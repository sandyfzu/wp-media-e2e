import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { loginViaUi } from "./login";

/**
 * Exercises {@link loginViaUi} against a fully mocked WordPress (via `page.route`) — no server,
 * no database — so the login state machine is tested deterministically: the success redirect, the
 * periodic admin-email interstitial, rejected credentials, and a login that never settles. Mirrors
 * the project's "no external environment" unit-test approach (stub `wp` / `setContent` fixtures).
 */

// A relative baseURL is required because loginViaUi navigates to "/wp-login.php"; every request is
// intercepted, so the host never has to resolve.
test.use({ baseURL: "http://wp.test" });

const CREDENTIALS = { username: "admin", password: "correct horse" } as const;

/**
 * Script that re-focuses the username field on a short timer — what WordPress's own login page does
 * inline, and what login-hardening plugins do on later events. Injected to reproduce the focus race
 * that misdirects `fill()`: it inserts text into whatever is focused at that instant, so a re-focus
 * landing mid-fill sends the password into the username box.
 */
const REFOCUS_SCRIPT = `<script>
  setInterval(function () { document.getElementById('user_login').focus(); }, 3);
</script>`;

/** The wp-login.php form: labelled fields + a "Log In" submit button that POSTs back to itself. */
function loginPage(errorHtml = "", extraHtml = ""): string {
  return `<!doctype html><html><body>
    <form name="loginform" action="/wp-login.php" method="post">
      <p><label for="user_login">Username or Email Address</label>
        <input type="text" id="user_login" name="log" /></p>
      <p><label for="user_pass">Password</label>
        <input type="password" id="user_pass" name="pwd" /></p>
      <button type="submit" id="wp-submit">Log In</button>
    </form>
    ${errorHtml}
    ${extraHtml}
  </body></html>`;
}

/** The "Administration email verification" interstitial, with the "Remind me later" escape hatch. */
function interstitialPage(): string {
  return `<!doctype html><html><body>
    <h1>Administration email verification</h1>
    <a href="/wp-admin/" class="admin-email__later">Remind me later</a>
  </body></html>`;
}

const DASHBOARD = `<!doctype html><html><body><h1>Dashboard</h1></body></html>`;

/**
 * Script that makes the password field impossible to fill: it clears itself on every `input`
 * event. Models the unrecoverable end of the focus race, so the failure message can be asserted.
 */
const REJECT_INPUT_SCRIPT = `<script>
  document.getElementById('user_pass')
    .addEventListener('input', function () { this.value = ''; });
</script>`;

/** What the mocked wp-login.php does with the POST'd credentials. */
type PostOutcome =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "stuck" }
  /** Redirect to wp-admin only if the POST actually carried the right credentials. */
  | { readonly kind: "verify" };

/** Whether a wp-login.php POST body carries exactly the expected credentials. */
function postedCorrectCredentials(body: string | null): boolean {
  const posted = new URLSearchParams(body ?? "");
  return (
    posted.get("log") === CREDENTIALS.username &&
    posted.get("pwd") === CREDENTIALS.password
  );
}

/**
 * Routes wp-admin to a dashboard and wp-login.php to the form (GET) / the given outcome (POST).
 * The interstitial is served when a GET carries `action=confirm_admin_email`.
 *
 * @param script - extra markup to inject into the login form (e.g. {@link REFOCUS_SCRIPT}).
 */
