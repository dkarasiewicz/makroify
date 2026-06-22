/**
 * Tenant resolution for the Discord gateway bot.
 *
 * A "tenant" = one Makro account served by one Eve agent, reachable on a base
 * URL, surfaced in one or more Discord channels. Today there's a single tenant
 * from .env. To go multi-tenant, replace `loadTenants()` / `tenantForGuild()`
 * with a lookup (DB/Supabase: guild → tenant → Makro account + Eve URL) — the
 * bot's message/reminder code already routes through these functions, so no
 * other change is needed.
 */
export interface Tenant {
  /** Stable id used to namespace conversations and (later) the Makro account. */
  id: string;
  /** Where this tenant's Eve agent HTTP API lives. */
  eveBaseUrl: string;
  /** Channels where the bot answers every message. */
  watchChannelIds: string[];
  /** Channel for the daily cart-review reminder (defaults to the first watched). */
  reminderChannelId?: string;
}

function tenantFromEnv(): Tenant {
  const watch = (process.env.DISCORD_WATCH_CHANNEL_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id: process.env.MAKRO_TENANT_ID ?? "default",
    eveBaseUrl: process.env.EVE_BASE_URL ?? "http://127.0.0.1:2000",
    watchChannelIds: watch,
    reminderChannelId: process.env.DISCORD_REMINDER_CHANNEL_ID ?? watch[0],
  };
}

let cache: Tenant[] | null = null;

/** All configured tenants. Single-tenant from env today. */
export function listTenants(): Tenant[] {
  return (cache ??= [tenantFromEnv()]);
}

/** Tenant that owns a watched channel, if any. */
export function tenantForChannel(channelId: string): Tenant | undefined {
  return listTenants().find((t) => t.watchChannelIds.includes(channelId));
}

/**
 * Tenant to use for an @mention outside a watched channel. Single-tenant: the
 * one tenant. Multi-tenant: map `guildId` → tenant here.
 */
export function tenantForGuild(_guildId: string | null): Tenant | undefined {
  return listTenants()[0];
}
