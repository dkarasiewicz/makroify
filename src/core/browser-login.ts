import type { Credentials, HarvestedCookie, ProvidedSession, SessionProvider } from "./auth";
import { buildSigninUrl, pkcePair } from "./auth";
import { AuthError } from "./errors";
import { randomBytes } from "node:crypto";
import { REDIRECT_URI } from "./config";

export interface BrowserLoginOptions {
  /** Run without a visible window (default true). Set false to debug/solve a captcha. */
  headless?: boolean;
  /** Overall timeout for the login interaction, ms (default 60000). */
  timeoutMs?: number;
  userAgent?: string;
  /** Optional Playwright launch channel, e.g. "chrome" to use system Chrome. */
  channel?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * A {@link SessionProvider} that drives a real Chromium via Playwright to get
 * past Akamai Bot Manager. It loads the Signin page, submits the credentials,
 * lets the SPA complete the OAuth + JWT exchange in-browser, then harvests the
 * ordercapture JWT (from the `loginWithIdamAccessToken` response) and the
 * session cookies. Those cookies authenticate all later data/cart calls made by
 * the lightweight client.
 *
 * Playwright is imported lazily so it is only required at login time.
 */
export function browserSessionProvider(opts: BrowserLoginOptions = {}): SessionProvider {
  return async (creds: Credentials): Promise<ProvidedSession> => {
    const { chromium } = await loadPlaywright();
    const timeout = opts.timeoutMs ?? 60_000;
    const browser = await chromium.launch({
      headless: opts.headless ?? true,
      channel: opts.channel,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const ctx = await browser.newContext({
        locale: "pl-PL",
        userAgent: opts.userAgent ?? DEFAULT_UA,
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(timeout);

      // Capture the ordercapture JWT the SPA receives after login.
      let jwt: string | null = null;
      page.on("response", async (res) => {
        if (jwt || !res.url().includes("loginWithIdamAccessToken")) return;
        try {
          jwt = (await res.json())?.JWT ?? null;
        } catch {
          /* ignore non-JSON */
        }
      });

      const signinUrl = buildSigninUrl({
        userId: creds.userId,
        password: creds.password,
        codeChallenge: pkcePair().challenge,
        state: randomBytes(16).toString("hex"),
        redirectUri: REDIRECT_URI,
      });

      await page.goto(signinUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#user_id", { state: "visible" });
      await page.fill("#user_id", creds.userId);
      await page.fill("#password", creds.password);
      await page.click("#submit");

      await page
        .waitForResponse((r) => r.url().includes("loginWithIdamAccessToken") && r.status() === 200, { timeout })
        .catch(() => undefined);
      // Let the response handler parse the body.
      await page.waitForTimeout(500);

      if (!jwt) {
        const err = await detectLoginError(page);
        throw new AuthError(
          err ?? "Browser login did not produce a session (wrong credentials, captcha, or a changed login form).",
        );
      }

      const cookies: HarvestedCookie[] = (await ctx.cookies())
        .filter((c) => c.domain.includes("makro"))
        .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));

      return { jwt, cookies };
    } finally {
      await browser.close();
    }
  };
}

/** Best-effort extraction of a visible login error message. */
async function detectLoginError(page: import("playwright").Page): Promise<string | null> {
  for (const sel of ['[class*="error" i]', '[role="alert"]', ".alert", "#error"]) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && (await el.isVisible())) {
        const t = (await el.innerText()).trim();
        if (t) return `Login error: ${t.slice(0, 200)}`;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function loadPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch {
    throw new AuthError(
      "Playwright is required for browser login but is not installed. Run `npm i playwright && npx playwright install chromium`.",
    );
  }
}
