import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Logs a WordPress user into the wp-admin UI. Shared by the auth setup project (which
 * persists the resulting session to `storageState`) and the standalone healthcheck
 * script (which logs in only to prove the credentials/UI work, then discards the
 * session). Navigates relative to the page's configured `baseURL`.
 *
 * Throws (via `expect`) if the session does not land on wp-admin.
 */
export async function loginViaUi(
  page: Page,
  credentials: { readonly username: string; readonly password: string },
): Promise<void> {
  await page.goto("/wp-login.php");
  await page.getByLabel("Username or Email Address").fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Log In" }).click();

  // After login WordPress lands on the dashboard or, periodically, the
  // "Administration email verification" interstitial. The Log In click waits for
  // that navigation, so the URL here is settled — dismiss the interstitial if shown.
  if (page.url().includes("action=confirm_admin_email")) {
    await page.getByRole("link", { name: /remind me later/i }).click();
  }
  await expect(page).toHaveURL(/\/wp-admin\/?/);
}
