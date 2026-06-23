import { Http, cacheBust } from "./http";
import { SHOP_BASE } from "./config";
import { ResolutionError } from "./errors";
import { compactDate, defaultDeliveryDate, type RequestContext } from "./context";
import type { Product, SearchHit, SearchResults } from "./types";

/** A bundleId is a variantId plus a 4-digit bundle/packaging suffix. */
export function variantIdFromBundleId(bundleId: string): string {
  return bundleId.slice(0, -4);
}

interface RawSearchResponse {
  amount: number;
  page: number;
  totalPages: number;
  resultIds: string[];
  results: Record<
    string,
    { id: string; price: number | null; isAvailable: boolean; recentlyOrdered: boolean; onList: boolean; score: number }
  >;
}

export interface SearchOptions {
  rows?: number;
  page?: number;
}

/** Full-text product search. Returns variant ids + prices (resolve for names). */
export async function search(
  http: Http,
  ctx: RequestContext,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResults> {
  const rows = opts.rows ?? 24;
  const page = opts.page ?? 1;
  const params = new URLSearchParams({
    language: ctx.locale,
    country: ctx.country,
    customerId: ctx.customerId,
    storeId: ctx.storeId,
    categories: "false",
    facets: "false",
    filter: "delivery_mode:METRO_DELIVERY",
    profile: "searchSuggest",
    query,
    rows: String(rows),
    page: String(page),
  });
  const url = `${SHOP_BASE}/searchdiscover/articlesearch/search?${params}&${cacheBust()}`;
  const data = await http.json<RawSearchResponse>(url);

  const hits: SearchHit[] = (data.resultIds ?? []).map((id) => {
    const r = data.results?.[id];
    return {
      variantId: id,
      price: r?.price ?? null,
      isAvailable: r?.isAvailable ?? false,
      recentlyOrdered: r?.recentlyOrdered ?? false,
      onList: r?.onList ?? false,
      score: r?.score ?? 0,
    };
  });

  return { query, total: data.amount ?? hits.length, page: data.page ?? page, totalPages: data.totalPages ?? 1, hits };
}

/**
 * Resolve variant ids to full {@link Product} records via `betty-variants`.
 * Returns a map keyed by variantId; the chosen bundle is the article's default
 * (first) bundle, which is what the shop adds to the cart.
 */
export async function resolveVariants(
  http: Http,
  ctx: RequestContext,
  variantIds: string[],
  deliveryDate: Date = defaultDeliveryDate(),
): Promise<Map<string, Product>> {
  const out = new Map<string, Product>();
  if (variantIds.length === 0) return out;

  const params = new URLSearchParams({
    country: ctx.country,
    locale: ctx.locale,
    customerId: ctx.customerId,
    deliveryDate: compactDate(deliveryDate),
  });
  params.append("storeIds", ctx.storeId);
  for (const id of variantIds) params.append("ids", id);
  const url = `${SHOP_BASE}/evaluate.article.v1/betty-variants?${params}&${cacheBust()}`;

  const data = await http.json<{ result?: Record<string, RawArticle> }>(url);
  for (const product of flattenBettyVariants(data.result ?? {}, ctx.storeId)) {
    out.set(product.variantId, product);
  }
  return out;
}

/** Resolve a single variant id (throws if not found). */
export async function getProductByVariant(
  http: Http,
  ctx: RequestContext,
  variantId: string,
  deliveryDate?: Date,
): Promise<Product> {
  const map = await resolveVariants(http, ctx, [variantId], deliveryDate);
  const p = map.get(variantId);
  if (!p) throw new ResolutionError(`Could not resolve variant ${variantId} to an orderable product`);
  return p;
}

/**
 * Resolve products for a set of bundle ids (used to enrich cart lines).
 * Returns a map keyed by bundleId.
 */
export async function resolveBundles(
  http: Http,
  ctx: RequestContext,
  bundleIds: string[],
  deliveryDate?: Date,
): Promise<Map<string, Product>> {
  const variantIds = [...new Set(bundleIds.map(variantIdFromBundleId))];
  const byVariant = await resolveVariants(http, ctx, variantIds, deliveryDate);
  const byBundle = new Map<string, Product>();
  for (const p of byVariant.values()) byBundle.set(p.bundleId, p);
  // A requested bundle whose default differs still maps to its variant's
  // product, so callers always get a name/price.
  for (const bundleId of bundleIds) {
    if (!byBundle.has(bundleId)) {
      const p = byVariant.get(variantIdFromBundleId(bundleId));
      if (p) byBundle.set(bundleId, { ...p, bundleId });
    }
  }
  return byBundle;
}

// Raw betty-variants shapes — only the fields we read.
interface RawSellingPriceInfo {
  finalPrice?: number;
  grossPrice?: number;
  netPrice?: number;
  shelfPrice?: number;
  currency?: string;
  vatPercent?: number;
}
interface RawArticle {
  variants?: Record<string, RawVariant>;
}
interface RawVariant {
  bettyVariantId?: { bettyVariantId?: string };
  description?: string;
  ownBrand?: string;
  bundles?: Record<string, RawBundle>;
}
interface RawBundle {
  bundleId?: { bettyBundleId?: string };
  availability?: string;
  stores?: Record<string, RawStore>;
}
interface RawStore {
  sortHints?: { priceHint?: number };
  possibleDeliveryModes?: Record<
    string,
    { possibleFulfillmentTypes?: Record<string, { sellingPriceInfo?: RawSellingPriceInfo; atpAvailableStock?: number }> }
  >;
}

/** Turn the deeply-nested betty-variants payload into flat Products. */
function flattenBettyVariants(result: Record<string, RawArticle>, storeId: string): Product[] {
  const products: Product[] = [];
  for (const article of Object.values(result)) {
    for (const variant of Object.values(article.variants ?? {})) {
      const variantId = variant.bettyVariantId?.bettyVariantId;
      const bundles = Object.values(variant.bundles ?? {});
      const bundle = bundles[0]; // default/first packaging
      const bundleId = bundle?.bundleId?.bettyBundleId;
      if (!variantId || !bundleId) continue;

      const store = bundle?.stores?.[storeId];
      const fulfillment = firstFulfillment(store);
      const price = fulfillment?.sellingPriceInfo;

      products.push({
        bundleId,
        variantId,
        name: variant.description ?? bundleId,
        brand: variant.ownBrand,
        price: price?.finalPrice ?? price?.grossPrice ?? store?.sortHints?.priceHint ?? null,
        netPrice: price?.netPrice ?? null,
        currency: price?.currency ?? "PLN",
        vatPercent: price?.vatPercent,
        availability: bundle?.availability ?? "UNKNOWN",
        stock: fulfillment?.atpAvailableStock ?? null,
        chargedByWeight: false,
        categories: [],
      });
    }
  }
  return products;
}

function firstFulfillment(store?: RawStore) {
  for (const mode of Object.values(store?.possibleDeliveryModes ?? {})) {
    for (const ff of Object.values(mode.possibleFulfillmentTypes ?? {})) {
      return ff;
    }
  }
  return undefined;
}
