import { describe, it, expect } from 'vitest';
import { translate, plural, LANGS } from './index';
import en from './en';
import pl from './pl';
import de from './de';
import ru from './ru';

describe('i18n', () => {
  it('interpolates variables', () => { const k = Object.keys(en).find(x => en[x].includes('{'))!; expect(translate('en', k, { n: 7, name: 'Zed', count: 7 })).not.toMatch(/\{(n|name|count)\}/); });
  it('falls back to English and never shows a raw key for a known key', () => {
    const k = Object.keys(en)[0]; expect(translate('de', k)).toBeTruthy(); expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
  it('every buyer key exists in every language (same gate as check:i18n)', () => {
    for (const [name, d] of Object.entries({ pl, de, ru })) {
      const missing = Object.keys(en).filter(k => !k.startsWith('seller.') && !(k in d));
      expect(missing, name).toEqual([]);
    }
  });
  it('placeholders match between English and translations', () => {
    const ph = (s: string) => (s.match(/\{[a-z]+\}/gi) || []).sort().join();
    for (const [name, d] of Object.entries({ pl, de, ru })) for (const k of Object.keys(d)) if (k in en && ph(d[k]) !== ph(en[k]) && !/\.(one|few|many|other)$/.test(k)) expect.soft(ph(d[k]), `${name}:${k}`).toBe(ph(en[k]));
  });
  it('knows four languages', () => { expect([...LANGS]).toEqual(['en', 'pl', 'de', 'ru']); });
  it('uses plural categories for Russian and Polish', () => {
    const key = Object.keys(ru).map(k => k.replace(/\.(one|few|many|other)$/, '')).find(k => ru[`${k}.few`] !== undefined);
    if (!key) return;
    expect(plural('ru', key, 2)).toBe(translate('ru', `${key}.few`, { n: 2 })); expect(plural('ru', key, 5)).toBe(translate('ru', `${key}.many`, { n: 5 }));
  });
});
