import { posix } from "node:path";

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { BackupHistoryTable } from "./backup-history.table";
import { WizardWatch } from "./wizard-watch";
import type { Edition } from "../../../common/config/types";

/**
 * Page objects for the restore screen, `admin.php?page=backwpuprestore` — the six-step wizard that
 * takes an archive from "unpacked" to "restored".
 *
 * **This is the one genuinely edition-divergent flow in BackWPup, and the only place in the
 * port that needs per-edition classes.** The wizard is shared and identical; how a user reaches it
 * is not:
 *
 *  - **Pro** — the history row's Restore action is a deep link naming the archive in the backup
 *    folder (`file`) and the slot the restore unpacks it from (`restore_file`, in the restore's
 *    working directory), with `trigger_download=1`: the server copies the archive across itself and
 *    the upload control is never shown.
 *  - **Free** — the same action lands on the bare page with no `restore_file`, so the user must
 *    re-upload the very file that is already on the server.
 *
 * The divergence is **structural, not a feature flag** — for the folder destination these scenarios
 * back up to: the code that stamps `restoreurl` onto its backup records is
 * `BackWPup_Pro_Destination_Folder::file_get_list()` (`inc/Pro/class-destination-folder.php`), and
 * Free ships no `inc/Pro/` directory at all. (It is per destination, not per edition: Free's own
 * SugarSync destination stamps one too.) It therefore cannot be simulated from the test side — each
 * edition's scenario must really take its own path, which is exactly why {@link ProRestorePage} and
 * {@link FreeRestorePage} assert the *negative* of each other's route.
 *
 * `is_pro()` itself is `file_exists(inc/Pro/class-pro.php)` — a property of the **build**, not of the
 * licence — so these paths behave the same on a site whose licence has lapsed.
 *
 * **The wizard's steps are separate page loads**, each `location.replace()`d with `step=<n>` once the
 * one before it is done (`restore-functions.js`), so the URL is the honest "which step" signal:
 * 1 unpacks (Pro copies, Free uploads), 2 offers the strategies the archive can serve, 3 confirms the
 * database connection, 4 offers a URL migration (Pro only), 5 starts the restore, 6 reports. A
 * files-only strategy goes from 2 straight to 5. Measured on `pro@nginx` for every strategy and every
 * kind of archive.
 *
 * The screen is legacy UI: it carries none of the plugin's `js-backwpup-*` triggers, and its upload
 * widget is plupload, whose real `<input type="file">` has a generated id. Locators here use roles
 * where the controls have names, and otherwise the stable ids and classes the wizard's own scripts
 * bind to.
 *
 * **Every wait fails as soon as the wizard does**, not when its budget runs out: on the wizard's own
 * error line, the decryption prompt, the login screen, and whatever {@link WizardWatch} sees in its
 * traffic — a stream that failed or reconnects, a call that failed, a script that threw.
 */

/** A strategy the wizard's second step can offer, by its button's label. */
export type RestoreStrategy = "Full Restore" | "Database Only" | "Files Only";

/** Every strategy, in the order the screen renders them (`views/restore/steps/step2_action.php`). */
export const RESTORE_STRATEGIES: readonly RestoreStrategy[] = [
  "Full Restore",
  "Database Only",
  "Files Only",
];

/**
 * How long the wizard may take to unpack the archive and offer its strategies: the server's copy and
 * extraction (5 s for a 412 MB archive on `pro@nginx`), or Free's upload through the browser first
 * (~3 min for the same archive from a home connection).
 */
export const UNPACK_TIMEOUT_MS = 15 * 60 * 1000;

/** How long the restore itself may take once started (files 21 s, database 8 s, measured). */
export const RESTORING_TIMEOUT_MS = 15 * 60 * 1000;

