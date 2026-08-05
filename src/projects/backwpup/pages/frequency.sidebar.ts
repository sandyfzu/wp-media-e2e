import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { waitForRest } from "../support/rest";
import { expectPanelClosed, expectPanelOpen } from "./panels";

/**
 * How often a job runs.
 *
 * `link` (trigger by URL) is **onboarding-gated, not edition-gated** — `frequency.php:62-64` appends it
 * only when `backwpup_onboarding` is unset, with no `is_pro()` check anywhere, and `parts/` is
 * byte-identical between Free and Pro. Verified live on 5.7.5: the wizard's advanced-frequency sidebar
 * offers `hourly, daily, weekly, monthly`; the same sidebar reached from a job card also offers `link`.
 * So a scenario may select it on the dashboard on either edition, and never inside the wizard.
 */
export type Frequency = "hourly" | "daily" | "weekly" | "monthly" | "link";

/**
 * Page object for the **Job Scheduled Settings** sidebar — a job's full schedule.
 *
 * Distinct from the onboarding wizard's inline frequency dropdown, which offers only the four basic
 * intervals: this sidebar adds the start time, the day-of-week/day-of-month selectors, and (on Pro)
 * link-triggered runs.
 *
 * **Its body is fetched, not pre-rendered.** Unlike most of BackWPup's sidebars, `#sidebar-frequency`
 * ships as an empty shell containing only its heading; the fields arrive from a `getblock` call when
 * a trigger opens it. So {@link waitForLoaded} waits for a *field*, not for the container — asserting
 * on the container would pass against the empty shell, and every subsequent locator would then time
 * out one at a time.
 *
 * Which controls are present depends on the chosen frequency (the plugin hides the start-time and day
 * pickers for hourly jobs), which is why the accessors are individually addressable rather than a
 * single "fill the form" method.
 */
export class FrequencySidebar {
  constructor(private readonly page: Page) {}

  /** The sidebar container. Present in the DOM even when empty — see {@link waitForLoaded}. */
  get container(): Locator {
    return this.page.locator("#sidebar-frequency");
  }

  /**
   * Waits until the sidebar's fields have loaded.
   *
   * The frequency select is the one control present for every frequency, so it is the honest proof
   * that the fetched body arrived.
   */
  async waitForLoaded(): Promise<void> {
    await expectPanelOpen(this.container);
    await expect(this.frequencySelect).toBeVisible();
  }

  /**
   * The frequency dropdown.
   *
   * Located by the plugin's own `frequency-job` trigger class rather than by its "Frequency" label:
   * the `<label>` is associated with the field by a `name` attribute rather than `for`, so it is not
   * a programmatic label and `getByLabel` cannot resolve it.
   */
  get frequencySelect(): Locator {
    return this.container.locator(".js-backwpup-frequency-job");
  }

  /** The start-time field (`<input type="time">`). Hidden for hourly jobs. */
  get startTime(): Locator {
    return this.container.locator('input[name="start_time"]');
  }

  /** The minute-past-the-hour selector, shown only for hourly jobs. */
  get hourlyStartTime(): Locator {
    return this.container.locator('select[name="hourly_start_time"]');
  }

  /** The day-of-week selector (`0`–`6`, Sunday = `0`), shown for weekly jobs. */
  get dayOfWeek(): Locator {
    return this.container.locator('select[name="day_of_week"]');
  }

  /** The day-of-month selector, shown for monthly jobs. */
  get dayOfMonth(): Locator {
    return this.container.locator('select[name="day_of_month"]');
  }

  /**
   * Chooses the frequency and waits for the dependent fields to settle.
   *
   * Changing frequency re-shows and re-hides the day/time controls client-side, so the assertion that
   * the value stuck is also what guarantees the dependent fields have been re-evaluated before a
   * caller touches them.
   */
  async setFrequency(frequency: Frequency): Promise<void> {
    await this.frequencySelect.selectOption(frequency);
    await expect(this.frequencySelect).toHaveValue(frequency);
  }

  /** Sets the start time (`HH:MM`). Only meaningful for non-hourly frequencies. */
  async setStartTime(time: string): Promise<void> {
    await this.startTime.fill(time);
    await expect(this.startTime).toHaveValue(time);
  }

  /**
   * Saves the schedule.
   *
   * `save_job_settings` is the completion signal — the sidebar closes optimistically, so a
   * visibility check would pass even if the save were rejected.
   */
  async save(): Promise<void> {
    await Promise.all([
      waitForRest(this.page, "save_job_settings"),
      this.container.locator("#save-job-settings").click(),
    ]);
  }

  /**
   * Closes the sidebar without saving.
   *
   * The completion signal is that the panel has left the viewport, **not** that it is hidden — see
   * {@link expectPanelClosed} for why a `toBeHidden()` check here could never pass.
   */
  async close(): Promise<void> {
    await this.container.locator(".js-backwpup-close-sidebar").first().click();
    await expectPanelClosed(this.container);
  }
}
