/**
 * The minimum CSS a captured-markup fixture needs to behave like the real page.
 *
 * The fixtures under this directory are raw HTML captured from a live cell; the plugin's compiled
 * Tailwind stylesheet is not captured with them. That is harmless for locator-resolution assertions,
 * but it breaks **click** assertions: BackWPup's toggle proxies are empty `<label>` elements whose
 * only size comes from utility classes (`h-6 w-10`), so without the stylesheet they collapse to a
 * 0×0 box and Playwright — correctly — refuses to click them.
 *
 * So a spec that exercises clicking prepends these rules. They are copied from Tailwind's own
 * definitions rather than invented, and cover only the two behaviours that matter here: `sr-only`
 * clipping and the proxies' geometry. Everything else is deliberately absent, so the fixtures cannot
 * quietly acquire layout the real page does not have.
 */
export const FIXTURE_STYLES = `<style>
/* Tailwind's own .sr-only — the reason these inputs are unclickable and need a proxy. */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0;
}
.hidden { display: none; }
/*
 * The toggle proxies' own utility classes (Tailwind: h-6 = 1.5rem, w-10 = 2.5rem, and inline-flex to
 * make an empty <label> occupy them). Scoped to the classes the plugin actually puts on those
 * elements — deliberately NOT a blanket \`label { min-height }\` rule, which would hand every label a
 * clickable box and let a test pass on geometry the real page does not have.
 */
.inline-flex { display: inline-flex; }
.h-6 { height: 1.5rem; }
.w-10 { width: 2.5rem; }
</style>`;
