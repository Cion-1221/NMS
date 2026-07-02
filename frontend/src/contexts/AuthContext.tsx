import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AuthUser, TokenBundle } from '../types/auth';
import { refreshToken as refreshTokenApi } from '../api/auth';
import { SESSION_REFRESHED_EVENT, storageKeys } from '../api/client';

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  /** 登录 / 密码修改成功后，存储完整 Token 包 */
  login: (bundle: TokenBundle) => void;
  logout: () => void;
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
  logout: () => {},
  refreshSession: () => {},
  updateStoredUser: () => {},
});

// ─── Provider ─────────────────────────────────────────────────────────────────

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Token 过期前 5 分钟触发静默刷新

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
    const delay = Math.max(refreshAt - Date.now(), 1000); // 至少 1 秒后

    timerRef.current = setTimeout(async () => {
      const storedRefresh = localStorage.getItem(storageKeys.refreshToken);
      if (!storedRefresh) {
        clearStorage();
        setToken(null);
        setUser(null);
        return;
      }
      try {
        const res = await refreshTokenApi(storedRefresh);
        const bundle = res.data;
        saveBundle(bundle);
        setToken(bundle.access_token);
        setUser(bundle.user);
        scheduleRefresh(bundle.access_token_expires_at); // 递归调度下一次
      } catch {
        // Refresh Token 失效 → 登出
        clearStorage();
        setToken(null);
        setUser(null);
      }
    }, delay);
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
            const res = await refreshTokenApi(storedRefresh);
            const bundle = res.data;
            saveBundle(bundle);
            setToken(bundle.access_token);
            setUser(bundle.user);
            scheduleRefresh(bundle.access_token_expires_at);
          } catch {
            clearStorage();
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

  // ─── 公开方法 ───────────────────────────────────────────────────────────────

  const login = useCallback((bundle: TokenBundle) => {
    saveBundle(bundle);
    setToken(bundle.access_token);
    setUser(bundle.user);
    scheduleRefresh(bundle.access_token_expires_at);
  }, [scheduleRefresh]);

  const logout = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
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