async function mockWordPress(
  page: Page,
  onPost: PostOutcome,
  script = "",
): Promise<void> {
  const form = (errorHtml = ""): string => loginPage(errorHtml, script);
  await page.route(/\/wp-admin\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: DASHBOARD }),
  );
  await page.route(/\/wp-login\.php/, async (route) => {
    if (route.request().method() === "POST") {
      if (onPost.kind === "verify") {
        // The decisive check: what actually reached the server, not what the page showed.
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: postedCorrectCredentials(route.request().postData())
            ? `<!doctype html><html><body><script>location.replace("http://wp.test/wp-admin/")</script></body></html>`
            : form(
                `<div id="login_error"><p>The password you entered for the username admin is incorrect.</p></div>`,
              ),
        });
        return;
      }
      if (onPost.kind === "redirect") {
        // Model WordPress's post-login redirect with a client-side navigation. A synthetic HTTP
        // 302 via route.fulfill() is not reliably followed as a document navigation across
        // Playwright versions, and what this suite verifies is loginViaUi's handling of where the
        // URL *lands*, not the redirect's wire mechanics.
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body><script>location.replace(${JSON.stringify(onPost.location)})</script></body></html>`,
        });
      } else if (onPost.kind === "error") {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: form(`<div id="login_error"><p>${onPost.message}</p></div>`),
        });
      } else {
        // "stuck": accept the POST but stay on a plain login page — never a terminal state.
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: form(),
        });
      }
      return;
    }
    const isInterstitial =
      new URL(route.request().url()).searchParams.get("action") ===
      "confirm_admin_email";
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: isInterstitial ? interstitialPage() : form(),
    });
  });
}

test.describe("loginViaUi", () => {
  test("reaches wp-admin on a successful login", async ({ page }) => {
    await mockWordPress(page, {
      kind: "redirect",
      location: "http://wp.test/wp-admin/",
    });
    await expect(loginViaUi(page, CREDENTIALS)).resolves.toBeUndefined();
    await expect(page).toHaveURL(/\/wp-admin\//);
  });

  test("dismisses the admin-email interstitial and continues to wp-admin", async ({
    page,
  }) => {
    await mockWordPress(page, {
      kind: "redirect",
      location: "http://wp.test/wp-login.php?action=confirm_admin_email",
    });
    await expect(loginViaUi(page, CREDENTIALS)).resolves.toBeUndefined();
    await expect(page).toHaveURL(/\/wp-admin\//);
  });

  test("fails fast with WordPress's own reason on rejected credentials", async ({
    page,
  }) => {
    await mockWordPress(page, {
      kind: "error",
      message: "The password you entered for the username admin is incorrect.",
    });
    // Short timeout: a fast-fail must not depend on waiting the settle budget out.
    await expect(
      loginViaUi(page, CREDENTIALS, { timeoutMs: 5_000 }),
    ).rejects.toThrow(/rejected the credentials: .*password.*incorrect/i);
  });

  test("times out instead of falsely resolving when login never settles", async ({
    page,
  }) => {
    await mockWordPress(page, { kind: "stuck" });
    await expect(
      loginViaUi(page, CREDENTIALS, { timeoutMs: 1_500 }),
    ).rejects.toThrow();
  });

  test("submits the right credentials even when the page steals focus mid-fill", async ({
    page,
  }) => {
    // The regression this guards. `fill()` writes into whatever is focused at that instant, so a
    // login page that re-focuses the username field diverted the password into it and submitted an
    // empty one — surfacing much later as "login never settled", nowhere near the cause. Asserted
    // on what reaches the *server*, which is the only thing that decides whether login works.
    await mockWordPress(page, { kind: "verify" }, REFOCUS_SCRIPT);
    await expect(loginViaUi(page, CREDENTIALS)).resolves.toBeUndefined();
    await expect(page).toHaveURL(/\/wp-admin\//);
  });

  test("names the field, and never leaks the password, when a value will not stick", async ({
    page,
  }) => {
    // The unrecoverable end of that race: the password field can never hold a value. The failure
    // must say so plainly rather than time out on a symptom — and must not quote the secret, which
    // is why the check compares in code instead of using `toHaveValue`.
    await mockWordPress(page, { kind: "stuck" }, REJECT_INPUT_SCRIPT);

    const failure = await loginViaUi(page, CREDENTIALS, {
      timeoutMs: 2_000,
    }).catch((error: unknown) => error);

    expect(String(failure)).toMatch(/password field did not keep its value/);
    expect(String(failure)).not.toContain(CREDENTIALS.password);
  });
});
