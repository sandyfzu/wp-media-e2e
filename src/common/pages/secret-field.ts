import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";

/**
 * Entering a secret — a password, a storage key — into a form field without writing it into a report.
 *
 * Playwright titles a `fill()`, `type()` or `pressSequentially()` step with the text it enters, and
 * passes that text as the step's parameters: a password typed so lands in the HTML report, the Allure
 * results and every retained trace. A boxed step hides nothing, and Playwright has no masking option.
 * `locator.evaluate` is titled without its argument, so the value is set in the page instead — through
 * the field's native `value` setter, then announced with the `input` and `change` events typing
 * raises, so the page's own scripts see it as typed.
 *
 * What this cannot hide: a trace's **DOM snapshots** record every field's value, a password field's
 * included. The auth setup therefore traces without them; a scenario's trace still has them.
 *
 * Use it for secrets only. Everything else keeps `fill()`, whose report entry is worth having.
 */

/**
 * Sets `secret` as the value of a text field, as typing it would.
 *
 * The field must be what `fill()` requires — visible and editable — so a secret never lands in a
 * field no user could type into. Setting the value directly also means no focus change in the page
 * can divert it into another field, which `fill()` — it writes into whatever holds focus at that
 * instant — cannot promise.
 *
 * @param field - an `<input>` or `<textarea>`.
 * @param secret - the value; never part of a step's title or parameters.
 * @param options - `timeout`: how long to wait for each of visible and editable (ms); Playwright's
 *   `expect` timeout when omitted.
 * @throws {@link Error} when the field is hidden, not editable, or neither an `<input>` nor a
 *   `<textarea>` — the message names the field's state or element, never the value.
 */
export async function enterSecret(
  field: Locator,
  secret: string,
  options: { readonly timeout?: number } = {},
): Promise<void> {
  await expect(field, "the field for a secret is not visible").toBeVisible(
    options,
  );
  await expect(field, "the field for a secret is not editable").toBeEditable(
    options,
  );
  // An inline arrow on purpose: Playwright sends the function's source to the page, and a named
  // function may be wrapped by the transpiler in a helper the page does not have.
  await field.evaluate((element, value: string) => {
    let prototype: HTMLInputElement | HTMLTextAreaElement;
    if (element instanceof HTMLInputElement) {
      prototype = HTMLInputElement.prototype;
    } else if (element instanceof HTMLTextAreaElement) {
      prototype = HTMLTextAreaElement.prototype;
    } else {
      throw new Error(
        `a secret goes into an <input> or a <textarea>, not a <${element.localName}>`,
      );
    }
    // The prototype's setter, not `element.value = …`: a framework such as React tracks the value
    // through a setter of its own on the element, and ignores an `input` event carrying a value that
    // setter already saw. Going around it, the event reads as the change it is.
    if (!Reflect.set(prototype, "value", value, element)) {
      throw new Error("the field's value could not be set");
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, secret);
}

/**
 * Whether a field holds exactly `secret`, compared in the page: only the boolean comes back, so the
 * value never becomes a call's result in a trace — as `inputValue()`'s would.
 *
 * @param field - an `<input>` or `<textarea>`.
 * @param secret - the value it should hold.
 * @returns `false` as well for an element that holds no value at all.
 */
export async function holdsSecret(
  field: Locator,
  secret: string,
): Promise<boolean> {
  return field.evaluate(
    (element, value: string) =>
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement) &&
      element.value === value,
    secret,
  );
}
