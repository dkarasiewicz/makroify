/**
 * Static configuration for the Makro Dla Gastronomii API.
 *
 * Values here were reverse-engineered from a real browser session (HAR capture).
 * Anything that varies per-customer (customerId, cardholderNumber, storeId,
 * fsdAddressId) is NOT hardcoded here — it is discovered at runtime from the
 * login JWT and the carts list (see `client.ts`).
 */

/** OAuth identity provider host. */
export const IDAM_BASE = "https://idam.makro.pl";

/** Shop / ordercapture API host. */
export const SHOP_BASE = "https://dlagastronomii.makro.pl";

/** OAuth client id used by the web shop. */
export const CLIENT_ID = "BTEX";

/** Realm for customer (as opposed to employee) logins. */
export const REALM_ID = "SSO_CUST_PL";

/** OAuth scope string (sent as `openid clnt=BTEX`). */
export const SCOPE = "openid clnt=BTEX";

/**
 * The redirect URI registered for the web client. The exact same value must be
 * sent to BOTH `/authc/authenticate` and `/oauth2/access_token`, so it lives in
 * one place. Taken verbatim from a known-good session.
 */
export const REDIRECT_URI =
  "https://dlagastronomii.makro.pl/shop/pv/BTY-X298754/0032/0021/Truskawka-1-kg-Polska-klasa-I?idamRedirect=1";

/** Sensible defaults for a PL coffee-shop customer. Overridable per-client. */
export const DEFAULTS = {
  country: "PL",
  locale: "pl-PL",
  userType: "CUST",
} as const;

/** Endpoint path builders. */
export const ENDPOINTS = {
  authenticate: () => `${IDAM_BASE}/web/authc/authenticate`,
  accessToken: () => `${IDAM_BASE}/authorize/api/oauth2/access_token`,
  userInfo: () => `${IDAM_BASE}/authorize/api/oauth2/userInfo`,
  loginWithIdamAccessToken: (country: string) =>
    `${SHOP_BASE}/ordercapture/login/auth/loginWithIdamAccessToken?country=${country}`,
} as const;
