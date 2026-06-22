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
  /**
   * Path to a Chromium executable. Set this on serverless (Vercel/Lambda) using
   * `@sparticuz/chromium` — e.g. `await chromium.executablePath()`. When set, the
   * provider uses `playwright-core` rather than the bundled Playwright browser.
   */
  executablePath?: string;
  /** Extra launch args, e.g. `chromium.args` from `@sparticuz/chromium`. */
  extraArgs?: string[];
  /**
   * Persist the browser profile to this directory. Keeps Akamai's trust cookies
   * (`_abck`/`bm_sz`) and the device fingerprint across logins, so after one
   * successful login the browser is "known" and later logins face far fewer bot
   * challenges. Recommended for local/long-running use.
   */
  userDataDir?: string;
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
    const launchOpts = {
      headless: opts.headless ?? true,
      channel: opts.channel,
      executablePath: opts.executablePath,
      args: ["--disable-blink-features=AutomationControlled", ...(opts.extraArgs ?? [])],
    };
    const contextOpts = { locale: "pl-PL", userAgent: opts.userAgent ?? DEFAULT_UA };

    // A persistent profile reuses Akamai trust cookies/fingerprint across logins.
    let browser: import("playwright").Browser | null = null;
    let ctx: import("playwright").BrowserContext;
    if (opts.userDataDir) {
      ctx = await chromium.launchPersistentContext(opts.userDataDir, { ...launchOpts, ...contextOpts });
    } else {
      browser = await chromium.launch(launchOpts);
      ctx = await browser.newContext(contextOpts);
    }
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
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

      // Warm up on the shop first (lets Akamai's sensor run, accept cookies) so
      // the login looks like a normal browsing session rather than a cold hit.
      try {
        await page.goto("https://dlagastronomii.makro.pl/", { waitUntil: "domcontentloaded" });
        await dismissCookieBanner(page);
        await page.waitForTimeout(800);
      } catch {
        /* warm-up is best-effort */
      }

      const signinUrl = buildSigninUrl({
        userId: creds.userId,
        password: creds.password,
        codeChallenge: pkcePair().challenge,
        state: randomBytes(16).toString("hex"),
        redirectUri: REDIRECT_URI,
      });

      await page.goto(signinUrl, { waitUntil: "domcontentloaded" });
      await dismissCookieBanner(page);
      await page.waitForSelector("#user_id", { state: "visible" });
      await page.fill("#user_id", creds.userId);
      await page.fill("#password", creds.password);
      // A late cookie banner can intercept the submit click — dismiss, then click.
      await dismissCookieBanner(page);
      await clickSubmit(page);

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
      await ctx.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  };
}

/** Accept a cookie-consent banner if present (best-effort, common frameworks + PL/EN). */
async function dismissCookieBanner(page: import("playwright").Page): Promise<void> {
  const selectors = [
    "#onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "[data-testid*='accept' i]",
    "[id*='accept-all' i]",
    "[class*='accept-all' i]",
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && (await el.isVisible())) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(200);
        return;
      }
    } catch {
      /* ignore */
    }
  }
  for (const re of [/zaakceptuj wszystk/i, /akceptuj/i, /zgadzam si/i, /accept all/i, /accept/i]) {
    try {
      const btn = page.getByRole("button", { name: re }).first();
      if ((await btn.count()) && (await btn.isVisible())) {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(200);
        return;
      }
    } catch {
      /* ignore */
    }
  }
}

/** Click the login button, retrying with force after re-dismissing a late banner. */
async function clickSubmit(page: import("playwright").Page): Promise<void> {
  try {
    await page.click("#submit", { timeout: 5000 });
  } catch {
    await dismissCookieBanner(page);
    await page.click("#submit", { timeout: 5000, force: true });
  }
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
  // Prefer full `playwright` (bundled browser) for local/dev; fall back to
  // `playwright-core` for serverless, where the browser comes from
  // `@sparticuz/chromium` via `executablePath`.
  try {
    return await import("playwright");
  } catch {
    /* try playwright-core next */
  }
  try {
    return (await import("playwright-core" as string)) as typeof import("playwright");
  } catch {
    throw new AuthError(
      "Browser login needs Playwright. Local: `npm i playwright && npx playwright install chromium`. " +
        "Serverless: `npm i playwright-core @sparticuz/chromium` and pass browser.executablePath.",
    );
  }
}
