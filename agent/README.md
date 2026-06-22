# Makroify agent (Eve)

An [Eve](https://eve.dev) agent that exposes the makroify operations as chat
tools, so you can manage your Makro cart from Discord (or Slack / web). It wraps
the `MakroClient` from `../src/core`.

```
agent/
  agent.ts          model selection (EVE_MODEL)
  instructions.md   assistant persona + guardrails
  tools/            one tool per operation (search, cart, add/update/remove)
  lib/
    tenant.ts       env-now / Supabase-later account resolution
    makro.ts        getMakroClient(ctx) used by every tool
```

## Adaptability (env now → SaaS later)

The `.env` decides **what runs** (`EVE_MODEL`, which channels are added) and
**which Makro account it affects** (`MAKRO_USER_ID` / `MAKRO_PASSWORD`). All
account resolution goes through `lib/tenant.ts`:

- **Now — `EnvTenantResolver`:** every chat maps to the single Makro account in
  `.env`. Good for running the bot for your own shop.
- **Later — `SupabaseTenantResolver`:** each Discord/Slack/WhatsApp user maps to
  their own account, credentials, and session. Tools don't change — only the
  resolver. Tracked in the SaaS GitHub issue.

## Setup

> Eve needs **Node 24+**. Install the Eve deps into this repo (per the Eve docs):

```bash
npm install eve@latest ai zod
npx eve init .            # registers the agent/ folder with Eve
```

Set one model credential and your Makro login in `.env` (see `../.env.example`):

```
EVE_MODEL=anthropic/claude-haiku-4.5
AI_GATEWAY_API_KEY=...      # or ANTHROPIC_API_KEY
MAKRO_USER_ID=you@example.com
MAKRO_PASSWORD=...
```

## Run locally

```bash
npm run dev          # or: npx eve dev
```

Try: *"search for oat milk"*, *"what's in my cart?"*, *"add 2 of the cheapest
strawberries"*.

## Add Discord

```bash
npx eve channels add discord
```

Follow the prompts to register the bot and set `DISCORD_BOT_TOKEN` (and the app
id / public key). Invite the bot to your server, then DM it or mention it.

## Deploy to Vercel

This repo is **deploy-ready**: `vercel.json` sets `buildCommand: "eve build"`
(Eve builds via Nitro, which auto-targets Vercel's Build Output API), and
`engines.node` pins Node 24 (Eve's requirement). No extra config needed.

**Steps**

1. Import the GitHub repo in Vercel (or run `vercel` / `vercel deploy` from the
   project root). Vercel reads `vercel.json` — no framework preset needed.
2. Set the environment variables below in the Vercel dashboard (Project →
   Settings → Environment Variables).
3. Deploy. Verify the running app with:
   ```bash
   npx eve dev https://your-app.vercel.app
   ```
4. Add Discord (`npx eve channels add discord`) and point Discord's interactions
   URL at the deployed app.

**Required env vars (Vercel)**

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` **or** `AI_GATEWAY_API_KEY` | model credential |
| `EVE_MODEL` | optional, defaults to `anthropic/claude-haiku-4.5` |
| `MAKRO_USER_ID`, `MAKRO_PASSWORD` | the Makro account the bot manages |
| `MAKRO_CHROMIUM_PATH` | optional Chromium override; **auto-wired** on Vercel |
| `DISCORD_BOT_TOKEN` (+ app id / public key) | Discord channel |

`@sparticuz/chromium` and `playwright-core` are already optional dependencies, so
they install on Vercel automatically. On Vercel the resolver detects the `VERCEL`
env and calls `@sparticuz/chromium` for the browser — **option A needs no code or
extra packages**, just the Makro + model env vars above.

### ⚠️ Login on serverless

Makro's login needs a real browser (Playwright) to pass Akamai — see the root
README. The **data/cart calls run fine on Vercel serverless**; only the login
needs a browser. Options:

**A. `@sparticuz/chromium` inside the Vercel function** (in-runtime login)

```bash
npm i playwright-core @sparticuz/chromium
```

Resolve the binary at startup and pass its path via `MAKRO_CHROMIUM_PATH`, or use
a custom resolver:

```ts
import chromium from "@sparticuz/chromium";
import { MakroClient } from "../src/core/index";

const makro = new MakroClient({
  credentials: { userId, password },
  store,                       // your SessionStore
  loginMethod: "browser",
  browser: {
    headless: true,
    executablePath: await chromium.executablePath(),
    extraArgs: chromium.args,  // Lambda-tuned flags
  },
});
```

The provider auto-falls back to `playwright-core` when `executablePath` is set, so
you don't bundle a browser. Configure the function with **high memory (≥1024 MB)**
and a longer `maxDuration` (the browser launch + login takes ~10–20 s).

> ⚠️ **Unverified risk:** login was validated from a residential IP. Akamai may be
> stricter from Vercel's datacenter IPs even with real Chromium — test before
> relying on it. If it gets blocked, use option B.

**B. Pre-seed sessions (recommended for SaaS)** — run the browser login on a
small always-on worker (or the user's machine) and share the session through a
common `SessionStore` (Supabase-backed in the SaaS design). The Vercel agent then
only makes data/cart calls. This sidesteps the datacenter-IP risk entirely.

For local `eve dev`, the bundled Playwright Chromium logs in automatically.
