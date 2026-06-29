# Makroify agent (Eve)

An [Eve](https://eve.dev) agent that exposes the makroify operations as chat
tools, so you can manage your Makro cart from Discord (or Slack / web). It wraps
the `MakroClient` from `../src/core`.

```
agent/
  agent.ts          model selection (EVE_MODEL)
  instructions.md   assistant persona (Polish, sassy) + the smart add flow
  tools/            search, find, recently-bought, cart, add/update/remove, orders, place-order
  lib/
    tenant.ts       env-now / Supabase-later account resolution
    makro.ts        getMakroClient(ctx) used by every tool
```

## Adaptability (env now → SaaS later)

The `.env` decides **what runs** (`EVE_MODEL`, which channels are added) and
**which Makro account it affects** (`MAKRO_COOKIE`). All account resolution goes
through `lib/tenant.ts`:

- **Now — `EnvTenantResolver`:** every chat maps to the single Makro account in
  `.env`. Good for running the bot for your own shop.
- **Later — `SupabaseTenantResolver`:** each Discord/Slack/WhatsApp user maps to
  their own account cookies and session. Tools don't change — only the resolver.
  Tracked in the SaaS GitHub issue.

## Setup

> Eve needs **Node 24+**. Install the Eve deps into this repo (per the Eve docs):

```bash
npm install eve@latest ai zod
npx eve init .            # registers the agent/ folder with Eve
```

Set one model credential and your Makro cookies in `.env` (see `../.env.example`):

```
EVE_MODEL=anthropic/claude-haiku-4.5
AI_GATEWAY_API_KEY=...      # or ANTHROPIC_API_KEY
MAKRO_COOKIE=allowedCookieCategories=necessary; metroIdentity=...; ...
```

## Run locally

```bash
npm run dev          # or: npx eve dev
```

Try (it answers in Polish, with attitude): *"dodaj truskawki"*, *"co jest w
koszyku?"*, *"co zwykle zamawiamy?"*, *"pokaż ostatnie zamówienia"*.

## Discord

Discord is served by the **gateway bot** in [`../bot`](../bot), not an Eve
channel — so the team can chat *normally* in a channel (no slash command) and the
bot reads messages, replies, and reacts ✅ when it changes the cart. It needs no
public URL/tunnel (outbound WebSocket). See `../bot/README.md`. Run it alongside
the agent with `npm run bot`.

## Deploy to Vercel

This repo is **deploy-ready**: `vercel.json` sets `buildCommand: "eve build"`
(Eve builds via Nitro, which auto-targets Vercel's Build Output API), and
`engines.node` pins Node 24 (Eve's requirement). Auth is pure HTTP (silent SSO
from the pasted cookies), so it runs on Vercel serverless with no browser — no
extra packages, no special function config.

**Steps**

1. Import the GitHub repo in Vercel (or run `vercel` / `vercel deploy` from the
   project root). Vercel reads `vercel.json` — no framework preset needed.
2. Set the environment variables below in the Vercel dashboard (Project →
   Settings → Environment Variables).
3. Deploy. Verify the running app with:
   ```bash
   npx eve dev https://your-app.vercel.app
   ```

> Note: the Discord **gateway bot** needs a persistent WebSocket, so it can't run
> on Vercel serverless — run it on a small always-on host (it just needs
> `DISCORD_BOT_TOKEN` and `EVE_BASE_URL` pointing at the deployed agent).

**Required env vars (Vercel — the agent)**

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` **or** `AI_GATEWAY_API_KEY` | model credential |
| `EVE_MODEL` | optional, defaults to `anthropic/claude-haiku-4.5` |
| `MAKRO_COOKIE` | logged-in idam.makro.pl Cookie header (the account the bot manages) |
| `MAKROIFY_HOME` | optional session dir; use `/tmp/.makroify` on Vercel |

> The pasted IDAM session lasts weeks; when it expires the silent SSO starts
> returning "cookies expired" — refresh `MAKRO_COOKIE` from a logged-in browser.
> For the multi-tenant SaaS, each user's cookies live in Supabase (see the issue).
