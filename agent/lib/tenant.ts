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
      browser: {
        headless: process.env.MAKRO_HEADLESS !== "0",
        ...(await serverlessBrowser()),
      },
      overrides: {
        storeId: process.env.MAKRO_STORE_ID,
        fsdAddressId: process.env.MAKRO_FSD_ADDRESS_ID,
      },
      debug: process.env.MAKROIFY_DEBUG === "1",
    });
    return this.client;
  }
}

/**
 * On serverless (Vercel/Lambda) resolve a Chromium binary for the login browser.
 * Uses an explicit `MAKRO_CHROMIUM_PATH`, else auto-wires `@sparticuz/chromium`
 * when running on Vercel. Returns `{}` locally so the bundled Playwright is used.
 */
async function serverlessBrowser(): Promise<{ executablePath?: string; extraArgs?: string[] }> {
  if (process.env.MAKRO_CHROMIUM_PATH) {
    return { executablePath: process.env.MAKRO_CHROMIUM_PATH };
  }
  if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) return {};
  try {
    const chromium = (await import("@sparticuz/chromium" as string)).default;
    return { executablePath: await chromium.executablePath(), extraArgs: chromium.args };
  } catch {
    return {}; // not installed — fall back to whatever Playwright finds
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
