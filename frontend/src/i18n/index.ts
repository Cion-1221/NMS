import { useAppContext } from '../contexts/AppContext';
import dict, { Lang, TranslationKey } from './translations';

/** Replace {key} placeholders in a string */
function interpolate(str: string, params?: Record<string, string | number>): string {
  if (!params) return str;
  return Object.entries(params).reduce(
    (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
    str,
  );
}

/** Hook: returns a t() function scoped to the user's current language */
export function useT() {
  const { language } = useAppContext();
  return (key: TranslationKey, params?: Record<string, string | number>): string => {
    const entry = dict[key];
    const raw = entry[language as Lang] ?? entry['en'] ?? String(key);
    return interpolate(raw, params);
  };
}

/** Standalone translate (for use outside hooks) */
export function translate(key: TranslationKey, lang: Lang, params?: Record<string, string | number>): string {
  const entry = dict[key];
  const raw = entry[lang] ?? entry['en'] ?? String(key);
  return interpolate(raw, params);
}
