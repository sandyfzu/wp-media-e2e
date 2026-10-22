import { expect } from "@playwright/test";
import type { Dialog, Locator, Page, Response } from "@playwright/test";

import {
  PluginActivationFailedError,
  PluginDeactivationFailedError,
  PluginDeletionFailedError,
  PluginNotInstalledError,
} from "../wp/errors";

/**
 * Page object for the WordPress Plugins admin screen (`wp-admin/plugins.php`).
 *
 * Install state is detected by element COUNT, not `isVisible()` (which cannot tell an absent
 * plugin from an off-screen one). Selectors use WordPress's per-row action-link ids —
 * `#activate-<slug>` / `#deactivate-<slug>` / `#delete-<slug>` — verified against a live
 * wp-admin.
 *
 * Navigation is the caller's responsibility (`goto`), so the object works against any rendered DOM.
 */
export class PluginsPage {
  constructor(private readonly page: Page) {}

  /** Navigate to the Plugins admin screen. */
  async goto(): Promise<void> {
    await this.page.goto("/wp-admin/plugins.php");
  }

  /** True if the plugin is installed (its activate/deactivate action link is present). Count-based. */
  async isInstalled(slug: string): Promise<boolean> {
    return (await this.actionLinks(slug).count()) > 0;
  }

  /** True if the plugin is installed AND active (WordPress shows a Deactivate action). */
  async isActive(slug: string): Promise<boolean> {
    return (await this.page.locator(`#deactivate-${slug}`).count()) > 0;
  }

  /**
   * Activates the plugin. No-op if already active.
   * Activate/Deactivate are regular navigations (not AJAX), so a successful click reloads the
   * page; the expected action link appearing afterwards confirms the outcome.
   *
   * @throws {@link PluginNotInstalledError} if the plugin is absent.
   * @throws {@link PluginActivationFailedError} if the Deactivate link never appears after the click.
   */
  async activate(
    slug: string,
    options: { timeout?: number } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? 15_000;
    if (!(await this.isInstalled(slug)))
      throw new PluginNotInstalledError(slug);
    if (await this.isActive(slug)) return;
    await this.page.locator(`#activate-${slug}`).click();
    try {
      await expect(this.page.locator(`#deactivate-${slug}`)).toBeVisible({
        timeout,
      });
    } catch {
      throw new PluginActivationFailedError(slug);
    }
  }

  /**
   * Deactivates the plugin. No-op if already inactive.
   *
   * @throws {@link PluginNotInstalledError} if the plugin is absent.
   * @throws {@link PluginDeactivationFailedError} if the Activate link never appears after the click.
   */
  async deactivate(
    slug: string,
    options: { timeout?: number } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? 15_000;
    if (!(await this.isInstalled(slug)))
      throw new PluginNotInstalledError(slug);
    if (!(await this.isActive(slug))) return;
    await this.page.locator(`#deactivate-${slug}`).click();
    try {
      await expect(this.page.locator(`#activate-${slug}`)).toBeVisible({
        timeout,
      });
    } catch {
      throw new PluginDeactivationFailedError(slug);
    }
  }

