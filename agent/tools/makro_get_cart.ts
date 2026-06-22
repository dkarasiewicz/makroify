import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

export default defineTool({
  description:
    "Get the current Makro cart: items with quantities and line totals, plus the estimated cart total (gross PLN).",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const cart = await makro.getCurrentCart();
    return {
      cartId: cart.cartId,
      itemCount: cart.items.length,
      total: cart.estimatedTotal,
      currency: cart.currency,
      items: cart.items.map((it) => ({
        bundleId: it.bundleId,
        name: it.name,
        quantity: it.quantity,
        lineTotal: it.lineTotal,
      })),
    };
  },
});
