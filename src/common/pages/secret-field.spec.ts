import { test, expect } from "@playwright/test";

import { enterSecret, holdsSecret } from "./secret-field";

/**
 * The secret helpers on a `setContent` form: the value lands, the page hears it as typed, the in-page
 * check answers both ways, and a wrong element is refused by name. That no report carries the value
 * is proven through the real runner, in `auth/secrets.run.spec.ts`.
 */

const SECRET = "s3cr3t-Ünïcode-✓ with spaces";

/**
 * A form recording, per field, the events it heard and the value each saw — what a page's own
 * scripts (a submit button that enables itself, a framework's state) rely on.
 */
const FORM = `<!doctype html><html><body>
  <input id="pw" type="password" />
  <textarea id="key"></textarea>
  <input id="readonly" type="password" readonly />
  <input id="hidden" type="password" style="display: none" />
  <input id="tracked" type="password" />
  <div id="div"></div>
  <script>
    window.heard = [];
    for (const id of ["pw", "key"]) {
      const el = document.getElementById(id);
      for (const type of ["input", "change"]) {
        el.addEventListener(type, (event) =>
          window.heard.push(id + ":" + type + ":" + event.target.value.length + ":" + event.bubbles));
      }
    }
    // React's value tracking, reduced: a setter of its own on the element records each value it is
    // given, and an input event whose value it already recorded is no change.
    const tracked = document.getElementById("tracked");
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    let known = tracked.value;
    Object.defineProperty(tracked, "value", {
      configurable: true,
      get() { return native.get.call(this); },
      set(value) { known = String(value); native.set.call(this, value); },
    });
    window.changes = 0;
    tracked.addEventListener("input", () => {
      const now = native.get.call(tracked);
      if (now !== known) { known = now; window.changes += 1; }
    });
  </script>
</body></html>`;

test.describe("enterSecret", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(FORM);
  });

  test("sets a password field's value and raises input then change, bubbling", async ({
    page,
  }) => {
    await enterSecret(page.locator("#pw"), SECRET);
    expect(await page.locator("#pw").inputValue()).toBe(SECRET);
    expect(await page.evaluate(() => window.heard)).toEqual([
      `pw:input:${String(SECRET.length)}:true`,
      `pw:change:${String(SECRET.length)}:true`,
    ]);
  });

  test("sets a textarea's value", async ({ page }) => {
    await enterSecret(page.locator("#key"), SECRET);
    expect(await page.locator("#key").inputValue()).toBe(SECRET);
  });

  test("replaces a value already there, as fill() does", async ({ page }) => {
    await page.locator("#pw").fill("old");
    await enterSecret(page.locator("#pw"), SECRET);
    expect(await page.locator("#pw").inputValue()).toBe(SECRET);
  });

  test("a framework tracking the value through its own setter sees the change", async ({
    page,
  }) => {
    // The control: assigning through the element's own setter, as `element.value = …` would, then
    // raising `input`, is no change to the tracker — the reason the helper goes around it.
    await page.locator("#tracked").evaluate((el) => {
      (el as HTMLInputElement).value = "typed";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await page.evaluate(() => window.changes)).toBe(0);

    await enterSecret(page.locator("#tracked"), SECRET);
    expect(await page.evaluate(() => window.changes)).toBe(1);
  });

  test("refuses a hidden field, as fill() would, without naming the value", async ({
    page,
  }) => {
    const failure = await enterSecret(page.locator("#hidden"), SECRET, {
      timeout: 500,
    }).catch((error: unknown) => error);
    expect(String(failure)).toMatch(/not visible/);
    expect(String(failure)).not.toContain(SECRET);
    expect(await page.locator("#hidden").inputValue()).toBe("");
  });

  test("refuses a read-only field without naming the value", async ({
    page,
  }) => {
    const failure = await enterSecret(page.locator("#readonly"), SECRET, {
      timeout: 500,
    }).catch((error: unknown) => error);
    expect(String(failure)).toMatch(/not editable/);
    expect(String(failure)).not.toContain(SECRET);
  });

  test("refuses an element that is not a text field, by its tag", async ({
    page,
  }) => {
    // A <div> is "editable" to Playwright only with contenteditable; give it that, so the refusal
    // tested is the helper's own.
    await page.locator("#div").evaluate((el) => {
      el.setAttribute("contenteditable", "true");
    });
    const failure = await enterSecret(page.locator("#div"), SECRET).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toMatch(/not a <div>/);
    expect(String(failure)).not.toContain(SECRET);
  });
});

test.describe("holdsSecret", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(FORM);
  });

  test("true for the exact value, false for any other", async ({ page }) => {
    await page.locator("#pw").fill(SECRET);
    expect(await holdsSecret(page.locator("#pw"), SECRET)).toBe(true);
    expect(await holdsSecret(page.locator("#pw"), `${SECRET} `)).toBe(false);
    expect(await holdsSecret(page.locator("#pw"), "")).toBe(false);
  });

  test("false for an element that holds no value", async ({ page }) => {
    expect(await holdsSecret(page.locator("#div"), "")).toBe(false);
  });
});

declare global {
  interface Window {
    /** What {@link FORM}'s listeners recorded. */
    heard: string[];
    /** The changes {@link FORM}'s value tracker saw. */
    changes: number;
  }
}
