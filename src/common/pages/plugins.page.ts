import { expect } from "@playwright/test";
import type { Dialog, Locator, Page } from "@playwright/test";

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
   * @throws PluginNotInstalledError if the plugin is absent.
   * @throws PluginActivationFailedError if the Deactivate link never appears after the click.
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
   * @throws PluginNotInstalledError if the plugin is absent.
   * @throws PluginDeactivationFailedError if the Activate link never appears after the click.
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
   *  - the click uses `force: true` because the normal actionability wait can stall on the
   *    plugins screen right after an in-session deactivate (it is still a real click, and the
   *    page carries no CSS animation that would justify the wait);
   *  - the slug-specific `delete-plugin` response is awaited only as a barrier: its arrival
   *    proves the request was issued (a missing one ⇒ failure) and stops the reload below from
   *    racing the in-flight AJAX — the body is not parsed. Success is then asserted
   *    authoritatively after a reload (WordPress's in-place row removal does not reliably fire
   *    under automation), by requiring the plugin's action links to be gone.
   *
   * @throws PluginNotInstalledError if the plugin is absent before deletion.
   * @throws PluginDeactivationFailedError if an active plugin cannot be deactivated first.
   * @throws PluginDeletionFailedError if the deletion request never lands or the plugin is
   *   still present after `timeout` ms.
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
      try {
        await Promise.all([
          this.page.waitForResponse(
            (response) => {
              const body = response.request().postData() ?? "";
              return (
                body.includes("action=delete-plugin") &&
                body.includes(`slug=${encodeURIComponent(slug)}`)
              );
            },
            { timeout },
          ),
          this.page.locator(`#delete-${slug}`).click({ force: true }),
        ]);
      } catch {
        throw new PluginDeletionFailedError(slug);
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
