import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, get, post, tokens } from '../api';
import { useApp, useAuth } from '../state';
import type { Identity, Order, OAuthProvider } from '../lib/types';
import { Empty, Field, Spinner, errText } from '../components/ui';
import { statusBadge } from './Order';
import { Inbox } from '../components/Inbox';

/* Google / GitHub / Amazon connected to this account */
function SignInMethods() {
  const { t, toast, date } = useApp(); const { profile } = useAuth();
  const [d, setD] = useState<{ identities: Identity[]; available: OAuthProvider[]; password_set: boolean } | null>(null);
  const load = () => get('/api/store/me/identities').then(setD).catch(() => setD({ identities: [], available: [], password_set: true }));
  useEffect(() => { load(); }, [profile?.password_set]);
  if (!d || (!d.available.length && !d.identities.length)) return null;
  const name = (p: string) => d.available.find(a => a.id === p)?.name || ({ google: 'Google', github: 'GitHub', amazon: 'Amazon' } as Record<string, string>)[p] || p;
  const connect = async (p: string) => { try { const r = await post<{ url: string }>(`/api/store/me/identities/${p}/ticket`); window.location.assign(r.url); } catch (x) { toast(errText(t, x), 'err'); } };
  const disconnect = async (p: string) => { if (!confirm(t('sso.unlinkConfirm', { p: name(p) }))) return; try { await api('DELETE', `/api/store/me/identities/${p}`); toast(t('common.saved')); load(); } catch (x) { toast(x instanceof ApiError && x.code === 'last_sign_in_method' ? t('sso.lastMethod') : errText(t, x), 'err'); } };
  const linked = new Set(d.identities.map(i => i.provider));
  return (
    <section className="card stack">
      <h3>{t('sso.methods')}</h3>
      <div className="small muted">{t('sso.methodsHint')}</div>
      <div className="sso-list">
        {d.identities.map(i => <div key={i.provider} className="sso-row"><b>{name(i.provider)}</b><span className="small muted">{t('sso.since', { d: date(i.created_at) })}</span><button className="btn btn-ghost btn-sm" onClick={() => disconnect(i.provider)}>{t('sso.unlink')}</button></div>)}
        {d.available.filter(a => !linked.has(a.id)).map(a => <div key={a.id} className="sso-row"><b>{a.name}</b><span className="small muted">{t('sso.notLinked')}</span><button className="btn btn-neon btn-sm" onClick={() => connect(a.id)}>{t('sso.link')}</button></div>)}
      </div>
      {!d.password_set && <div className="notice small">{t('sso.noPassword')}</div>}
    </section>
  );
}

function Orders() {
  const { t, money, date } = useApp(); const [list, setList] = useState<Order[] | null>(null);
  useEffect(() => { get<{ orders: Order[] }>('/api/store/orders').then(r => setList(r.orders)).catch(() => setList([])); }, []);
  if (!list) return <Spinner />;
  if (!list.length) return <Empty title={t('acc.noOrders')}><Link className="btn btn-primary mt" to="/search">{t('cart.continue')}</Link></Empty>;
  return <div className="stack">{list.map(o => (
    <Link key={o.code} to={'/order/' + o.code} className="card row between" style={{ color: 'inherit' }}>
      <div><b>{o.code}</b> <span className="muted small">· {date(o.created_at)}</span><div className="small muted">{o.items.map(i => i.title).join(', ').slice(0, 110)}</div></div>
      <div className="right"><b>{money(o.total)}</b><div><span className={'badge ' + statusBadge(o.status)}>{t('order.s.' + o.status)}</span></div></div>
    </Link>))}</div>;
}

function ProfileForm() {
  const { t, countries, countryName, lang, toast } = useApp(); const { profile, refresh } = useAuth(); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: '', phone: '', line1: '', postal: '', city: '', country: 'PL' });
  useEffect(() => { if (profile) setF({ name: profile.name || '', phone: profile.phone || '', line1: profile.address?.line1 || '', postal: profile.address?.postal || '', city: profile.address?.city || '', country: profile.address?.country || profile.country }); }, [profile?.id]);
  if (!profile) return <Spinner />;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const body: any = { name: f.name, phone: f.phone, country: f.country, lang };
      if (f.line1 && f.postal && f.city) body.address = { name: f.name, phone: f.phone || undefined, line1: f.line1, postal: f.postal, city: f.city, country: f.country };
      await api('PATCH', '/api/store/me', body); await refresh(); toast(t('common.saved'));
    } catch (x) { toast(errText(t, x), 'err'); }
    setBusy(false);
  };
  return (
    <form className="card stack" onSubmit={save}>
      <h3>{t('acc.profile')}</h3>
      <div className="small muted">{profile.email} · {t('acc.loyalty', { n: profile.loyalty.points })}{profile.loyalty.tier ? ` · ${profile.loyalty.tier}` : ''}</div>
      <div className="grid-2"><Field label={t('f.name')}><input className="input" value={f.name} onChange={set('name')} maxLength={80} autoComplete="name" /></Field>
        <Field label={t('f.phone')}><input className="input" value={f.phone} onChange={set('phone')} maxLength={30} autoComplete="tel" /></Field></div>
      <Field label={t('f.line1')}><input className="input" value={f.line1} onChange={set('line1')} maxLength={120} autoComplete="street-address" /></Field>
      <div className="grid-3"><Field label={t('f.postal')}><input className="input" value={f.postal} onChange={set('postal')} maxLength={12} autoComplete="postal-code" /></Field>
        <Field label={t('f.city')}><input className="input" value={f.city} onChange={set('city')} maxLength={60} autoComplete="address-level2" /></Field>
        <Field label={t('f.country')}><select className="input" value={f.country} onChange={set('country')}>{countries.map(c => <option key={c} value={c}>{countryName(c)}</option>)}</select></Field></div>
      <div><button className="btn btn-primary" disabled={busy}>{t('common.save')}</button></div>
    </form>
  );
}

