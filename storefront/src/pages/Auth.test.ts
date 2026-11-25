import { describe, expect, it } from 'vitest';
import { safeNext, startUrl, strength } from './Auth';

describe('sign-in helpers', () => {
  it('never redirects off-site or back into the login pages', () => {
    expect(safeNext('/cart')).toBe('/cart');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
  it('rates passwords: under 10 characters is never acceptable', () => {
    expect(strength('short')).toBe(0);
    expect(strength('longenough')).toBe(1);
    expect(strength('Longer-Pass-2024!')).toBe(4);
  });
  it('builds the start link with the return path, language and country', () => {
    const u = new URL(startUrl('google', '/cart', 'pl', 'PL'), 'https://api.example');
    expect(u.pathname).toBe('/api/store/oauth/google/start');
    expect(u.searchParams.get('next')).toBe('/cart'); expect(u.searchParams.get('lang')).toBe('pl'); expect(u.searchParams.get('country')).toBe('PL');
  });
});
