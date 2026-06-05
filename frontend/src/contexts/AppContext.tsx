import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

  // Listen for OS colour-scheme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Sync with server-side user preferences on login / user change
  useEffect(() => {
    if (!user) return;
    const t = (user.theme as ThemeMode)    ?? 'system';
    const l = (user.language as Language)  ?? 'en';
    setThemeState(t);
    setLanguageState(l);
    localStorage.setItem(LS_THEME, t);
    localStorage.setItem(LS_LANG,  l);
  }, [user]);

  const resolvedTheme: 'light' | 'dark' =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : (theme as 'light' | 'dark');

  const setTheme = useCallback((t: ThemeMode) => {
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
