import { Http, cacheBust } from "./http";
import { SHOP_BASE } from "./config";
import type { RequestContext } from "./context";

/** One entry from the "recently bought" personal list (ids only — resolve for names). */
export interface RecentlyBoughtItem {
  variantId: string;
  bundleId: string;
  /** Last-ordered amount the shop remembers (usually 1). */
  amount: number;
}

/** A past order as shown in the order list. */
export interface OrderSummary {
  orderId: string;
  orderNumber: string;
  /** Order placed (epoch ms). */
  orderedAt: number;
  /** Scheduled/actual delivery (epoch ms), if known. */
  deliveryAt?: number;
  status: string;
  total: number | null;
  currency: string;
  itemCount: number;
}

export interface OrderList {
  total: number;
  /** Pass back as `cursor` to fetch the next page; null when exhausted. */
  nextCursor: string | null;
  orders: OrderSummary[];
}

/** A line of a past order. */
export interface OrderLineItem {
  bundleId: string;
  variantId: string;
  name: string;
  quantity: number;
  /** Gross unit price (PLN). */
  unitPrice: number | null;
  /** Gross line total (PLN). */
  lineTotal: number | null;
  replaced: boolean;
}

export interface OrderDetails {
  orderId: string;
  orderNumber: string;
  orderedAt: number;
  status: string;
  total: number | null;
  currency: string;
  itemCount: number;
  deliveryAddress?: string;
  items: OrderLineItem[];
}

/** Fetch the customer's "recently bought" list (up to ~last few months). */
export async function listRecentlyBought(http: Http, ctx: RequestContext): Promise<RecentlyBoughtItem[]> {
  const url =
    `${SHOP_BASE}/explore.personallists.v1/dynamicLists/country/${ctx.country}` +
    `/storeId/${ctx.storeId}/customerId/${ctx.customerId}/recentlyBought?${cacheBust()}`;
  const data = await http.json<{ items?: RawRecentItem[] }>(url);
  return (data.items ?? [])
    .map((it) => ({
      variantId: it.articleVariantId ?? "",
      bundleId: it.bundleId ?? it.bettyBundleId ?? "",
      amount: it.amount ?? 1,
    }))
    .filter((it) => it.bundleId);
}

/** List past orders, newest first. Page through with the returned `nextCursor`. */
export async function listOrders(
  http: Http,
  ctx: RequestContext,
  opts: { rows?: number; cursor?: string | null } = {},
): Promise<OrderList> {
  const p = new URLSearchParams({
    "order-type": "all",
    rows: String(opts.rows ?? 10),
    locale: ctx.locale,
    selectedCustomerStore: ctx.storeId,
  });
  if (opts.cursor) p.set("cursor-mark", opts.cursor);
  const url =
    `${SHOP_BASE}/cia/orderhistory/orderlist/country/${ctx.country}` +
    `/customerid/${ctx.customerId}?${p}&${cacheBust()}`;
  const data = await http.json<RawOrderList>(url);
  return {
    total: data.numberOfOrders ?? 0,
    nextCursor: data.nextCursorMark ?? null,
    orders: (data.orders ?? []).map((o) => ({
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      orderedAt: o.orderTimeStamp,
      deliveryAt: o.deliveryTimeStamp,
      status: o.status,
      total: o.price?.amount ?? null,
      currency: o.price?.currency ?? "PLN",
      itemCount: o.itemCount ?? 0,
    })),
  };
}

/** Full details (line items) for one order. */
export async function getOrderDetails(http: Http, ctx: RequestContext, orderId: string): Promise<OrderDetails> {
  const p = new URLSearchParams({ country: ctx.country, locale: ctx.locale, store: ctx.storeId });
  const url = `${SHOP_BASE}/cia/orderhistory/orderdetails/orderid/${orderId}?${p}&${cacheBust()}`;
  const d = await http.json<RawOrderDetails>(url);

  const items: OrderLineItem[] = [];
  for (const sub of d.subOrders ?? []) {
    for (const it of sub.items ?? []) {
      items.push({
        bundleId: it.bettyBundleId ?? "",
        variantId: it.bettyVariantId ?? "",
        name: it.description ?? it.bettyBundleId ?? "",
        quantity: it.quantity ?? 0,
        unitPrice: it.amountPrice?.amount ?? null,
        lineTotal: it.grossPrice?.amount ?? null,
        replaced: it.replacementStatus ? it.replacementStatus !== "NOT_REPLACED" : false,
      });
    }
  }
  const addr = d.subOrders?.find((s) => s.deliveryInformation)?.deliveryInformation;
  return {
    orderId: d.orderId,
    orderNumber: d.orderNumber,
    orderedAt: d.orderTimeStamp,
    status: d.status,
    total: d.price?.amount ?? null,
    currency: d.price?.currency ?? "PLN",
    itemCount: d.totalItemAmount ?? items.length,
    deliveryAddress: addr ? [addr.addressLine1, addr.addressLine2].filter(Boolean).join(", ") : undefined,
    items,
  };
}

// --- raw shapes (only the fields we read) ---------------------------------

interface RawRecentItem {
  articleVariantId?: string;
  bundleId?: string;
  bettyBundleId?: string;
  amount?: number;
}
interface RawMoney {
  amount?: number;
  currency?: string;
}
interface RawOrderSummary {
  orderId: string;
  orderNumber: string;
  orderTimeStamp: number;
  deliveryTimeStamp?: number;
  status: string;
  price?: RawMoney;
  itemCount?: number;
}
interface RawOrderList {
  numberOfOrders?: number;
  nextCursorMark?: string | null;
  orders?: RawOrderSummary[];
}
interface RawOrderItem {
  bettyBundleId?: string;
  bettyVariantId?: string;
  description?: string;
  quantity?: number;
  replacementStatus?: string;
  amountPrice?: RawMoney;
  grossPrice?: RawMoney;
}
interface RawSubOrder {
  deliveryInformation?: { addressLine1?: string; addressLine2?: string };
  items?: RawOrderItem[];
}
interface RawOrderDetails {
  orderId: string;
  orderNumber: string;
  orderTimeStamp: number;
  status: string;
  price?: RawMoney;
  totalItemAmount?: number;
  subOrders?: RawSubOrder[];
}
