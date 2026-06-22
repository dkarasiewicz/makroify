import { createHash, randomBytes } from "node:crypto";
import { Http } from "./http";
import { MakroCookieJar } from "./cookies";
import { AuthError } from "./errors";
import {
  CLIENT_ID,
  DEFAULTS,
  ENDPOINTS,
  IDAM_BASE,
  REALM_ID,
  REDIRECT_URI,
  SCOPE,
} from "./config";

export interface Credentials {
  userId: string;
  password: string;
}

export interface LoginResult {
  /** The ordercapture JWT used as customer context. */
  jwt: string;
}

/** A cookie harvested from a browser/jar, to seed the lightweight client. */
export interface HarvestedCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

/** A complete, ready-to-use session produced by a {@link SessionProvider}. */
export interface ProvidedSession {
  /** The ordercapture JWT. */
  jwt: string;
  /** Session cookies (the actual credential for the data API). */
  cookies: HarvestedCookie[];
}

/**
 * Strategy for performing the Akamai-gated login and returning a usable session.
 * {@link directSessionProvider} replays the HTTP chain (works only where Akamai
 * is absent); {@link browser-login.browserSessionProvider} drives a real browser.
 */
export type SessionProvider = (creds: Credentials) => Promise<ProvidedSession>;

/** Parameters needed to render the Signin page / submit credentials. */
export interface CodeRequest {
  userId: string;
  password: string;
  codeChallenge: string;
  state: string;
  redirectUri: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE pair: a random verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex"); // 64 chars, within 43..128
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Build the IDAM Signin URL the SPA uses (PKCE challenge lives in the query). */
export function buildSigninUrl(req: CodeRequest): string {
  const p = new URLSearchParams({
    passwordless: "true",
    state: req.state,
    scope: SCOPE,
    locale_id: DEFAULTS.locale,
    redirect_uri: req.redirectUri,
    client_id: CLIENT_ID,
    country_code: DEFAULTS.country,
    realm_id: REALM_ID,
    user_type: DEFAULTS.userType,
    code_challenge: req.codeChallenge,
    code_challenge_method: "S256",
    response_type: "code",
  });
  return `${IDAM_BASE}/web/Signin?${p}`;
}

/**
 * Run login via the given session provider and seed the client's cookie jar
 * with the resulting session cookies (the actual credential for data calls).
 */
export async function login(http: Http, creds: Credentials, provider: SessionProvider): Promise<LoginResult> {
  const session = await provider(creds);
  seedJar(http.jar, session.cookies);
  return { jwt: session.jwt };
}

/** Seed a cookie jar with cookies harvested from a browser/another jar. */
export function seedJar(jar: MakroCookieJar, cookies: HarvestedCookie[]): void {
  for (const c of cookies) {
    const path = c.path ?? "/";
    const host = c.domain.replace(/^\./, "");
    const url = `https://${host}${path}`;
    const domainAttr = c.domain ? `; Domain=${c.domain}` : "";
    jar.storeFromResponse(url, [`${c.name}=${c.value}${domainAttr}; Path=${path}`]);
  }
}

/**
 * Direct (no-browser) login: replays the full HTTP chain. Subject to Akamai Bot
 * Manager — fails with 403 where it is enforced. Useful for tests / non-gated
 * environments.
 */
export function directSessionProvider(): SessionProvider {
  return async (creds) => {
    const jar = new MakroCookieJar();
    const http = new Http({ jar });
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("hex");
    const { code } = await directAuthenticate(http, {
      userId: creds.userId,
      password: creds.password,
      codeChallenge: challenge,
      state,
      redirectUri: REDIRECT_URI,
    });
    const accessToken = await exchangeCodeForAccessToken(http, code, verifier);
    const jwt = await loginWithIdamAccessToken(http, accessToken);
    return { jwt, cookies: jar.export() };
  };
}

async function directAuthenticate(http: Http, req: CodeRequest): Promise<{ code: string }> {
  const form = new URLSearchParams({
    user_id: req.userId,
    password: req.password,
    user_type: DEFAULTS.userType,
    client_id: CLIENT_ID,
    response_type: "code",
    country_code: DEFAULTS.country,
    locale_id: DEFAULTS.locale,
    realm_id: REALM_ID,
    account_id: "",
    redirect_url: req.redirectUri,
    state: req.state,
    nonce: "",
    scope: SCOPE,
    code_challenge: req.codeChallenge,
    code_challenge_method: "S256",
  });

  const res = await http.request(ENDPOINTS.authenticate(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: IDAM_BASE,
      referer: `${IDAM_BASE}/web/Signin`,
    },
    raw: form.toString(),
    noThrow: true,
  });

  const location = res.headers.get("location") ?? "";
  const text = await res.text().catch(() => "");
  if (res.status >= 400) {
    throw new AuthError(`Authentication failed (HTTP ${res.status}). Body: ${text.slice(0, 300)}`);
  }
  const code = extractAuthCode(`${location}\n${text}`);
  if (!code) throw new AuthError(`Could not locate authorization code. Body: ${text.slice(0, 300)}`);
  return { code };
}

/** Pull an OAuth `code` out of a redirect URL or JSON blob. */
export function extractAuthCode(haystack: string): string | null {
  try {
    const obj = JSON.parse(haystack.trim().split("\n").pop() ?? "");
    for (const key of ["redirectUrl", "redirect_uri", "redirectUri", "location", "url", "code", "authorizationCode"]) {
      const v = (obj as Record<string, unknown>)[key];
      if (typeof v === "string") {
        const m = /[?&#]code=([^&"#\s]+)/.exec(v);
        if (m) return decodeURIComponent(m[1]!);
        if (key === "code" || key === "authorizationCode") return v;
      }
    }
  } catch {
    // not JSON; fall through
  }
  const m = /[?&#]code=([^&"#\s]+)/.exec(haystack);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Exchange the authorization code for an IDAM access token (PKCE). */
export async function exchangeCodeForAccessToken(http: Http, code: string, verifier: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
  });
  const data = await http.json<{ access_token?: string }>(ENDPOINTS.accessToken(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    raw: form.toString(),
  });
  if (!data.access_token) throw new AuthError("Token exchange returned no access_token");
  return data.access_token;
}

/** Trade the IDAM access token for the ordercapture JWT + session cookies. */
export async function loginWithIdamAccessToken(http: Http, accessToken: string): Promise<string> {
  const data = await http.json<{ JWT?: string }>(ENDPOINTS.loginWithIdamAccessToken(DEFAULTS.country), {
    method: "POST",
    headers: { "content-type": "text/plain" },
    raw: accessToken,
  });
  if (!data.JWT) throw new AuthError("loginWithIdamAccessToken returned no JWT");
  return data.JWT;
}
