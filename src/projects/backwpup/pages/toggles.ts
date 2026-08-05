import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";

/**
 * The one interaction primitive BackWPup's UI forces on us.
 *
 * Every switch, storage tile and file-tree row in BackWPup pairs a **visually hidden** real
 * `<input type="checkbox">` (Tailwind's `sr-only`) with a **visible proxy** element that carries the
 * styling and the click handler. The input holds the state; the proxy receives the click.
 *
 * That shape defeats the obvious approaches, all verified against the captured markup:
 *  - `getByRole("checkbox")` / `getByLabel(…)` cannot see the data-selection switches at all: their
 *    inputs are `aria-hidden="true"` (so absent from the accessibility tree) and their `<label>`
 *    elements contain no text.
 *  - `check()` / `setChecked()` on the input itself is not reliable either — an `sr-only` element is
 *    clipped to a 1px box, so Playwright's actionability checks are at best fragile on it, and
 *    forcing the click bypasses the very handler that persists the change.
 *
 * So the honest interaction is: **click the visible proxy, then assert the hidden input's state.**
 * The assertion is what makes it safe — it is a retrying, web-first check against the element that
 * actually holds the value, so a click that landed on the wrong element or fired no handler fails
 * here rather than three steps later.
 *
 * This is the §3.2 locator policy's documented second exception (alongside icon-only buttons):
 * where the accessible name genuinely does not exist, the plugin's own stable hooks and ids are used
 * instead — never structural CSS.
 */

/**
 * Clicks `proxy` until `input`'s checked state equals `checked`, then asserts it.
 *
 * Idempotent: a toggle already in the wanted state is left alone, so callers can express intent
 * ("files are included") rather than tracking current state — which is what replaces the baseline's
 * `isChecked()` → `if` → `click()` dance.
 *
 * @param proxy - the visible element that carries the click handler.
 * @param input - the hidden `<input type="checkbox">` that holds the state.
 * @param checked - the state to end in.
 * @param options.timeout - budget for the state assertion, in ms.
 */
export async function setToggle(
  proxy: Locator,
  input: Locator,
  checked: boolean,
  options: { timeout?: number } = {},
): Promise<void> {
  if ((await input.isChecked()) !== checked) {
    await proxy.click();
  }
  // Assert against the input, not the proxy: the input is the state. Retries, so it also absorbs
  // the handler's own asynchrony.
  await expect(input).toBeChecked({
    checked,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
}
