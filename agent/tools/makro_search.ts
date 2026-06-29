import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

export default defineTool({
  description:
    "Search Makro products by free text (Polish). Fuzzy: retries with looser variants if the exact term finds nothing. Returns orderable items with a bundleId, name, gross price (PLN) and stock. For an 'add this product' request, prefer makro_find. Use the bundleId with makro_add_to_cart.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Search text, e.g. 'truskawki' or 'mleko owsiane'"),
    limit: z.number().int().min(1).max(40).optional().describe("Max results (default 12)"),
  }),
  async execute({ query, limit }, ctx) {
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const { query: used, products } = await makro.searchProductsFuzzy(query, { rows: limit ?? 12 });
    return {
      count: products.length,
      query: used,
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
