import { store } from './lib/storage';

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') || '';
export const API_BASE = BASE;

export class ApiError extends Error {
  status: number; code: string; extra: any;
  constructor(status: number, code: string, extra?: any) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

export const tokens = {
  buyer: () => store.get('asv_token'), setBuyer: (t: string | null) => (t ? store.set('asv_token', t) : store.del('asv_token')),
  seller: () => store.get('asv_seller_token'), setSeller: (t: string | null) => (t ? store.set('asv_seller_token', t) : store.del('asv_seller_token'))
};

// pseudonymous id for personalisation: created ONLY after the visitor consented (see ConsentBanner)
export function anonId(): string | null {
  if (store.get('asv_consent') !== 'all') return null;
  let id = store.get('asv_anon');
  if (!id) { id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, '') .padEnd(24, 'x'); store.set('asv_anon', id); }
  return id;
}

type Auth = 'buyer' | 'seller' | null;
let onUnauthorized: ((who: 'buyer' | 'seller') => void) | null = null;
export const setUnauthorizedHandler = (f: (who: 'buyer' | 'seller') => void) => { onUnauthorized = f; };

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { auth?: Auth; headers?: Record<string, string>; optionalAuth?: boolean } = {}): Promise<T> {
  const h: Record<string, string> = { Accept: 'application/json', ...(opts.headers || {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const who: Auth = 'auth' in opts ? (opts.auth ?? null) : (path.startsWith('/api/seller') ? 'seller' : opts.optionalAuth === false ? null : 'buyer');   // an explicit auth:null means anonymous: no token is sent
  const tok = who === 'seller' ? tokens.seller() : who === 'buyer' ? tokens.buyer() : null;
  if (tok) h.Authorization = 'Bearer ' + tok;
  const a = anonId(); if (a) h['X-Anon-Id'] = a;
  let res: Response;
  try { res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw new ApiError(0, 'network_error'); }
  if (res.status === 204) return undefined as T;
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && tok && who && onUnauthorized) onUnauthorized(who);
    if (res.status === 503 && data?.error === 'maintenance' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('asv:maintenance', { detail: data.message }));
    throw new ApiError(res.status, data?.error || 'error', data);
  }
  return data as T;
}
export const get = <T = any>(p: string, o?: Parameters<typeof api>[3]) => api<T>('GET', p, undefined, o);
export const post = <T = any>(p: string, b?: unknown, o?: Parameters<typeof api>[3]) => api<T>('POST', p, b ?? {}, o);

export const assetUrl = (u: string | null | undefined) => (!u ? null : u.startsWith('/f/') || u.startsWith('/s/') ? BASE + u : u);
