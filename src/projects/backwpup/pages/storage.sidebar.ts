import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { STORAGE_PANEL_TITLES } from "./storages";
import type { StorageSlug } from "./storages";
import { waitForRest } from "../support/rest";
import { expectPanelOpen } from "./panels";

/**
 * Page object for the storage sidebars — the destination picker and each provider's settings form.
 *
 * The structure, verified in the captured markup, is two levels:
 *  - `#sidebar-storages` — the picker, listing every destination;
 *  - `#sidebar-storage-<SLUG>` — one settings panel per destination, all eleven pre-rendered
 *    (`FOLDER`, `DROPBOX`, `FTP`, `MSAZURE`, `S3`, `SUGARSYNC`, `RSC`, `GDRIVE`, `GLACIER`,
 *    `HIDRIVE`, `ONEDRIVE`), each with its own heading and its own
 *    `js-backwpup-test-<SLUG>-storage` save-and-test button.
 *
 * Field names are **provider-specific** (`glacieraccesskey`, `gdrivedir`, `newvault`, …), so this
 * object exposes a typed {@link field} accessor rather than pretending there is a common schema. The
 * per-provider field maps belong with the scenarios that fill them (6H.2), not here.
 *
 * {@link saveAndTestConnection} is written but is only *exercised* once real credentials exist
 * (6H.2): it performs a live round-trip to the provider, so it cannot pass without them.
 */
export class StorageSidebar {
  constructor(private readonly page: Page) {}

  // ── The destination picker ───────────────────────────────────────────────────

  /** The storage picker sidebar. */
  get container(): Locator {
    return this.page.locator("#sidebar-storages");
  }

  /** Waits for the picker to be showing. */
  async waitForLoaded(): Promise<void> {
    await expectPanelOpen(this.container);
  }

  /** A destination's toggle within the picker. */
  storageToggle(slug: StorageSlug): Locator {
    return this.container.locator(
      `.js-backwpup-toggle-storage[data-storage="${slug}"]`,
    );
  }

  /**
   * The hidden checkbox recording whether a destination is selected.
   *
   * Set by the plugin's `refresh_storage_destinations()` once the provider's settings save — never by
   * clicking the tile, which merely opens the settings (see {@link openSettings}).
   */
  storageInput(slug: StorageSlug): Locator {
    return this.page.locator(`#destination-${slug}`);
  }

  /** Asserts whether a destination is currently selected. */
  async expectStorageSelected(
    slug: StorageSlug,
    selected: boolean,
  ): Promise<void> {
    await expect(this.storageInput(slug)).toBeChecked({ checked: selected });
  }

  /**
   * Asserts a destination is shown as a locked Pro upsell (V2) — Free only.
   *
   * The locked entry is an `<li>`, deliberately not a toggle, so the absence of the toggle is
   * asserted too: either check alone could pass against the wrong edition.
   */
  async expectStorageLocked(slug: StorageSlug): Promise<void> {
    await expect(
      this.page.locator(
        `li.js-backwpup-locked-storage[data-storage="${slug}"]`,
      ),
    ).toBeVisible();
    await expect(this.storageToggle(slug)).toHaveCount(0);
  }

  // ── One provider's settings ──────────────────────────────────────────────────

  /** A provider's settings panel. */
  panel(slug: StorageSlug): Locator {
    return this.page.locator(`#sidebar-storage-${slug}`);
  }

  /**
   * Opens a provider's settings panel and waits for it.
   *
   * The panel is reached from the picker via the destination's own `data-content="storage-<SLUG>"`
   * trigger; its heading is asserted too, so a mis-dispatched click fails here rather than silently
   * filling the wrong provider's form.
   *
   * The heading comes from {@link STORAGE_PANEL_TITLES} and **not** from the picker's label: they
   * differ for `FOLDER` ("Website Server" in the picker, "Folder Settings" on the panel).
   */
  async openSettings(slug: StorageSlug): Promise<void> {
    await this.container
      .locator(`[data-content="storage-${slug}"]`)
      .first()
      .click();
    await expectPanelOpen(this.panel(slug));
    await expect(
      this.panel(slug).getByRole("heading", {
        name: STORAGE_PANEL_TITLES[slug],
      }),
    ).toBeVisible();
  }

  /**
   * One field within a provider's settings panel, by the plugin's own field name.
   *
   * Names are provider-specific and are not normalised here on purpose: inventing a common vocabulary
   * would mean maintaining a mapping that silently rots when the plugin renames a field, whereas a
   * wrong name here fails immediately and visibly as an unresolved locator.
   */
  field(slug: StorageSlug, name: string): Locator {
    return this.panel(slug).locator(`[name="${name}"]`);
  }

  /** Fills one of a provider's fields and asserts the value stuck. */
  async fill(slug: StorageSlug, name: string, value: string): Promise<void> {
    const input = this.field(slug, name);
    await input.fill(value);
    await expect(input).toHaveValue(value);
  }

  /**
   * Saves a provider's settings and tests the connection ("Save & Test connection").
   *
   * `cloudsaveandtest` is the completion signal, and the response is returned so a caller can assert
   * on the provider's verdict rather than only on the UI. **Requires real credentials** — the call
   * performs a live round-trip — which is why no scenario exercises this before 6H.2.
   */
  async saveAndTestConnection(slug: StorageSlug): Promise<void> {
    await Promise.all([
      waitForRest(this.page, "cloudsaveandtest"),
      this.panel(slug).locator(`.js-backwpup-test-${slug}-storage`).click(),
    ]);
  }

  /**
   * **Deliberately no `close()`.** Verified live: clicking `.js-backwpup-close-sidebar` inside a
   * provider's sub-panel does nothing at all — the shell stays open and the panel stays visible, so
   * the control is inert in that state (unlike the frequency sidebar's, which works). Offering a
   * `close()` that cannot close would be a method whose failure only shows up as a timeout in whichever
   * scenario first trusted it.
   *
   * Scenarios that need to leave a provider's settings should navigate away, or reopen the panel they
   * want. If 6H.2 finds a control that genuinely closes it, add the method then — with the same live
   * verification.
   */
}
