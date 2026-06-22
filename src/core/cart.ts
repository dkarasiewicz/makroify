import { randomUUID } from "node:crypto";
import { Http, cacheBust } from "./http";
import { SHOP_BASE } from "./config";
import type { RequestContext } from "./context";
import type { Cart, CartItem, CartSummary } from "./types";

/** Shared query params for cart endpoints. */
function cartQuery(ctx: RequestContext): URLSearchParams {
  const p = new URLSearchParams({
    customerId: ctx.customerId,
    cardholderNumber: ctx.cardholderNumber,
    storeId: ctx.storeId,
    country: ctx.country,
    locale: ctx.locale,
  });
  if (ctx.fsdAddressId) p.set("fsdAddressId", ctx.fsdAddressId);
  return p;
}

const cartBase = (cartId: string) => `${SHOP_BASE}/ordercapture/customercart/carts/${cartId}`;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** List saved/active carts (lightweight summaries). */
export async function listCarts(
  http: Http,
  ctx: RequestContext,
  status?: "SAVED" | "ACTIVE",
): Promise<CartSummary[]> {
  const p = new URLSearchParams({
    customerId: ctx.customerId,
    storeId: ctx.storeId,
    country: ctx.country,
  });
  if (status) p.set("status", status);
  const url = `${SHOP_BASE}/ordercapture/customercart/carts?${p}&${cacheBust()}`;
  const data = await http.json<{ data?: { carts?: RawCartSummary[] } }>(url);
  return (data.data?.carts ?? []).map((c) => ({
    cartId: c.cartId,
    cartName: c.cartName ?? undefined,
    status: c.status,
    storeId: c.storeId,
    fsdAddressId: c.fsdAddressId,
    itemCount: Object.keys(c.items ?? {}).length,
  }));
}

/** The current/active cart with fully-resolved item details and totals. */
export async function getCurrentCart(http: Http, ctx: RequestContext): Promise<Cart> {
  const url = `${cartBase("alias/current")}?${cartQuery(ctx)}&${cacheBust()}`;
  const res = await http.json<{ data?: RawCart }>(url);
  return parseCart(res.data);
}

/** Fetch a specific cart by id. */
export async function getCart(http: Http, ctx: RequestContext, cartId: string): Promise<Cart> {
  const url = `${cartBase(cartId)}?${cartQuery(ctx)}&status=ACTIVE&${cacheBust()}`;
  const res = await http.json<{ data?: RawCart }>(url);
  return parseCart(res.data);
}

// ---------------------------------------------------------------------------
// Mutations (all return 202; re-fetch the cart to see the result)
// ---------------------------------------------------------------------------

export async function addItem(
  http: Http,
  ctx: RequestContext,
  cartId: string,
  bundleId: string,
  quantity: number,
  comment = "",
): Promise<void> {
  const url = `${cartBase(cartId)}/items?${cartQuery(ctx)}`;
  await http.request(url, {
    method: "POST",
    json: { requestId: `add-to-cart-${randomUUID()}`, customerId: ctx.customerId, bundleId, quantity, comment },
  });
}

export async function updateItemQuantity(
  http: Http,
  ctx: RequestContext,
  cartId: string,
  bundleId: string,
  quantity: number,
): Promise<void> {
  const url = `${cartBase(cartId)}/items/${bundleId}/quantity?${cartQuery(ctx)}`;
  await http.request(url, {
    method: "PUT",
    json: { requestId: `BTOC-${randomUUID()}`, customerId: ctx.customerId, quantity },
  });
}

export async function removeItem(
  http: Http,
  ctx: RequestContext,
  cartId: string,
  bundleId: string,
): Promise<void> {
  const p = cartQuery(ctx);
  p.set("requestId", `BTOC-${randomUUID()}`);
  const url = `${cartBase(cartId)}/items/${bundleId}?${p}`;
  await http.request(url, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Money {
  amount: number | null;
  currency: string;
}
interface RawCartItem {
  quantity: number;
  comment: string | null;
  addedTimestamp?: number;
  description?: string;
  bundleId?: string;
  availability?: string;
  prices?: {
    single?: { article?: { gross?: Money } };
    bundle?: { sum?: { gross?: Money } };
  };
}
interface RawCart {
  cartId: string;
  cartName: string | null;
  status?: string;
  storeId?: string;
  fsdAddressId?: string;
  items?: Record<string, RawCartItem>;
  totalPrices?: { basket?: { total?: { gross?: Money } } };
}
interface RawCartSummary {
  cartId: string;
  cartName: string | null;
  status?: string;
  storeId?: string;
  fsdAddressId?: string;
  items?: Record<string, unknown>;
}

function parseCart(raw?: RawCart): Cart {
  if (!raw) return { cartId: "", items: [], estimatedTotal: null };
  const items: CartItem[] = Object.entries(raw.items ?? {}).map(([bundleId, it]) => ({
    bundleId: it.bundleId ?? bundleId,
    quantity: it.quantity,
    addedAt: it.addedTimestamp,
    comment: it.comment ?? undefined,
    name: it.description,
    availability: it.availability,
    unitPrice: it.prices?.single?.article?.gross?.amount ?? null,
    lineTotal: it.prices?.bundle?.sum?.gross?.amount ?? null,
  }));
  const total = raw.totalPrices?.basket?.total?.gross;
  return {
    cartId: raw.cartId,
    cartName: raw.cartName ?? undefined,
    status: raw.status,
    storeId: raw.storeId,
    fsdAddressId: raw.fsdAddressId,
    items,
    estimatedTotal: total?.amount ?? null,
    currency: total?.currency ?? "PLN",
  };
}
