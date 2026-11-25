import { Link } from 'react-router-dom';
import type { Card } from '../lib/types';
import { assetUrl, post } from '../api';
import { useApp } from '../state';
import { ProductArt } from './ProductArt';
import { Stars } from './ui';

export function ProductCard({ c }: { c: Card }) {
  const { t, money } = useApp();
  const img = assetUrl(c.image);
  const click = () => { if (c.sponsored && c.campaign_id) post(`/api/store/ads/${c.campaign_id}/click`, {}, { auth: null }).catch(() => {}); };
  return (
    <Link className="pcard" to={`/p/${c.slug}`} onClick={click}>
      <div className="media">
        {img ? <img src={img} alt={c.title} loading="lazy" /> : <ProductArt seed={c.slug} category={c.category} title={c.title} />}
        <div className="tags">
          {c.sponsored && <span className="badge">{t('common.sponsored')}</span>}
          {c.was_price && <span className="badge err">{t('common.deal')}</span>}
          {c.is_new && !c.was_price && <span className="badge cyan">{t('common.new')}</span>}
          {c.digital && <span className="badge">{t('common.digital')}</span>}
        </div>
      </div>
      <div className="body">
        {c.brand && <div className="brand">{c.brand}</div>}
        <div className="title">{c.title}</div>
        <Stars value={c.rating} count={c.reviews} />
        <div className="price">
          {c.price_from !== c.price_to && <span className="from">{t('common.from')}</span>}{money(c.price_from)}
          {c.was_price && c.was_price > c.price_from && <span className="was">{money(c.was_price)}</span>}
        </div>
        <div className="small muted">{c.in_stock ? (c.offers > 1 ? t('common.nOffers', { n: c.offers }) : t('common.inStock')) : <span className="stock-out">{t('common.outOfStock')}</span>}</div>
      </div>
    </Link>
  );
}
export const CardSkeletons = ({ n = 8 }: { n?: number }) => <div className="grid-products">{Array.from({ length: n }, (_, i) => <div key={i} className="skeleton skel-card" />)}</div>;
