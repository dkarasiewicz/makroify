/** Decode a JWT payload (no signature verification — we only read claims). */
export function decodeJwt<T = Record<string, unknown>>(token: string): T {
  const part = token.split(".")[1];
  if (!part) throw new Error("Malformed JWT: missing payload segment");
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json) as T;
}

/** Customer context extracted from the ordercapture JWT. */
export interface JwtContext {
  customerId: string;
  cardholderNumber: string;
  country: string;
  tierLevel?: string;
  /** Store ids the user has access to, e.g. ["00001", "00401"]. */
  stores: string[];
  /** Unix seconds when the JWT expires. */
  exp?: number;
}

interface OrderCaptureJwt {
  payload?: string;
  uStores?: string | null;
  exp?: number;
}

interface InnerPayload {
  role?: string;
  upn?: string;
  cardholderNumber?: string;
  tierLevel?: string;
  country?: string;
}

/**
 * Parse the ordercapture JWT returned by loginWithIdamAccessToken.
 * The interesting customer identifiers live in a JSON-stringified `payload`
 * claim; store ids are encoded in `uStores` as e.g. "PLD1,PLD401".
 */
export function parseJwtContext(jwt: string): JwtContext {
  const claims = decodeJwt<OrderCaptureJwt>(jwt);
  const inner: InnerPayload = claims.payload ? JSON.parse(claims.payload) : {};

  const stores = (claims.uStores ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => storeCodeToId(s))
    .filter((s): s is string => Boolean(s));

  if (!inner.upn) throw new Error("JWT missing customer id (payload.upn)");

  return {
    customerId: inner.upn,
    cardholderNumber: inner.cardholderNumber ?? "1",
    country: inner.country ?? "PL",
    tierLevel: inner.tierLevel,
    stores,
    exp: claims.exp,
  };
}

/** "PLD401" -> "00401", "PLD1" -> "00001". Returns null if unrecognized. */
function storeCodeToId(code: string): string | null {
  const m = /^[A-Z]{2}D(\d+)$/.exec(code);
  if (!m) return null;
  return m[1]!.padStart(5, "0");
}
