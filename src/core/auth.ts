import { createHash, randomBytes } from "node:crypto";
import { Http } from "./http";
import { MakroCookieJar } from "./cookies";
import { AuthError } from "./errors";
import { CLIENT_ID, DEFAULTS, ENDPOINTS, REALM_ID, SCOPE, SHOP_BASE, SILENT_REDIRECT_URI } from "./config";

export interface LoginResult {
  jwt: string;
}

export interface HarvestedCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

export interface ProvidedSession {
  jwt: string;
  cookies: HarvestedCookie[];
}

export type SessionProvider = () => Promise<ProvidedSession>;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Run the provider and seed the client's jar with the session cookies. */
export async function login(http: Http, provider: SessionProvider): Promise<LoginResult> {
  const session = await provider();
  seedJar(http.jar, session.cookies);
  return { jwt: session.jwt };
}

export function seedJar(jar: MakroCookieJar, cookies: HarvestedCookie[]): void {
  for (const c of cookies) {
    const path = c.path ?? "/";
    const host = c.domain.replace(/^\./, "");
    const domainAttr = c.domain ? `; Domain=${c.domain}` : "";
    jar.storeFromResponse(`https://${host}${path}`, [`${c.name}=${c.value}${domainAttr}; Path=${path}`]);
  }
}

/**
 * The login path. Reuses a logged-in browser's IDAM cookies to run the SPA's
 * silent OAuth flow (`prompt=none`) — minting a fresh code → access token →
 * ordercapture JWT with no password and no Akamai-gated step. The IDAM session
 * outlives the 1h JWT by weeks, so the same pasted cookies keep refreshing it.
 */
export function cookieSsoProvider(cookies: HarvestedCookie[]): SessionProvider {
  return async () => {
    if (!cookies.length) {
      throw new AuthError("No cookies provided — set MAKRO_COOKIE to a logged-in idam.makro.pl Cookie header.");
    }
    const jar = new MakroCookieJar();
    seedJar(jar, cookies);
    const http = new Http({ jar });

    const { verifier, challenge } = pkcePair();
    const code = await silentAuthorize(http, challenge, randomBytes(16).toString("hex"));
    const { accessToken, idToken } = await exchangeCodeForAccessToken(http, code, verifier);
    const { jwt, compressedJwt } = await loginWithIdamAccessToken(http, accessToken);

    // The SPA sets these client-side after login; the data API authorizes off
    // `compressedJWT` (+ `idamUserIdToken`), so we set them ourselves.
    seedJar(jar, [
      ...(idToken ? [cookie("idamUserIdToken", idToken)] : []),
      ...(compressedJwt ? [cookie("compressedJWT", compressedJwt)] : []),
      cookie("JWT", jwt),
    ]);

    return { jwt, cookies: jar.export() };
  };
}

const cookie = (name: string, value: string): HarvestedCookie => ({ name, value, domain: ".makro.pl", path: "/" });

/**
 * `prompt=none` authorize: with a valid IDAM session cookie this returns an auth
 * code (no prompt) inside a tiny HTML page redirecting to `silent-redirect.html`.
 */
async function silentAuthorize(http: Http, codeChallenge: string, state: string): Promise<string> {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: SILENT_REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "none",
    realm_id: REALM_ID,
    country_code: DEFAULTS.country,
    locale_id: DEFAULTS.locale,
    user_type: DEFAULTS.userType,
  });
  const res = await http.request(`${ENDPOINTS.authorize()}?${p}`, {
    method: "GET",
    headers: { accept: "text/html", referer: `${SHOP_BASE}/` },
    noThrow: true,
  });
  const body = await res.text().catch(() => "");
  const expired = "The pasted cookies are expired — copy a fresh Cookie header from a logged-in browser.";
  if (res.status >= 400) throw new AuthError(`Silent authorize failed (HTTP ${res.status}). ${expired}`);

  const match = /[?&]code=([^&"#\s]+)/.exec(body.replace(/&amp;/g, "&"));
  if (!match) throw new AuthError(`Silent authorize returned no code. ${expired}`);
  return decodeURIComponent(match[1]!);
}

export function parseCookieHeader(raw: string, domain = ".makro.pl"): HarvestedCookie[] {
  const out: HarvestedCookie[] = [];
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out.push({ name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim(), domain, path: "/" });
  }
  return out;
}

/** Exchange the auth code for an IDAM access token (PKCE). */
export async function exchangeCodeForAccessToken(
  http: Http,
  code: string,
  verifier: string,
): Promise<{ accessToken: string; idToken?: string }> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    redirect_uri: SILENT_REDIRECT_URI,
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
  });
  const data = await http.json<{ access_token?: string; id_token?: string }>(ENDPOINTS.accessToken(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    raw: form.toString(),
  });
  if (!data.access_token) throw new AuthError("Token exchange returned no access_token");
  return { accessToken: data.access_token, idToken: data.id_token };
}

/** Trade the IDAM access token for the ordercapture JWT (+ its compressed form). */
export async function loginWithIdamAccessToken(
  http: Http,
  accessToken: string,
): Promise<{ jwt: string; compressedJwt?: string }> {
  const data = await http.json<{ JWT?: string; compressedJWT?: string }>(
    ENDPOINTS.loginWithIdamAccessToken(DEFAULTS.country),
    { method: "POST", headers: { "content-type": "text/plain" }, raw: accessToken },
  );
  if (!data.JWT) throw new AuthError("loginWithIdamAccessToken returned no JWT");
  return { jwt: data.JWT, compressedJwt: data.compressedJWT };
}
