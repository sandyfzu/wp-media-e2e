import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { PluginsPage, deletionAnswerProblem } from "./plugins.page";
import {
  PluginDeactivationFailedError,
  PluginDeletionFailedError,
  PluginNotInstalledError,
} from "../wp/errors";

/** How the stand-in admin-ajax answers a `delete-plugin` request. */
interface AjaxAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/** What `wp_ajax_delete_plugin` answers when the plugin's files are gone. */
const DELETED: AjaxAnswer = {
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    success: true,
    data: {
      delete: "plugin",
      slug: "demo",
      plugin: "demo/demo.php",
      pluginName: "Demo",
    },
  }),
};

// Fixtures mirroring wp-admin's per-row action-link ids. `active-demo` shows only Deactivate
// (installed + active); `inactive-demo` shows Activate + Delete. The links are inert, so the
// full delete() AJAX flow is covered by live tests — these specs cover detection and the
// guard branches that run BEFORE any AJAX, with no browser environment.
const FIXTURE = `<!doctype html><html><body>
<table class="plugins">
  <tr data-p="active-demo"><td><a id="deactivate-active-demo" href="#">Deactivate</a></td></tr>
  <tr data-p="inactive-demo"><td><a id="activate-inactive-demo" href="#">Activate</a> <a id="delete-inactive-demo" href="#">Delete</a></td></tr>
</table>
</body></html>`;

test.describe("PluginsPage — detection (count-based)", () => {
  test("isInstalled: present (active or inactive) vs absent", async ({
    page,
  }) => {
    await page.setContent(FIXTURE);
    const plugins = new PluginsPage(page);
    expect(await plugins.isInstalled("active-demo")).toBe(true);
    expect(await plugins.isInstalled("inactive-demo")).toBe(true);
    expect(await plugins.isInstalled("ghost")).toBe(false);
  });

  test("isActive: active vs inactive", async ({ page }) => {
    await page.setContent(FIXTURE);
    const plugins = new PluginsPage(page);
    expect(await plugins.isActive("active-demo")).toBe(true);
    expect(await plugins.isActive("inactive-demo")).toBe(false);
  });
});

test.describe("PluginsPage — delete() guards (no AJAX)", () => {
  test("absent plugin throws PluginNotInstalledError before acting", async ({
    page,
  }) => {
    await page.setContent(FIXTURE);
    await expect(new PluginsPage(page).delete("ghost")).rejects.toBeInstanceOf(
      PluginNotInstalledError,
    );
  });

  test("deactivation that never reveals Delete throws PluginDeactivationFailedError", async ({
    page,
  }) => {
    // active-demo's Deactivate link is inert, so #delete-active-demo never appears.
    await page.setContent(FIXTURE);
    await expect(
      new PluginsPage(page).delete("active-demo", { timeout: 1000 }),
    ).rejects.toBeInstanceOf(PluginDeactivationFailedError);
  });
});

/**
 * A stand-in wp-admin: the Delete link behaves as WordPress's does — it raises a `confirm()` and,
 * on acceptance, POSTs `action=delete-plugin` to admin-ajax rather than following its own href.
 *
 * The **overlay** is the point. It covers the link for `coverMs` and then removes itself, standing
 * in for the live plugins screen, where the link reports `visibility: visible` while a hit test at
 * its own bounding-box centre still lands on the document root.
 */
function servedPluginsHtml(gone: boolean, coverMs: number): string {
  if (gone)
    return `<!doctype html><html><body><table class="plugins"></table></body></html>`;
  return `<!doctype html><html><body>
<div id="cover" style="position:fixed;inset:0;z-index:9;background:rgba(0,0,0,.01)"></div>
<table class="plugins">
  <tr data-p="demo"><td><a id="activate-demo" href="#">Activate</a>
  <a id="delete-demo" href="/wp-admin/plugins.php?action=delete-selected">Delete</a></td></tr>
</table>
<script>
  setTimeout(function () { document.getElementById('cover').remove(); }, ${String(coverMs)});
  document.getElementById('delete-demo').addEventListener('click', function (event) {
    event.preventDefault();
    if (!window.confirm('Are you sure you want to delete demo and its data?')) return;
    fetch('/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=delete-plugin&slug=demo',
    });
  });
</script>
</body></html>`;
}

