import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';
import { useApp, useAuth } from '../state';
import type { Card, CatNode, Home as HomeData } from '../lib/types';
import { ProductCard, CardSkeletons } from '../components/ProductCard';

const TILE_COLORS: [string, string][] = [['#4fe3d0', '#8b5cf6'], ['#8b5cf6', '#f472b6'], ['#4f8cff', '#4fe3d0'], ['#f472b6', '#4f8cff'], ['#4fe3d0', '#4f8cff'], ['#a78bfa', '#4fe3d0']];
const TILE_GLYPH: Record<string, string> = {
  Innovations: 'M50 18a32 32 0 1 0 0 64 32 32 0 0 0 0-64zm0 14v18l12 8', Audio: 'M22 62V50a28 28 0 0 1 56 0v12M22 56h8v22h-8zM70 56h8v22h-8z',
  Wellness: 'M50 84C30 70 22 56 24 42c2-12 14-18 26-8 12-10 24-4 26 8 2 14-6 28-26 42z', Style: 'M50 22a6 6 0 1 1 6 6v6l30 22a5 5 0 0 1-3 9H17a5 5 0 0 1-3-9l30-22',
  Home: 'M18 52 50 24l32 28v30H62V62H38v20H18z', Digital: 'M30 70a16 16 0 0 1 2-32 22 22 0 0 1 42 6 13 13 0 0 1-2 26z'
};

function HeroArt() {
  const nodes = [[60, 70], [120, 40], [170, 95], [230, 55], [290, 110], [210, 170], [110, 150], [320, 190]];
  return (
    <svg viewBox="0 0 380 260" aria-hidden>
      <defs>
        <radialGradient id="hb1" cx="30%" cy="30%"><stop offset="0" stopColor="#4fe3d0" stopOpacity=".95" /><stop offset="1" stopColor="#4fe3d0" stopOpacity=".15" /></radialGradient>
        <radialGradient id="hb2" cx="30%" cy="30%"><stop offset="0" stopColor="#b9a2ff" stopOpacity=".95" /><stop offset="1" stopColor="#8b5cf6" stopOpacity=".18" /></radialGradient>
        <filter id="hg"><feGaussianBlur stdDeviation="3" /></filter>
      </defs>
      <g stroke="#7f8cff" strokeOpacity=".35" strokeWidth="1">{nodes.slice(1).map((n, i) => <line key={i} x1={nodes[i][0]} y1={nodes[i][1]} x2={n[0]} y2={n[1]} />)}<line x1="120" y1="40" x2="210" y2="170" /><line x1="60" y1="70" x2="110" y2="150" /></g>
      {nodes.map((n, i) => <circle key={i} cx={n[0]} cy={n[1]} r={i % 3 === 0 ? 5 : 3.5} fill={i % 2 ? '#b9a2ff' : '#4fe3d0'} filter="url(#hg)" />)}
      <path className="blob" d="M40 130c-10-30 20-60 55-48 30 10 30 50 5 62s-52 4-60-14z" fill="url(#hb1)" />
      <path className="blob" d="M240 20c20-14 60-4 66 24 5 24-24 40-48 34-26-6-36-40-18-58z" fill="url(#hb2)" />
      <path className="blob" d="M250 150c16-16 54-8 62 18 6 24-18 44-44 40-28-4-34-40-18-58z" fill="url(#hb1)" opacity=".8" />
      <path className="blob" d="M120 190c12-12 40-6 46 14 4 18-14 32-34 29-20-3-24-30-12-43z" fill="url(#hb2)" opacity=".85" />
    </svg>
  );
}

function Row({ title, tag, items, to }: { title: string; tag?: string; items: Card[]; to?: string }) {
  const { t } = useApp();
  if (!items.length) return null;
  return (
    <section className="section">
      <div className="section-head"><h2>{title}{tag && <span className="tag">{tag}</span>}</h2>{to && <Link to={to}>{t('home.seeAll')} →</Link>}</div>
      <div className="rail">{items.map(c => <ProductCard key={c.slug} c={c} />)}</div>
    </section>
  );
}

