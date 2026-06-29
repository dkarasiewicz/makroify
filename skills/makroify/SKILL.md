---
name: makroify
description: Manage a Makro Dla Gastronomii (dlagastronomii.makro.pl) food-ordering account — log in, search products, read the cart, and add/update/remove cart items. Use when the user wants to check Makro prices/stock, see or modify their Makro cart, or order supplies for their coffee shop / restaurant.
---

# Makroify — Makro Dla Gastronomii ordering

Drive a Makro Dla Gastronomii account through the `makroify` CLI. Use it whenever
the user asks to check Makro prices/availability, view their cart, or add/remove/
change items.

## Setup (once)

The CLI lives in this project. Build it if `dist/` is missing:

```bash
npm install && npm run build
```

Auth comes from `MAKRO_COOKIE` in `.env` (or the environment) — the `Cookie`
header from a logged-in idam.makro.pl browser session. Run commands with
`node dist/cli/index.js <cmd>` (or `npm run cli -- <cmd>` during dev). Prefer
`--json` so you can parse the output.

## Auth model

No password, no browser: the pasted IDAM cookies drive a silent OAuth flow
(`prompt=none`) that mints a fresh JWT on demand. The session is cached in
`~/.makroify` and refreshed automatically. If you get a "cookies expired" error,
refresh `MAKRO_COOKIE` from a logged-in browser.

## Commands

```bash
node dist/cli/index.js login              # establish/refresh the session
node dist/cli/index.js status --json      # check who's logged in
node dist/cli/index.js search "<query>" --json -n 15   # fuzzy full-text search
node dist/cli/index.js find "<query>" --json      # smart resolve: cart → recent → search
node dist/cli/index.js recent --json -n 30        # products bought regularly (cached 24h)
node dist/cli/index.js orders --json -n 10        # past orders (date, total, status)
node dist/cli/index.js order-details <orderId> --json   # line items of one order
node dist/cli/index.js cart --json        # current cart + totals
node dist/cli/index.js add <bundleId> <qty>       # add by bundle id
node dist/cli/index.js add <variantId> <qty> --variant
node dist/cli/index.js update <bundleId> <qty>    # set quantity
node dist/cli/index.js remove <bundleId>
node dist/cli/index.js order              # PREVIEW the order (dry run, cash on delivery)
node dist/cli/index.js order --confirm    # actually place the order (irreversible)
```

## Resolving a loose request ("truskawki")

Prefer `find` over a raw `search` when the user names a product to add. It checks,
in order: the **current cart** (maybe just bump the quantity), the
**recently-bought** list (what they actually buy → add 1, ask if more), then a
**fuzzy search** (best match, then 2-3 alternatives). `find --json` returns
`source`, `inCart`, `usuallyBuy`, `best`, and `alternatives`.

## Key ID rule

`search` returns products with a **`bundleId`** (e.g. `BTY-X38571400320021`).
**Always use that `bundleId`** with `add`/`update`/`remove`. The shorter
`variantId` (`BTY-X3857140032`) only works with `add ... --variant`.

## Typical flow

1. `search "<thing>" --json` → pick the product the user means (show name, price,
   stock; confirm if ambiguous).
2. `add <bundleId> <qty>` → then `cart --json` to confirm the new state and total.
3. Report the cart total back to the user.

## Guardrails

- **Confirm before mutating the cart** (add/update/remove) unless the user was
  explicit about the exact item and quantity.
- **Placing an order is irreversible and cash-on-delivery.** `order` without
  `--confirm` only previews (dry run). Only run `order --confirm` after the user
  explicitly confirms. Never claim an order was placed unless the result says so.
- Prices are gross PLN; stock shows available-to-promise quantity.
