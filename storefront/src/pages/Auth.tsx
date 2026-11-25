import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { API_BASE, ApiError, anonId, get, post } from '../api';
import { useApp, useAuth } from '../state';
import { Field, Spinner, errText } from '../components/ui';
import type { OAuthProvider, Profile } from '../lib/types';

export const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') && !n.startsWith('/register') ? n : '/');

/* ---------- "Continue with Google / GitHub / Amazon" ---------- */
let cache: OAuthProvider[] | null = null;
export function useProviders() {
  const [list, setList] = useState<OAuthProvider[] | null>(cache);
  useEffect(() => { if (cache) return; get<{ providers: OAuthProvider[] }>('/api/store/oauth/providers', { auth: null }).then(r => { cache = r.providers; setList(r.providers); }).catch(() => setList([])); }, []);
  return list;
}
// a full page navigation: the server talks to the provider, the client secret never reaches the browser
export function startUrl(p: string, next: string, lang: string, country: string) {
  const q = new URLSearchParams({ next, lang, country }); const a = anonId(); if (a) q.set('anon', a);
  return `${API_BASE}/api/store/oauth/${p}/start?${q}`;
}
const Glyph = ({ p }: { p: string }) => <span className={'sso-glyph sso-' + p} aria-hidden="true">{p === 'github' ? '</>' : p === 'amazon' ? 'a' : 'G'}</span>;

function Social({ next, mode }: { next: string; mode: 'login' | 'register' }) {
  const { t, lang, country } = useApp(); const list = useProviders(); const [going, setGoing] = useState<string | null>(null);
  if (!list || !list.length) return null;
  return (
    <div className="sso">
      {list.map(p => (
        <a key={p.id} className={'btn btn-ghost btn-block sso-btn' + (going === p.id ? ' is-going' : '')} href={startUrl(p.id, next, lang, country)} onClick={() => setGoing(p.id)} aria-busy={going === p.id}>
          <Glyph p={p.id} /><span>{t(mode === 'login' ? 'auth.with' : 'auth.withReg', { p: p.name })}</span>
        </a>))}
      <div className="sso-or" role="separator"><span>{t('auth.orEmail')}</span></div>
    </div>
  );
}

function PasswordInput({ value, onChange, autoComplete, minLength, label, hint }: { value: string; onChange: (v: string) => void; autoComplete: string; minLength?: number; label: string; hint?: string }) {
  const { t } = useApp(); const [show, setShow] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="pw-wrap">
        <input className="input" type={show ? 'text' : 'password'} required value={value} onChange={e => onChange(e.target.value)} autoComplete={autoComplete} minLength={minLength} maxLength={200} />
        <button type="button" className="pw-eye" onClick={() => setShow(!show)} aria-label={t(show ? 'auth.hidePw' : 'auth.showPw')} aria-pressed={show}>{show ? t('auth.hide') : t('auth.show')}</button>
      </div>
    </Field>
  );
}
// rough strength meter: length first (the server only requires 10+), then variety
export function strength(pw: string) { let s = 0; if (pw.length >= 10) s++; if (pw.length >= 14) s++; if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++; if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++; return pw.length < 10 ? 0 : Math.min(4, Math.max(1, s)); }

function Shell({ mode, next, children }: { mode: 'login' | 'register'; next: string; children: ReactNode }) {
  const { t } = useApp(); const q = '?next=' + encodeURIComponent(next);
  return (
    <div className="auth-wrap">
      <div className="card auth-box neon">
        <div className="auth-tabs" role="tablist">
          <Link role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} to={'/login' + q} replace>{t('menu.login')}</Link>
          <Link role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} to={'/register' + q} replace>{t('auth.create')}</Link>
        </div>
        <h1 className="auth-h">{t(mode === 'login' ? 'auth.loginTitle' : 'auth.registerTitle')}</h1>
        <p className="muted small auth-lead">{t(mode === 'login' ? 'auth.loginLead' : 'auth.registerLead')}</p>
        <Social next={next} mode={mode} />
        {children}
      </div>
      <ul className="auth-perks small muted">
        <li>{t('auth.perk1')}</li><li>{t('auth.perk2')}</li><li>{t('auth.perk3')}</li>
      </ul>
    </div>
  );
}

