import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AuthUser, TokenBundle } from '../types/auth';
import { logout as logoutApi } from '../api/auth';
import {
  isAuthInvalidError,
  refreshSessionSingleFlight,
  SESSION_REFRESHED_EVENT,
  storageKeys,
} from '../api/client';

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  /** 登录 / 密码修改成功后，存储完整 Token 包 */
  login: (bundle: TokenBundle) => void;
  /** 服务端吊销本会话的 Refresh Token 后清本地（服务端不可达时也照常清本地） */
  logout: () => Promise<void>;
  /** Refresh Token 换 Token 成功后更新 session（同 login，逻辑复用） */
  refreshSession: (bundle: TokenBundle) => void;
  /** 局部更新已登录用户的偏好（theme/language 等）并同步到 localStorage，
   *  使下次重载从 nms_user 恢复时保持一致（不重新拉取 Token）。 */
  updateStoredUser: (partial: Partial<AuthUser>) => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  loading: true,
  login: () => {},
  logout: async () => {},
  refreshSession: () => {},
  updateStoredUser: () => {},
});

// ─── Provider ─────────────────────────────────────────────────────────────────

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Token 过期前 5 分钟触发静默刷新
// 浏览器 setTimeout 的延时参数在底层 WebIDL 中为 32 位有符号整数（最大 2^31 - 1 ≈ 24.85 天），
// 超过该值（如 30 天会话）会溢出导致 1ms 内立即触发死循环刷新。超出时分段接力定时。
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
const TRANSIENT_RETRY_MS = 30_000; // 网络瞬断或后端重启（502/503）时 30 秒后重试，不踢出登录

function clearStorage() {
  Object.values(storageKeys).forEach((k) => localStorage.removeItem(k));
}

