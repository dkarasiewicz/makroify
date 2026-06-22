import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

export default defineTool({
  description:
    "Set the quantity of an item already in the Makro cart (by bundleId). Returns the updated cart. Confirm with the user first.",
  inputSchema: z.object({
    bundleId: z.string().min(1),
    quantity: z.number().int().min(1).describe("New quantity (use makro_remove_from_cart to remove entirely)"),
  }),
  async execute({ bundleId, quantity }, ctx) {
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const cart = await makro.updateItem(bundleId, quantity);
    return { ok: true, total: cart.estimatedTotal, currency: cart.currency, itemCount: cart.items.length };
  },
});
