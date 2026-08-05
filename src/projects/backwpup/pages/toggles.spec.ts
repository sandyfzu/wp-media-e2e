import { test, expect } from "@playwright/test";

import { setToggle } from "./toggles";
import { FIXTURE_STYLES } from "./__fixtures__/styles";

/**
 * `setToggle`'s behaviour against BackWPup's shared toggle markup.
 *
 * The fixture reproduces `components/form/toggle.php` exactly as it renders (an `sr-only`,
 * `aria-hidden` checkbox whose id equals its name, plus a textless `<label for=…>` proxy). Clicking a
 * label natively toggles its checkbox, so this exercises the real interaction with no plugin
 * JavaScript — while the captured-markup contract lives in `locator-contract.spec.ts`.
 */

// The class lists are copied verbatim from `components/form/toggle.php` as it renders — including
// `inline-flex`, without which `h-6 w-10` would not apply to an otherwise-inline <label> and the proxy
// would have no clickable box. An earlier version of this fixture dropped it, which made the test pass
// only because the style shim then handed every label a size the real page does not give it.
const TOGGLE = (checked: boolean): string => `${FIXTURE_STYLES}
<div class="relative flex gap-2">
  <input type="checkbox" class="sr-only peer group js-backwpup-toggle-job" aria-hidden="true"
         id="next_backup_7" name="next_backup_7"${checked ? " checked" : ""}>
  <label for="next_backup_7" class="bg-grey-500 peer-checked:bg-secondary-base relative inline-flex h-6 w-10 flex-shrink-0 cursor-pointer rounded-full"></label>
</div>`;

/** A proxy whose click does nothing — a broken or mis-wired control. */
const INERT = `${FIXTURE_STYLES}
<input type="checkbox" id="inert" name="inert" class="sr-only">
<span id="inert-proxy">click me</span>`;

test.describe("setToggle", () => {
  test("turns an off toggle on", async ({ page }) => {
    await page.setContent(TOGGLE(false));
    const input = page.locator("#next_backup_7");
    await setToggle(page.locator('label[for="next_backup_7"]'), input, true);
    await expect(input).toBeChecked();
  });

  test("turns an on toggle off", async ({ page }) => {
    await page.setContent(TOGGLE(true));
    const input = page.locator("#next_backup_7");
    await setToggle(page.locator('label[for="next_backup_7"]'), input, false);
    await expect(input).not.toBeChecked();
  });

  // Idempotence is what lets callers state intent rather than track state — and it is what replaces
  // the baseline's isChecked() → if → click() dance.
  test("is a no-op when already in the wanted state", async ({ page }) => {
    await page.setContent(TOGGLE(true));
    const input = page.locator("#next_backup_7");
    await setToggle(page.locator('label[for="next_backup_7"]'), input, true);
    await expect(input).toBeChecked();
    // A second call must not flip it back.
    await setToggle(page.locator('label[for="next_backup_7"]'), input, true);
    await expect(input).toBeChecked();
  });

  test("works on the aria-hidden input that role locators cannot reach", async ({
    page,
  }) => {
    await page.setContent(TOGGLE(false));
    // Proof the hard case is the one being handled: the control is invisible to the a11y tree.
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await setToggle(
      page.locator('label[for="next_backup_7"]'),
      page.locator("#next_backup_7"),
      true,
    );
    await expect(page.locator("#next_backup_7")).toBeChecked();
  });

  // The state assertion is what makes the click-the-proxy approach safe: a proxy that fires no
  // handler must fail here, not three steps later.
  test("fails when the proxy does not actually change the state", async ({
    page,
  }) => {
    await page.setContent(INERT);
    await expect(
      setToggle(page.locator("#inert-proxy"), page.locator("#inert"), true, {
        timeout: 500,
      }),
    ).rejects.toThrow();
  });
});