/** How long one of the in-between steps may take to hand over to the next (about a second, measured). */
const STEP_TIMEOUT_MS = 2 * 60 * 1000;

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
  /**
   * Assert this edition really took its own entry path, and not the other's.
   * @param archive - the archive's file name, when the caller knows which one it asked for.
   */
  expectEntryPath(archive?: string): Promise<void>;
  /**
   * Waits for the archive to be unpacked and returns the strategies the wizard then offers, in
   * screen order.
   * @throws {@link Error} if the wizard reported an error, a step's request failed, or the step never
   * came within {@link UNPACK_TIMEOUT_MS}.
   */
  strategiesOffered(): Promise<RestoreStrategy[]>;
  /**
   * What {@link RestorePage.strategiesOffered} last returned — empty until it has been asked — so a
   * step after the choice was made can still say what the screen offered.
   */
  readonly offered: readonly RestoreStrategy[];
  /**
   * Chooses a strategy and goes through the remaining steps as offered — the database connection as
   * configured, no URL migration — until the wizard reports success.
   * @param strategy - one of the strategies {@link RestorePage.strategiesOffered} returned.
   * @param beforeStart - run on the last step, just before "Start": the last moment the site is as
   * it was before anything was restored.
   * @throws {@link Error} if the wizard reported an error or the restore did not finish successfully.
   */
  restoreWith(
    strategy: RestoreStrategy,
    beforeStart?: () => Promise<void>,
  ): Promise<void>;
}

/** The query parameter Pro's deep link carries and Free's does not. */
const RESTORE_FILE_PARAM = "restore_file";

/**
 * The wizard step a URL shows, or `undefined` when it is not the restore screen or names no step.
 *
 * @param url - the page's URL.
 */
export function wizardStep(url: string): number | undefined {
  const params = new URL(url).searchParams;
  if (params.get("page") !== "backwpuprestore") return undefined;
  const step = params.get("step");
  return step === null || !/^[1-6]$/.test(step) ? undefined : Number(step);
}

/** Fields and controls shared by both editions' restore screens. */
abstract class BaseRestorePage implements RestorePage {
  /** The strategies offered the last time the archive was unpacked. */
  private lastOffered: readonly RestoreStrategy[] = [];

  /** The wizard's traffic, watched from now on. */
  private readonly watch: WizardWatch;

  /**
   * @param page - the scenario's page; the wizard's traffic on it is watched from here on.
   */
  constructor(protected readonly page: Page) {
    this.watch = new WizardWatch(page);
  }

  /** What {@link BaseRestorePage.strategiesOffered} last returned. */
  get offered(): readonly RestoreStrategy[] {
    return this.lastOffered;
  }

