import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the screen onboarding hands over to — `admin.php?page=backwpupfirstbackup`.
 *
 * **Completing onboarding does not just save settings; it starts a real backup.** Onboarding's own
 * step 2 says so ("The first backup will be created right after saving the options"), and the
 * mechanism is this page: the plugin redirects here on save, the admin script posts `startbackup`
 * for the job the installer created, and the page then reloads into a live progress view.
 *
 * That makes landing here the proof that onboarding handed over rather than merely saved, which is
 * the one claim this object makes. **What it cannot tell you is when the backup ended** — see
 * {@link congratulations}. The run itself is watched through WP-CLI, which is true no matter how
 * fast the site backs itself up. That matters beyond tidiness: the plugin lifecycle uninstalls the
 * plugin when the scenario ends, and a background job outliving its own code is how flaky failures
 * start.
 *
 * **This screen is allowed to leave on its own, and that is why nothing here asserts its DOM.** Every
 * load of this URL re-posts `startbackup`; the first sets a site transient and starts the job, and
 * any later one is answered `{status: 301, url: admin.php?page=backwpup}` — so the ~500 ms reload the
 * script schedules lands on the dashboard whenever the job has already finished (`backwpup-generate.js`
 * is enqueued only while `BackWPup_Job::get_working_data()` reports a running job, and without it the
 * re-post is not suppressed). A fast backup — a database-only one, say — takes that path routinely.
 * A retrying assertion against this page's heading or its hidden field therefore races a *correct*
 * product behaviour, and once the browser has moved on, retrying cannot recover.
 *
 * Those two markers are still asserted, where a fixture can prove them without a clock: the
 * `FirstBackupPage` block in `locator-contract.spec.ts`, against captured markup. And a page that
 * rendered a fatal instead of the real screen is caught twice over without them — the `@plugin`
 * teardown fails the scenario on anything PHP logged, and no backup would appear for
 * `the first backup completes` to find.
 */

/** This screen's own URL — the destination that makes the handover observable. */
const HANDOVER_URL = /[?&]page=backwpupfirstbackup(?:&|$)/;

/**
 * How long onboarding's save may take to redirect here.
 *
 * Explicit because `waitForURL`'s own default is **no timeout** unless a config sets
 * `navigationTimeout`, and ours does not — left implicit, a handover that never happened would burn
 * the scenario's whole budget and report itself as a timeout with nothing to point at.
 */
const HANDOVER_TIMEOUT_MS = 30_000;

export class FirstBackupPage {
  constructor(private readonly page: Page) {}

  /**
   * Runs `submit` and asserts the browser landed here — onboarding's handover, in one step.
   *
   * **The wait is armed before `submit` runs, and that is the whole design.** A navigation is a
   * one-shot event: once `waitForURL` has seen it, no later redirect can take it back, so this holds
   * even when the plugin immediately moves the browser on to the dashboard. Awaiting a *state* after
   * the fact — the URL as it is now, an element on the page — is what the fast-backup path above can
   * invalidate. `Promise.all` gives that ordering for free, since the array's elements are evaluated
   * left to right and `waitForURL` registers its listener synchronously; it is the same shape the
   * REST barriers in this suite use.
   *
   * `waitUntil: "commit"` rather than the default `load`: the claim is that the browser *went*
   * there, which is settled the moment the response arrives and the document starts loading. Waiting
   * for `load` would re-open a window in which the plugin's own script can navigate away and
   * interrupt the wait.
   *
   * @param submit - the action that triggers the handover, normally `OnboardingPage.submit`.
   * @throws Error if the browser never reached this screen within {@link HANDOVER_TIMEOUT_MS}, or
   * whatever `submit` itself threw.
   */
  async expectHandover(submit: () => Promise<void>): Promise<void> {
    await Promise.all([
      this.page.waitForURL(HANDOVER_URL, {
        waitUntil: "commit",
        timeout: HANDOVER_TIMEOUT_MS,
      }),
      submit(),
    ]);
  }

  /**
   * The plugin's own "the first backup is done" panel — present in the DOM, revealed by the
   * progress poller when the job reports itself finished.
   *
   * **Do not wait on this to decide the backup is over.** It is only ever shown when the run was
   * *still going* at the moment the page reloaded, and the class doc above explains why that is not
   * guaranteed: a job that finished first sends the browser to the dashboard having never shown this
   * panel at all.
   *
   * The honest signal is the archive appearing in the history (`support/backups.ts`), which is true
   * regardless of which path the browser took. This locator stays exposed for a scenario that wants
   * to assert the panel's *content* once it is showing.
   */
  get congratulations(): Locator {
    return this.page.locator("#first-congratulations");
  }
}
