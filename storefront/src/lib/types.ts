export interface Card {
  slug: string; title: string; brand: string | null; category: string; image: string | null; images: string[];
  price_from: number; price_to: number; offers: number; rating: number | null; reviews: number; in_stock: boolean; digital: boolean;
  product_id: number; was_price: number | null; currency: string; is_new: boolean; sponsored?: boolean; campaign_id?: number;
  category_slug?: string | null; kind?: CatKind; restricted?: 'none' | 'b2b_licence';
}
export type CatKind = 'shop' | 'classifieds' | 'rfq' | 'partner';
export interface CatNode { slug: string; name: string; icon: string | null; kind: CatKind; restricted: 'none' | 'b2b_licence'; count: number; children: CatNode[] }
export interface OtherOffer { id: number; source_name: string; source_kind: string | null; url: string; price: number; shipping: number | null; delivery_days: number | null; mode: 'link' | 'broker'; affiliate: boolean; checked_at: number; landed: number }
export interface Party { name: string; address: string | null; email: string | null; country?: string | null }
export interface Trader { name: string; address: string | null; country: string; registry: string | null; registration_no: string | null; vat_no: string | null; self_certified: boolean }
export interface ProductSafety { manufacturer: Party | null; responsible_person: Party | null; identifier: string | null; safety_info: string | null }
export interface Offer {
  product_id: number; seller: { id: number; name: string; country: string; rating: number | null; reviews: number; trader?: Trader | null };
  sold_in_country?: boolean; product_safety?: ProductSafety;
  price: number; shipping: number | null; landed: number | null; in_stock: boolean; ships_to_country: boolean;
  delivery: { min: number; max: number } | null; low_stock: number | null; digital: boolean; condition: string; score: number; buybox: boolean;
}
export interface Model extends Card {
  description: string; offers: any; buybox: Offer | null; reviews_summary: ReviewSummary; also_bought: Card[];
  seo: { title_tag: string | null; meta_description: string | null } | null;
}
export interface ModelFull extends Omit<Model, 'offers'> { offers: Offer[]; offer_count?: number; other_offers?: OtherOffer[]; category_path?: { slug: string; name: string }[] }
export interface ReviewSummary { count: number; avg: number | null; histogram: Record<string, number> }
export interface Review { id: number; rating: number; body: string; created_at: number; author: string; verified: boolean }
export interface Banner { id: number; placement: string; title: string; text: string | null; link: string | null }
export interface Home {
  banners: Banner[]; segments: string[]; continue: Card[]; for_you: { personal: boolean; items: Card[] };
  trending: Card[]; new: Card[]; deals: Card[]; categories: { name: string; count: number; image: string | null }[]; sponsored: Card[];
}
export interface SearchResult {
  total: number; page: number; limit: number; items: Card[]; sponsored: Card[]; suggest?: string[];
  facets: { categories: { name: string; count: number }[]; brands: { name: string; count: number }[]; price: { min: number; max: number };
    tree?: CatNode[]; price_bands?: { min: number; max: number | null; count: number }[] };
  category?: { slug: string; name: string; path: { slug: string; name: string }[]; kind: CatKind; restricted: string };
}
export interface QuoteLine { product_id: number; slug: string; title: string; image: string | null; seller: string; qty: number; unit_price: number; line_total: number; digital: boolean; unavailable?: boolean }
export interface Quote {
  currency: string; country: string; lines: QuoteLine[]; subtotal: number; discount: number; tax: number; tax_rate_bps: number; shipping: number; total: number; shipments: number;
  coupon: { code: string; discount: number } | null; coupon_error: string | null; issues: { product_id?: number; code: string; available?: number }[]; ok: boolean;
}
export interface Address { name?: string; phone?: string; line1: string; postal: string; city: string; country: string }
export interface Profile {
  id: number; password_set?: boolean; email: string | null; name: string | null; phone: string | null; country: string; lang: string | null; address: Address | null;
  loyalty: { tier: string | null; points: number; orders: number; spent: number }; currency: string;
}
export interface OrderItem { product_id: number; slug: string; title: string; image: string | null; qty: number; unit_price: number; seller: string; returned_qty: number; digital: boolean; download?: { name: string; url: string; expires_in_h: number } }
export interface Shipment { id: number; status: string; carrier: string | null; tracking_no: string | null; shipped_at: number | null; tracking_url: string | null }
export interface Order {
  code: string; status: string; created_at: number; country: string; currency: string; subtotal: number; discount: number; tax: number; shipping: number; total: number; coupon: string | null;
  items: OrderItem[]; shipments: Shipment[]; returns: { id: number; product_id: number; qty: number; reason: string; status: string; refund_amount: number }[]; can_cancel: boolean; can_return: boolean;
}
export interface CartItem { product_id: number; qty: number; slug: string; title: string; image: string | null; price: number; seller: string }

export interface OAuthProvider { id: 'google' | 'github' | 'amazon'; name: string }
export interface Identity { provider: OAuthProvider['id']; created_at: number; last_login: number | null }

export interface InqMsg { author: 'buyer' | 'seller' | 'staff'; body: string; at: number }
export interface Inquiry { id: number; kind: string; status: string; subject: string; with: string; buyer?: string; product: { slug: string; title: string; image: string | null } | null; last_message_at: number | null; created_at?: number; messages?: InqMsg[]; last?: InqMsg | null; quantity?: string | null; location?: string | null; company?: string | null }