  /** See {@link RestorePage.expectEntryPath}. */
  abstract expectEntryPath(archive?: string): Promise<void>;

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
    await new BackupHistoryTable(this.page).openRestore(row);
    await this.page
      .locator("#sidebar-restore-backup")
      .getByRole("button", { name: "Start Restoration" })
      .click();
    await this.expectLoaded();
  }

  /**
   * See {@link RestorePage.strategiesOffered}. The buttons are rendered by the server for the
   * strategies the archive can serve, so they are read once the step has loaded; a step offering none
   * fails with what it says instead.
   */
  async strategiesOffered(): Promise<RestoreStrategy[]> {
    await this.untilStep([2], UNPACK_TIMEOUT_MS, "unpack the archive");
    const buttons = this.strategyButtons;
    if ((await buttons.count()) === 0) {
      const says = await this.page
        .locator("#restore_step")
        .innerText()
        .catch(() => "");
      throw new Error(
        `[backwpup/restore] the wizard offered no restore strategy: ${says.trim().slice(0, 300) || "(nothing)"}`,
      );
    }
    const labels = (await buttons.allInnerTexts()).map((label) => label.trim());
    const offered = labels.map((label) => {
      const strategy = RESTORE_STRATEGIES.find((known) => known === label);
      if (strategy === undefined) {
        throw new Error(
          `[backwpup/restore] the wizard offered a strategy this page object does not know: "${label}".`,
        );
      }
      return strategy;
    });
    this.lastOffered = offered;
    return offered;
  }

  /** See {@link RestorePage.restoreWith}. */
  async restoreWith(
    strategy: RestoreStrategy,
    beforeStart?: () => Promise<void>,
  ): Promise<void> {
    if (!this.lastOffered.includes(strategy)) {
      throw new Error(
        `[backwpup/restore] cannot restore with "${strategy}": the wizard offered ` +
          `${this.lastOffered.length === 0 ? "nothing yet" : this.lastOffered.map((s) => `"${s}"`).join(", ")}.`,
      );
    }
    await this.page
      .locator("#restore_step")
      .getByRole("button", { name: strategy, exact: true })
      .click();
    // From here each step replaces the page with the next; the URL says which one is showing. At most
    // two steps stand between the choice and the start (3, then 4 on Pro), so a wizard that keeps
    // coming back fails here instead of looping.
    let step = await this.untilStep(
      [3, 4, 5],
      STEP_TIMEOUT_MS,
      "leave the strategy choice",
    );
    for (let hops = 0; step !== 5; hops++) {
      if (hops === 2) {
        throw new Error(
          `[backwpup/restore] the wizard is still at step ${String(step)} after two steps past the strategy choice.`,
        );
      }
      const form =
        step === 3 ? "#db-settings-form" : "#migration-settings-form";
      // Step 3 keeps the connection the site is configured with; step 4 migrates nothing.
      await this.page
        .locator(form)
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      step = await this.untilStep(
        [3, 4, 5],
        STEP_TIMEOUT_MS,
        `leave step ${String(step)}`,
        step,
      );
    }
    await beforeStart?.();
    await this.page
      .locator("#restore_step")
      .getByRole("button", { name: "Start", exact: true })
      .click();
    await this.untilStep([6], RESTORING_TIMEOUT_MS, "restore the archive");
    await expect(
      this.page.getByRole("heading", { name: "Restore Report", exact: true }),
      "the wizard reported errors on its last step",
    ).toHaveCount(0);
    await expect(
      this.page.getByRole("heading", { name: "Success", exact: true }),
      "the wizard did not say it succeeded on its last step",
    ).toBeVisible();
  }

  /** plupload's real file input. Its id is generated per load, so it is addressed by type. */
  protected get fileInput(): Locator {
    return this.page.locator('input[type="file"]');
  }

  /** The upload dropzone (the restore flow's step-1 upload view). */
  protected get dropZone(): Locator {
    return this.page.locator("#drag-drop-area");
  }

  /**
   * The strategy buttons, by the class the wizard's own script binds the choice to
   * (`controller.js` step 2) — so a button it would not act on is not counted.
   */
  protected get strategyButtons(): Locator {
    return this.page.locator("#restore_step .restore-select-strategy");
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

  /** The wizard's own error line (`BWU.Functions.printMessageError`). */
  protected get errorLine(): Locator {
    return this.page.locator("#restore_step #bwu_response.response-error");
  }

  /**
   * Waits until the wizard shows one of `steps` — another than `leaving`, when given — failing early,
   * and saying why, on every way it gets stuck: its own error line, the decryption prompt (an archive
   * this page object cannot open), the login screen (the session did not survive the restore), and
   * whatever its traffic showed ({@link WizardWatch}), before this wait began or during it.
   *
   * @param steps - the steps that end the wait.
   * @param timeout - how long it may take.
   * @param doing - what the wizard is doing meanwhile, for the messages.
   * @param leaving - a step the wizard must have moved on from, though it is in `steps` too.
   * @returns the step it reached.
   */
  protected async untilStep(
    steps: readonly number[],
    timeout: number,
    doing: string,
    leaving?: number,
  ): Promise<number> {
    const accepts = (step: number | undefined): step is number =>
      step !== undefined && steps.includes(step) && step !== leaving;
    const failures: Promise<never>[] = [
      this.errorLine.waitFor({ state: "visible", timeout }).then(async () => {
        throw new Error(
          `[backwpup/restore] the wizard reported an error while trying to ${doing}: ` +
            (await this.errorLine.innerText()).trim(),
        );
      }),
      this.decryptionKey.waitFor({ state: "visible", timeout }).then(() => {
        throw new Error(
          `[backwpup/restore] the wizard asked for a decryption key while trying to ${doing} — the ` +
            "archive is encrypted, which this page object does not restore.",
        );
      }),
      this.page.waitForURL(/\/wp-login\.php/, { timeout }).then(() => {
        throw new Error(
          `[backwpup/restore] the admin session ended while trying to ${doing} — the restored ` +
            "database does not know this login.",
        );
      }),
      this.watch.failed.catch((error: unknown) => {
        throw new Error(
          `[backwpup/restore] while trying to ${doing}, ${error instanceof Error ? error.message : String(error)}.`,
        );
      }),
    ];
    const settle = this.page.waitForURL(
      (url) => accepts(wizardStep(url.href)),
      {
        timeout,
      },
    );
    try {
      await Promise.race([settle, ...failures]);
    } finally {
      // The losers keep waiting; give each a handler so their timeouts are not unhandled rejections.
      for (const failure of failures) failure.catch(() => undefined);
      settle.catch(() => undefined);
    }
    const step = wizardStep(this.page.url());
    if (!accepts(step)) {
      throw new Error(
        `[backwpup/restore] expected step ${steps.join(" or ")} after trying to ${doing}, but the ` +
          `wizard is at ${this.page.url()}.`,
      );
    }
    return step;
  }
}

