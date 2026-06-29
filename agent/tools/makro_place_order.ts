import { defineTool } from "eve/tools";
import { z } from "zod";
import { getMakroClient, tenantFromCtx } from "../lib/makro";

export default defineTool({
  description:
    "Place the order from the current Makro cart (payment: CASH on delivery). IRREVERSIBLE — this submits a real order. ONLY call it after the user has explicitly confirmed in this conversation (e.g. said 'tak'/'składaj'/'potwierdzam') to a summary you showed them (items, total, delivery date). Set confirmed=true only in that case. To preview without ordering, pass dryRun=true.",
  inputSchema: z.object({
    confirmed: z
      .boolean()
      .describe("True ONLY if the user just explicitly confirmed placing the order. If they haven't, set false."),
    dryRun: z
      .boolean()
      .optional()
      .describe("Run checkout + force cash payment but stop before submitting (no order placed). For previews."),
    deliveryDate: z.string().optional().describe("Delivery date YYYY-MM-DD; defaults to tomorrow."),
  }),
  async execute({ confirmed, dryRun, deliveryDate }, ctx) {
    if (!confirmed && !dryRun) {
      return {
        placed: false,
        needsConfirmation: true,
        message:
          "Nie składam zamówienia bez wyraźnego potwierdzenia. Pokaż koszyk i sumę, zapytaj 'na pewno składać?' i wywołaj ponownie z confirmed=true dopiero po 'tak'.",
      };
    }
    const makro = await getMakroClient(tenantFromCtx(ctx));
    const res = await makro.placeOrder({ dryRun, deliveryDate });
    return {
      placed: res.status === "SUBMITTED",
      status: res.status,
      submitId: res.submitId,
      total: res.total,
      currency: res.currency,
      payment: "CASH on delivery",
    };
  },
});
