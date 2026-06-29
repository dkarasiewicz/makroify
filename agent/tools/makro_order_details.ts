import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

export default defineTool({
  description:
    "Show the line items of one past order (name, quantity, line total, and whether an item was replaced). Pass an orderId from makro_orders. Each item also carries a bundleId you can reuse with makro_add_to_cart to re-order.",
  inputSchema: z.object({
    orderId: z.string().min(1).describe("orderId from makro_orders, e.g. combi-4c0onhtdhcg44qabt1cq5eulq"),
  }),
  async execute({ orderId }, ctx) {
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const d = await makro.getOrderDetails(orderId);
    return {
      orderNumber: d.orderNumber,
      date: new Date(d.orderedAt).toISOString().slice(0, 10),
      status: d.status,
      total: d.total,
      currency: d.currency,
      itemCount: d.itemCount,
      items: d.items.map((it) => ({
        bundleId: it.bundleId,
        name: it.name,
        quantity: it.quantity,
        lineTotal: it.lineTotal,
        replaced: it.replaced,
      })),
    };
  },
});
