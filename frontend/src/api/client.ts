import axios from 'axios';

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
 * - 收到 401 时清除所有本地令牌并强制跳转首页（AuthContext 检测到状态为空后渲染登录页）
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

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
      window.location.replace('/');
    }
    return Promise.reject(error);
  },
);

export default client;
