import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * WordPress UI login, hardened against the flakiness that made the raw
 * "click then read the URL" flow fail intermittently.
 *
 * Shared by the auth setup project (which persists the resulting session to
 * `storageState`) and the standalone healthcheck (which logs in only to prove the
 * credentials/UI work, then discards the session). Navigates relative to the page's
 * configured `baseURL`.
 */

/** Default cap on how long each post-submit navigation may take to settle (ms). */
const DEFAULT_LOGIN_TIMEOUT_MS = 15_000;

/** Options for {@link loginViaUi}. */
export interface LoginOptions {
  /**
   * Max time (ms) to wait for the login to settle and for wp-admin to be reached.
   * Defaults to {@link DEFAULT_LOGIN_TIMEOUT_MS}. Playwright's own `expect` timeout is
   * only 5s, which is too tight for a slow remote (SSH-hosted) staging box — the
   * healthcheck raises this via `HEALTHCHECK_LOGIN_TIMEOUT_MS`.
   */
  readonly timeoutMs?: number;
}

/**
 * True when `url`'s PATH is under wp-admin. Checked on the pathname, not the whole URL, so a
 * `redirect_to=…%2Fwp-admin%2F` query parameter carried on the login page is never mistaken
 * for having actually reached the dashboard. Also matches sub-directory installs (e.g. Bedrock's
 * `/wp/wp-admin/`).
 */
function isWpAdminUrl(url: string): boolean {
  try {
    return /\/wp-admin(\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * True when the URL is WordPress's post-login "Administration email verification" interstitial.
 * WordPress shows this periodically (not every login) at `wp-login.php?action=confirm_admin_email`
 * before forwarding to the dashboard.
 */
function isAdminEmailInterstitial(url: string): boolean {
  return url.includes("action=confirm_admin_email");
}

/**
 * Logs a WordPress user into wp-admin through the UI, then returns once the dashboard is reached.
 *
 * Robust against the two things that made this flaky:
 *  1. It waits for the submit's POST → redirect chain to actually SETTLE before inspecting the
 *     URL. Reading `page.url()` immediately after the click is racy — the click's auto-wait does
 *     not guarantee the final redirect has landed — which intermittently skipped the interstitial
 *     handling and then failed the URL assertion on a still-`wp-login.php` page.
 *  2. It fast-fails with WordPress's own reason when the credentials are rejected, instead of
 *     silently waiting out the timeout on a URL that will never become wp-admin.
 *
 * @param page - a page in a context whose `baseURL` is the target site.
 * @param credentials - the WordPress username/password to submit.
 * @param options - see {@link LoginOptions}.
 * @throws {@link Error} when the credentials are rejected or wp-admin is never reached.
 */
export async function loginViaUi(
  page: Page,
  credentials: { readonly username: string; readonly password: string },
  options: LoginOptions = {},
): Promise<void> {
  const timeout = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  await page.goto("/wp-login.php");
  await page.getByLabel("Username or Email Address").fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Log In" }).click();

  const loginError = page.locator("#login_error");

  // Wait for the attempt to reach a terminal state. `toPass` retries the whole block — absorbing
  // the transient errors thrown while the redirect chain is mid-flight — until one of the three
  // known outcomes holds (dashboard, interstitial, or a rendered login error) or `timeout` elapses.
  await expect(async () => {
    const settled =
      isWpAdminUrl(page.url()) ||
      isAdminEmailInterstitial(page.url()) ||
      (await loginError.isVisible());
    expect(settled, "login has not settled on a known outcome yet").toBe(true);
  }).toPass({ timeout });

  // Rejected credentials → fail fast with WordPress's own message rather than timing out below.
  if (await loginError.isVisible()) {
    const reason = (await loginError.innerText()).replace(/\s+/g, " ").trim();
    throw new Error(`WordPress rejected the credentials: ${reason}`);
  }

  // Periodic "Administration email verification" interstitial → dismiss it and continue.
  if (isAdminEmailInterstitial(page.url())) {
    await page.getByRole("link", { name: /remind me later/i }).click();
  }

  await expect(page, "login did not reach wp-admin").toHaveURL(
    (url) => isWpAdminUrl(url.href),
    { timeout },
  );
}
