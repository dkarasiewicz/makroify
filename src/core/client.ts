import { Http, type Logger } from "./http";
import { MakroCookieJar } from "./cookies";
import { login as runLogin, cookieSsoProvider, parseCookieHeader, type SessionProvider } from "./auth";
import { parseJwtContext } from "./jwt";
import { DEFAULTS } from "./config";
import {
  FileSessionStore,
  type Session,
  type SessionContext,
  type SessionStore,
} from "./session";
import { HttpError, MakroError } from "./errors";
import type { RequestContext } from "./context";
import {
  search as runSearch,
  resolveVariants,
  resolveBundles,
  getProductByVariant,
  type SearchOptions,
} from "./products";
import * as cartApi from "./cart";
import {
  listRecentlyBought,
  listOrders,
  getOrderDetails as runGetOrderDetails,
  type OrderList,
  type OrderDetails,
} from "./history";
import { fuzzyQueries, rankByMatchThenPrice, strongMatch, uniqueByBundle } from "./match";
import { placeOrder as runPlaceOrder, type OrderResult, type PlaceOrderParams } from "./order";
import type { Cart, CartItem, CartSummary, Product, SearchResults } from "./types";

const RECENTLY_BOUGHT_TTL_MS = 24 * 3_600_000;
const RESOLVE_CHUNK = 40;

/** A fuzzy search outcome: the variant that actually returned hits + what was tried. */
export interface FuzzySearch {
  /** The query variant that produced results (may differ from the input). */
  query: string;
  products: Product[];
  /** Every query variant attempted, in order. */
  tried: string[];
}

/**
 * Result of resolving a loose user request (e.g. "truskawki") against, in order,
 * the current cart, the recently-bought list, and a fuzzy search. The caller
 * decides what to say/do; this just gathers the signals.
 */
export interface FindResult {
  query: string;
  /** Where the top recommendation came from. */
  source: "cart" | "recent" | "search" | "none";
  /** Matching items already in the cart (so the user can just bump quantity). */
  inCart: CartItem[];
  /** Matches from the recently-bought list, best first. */
  recentlyBought: Product[];
  /** The single best product to add (from recent if any, else search), or null. */
  best: Product | null;
  /** A couple of alternatives to offer (cheaper / other close matches). */
  alternatives: Product[];
  /** Query variants the search tried (for transparency / debugging). */
  triedQueries: string[];
}

export interface ContextOverrides {
  country?: string;
  locale?: string;
  storeId?: string;
  fsdAddressId?: string;
}

export interface MakroClientOptions {
  store?: SessionStore;
  overrides?: ContextOverrides;
  /**
   * Raw browser `Cookie:` header from a logged-in idam.makro.pl session. We
   * reuse its IDAM cookies to silently mint a fresh JWT on demand (no password,
   * no Akamai-gated login). This is the credential.
   */
  cookieHeader?: string;
  /** Provide a fully custom session provider (overrides `cookieHeader`). */
  sessionProvider?: SessionProvider;
  /**
   * How long to reuse a stored session before forcing a fresh login, ms. The
   * IDAM cookies outlive the 1h JWT, so we reuse a minted session for a long
   * window and re-login lazily only when a request actually fails auth.
   * Default 12h.
   */
  sessionMaxAgeMs?: number;
  /** Enable verbose request logging. */
  debug?: boolean;
  logger?: Logger;
}

/**
 * High-level entry point. Holds a session (cookies + JWT + customer context),
 * persists it via a pluggable {@link SessionStore}, and exposes search/cart ops.
 */
export class MakroClient {
  private store: SessionStore;
  private overrides: ContextOverrides;
  private log: Logger;
  private sessionProvider: SessionProvider;
  private session: Session | null = null;
  private http: Http | null = null;
  private sessionMaxAgeMs: number;
  /** Dedupes concurrent logins into one (so parallel tool calls mint once). */
  private loginInFlight: Promise<SessionContext> | null = null;
  /** In-memory cache of the resolved recently-bought list (refreshed daily). */
  private recentlyBought: { at: number; items: Product[] } | null = null;

  constructor(opts: MakroClientOptions = {}) {
    this.store = opts.store ?? new FileSessionStore();
    this.overrides = opts.overrides ?? {};
    this.sessionMaxAgeMs = opts.sessionMaxAgeMs ?? 12 * 3_600_000;
    this.log = opts.debug ? opts.logger ?? ((m, meta) => console.error(`[makroify] ${m}`, meta ?? "")) : () => {};
    this.sessionProvider =
      opts.sessionProvider ?? cookieSsoProvider(parseCookieHeader(opts.cookieHeader ?? ""));
  }

  /** Build a client from environment variables (.env style). */
  static fromEnv(extra: Partial<MakroClientOptions> = {}): MakroClient {
    return new MakroClient({
      overrides: {
        country: process.env.MAKRO_COUNTRY,
        locale: process.env.MAKRO_LOCALE,
        storeId: process.env.MAKRO_STORE_ID,
        fsdAddressId: process.env.MAKRO_FSD_ADDRESS_ID,
      },
      cookieHeader: process.env.MAKRO_COOKIE,
      debug: process.env.MAKROIFY_DEBUG === "1",
      ...extra,
    });
  }

  // --- session lifecycle ---------------------------------------------------

  /**
   * Mint a fresh session from the pasted cookies and persist it. Concurrent
   * calls within a process share one mint (so parallel tool calls don't each run
   * the silent OAuth chain); the silent SSO is cheap and unthrottled, so no
   * cross-process lock is needed — a rare double-mint just overwrites the store.
   */
  async login(): Promise<SessionContext> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.freshLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** Reuse a session another run just persisted, else mint a new one. */
  private async freshLogin(): Promise<SessionContext> {
    const existing = await this.store.load();
    if (existing && !this.isStale(existing)) {
      this.session = existing;
      this.http = new Http({ jar: new MakroCookieJar(existing.cookies), log: this.log });
      return existing.context;
    }
    return this.doLogin();
  }

