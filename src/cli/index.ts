#!/usr/bin/env node
import { Command } from "commander";
import { MakroClient } from "../core/index";
import type { Cart, Product } from "../core/index";

// Load .env if present (Node >= 20.6). Never fatal.
try {
  process.loadEnvFile?.();
} catch {
  /* no .env — rely on real env vars */
}

const program = new Command();

program
  .name("makroify")
  .description("CLI for Makro Dla Gastronomii (dlagastronomii.makro.pl) ordering")
  .option("--json", "output raw JSON instead of formatted text")
  .option("--debug", "verbose request logging to stderr");

function client(): MakroClient {
  const opts = program.opts();
  return MakroClient.fromEnv({ debug: Boolean(opts.debug) });
}

function isJson(): boolean {
  return Boolean(program.opts().json);
}

function out(human: () => void, data: unknown): void {
  if (isJson()) console.log(JSON.stringify(data, null, 2));
  else human();
}

const zl = (s: string | undefined, n: number) => (s ?? "").padEnd(n).slice(0, n);
const money = (n: number | null | undefined, cur = "PLN") =>
  n == null ? "—".padStart(9) : `${n.toFixed(2)} ${cur}`.padStart(9);

// --- commands --------------------------------------------------------------

program
  .command("login")
  .description("Mint a session from MAKRO_COOKIE (silent SSO) and persist it")
  .action(async () => {
    const ctx = await client().login();
    out(
      () =>
        console.log(
          `Logged in. customer=${ctx.customerId} cardholder=${ctx.cardholderNumber} ` +
            `store=${ctx.storeId} address=${ctx.fsdAddressId ?? "(none)"}`,
        ),
      ctx,
    );
  });

program
  .command("logout")
  .description("Clear the saved session")
  .action(async () => {
    await client().logout();
    out(() => console.log("Logged out."), { ok: true });
  });

program
  .command("status")
  .alias("whoami")
  .description("Show session status and customer context")
  .action(async () => {
    const c = client();
    if (!(await c.isLoggedIn())) {
      out(() => console.log("Not logged in."), { loggedIn: false });
      return;
    }
    const ctx = await c.context();
    out(() => console.log(`Logged in as customer ${ctx.customerId} (store ${ctx.storeId}).`), {
      loggedIn: true,
      ...ctx,
    });
  });

program
  .command("search <query>")
  .description("Search products (resolves names, prices, orderable ids)")
  .option("-n, --rows <n>", "number of results", "12")
  .action(async (query: string, o) => {
    const products = await client().searchProducts(query, { rows: Number(o.rows) });
    out(() => printProducts(products), products);
  });

program
  .command("recent")
  .alias("recently-bought")
  .description("Products you buy regularly (recently-bought list, cached 24h)")
  .option("-n, --rows <n>", "max items", "30")
  .option("--refresh", "ignore the cache and refetch")
  .action(async (o) => {
    const products = await client().getRecentlyBought({ limit: Number(o.rows), refresh: Boolean(o.refresh) });
    out(() => printProducts(products), products);
  });

program
  .command("find <query>")
  .description("Smart resolve: check cart, recently-bought, then fuzzy search")
  .action(async (query: string) => {
    const res = await client().findItem(query);
    out(
      () => {
        console.log(`Query "${res.query}" → source: ${res.source}`);
        if (res.inCart.length) {
          console.log("Already in cart:");
          for (const it of res.inCart) console.log(`  x${it.quantity}  ${it.name ?? it.bundleId}`);
        }
        if (res.best) {
          const b = res.best;
          console.log(`Best: ${b.name} — ${money(b.price, b.currency)}  (${b.bundleId})`);
        } else {
          console.log("No match found.");
        }
        if (res.alternatives.length) {
          console.log("Alternatives:");
          printProducts(res.alternatives);
        }
      },
      res,
    );
  });

program
  .command("orders")
  .description("List past orders (newest first)")
  .option("-n, --rows <n>", "number of orders", "10")
  .action(async (o) => {
    const list = await client().getOrders({ rows: Number(o.rows) });
    out(
      () => {
        console.log(`${list.total} order(s) total — showing ${list.orders.length}`);
        for (const ord of list.orders) {
          const date = new Date(ord.orderedAt).toISOString().slice(0, 10);
          console.log(
            `  ${zl(ord.orderId, 34)} ${date} ${zl(ord.status, 10)} ${money(ord.total, ord.currency)}  ${ord.itemCount} item(s)`,
          );
        }
      },
      list,
    );
  });

program
  .command("order-details <orderId>")
  .description("Show the line items of a past order")
  .action(async (orderId: string) => {
    const d = await client().getOrderDetails(orderId);
    out(
      () => {
        const date = new Date(d.orderedAt).toISOString().slice(0, 10);
        console.log(`Order ${d.orderNumber} (${date}) — ${d.status} — ${money(d.total, d.currency)}`);
        for (const it of d.items) {
          console.log(`  x${String(it.quantity).padEnd(4)} ${money(it.lineTotal, d.currency)}  ${it.name}`);
        }
      },
      d,
    );
  });

