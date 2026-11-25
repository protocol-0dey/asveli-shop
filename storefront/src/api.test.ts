import { describe, it, expect, vi } from 'vitest';
import { api, ApiError, tokens, anonId, setUnauthorizedHandler, assetUrl } from './api';
import { mockFetch } from './test/utils';

describe('api client', () => {
  it('sends the buyer token on store routes and the seller token on seller routes', async () => {
    const calls = mockFetch({ '/api/store/x': { ok: 1 }, '/api/seller/y': { ok: 1 } });
    tokens.setBuyer('B'); tokens.setSeller('S');
    await api('GET', '/api/store/x'); await api('GET', '/api/seller/y');
    expect((calls[0].init!.headers as any).Authorization).toBe('Bearer B');
    expect((calls[1].init!.headers as any).Authorization).toBe('Bearer S');
  });
  it('sends no token when auth is explicitly null', async () => {
    const calls = mockFetch({ '/api/store/config': {} }); tokens.setBuyer('B');
    await api('GET', '/api/store/config', undefined, { auth: null });
    expect((calls[0].init!.headers as any).Authorization).toBeUndefined();
  });
  it('maps HTTP errors to ApiError with the server code', async () => {
    mockFetch({ '/api/store/z': { __status: 409, error: 'out_of_stock' } });
    await expect(api('POST', '/api/store/z', {})).rejects.toMatchObject({ status: 409, code: 'out_of_stock' });
  });
  it('maps a dead network to network_error', async () => {
    globalThis.fetch = (async () => { throw new TypeError('down'); }) as any;
    const e = await api('GET', '/api/store/q').catch(x => x); expect(e).toBeInstanceOf(ApiError); expect(e.code).toBe('network_error');
  });
  it('calls the unauthorized handler only when a token was actually sent', async () => {
    const h = vi.fn(); setUnauthorizedHandler(h);
    mockFetch({ '/api/store/me': { __status: 401, error: 'auth_required' } });
    await api('GET', '/api/store/me').catch(() => {}); expect(h).not.toHaveBeenCalled();
    tokens.setBuyer('B'); await api('GET', '/api/store/me').catch(() => {}); expect(h).toHaveBeenCalledWith('buyer');
  });
  it('handles 204 without a body', async () => { mockFetch({ '/api/store/d': { __status: 204 } }); await expect(api('POST', '/api/store/d', {})).resolves.toBeUndefined(); });
  it('creates the pseudonymous id only after consent, and drops it on withdrawal', () => {
    expect(anonId()).toBeNull();
    localStorage.setItem('asv_consent', 'essential'); expect(anonId()).toBeNull();
    localStorage.setItem('asv_consent', 'all'); const id = anonId(); expect(id).toMatch(/^[A-Za-z0-9_-]{24,}$/); expect(anonId()).toBe(id);
  });
  it('prefixes only server-hosted asset paths', () => { expect(assetUrl(null)).toBeNull(); expect(assetUrl('https://x.test/a.png')).toBe('https://x.test/a.png'); expect(assetUrl('/f/1')).toMatch(/\/f\/1$/); });
});
