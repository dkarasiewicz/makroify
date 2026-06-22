import { randomUUID } from "node:crypto";
import { MakroCookieJar } from "./cookies";
import { HttpError } from "./errors";
import { SHOP_BASE } from "./config";

export type Logger = (msg: string, meta?: unknown) => void;

export interface HttpOptions {
  jar: MakroCookieJar;
  /** Optional debug logger; defaults to no-op. */
  log?: Logger;
  /** Overrides the default browser-ish User-Agent. */
  userAgent?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface RequestInitX extends Omit<RequestInit, "body"> {
  /** JSON body — serialized and sent with application/json. */
  json?: unknown;
  /** Raw body (string) — sent as-is with the provided content-type. */
  raw?: string;
  /** Skip throwing on non-2xx; return the Response untouched. */
  noThrow?: boolean;
}

/**
 * Cookie-aware fetch wrapper. Every request automatically attaches the stored
 * Cookie header and captures any Set-Cookie from the response, so the login
 * session "just works" across the multi-host OAuth chain.
 */
export class Http {
  readonly jar: MakroCookieJar;
  private log: Logger;
  private ua: string;

  constructor(opts: HttpOptions) {
    this.jar = opts.jar;
    this.log = opts.log ?? (() => {});
    this.ua = opts.userAgent ?? DEFAULT_UA;
  }

  async request(url: string, init: RequestInitX = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);

    if (!headers.has("user-agent")) headers.set("user-agent", this.ua);
    if (!headers.has("accept")) headers.set("accept", "*/*");
    // Mimic the browser shop client; some endpoints check origin/referer.
    if (!headers.has("origin")) headers.set("origin", SHOP_BASE);
    if (!headers.has("referer")) headers.set("referer", `${SHOP_BASE}/`);
    if (!headers.has("calltreeid")) headers.set("calltreeid", `||BTOC-${randomUUID().toUpperCase()}`);

    let body: string | undefined;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=UTF-8");
    } else if (init.raw !== undefined) {
      body = init.raw;
    }

    const cookie = this.jar.cookieHeader(url);
    if (cookie) headers.set("cookie", cookie);

    this.log(`→ ${method} ${url}`, init.json ?? init.raw);

    const res = await fetch(url, { ...init, method, headers, body, redirect: "manual" });

    // Capture cookies regardless of status (login redirects set cookies on 3xx).
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length) this.jar.storeFromResponse(url, setCookies);

    this.log(`← ${res.status} ${method} ${url}`);

    if (!init.noThrow && !res.ok && !(res.status >= 300 && res.status < 400)) {
      const text = await res.text().catch(() => "");
      throw new HttpError({ status: res.status, url, method, body: text });
    }
    return res;
  }

  /** Request and parse a JSON response. */
  async json<T>(url: string, init: RequestInitX = {}): Promise<T> {
    const res = await this.request(url, init);
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new HttpError({ status: res.status, url, method: init.method ?? "GET", body: text });
    }
  }
}

/** Cache-busting timestamp param the shop appends as `__t`. Deterministic-free. */
export function cacheBust(): string {
  return `__t=${Date.now()}`;
}
