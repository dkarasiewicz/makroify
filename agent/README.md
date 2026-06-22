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
EVE_MODEL=anthropic/claude-opus-4.8
ANTHROPIC_API_KEY=...      # or AI_GATEWAY_API_KEY
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

The agent is a normal Vercel app. Push to a repo connected to Vercel (or
`vercel deploy`), set the env vars in the Vercel dashboard, and point Discord's
interactions URL at the deployed app. Verify with:

```bash
npx eve dev https://your-app.vercel.app
```

### ⚠️ Login on serverless

Makro's login requires a real browser (Playwright) to pass Akamai — see the root
README. **Standard Vercel serverless functions can't launch a full browser**, so
plan for one of these:

1. **Pre-seed sessions** — run `makroify login` somewhere with a browser (your
   machine, or the SaaS "login worker") and share the session via a common
   `SessionStore` (a Supabase-backed store in the SaaS design). The Vercel agent
   then only does data/cart calls, which work fine on serverless.
2. **Remote browser** — point the browser login at a hosted Chromium
   (Browserless / `@sparticuz/chromium` on a fat function) for in-runtime login.

For local `eve dev`, the bundled Playwright Chromium logs in automatically.
