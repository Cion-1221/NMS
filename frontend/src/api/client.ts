import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const KEYS = {
  accessToken:  'nms_access_token',
  refreshToken: 'nms_refresh_token',
  expiresAt:    'nms_token_expires_at',
  user:         'nms_user',
} as const;

export { KEYS as storageKeys };

/**
 * 全局共享 Axios 实例
 * - 自动携带 Authorization: Bearer <access_token>
 * - 业务请求收到 401 时：先用 Refresh Token 静默换新（并发去重，只发一次），
 *   成功后重放原请求；换新失败或重放仍 401 才清除本地令牌并跳回登录页。
 *   这覆盖了"休眠唤醒后 Access Token 已过期但 Refresh Token 仍有效"的场景，
 *   避免把用户硬登出。
 * - /auth/login 与 /auth/refresh 自身的 401 是业务语义（密码错误 / Refresh Token
 *   失效），原样抛给调用方展示错误，绝不触发整页跳转。
 */
const client = axios.create({
  baseURL: '/api/v1',
  timeout: 10000,
});

client.interceptors.request.use((config) => {
  const token = localStorage.getItem(KEYS.accessToken);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 这两个端点的 401 必须透传给调用方，不属于"会话失效"
const AUTH_PATHS = ['/auth/login', '/auth/refresh'];

function forceLogout() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  window.location.replace('/');
}

// 拦截器静默换新成功后广播该事件；AuthContext 监听它把 React 状态（token/user/
// 刷新定时器）与 localStorage 重新对齐，避免两边漂移
export const SESSION_REFRESHED_EVENT = 'nms:session-refreshed';

// 单飞：并发多个请求同时 401 时只触发一次 refresh，其余等待同一个 Promise
let refreshInFlight: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const stored = localStorage.getItem(KEYS.refreshToken);
  if (!stored) throw new Error('no refresh token');
  // 用裸 axios 而非 client：跳过本文件的拦截器，避免 401 递归
  const res = await axios.post('/api/v1/auth/refresh', { refresh_token: stored });
  const bundle = res.data;
  localStorage.setItem(KEYS.accessToken, bundle.access_token);
  localStorage.setItem(KEYS.refreshToken, bundle.refresh_token);
  localStorage.setItem(KEYS.expiresAt, bundle.access_token_expires_at);
  localStorage.setItem(KEYS.user, JSON.stringify(bundle.user));
  window.dispatchEvent(new Event(SESSION_REFRESHED_EVENT));
  return bundle.access_token as string;
}

client.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const url = config?.url ?? '';

    if (
      error.response?.status !== 401 ||
      !config ||
      AUTH_PATHS.some((p) => url.includes(p))
    ) {
      return Promise.reject(error);
    }

    // 换新后重放仍然 401：新 Token 也不被接受（如服务端 secret 已更换），彻底登出
    if (config._retried) {
      forceLogout();
      return Promise.reject(error);
    }

    try {
      refreshInFlight =
        refreshInFlight ??
        refreshAccessToken().finally(() => { refreshInFlight = null; });
      const token = await refreshInFlight;
      config._retried = true;
      config.headers.Authorization = `Bearer ${token}`;
      return client.request(config);
    } catch {
      forceLogout();
      return Promise.reject(error);
    }
  },
);

export default client;
