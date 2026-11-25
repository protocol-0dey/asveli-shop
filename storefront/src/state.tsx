import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { get, post, api, tokens, setUnauthorizedHandler, ApiError } from './api';
import { store } from './lib/storage';
import { Lang, LANGS, translate, plural as pluralize, detectLang, locale } from './i18n';
import type { CartItem, Profile } from './lib/types';

/* ------------------------------ app (language, country, money, consent, toasts) ------------------------------ */
interface AppCtx {
  lang: Lang; setLang: (l: Lang) => void; country: string; setCountry: (c: string) => void;
  currency: string; countries: string[];
  t: (k: string, v?: Record<string, string | number>) => string; pl: (k: string, n: number, v?: Record<string, string | number>) => string;
  money: (cents: number | null | undefined) => string; date: (ms: number) => string; countryName: (cc: string) => string;
  consent: string | null; setConsent: (c: 'all' | 'essential') => void;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
}
const AppC = createContext<AppCtx>(null as any);
export const useApp = () => useContext(AppC);

export function AppProvider({ children }: { children: ReactNode }) {
  const [lang, setLangS] = useState<Lang>(() => { const s = store.get('asv_lang'); return (LANGS as readonly string[]).includes(s || '') ? (s as Lang) : detectLang(); });
  const [country, setCountryS] = useState<string>(() => store.get('asv_country') || 'PL');
  const [cfg, setCfg] = useState<{ currency: string; countries: string[] }>({ currency: 'EUR', countries: ['PL', 'DE'] });
  const [consent, setConsentS] = useState<string | null>(() => store.get('asv_consent'));
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);

  useEffect(() => { get('/api/store/config', { auth: null }).then(c => setCfg({ currency: c.currency, countries: c.countries })).catch(() => {}); }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = useCallback((l: Lang) => { setLangS(l); store.set('asv_lang', l); }, []);
  const setCountry = useCallback((c: string) => { setCountryS(c); store.set('asv_country', c); }, []);
  const setConsent = useCallback((c: 'all' | 'essential') => {
    store.set('asv_consent', c); setConsentS(c);
    if (c === 'essential') { store.del('asv_anon'); }                   // withdrawing consent also deletes the pseudonymous id
  }, []);
  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random(); setToasts(x => [...x, { id, msg, kind }]);
    setTimeout(() => setToasts(x => x.filter(y => y.id !== id)), 4200);
  }, []);

  const value = useMemo<AppCtx>(() => {
    const nf = new Intl.NumberFormat(locale(lang), { style: 'currency', currency: cfg.currency });
    const df = new Intl.DateTimeFormat(locale(lang), { year: 'numeric', month: 'short', day: 'numeric' });
    let dn: Intl.DisplayNames | null = null; try { dn = new Intl.DisplayNames([locale(lang)], { type: 'region' }); } catch { /* old browser */ }
    return {
      lang, setLang, country, setCountry, currency: cfg.currency, countries: cfg.countries,
      t: (k, v) => translate(lang, k, v), pl: (k, n, v) => pluralize(lang, k, n, v),
      money: c => (c == null ? '—' : nf.format(c / 100)), date: ms => df.format(new Date(ms)), countryName: cc => { try { return dn?.of(cc) || cc; } catch { return cc; } },
      consent, setConsent, toast
    };
  }, [lang, country, cfg, consent, setLang, setCountry, setConsent, toast]);

  return (
    <AppC.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{toasts.map(x => <div key={x.id} className={'toast ' + x.kind}>{x.msg}</div>)}</div>
    </AppC.Provider>
  );
}

/* ------------------------------ buyer auth ------------------------------ */
interface AuthCtx {
  profile: Profile | null; ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (d: { email: string; password: string; name: string; country: string; lang: string }) => Promise<void>;
  logout: () => Promise<void>; refresh: () => Promise<void>;
  adopt: (token: string, profile: Profile) => void;               // sign-in finished elsewhere (Google / GitHub / Amazon)
}
const AuthC = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(AuthC);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    if (!tokens.buyer()) { setProfile(null); setReady(true); return; }
    try { setProfile(await get<Profile>('/api/store/me')); } catch (e) { if (e instanceof ApiError && e.status === 401) tokens.setBuyer(null); setProfile(null); }
    setReady(true);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setUnauthorizedHandler(who => { if (who === 'buyer') { tokens.setBuyer(null); setProfile(null); } else tokens.setSeller(null); }); }, []);
  const value = useMemo<AuthCtx>(() => ({
    profile, ready, refresh,
    login: async (email, password) => { const r = await post('/api/store/auth/login', { email, password }, { auth: null }); tokens.setBuyer(r.token); setProfile(r.profile); },
    register: async d => { const r = await post('/api/store/auth/register', d, { auth: null }); tokens.setBuyer(r.token); setProfile(r.profile); },
    adopt: (token, p) => { tokens.setBuyer(token); setProfile(p); },
    logout: async () => { try { await api('POST', '/api/store/auth/logout', {}); } catch { /* ignore */ } tokens.setBuyer(null); setProfile(null); }
  }), [profile, ready, refresh]);
  return <AuthC.Provider value={value}>{children}</AuthC.Provider>;
}

/* ------------------------------ cart (client side; prices are always re-quoted by the server) ------------------------------ */
interface CartCtx { items: CartItem[]; count: number; add: (i: CartItem) => void; setQty: (id: number, q: number) => void; remove: (id: number) => void; clear: () => void }
const CartC = createContext<CartCtx>(null as any);
export const useCart = () => useContext(CartC);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>(() => store.json<CartItem[]>('asv_cart', []).filter(i => Number.isSafeInteger(i.product_id) && i.qty > 0));
  useEffect(() => { store.set('asv_cart', JSON.stringify(items)); }, [items]);
  const value = useMemo<CartCtx>(() => ({
    items, count: items.reduce((s, i) => s + i.qty, 0),
    add: i => setItems(x => { const f = x.find(y => y.product_id === i.product_id); return f ? x.map(y => (y === f ? { ...y, qty: Math.min(100, y.qty + i.qty) } : y)) : [...x, i]; }),
    setQty: (id, q) => setItems(x => x.map(y => (y.product_id === id ? { ...y, qty: Math.max(1, Math.min(100, q)) } : y))),
    remove: id => setItems(x => x.filter(y => y.product_id !== id)), clear: () => setItems([])
  }), [items]);
  return <CartC.Provider value={value}>{children}</CartC.Provider>;
}
