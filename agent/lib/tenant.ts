/**
 * Tenant resolution — the seam between the single-account .env setup we run now
 * and the multi-tenant Supabase SaaS described in the GitHub issue.
 *
 * A "tenant" is whoever the bot is acting for. Today there is exactly one,
 * configured via .env. Tomorrow each Discord/Slack/WhatsApp user maps to their
 * own Makro account, credentials, and session — resolved here without touching
 * any tool code.
 */
import {
  MakroClient,
  FileSessionStore,
  type SessionStore,
  type Credentials,
} from "../../src/core/index";

/** Identity of the inbound request (filled from the channel/session context). */
export interface TenantRequest {
  /** Stable per-user id from the channel (e.g. Discord user id). */
  userKey?: string;
  /** Channel name: "discord" | "slack" | "http" | ... */
  channel?: string;
}

/** Resolves a {@link MakroClient} (account + session) for a given request. */
export interface TenantResolver {
  resolve(req: TenantRequest): Promise<MakroClient>;
}

/**
 * Single-account resolver driven by environment variables. Every request maps
 * to the one Makro account in `.env`. The client (and its session) is cached
 * for the process, with automatic re-login on expiry.
 */
export class EnvTenantResolver implements TenantResolver {
  private client: MakroClient | null = null;

  async resolve(_req: TenantRequest): Promise<MakroClient> {
    if (this.client) return this.client;

    const userId = process.env.MAKRO_USER_ID;
    const password = process.env.MAKRO_PASSWORD;
    if (!userId || !password) {
      throw new Error("MAKRO_USER_ID and MAKRO_PASSWORD must be set in the environment.");
    }
    const credentials: Credentials = { userId, password };

    // On Vercel the only writable path is /tmp; warm instances reuse the session.
    const store: SessionStore = new FileSessionStore({
      dir: process.env.MAKROIFY_HOME ?? "/tmp/.makroify",
    });

    this.client = new MakroClient({
      credentials,
      store,
      loginMethod: process.env.MAKRO_LOGIN_METHOD === "direct" ? "direct" : "browser",
      browser: { headless: process.env.MAKRO_HEADLESS !== "0" },
      overrides: {
        storeId: process.env.MAKRO_STORE_ID,
        fsdAddressId: process.env.MAKRO_FSD_ADDRESS_ID,
      },
      debug: process.env.MAKROIFY_DEBUG === "1",
    });
    return this.client;
  }
}

let cached: TenantResolver | null = null;

/**
 * Pick the resolver based on configuration. Today: always the env resolver.
 * Later: `if (process.env.SUPABASE_URL) return new SupabaseTenantResolver()`.
 */
export function getResolver(): TenantResolver {
  if (!cached) cached = new EnvTenantResolver();
  return cached;
}