function Security() {
  const { t, toast } = useApp(); const { profile, refresh } = useAuth(); const first = profile?.password_set === false; const [cur, setCur] = useState(''); const [nxt, setNxt] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { const r = await post('/api/store/me/password', first ? { next: nxt } : { current: cur, next: nxt }); tokens.setBuyer(r.token); setCur(''); setNxt(''); toast(t('common.saved')); if (first) refresh(); }
    catch (x) { toast(errText(t, x), 'err'); }
    setBusy(false);
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>{t(first ? 'sso.setPw' : 'acc.password')}</h3>
      {first && <div className="small muted">{t('sso.setPwHint')}</div>}
      <div className="grid-2">{!first && <Field label={t('acc.currentPw')}><input className="input" type="password" value={cur} onChange={e => setCur(e.target.value)} autoComplete="current-password" required /></Field>}
        <Field label={t('acc.newPw')} hint={t('auth.pwHint')}><input className="input" type="password" value={nxt} onChange={e => setNxt(e.target.value)} autoComplete="new-password" minLength={10} required /></Field></div>
      <div><button className="btn btn-ghost" disabled={busy}>{t(first ? 'sso.setPw' : 'acc.changePw')}</button></div>
    </form>
  );
}

function Privacy() {
  const { t, consent, setConsent, toast } = useApp(); const { logout, profile } = useAuth(); const nav = useNavigate(); const noPw = profile?.password_set === false;
  const [pw, setPw] = useState(''); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const exportData = async () => {
    try {
      const data = await get('/api/store/me/export'); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'asveli-my-data.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (x) { toast(errText(t, x), 'err'); }
  };
  const erase = async (e: FormEvent) => {
    e.preventDefault(); if (!confirm(t('acc.eraseConfirm'))) return; setBusy(true);
    try { await api('DELETE', '/api/store/me', noPw ? { confirm: pw === 'DELETE' ? 'DELETE' : '' } : { password: pw }); tokens.setBuyer(null); await logout(); toast(t('acc.erased')); nav('/'); }
    catch (x) { toast(x instanceof ApiError && x.code === 'open_orders' ? t('acc.openOrders') : errText(t, x), 'err'); }
    setBusy(false);
  };
  return (
    <section className="card stack">
      <h3>{t('acc.privacy')}</h3>
      <label className="row"><input type="checkbox" checked={consent === 'all'} onChange={e => setConsent(e.target.checked ? 'all' : 'essential')} /> <span>{t('acc.personalise')}</span></label>
      <div className="small muted">{t('acc.personaliseHint')}</div>
      <div><button className="btn btn-ghost" onClick={exportData}>{t('acc.export')}</button></div>
      {!open ? <div><button className="btn btn-danger" onClick={() => setOpen(true)}>{t('acc.erase')}</button></div> : (
        <form className="stack" onSubmit={erase}>
          <div className="notice warn small">{t('acc.eraseWarn')}</div>
          {noPw ? <Field label={t('sso.typeDelete')}><input className="input" value={pw} onChange={e => setPw(e.target.value)} autoComplete="off" required pattern="DELETE" /></Field>
            : <Field label={t('auth.password')}><input className="input" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" required /></Field>}
          <div className="row"><button className="btn btn-danger" disabled={busy}>{t('acc.eraseDo')}</button><button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button></div>
        </form>)}
    </section>
  );
}

export default function Account() {
  const { tab = 'orders', id } = useParams(); const { t } = useApp(); const { profile, ready } = useAuth(); const nav = useNavigate();
  document.title = t('menu.account') + ' — ASVELI';
  if (ready && !profile) return <Navigate to={'/login?next=/account/' + tab} replace />;
  if (!['orders', 'messages', 'profile'].includes(tab)) return <Navigate to="/account/orders" replace />;
  return (
    <>
      <h1 className="mt" style={{ fontSize: '1.6rem' }}>{t('menu.account')}</h1>
      <div className="tabs"><NavLink to="/account/orders">{t('menu.orders')}</NavLink><NavLink to="/account/messages">{t('menu.messages')}</NavLink><NavLink to="/account/profile">{t('menu.profile')}</NavLink></div>
      {tab === 'orders' ? <Orders /> : tab === 'messages' ? <Inbox base="/api/store/inquiries" me="buyer" id={id ? Number(id) : null} open={i => nav('/account/messages' + (i ? '/' + i : ''))} /> : <div className="stack"><ProfileForm /><SignInMethods /><Security /><Privacy /></div>}
    </>
  );
}
