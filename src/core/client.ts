import { Http, type Logger } from "./http";
import { MakroCookieJar } from "./cookies";
import { login as runLogin, directSessionProvider, type SessionProvider, type Credentials } from "./auth";
import { browserSessionProvider, type BrowserLoginOptions } from "./browser-login";
import { parseJwtContext } from "./jwt";
import { DEFAULTS } from "./config";
import {
  FileSessionStore,
  isExpired,
  type Session,
  type SessionContext,
  type SessionStore,
} from "./session";
import { NotAuthenticatedError } from "./errors";
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
  private credentials?: Credentials;
  private overrides: ContextOverrides;
  private log: Logger;
  private sessionProvider: SessionProvider;
  private session: Session | null = null;
  private http: Http | null = null;

  constructor(opts: MakroClientOptions = {}) {
    this.store = opts.store ?? new FileSessionStore();
    this.credentials = opts.credentials;
    this.overrides = opts.overrides ?? {};
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

  /** Log in (using provided/env credentials) and persist the session. */
  async login(creds?: Credentials): Promise<SessionContext> {
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

  /** Whether a non-expired session is available (without throwing). */
  async isLoggedIn(): Promise<boolean> {
    const s = this.session ?? (await this.store.load());
    return Boolean(s && !isExpired(s));
  }

  /** Resolved customer/store context for the active session. */
  async context(): Promise<SessionContext> {
    return (await this.ensure()).context;
  }

  /** Load (and validate) the session, throwing if absent/expired. */
  private async ensure(): Promise<Session> {
    if (this.session && this.http && !isExpired(this.session)) return this.session;

    const loaded = this.session ?? (await this.store.load());

    // No session yet, or it expired: log in transparently when we have
    // credentials (the agent path). Otherwise tell the user to log in.
    if (!loaded || isExpired(loaded)) {
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
    const { http, ctx } = await this.reqCtx();
    return runSearch(http, ctx, query, opts);
  }

  /** Search and resolve hits to full products (names, bundle ids, prices). */
  async searchProducts(query: string, opts?: SearchOptions): Promise<Product[]> {
    const { http, ctx } = await this.reqCtx();
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
  }

  /** Resolve a single variant id to a full product. */
  async getProduct(variantId: string): Promise<Product> {
    const { http, ctx } = await this.reqCtx();
    return getProductByVariant(http, ctx, variantId);
  }

  // --- cart operations -----------------------------------------------------

  async getCurrentCart(): Promise<Cart> {
    const { http, ctx } = await this.reqCtx();
    return cartApi.getCurrentCart(http, ctx);
  }

  async listCarts(status?: "SAVED" | "ACTIVE"): Promise<CartSummary[]> {
    const { http, ctx } = await this.reqCtx();
    return cartApi.listCarts(http, ctx, status);
  }

  /** Resolve the id of the current cart (needed for mutations). */
  private async currentCartId(): Promise<string> {
    const cart = await this.getCurrentCart();
    return cart.cartId;
  }

  /** Add a product to the current cart by orderable bundle id. */
  async addItem(bundleId: string, quantity = 1, comment = ""): Promise<Cart> {
    const { http, ctx } = await this.reqCtx();
    const cartId = await this.currentCartId();
    await cartApi.addItem(http, ctx, cartId, bundleId, quantity, comment);
    return cartApi.getCurrentCart(http, ctx);
  }

  /** Add by variant id (resolves to the default bundle first). */
  async addByVariant(variantId: string, quantity = 1, comment = ""): Promise<Cart> {
    const product = await this.getProduct(variantId);
    return this.addItem(product.bundleId, quantity, comment);
  }

  async updateItem(bundleId: string, quantity: number): Promise<Cart> {
    const { http, ctx } = await this.reqCtx();
    const cartId = await this.currentCartId();
    await cartApi.updateItemQuantity(http, ctx, cartId, bundleId, quantity);
    return cartApi.getCurrentCart(http, ctx);
  }

  async removeItem(bundleId: string): Promise<Cart> {
    const { http, ctx } = await this.reqCtx();
    const cartId = await this.currentCartId();
    await cartApi.removeItem(http, ctx, cartId, bundleId);
    return cartApi.getCurrentCart(http, ctx);
  }

  // --- order (stub until checkout HAR is provided) -------------------------

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const { http, ctx } = await this.reqCtx();
    return runPlaceOrder(http, ctx, params);
  }
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
