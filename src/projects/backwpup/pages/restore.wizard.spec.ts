import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FreeRestorePage, ProRestorePage, wizardStep } from "./restore.page";
import type { Page, Route } from "@playwright/test";

/**
 * The restore wizard's page object against the wizard's own markup, captured live step by step
 * (`npm run fixtures:capture`, its restore phase).
 *
 * Each step is a page load of its own, `location.replace()`d by the wizard's scripts once the step
 * is done. The captured markup carries those scripts' own wiring — every button names the step it
 * leads to in `data-next-step` — so a few lines injected here follow it the way `controller.js`
 * does, which drives the page object through the real buttons, by the real roles, to the real end
 * screen. What the plugin does *between* the steps (unpacking, restoring) is the live scenarios'
 * business; how a failure there surfaces is simulated below, one way at a time.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const step = (n: number): string =>
  readFileSync(join(FIXTURES, `restore-step${String(n)}.html`), "utf8");

const ORIGIN = "http://bwp.test";
const WIZARD = `${ORIGIN}/wp-admin/admin.php?page=backwpuprestore`;

/**
 * Follows a button's `data-next-step`, as the wizard's scripts do; "Start" (which has none) goes to
 * the last step. A test can replace what "Start" does to simulate a failure.
 *
 * The navigation comes a moment after the click, as the wizard's does after its AJAX round trip — so
 * a page object that read the step before the wizard moved would act on the old one. Every click is
 * recorded in `sessionStorage`, across the steps, so a test can say which buttons were pressed.
 */
const FOLLOW = `<script>
document.addEventListener('click', function (event) {
  var button = event.target.closest('button');
  if (!button) { return; }
  event.preventDefault();
  var clicked = JSON.parse(sessionStorage.getItem('clicked') || '[]');
  clicked.push(button.textContent.trim());
  sessionStorage.setItem('clicked', JSON.stringify(clicked));
  var next = button.getAttribute('data-next-step') || (button.id === 'start-restore' ? '6' : '');
  if (window.__onStart && button.id === 'start-restore') { window.__onStart(); return; }
  if (next) {
    setTimeout(function () {
      location.replace(location.pathname + '?step=' + next + '&page=backwpuprestore');
    }, 300);
  }
});
</script>`;

/** The buttons pressed so far, in order. */
async function clicked(page: Page): Promise<string[]> {
  return page.evaluate(
    () => JSON.parse(sessionStorage.getItem("clicked") ?? "[]") as string[],
  );
}

/** Wraps captured markup the way the restore screen does, so the page object's anchors resolve. */
function screen(body: string, extra = ""): string {
  return `<!doctype html><html><body><div class="wrap" id="backwpup-page"><h1>BackWPup Pro › Restore</h1>${body}</div>${FOLLOW}${extra}</body></html>`;
}

/** How {@link serveWizard} answers, where a test needs something other than the captured wizard. */
interface WizardOptions {
  /** A script for step 5, typically defining `window.__onStart`. */
  readonly start?: string;
  /** Step 1's body, in place of a bare step container. */
  readonly step1?: string;
  /** Step 2's body, in place of the capture. */
  readonly step2?: string;
  /** Step 4's body, in place of the capture. */
  readonly step4?: string;
  /** Step 6's body, in place of the capture. */
  readonly step6?: string;
  /** How admin-ajax answers; an HTML error page unless given. */
  readonly ajax?: (url: URL) => {
    readonly contentType: string;
    readonly body: string;
  };
}

/** Serves the wizard: each `step` from its capture, step 1 as a bare step container. */
async function serveWizard(
  page: Page,
  options: WizardOptions = {},
): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/wp-login.php")) {
      await route.fulfill({ contentType: "text/html", body: "<p>Log in</p>" });
      return;
    }
    if (url.pathname.endsWith("/admin-ajax.php")) {
      await route.fulfill(
        options.ajax?.(url) ?? {
          contentType: "text/html",
          body: "<p>There has been a critical error on this website.</p>",
        },
      );
      return;
    }
    if (url.pathname.endsWith(".js")) {
      await route.fulfill({
        contentType: "text/javascript",
        body: "throw new TypeError('the script failed');",
      });
      return;
    }
    const n = Number(url.searchParams.get("step") ?? "1");
    const body =
      n === 1
        ? (options.step1 ?? '<div id="restore_step"></div>')
        : n === 2
          ? (options.step2 ?? step(2))
          : n === 4
            ? (options.step4 ?? step(4))
            : n === 6
              ? (options.step6 ?? step(6))
              : step(n);
    await route.fulfill({
      contentType: "text/html",
      body: screen(body, n === 5 ? (options.start ?? "") : ""),
    });
  });
}

