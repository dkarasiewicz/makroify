/**
 * Agent tool definitions for Makroify.
 *
 * These are intentionally framework-agnostic so they can be dropped into Eve
 * (https://eve.dev) or the Vercel AI SDK with a thin adapter. Each tool carries
 * a JSON Schema for its inputs and an `execute` handler bound to a MakroClient.
 *
 * Vercel AI SDK / Eve adapter (once you add the `ai` package):
 *
 *   import { tool, jsonSchema } from "ai";
 *   import { createMakroTools } from "makroify/eve";
 *   const client = MakroClient.fromEnv();
 *   const tools = Object.fromEntries(
 *     Object.entries(createMakroTools(client)).map(([name, t]) => [
 *       name,
 *       tool({ description: t.description, inputSchema: jsonSchema(t.parameters), execute: t.execute }),
 *     ]),
 *   );
 */
import { MakroClient } from "../core/index";

// `I = any` keeps each tool's execute handler conveniently typed to its own
// input shape; the actual inputs are validated at runtime against `parameters`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MakroTool<I = any, O = unknown> {
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
  execute: (input: I) => Promise<O>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/** Build the full Makroify tool set bound to a client instance. */
export function createMakroTools(client: MakroClient): Record<string, MakroTool> {
  return {
    makro_search: {
      description:
        "Search Makro products by free text. Returns orderable items with a bundleId, name, price and stock. " +
        "Use the returned bundleId with makro_add_to_cart.",
      parameters: obj(
        {
          query: { type: "string", description: "Search text, e.g. 'truskawki' or 'mleko'" },
          rows: { type: "number", description: "Max results (default 12)" },
        },
        ["query"],
      ),
      execute: (i: { query: string; rows?: number }) => client.searchProducts(i.query, { rows: i.rows }),
    },

    makro_get_product: {
      description: "Get full details for one product by its variant id (e.g. 'BTY-X3857140032').",
      parameters: obj({ variantId: { type: "string" } }, ["variantId"]),
      execute: (i: { variantId: string }) => client.getProduct(i.variantId),
    },

    makro_get_cart: {
      description: "Get the current shopping cart: items, quantities, line totals and the estimated total.",
      parameters: obj({}),
      execute: () => client.getCurrentCart(),
    },

    makro_list_carts: {
      description: "List the customer's saved and active carts.",
      parameters: obj({ status: { type: "string", enum: ["SAVED", "ACTIVE"] } }),
      execute: (i: { status?: "SAVED" | "ACTIVE" }) => client.listCarts(i.status),
    },

    makro_add_to_cart: {
      description:
        "Add a product to the current cart. Provide a bundleId (from makro_search) or set byVariant=true to pass a variant id.",
      parameters: obj(
        {
          id: { type: "string", description: "bundleId, or variantId when byVariant=true" },
          quantity: { type: "number", description: "Quantity to add (default 1)" },
          comment: { type: "string", description: "Optional note for the item" },
          byVariant: { type: "boolean", description: "Treat id as a variant id" },
        },
        ["id"],
      ),
      execute: (i: { id: string; quantity?: number; comment?: string; byVariant?: boolean }) =>
        i.byVariant
          ? client.addByVariant(i.id, i.quantity ?? 1, i.comment ?? "")
          : client.addItem(i.id, i.quantity ?? 1, i.comment ?? ""),
    },

    makro_update_quantity: {
      description: "Set the quantity of an item already in the cart (by bundleId).",
      parameters: obj({ bundleId: { type: "string" }, quantity: { type: "number" } }, ["bundleId", "quantity"]),
      execute: (i: { bundleId: string; quantity: number }) => client.updateItem(i.bundleId, i.quantity),
    },

    makro_remove_from_cart: {
      description: "Remove an item from the cart (by bundleId).",
      parameters: obj({ bundleId: { type: "string" } }, ["bundleId"]),
      execute: (i: { bundleId: string }) => client.removeItem(i.bundleId),
    },

    // NOTE: placing an order is intentionally NOT exposed yet — the checkout
    // endpoint is unknown until a "place order" HAR is captured. Add a
    // `makro_place_order` tool here once core.placeOrder is implemented.
  };
}
