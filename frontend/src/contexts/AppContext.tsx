import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';

export type ThemeMode = 'light' | 'dark' | 'system';
export type Language  = 'en' | 'zh';

interface AppContextType {
  theme:         ThemeMode;
  language:      Language;
  /** Resolved to either 'light' or 'dark' (system preference resolved) */
  resolvedTheme: 'light' | 'dark';
  setTheme:      (t: ThemeMode) => void;
  setLanguage:   (l: Language)  => void;
}

const AppContext = createContext<AppContextType>({
  theme:         'system',
  language:      'en',
  resolvedTheme: 'light',
  setTheme:      () => {},
  setLanguage:   () => {},
});

const LS_THEME = 'nms_ui_theme';
const LS_LANG  = 'nms_ui_language';

function readSystemDark() {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();

  const [theme, setThemeState] = useState<ThemeMode>(
    () => (localStorage.getItem(LS_THEME) as ThemeMode) ?? 'system',
  );
  const [language, setLanguageState] = useState<Language>(
    () => (localStorage.getItem(LS_LANG) as Language) ?? 'en',
  );
  const [systemDark, setSystemDark] = useState(readSystemDark);

  // True once the user explicitly picks a theme this session (including the
  // pre-login toggle on the sign-in page). While set, the login/refresh sync
  // below won't override that choice with the server's stored value.
  const manualThemeOverride = useRef(false);

  // Listen for OS colour-scheme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Sync with server-side user preferences on login / user change.
  // Language always follows the server value; theme only does so when the user
  // hasn't made an explicit choice this session — otherwise signing in would
  // overwrite e.g. a dark theme picked on the login screen.
  useEffect(() => {
    // Logged out (mount or logout) → clear the override so the next login starts
    // clean and adopts that account's stored prefs.
    if (!user) { manualThemeOverride.current = false; return; }
    const l = (user.language as Language) ?? 'en';
    setLanguageState(l);
    localStorage.setItem(LS_LANG, l);
    if (!manualThemeOverride.current) {
      const t = (user.theme as ThemeMode) ?? 'system';
      setThemeState(t);
      localStorage.setItem(LS_THEME, t);
    }
  }, [user]);

  const resolvedTheme: 'light' | 'dark' =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : (theme as 'light' | 'dark');

  const setTheme = useCallback((t: ThemeMode) => {
    manualThemeOverride.current = true;
    setThemeState(t);
    localStorage.setItem(LS_THEME, t);
  }, []);

  const setLanguage = useCallback((l: Language) => {
    setLanguageState(l);
    localStorage.setItem(LS_LANG, l);
  }, []);

  return (
    <AppContext.Provider value={{ theme, language, resolvedTheme, setTheme, setLanguage }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => useContext(AppContext);
