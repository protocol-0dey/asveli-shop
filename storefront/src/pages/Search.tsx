import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post } from '../api';
import { useApp } from '../state';
import type { CatNode, SearchResult } from '../lib/types';
import { ProductCard, CardSkeletons } from '../components/ProductCard';
import { Empty } from '../components/ui';

export default function Search() {
  const { t, money, pl, country, lang } = useApp(); const [sp, setSp] = useSearchParams();
  const [r, setR] = useState<SearchResult | null>(null); const [err, setErr] = useState(false); const [open, setOpen] = useState(false);
  const p = (k: string) => sp.get(k) || '';
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } if (!('page' in patch)) n.delete('page'); setSp(n, { replace: false }); };
  const qs = sp.toString();
  useEffect(() => { setR(null); setErr(false); get<SearchResult>('/api/store/search?' + qs + (qs ? '&' : '') + 'country=' + country + '&lang=' + lang).then(setR).catch(() => setErr(true)); }, [qs, country, lang]);
  useEffect(() => { if (r?.sponsored.length) post('/api/store/ads/impressions', { ids: r.sponsored.map(s => s.campaign_id).filter(Boolean) }, { auth: null }).catch(() => {}); }, [r]);
  const brands = useMemo(() => new Set(p('brand').split(',').filter(Boolean)), [qs]);
  const toggleBrand = (b: string) => { const n = new Set(brands); n.has(b) ? n.delete(b) : n.add(b); set({ brand: [...n].join(',') || null }); };
  const [min, setMin] = useState(p('min') ? String(+p('min') / 100) : ''); const [max, setMax] = useState(p('max') ? String(+p('max') / 100) : '');
  useEffect(() => { setMin(p('min') ? String(+p('min') / 100) : ''); setMax(p('max') ? String(+p('max') / 100) : ''); }, [p('min'), p('max')]);
  const applyPrice = () => set({ min: min ? String(Math.round(+min * 100)) : null, max: max ? String(Math.round(+max * 100)) : null });
  const title = p('q') ? t('search.resultsFor', { q: p('q') }) : r?.category?.name || p('category') || (p('deals') ? t('nav.deals') : t('nav.all'));
  document.title = title + ' — ASVELI';
  const pages = r ? Math.ceil(r.total / r.limit) : 0;

  return (
    <div className="search-layout">
      <aside className={'filters ' + (open ? 'open' : '')} aria-label={t('search.filters')}>
        {r && r.facets.tree && r.facets.tree.length > 0 ? <div><h4>{t('search.category')}</h4>
          <div className="tree"><a href="#" className={!p('cat') ? 'on' : ''} onClick={e => { e.preventDefault(); set({ cat: null, category: null }); }}>{t('cat.all')}</a><Tree nodes={r.facets.tree} cur={p('cat')} pick={slug => set({ cat: slug, category: null })} /></div></div>
        : r && r.facets.categories.length > 0 && <div><h4>{t('search.category')}</h4>
          <label className="opt"><input type="radio" name="cat" checked={!p('category')} onChange={() => set({ category: null })} />{t('nav.all')}</label>
          {r.facets.categories.map(c => <label key={c.name} className="opt"><input type="radio" name="cat" checked={p('category') === c.name} onChange={() => set({ category: c.name })} />{c.name}<span className="n">{c.count}</span></label>)}</div>}
        <div><h4>{t('search.delivery')}</h4>{['', '2', '7', '30'].map(d => <label key={d} className="opt"><input type="radio" name="dl" checked={p('delivery') === d} onChange={() => set({ delivery: d || null })} />{t(d ? 'search.d' + d : 'search.dAny')}</label>)}</div>
        {r && r.facets.brands.length > 0 && <div><h4>{t('search.brand')}</h4>{r.facets.brands.map(b => <label key={b.name} className="opt"><input type="checkbox" checked={brands.has(b.name)} onChange={() => toggleBrand(b.name)} />{b.name}<span className="n">{b.count}</span></label>)}</div>}
        <div><h4>{t('search.price')}</h4>
          <div className="row" style={{ flexWrap: 'nowrap' }}><input className="input" inputMode="decimal" placeholder={r ? String(Math.floor(r.facets.price.min / 100)) : 'min'} value={min} onChange={e => setMin(e.target.value.replace(/[^\d.]/g, ''))} aria-label="min" /><span>–</span><input className="input" inputMode="decimal" placeholder={r ? String(Math.ceil(r.facets.price.max / 100)) : 'max'} value={max} onChange={e => setMax(e.target.value.replace(/[^\d.]/g, ''))} aria-label="max" /></div>
          <button className="btn btn-ghost btn-sm mt-s" onClick={applyPrice}>{t('search.apply')}</button>
          {r && r.facets.price_bands && r.facets.price_bands.length > 1 && <div className="chips mt-s" aria-label={t('search.priceBands')}>{r.facets.price_bands.map(b => { const on = p('min') === String(b.min || '') && p('max') === String(b.max ?? ''); return <button key={b.min} className={on ? 'on' : ''} onClick={() => set(on ? { min: null, max: null } : { min: b.min ? String(b.min) : null, max: b.max != null ? String(b.max) : null })}>{b.max == null ? t('search.bandFrom', { a: money(b.min) }) : t('search.bandRange', { a: money(b.min), b: money(b.max) })} <span className="muted">{b.count}</span></button>; })}</div>}</div>
        <div><h4>{t('search.rating')}</h4>{[4, 3].map(n => <label key={n} className="opt"><input type="radio" name="rt" checked={p('rating') === String(n)} onChange={() => set({ rating: String(n) })} />{t('search.andUp', { n })}</label>)}<label className="opt"><input type="radio" name="rt" checked={!p('rating')} onChange={() => set({ rating: null })} />{t('nav.all')}</label></div>
        <div><label className="opt"><input type="checkbox" checked={p('in_stock') === '1'} onChange={e => set({ in_stock: e.target.checked ? '1' : null })} />{t('search.inStock')}</label><label className="opt"><input type="checkbox" checked={p('deals') === '1'} onChange={e => set({ deals: e.target.checked ? '1' : null })} />{t('nav.deals')}</label></div>
      </aside>
      <section>
        <div className="toolbar">
          <div><h1 style={{ fontSize: '1.5rem', margin: 0 }}>{title}</h1>{r && <span className="muted small">{pl('search.count', r.total)}</span>}</div>
          <div className="row">
            <button className="btn btn-ghost btn-sm filter-toggle" onClick={() => setOpen(o => !o)}>{t('search.filters')}</button>
            <select className="input" style={{ width: 'auto' }} value={p('sort')} onChange={e => set({ sort: e.target.value || null })} aria-label={t('search.sort')}>
              {['', 'price_asc', 'price_desc', 'fast', 'rating', 'popular', 'new'].map(s => <option key={s} value={s}>{t('sort.' + (s || 'relevance'))}</option>)}
            </select>
          </div>
        </div>
        {r?.category && r.category.path.length > 1 && <nav className="crumbs" aria-label="breadcrumbs">{r.category.path.map((c, i) => <span key={c.slug}>{i > 0 && '› '}<Link to={'/search?cat=' + c.slug}>{c.name}</Link></span>)}</nav>}
        {r?.category?.kind === 'rfq' && <div className="cta-band"><div><h3>{t('rfq.ctaTitle')}</h3><p>{t('rfq.ctaText')}</p></div><Link className="btn btn-primary" to={'/request?cat=' + r.category.slug}>{t('rfq.cta')}</Link></div>}
        {r?.category?.restricted === 'b2b_licence' && <div className="notice">{t('pdp.b2bHint')}</div>}
        {err && <div className="notice err">{t('err.load')}</div>}
        {!r && !err && <CardSkeletons />}
        {r && r.sponsored.length > 0 && <div className="mb"><div className="small muted mb" style={{ marginBottom: 8 }}>{t('common.sponsored')}</div><div className="grid-products">{r.sponsored.map(c => <ProductCard key={'s' + c.slug} c={c} />)}</div><hr className="sep" /></div>}
        {r && r.items.length > 0 && <div className="grid-products">{r.items.map(c => <ProductCard key={c.slug} c={c} />)}</div>}
        {r && r.items.length === 0 && (
          <Empty title={t('search.none')}>
            {r.suggest && r.suggest.length > 0 && <p>{t('search.didYouMean')} {r.suggest.map(s => <Link key={s} className="chip" to={'/search?q=' + encodeURIComponent(s)} style={{ marginLeft: 6 }}>{s}</Link>)}</p>}
            <Link className="btn btn-ghost" to="/search">{t('search.reset')}</Link>
          </Empty>)}
        {pages > 1 && <nav className="pager" aria-label="pagination">
          <button className="btn btn-ghost btn-sm" disabled={r!.page <= 1} onClick={() => set({ page: String(r!.page - 1) })}>←</button>
          <span className="muted" style={{ alignSelf: 'center' }}>{r!.page} / {pages}</span>
          <button className="btn btn-ghost btn-sm" disabled={r!.page >= pages} onClick={() => set({ page: String(r!.page + 1) })}>→</button></nav>}
        <span className="sr">{money(0)}</span>
      </section>
    </div>
  );
}

function Tree({ nodes, cur, pick, depth = 0 }: { nodes: CatNode[]; cur: string; pick: (slug: string) => void; depth?: number }) {
  const { t } = useApp();
  const has = (n: CatNode): boolean => n.slug === cur || n.children.some(has);
  return <>{nodes.filter(n => n.count > 0 || n.kind !== 'shop').map(n => (
    <div key={n.slug}>
      <a href={'/search?cat=' + n.slug} className={n.slug === cur ? 'on' : ''} onClick={e => { e.preventDefault(); pick(n.slug); }}>{depth === 0 && n.icon ? n.icon + ' ' : ''}{n.name}{n.kind !== 'shop' && <small className="tag">{t('kind.' + n.kind)}</small>}{n.count > 0 && <span className="n">{n.count}</span>}</a>
      {n.children.length > 0 && has(n) && <div className="sub"><Tree nodes={n.children} cur={cur} pick={pick} depth={depth + 1} /></div>}
    </div>))}</>;
}