/** A step-5 script making "Start" run `body` instead of moving on. */
function onStart(body: string): string {
  return `<script>window.__onStart = function () { ${body} };</script>`;
}

/** Lands on step 2, as the wizard does once the archive is unpacked. */
async function atStrategyChoice(page: Page): Promise<ProRestorePage> {
  await page.goto(`${WIZARD}&step=2`);
  return new ProRestorePage(page);
}

test.describe("wizardStep", () => {
  test("reads the step a wizard URL names", () => {
    expect(wizardStep(`${WIZARD}&step=3`)).toBe(3);
    expect(
      wizardStep(`${ORIGIN}/wp-admin/admin.php?step=6&page=backwpuprestore`),
    ).toBe(6);
  });

  test("names none for the bare screen, anything that is not a step, or another page", () => {
    expect(wizardStep(WIZARD)).toBeUndefined();
    expect(wizardStep(`${WIZARD}&step=7`)).toBeUndefined();
    expect(wizardStep(`${WIZARD}&step=2a`)).toBeUndefined();
    expect(
      wizardStep(`${ORIGIN}/wp-admin/admin.php?page=backwpupbackups&step=6`),
    ).toBeUndefined();
  });
});

test.describe("Restore wizard — locator contract", () => {
  test("step 2 offers the three strategies, in screen order, by the class its script binds", async ({
    page,
  }) => {
    await page.setContent(screen(step(2)));
    await expect(
      page.locator("#restore_step .restore-select-strategy"),
    ).toHaveText(["Full Restore", "Database Only", "Files Only"]);
    for (const name of ["Full Restore", "Database Only", "Files Only"]) {
      await expect(
        page
          .locator("#restore_step")
          .getByRole("button", { name, exact: true }),
      ).toHaveCount(1);
    }
  });

  test("step 3's Continue is the database form's, and the connection values are not in the capture", async ({
    page,
  }) => {
    await page.setContent(screen(step(3)));
    await expect(
      page
        .locator("#db-settings-form")
        .getByRole("button", { name: "Continue", exact: true }),
    ).toHaveCount(1);
    for (const field of ["#db_host", "#db_name", "#db_user", "#db_pw"]) {
      await expect(page.locator(field)).toHaveAttribute("value", "REDACTED");
    }
  });

  test("step 4's Continue is the migration form's, and migrating is off", async ({
    page,
  }) => {
    await page.setContent(screen(step(4)));
    await expect(
      page
        .locator("#migration-settings-form")
        .getByRole("button", { name: "Continue", exact: true }),
    ).toHaveCount(1);
    await expect(page.locator("#do-migrate")).not.toBeChecked();
  });

  test("step 5 has the Start button, and the last step says Success", async ({
    page,
  }) => {
    await page.setContent(screen(step(5)));
    await expect(
      page
        .locator("#restore_step")
        .getByRole("button", { name: "Start", exact: true }),
    ).toHaveCount(1);
    await page.setContent(screen(step(6)));
    await expect(
      page.getByRole("heading", { name: "Success", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Restore Report", exact: true }),
    ).toHaveCount(0);
  });
});

test.describe("Restore wizard — driving it", () => {
  test("reads the strategies offered and remembers them", async ({ page }) => {
    await serveWizard(page);
    const restore = await atStrategyChoice(page);
    expect(restore.offered).toEqual([]);
    expect(await restore.strategiesOffered()).toEqual([
      "Full Restore",
      "Database Only",
      "Files Only",
    ]);
    expect(restore.offered).toEqual([
      "Full Restore",
      "Database Only",
      "Files Only",
    ]);
  });

  test("waits on the unpacking until the strategy step comes", async ({
    page,
  }) => {
    await serveWizard(page);
    await page.goto(WIZARD);
    const restore = new ProRestorePage(page);
    const offered = restore.strategiesOffered();
    await page.evaluate(() => {
      setTimeout(() => {
        location.replace(`${location.pathname}?step=2&page=backwpuprestore`);
      }, 300);
    });
    expect(await offered).toHaveLength(3);
  });

  // A database restore goes through every step: the connection, the migration, the start — pressing
  // the strategy asked for, and each step's button once, though each step moves on a moment late.
  for (const strategy of ["Database Only", "Full Restore"] as const) {
    test(`chooses ${strategy} and goes through every step to the success screen`, async ({
      page,
    }) => {
      await serveWizard(page);
      const restore = await atStrategyChoice(page);
      await restore.strategiesOffered();
      await restore.restoreWith(strategy);
      expect(wizardStep(page.url())).toBe(6);
      expect(await clicked(page)).toEqual([
        strategy,
        "Continue",
        "Continue",
        "Start",
      ]);
    });
  }

  // Files Only skips straight to the start, as its button says.
  test("follows a strategy that skips the in-between steps", async ({
    page,
  }) => {
    await serveWizard(page);
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await restore.restoreWith("Files Only");
    expect(wizardStep(page.url())).toBe(6);
    expect(await clicked(page)).toEqual(["Files Only", "Start"]);
  });

  // The last moment the site is as it was: on the start step, before "Start" is pressed.
  test("runs what it is given just before pressing Start", async ({ page }) => {
    await serveWizard(page);
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    const seen: { step: number | undefined; pressed: string[] }[] = [];
    await restore.restoreWith("Database Only", async () => {
      seen.push({ step: wizardStep(page.url()), pressed: await clicked(page) });
    });
    expect(seen).toEqual([
      { step: 5, pressed: ["Database Only", "Continue", "Continue"] },
    ]);
  });

  test("gives up on a wizard that keeps coming back instead of reaching the start", async ({
    page,
  }) => {
    await serveWizard(page, {
      step4: step(4).replace('data-next-step="5"', 'data-next-step="3"'),
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /still at step 3 after two steps past the strategy choice/,
    );
  });

  test("fails with what the strategy step says when it offers none", async ({
    page,
  }) => {
    await serveWizard(page, {
      step2:
        '<div id="restore_step"><p>The archive could not be read.</p></div>',
    });
    const restore = await atStrategyChoice(page);
    await expect(restore.strategiesOffered()).rejects.toThrow(
      /offered no restore strategy: The archive could not be read\./,
    );
  });

  test("refuses a strategy the wizard did not offer, saying what it did", async ({
    page,
  }) => {
    await page.setContent(screen(step(2)));
    const restore = new ProRestorePage(page);
    await expect(restore.restoreWith("Full Restore")).rejects.toThrow(
      /offered nothing yet/,
    );
  });

  test("fails with the wizard's own error line, not a timeout", async ({
    page,
  }) => {
    await serveWizard(page, {
      start: `<script>window.__onStart = function () {
        var p = document.createElement('p');
        p.id = 'bwu_response'; p.className = 'response response-error';
        p.textContent = 'Could not restore the database.';
        document.querySelector('#restore_step').appendChild(p);
      };</script>`,
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /reported an error while trying to restore the archive: Could not restore the database\./,
    );
  });

  // A stream that failed before it began answers with an error page — and the browser's EventSource
  // then closes for good, so nothing on screen ever changes.
  test("fails when a step's stream answers with an error page", async ({
    page,
  }) => {
    await serveWizard(page, {
      start: onStart(
        "fetch('/wp-admin/admin-ajax.php?action=restore_dir&context=event_source&controller=job');",
      ),
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /while trying to restore the archive, the "restore_dir" stream answered 200 text\/html.* instead of an event stream/,
    );
  });

  // A stream PHP failed in after its headers went out is a healthy-looking stream that ends — and the
  // browser reconnects it, re-running the action, for ever.
  test("fails when a step's stream is opened again on the same page", async ({
    page,
  }) => {
    await serveWizard(page, {
      ajax: () => ({ contentType: "text/event-stream", body: "" }),
      start: onStart(
        "var u = '/wp-admin/admin-ajax.php?action=restore_db&context=event_source&controller=job'; " +
          "fetch(u).then(function () { fetch(u); });",
      ),
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /the "restore_db" stream was opened again on the same page/,
    );
  });

  // Pro's first stream opens as step 1 loads — before anything waits for step 2 — so a failure there
  // must still fail that wait, at once rather than when its budget runs out.
  test("fails a wait at once for a stream that failed before it began", async ({
    page,
  }) => {
    await serveWizard(page, {
      step1:
        '<div id="restore_step"></div><script>fetch("/wp-admin/admin-ajax.php?action=download&context=event_source");</script>',
    });
    const restore = new ProRestorePage(page);
    const answered = page.waitForResponse(/action=download/);
    await page.goto(WIZARD);
    await answered;
    const started = Date.now();
    await expect(restore.strategiesOffered()).rejects.toThrow(
      /while trying to unpack the archive, the "download" stream answered 200 text\/html/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("fails when one of the wizard's calls answers with an error page", async ({
    page,
  }) => {
    await serveWizard(page, {
      start: onStart(
        "fetch('/wp-admin/admin-ajax.php', { method: 'POST', headers: { 'Content-Type': " +
          "'application/x-www-form-urlencoded; charset=UTF-8' }, body: 'controller=job&action=get_strategy' });",
      ),
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /the wizard's "get_strategy" call answered with text\/html.* instead of JSON/,
    );
  });

  test("fails when one of the wizard's calls answers success: false", async ({
    page,
  }) => {
    await serveWizard(page, {
      ajax: () => ({
        contentType: "application/json; charset=UTF-8",
        body: '{"success":false,"data":{"state":"error","message":"No connection"}}',
      }),
      start: onStart(
        "fetch('/wp-admin/admin-ajax.php', { method: 'POST', headers: { 'Content-Type': " +
          "'application/x-www-form-urlencoded; charset=UTF-8' }, body: 'controller=job&action=db_test' });",
      ),
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /"db_test" call answered with success: false \(No connection\)/,
    );
  });

  // WordPress's own traffic on the page is not the wizard's.
  test("ignores the heartbeat and other plugins' scripts failing", async ({
    page,
  }) => {
    await serveWizard(page, {
      start: onStart(
        "fetch('/wp-admin/admin-ajax.php', { method: 'POST', headers: { 'Content-Type': " +
          "'application/x-www-form-urlencoded; charset=UTF-8' }, body: 'action=heartbeat' }); " +
          "var s = document.createElement('script'); s.src = '/wp-content/plugins/other/x.js'; " +
          "document.body.appendChild(s); " +
          "setTimeout(function () { location.replace(location.pathname + '?step=6&page=backwpuprestore'); }, 500);",
      ),
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).resolves.toBeUndefined();
  });

  test("fails when the plugin's own script throws", async ({ page }) => {
    await serveWizard(page, {
      start: onStart(
        "var s = document.createElement('script'); s.src = '/wp-content/plugins/backwpup-pro/x.js'; " +
          "document.body.appendChild(s);",
      ),
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /the plugin's script threw: the script failed/,
    );
  });

  test("fails when the archive asks for a decryption key", async ({ page }) => {
    await serveWizard(page, {
      step1:
        '<div id="restore_step"><div id="decrypt_key"><textarea id="decryption_key"></textarea></div></div>',
    });
    await page.goto(WIZARD);
    await expect(new ProRestorePage(page).strategiesOffered()).rejects.toThrow(
      /asked for a decryption key while trying to unpack the archive/,
    );
  });

  test("fails when the restore ends the admin session", async ({ page }) => {
    await serveWizard(page, {
      start: `<script>window.__onStart = function () {
        location.replace('/wp-login.php?reauth=1');
      };</script>`,
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /admin session ended while trying to restore the archive/,
    );
  });

  test("fails when the last step says neither that it succeeded nor what failed", async ({
    page,
  }) => {
    await serveWizard(page, { step6: '<div id="restore_step"></div>' });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /did not say it succeeded/,
    );
  });

  test("fails when the last step reports errors instead of success", async ({
    page,
  }) => {
    await serveWizard(page, {
      step6:
        '<div class="postbox"><h3 class="hndle"><span>Restore Report</span></h3></div>',
    });
    const restore = await atStrategyChoice(page);
    await restore.strategiesOffered();
    await expect(restore.restoreWith("Database Only")).rejects.toThrow(
      /reported errors on its last step/,
    );
  });
});

test.describe("FreeRestorePage", () => {
  test("is the same wizard after the upload", async ({ page }) => {
    await serveWizard(page);
    await page.goto(`${WIZARD}&step=2`);
    const restore = new FreeRestorePage(page);
    await restore.strategiesOffered();
    await restore.restoreWith("Full Restore");
    expect(wizardStep(page.url())).toBe(6);
  });
});
