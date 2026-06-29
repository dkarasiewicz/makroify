export { MakroClient } from "./client";
export type { MakroClientOptions, ContextOverrides, FuzzySearch, FindResult } from "./client";

export type {
  RecentlyBoughtItem,
  OrderSummary,
  OrderList,
  OrderLineItem,
  OrderDetails,
} from "./history";
export {
  foldDiacritics,
  normalize,
  fuzzyQueries,
  scoreNameMatch,
  rankByMatchThenPrice,
} from "./match";

export type {
  LoginResult,
  SessionProvider,
  ProvidedSession,
  HarvestedCookie,
} from "./auth";
export { cookieSsoProvider, parseCookieHeader, pkcePair, seedJar } from "./auth";
export type {
  Session,
  SessionStore,
  SessionContext,
} from "./session";
export { FileSessionStore, MemorySessionStore, isExpired } from "./session";

export type { RequestContext } from "./context";
export { defaultDeliveryDate, isoDate, compactDate } from "./context";

export type {
  Product,
  SearchHit,
  SearchResults,
  Cart,
  CartItem,
  CartSummary,
} from "./types";
export { variantIdFromBundleId } from "./products";

export type { PlaceOrderParams, OrderResult } from "./order";

export {
  MakroError,
  AuthError,
  HttpError,
  NotAuthenticatedError,
  ResolutionError,
} from "./errors";

export { parseJwtContext, decodeJwt } from "./jwt";
export type { JwtContext } from "./jwt";
