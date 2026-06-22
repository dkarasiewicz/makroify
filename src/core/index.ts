export { MakroClient } from "./client";
export type { MakroClientOptions, ContextOverrides, LoginLock } from "./client";

export type {
  Credentials,
  LoginResult,
  SessionProvider,
  ProvidedSession,
  CodeRequest,
  HarvestedCookie,
} from "./auth";
export { directSessionProvider, pkcePair, buildSigninUrl, seedJar } from "./auth";
export { browserSessionProvider } from "./browser-login";
export type { BrowserLoginOptions } from "./browser-login";
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
