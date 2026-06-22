# makroify

TypeScript client + CLI for ordering at **Makro Dla Gastronomii**
(`dlagastronomii.makro.pl`). Built for a small coffee shop to script its Makro
inventory: log in, search products, read the cart, and add/update/remove items.
Designed to be reused later by an [Eve](https://eve.dev) agent connected to
Discord — the core is framework-agnostic and the session storage is pluggable.

> **Status:** login, search, cart read, and cart management are implemented and
> tested live. **Placing an order is a stub** (`src/core/order.ts`) — it will be
> wired up once a checkout HAR is captured.

## How auth works (important)

Makro's login page is protected by **Akamai Bot Manager**. Only the single
credential-submission step (`idam.makro.pl/web/authc/authenticate`) is gated —
it returns `403` to any non-browser client. Everything else (token exchange,
search, cart, checkout) works with a plain HTTP client.

So login runs the credential step in a **real headless Chromium** (via
Playwright), harvests the resulting session cookies + ordercapture JWT, and hands
them to the lightweight client, which makes all subsequent API calls directly.
The session lasts ~1 hour; the client re-logs-in automatically when it expires
(if credentials are available).

## Install

```bash
npm install
npx playwright install chromium   # one-time browser download (login only)
npm run build
```

## Configure

Copy `.env.example` to `.env` and set your Makro credentials:

```
MAKRO_USER_ID=you@example.com
MAKRO_PASSWORD=your-password
```

`storeId` and the delivery address are auto-discovered from your account; override
via `MAKRO_STORE_ID` / `MAKRO_FSD_ADDRESS_ID` if needed.

## CLI

```bash
makroify login                 # browser login, persists session to ~/.makroify
makroify login --headed        # show the window (debug / solve a captcha)
makroify status                # session + customer context
makroify search truskawki      # search products -> bundle ids, prices, stock
makroify search "mleko owsiane" -n 20
makroify product BTY-X3857140032   # details by variant id
makroify cart                  # current cart with line totals
makroify carts                 # list saved/active carts
makroify add BTY-X38571400320021 2     # add 2 of a bundle id
makroify add BTY-X3857140032 1 --variant   # add by variant id (auto-resolves)
makroify update BTY-X38571400320021 5  # set quantity to 5
makroify remove BTY-X38571400320021    # remove item
makroify order                 # (not implemented yet)
```

Add `--json` to any command for machine-readable output (handy for agents), and
`--debug` for verbose request logging.

## Library

```ts
import { MakroClient } from "makroify";

const makro = MakroClient.fromEnv();          // reads MAKRO_USER_ID / MAKRO_PASSWORD
await makro.login();                          // browser login, persists session

const hits = await makro.searchProducts("truskawki", { rows: 10 });
const cart = await makro.getCurrentCart();
await makro.addItem(hits[0].bundleId, 2);
await makro.updateItem(hits[0].bundleId, 5);
await makro.removeItem(hits[0].bundleId);
```

### Pluggable session storage (for a SaaS/agent deployment)

The CLI persists the session to `~/.makroify` via `FileSessionStore`. Implement
the `SessionStore` interface to store sessions in Redis/Postgres/etc. instead:

```ts
import { MakroClient, type SessionStore, type Session } from "makroify";

class RedisSessionStore implements SessionStore {
  async load(): Promise<Session | null> { /* ... */ }
  async save(session: Session): Promise<void> { /* ... */ }
  async clear(): Promise<void> { /* ... */ }
}

const makro = new MakroClient({ store: new RedisSessionStore(), credentials: { userId, password } });
```

## Agent tools (Eve / Vercel AI SDK)

`src/eve/tools.ts` exposes the operations as framework-agnostic tool descriptors
(`createMakroTools(client)`) with JSON Schemas, ready to adapt to Eve or the
Vercel AI SDK. See the file header for the adapter snippet.

## Architecture

```
src/core/
  client.ts        MakroClient — orchestration, session lifecycle, auto re-login
  auth.ts          OAuth/PKCE chain + SessionProvider abstraction
  browser-login.ts Playwright session provider (Akamai-gated login)
  http.ts          cookie-aware fetch wrapper
  cookies.ts       tough-cookie jar
  session.ts       Session types + SessionStore (File / Memory)
  products.ts      search + variant→bundle resolution
  cart.ts          cart read + add/update/remove
  order.ts         placeOrder (stub)
  jwt.ts           ordercapture JWT context parsing
src/cli/index.ts   commander CLI
src/eve/tools.ts   agent tool descriptors
skills/makroify/   Claude Code skill
```

### Data model notes

- Search returns **variant ids** (`BTY-X3857140032`) + price. Resolve via
  `betty-variants` to an orderable **bundle id** (`BTY-X38571400320021` = variant
  + 4-digit packaging suffix). The cart is keyed by bundle id.
- `customerId` / `cardholderNumber` come from the ordercapture JWT;
  `storeId` / `fsdAddressId` are discovered from the carts list.

## Security

Credentials and the captured HAR contain live secrets — both are gitignored
(`.env`, `*.har`, `.makroify/`). The session file is written `0600`.