test.describe("PluginsPage — the delete click", () => {
  /**
   * Serves the stand-in screen, flipping to "deleted" once the AJAX has been received — whatever it
   * answers, as a deletion WordPress could not finish can still take the row off the screen.
   */
  async function serve(
    page: Page,
    coverMs: number,
    answer: AjaxAnswer = DELETED,
  ): Promise<void> {
    let gone = false;
    await page.route("**/admin-ajax.php", async (route) => {
      gone = true;
      await route.fulfill(answer);
    });
    await page.route("**/plugins.php*", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: servedPluginsHtml(gone, coverMs),
      });
    });
    await page.goto("http://wp-admin.test/wp-admin/plugins.php");
  }

  /**
   * The regression this pins. The click used to be forced, which skips the "receives pointer
   * events" check — and on a live cell it then landed on the document root and produced no request
   * at all, so the deletion silently never happened. An ordinary click waits the cover out.
   *
   * With `force: true` restored, this test fails: the click hits the overlay, no AJAX is sent, and
   * the barrier times out into `PluginDeletionFailedError`.
   */
  test("waits for the link to be clickable rather than forcing the click through", async ({
    page,
  }) => {
    await serve(page, 1200);
    await new PluginsPage(page).delete("demo", { timeout: 10_000 });
  });

  /**
   * The other half of the same flow: WordPress guards Delete with a native `confirm()`, so a run
   * that dismissed it would never delete anything.
   *
   * The handler must also not outlive the call. Checked by behaviour rather than by counting
   * listeners: Playwright dismisses a dialog automatically when nothing is handling it, so a later
   * `confirm()` coming back `false` is proof that no accept-everything handler was left behind —
   * one that would silently agree to an unrelated prompt in a later step.
   */
  test("accepts the confirmation WordPress raises, and stops listening afterwards", async ({
    page,
  }) => {
    await serve(page, 0);
    await new PluginsPage(page).delete("demo", { timeout: 10_000 });
    expect(await page.evaluate(() => window.confirm("unrelated"))).toBe(false);
  });

  /**
   * WordPress removes a plugin entry by entry and answers `success: false` when it could not finish,
   * in its own words — while the screen, reloaded, may no longer list the half-removed plugin.
   */
  test("fails on WordPress's own refusal, quoting it, though the row is gone", async ({
    page,
  }) => {
    await serve(page, 0, {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        data: {
          delete: "plugin",
          slug: "demo",
          errorCode: "could_not_remove_plugin",
          errorMessage: "Could not fully remove the plugin(s) Demo.",
        },
      }),
    });
    const failure = await new PluginsPage(page)
      .delete("demo", { timeout: 10_000 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginDeletionFailedError);
    expect((failure as Error).message).toContain(
      "WordPress answered: Could not fully remove the plugin(s) Demo.",
    );
  });

  /** A PHP-FPM restart mid-request: the web server answers, WordPress never does. */
  test("fails on a gateway's error page, naming its status", async ({
    page,
  }) => {
    await serve(page, 0, {
      status: 502,
      contentType: "text/html",
      body: "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>",
    });
    await expect(
      new PluginsPage(page).delete("demo", { timeout: 10_000 }),
    ).rejects.toThrow(
      /answered HTTP 502 with no answer from WordPress: 502 Bad Gateway 502 Bad Gateway nginx/,
    );
  });
});