  private async doLogin(): Promise<SessionContext> {
    const jar = new MakroCookieJar();
    const http = new Http({ jar, log: this.log });
    const { jwt } = await runLogin(http, this.sessionProvider);

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

    // No session yet, or past the reuse window: mint a fresh one from the cookies.
    if (!loaded || this.isStale(loaded)) {
      await this.login();
      return this.session!;
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
      if (!isAuthFailure(e)) throw e;
      this.log("auth failure — re-logging in and retrying", e);
      await this.reauth();
      const retry = await this.reqCtx();
      return fn(retry.http, retry.ctx);
    }
  }

  /** Invalidate the current session and mint a fresh one. */
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

  /**
   * Search, retrying with progressively looser query variants until something
   * hits (handles Polish declension and small typos). Returns the variant that
   * worked plus the full list of variants tried.
   */
  async searchProductsFuzzy(query: string, opts?: SearchOptions): Promise<FuzzySearch> {
    const tried: string[] = [];
    for (const q of fuzzyQueries(query)) {
      tried.push(q);
      const products = await this.searchProducts(q, opts);
      if (products.length) return { query: q, products, tried };
    }
    return { query, products: [], tried };
  }

  // --- history & discovery -------------------------------------------------

  /**
   * The customer's recently-bought products, resolved to names/prices. Cached in
   * memory for 24h (the list barely changes day-to-day); pass `refresh` to bust.
   */
  async getRecentlyBought(opts?: { limit?: number; refresh?: boolean }): Promise<Product[]> {
    const fresh = this.recentlyBought && Date.now() - this.recentlyBought.at < RECENTLY_BOUGHT_TTL_MS;
    if (!opts?.refresh && fresh) return slice(this.recentlyBought!.items, opts?.limit);

    const items = await this.run(async (http, ctx) => {
      const raw = await listRecentlyBought(http, ctx);
      const bundleIds = raw.map((r) => r.bundleId);
      const byBundle = new Map<string, Product>();
      for (let i = 0; i < bundleIds.length; i += RESOLVE_CHUNK) {
        const chunk = bundleIds.slice(i, i + RESOLVE_CHUNK);
        for (const [id, p] of await resolveBundles(http, ctx, chunk)) byBundle.set(id, p);
      }
      // Preserve the recently-bought order (most recent first).
      return raw.map((r) => byBundle.get(r.bundleId)).filter((p): p is Product => Boolean(p));
    });

    this.recentlyBought = { at: Date.now(), items };
    return slice(items, opts?.limit);
  }

  /**
   * Resolve a loose request against cart → recently-bought → fuzzy search, in
   * that priority. Read-only: returns what was found and the best pick; the
   * caller adds to the cart and asks the user about quantity/alternatives.
   */
  async findItem(query: string, opts?: { limit?: number }): Promise<FindResult> {
    const limit = opts?.limit ?? 6;
    const [cart, recent] = await Promise.all([
      this.getCurrentCart().catch(() => null),
      this.getRecentlyBought().catch(() => [] as Product[]),
    ]);

    const inCart = (cart?.items ?? []).filter((it) => strongMatch(query, it.name));
    const recentlyBought = rankByMatchThenPrice(query, recent.filter((p) => strongMatch(query, p.name))).slice(0, limit);

    const { products, tried } = await this.searchProductsFuzzy(query, { rows: 12 });
    const ranked = rankByMatchThenPrice(query, products);

    const best = recentlyBought[0] ?? ranked[0] ?? null;
    // Offer other recently-bought matches first (what they actually buy), then
    // the best search hits — de-duped, minus whatever we picked as `best`.
    const alternatives = uniqueByBundle([...recentlyBought, ...ranked])
      .filter((p) => p.bundleId !== best?.bundleId)
      .slice(0, 3);
    const source: FindResult["source"] = inCart.length
      ? "cart"
      : recentlyBought.length
        ? "recent"
        : ranked.length
          ? "search"
          : "none";

    return { query, source, inCart, recentlyBought, best, alternatives, triedQueries: tried };
  }

  /** List past orders, newest first. Page with the returned `nextCursor`. */
  async getOrders(opts?: { rows?: number; cursor?: string | null }): Promise<OrderList> {
    return this.run((http, ctx) => listOrders(http, ctx, opts ?? {}));
  }

  /** Full line items + totals for one past order. */
  async getOrderDetails(orderId: string): Promise<OrderDetails> {
    return this.run((http, ctx) => runGetOrderDetails(http, ctx, orderId));
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

  // --- order ---------------------------------------------------------------

  /**
   * Place an order from the current cart (cash on delivery). IRREVERSIBLE —
   * confirm with the user first. Pass `dryRun` to run checkout up to, but not
   * including, the final submit. Not auto-retried, to avoid double submission.
   */
  async placeOrder(params: Partial<PlaceOrderParams> = {}): Promise<OrderResult> {
    const { http, ctx } = await this.reqCtx();
    const cart = await cartApi.getCurrentCart(http, ctx);
    if (!cart.cartId) throw new MakroError("No active cart to order.");
    if (!cart.items.length) throw new MakroError("Cart is empty — nothing to order.");
    return runPlaceOrder(http, ctx, {
      cartId: cart.cartId,
      fsdAddressId: cart.fsdAddressId ?? ctx.fsdAddressId,
      deliveryDate: params.deliveryDate,
      dryRun: params.dryRun,
    });
  }
}

const slice = <T>(arr: T[], limit?: number): T[] => (limit ? arr.slice(0, limit) : arr);

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
