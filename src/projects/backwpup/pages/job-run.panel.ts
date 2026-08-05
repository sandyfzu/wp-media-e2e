import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { waitForRest } from "../support/rest";

/**
 * Page object for a running backup job.
 *
 * **This is an in-page region, not a modal.** The plan called it `JobRunModal`; the captured markup
 * shows the progress UI is `div#runningjob`, rendered inline on the dashboard with
 * `style="display: none"` and revealed once a job starts. The only modal involved is the *confirmation*
 * dialog (`#sidebar-backup-now`) that precedes it, whose "Start" button is what actually launches the
 * job. Keeping the two apart matters: asserting on the modal proves a dialog opened, while asserting
 * on this region proves a backup is genuinely running.
 *
 * Because the region pre-exists in the DOM, **presence proves nothing** — every assertion here is a
 * visibility or content assertion, never `toBeAttached`.
 */
export class JobRunPanel {
  constructor(private readonly page: Page) {}

  /** The progress region, present in the DOM from page load and revealed while a job runs. */
  get region(): Locator {
    return this.page.locator("#runningjob");
  }

  /**
   * Confirms the "Backup Now" dialog and starts the backup.
   *
   * The `startbackup` REST call is the point of no return, so it is awaited as a barrier around the
   * click — a click that opened no request is a failure here, not a silent no-op that surfaces later
   * as an empty backup history. The progress region becoming visible is then asserted as the
   * user-visible consequence.
   */
  async startFromModal(): Promise<void> {
    const start = this.page
      .locator("#sidebar-backup-now")
      .locator(".js-backwpup-start-backup-now");
    await expect(start).toBeVisible();
    await Promise.all([waitForRest(this.page, "startbackup"), start.click()]);
    await expect(this.region).toBeVisible();
  }

  /** Asserts a backup is currently running, by its own heading. */
  async expectRunning(): Promise<void> {
    await expect(this.region).toBeVisible();
    await expect(
      this.page.locator("#backupgeneration-progress-box-title"),
    ).toBeVisible();
  }

  /**
   * The progress bar's filled portion.
   *
   * Its width is driven inline as the job advances and its `<span>` carries the percentage, so a
   * scenario asserting progress should assert on the text rather than on geometry.
   */
  get progressBar(): Locator {
    return this.region.locator(".progress-bar .progress-step");
  }

  /**
   * The step the job is currently on (the plugin's `lastmsg`).
   *
   * Empty until the first step reports, which is why "a job is running" is asserted via
   * {@link expectRunning} and not via this element having text.
   */
  get currentStep(): Locator {
    return this.region.locator(".js-backwpup-current-file");
  }

  /** The "Abort" control, offered while the job is running. */
  get abortButton(): Locator {
    return this.page.locator("#abortbutton");
  }

  /**
   * Aborts the running job.
   *
   * The plugin polls `job-abort-status` to confirm the abort took effect, so that call is the honest
   * completion signal — a click alone proves only that a request was sent, and the job may keep
   * running. Callers should still verify the outcome against WP-CLI, since aborting is inherently
   * racy: a job that finishes first cannot be aborted at all.
   */
  async abort(): Promise<void> {
    await expect(this.abortButton).toBeVisible();
    await Promise.all([
      waitForRest(this.page, "job-abort-status"),
      this.abortButton.click(),
    ]);
  }

  /** Dismisses the finished-job panel, returning to the dashboard. */
  async close(): Promise<void> {
    await this.page.locator("#showworkingclose").click();
    await expect(this.region).toBeHidden();
  }

  /** Opens the job's live log in the plugin's thickbox overlay ("Display Logs"). */
  async showLogs(): Promise<void> {
    await this.region.getByRole("link", { name: "Display Logs" }).click();
    await expect(this.page.locator("#showworking")).toBeVisible();
  }
}
