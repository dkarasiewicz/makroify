/**
 * Tenant resolution — the seam between today's single-account .env setup and the
 * multi-tenant Supabase SaaS (see the GitHub issue). One tenant now; later each
 * channel user maps to their own Makro account and session, resolved here.
 */
import { MakroClient, FileSessionStore, type SessionStore } from "../../src/core/index";

/** Identity of the inbound request, from the channel/session context. */
export interface TenantRequest {
  userKey?: string;
  channel?: string;
}

/** Resolves a {@link MakroClient} (account + session) for a given request. */
export interface TenantResolver {
  resolve(req: TenantRequest): Promise<MakroClient>;
}

/** Single-account resolver driven by `.env`. The client is cached per process. */
export class EnvTenantResolver implements TenantResolver {
  private client: MakroClient | null = null;

  async resolve(_req: TenantRequest): Promise<MakroClient> {
    if (this.client) return this.client;

    const cookieHeader = process.env.MAKRO_COOKIE;
    if (!cookieHeader) {
      throw new Error(
        "MAKRO_COOKIE must be set — paste the Cookie header from a logged-in idam.makro.pl session.",
      );
    }

    // On Vercel the only writable path is /tmp; warm instances reuse the session.
    const store: SessionStore = new FileSessionStore({
      dir: process.env.MAKROIFY_HOME ?? "/tmp/.makroify",
    });

    this.client = new MakroClient({
      cookieHeader,
      store,
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

/** Pick the resolver based on configuration. Today: always the env resolver. */
export function getResolver(): TenantResolver {
  if (!cached) cached = new EnvTenantResolver();
  return cached;
}