export function Login() {
  const { t } = useApp(); const { login, profile } = useAuth(); const nav = useNavigate(); const [sp] = useSearchParams(); const next = safeNext(sp.get('next'));
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  document.title = t('menu.login') + ' — ASVELI';
  if (profile) return <Navigate to={next} replace />;
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await login(email, pw); nav(next, { replace: true }); } catch (x) { setErr(errText(t, x)); } setBusy(false); };
  return (
    <Shell mode="login" next={next}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('f.email')}><input className="input" type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" /></Field>
        <PasswordInput label={t('f.password')} value={pw} onChange={setPw} autoComplete="current-password" />
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t('auth.wait') : t('menu.login')}</button>
      </form>
      <p className="muted small mt">{t('auth.noAccount')} <Link to={'/register?next=' + encodeURIComponent(next)}>{t('auth.createOne')}</Link></p>
      <p className="faint small">{t('auth.socialHint')}</p>
    </Shell>
  );
}

export function Register() {
  const { t, lang, country, countries, countryName } = useApp(); const { register, profile } = useAuth(); const nav = useNavigate(); const [sp] = useSearchParams(); const next = safeNext(sp.get('next'));
  const [f, setF] = useState({ name: '', email: '', password: '', country }); const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  document.title = t('auth.registerTitle') + ' — ASVELI';
  if (profile) return <Navigate to={next} replace />;
  const s = strength(f.password);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await register({ ...f, lang }); nav(next, { replace: true }); } catch (x) { setErr(errText(t, x)); } setBusy(false); };
  return (
    <Shell mode="register" next={next}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('f.name')}><input className="input" required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoComplete="name" maxLength={80} /></Field>
        <Field label={t('f.email')}><input className="input" type="email" required value={f.email} onChange={e => setF({ ...f, email: e.target.value })} autoComplete="email" inputMode="email" /></Field>
        <PasswordInput label={t('f.password')} hint={t('auth.pwHint')} value={f.password} onChange={v => setF({ ...f, password: v })} autoComplete="new-password" minLength={10} />
        {f.password && <div className={'pw-meter s' + s} aria-live="polite"><i /><i /><i /><i /><span className="small">{t('auth.pw' + s)}</span></div>}
        <Field label={t('f.country')}><select className="input" value={f.country} onChange={e => setF({ ...f, country: e.target.value })}>{countries.map(c => <option key={c} value={c}>{countryName(c)}</option>)}</select></Field>
        <label className="check"><input type="checkbox" required checked={ok} onChange={e => setOk(e.target.checked)} /><span>{t('auth.agree')} <Link to="/info/terms">{t('footer.terms')}</Link> · <Link to="/info/privacy">{t('footer.privacy')}</Link></span></label>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t('auth.wait') : t('auth.create')}</button>
      </form>
      <p className="muted small mt">{t('auth.haveAccount')} <Link to={'/login?next=' + encodeURIComponent(next)}>{t('menu.login')}</Link></p>
    </Shell>
  );
}

/* ---------- back from Google / GitHub / Amazon: <shop>/login/callback#code=…&next=… ---------- */
export function LoginCallback() {
  const { t, toast } = useApp(); const { adopt } = useAuth(); const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null); const once = useRef(false);
  useEffect(() => {
    if (once.current) return; once.current = true;
    const h = new URLSearchParams(window.location.hash.slice(1)); const next = safeNext(h.get('next'));
    window.history.replaceState(null, '', window.location.pathname);              // the one-time code leaves the address bar at once
    const e = h.get('error'), code = h.get('code');
    if (e || !code) { const k = 'sso.e.' + (e || 'provider'); setErr(t(k) === k ? t('sso.e.provider') : t(k)); return; }
    post<{ token: string; profile: Profile; created: boolean }>('/api/store/oauth/exchange', { code }, { auth: null })
      .then(r => { adopt(r.token, r.profile); if (h.get('linked')) toast(t('sso.linked')); else if (r.created) toast(t('sso.welcome')); nav(next, { replace: true }); })
      .catch(x => setErr(x instanceof ApiError && x.code === 'invalid_code' ? t('sso.e.expired') : errText(t, x)));
  }, []);
  return (
    <div className="card auth-box neon center">
      {!err ? <><Spinner /><p className="muted">{t('sso.signing')}</p></> : <>
        <h1 className="auth-h">{t('sso.failed')}</h1><p className="err" role="alert">{err}</p>
        <div className="row center mt"><Link className="btn btn-primary" to="/login">{t('sso.tryAgain')}</Link><Link className="btn btn-ghost" to="/">{t('common.home')}</Link></div></>}
    </div>
  );
}
