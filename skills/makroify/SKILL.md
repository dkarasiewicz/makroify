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
npm install && npx playwright install chromium && npm run build
```

Credentials come from `.env` (`MAKRO_USER_ID`, `MAKRO_PASSWORD`) or the
environment. Run commands with `node dist/cli/index.js <cmd>` (or `npm run cli -- <cmd>`
during dev). Prefer `--json` so you can parse the output.

## Auth model

Login uses a real headless browser (Playwright) to pass Akamai bot protection,
then caches a session in `~/.makroify` for ~1 hour. After that it re-logs-in
automatically. If you get a "Not authenticated" error, run `login` first.

## Commands

```bash
node dist/cli/index.js login              # establish/refresh the session
node dist/cli/index.js status --json      # check who's logged in
node dist/cli/index.js search "<query>" --json -n 15
node dist/cli/index.js cart --json        # current cart + totals
node dist/cli/index.js add <bundleId> <qty>       # add by bundle id
node dist/cli/index.js add <variantId> <qty> --variant
node dist/cli/index.js update <bundleId> <qty>    # set quantity
node dist/cli/index.js remove <bundleId>
```

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
- **Placing an order is not implemented** — `order` will error. Do not claim an
  order was placed.
- Prices are gross PLN; stock shows available-to-promise quantity.
