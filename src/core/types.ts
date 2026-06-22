/** A single hit from the article search (IDs + price only — names need resolve). */
export interface SearchHit {
  /** variantId, e.g. "BTY-X3857140032". Resolve to a bundleId before cart ops. */
  variantId: string;
  price: number | null;
  isAvailable: boolean;
  recentlyOrdered: boolean;
  onList: boolean;
  score: number;
}

export interface SearchResults {
  query: string;
  total: number;
  page: number;
  totalPages: number;
  hits: SearchHit[];
}

/** A fully-resolved, orderable product. */
export interface Product {
  /** Orderable id used by all cart operations, e.g. "BTY-X38571400320021". */
  bundleId: string;
  variantId: string;
  /** Human display id / article number shown in the shop, e.g. "134408". */
  displayId?: string;
  name: string;
  brand?: string;
  /** Gross (incl. VAT) price for a single bundle, in PLN. */
  price: number | null;
  netPrice?: number | null;
  currency: string;
  vatPercent?: number;
  availability: string;
  /** Available-to-promise stock, if known. */
  stock?: number | null;
  /** e.g. "1 BUTELKA". */
  bundleSize?: string;
  chargedByWeight: boolean;
  minOrderQuantity?: number;
  maxOrderQuantity?: number | null;
  imageUrl?: string;
  categories: string[];
}

/** Raw item as stored in a cart (keyed by bundleId). */
export interface CartItemRaw {
  bundleId: string;
  quantity: number;
  addedAt?: number;
  comment?: string;
}

/** Cart item enriched with product details (name, price). */
export interface CartItem extends CartItemRaw {
  name?: string;
  unitPrice?: number | null;
  lineTotal?: number | null;
  availability?: string;
}

export interface Cart {
  cartId: string;
  cartName?: string;
  status?: string;
  storeId?: string;
  fsdAddressId?: string;
  items: CartItem[];
  /** Sum of line totals (gross), when prices could be resolved. */
  estimatedTotal?: number | null;
  currency?: string;
}

/** Lightweight cart summary from the carts list endpoint. */
export interface CartSummary {
  cartId: string;
  cartName?: string;
  status?: string;
  storeId?: string;
  fsdAddressId?: string;
  itemCount: number;
}