  /**
   * Deletes the plugin through the admin UI — the asserted, user-facing flow. Deactivates first
   * if needed (WordPress only offers Delete for inactive plugins), then triggers the Delete
   * action and confirms the result.
   *
   * WordPress deletes via an AJAX call (`wp.updates` → `admin-ajax.php?action=delete-plugin`),
   * guarded by a native `confirm()` dialog — not a navigation. Details, all verified against a
   * live wp-admin, drive this implementation:
   *  - the `confirm()` is accepted by a dialog handler that is removed in a `finally`, so it can
   *    never linger to auto-accept an unrelated later dialog if the click fires no confirm;
   *  - the Delete click is **not** forced. It used to be, to dodge a stall on the plugins screen
   *    right after an in-session deactivate, and that is precisely what broke it: measured on a
   *    live cell, `elementFromPoint` at the link's own bounding-box centre returned the document
   *    root while the link reported `visibility: visible`, so the forced click — which skips the
   *    "receives pointer events" check — landed on nothing and produced no request at all. The
   *    ordinary click waits for that check to pass and then works first time, dialog and AJAX
   *    included. A stall now fails with Playwright's actionability log, which says what the
   *    element was doing; "no response arrived" never could;
   *  - the slug-specific `delete-plugin` response is awaited: its arrival proves the request was
   *    issued (a missing one ⇒ failure) and stops the reload below from racing the in-flight AJAX.
   *    **Its answer is read** ({@link deletionAnswerProblem}): WordPress removes a plugin entry by
   *    entry, so a deletion it could not finish answers `success: false` with "Could not fully
   *    remove the plugin(s) …", and a request killed mid-way (a PHP-FPM restart) answers with a
   *    gateway's error page — while either can leave the row gone from the screen. Success is then
   *    asserted after a reload (WordPress's in-place row removal does not reliably fire under
   *    automation), by requiring the plugin's action links to be gone. Whether anything is left at
   *    the plugin's path is the site's to answer, not this screen's.
   *
   * @throws {@link PluginNotInstalledError} if the plugin is absent before deletion.
   * @throws {@link PluginDeactivationFailedError} if an active plugin cannot be deactivated first.
   * @throws {@link PluginDeletionFailedError} if the deletion request never lands, WordPress answers
   *   that it failed, or the plugin is still present after `timeout` ms.
   */
  async delete(
    slug: string,
    options: { timeout?: number } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? 15_000;

    if (!(await this.isInstalled(slug))) {
      throw new PluginNotInstalledError(slug);
    }

    // WordPress only offers Delete for inactive plugins, so deactivate first if needed.
    if (await this.isActive(slug)) {
      try {
        await this.page.locator(`#deactivate-${slug}`).click();
        await expect(this.page.locator(`#delete-${slug}`)).toBeVisible({
          timeout,
        });
        // The link being *present* is not the same as Delete being wired up. WordPress binds the
        // action in `updates.js` on document-ready, so a click landing before that script has run
        // follows the link's plain `href` instead — a navigation to the "are you sure" screen, on
        // which the AJAX barrier below waits out its timeout and reports a deletion that never
        // failed so much as never happened. Waiting for `load` means the scripts have executed.
        // Ordered *after* the visibility assertion on purpose: that assertion is what proves the
        // new document is the current one, so this cannot resolve against the old page's load
        // state. `load` is a real event, not the `networkidle` heuristic the lint gate rightly
        // bans, and it takes the caller's budget like every other wait in this method — its own
        // default is the navigation timeout, which has nothing to do with what was asked for.
        await this.page.waitForLoadState("load", { timeout });
      } catch {
        throw new PluginDeactivationFailedError(slug);
      }
    }

    // Accept the confirm() the Delete click raises; remove the handler afterwards so it
    // can't outlive this call.
    const acceptDialog = (dialog: Dialog): void => {
      void dialog.accept();
    };
    this.page.on("dialog", acceptDialog);
    try {
      // Trigger the delete and wait for ITS AJAX request to land, so the reload below cannot
      // race the in-flight call. A missing response (timeout) is a deletion failure.
      let answer: Response;
      try {
        [answer] = await Promise.all([
          this.page.waitForResponse(
            (response) => {
              const body = response.request().postData();
              if (body === null) return false;
              // Parse the form body for an EXACT slug match — a substring check on
              // `slug=<slug>` would also match a longer slug sharing the prefix
              // (e.g. "backwpup" matching a "backwpup-pro" deletion).
              const params = new URLSearchParams(body);
              return (
                params.get("action") === "delete-plugin" &&
                params.get("slug") === slug
              );
            },
            { timeout },
          ),
          this.page.locator(`#delete-${slug}`).click({ timeout }),
        ]);
      } catch {
        throw new PluginDeletionFailedError(slug);
      }
      const problem = deletionAnswerProblem(
        answer.status(),
        await answer.text().catch(() => undefined),
      );
      if (problem !== undefined) {
        throw new PluginDeletionFailedError(slug, problem);
      }

      // Confirm authoritatively against reloaded, server-backed DOM.
      await this.page.reload();
      try {
        await expect(this.actionLinks(slug)).toHaveCount(0, { timeout });
      } catch {
        throw new PluginDeletionFailedError(slug);
      }
    } finally {
      this.page.off("dialog", acceptDialog);
    }
  }

  /**
   * Deletes the plugin if it is installed; no-op if already absent.
   * Throws only if the plugin is present but the deletion process fails.
   */
  async ensureAbsent(
    slug: string,
    options: { timeout?: number } = {},
  ): Promise<void> {
    if (!(await this.isInstalled(slug))) return;
    await this.delete(slug, options);
  }

  /** The plugin's Activate/Deactivate action link(s) — present iff the plugin is installed. */
  private actionLinks(slug: string): Locator {
    return this.page.locator(`#activate-${slug}, #deactivate-${slug}`);
  }
}

/**
 * What is wrong with WordPress's answer to a `delete-plugin` request, or `undefined` when it reports
 * success.
 *
 * `wp_ajax_delete_plugin` answers `{"success":true,…}`, or `{"success":false,"data":{…,"errorMessage":
 * "…"}}` — in its own words, which are what an operator needs. Anything else is no answer from
 * WordPress at all: a request killed part-way comes back as the web server's error page.
 *
 * @param status - the response's HTTP status.
 * @param body - its body, or `undefined` when it could not be read.
 */
export function deletionAnswerProblem(
  status: number,
  body: string | undefined,
): string | undefined {
  let answer: unknown;
  try {
    answer = body === undefined ? undefined : JSON.parse(body);
  } catch {
    answer = undefined;
  }
  if (typeof answer !== "object" || answer === null || !("success" in answer)) {
    return (
      `the delete-plugin request answered HTTP ${String(status)} with no answer from WordPress` +
      (body === undefined
        ? " (its body could not be read)"
        : `: ${oneLine(body)}`)
    );
  }
  if (answer.success === true) return undefined;
  const data = "data" in answer ? answer.data : undefined;
  const message =
    typeof data === "object" &&
    data !== null &&
    "errorMessage" in data &&
    typeof data.errorMessage === "string"
      ? data.errorMessage
      : "WordPress gave no reason";
  return `WordPress answered: ${message}`;
}

/** A response body cut to one short line, so an HTML error page cannot flood a report. */
function oneLine(body: string): string {
  const flat = body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "") return "(empty body)";
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
