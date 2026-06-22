import { Http, type Logger } from "./http";
import { MakroCookieJar } from "./cookies";
import { login as runLogin, directSessionProvider, type SessionProvider, type Credentials } from "./auth";
import { browserSessionProvider, type BrowserLoginOptions } from "./browser-login";
import { parseJwtContext } from "./jwt";
import { DEFAULTS } from "./config";
import {
  FileSessionStore,
  type Session,
  type SessionContext,
  type SessionStore,
} from "./session";
import { HttpError, NotAuthenticatedError } from "./errors";
import type { RequestContext } from "./context";
import {
  search as runSearch,
  resolveVariants,
  getProductByVariant,
  type SearchOptions,
} from "./products";
import * as cartApi from "./cart";
import { placeOrder as runPlaceOrder, type OrderResult, type PlaceOrderParams } from "./order";
import type { Cart, CartSummary, Product, SearchResults } from "./types";

export interface ContextOverrides {
  country?: string;
  locale?: string;
  storeId?: string;
  fsdAddressId?: string;
}

export interface MakroClientOptions {
  store?: SessionStore;
  credentials?: Credentials;
  overrides?: ContextOverrides;
  /** How to get past the Akamai-gated credential step. Default "browser". */
  loginMethod?: "browser" | "direct";
  /** Options for the browser login (headless, timeout, channel). */
  browser?: BrowserLoginOptions;
  /** Provide a fully custom session provider (overrides loginMethod). */
  sessionProvider?: SessionProvider;
  /**
   * Cross-context login lock. Acquire returns a release fn. Use this when
   * multiple isolated processes/contexts share a {@link SessionStore} (e.g. Eve
   * tool calls) so they don't all launch a browser login at once — Akamai
   * rate-limits concurrent logins. See `fileLoginLock` in the agent.
   */
  loginLock?: LoginLock;
  /**
   * How long to reuse a stored session before forcing a fresh login, ms. The
   * real auth (cookies) outlives the 1h JWT, so we reuse the session for a long
   * window and re-login lazily only when a request actually fails auth.
   * Default 12h.
   */
  sessionMaxAgeMs?: number;
  /** Enable verbose request logging. */
  debug?: boolean;
  logger?: Logger;
}

/** Acquire a cross-context login lock; resolves to a release function. */
export type LoginLock = () => Promise<() => Promise<void>>;

/**
 * High-level entry point. Holds a session (cookies + JWT + customer context),
 * persists it via a pluggable {@link SessionStore}, and exposes search/cart ops.
 */
export class MakroClient {
  private store: SessionStore;
  private credentials?: Credentials;
  private overrides: ContextOverrides;
  private log: Logger;
  private sessionProvider: SessionProvider;
  private session: Session | null = null;
  private http: Http | null = null;
  private loginLock?: LoginLock;
  private sessionMaxAgeMs: number;
  /** Dedupes concurrent logins within one context into one. */
  private loginInFlight: Promise<SessionContext> | null = null;

  constructor(opts: MakroClientOptions = {}) {
    this.store = opts.store ?? new FileSessionStore();
    this.credentials = opts.credentials;
    this.overrides = opts.overrides ?? {};
    this.loginLock = opts.loginLock;
    this.sessionMaxAgeMs = opts.sessionMaxAgeMs ?? 12 * 3_600_000;
    this.log = opts.debug ? opts.logger ?? ((m, meta) => console.error(`[makroify] ${m}`, meta ?? "")) : () => {};
    this.sessionProvider =
      opts.sessionProvider ??
      (opts.loginMethod === "direct" ? directSessionProvider() : browserSessionProvider(opts.browser));
  }

  /** Build a client from environment variables (.env style). */
  static fromEnv(extra: Partial<MakroClientOptions> = {}): MakroClient {
    const userId = process.env.MAKRO_USER_ID;
    const password = process.env.MAKRO_PASSWORD;
    return new MakroClient({
      credentials: userId && password ? { userId, password } : undefined,
      overrides: {
        country: process.env.MAKRO_COUNTRY,
        locale: process.env.MAKRO_LOCALE,
        storeId: process.env.MAKRO_STORE_ID,
        fsdAddressId: process.env.MAKRO_FSD_ADDRESS_ID,
      },
      loginMethod: process.env.MAKRO_LOGIN_METHOD === "direct" ? "direct" : "browser",
      browser: { headless: process.env.MAKRO_HEADLESS !== "0" },
      debug: process.env.MAKROIFY_DEBUG === "1",
      ...extra,
    });
  }