test.describe("deletionAnswerProblem", () => {
  test("accepts WordPress's success", () => {
    expect(deletionAnswerProblem(200, DELETED.body)).toBeUndefined();
  });

  test("quotes WordPress's reason for a failure, or says it gave none", () => {
    expect(
      deletionAnswerProblem(
        200,
        '{"success":false,"data":{"errorMessage":"Plugin file does not exist."}}',
      ),
    ).toBe("WordPress answered: Plugin file does not exist.");
    expect(deletionAnswerProblem(200, '{"success":false}')).toBe(
      "WordPress answered: WordPress gave no reason",
    );
  });

  test("calls anything else no answer from WordPress", () => {
    expect(deletionAnswerProblem(200, "{}")).toBe(
      "the delete-plugin request answered HTTP 200 with no answer from WordPress: {}",
    );
    expect(deletionAnswerProblem(500, "")).toContain("HTTP 500");
    expect(deletionAnswerProblem(200, "0")).toContain("HTTP 200");
    expect(deletionAnswerProblem(200, undefined)).toBe(
      "the delete-plugin request answered HTTP 200 with no answer from WordPress (its body could not be read)",
    );
  });

  // Only WordPress's own `true` is success: `1`, `"true"` or any other truthy value is not its answer.
  test("takes nothing but success: true for success", () => {
    for (const success of ["1", '"true"', '"yes"']) {
      expect(deletionAnswerProblem(200, `{"success":${success}}`)).toBe(
        "WordPress answered: WordPress gave no reason",
      );
    }
  });

  test("gives no reason for an errorMessage that is not text", () => {
    expect(
      deletionAnswerProblem(
        200,
        '{"success":false,"data":{"errorMessage":42}}',
      ),
    ).toBe("WordPress answered: WordPress gave no reason");
    expect(
      deletionAnswerProblem(200, '{"success":false,"data":"Plugin gone"}'),
    ).toBe("WordPress answered: WordPress gave no reason");
  });

  test("says an empty or blank body is empty", () => {
    for (const body of ["", " \n ", "<p> </p>"]) {
      expect(deletionAnswerProblem(502, body)).toBe(
        "the delete-plugin request answered HTTP 502 with no answer from WordPress: (empty body)",
      );
    }
  });

  test("cuts a long error page to one short line", () => {
    const problem = deletionAnswerProblem(502, `<p>${"x ".repeat(500)}</p>`);
    expect(problem?.length).toBeLessThan(300);
    expect(problem).not.toContain("<p>");
  });
});

/**
 * A stand-in wp-admin for the deactivate-then-delete flow, where both halves behave as the real
 * screen does: Deactivate is an ordinary navigation, and the Delete action is wired up by a
 * **blocking external script** — WordPress binds it in `updates.js` on document-ready.
 *
 * That script is the point. The row it acts on is parsed and visible before the script has loaded,
 * so there is a real window in which the link is clickable and does nothing but follow its `href`.
 */
function servedDeactivateFlow(active: boolean, gone: boolean): string {
  if (gone)
    return `<!doctype html><html><body><table class="plugins"></table></body></html>`;
  const row = active
    ? `<tr data-p="demo"><td><a id="deactivate-demo" href="/wp-admin/plugins.php?action=deactivate">Deactivate</a></td></tr>`
    : `<tr data-p="demo"><td><a id="activate-demo" href="#">Activate</a>
  <a id="delete-demo" href="/wp-admin/plugins.php?action=delete-selected">Delete</a></td></tr>`;
  // The script tag sits AFTER the table so the row renders first, exactly as wp-admin's does.
  return `<!doctype html><html><body>
<table class="plugins">${row}</table>
${active ? "" : '<script src="/wp-admin/js/updates.js"></script>'}
</body></html>`;
}

test.describe("PluginsPage — deactivating before the delete", () => {
  /** Serves the flow, holding `updates.js` back by `bindDelayMs` so the binding window is real. */
  async function serve(page: Page, bindDelayMs: number): Promise<void> {
    let active = true;
    let gone = false;
    await page.route("**/js/updates.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, bindDelayMs));
      await route.fulfill({
        contentType: "application/javascript",
        body: `document.getElementById('delete-demo').addEventListener('click', function (event) {
          event.preventDefault();
          if (!window.confirm('Are you sure you want to delete demo and its data?')) return;
          fetch('/wp-admin/admin-ajax.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'action=delete-plugin&slug=demo',
          });
        });`,
      });
    });
    await page.route("**/admin-ajax.php", async (route) => {
      gone = true;
      await route.fulfill(DELETED);
    });
    await page.route("**/plugins.php*", async (route) => {
      if (route.request().url().includes("action=deactivate")) active = false;
      await route.fulfill({
        contentType: "text/html",
        body: servedDeactivateFlow(active, gone),
      });
    });
    await page.goto("http://wp-admin.test/wp-admin/plugins.php");
  }

  /**
   * The second regression in this flow, and an independent one: the Delete link is *present* on the
   * reloaded screen long before it does anything, so a click that only waited for it to be visible
   * followed the plain `href` instead. That navigates to WordPress's "are you sure" screen, issues
   * no AJAX at all, and the barrier then times out reporting a deletion that never happened.
   *
   * Waiting for `load` is what closes that window. Remove that wait and this test fails: the click
   * lands during the 600 ms the handler script is held back, and no request is ever made.
   */
  test("waits for the Delete action to be wired up, not merely rendered", async ({
    page,
  }) => {
    await serve(page, 600);
    await new PluginsPage(page).delete("demo", { timeout: 10_000 });
  });
});
