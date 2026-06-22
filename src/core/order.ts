import { Http } from "./http";
import { MakroError } from "./errors";
import type { RequestContext } from "./context";

export interface PlaceOrderParams {
  cartId: string;
  /** Desired delivery date (YYYY-MM-DD); defaults to the cart's date. */
  deliveryDate?: string;
  /** Payment method id, when the checkout flow requires choosing one. */
  paymentId?: number;
  /** Optional customer order reference. */
  orderReference?: string;
  /** Don't actually submit — validate inputs only. */
  dryRun?: boolean;
}

export interface OrderResult {
  orderId: string;
  status: string;
}

/**
 * Place an order from a cart.
 *
 * NOT YET IMPLEMENTED — the captured HAR did not include a checkout submission,
 * so the exact endpoint/payload is unknown. Once a "place order" HAR is
 * provided, implement the checkout call(s) here (likely a POST under
 * `/ordercapture/checkout/...`). The signature is intentionally stable so the
 * CLI / Eve tools can wire to it now.
 */
export async function placeOrder(
  _http: Http,
  _ctx: RequestContext,
  _params: PlaceOrderParams,
): Promise<OrderResult> {
  throw new MakroError(
    "placeOrder is not implemented yet. Send a HAR capture of a real checkout " +
      "(the 'place order' click) and this will be wired up as the final step.",
  );
}
