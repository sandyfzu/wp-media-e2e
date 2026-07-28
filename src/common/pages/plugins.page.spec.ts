import { test, expect } from "@playwright/test";

import { PluginsPage } from "./plugins.page";
import {
  PluginDeactivationFailedError,
  PluginNotInstalledError,
} from "../wp/errors";

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
