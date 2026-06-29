import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

export default defineTool({
  description:
    "List past Makro orders, newest first (date, status, total, item count, orderId). Use for 'what did we order last time?' or 'show recent orders'. To see the items of one order, pass its orderId to makro_order_details.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(30).optional().describe("How many orders to return (default 10)"),
  }),
  async execute({ limit }, ctx) {
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const list = await makro.getOrders({ rows: limit ?? 10 });
    return {
      totalOrders: list.total,
      orders: list.orders.map((o) => ({
        orderId: o.orderId,
        orderNumber: o.orderNumber,
        date: new Date(o.orderedAt).toISOString().slice(0, 10),
        status: o.status,
        total: o.total,
        currency: o.currency,
        itemCount: o.itemCount,
      })),
    };
  },
});
