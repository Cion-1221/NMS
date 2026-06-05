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
import { storageKeys } from '../api/client';

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
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  loading: true,
  login: () => {},
  logout: () => {},
  refreshSession: () => {},
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

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, refreshSession }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
