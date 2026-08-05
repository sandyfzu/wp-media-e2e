import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import type { Edition } from "../../../common/config/types";

/**
 * Page objects for the restore screen, `admin.php?page=backwpuprestore`.
 *
 * **This is the one genuinely edition-divergent flow in BackWPup (V13), and the only place in the
 * port that needs per-edition classes.** The restore *screen* is shared and identical; how a user
 * reaches it is not:
 *
 *  - **Pro** — the history row's Restore action is a deep link carrying `restore_file`, pointing at
 *    the archive already sitting in `wp-content/uploads/backwpup…`. Nothing is uploaded.
 *  - **Free** — the same action lands on the bare page with no `restore_file`, so the user must
 *    re-upload the very file that is already on the server.
 *
 * The divergence is **structural, not a feature flag**: the code that stamps `restoreurl` onto a
 * backup record lives in `inc/Pro/class-destinations.php`, and Free ships no `inc/Pro/` directory at
 * all (the shared base merely checks `BackWPup::is_pro()` before delegating to it). It therefore
 * cannot be simulated from the test side — each edition's scenario must really take its own path,
 * which is exactly why {@link ProRestorePage} and {@link FreeRestorePage} assert the *negative* of
 * each other's route.
 *
 * `is_pro()` itself is `file_exists(inc/Pro/class-pro.php)` — a property of the **build**, not of the
 * licence — so these paths behave the same on a site whose licence has lapsed.
 *
 * Note the screen is legacy UI: it carries none of the plugin's `js-backwpup-*` triggers, and its
 * upload widget is plupload, whose real `<input type="file">` has a generated id. Locators here use
 * the stable structural ids the page has always had.
 */

/** What both editions' restore pages can do. */
export interface RestorePage {
  /** Navigate to the restore screen directly (the bare entry, with nothing pre-selected). */
  goto(): Promise<void>;
  /** Assert the restore screen is showing. */
  expectLoaded(): Promise<void>;
  /**
   * Reach the restore screen from a backup's history row. The click path is shared by both editions;
   * where it lands is not — see {@link RestorePage.expectEntryPath}.
   * @param row - the history row of the backup to restore.
   */
  startFrom(row: Locator): Promise<void>;
  /** Assert this edition really took its own entry path, and not the other's. */
  expectEntryPath(): Promise<void>;
}

/** The query parameter Pro's deep link carries and Free's does not. */
const RESTORE_FILE_PARAM = "restore_file";

/** Fields and controls shared by both editions' restore screens. */
abstract class BaseRestorePage {
  constructor(protected readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/wp-admin/admin.php?page=backwpuprestore");
  }

  /**
   * Asserts the restore screen is showing.
   *
   * Anchored on the page wrapper and the step container rather than on the `<h1>`, whose text embeds
   * the edition ("BackWPup Pro › Restore" vs "BackWPup › Restore") and so cannot be shared.
   */
  async expectLoaded(): Promise<void> {
    await expect(this.page.locator("#backwpup-page")).toBeVisible();
    await expect(this.page.locator("#restore_step")).toBeVisible();
  }

  /**
   * Reaches the restore screen from a backup's history row.
   *
   * **Shared by both editions on purpose:** the click path is identical — open the row's Restore
   * action, then confirm in the modal. What differs is where it *lands*, which is exactly what each
   * edition's {@link RestorePage.expectEntryPath} asserts. Duplicating the clicks per edition would
   * have invited the two copies to drift apart.
   *
   * Two label details, both captured from the rendered page:
   *  - the row's action label is data-driven (`dataset-restore['label']`), so the action is located by
   *    the modal it targets (`data-content="restore-backup"`), never by its text;
   *  - the modal's confirm button reads **"Start Restoration"** — which notably does *not* contain the
   *    substring "Restore", so a `/Restore/` pattern silently matches nothing.
   */
  async startFrom(row: Locator): Promise<void> {
    await row
      .locator('[data-content="restore-backup"]')
      .filter({ visible: true })
      .first()
      .click();
    const modal = this.page.locator("#sidebar-restore-backup");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Start Restoration" }).click();
    await this.expectLoaded();
  }

  /** The upload dropzone (the restore flow's step-1 upload view). */
  protected get dropZone(): Locator {
    return this.page.locator("#drag-drop-area");
  }

