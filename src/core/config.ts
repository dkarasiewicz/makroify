/**
 * Static config for the Makro Dla Gastronomii API, reverse-engineered from a real
 * session. Per-customer values (customerId, storeId, fsdAddressId, …) are NOT
 * here — they're discovered at runtime from the JWT and carts list (see client.ts).
 */

/** OAuth identity provider host. */
export const IDAM_BASE = "https://idam.makro.pl";

/** Shop / ordercapture API host. */
export const SHOP_BASE = "https://dlagastronomii.makro.pl";

export const CLIENT_ID = "BTEX";
export const REALM_ID = "SSO_CUST_PL";
export const SCOPE = "openid clnt=BTEX";

/**
 * Redirect URI for the SPA's silent OAuth flow. The `authorize` and
 * `access_token` calls must send this exact value, so it lives in one place.
 */
export const SILENT_REDIRECT_URI =
  "https://dlagastronomii.makro.pl/ordercapture/uidispatcher/static/silent-redirect.html";

export const DEFAULTS = {
  country: "PL",
  locale: "pl-PL",
  userType: "CUST",
} as const;

export const ENDPOINTS = {
  authorize: () => `${IDAM_BASE}/authorize/api/oauth2/authorize`,
  accessToken: () => `${IDAM_BASE}/authorize/api/oauth2/access_token`,
  loginWithIdamAccessToken: (country: string) =>
    `${SHOP_BASE}/ordercapture/login/auth/loginWithIdamAccessToken?country=${country}`,
} as const;
