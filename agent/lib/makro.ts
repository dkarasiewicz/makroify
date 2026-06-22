/**
 * Helper used by every tool to get a ready MakroClient for the current request.
 * Tools stay platform-agnostic: they don't know whether they're serving a single
 * .env account or a SaaS tenant — that's the resolver's job.
 */
import { getResolver, type TenantRequest } from "./tenant";

/**
 * Derive the tenant identity from an Eve tool `ctx` (best-effort).
 *
 * Today the resolver ignores this (single .env account). For the SaaS build it
 * becomes the lookup key — mapped from the authenticated channel user. The Eve
 * session exposes `id` and `auth`; we pass the session id through for now.
 */
export function tenantFromCtx(ctx?: { session?: { id?: string; auth?: unknown } }): TenantRequest {
  return { userKey: ctx?.session?.id };
}

/** Resolve the MakroClient for a request (logs in lazily, reuses the session). */
export function getMakroClient(req: TenantRequest = {}) {
  return getResolver().resolve(req);
}
