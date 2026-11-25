import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { get } from '../api';
import { useApp, useAuth, useCart } from '../state';
import { LANGS, LANG_NAMES, Lang } from '../i18n';
import { Logo } from './Logo';
import type { CatNode } from '../lib/types';

const Ico = ({ d }: { d: string }) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;
const I = { search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4', cart: 'M3 4h2l2.4 11h10.2L20 7H6.2M9 20a1 1 0 1 0 0 .01M17 20a1 1 0 1 0 0 .01', user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18' };

function useOutside(close: () => void) {
  const r = useRef<HTMLDivElement>(null);
  useEffect(() => { const f = (e: MouseEvent) => { if (r.current && !r.current.contains(e.target as Node)) close(); }; document.addEventListener('mousedown', f); return () => document.removeEventListener('mousedown', f); }, [close]);
  return r;
}

function SearchBox() {
  const { t } = useApp(); const nav = useNavigate(); const [sp] = useSearchParams(); const loc = useLocation();
  const [q, setQ] = useState(sp.get('q') || ''); const [items, setItems] = useState<{ text: string; type: string; slug: string | null }[]>([]); const [open, setOpen] = useState(false); const [hi, setHi] = useState(-1);
  const ref = useOutside(() => setOpen(false));
  useEffect(() => { if (loc.pathname !== '/search') setQ(''); }, [loc.pathname]);
  useEffect(() => {
    if (q.trim().length < 2) { setItems([]); return; }
    const id = setTimeout(() => { get('/api/store/suggest?q=' + encodeURIComponent(q), { auth: null }).then(r => { setItems(r.items); setHi(-1); }).catch(() => {}); }, 160);
    return () => clearTimeout(id);
  }, [q]);
  const go = (text: string) => { setOpen(false); nav('/search?q=' + encodeURIComponent(text)); };
  const submit = (e: FormEvent) => { e.preventDefault(); const it = items[hi]; if (it) { setOpen(false); if (it.type === 'product' && it.slug) nav('/p/' + it.slug); else go(it.text); } else go(q.trim()); };
  const key = (e: React.KeyboardEvent) => { if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(items.length - 1, h + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(-1, h - 1)); } else if (e.key === 'Escape') setOpen(false); };
  return (
    <div className="search" ref={ref} role="search">
      <form onSubmit={submit}>
        <input value={q} onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={key} placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} autoComplete="off" maxLength={100} />
        <button aria-label={t('search.go')}><Ico d={I.search} /></button>
      </form>
      {open && items.length > 0 && (
        <div className="suggest" role="listbox">
          {items.map((it, i) => <button key={it.type + it.text} className={i === hi ? 'on' : ''} onMouseDown={e => e.preventDefault()} onClick={() => (it.type === 'product' && it.slug ? (setOpen(false), nav('/p/' + it.slug)) : go(it.text))}>{it.text}<small>{t('suggest.' + it.type)}</small></button>)}
        </div>
      )}
    </div>
  );
}

