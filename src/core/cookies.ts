import { CookieJar } from "tough-cookie";

/**
 * Thin wrapper around tough-cookie's CookieJar.
 *
 * The Makro login chain authenticates via httpOnly cookies that are set across
 * BOTH idam.makro.pl and dlagastronomii.makro.pl. We never need to know the
 * cookie names — we just capture every Set-Cookie and replay them on subsequent
 * requests to the matching domain. tough-cookie handles domain/path/expiry.
 */
export class MakroCookieJar {
  private jar: CookieJar;

  constructor(serialized?: string) {
    this.jar = serialized
      ? CookieJar.deserializeSync(serialized)
      : new CookieJar();
  }

  /** Cookie header value to send for a given URL ("" if none). */
  cookieHeader(url: string): string {
    return this.jar.getCookieStringSync(url);
  }

  /** Store all Set-Cookie values returned for a URL. */
  storeFromResponse(url: string, setCookies: string[]): void {
    for (const sc of setCookies) {
      try {
        this.jar.setCookieSync(sc, url, { ignoreError: true });
      } catch {
        // Ignore malformed cookies; never let a stray cookie break the flow.
      }
    }
  }

  /** Serialize for persistence in a SessionStore. */
  serialize(): string {
    return JSON.stringify(this.jar.serializeSync());
  }

  /** True if any cookie is currently stored. */
  isEmpty(): boolean {
    return (this.jar.serializeSync()?.cookies?.length ?? 0) === 0;
  }

  /** Export stored cookies in a flat, portable shape. */
  export(): Array<{ name: string; value: string; domain: string; path?: string }> {
    const ser = this.jar.serializeSync();
    return (ser?.cookies ?? [])
      .filter((c) => c.key && c.value)
      .map((c) => ({
        name: String(c.key),
        value: String(c.value),
        domain: c.domain ? String(c.domain) : "",
        path: c.path ? String(c.path) : "/",
      }));
  }
}
