/** Base error for all Makroify failures. */
export class MakroError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when the login chain fails at any step. */
export class AuthError extends MakroError {}

/** Thrown when there is no usable session and one is required. */
export class NotAuthenticatedError extends MakroError {
  constructor(message = "Not authenticated. Run `makroify login` first.") {
    super(message);
  }
}

/** Thrown for non-2xx HTTP responses. Carries the raw response details. */
export class HttpError extends MakroError {
  readonly status: number;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: { status: number; url: string; method: string; body: string }) {
    super(`HTTP ${args.status} on ${args.method} ${args.url}: ${args.body.slice(0, 500)}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
  }
}

/** Thrown when a product/search lookup cannot be resolved to an orderable bundle. */
export class ResolutionError extends MakroError {}