export default function Home() {
  const { t, consent, lang } = useApp(); const { profile } = useAuth();
  const [d, setD] = useState<HomeData | null>(null); const [err, setErr] = useState(false); const [tree, setTree] = useState<CatNode[] | null>(null);
  useEffect(() => { get<{ tree: CatNode[] }>('/api/store/categories/tree?lang=' + lang, { auth: null }).then(r => setTree(r.tree)).catch(() => setTree([])); }, [lang]);
  const niche = (tree || []).filter(n => n.kind === 'shop').slice(0, 6);
  useEffect(() => { setD(null); get<HomeData>('/api/store/home').then(setD).catch(() => setErr(true)); }, [profile?.id, consent]);
  useEffect(() => { if (d?.sponsored.length) post('/api/store/ads/impressions', { ids: d.sponsored.map(s => s.campaign_id).filter(Boolean) }, { auth: null }).catch(() => {}); }, [d]);
  document.title = 'ASVELI — ' + t('b2b.title');
  return (
    <>
      <section className="hero">
        <div>
          <span className="badge cyan">{t('b2b.badge')}</span>
          <h1 className="mt-s">{t('b2b.title')}</h1>
          <p className="lead">{t('b2b.lead')}</p>
          <div className="row"><Link className="btn btn-primary btn-lg" to={niche[0] ? '/search?cat=' + niche[0].slug : '/search'}>{t('b2b.cta')}</Link><Link className="btn btn-neon btn-lg" to="/request">{t('b2b.rfq')}</Link></div>
        </div>
        <div className="hero-art"><HeroArt /></div>
      </section>

      {d && d.banners.length > 0 && <div className="banner-strip">{d.banners.map(b => <Link key={b.id} to={b.link && b.link.startsWith('/') ? b.link : '/search'}><b>{b.title}</b>{b.text && <span>{b.text}</span>}</Link>)}</div>}

      {err && <div className="notice err mt">{t('err.load')}</div>}
      {!d && !err && <div className="section"><CardSkeletons n={4} /></div>}
      {d && (
        <>
          {niche.length > 0 && <section className="section">
            <div className="section-head"><h2>{t('b2b.niche')}</h2><Link to="/search">{t('home.seeAll')} →</Link></div>
            <div className="tiles">{niche.map((c, i) => (
              <Link key={c.slug} className="tile" to={'/search?cat=' + c.slug} style={{ ['--c1' as any]: TILE_COLORS[i % 6][0], ['--c2' as any]: TILE_COLORS[i % 6][1] }}>
                <b>{c.name}</b><small>{c.children.slice(0, 3).map(x => x.name).join(' · ') || t('home.nProducts', { n: c.count })}</small>
                <span className="glyph tile-icon" aria-hidden>{c.icon}</span>
              </Link>))}
            </div>
          </section>}
          <section className="section b2b-points">
            {['p1', 'p2', 'p3'].map(k => <div key={k} className="card"><b>{t('b2b.' + k + 't')}</b><p className="muted small">{t('b2b.' + k)}</p></div>)}
          </section>
          <Row title={t('home.continue')} items={d.continue} />
          <Row title={d.for_you.personal ? t('home.forYou') : t('home.popular')} tag={d.for_you.personal ? t('home.personal') : undefined} items={d.for_you.items} />
          <Row title={t('home.sponsored')} items={d.sponsored} />
          <Row title={t('home.deals')} items={d.deals} to="/search?deals=1" />
          <Row title={t('home.trending')} items={d.trending} to="/search?sort=popular" />
          <Row title={t('home.new')} items={d.new} to="/search?sort=new" />
          {consent !== 'all' && <div className="notice mt">{t('home.personalHint')}</div>}
        </>
      )}
    </>
  );
}
