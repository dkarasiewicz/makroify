import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

export default defineTool({
  description: "Remove an item from the Makro cart (by bundleId). Returns the updated cart. Confirm with the user first.",
  inputSchema: z.object({
    bundleId: z.string().min(1),
  }),
  async execute({ bundleId }, ctx) {
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const cart = await makro.removeItem(bundleId);
    return { ok: true, total: cart.estimatedTotal, currency: cart.currency, itemCount: cart.items.length };
  },
});
