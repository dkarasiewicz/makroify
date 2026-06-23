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

Makro's login is protected by **Akamai Bot Manager** — the credential step
returns `403` to any non-browser client, so we don't submit a password at all.

Instead you log in once in a real browser and **paste its cookies**. The
long-lived IDAM session cookie (`metroIdentity`) lets us run the SPA's *silent*
OAuth flow (`prompt=none`): mint a fresh authorization code → access token →
ordercapture JWT, with no password, no browser, and no Akamai-gated step. We set
the resulting JWT as the `compressedJWT` / `idamUserIdToken` cookies (exactly as
the web app does) and call the data API directly.

The minted JWT lasts ~1h and is refreshed automatically; the pasted IDAM session
lasts weeks, so you only re-paste cookies occasionally.

## Install

```bash
npm install
npm run build
```

No browser download — auth is pure HTTP.

## Configure

Copy `.env.example` to `.env` and paste your Makro cookies:

```
MAKRO_COOKIE=allowedCookieCategories=necessary; metroIdentity=...; ...
```

To get the value: log in at `dlagastronomii.makro.pl`, open DevTools → Network →
click any request to `idam.makro.pl` → copy the full `Cookie:` request header.

`storeId` and the delivery address are auto-discovered from your account; override
via `MAKRO_STORE_ID` / `MAKRO_FSD_ADDRESS_ID` if needed.

## CLI

```bash
makroify login                 # mint a session from MAKRO_COOKIE, persist to ~/.makroify
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

const makro = MakroClient.fromEnv();          // reads MAKRO_COOKIE
await makro.login();                          // silent SSO, persists session

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

const makro = new MakroClient({ store: new RedisSessionStore(), cookieHeader });
```

## Chat agent (Eve → Discord/Slack/web)

`agent/` is an [Eve](https://eve.dev) agent that exposes these operations as chat
tools, ready to deploy to Vercel and connect to Discord. See `agent/README.md`.

## Architecture

```
src/core/
  client.ts        MakroClient — orchestration, session lifecycle, auto re-login
  auth.ts          silent-SSO cookie login (PKCE) + SessionProvider abstraction
  config.ts        hosts, OAuth client/realm/scope, endpoint builders
  http.ts          cookie-aware fetch wrapper
  cookies.ts       tough-cookie jar
  session.ts       Session types + SessionStore (File / Memory)
  products.ts      search + variant→bundle resolution
  cart.ts          cart read + add/update/remove
  order.ts         placeOrder (stub)
  jwt.ts           ordercapture JWT context parsing
src/cli/index.ts   commander CLI
agent/             Eve chat agent (tools wrap MakroClient)
skills/makroify/   Claude Code skill
```

### Data model notes

- Search returns **variant ids** (`BTY-X3857140032`) + price. Resolve via
  `betty-variants` to an orderable **bundle id** (`BTY-X38571400320021` = variant
  + 4-digit packaging suffix). The cart is keyed by bundle id.
- `customerId` / `cardholderNumber` come from the ordercapture JWT;
  `storeId` / `fsdAddressId` are discovered from the carts list.

## Security

The pasted cookies and any captured HAR contain live secrets — both are
gitignored (`.env`, `*.har`, `.makroify/`). The session file is written `0600`.
```