  // --- session lifecycle ---------------------------------------------------

  /**
   * Log in (using provided/env credentials) and persist the session.
   *
   * Concurrent calls share a single login — critical because the browser login
   * is Akamai-rate-limited, so N parallel tool calls must NOT launch N logins.
   */
  async login(creds?: Credentials): Promise<SessionContext> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.lockedLogin(creds).finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** Acquire the cross-context lock, then re-check the store before logging in. */
  private async lockedLogin(creds?: Credentials): Promise<SessionContext> {
    const release = this.loginLock ? await this.loginLock() : null;
    try {
      // Another context may have logged in while we waited for the lock.
      const existing = await this.store.load();
      if (existing && !this.isStale(existing)) {
        this.session = existing;
        this.http = new Http({ jar: new MakroCookieJar(existing.cookies), log: this.log });
        return existing.context;
      }
      return await this.doLogin(creds);
    } finally {
      if (release) await release();
    }
  }

  private async doLogin(creds?: Credentials): Promise<SessionContext> {
    const credentials = creds ?? this.credentials;
    if (!credentials) throw new NotAuthenticatedError("No credentials provided (set MAKRO_USER_ID / MAKRO_PASSWORD).");

    const jar = new MakroCookieJar();
    const http = new Http({ jar, log: this.log });
    const { jwt } = await runLogin(http, credentials, this.sessionProvider);

    const context = await this.bootstrapContext(http, jwt);
    const session: Session = { jwt, cookies: jar.serialize(), context, savedAt: Date.now() };
    await this.store.save(session);
    this.session = session;
    this.http = http;
    return context;
  }

  /** Drop the persisted session. */
  async logout(): Promise<void> {
    await this.store.clear();
    this.session = null;
    this.http = null;
  }

  /** A session is "stale" past its reuse window (savedAt + sessionMaxAgeMs).
   *  Within the window we keep using it and rely on lazy re-auth on failure. */
  private isStale(s: Session): boolean {
    return Date.now() - s.savedAt > this.sessionMaxAgeMs;
  }

  /** Whether a reusable session is available (without throwing). */
  async isLoggedIn(): Promise<boolean> {
    const s = this.session ?? (await this.store.load());
    return Boolean(s && !this.isStale(s));
  }

  /** Resolved customer/store context for the active session. */
  async context(): Promise<SessionContext> {
    return (await this.ensure()).context;
  }

  /** Load (and validate) the session, throwing if absent/stale. */
  private async ensure(): Promise<Session> {
    if (this.session && this.http && !this.isStale(this.session)) return this.session;

    const loaded = this.session ?? (await this.store.load());

    // No session yet, or it's past the reuse window: log in transparently when
    // we have credentials (the agent path). Otherwise tell the user to log in.
    if (!loaded || this.isStale(loaded)) {
      if (this.credentials) {
        await this.login();
        return this.session!;
      }
      throw new NotAuthenticatedError(
        loaded ? "Session expired. Run `makroify login` again." : undefined,
      );
    }

    this.session = loaded;
    this.http = new Http({ jar: new MakroCookieJar(loaded.cookies), log: this.log });
    return loaded;
  }

  private async reqCtx(): Promise<{ http: Http; ctx: RequestContext }> {
    const s = await this.ensure();
    return { http: this.http!, ctx: toRequestContext(s.context) };
  }

  /**
   * Run an operation against the current session; if it fails with an auth
   * error (the session actually expired), re-login once and retry. This lets us
   * reuse a session for a long time and only pay a login when truly needed.
   */
  private async run<T>(fn: (http: Http, ctx: RequestContext) => Promise<T>): Promise<T> {
    const { http, ctx } = await this.reqCtx();
    try {
      return await fn(http, ctx);
    } catch (e) {
      if (!this.credentials || !isAuthFailure(e)) throw e;
      this.log("auth failure — re-logging in and retrying", e);
      await this.reauth();
      const retry = await this.reqCtx();
      return fn(retry.http, retry.ctx);
    }
  }

  /** Invalidate the current session and log in fresh (under the login lock). */
  private async reauth(): Promise<void> {
    this.session = null;
    this.http = null;
    await this.store.clear().catch(() => {});
    await this.login();
  }

