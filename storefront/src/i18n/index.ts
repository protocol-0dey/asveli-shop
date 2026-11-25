import en from './en';
import pl from './pl';
import de from './de';
import ru from './ru';

export const LANGS = ['en', 'pl', 'de', 'ru'] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_NAMES: Record<Lang, string> = { en: 'English', pl: 'Polski', de: 'Deutsch', ru: 'Русский' };
const LOCALES: Record<Lang, string> = { en: 'en-GB', pl: 'pl-PL', de: 'de-DE', ru: 'ru-RU' };
const dict: Record<Lang, Record<string, string>> = { en, pl, de, ru };

export const locale = (l: Lang) => LOCALES[l];
// missing keys fall back to English, never to a raw key on screen
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = dict[lang][key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
// plural helper: keys "x.one" / "x.few" / "x.many" / "x.other"
export function plural(lang: Lang, key: string, n: number, vars?: Record<string, string | number>) {
  const cat = new Intl.PluralRules(LOCALES[lang]).select(n);
  const k = dict[lang][`${key}.${cat}`] !== undefined || en[`${key}.${cat}`] !== undefined ? `${key}.${cat}` : `${key}.other`;
  return translate(lang, k, { n, ...(vars || {}) });
}
export function detectLang(): Lang {
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return (LANGS as readonly string[]).includes(nav) ? (nav as Lang) : 'en';
}