/**
 * Pro's restore journey: **from the archive already on the server.**
 *
 * What makes this meaningfully "Pro" is the deep link naming that archive, and the upload control
 * never being shown. A regression that silently downgraded Pro to Free's journey would still end with
 * a restored site, so the URL and the missing upload — not the outcome — are what reveal it.
 */
export class ProRestorePage extends BaseRestorePage {
  /**
   * Asserts Pro's entry path: the URL names the archive already on the server, the server is told to
   * fetch it itself, and nothing asks the user for a file.
   *
   * `restore_file` **is** the divergence — for the folder destination it is what
   * `BackWPup_Pro_Destination_Folder::file_get_list()` stamps, which Free does not ship — so its
   * presence is the core of the regression guard. Given the archive's name, both `file` (where it is) and `restore_file`
   * (where the restore takes it from) must name that archive, so a link to some other backup fails.
   *
   * @param archive - the archive's file name; omit to check the shape of the link only.
   */
  async expectEntryPath(archive?: string): Promise<void> {
    // Confirm this really is the restore screen first: a URL check alone would also "pass" on any
    // other page that happens to carry the parameter.
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
    if (archive !== undefined) {
      expect(
        posix.basename(url.searchParams.get("file") ?? ""),
        "the deep link should name the archive being restored as the one to fetch",
      ).toBe(archive);
      expect(
        posix.basename(restoreFile ?? ""),
        "the deep link should restore from a copy of that same archive",
      ).toBe(archive);
      expect(
        url.searchParams.get("trigger_download"),
        "the deep link should have the server fetch the archive itself",
      ).toBe("1");
      await expect(
        this.dropZone,
        "Pro's journey never asks the user for a file",
      ).toBeHidden();
    }
  }
}

/**
 * Free's restore journey: **re-upload the archive that is already on the server.**
 *
 * The inverse assertion to Pro's — the history action must land on the bare page with no
 * `restore_file`, making the upload unavoidable.
 */
export class FreeRestorePage extends BaseRestorePage {
  /**
   * Asserts Free's entry path: the page offers an upload and names no archive.
   *
   * The absent `restore_file` is the load-bearing half — it is what forces the re-upload, and what a
   * regression granting Free the Pro deep link would break. Free's link names no archive, so there is
   * none to hold it against.
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
   * Uploads an archive; the wizard unpacks it by itself afterwards.
   *
   * Files are set on plupload's hidden input; the upload starts by itself, which the page says in as
   * many words, so the progress readout appearing is the honest signal that it did. Waiting for the
   * upload to finish is {@link RestorePage.strategiesOffered}'s job.
   *
   * @param archivePath - the archive on the runner.
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
