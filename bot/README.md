# Makroify Discord gateway bot

Lets a team **chat naturally** in a Discord channel ("potrzebujemy cukier 1 kg")
and have the Makroify Eve agent answer, ask follow-ups, manage the cart, and
react ✅ when it adds/updates/removes something. Also answers `@Makroify`
mentions anywhere.

## Why a separate process?

Eve's Discord channel only receives *interactions* (slash commands). Normal
channel messages arrive only over Discord's **Gateway** (WebSocket) with the
**Message Content** intent. So this bot connects to the Gateway and bridges
messages to the **same** Eve agent over its HTTP API (`POST /eve/v1/session`).
It holds no business logic — Eve stays the brain. No public URL/tunnel needed
(the socket is outbound).

```
Discord Gateway ──message──▶ bot ──HTTP──▶ Eve agent (tools) ──▶ Makro
      ▲                                                           │
      └──────────── reply + ✅ reaction ◀────────────────────────┘
```

## Run

Needs the Eve agent running (`npm run agent`) and these env vars (see
`../.env.example`):

```
DISCORD_BOT_TOKEN=...            # + enable the Message Content intent in the portal
DISCORD_WATCH_CHANNEL_ID=...     # channel(s) to watch (comma-separated)
EVE_BASE_URL=http://127.0.0.1:2000
```

Grant the bot **View Channel / Send Messages / Read Message History / Add
Reactions** in the watched channel, then:

```bash
npm run bot
```

## Daily reminder

At **20:00 Europe/Warsaw** (DST-safe) it posts a cart summary to
`DISCORD_REMINDER_CHANNEL_ID` (default: first watched channel) and asks whether
to order — including the delivery date (order before 21:00 → next day, never
Sunday).

## Multi-tenancy

Routing lives in [`tenants.ts`](./tenants.ts). Today it's one tenant from `.env`.
To serve multiple Makro accounts, map `guildId → tenant` (each with its own Eve
URL / Makro account) in `tenantForGuild()` / `listTenants()` — the message and
reminder paths already route through them, so nothing else changes.
