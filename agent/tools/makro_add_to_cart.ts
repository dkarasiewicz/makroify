import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

export default defineTool({
  description:
    "Add a product to the current Makro cart. Pass the bundleId from makro_search. Returns the updated cart. Confirm the item and quantity with the user first.",
  inputSchema: z.object({
    bundleId: z.string().min(1).describe("Orderable bundle id from makro_search, e.g. BTY-X38571400320021"),
    quantity: z.number().int().min(1).default(1),
    comment: z.string().optional().describe("Optional note attached to the item"),
  }),
  async execute({ bundleId, quantity, comment }, ctx) {
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const cart = await makro.addItem(bundleId, quantity, comment ?? "");
    return { ok: true, total: cart.estimatedTotal, currency: cart.currency, itemCount: cart.items.length };
  },
});