function Pop({ icon, label, children, hideLabelOnMobile = true }: { icon: string; label: string; children: (close: () => void) => ReactNode; hideLabelOnMobile?: boolean }) {
  const [open, setOpen] = useState(false); const ref = useOutside(() => setOpen(false));
  return (
    <div className="menu" ref={ref}>
      <button className="link" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="menu" aria-label={label}><Ico d={icon} /><span className={hideLabelOnMobile ? 'hide-m' : ''}>{label}</span></button>
      {open && <div className="menu-pop" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Header() {
  const { t, lang, setLang, country, setCountry, countries, countryName } = useApp(); const { profile, logout } = useAuth(); const cart = useCart(); const nav = useNavigate();
  return (
    <>
      <div className="topbar"><div className="container">
        <span className="ship"><b>{t('top.ship')}</b> · {t('top.shipSub')}</span>
        <span><Link to="/seller" style={{ color: 'inherit' }}>{t('top.sell')}</Link></span>
      </div></div>
      <header className="header"><div className="container">
        <Logo />
        <SearchBox />
        <nav className="nav" aria-label="Main">
          <Pop icon={I.globe} label={`${lang.toUpperCase()} · ${country}`}>
            {close => (
              <div style={{ padding: 6, display: 'grid', gap: 10, minWidth: 220 }}>
                <label className="field"><span>{t('menu.language')}</span><select className="input" value={lang} onChange={e => setLang(e.target.value as Lang)}>{LANGS.map(l => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}</select></label>
                <label className="field"><span>{t('menu.deliverTo')}</span><select className="input" value={country} onChange={e => { setCountry(e.target.value); close(); }}>{countries.map(c => <option key={c} value={c}>{countryName(c)}</option>)}</select></label>
              </div>
            )}
          </Pop>
          {profile ? (
            <Pop icon={I.user} label={(profile.name || t('menu.account')).split(' ')[0]}>
              {close => (<>
                <Link to="/account/orders" onClick={close}>{t('menu.orders')}</Link>
                <Link to="/account/messages" onClick={close}>{t('menu.messages')}</Link>
                <Link to="/account/profile" onClick={close}>{t('menu.profile')}</Link>
                <button onClick={async () => { close(); await logout(); nav('/'); }}>{t('menu.logout')}</button>
              </>)}
            </Pop>
          ) : <NavLink to="/login" aria-label={t('menu.login')}><Ico d={I.user} /><span className="hide-m">{t('menu.login')}</span></NavLink>}
          <NavLink to="/cart" className="cart-link" aria-label={t('menu.cart')}><Ico d={I.cart} /><span className="hide-m">{t('menu.cart')}</span>{cart.count > 0 && <span className="cart-count">{cart.count}</span>}</NavLink>
        </nav>
      </div></header>
    </>
  );
}

export function CategoryBar({ tree }: { tree: CatNode[] }) {
  const { t } = useApp(); const [open, setOpen] = useState<string | null>(null); const loc = useLocation();
  const ref = useOutside(() => setOpen(null));
  useEffect(() => setOpen(null), [loc.pathname, loc.search]);
  if (!tree.length) return null;
  const roots = tree.filter((n, i) => i < 6 || n.count > 0 || n.kind !== 'shop');   // the launch niche (first roots) is always in the menu
  return (
    <div className="catbar" ref={ref}><div className="container">
      <Link to="/search">{t('nav.all')}</Link>
      {roots.map(n => (
        <div key={n.slug} className={'cat-root' + (open === n.slug ? ' on' : '')} onMouseEnter={() => setOpen(n.slug)} onMouseLeave={() => setOpen(null)}>
          <Link to={'/search?cat=' + n.slug} onClick={e => { if (n.children.length && open !== n.slug && matchMedia('(hover: none)').matches) { e.preventDefault(); setOpen(n.slug); } }} aria-haspopup={n.children.length ? 'menu' : undefined} aria-expanded={open === n.slug}>{n.icon ? n.icon + ' ' : ''}{n.name}</Link>
          {open === n.slug && n.children.length > 0 && (
            <div className="mega" role="menu">
              {n.children.map(c => (
                <div key={c.slug} className="mega-col">
                  <Link className="mega-h" to={'/search?cat=' + c.slug}>{c.name}{c.kind !== 'shop' && <small className="tag">{t('kind.' + c.kind)}</small>}{c.restricted === 'b2b_licence' && <small className="tag">B2B</small>}</Link>
                  {c.children.map(g => <Link key={g.slug} to={'/search?cat=' + g.slug}>{g.name}{g.count > 0 && <span className="n">{g.count}</span>}</Link>)}
                </div>))}
            </div>)}
        </div>))}
      <Link to="/request">{t('rfq.cta')}</Link>
      <Link to="/search?deals=1">{t('nav.deals')}</Link>
    </div></div>
  );
}

export function Footer() {
  const { t } = useApp();
  return (
    <footer className="footer"><div className="container">
      <div className="footer-grid">
        <div><Logo /><p className="muted small mt-s" style={{ maxWidth: 320 }}>{t('footer.tagline')}</p></div>
        <div><h4>{t('footer.shop')}</h4><ul><li><Link to="/search">{t('nav.all')}</Link></li><li><Link to="/search?deals=1">{t('nav.deals')}</Link></li><li><Link to="/search?sort=new">{t('footer.new')}</Link></li></ul></div>
        <div><h4>{t('footer.help')}</h4><ul><li><Link to="/info/shipping">{t('footer.shipping')}</Link></li><li><Link to="/info/returns">{t('footer.returns')}</Link></li><li><Link to="/info/about">{t('footer.about')}</Link></li></ul></div>
        <div><h4>{t('footer.legal')}</h4><ul><li><Link to="/info/terms">{t('footer.terms')}</Link></li><li><Link to="/info/privacy">{t('footer.privacy')}</Link></li><li><Link to="/seller">{t('top.sell')}</Link></li></ul></div>
      </div>
      <div className="legal"><span>© {new Date().getFullYear()} ASVELI. {t('footer.rights')}</span><span>info@asveli.org</span></div>
    </div></footer>
  );
}

export function ConsentBanner() {
  const { consent, setConsent, t } = useApp();
  if (consent) return null;
  return (
    <div className="consent" role="dialog" aria-label={t('consent.title')}>
      <p><b>{t('consent.title')}</b> {t('consent.text')} <Link to="/info/privacy">{t('footer.privacy')}</Link></p>
      <div className="row"><button className="btn btn-ghost btn-sm" onClick={() => setConsent('essential')}>{t('consent.essential')}</button><button className="btn btn-primary btn-sm" onClick={() => setConsent('all')}>{t('consent.all')}</button></div>
    </div>
  );
}

export function ScrollTop() { const { pathname } = useLocation(); useEffect(() => { window.scrollTo(0, 0); }, [pathname]); return null; }

export function ShopLayout() {
  const { lang } = useApp(); const [tree, setTree] = useState<CatNode[]>([]);
  useEffect(() => { get('/api/store/categories/tree?lang=' + lang, { auth: null }).then(r => setTree(r.tree)).catch(() => {}); }, [lang]);
  return (<><ScrollTop /><Header /><CategoryBar tree={tree} /><main className="container" style={{ minHeight: '60vh' }}><Outlet /></main><Footer /><ConsentBanner /></>);
}
