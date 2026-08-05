import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { setToggle } from "./toggles";
import { waitForRest } from "../support/rest";
import { STORAGE_LABELS } from "./storages";
import type { StorageSlug } from "./storages";
import { expectPanelOpen } from "./panels";

/**
 * Page object for BackWPup's onboarding wizard.
 *
 * **The wizard is its own admin page, `admin.php?page=backwpuponboarding`.** While the site option
 * `backwpup_onboarding` is set, every other `page=backwpup*` request is redirected here
 * (`inc/class-admin.php:272-282`), and the page is only registered at all while that option is set
 * (`:676`). So {@link goto} targets the wizard directly: navigating to `page=backwpup` and asserting
 * on what appears would be asserting against a redirect, and would break silently the moment
 * onboarding is already complete.
 *
 * The three steps live in **one form** (`#backwpup-onboarding-form`) as sibling panes; moving
 * between them shows and hides panes client-side rather than navigating. Each pane is
 * `article[data-step="1|2|3"]` inside `#backwpup-onboarding-panes`, and the inactive ones carry
 * `hidden` — so "am I on step 2?" is a visibility assertion on a stable attribute, never a URL check.
 *
 * All locators are derived from markup captured from the ref under test; see the sibling
 * `onboarding.page.spec.ts` for the locator contract that guards them.
 */
export class OnboardingPage {
  constructor(private readonly page: Page) {}

  /** Navigate to the wizard. Only reachable while `backwpup_onboarding` is set. */
  async goto(): Promise<void> {
    await this.page.goto("/wp-admin/admin.php?page=backwpuponboarding");
  }

  /**
   * Asserts the wizard is showing, rather than the dashboard or a redirect target.
   *
   * Checks the wizard's own heading *and* that the form is present, so a page that merely happens
   * to contain the words cannot satisfy it.
   */
  async expectLoaded(): Promise<void> {
    await expect(
      this.page.getByRole("heading", {
        name: "Ready to set up your first backup?",
      }),
    ).toBeVisible();
    await expect(this.form).toBeAttached();
  }

  // ── Step navigation ──────────────────────────────────────────────────────────

  /** The wizard's form — the shared container for all three steps. */
  private get form(): Locator {
    return this.page.locator("#backwpup-onboarding-form");
  }

  /** The pane for `step`, whether currently shown or hidden. */
  pane(step: 1 | 2 | 3): Locator {
    return this.page.locator(
      `#backwpup-onboarding-panes article[data-step="${String(step)}"]`,
    );
  }

  /** Asserts `step`'s pane is the visible one. */
  async expectOnStep(step: 1 | 2 | 3): Promise<void> {
    await expect(this.pane(step)).toBeVisible();
  }

  /**
   * Advances step 1 → step 2 ("Save & Continue") and waits for step 2 to be showing.
   *
   * The completion signal is the next pane becoming visible, which is the user-visible outcome —
   * not a network call, because this transition is purely client-side.
   */
  async continueToSchedule(): Promise<void> {
    await this.pane(1).locator(".js-backwpup-onboarding-step-2").click();
    await this.expectOnStep(2);
  }

  /** Advances step 2 → step 3 ("Save & Continue") and waits for step 3 to be showing. */
  async continueToStorage(): Promise<void> {
    await this.pane(2).locator(".js-backwpup-onboarding-step-3").click();
    await this.expectOnStep(3);
  }

  /** Goes back from step 2 to step 1 ("Back to What"). */
  async backToDataSelection(): Promise<void> {
    await this.pane(2).locator(".js-backwpup-onboarding-step-1").click();
    await this.expectOnStep(1);
  }

  /** Goes back from step 3 to step 2 ("Back to When"). */
  async backToSchedule(): Promise<void> {
    await this.pane(3).locator(".js-backwpup-onboarding-step-2").click();
    await this.expectOnStep(2);
  }

  // ── Step 1: what to back up ──────────────────────────────────────────────────

  /**
   * The hidden checkbox holding whether files/database are included.
   *
   * These are `sr-only` **and** `aria-hidden="true"` with textless labels, so they are invisible to
   * role- and label-based locators — see `toggles.ts` for why the stable id is the only honest
   * handle. The visible proxy is the `<label for=…>` beside it.
   */
  private dataInput(kind: "files" | "database"): Locator {
    return this.page.locator(
      kind === "files" ? "#backup_files" : "#backup_database",
    );
  }

