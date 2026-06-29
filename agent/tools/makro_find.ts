import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

const product = (p: {
  bundleId: string;
  name: string;
  price: number | null;
  currency: string;
  stock?: number | null;
  availability: string;
}) => ({
  bundleId: p.bundleId,
  name: p.name,
  price: p.price,
  currency: p.currency,
  stock: p.stock,
  availability: p.availability,
});

export default defineTool({
  description:
    "Resolve what the user wants to add (e.g. 'truskawki') the smart way: checks the current cart, then the recently-bought list, then a fuzzy search. Use this FIRST when someone names a product to add. Returns: items already in the cart, matches from what they usually buy, the single best pick to add, and 2-3 alternatives. Read-only — add the chosen item with makro_add_to_cart afterwards.",
  inputSchema: z.object({
    query: z.string().min(1).describe("What the user asked for, in Polish, e.g. 'truskawki' or 'mleko owsiane'"),
  }),
  async execute({ query }, ctx) {
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const r = await makro.findItem(query);
    return {
      query: r.query,
      source: r.source,
      inCart: r.inCart.map((it) => ({ bundleId: it.bundleId, name: it.name, quantity: it.quantity })),
      usuallyBuy: r.recentlyBought.map(product),
      best: r.best ? product(r.best) : null,
      alternatives: r.alternatives.map(product),
    };
  },
});