  /** Resolve storeId / fsdAddressId after login, from JWT + carts list. */
  private async bootstrapContext(http: Http, jwt: string): Promise<SessionContext> {
    const jwtCtx = parseJwtContext(jwt);
    const country = this.overrides.country ?? jwtCtx.country ?? DEFAULTS.country;
    const locale = this.overrides.locale ?? DEFAULTS.locale;

    // Prefer an explicit store; else a non-home store from the JWT; else first.
    let storeId =
      this.overrides.storeId ?? jwtCtx.stores.find((s) => s !== "00001") ?? jwtCtx.stores[0] ?? "00401";
    let fsdAddressId = this.overrides.fsdAddressId;

    // Discover the delivery address (and confirm store) from existing carts.
    if (!fsdAddressId) {
      const probe: RequestContext = {
        country,
        locale,
        storeId,
        customerId: jwtCtx.customerId,
        cardholderNumber: jwtCtx.cardholderNumber,
      };
      try {
        const carts = await cartApi.listCarts(http, probe, "SAVED");
        const withAddr = carts.find((c) => c.fsdAddressId);
        if (withAddr) {
          if (!this.overrides.storeId && withAddr.storeId) storeId = withAddr.storeId;
          fsdAddressId = withAddr.fsdAddressId;
        }
      } catch (e) {
        this.log("context bootstrap: carts probe failed", e);
      }
    }

    return { ...jwtCtx, storeId, fsdAddressId, locale };
  }

  // --- product operations --------------------------------------------------

  /** Raw search (variant ids + prices). */
  async search(query: string, opts?: SearchOptions): Promise<SearchResults> {
    return this.run((http, ctx) => runSearch(http, ctx, query, opts));
  }

  /** Search and resolve hits to full products (names, bundle ids, prices). */
  async searchProducts(query: string, opts?: SearchOptions): Promise<Product[]> {
    return this.run(async (http, ctx) => {
      const results = await runSearch(http, ctx, query, opts);
      const ids = results.hits.map((h) => h.variantId);
      const resolved = await resolveVariants(http, ctx, ids);
      // Preserve search ranking; merge in search price as a fallback.
      return results.hits
        .map((h) => {
          const p = resolved.get(h.variantId);
          if (!p) return undefined;
          return { ...p, price: p.price ?? h.price };
        })
        .filter((p): p is Product => Boolean(p));
    });
  }

  /** Resolve a single variant id to a full product. */
  async getProduct(variantId: string): Promise<Product> {
    return this.run((http, ctx) => getProductByVariant(http, ctx, variantId));
  }

  // --- cart operations -----------------------------------------------------

  async getCurrentCart(): Promise<Cart> {
    return this.run((http, ctx) => cartApi.getCurrentCart(http, ctx));
  }

  async listCarts(status?: "SAVED" | "ACTIVE"): Promise<CartSummary[]> {
    return this.run((http, ctx) => cartApi.listCarts(http, ctx, status));
  }

  /** Add a product to the current cart by orderable bundle id. */
  async addItem(bundleId: string, quantity = 1, comment = ""): Promise<Cart> {
    return this.run(async (http, ctx) => {
      const { cartId } = await cartApi.getCurrentCart(http, ctx);
      await cartApi.addItem(http, ctx, cartId, bundleId, quantity, comment);
      return cartApi.getCurrentCart(http, ctx);
    });
  }

  /** Add by variant id (resolves to the default bundle first). */
  async addByVariant(variantId: string, quantity = 1, comment = ""): Promise<Cart> {
    const product = await this.getProduct(variantId);
    return this.addItem(product.bundleId, quantity, comment);
  }

  async updateItem(bundleId: string, quantity: number): Promise<Cart> {
    return this.run(async (http, ctx) => {
      const { cartId } = await cartApi.getCurrentCart(http, ctx);
      await cartApi.updateItemQuantity(http, ctx, cartId, bundleId, quantity);
      return cartApi.getCurrentCart(http, ctx);
    });
  }

  async removeItem(bundleId: string): Promise<Cart> {
    return this.run(async (http, ctx) => {
      const { cartId } = await cartApi.getCurrentCart(http, ctx);
      await cartApi.removeItem(http, ctx, cartId, bundleId);
      return cartApi.getCurrentCart(http, ctx);
    });
  }

  // --- order (stub until checkout HAR is provided) -------------------------

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const { http, ctx } = await this.reqCtx();
    return runPlaceOrder(http, ctx, params);
  }
}

/** A 401/403 from a data call means the session is no longer authenticated. */
function isAuthFailure(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 401 || e.status === 403);
}

function toRequestContext(c: SessionContext): RequestContext {
  return {
    country: c.country,
    locale: c.locale,
    storeId: c.storeId,
    customerId: c.customerId,
    cardholderNumber: c.cardholderNumber,
    fsdAddressId: c.fsdAddressId,
  };
}