  private dataProxy(kind: "files" | "database"): Locator {
    return this.page.locator(
      kind === "files"
        ? 'label[for="backup_files"]'
        : 'label[for="backup_database"]',
    );
  }

  /** Includes or excludes files / the database in the job being configured. Idempotent. */
  async setDataIncluded(
    kind: "files" | "database",
    included: boolean,
  ): Promise<void> {
    await setToggle(this.dataProxy(kind), this.dataInput(kind), included);
  }

  /** Asserts whether files / the database are currently included. */
  async expectDataIncluded(
    kind: "files" | "database",
    included: boolean,
  ): Promise<void> {
    await expect(this.dataInput(kind)).toBeChecked({ checked: included });
  }

  /**
   * Opens the exclusion sidebar for files or database tables ("Advanced settings" on step 1).
   *
   * Both buttons share the accessible name "Advanced settings", so they are told apart by the
   * `data-content` the plugin's own JavaScript dispatches on.
   *
   * `getblock` is the completion signal: `load_and_open_sidebar` fetches the panel body and only
   * reveals the sidebar in that call's success handler, so the request is what proves the panel is on
   * its way. This differs from the storage tiles in the same wizard, which fire no request at all —
   * see {@link openStorageSettings}.
   */
  async openDataSelection(kind: "files" | "database"): Promise<void> {
    const content = kind === "files" ? "select-files" : "select-tables";
    await Promise.all([
      waitForRest(this.page, "getblock"),
      this.pane(1)
        .locator(
          `.js-backwpup-load-and-open-sidebar[data-content="${content}"]`,
        )
        .click(),
    ]);
    await expectPanelOpen(this.page.locator(`#sidebar-${content}`));
  }

  // ── Step 2: when to back up ──────────────────────────────────────────────────

  /**
   * The frequency `<select>` for files or the database.
   *
   * Both are labelled "Frequency", but their `<label>` uses `name=` rather than `for=`, so it is not
   * programmatically associated and `getByLabel` cannot reach either. The plugin's own
   * `js-backwpup-onboarding-*-frequency` class is the stable handle; the `job_N_frequency` field name
   * is deliberately *not* used, since N is an allocated job id that varies per site.
   */
  frequencySelect(kind: "files" | "database"): Locator {
    return this.pane(2).locator(`.js-backwpup-onboarding-${kind}-frequency`);
  }

  /** Sets how often files / the database are backed up, and asserts the choice stuck. */
  async setFrequency(
    kind: "files" | "database",
    frequency: "hourly" | "daily" | "weekly" | "monthly",
  ): Promise<void> {
    const select = this.frequencySelect(kind);
    await select.selectOption(frequency);
    await expect(select).toHaveValue(frequency);
  }

  /**
   * Opens the advanced frequency sidebar for files or the database (step 2's "Advanced settings").
   *
   * Both step-2 buttons share `data-content="frequency"` and differ only by the job id they carry, so
   * they are addressed positionally within the pane — files first, database second, the order the
   * plugin renders them and the only distinction available. Measured against the captured markup:
   * exactly two exist.
   *
   * `getblock` is the completion signal, and the sidebar's body genuinely arrives that way — its
   * container ships empty (see {@link FrequencySidebar}), so a visibility check alone would pass
   * against an empty shell.
   */
  async openAdvancedFrequency(kind: "files" | "database"): Promise<void> {
    const index = kind === "files" ? 0 : 1;
    await Promise.all([
      waitForRest(this.page, "getblock"),
      this.pane(2)
        .locator('.js-backwpup-load-and-open-sidebar[data-content="frequency"]')
        .nth(index)
        .click(),
    ]);
    await expectPanelOpen(this.page.locator("#sidebar-frequency"));
  }

  // ── Step 3: where to store ───────────────────────────────────────────────────

  /**
   * A storage destination's selectable tile.
   *
   * The tile is a `<button>` whose accessible name comes from the `<label>` it contains, so the
   * role/name locator works here — but it is scoped by `data-storage` as well, because the label
   * text is a translated display string while the slug is the plugin's own contract.
   */
  storageTile(slug: StorageSlug): Locator {
    return this.pane(3).locator(
      `button.js-backwpup-toggle-storage[data-storage="${slug}"]`,
    );
  }

  /** The hidden checkbox behind a storage tile, which holds whether it is selected. */
  private storageInput(slug: StorageSlug): Locator {
    return this.pane(3).locator(`#destination-${slug}`);
  }