program
  .command("product <variantId>")
  .description("Show details for a single product (by variant id)")
  .action(async (variantId: string) => {
    const p = await client().getProduct(variantId);
    out(() => printProducts([p]), p);
  });

program
  .command("cart")
  .description("Show the current cart")
  .action(async () => {
    const cart = await client().getCurrentCart();
    out(() => printCart(cart), cart);
  });

program
  .command("carts")
  .description("List saved/active carts")
  .option("-s, --status <status>", "filter: SAVED | ACTIVE")
  .action(async (o) => {
    const carts = await client().listCarts(o.status);
    out(
      () => {
        if (!carts.length) return console.log("No carts.");
        for (const c of carts)
          console.log(`${zl(c.cartId, 38)} ${zl(c.status, 8)} items=${c.itemCount} ${c.cartName ?? ""}`);
      },
      carts,
    );
  });

program
  .command("add <id> [quantity]")
  .description("Add a product to the cart (bundle id by default)")
  .option("--variant", "treat <id> as a variant id (resolve to a bundle first)")
  .option("-c, --comment <text>", "item comment", "")
  .action(async (id: string, quantity = "1", o) => {
    const c = client();
    const qty = Number(quantity);
    const cart = o.variant ? await c.addByVariant(id, qty, o.comment) : await c.addItem(id, qty, o.comment);
    out(() => printCart(cart), cart);
  });

program
  .command("update <bundleId> <quantity>")
  .description("Set the quantity of a cart item")
  .action(async (bundleId: string, quantity: string) => {
    const cart = await client().updateItem(bundleId, Number(quantity));
    out(() => printCart(cart), cart);
  });

program
  .command("remove <bundleId>")
  .description("Remove an item from the cart")
  .action(async (bundleId: string) => {
    const cart = await client().removeItem(bundleId);
    out(() => printCart(cart), cart);
  });

program
  .command("order")
  .description("Place an order from the current cart (cash on delivery)")
  .option("--confirm", "actually submit the order (without this flag it only previews)")
  .option("--delivery-date <date>", "delivery date YYYY-MM-DD (default: tomorrow)")
  .action(async (o) => {
    const c = client();
    const cart = await c.getCurrentCart();
    if (!cart.items.length) {
      out(() => console.log("Cart is empty — nothing to order."), { error: "empty cart" });
      return;
    }
    if (!o.confirm) {
      // Safety: preview the cart and run a dry-run checkout instead of submitting.
      const preview = await c.placeOrder({ deliveryDate: o.deliveryDate, dryRun: true });
      out(() => {
        printCart(cart);
        console.log(`\nPayment: CASH on delivery. Delivery: ${o.deliveryDate ?? "tomorrow"}.`);
        console.log("This was a PREVIEW (dry run). Re-run with --confirm to actually place the order.");
      }, { preview: true, ...preview, cart });
      return;
    }
    const res = await c.placeOrder({ deliveryDate: o.deliveryDate });
    out(
      () => console.log(`Order ${res.status}. total=${money(res.total, res.currency)} submitId=${res.submitId ?? "—"}`),
      res,
    );
  });

// --- output helpers --------------------------------------------------------

function printProducts(products: Product[]): void {
  if (!products.length) return console.log("No products found.");
  console.log(`${zl("BUNDLE ID", 22)} ${zl("PRICE", 11)} ${zl("STOCK", 6)} NAME`);
  for (const p of products) {
    const price = p.price == null ? "—" : `${p.price.toFixed(2)} ${p.currency}`;
    const stock = p.availability === "AVAILABLE" ? String(p.stock ?? "✓") : "✗";
    console.log(`${zl(p.bundleId, 22)} ${zl(price, 11)} ${zl(stock, 6)} ${p.name}`);
  }
}

function printCart(cart: Cart): void {
  if (!cart.cartId) return console.log("No active cart.");
  console.log(`Cart ${cart.cartId}${cart.cartName ? ` (${cart.cartName})` : ""} — ${cart.items.length} item(s)`);
  for (const it of cart.items) {
    console.log(
      `  ${zl(it.bundleId, 22)} x${String(it.quantity).padEnd(4)} ${money(it.lineTotal, cart.currency)}  ${it.name ?? ""}`,
    );
  }
  if (cart.estimatedTotal != null) console.log(`  TOTAL: ${cart.estimatedTotal.toFixed(2)} ${cart.currency}`);
}

// --- run -------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (program.opts().json) console.log(JSON.stringify({ error: msg }, null, 2));
  else console.error(`Error: ${msg}`);
  process.exit(1);
});
