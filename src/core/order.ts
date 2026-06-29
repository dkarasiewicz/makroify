import { randomUUID } from "node:crypto";
import { Http } from "./http";
import { SHOP_BASE } from "./config";
import { MakroError } from "./errors";
import { defaultDeliveryDate, isoDate, type RequestContext } from "./context";

export interface PlaceOrderParams {
  /** Cart to order. */
  cartId: string;
  /** Delivery date (YYYY-MM-DD); defaults to the next day. */
  deliveryDate?: string;
  /** fsdAddressId for the cart; defaults to the request context. */
  fsdAddressId?: string;
  /** Run checkout + force cash payment but stop before submitting (no order). */
  dryRun?: boolean;
}

export interface OrderResult {
  /** "SUBMITTED" when the order was placed; "DRY_RUN" when stopped before submit. */
  status: string;
  /** Server-side submission id (proof the order went through). */
  submitId?: string;
  /** The checkout session id used. */
  checkoutId: string;
  /** Gross total of the placed order (PLN). */
  total: number | null;
  currency: string;
  /** When it was submitted (epoch ms). */
  submittedAt?: number;
}

const CHECKOUT_BASE = `${SHOP_BASE}/ordercapture/checkout/checkout`;

/**
 * Place an order from a cart, mirroring the shop's checkout: open a checkout
 * session, force **cash on delivery** as the payment method, then submit.
 *
 * Irreversible — callers MUST confirm with the user first. Pass `dryRun` to run
 * everything except the final submit.
 */
export async function placeOrder(
  http: Http,
  ctx: RequestContext,
  params: PlaceOrderParams,
): Promise<OrderResult> {
  if (!params.cartId) throw new MakroError("placeOrder requires a cartId.");
  const fsdAddressId = params.fsdAddressId ?? ctx.fsdAddressId;
  const deliveryDate = params.deliveryDate ?? isoDate(defaultDeliveryDate());

  const checkoutId = await openCheckout(http, ctx, params.cartId, fsdAddressId, deliveryDate);
  // Always pay cash on delivery, regardless of the account's default payment.
  await setCashPayment(http, ctx, checkoutId);

  if (params.dryRun) {
    return { status: "DRY_RUN", checkoutId, total: null, currency: "PLN" };
  }

  const result = await submitCheckout(http, ctx, checkoutId);
  // The shop opens a fresh empty cart after a successful order — best effort.
  await openFreshCart(http, ctx, fsdAddressId).catch(() => {});
  return result;
}

/** Path segment shared by the checkout sub-endpoints. */
function checkoutSeg(ctx: RequestContext, checkoutId: string): string {
  return `${ctx.country}/${ctx.storeId}/${ctx.customerId}/${ctx.cardholderNumber}/${checkoutId}`;
}

/** Step 1: open a checkout session for the cart → returns the checkoutId. */
async function openCheckout(
  http: Http,
  ctx: RequestContext,
  cartId: string,
  fsdAddressId: string | undefined,
  deliveryDate: string,
): Promise<string> {
  const p = new URLSearchParams({
    customerId: ctx.customerId,
    cardholderNumber: ctx.cardholderNumber,
    storeId: ctx.storeId,
    country: ctx.country,
    locale: ctx.locale,
    sync: "true",
  });
  if (fsdAddressId) p.set("fsdAddressId", fsdAddressId);
  const url = `${SHOP_BASE}/ordercapture/customercart/carts/${cartId}/order-data/checkout?${p}`;
  const res = await http.json<{ data?: { checkoutId?: string } }>(url, {
    method: "POST",
    json: {
      requestId: `BTOC-${randomUUID()}`,
      customerId: ctx.customerId,
      shownDeliveryDate: deliveryDate,
      checkBundleIdsForMovPerSupplier: false,
    },
  });
  const checkoutId = res.data?.checkoutId;
  if (!checkoutId) throw new MakroError("Checkout did not return a checkoutId (cart may be empty or unavailable).");
  return checkoutId;
}

/** Step 2: set payment to cash on delivery. */
async function setCashPayment(http: Http, ctx: RequestContext, checkoutId: string): Promise<void> {
  await http.request(`${CHECKOUT_BASE}/payment-method/${checkoutSeg(ctx, checkoutId)}`, {
    method: "PUT",
    json: {
      mainPaymentId: { allowance: "PAYMENT_ON_DELIVERY", type: "CASH" },
      mainPaymentFulfillmentTypes: ["FSD"],
      complementaryPaymentId: null,
    },
  });
}

/** Step 3: submit the checkout → places the order. */
async function submitCheckout(http: Http, ctx: RequestContext, checkoutId: string): Promise<OrderResult> {
  const url = `${CHECKOUT_BASE}/submit/${checkoutSeg(ctx, checkoutId)}?locale=${ctx.locale}`;
  const res = await http.json<SubmitResponse>(url, {
    method: "POST",
    json: {
      saveCreditCardPermitted: false,
      useNewPaymentSelection: true,
      deviceChannel: "BROWSER",
      hipayBrowserInfo: {
        isJavaEnabled: false,
        isJavascriptEnabled: true,
        language: "pl-PL",
        colorDepth: 24,
        screenHeight: 1080,
        screenWidth: 1920,
        timezoneOffsetInMinutes: 0,
      },
    },
  });
  const data = res.data;
  const status = data?.status?.type ?? "UNKNOWN";
  const gross = data?.checkoutPrices?.grandTotal?.article?.gross;
  return {
    status,
    submitId: data?.status?.submitId,
    checkoutId,
    total: gross?.amount ?? null,
    currency: gross?.currency ?? "PLN",
    submittedAt: data?.status?.timestamp,
  };
}

/** After ordering, open a fresh empty cart (what the shop UI does). */
async function openFreshCart(http: Http, ctx: RequestContext, fsdAddressId?: string): Promise<void> {
  await http.request(`${SHOP_BASE}/ordercapture/customercart/carts?sync=true`, {
    method: "POST",
    json: {
      requestId: `BTOC-${randomUUID()}`,
      customerId: ctx.customerId,
      cardholderNumber: ctx.cardholderNumber,
      storeId: ctx.storeId,
      fsdAddressId,
      country: ctx.country,
      locale: ctx.locale,
    },
  });
}

interface Money {
  amount?: number;
  currency?: string;
}
interface SubmitResponse {
  data?: {
    status?: { type?: string; submitId?: string; timestamp?: number };
    checkoutPrices?: { grandTotal?: { article?: { gross?: Money } } };
  };
}