  /**
   * Opens a destination's settings panel.
   *
   * **A storage tile is not a checkbox.** Clicking it opens that provider's settings form; the hidden
   * checkbox is only ticked later, by the plugin's `refresh_storage_destinations()`, once those
   * settings save successfully. So choosing a destination is a two-step flow — configure, then save.
   *
   * **No REST barrier here, deliberately.** The same `js-backwpup-toggle-storage` class is bound to
   * two different handlers: on the dashboard it runs `load_and_open_storage`, which *fetches* the form
   * over `getblock`; in the wizard every provider's panel is already pre-rendered in the page, so the
   * click merely reveals it and no request is made. Verified live — requiring a `getblock` response
   * here timed out even though the panel opened correctly. Visibility is therefore the honest signal.
   */
  async openStorageSettings(slug: StorageSlug): Promise<void> {
    await this.storageTile(slug).click();
    await expectPanelOpen(this.page.locator(`#sidebar-storage-${slug}`));
  }

  /**
   * Saves an open destination's settings, which is what marks it selected.
   *
   * The completion signal is the destination's own checkbox becoming checked — the state the plugin
   * itself sets on success. That is deliberately asserted instead of a REST route: providers differ in
   * which endpoint they save through, whereas every one of them ends by ticking this box, so this
   * assertion is both provider-agnostic and the actual product outcome.
   */
  async saveStorageSettings(slug: StorageSlug): Promise<void> {
    await this.page
      .locator(`#sidebar-storage-${slug}`)
      .locator(`.js-backwpup-test-${slug}-storage`)
      .click();
    await expect(this.storageInput(slug)).toBeChecked();
  }

  /**
   * Chooses a destination end to end: open its settings, accept them, save.
   *
   * Suitable for destinations that need no credentials — in practice the local **Website Server**
   * (`FOLDER`), which every credential-free scenario uses. A cloud provider needs its fields filled
   * between the two steps, so those scenarios call {@link openStorageSettings} and
   * {@link saveStorageSettings} around their own `fill`s (6H.2).
   */
  async selectStorage(slug: StorageSlug): Promise<void> {
    await this.openStorageSettings(slug);
    await this.saveStorageSettings(slug);
  }

  /** Asserts a storage destination's selected state. */
  async expectStorageSelected(
    slug: StorageSlug,
    selected: boolean,
  ): Promise<void> {
    await expect(this.storageInput(slug)).toBeChecked({ checked: selected });
  }

  /**
   * Asserts a destination is offered as a **locked Pro upsell** rather than a usable option (V2).
   *
   * Only ever true on a Free build: on Pro `$locked_pro_slugs` is empty and every destination is
   * selectable. The locked entry is a plain `<li>`, not a `<button>`, which is what makes it
   * unselectable — so the assertion checks for the locked element *and* the absence of the tile,
   * because either alone could pass against the wrong edition.
   */
  async expectStorageLocked(slug: StorageSlug): Promise<void> {
    await expect(
      this.page.locator(
        `li.js-backwpup-locked-storage[data-storage="${slug}"]`,
      ),
    ).toBeVisible();
    await expect(this.storageTile(slug)).toHaveCount(0);
  }

  /** The visible label a destination is offered under, for assertions on what the user reads. */
  storageLabel(slug: StorageSlug): string {
    return STORAGE_LABELS[slug];
  }

  // ── Completion ───────────────────────────────────────────────────────────────

  /** The wizard's final submit ("Save & Continue" on step 3). */
  private get submitButton(): Locator {
    return this.pane(3).locator(".js-backwpup-onboarding-submit-form");
  }

  /**
   * Asserts the wizard cannot be submitted yet.
   *
   * The submit button ships `disabled` and the plugin enables it once at least one destination is
   * chosen, so this is a real product rule worth asserting rather than an implementation detail.
   */
  async expectCannotSubmit(): Promise<void> {
    await expect(this.submitButton).toBeDisabled();
  }

  /**
   * Submits the wizard and waits for it to have left the wizard behind.
   *
   * Completion deletes the `backwpup_onboarding` option, after which this page no longer exists —
   * so the honest signal is that the wizard's own form is gone. The plugin also starts the first
   * backup immediately on save (step 2 says so in as many words), which is why callers that care
   * about that backup should wait on it explicitly rather than assuming this returned after it.
   */
  async submit(): Promise<void> {
    await expect(this.submitButton).toBeEnabled();
    await this.submitButton.click();
    await expect(this.form).toHaveCount(0);
  }
}
