import { test, expect } from "@playwright/test";

import { expectPanelClosed, expectPanelOpen } from "./panels";

/**
 * `expectPanelOpen` / `expectPanelClosed` against BackWPup's real sidebar mechanics.
 *
 * The fixture reproduces the only two things that decide the answer: an aside pinned to the right edge
 * (`#backwpup-sidebar`, `fixed … right-0 w-[410px]`) which `closeSidebar()` parks by adding
 * `translate-x-[450px]`, and the articles inside it, of which `openSidebar()` shows exactly one.
 * Geometry is written as inline style rather than those utility classes because the compiled Tailwind
 * sheet is not available here — `translate-x-[450px]` *is* `transform: translateX(450px)`.
 *
 * The first test is the one that matters: it pins the false pass these helpers exist to remove, so if a
 * future refactor swaps them back for `toBeVisible()`, the reason is recorded right here.
 */

const VIEWPORT_WIDTH = 1280;

/** The aside plus two panels — `open` picks which is shown, `parked` whether the aside is closed. */
const ASIDE = (options: { parked: boolean; shown: "a" | "b" }): string => `
<div style="width:${String(VIEWPORT_WIDTH)}px">
  <aside id="backwpup-sidebar"
         style="position:fixed; top:0; right:0; bottom:0; width:410px;
                transform: translateX(${options.parked ? "450px" : "0px"});">
    <article id="sidebar-a" style="display:${options.shown === "a" ? "block" : "none"}">
      <h1>Panel A</h1>
    </article>
    <article id="sidebar-b" style="display:${options.shown === "b" ? "block" : "none"}">
      <h1>Panel B</h1>
    </article>
  </aside>
</div>`;

test.describe("expectPanelOpen", () => {
  test("the parked aside still reports its panel visible — the false pass being removed", async ({
    page,
  }) => {
    await page.setContent(ASIDE({ parked: true, shown: "a" }));
    const panel = page.locator("#sidebar-a");

    // This is what a page object used to assert, and it passes on a panel the user cannot reach.
    await expect(panel).toBeVisible();
    // Proof it really is off-screen: the aside is 410px wide at right:0, pushed a further 450px right.
    const box = await panel.boundingBox();
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(VIEWPORT_WIDTH);

    await expect(
      expectPanelOpen(panel, { timeout: 500 }),
      "expectPanelOpen must reject a panel in a parked aside",
    ).rejects.toThrow();
  });

  test("accepts the shown panel once the aside is un-parked", async ({
    page,
  }) => {
    await page.setContent(ASIDE({ parked: false, shown: "a" }));
    await expectPanelOpen(page.locator("#sidebar-a"));
  });

  test("rejects a panel that is not the one on show", async ({ page }) => {
    // `openSidebar()` hides every article before showing the requested one, so this is the case the
    // retained `toBeVisible()` check reports — with the right reason, rather than "not in viewport".
    await page.setContent(ASIDE({ parked: false, shown: "a" }));
    await expect(
      expectPanelOpen(page.locator("#sidebar-b"), { timeout: 500 }),
    ).rejects.toThrow();
  });

  test("is not fooled by a panel taller than the viewport", async ({
    page,
  }) => {
    // Why the helper uses the default intersection ratio and not `{ ratio: 1 }`: a long provider form
    // (S3's) exceeds the viewport, and demanding full containment could never pass.
    await page.setContent(`
      <aside id="backwpup-sidebar" style="position:fixed; top:0; right:0; width:410px; transform:translateX(0px)">
        <article id="sidebar-tall" style="display:block; height:4000px">tall</article>
      </aside>`);
    await expectPanelOpen(page.locator("#sidebar-tall"));
  });
});

test.describe("expectPanelClosed", () => {
  test("accepts a parked aside", async ({ page }) => {
    await page.setContent(ASIDE({ parked: true, shown: "a" }));
    await expectPanelClosed(page.locator("#sidebar-a"));
  });

  test("rejects a panel that is still on screen", async ({ page }) => {
    await page.setContent(ASIDE({ parked: false, shown: "a" }));
    await expect(
      expectPanelClosed(page.locator("#sidebar-a"), { timeout: 500 }),
    ).rejects.toThrow();
  });

  test("does not require the panel to be display:none, which never happens", async ({
    page,
  }) => {
    // `closeSidebar()` only parks the aside; it never hides the articles. A `toBeHidden()` check in
    // `FrequencySidebar.close()` would therefore hang forever — this records why.
    await page.setContent(ASIDE({ parked: true, shown: "a" }));
    const panel = page.locator("#sidebar-a");
    await expect(panel).toBeVisible();
    await expectPanelClosed(panel);
  });
});
