import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import type { JwtContext } from "./jwt";

/** A persisted, resumable Makro session. */
export interface Session {
  /** The ordercapture JWT (auth is actually carried by cookies, but we keep
   *  this for context + expiry checks). */
  jwt: string;
  /** Serialized cookie jar (the real credential). */
  cookies: string;
  /** Customer/store context resolved at login time. */
  context: SessionContext;
  /** Unix ms when the session was created. */
  savedAt: number;
}

export interface SessionContext extends JwtContext {
  /** Active store, e.g. "00401". */
  storeId: string;
  /** Delivery address id used by cart/article calls, if discovered. */
  fsdAddressId?: string;
  locale: string;
}

/**
 * Pluggable session persistence. The CLI uses {@link FileSessionStore}; a SaaS
 * deployment can implement this against Redis/Postgres/etc. — the core client
 * only depends on this interface.
 */
export interface SessionStore {
  load(): Promise<Session | null>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
}

/** Keeps the session in memory only (good for tests / serverless requests). */
export class MemorySessionStore implements SessionStore {
  private session: Session | null = null;
  constructor(initial?: Session | null) {
    this.session = initial ?? null;
  }
  async load() {
    return this.session;
  }
  async save(session: Session) {
    this.session = session;
  }
  async clear() {
    this.session = null;
  }
}

/** Persists the session as JSON under ~/.makroify (override via MAKROIFY_HOME). */
export class FileSessionStore implements SessionStore {
  private file: string;

  constructor(opts?: { dir?: string; file?: string }) {
    const dir = opts?.dir ?? process.env.MAKROIFY_HOME ?? join(homedir(), ".makroify");
    this.file = join(dir, opts?.file ?? "session.json");
  }

  async load(): Promise<Session | null> {
    try {
      const raw = await readFile(this.file, "utf8");
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  async save(session: Session): Promise<void> {
    await mkdir(join(this.file, ".."), { recursive: true });
    // 0600 so the cookie/JWT aren't world-readable.
    await writeFile(this.file, JSON.stringify(session, null, 2), { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

/** True if the JWT is expired (or expires within `skewSeconds`). */
export function isExpired(session: Session, skewSeconds = 60): boolean {
  const exp = session.context.exp;
  if (!exp) return false;
  return Date.now() / 1000 >= exp - skewSeconds;
}
