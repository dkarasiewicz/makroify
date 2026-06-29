import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

export default defineTool({
  description:
    "List the products the shop buys regularly (the Makro 'recently bought' list, cached 24h). Use it for 'what do we usually order?', for restocking suggestions, or to ground a vague request. Returns orderable bundleIds with names, gross prices and stock.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(60).optional().describe("Max items (default 30)"),
  }),
  async execute({ limit }, ctx) {
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const products = await makro.getRecentlyBought({ limit: limit ?? 30 });
    return {
      count: products.length,
      products: products.map((p) => ({
        bundleId: p.bundleId,
        name: p.name,
        price: p.price,
        currency: p.currency,
        stock: p.stock,
        availability: p.availability,
      })),
    };
  },
});