function saveBundle(bundle: TokenBundle) {
  localStorage.setItem(storageKeys.accessToken, bundle.access_token);
  localStorage.setItem(storageKeys.refreshToken, bundle.refresh_token);
  localStorage.setItem(storageKeys.expiresAt, bundle.access_token_expires_at);
  localStorage.setItem(storageKeys.user, JSON.stringify(bundle.user));
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken]   = useState<string | null>(null);
  const [user, setUser]     = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // timer ref：存放 setTimeout 返回值，用于在下次调度时 clearTimeout
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── 调度静默刷新 ───────────────────────────────────────────────────────────
  const scheduleRefresh = useCallback((expiresAtIso: string) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const expiresMs = new Date(expiresAtIso).getTime();
    const refreshAt = expiresMs - REFRESH_BUFFER_MS;
    const baseRemaining = Math.max(refreshAt - Date.now(), 1000); // 至少 1 秒后
    // 多标签页错峰抖动（0~3s）：避免多个同源标签页在同一毫秒并发击穿 /auth/refresh
    const jitter = baseRemaining > 10_000 ? Math.floor(Math.random() * 3000) : 0;
    const remaining = baseRemaining + jitter;

    // 超出 32 位定时器上限（24.85 天）时先定满一段，唤醒后接力剩余时间
    if (remaining > MAX_SET_TIMEOUT_MS) {
      timerRef.current = setTimeout(() => {
        scheduleRefresh(expiresAtIso);
      }, MAX_SET_TIMEOUT_MS);
      return;
    }

    timerRef.current = setTimeout(async () => {
      const storedRefresh = localStorage.getItem(storageKeys.refreshToken);
      if (!storedRefresh) {
        clearStorage();
        setToken(null);
        setUser(null);
        return;
      }
      try {
        const bundle = await refreshSessionSingleFlight();
        setToken(bundle.access_token);
        setUser(bundle.user);
        scheduleRefresh(bundle.access_token_expires_at); // 递归调度下一次
      } catch (err) {
        if (!localStorage.getItem(storageKeys.refreshToken) || isAuthInvalidError(err)) {
          // 服务端明确拒绝（401/403）→ 登出
          clearStorage();
          setToken(null);
          setUser(null);
        } else {
          // 瞬时网络抖动或服务端重启中（502/503）→ 保留会话，30s 后重试
          scheduleRefresh(new Date(Date.now() + REFRESH_BUFFER_MS + TRANSIENT_RETRY_MS).toISOString());
        }
      }
    }, remaining);
  }, []);

  // ─── 初始化：从 localStorage 恢复 session ───────────────────────────────────
  useEffect(() => {
    async function initAuth() {
      const storedToken   = localStorage.getItem(storageKeys.accessToken);
      const storedRefresh = localStorage.getItem(storageKeys.refreshToken);
      const storedExpires = localStorage.getItem(storageKeys.expiresAt);
      const storedUser    = localStorage.getItem(storageKeys.user);

      if (storedToken && storedRefresh && storedExpires && storedUser) {
        const expiresMs = new Date(storedExpires).getTime();
        const stillValid = expiresMs > Date.now() + 60_000; // 至少 1 分钟有效期

        if (stillValid) {
          // Token 仍然有效：直接恢复
          try {
            setToken(storedToken);
            setUser(JSON.parse(storedUser) as AuthUser);
            scheduleRefresh(storedExpires);
          } catch {
            clearStorage();
          }
        } else {
          // Token 即将到期或已过期：立即用 Refresh Token 换取新 Token
          try {
            const bundle = await refreshSessionSingleFlight();
            setToken(bundle.access_token);
            setUser(bundle.user);
            scheduleRefresh(bundle.access_token_expires_at);
          } catch (err) {
            if (isAuthInvalidError(err)) {
              clearStorage();
            } else {
              // 瞬时网络错误：先用本地缓存态恢复界面，稍后重试刷新
              try {
                setToken(storedToken);
                setUser(JSON.parse(storedUser) as AuthUser);
                scheduleRefresh(new Date(Date.now() + REFRESH_BUFFER_MS + TRANSIENT_RETRY_MS).toISOString());
              } catch {
                clearStorage();
              }
            }
          }
        }
      }
      setLoading(false);
    }

    initAuth();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 与 axios 拦截器的静默刷新保持同步 ──────────────────────────────────────
  // client.ts 的 401 拦截器换新 Token 后只写 localStorage 并广播该事件；
  // 这里把 React 状态和刷新定时器重新对齐到新的 Token/到期时间。
  useEffect(() => {
    const onSessionRefreshed = () => {
      const storedToken   = localStorage.getItem(storageKeys.accessToken);
      const storedExpires = localStorage.getItem(storageKeys.expiresAt);
      const storedUser    = localStorage.getItem(storageKeys.user);
      if (!storedToken || !storedExpires || !storedUser) return;
      try {
        setToken(storedToken);
        setUser(JSON.parse(storedUser) as AuthUser);
        scheduleRefresh(storedExpires);
      } catch {
        /* 损坏的 user JSON：保持现状，等下一次正常登录/刷新覆盖 */
      }
    };
    window.addEventListener(SESSION_REFRESHED_EVENT, onSessionRefreshed);
    return () => window.removeEventListener(SESSION_REFRESHED_EVENT, onSessionRefreshed);
  }, [scheduleRefresh]);

  // ─── 跨标签页会话与用户信息实时同步（storage 事件）──────────────────────────
  // 任一标签页完成静默续期、登录、退出或修改偏好后，其余同源标签页即时同步最新状态并重设定时器，
  // 防止旧标签页继续持有已旋转的旧 Refresh Token 撞车，也确保单标签页登出后全窗口同步退出。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKeys.accessToken) {
        if (!e.newValue) {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          setToken(null);
          setUser(null);
          return;
        }
        const storedExpires = localStorage.getItem(storageKeys.expiresAt);
        const storedUser    = localStorage.getItem(storageKeys.user);
        setToken(e.newValue);
        if (storedUser) {
          try { setUser(JSON.parse(storedUser) as AuthUser); } catch { /* ignore */ }
        }
        if (storedExpires) {
          scheduleRefresh(storedExpires);
        }
      } else if (e.key === storageKeys.user && e.newValue) {
        try { setUser(JSON.parse(e.newValue) as AuthUser); } catch { /* ignore */ }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [scheduleRefresh]);

  // ─── 公开方法 ───────────────────────────────────────────────────────────────

  const login = useCallback((bundle: TokenBundle) => {
    saveBundle(bundle);
    setToken(bundle.access_token);
    setUser(bundle.user);
    scheduleRefresh(bundle.access_token_expires_at);
  }, [scheduleRefresh]);

  const logout = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // 先让服务端吊销本会话的 Refresh Token 家族，再清本地：只清本地的话令牌在服务端
    // 仍然有效，被盗后照常续期。请求必须在清存储之前发出——拦截器从 localStorage
    // 取 Bearer。网络不通或已失效都不阻止本机退出。
    const storedRefresh = localStorage.getItem(storageKeys.refreshToken);
    if (storedRefresh) {
      try { await logoutApi(storedRefresh); } catch { /* 忽略：本地照常退出 */ }
    }
    clearStorage();
    setToken(null);
    setUser(null);
  }, []);

  const refreshSession = useCallback((bundle: TokenBundle) => {
    saveBundle(bundle);
    setToken(bundle.access_token);
    setUser(bundle.user);
    scheduleRefresh(bundle.access_token_expires_at);
  }, [scheduleRefresh]);

  const updateStoredUser = useCallback((partial: Partial<AuthUser>) => {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...partial };
      localStorage.setItem(storageKeys.user, JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, refreshSession, updateStoredUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