  /**
   * plupload's real file input.
   *
   * Its id is generated per page load, so it is addressed by type. It is deliberately transparent and
   * absolutely positioned over the visible "Select Archive" button, which is why files are set on it
   * directly rather than by clicking that button and driving a native dialog.
   */
  protected get fileInput(): Locator {
    return this.page.locator('input[type="file"]');
  }

  /** The restore progress readout. */
  get progress(): Locator {
    return this.page.locator("#upload_progress");
  }

  /** The current restore step. */
  get currentStep(): Locator {
    return this.page.locator("#onstep");
  }

  /** The decryption-key field, for encrypted archives (Pro). */
  get decryptionKey(): Locator {
    return this.page.locator("#decryption_key");
  }
}

/**
 * Pro's restore journey: **in place, from the archive already on the server.**
 *
 * What makes this meaningfully "Pro" is the deep link naming an archive already on the server. A
 * regression that silently downgraded Pro to Free's journey would still end with a restored site, so
 * the URL — not the outcome — is what reveals it.
 */
export class ProRestorePage extends BaseRestorePage implements RestorePage {
  /**
   * Asserts Pro's entry path: the URL names the archive already on the server.
   *
   * That parameter **is** the divergence — it is what `BackWPup_Pro_Destinations::file_get_list()`
   * stamps and what Free, shipping no `inc/Pro/`, can never produce. So its presence is the whole
   * regression guard: a Pro build that fell back to Free's journey would still end with a restored
   * site, and only the missing deep link reveals the downgrade.
   *
   * It deliberately does **not** assert that the page offers no upload control. The dropzone lives in
   * the restore flow's step-1 view (`views/restore/steps/step1_action.php`) and the step defaults to
   * `1`, so whether the deep link skips that view is not something this has observed — asserting it
   * would be a guess. The UI-level "never asks for a file" check belongs to 6G, which drives a real
   * restore and can see it.
   */
  async expectEntryPath(): Promise<void> {
    // Confirm this really is the restore screen first: a URL check alone would also "pass" on any
    // other page that happens not to carry the parameter.
    await this.expectLoaded();
    const url = new URL(this.page.url());
    const restoreFile = url.searchParams.get(RESTORE_FILE_PARAM);
    expect(
      restoreFile,
      `Pro should deep-link at the archive already on the server, but the restore URL carried no ` +
        `"${RESTORE_FILE_PARAM}". This is what a Pro→Free downgrade of the restore journey looks like.`,
    ).not.toBeNull();
    expect(
      restoreFile,
      `"${RESTORE_FILE_PARAM}" was present but empty, so no archive was named.`,
    ).not.toBe("");
  }
}

/**
 * Free's restore journey: **re-upload the archive that is already on the server.**
 *
 * The inverse assertion to Pro's — the history action must land on the bare page with no
 * `restore_file`, making the upload unavoidable.
 */
export class FreeRestorePage extends BaseRestorePage implements RestorePage {
  /**
   * Asserts Free's entry path: the page offers an upload and names no archive.
   *
   * The absent `restore_file` is the load-bearing half — it is what forces the re-upload, and what a
   * regression granting Free the Pro deep link would break.
   */
  async expectEntryPath(): Promise<void> {
    const url = new URL(this.page.url());
    expect(
      url.searchParams.get(RESTORE_FILE_PARAM),
      `Free must not receive a "${RESTORE_FILE_PARAM}" deep link — that is the Pro-only journey.`,
    ).toBeNull();
    await expect(this.dropZone).toBeVisible();
  }

  /**
   * Uploads an archive and waits for the restore to begin.
   *
   * Files are set on plupload's hidden input; the upload starts by itself, which the page says in as
   * many words, so the progress readout appearing is the honest signal that it did.
   */
  async uploadArchive(archivePath: string): Promise<void> {
    await this.fileInput.setInputFiles(archivePath);
    await expect(this.progress).toBeVisible();
  }
}

/**
 * The restore page for a cell's edition.
 *
 * The small factory (rather than one class with `if (edition === "pro")` scattered through it) keeps
 * each journey's assertions — including each one's negative assertion about the other — in its own
 * class, so neither can be weakened by a change meant for the other.
 */
export function restorePage(page: Page, edition: Edition): RestorePage {
  return edition === "pro"
    ? new ProRestorePage(page)
    : new FreeRestorePage(page);
}
