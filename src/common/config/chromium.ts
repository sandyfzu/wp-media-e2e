/**
 * Chromium launch arguments — specifically, the one Playwright default this suite has to undo when
 * somebody is watching the browser.
 *
 * **The symptom.** Completing BackWPup's onboarding navigates POST → redirect → first-backup screen →
 * dashboard. From the moment that chain starts, the tab **stops rendering entirely**: in a headed run
 * the window goes blank and stays blank, videos record nothing, and `page.screenshot()` hangs until
 * it times out. Scenarios still pass, because assertions read the DOM over CDP and the DOM is fine —
 * so the failure is invisible except to a human watching, which is exactly when it matters.
 *
 * **What it actually is.** Measured with `requestAnimationFrame`: 84 frames/0.7s before the submit,
 * **0 after**, and it never recovers — not on the next navigation, not on a reload, not after
 * `bringToFront`. The main thread stays responsive throughout (`page.evaluate` works, `setTimeout`
 * fires), and a *new* page in the same context renders normally, so the wedge belongs to the tab's
 * rendering pipeline rather than to the document, the renderer process or the site. Raw CDP
 * `Page.captureScreenshot` hangs identically, which rules Playwright out as the cause.
 *
 * **The cause.** Playwright launches Chromium with `RenderDocument` in its `--disable-features` list
 * ({@link PLAYWRIGHT_DISABLED_FEATURES}). Bisected one feature at a time against this flow: with
 * `RenderDocument` disabled the tab wedges, with it enabled the tab renders (84 → 84 frames) and
 * screenshots take ~46ms. Nothing else in the list matters, and no compositor-level flag avoids it —
 * `--run-all-compositor-stages-before-draw`, `--disable-gpu-compositing` and
 * `--disable-new-content-rendering-timeout` all still wedge, and `--disable-threaded-compositing`
 * breaks clicks outright.
 *
 * **Why it is not simply switched back on for every run.** Playwright disables `RenderDocument`
 * deliberately (microsoft/playwright#37714): with it enabled Chromium reports an extra utility
 * context, which breaks Playwright's isolated worlds and can error when a script is evaluated right
 * after a navigation. That is a flake risk on every navigation in the suite, traded against a
 * cosmetic problem — a bad deal for CI. So the override applies **only when a human is watching**
 * ({@link wantsVisibleBrowser}), and unattended runs keep Playwright's defaults exactly as shipped.
 *
 * **Signalled by environment, not by `--headed`,** because Playwright re-evaluates this config in
 * every *worker* process, and a worker's `process.argv` does not carry the CLI's flags — the browser
 * is launched there, so sniffing argv looks right and silently does nothing (measured: with argv
 * detection the flag never reached the launch command line). The `:headed` and `:ui` npm scripts
 * therefore export {@link VISIBLE_BROWSER_ENV}, which workers do inherit, and `--debug` needs nothing
 * because Playwright already exports `PWDEBUG` for it.
 *
 * A failed CI run needs no flag: **traces are DOM snapshots, not pixels**, so the trace viewer
 * replays a wedged tab correctly even though its video is blank.
 */

/** Env var that forces the override on (or off, with `0`) regardless of how the run was invoked. */
export const VISIBLE_BROWSER_ENV = "E2E_VISIBLE_BROWSER";

/** The Chromium feature whose *absence* wedges the tab. Enabled by removing it from the list below. */
export const FRAME_REUSE_FEATURE = "RenderDocument";

/**
 * Playwright's own `--disable-features` value, verbatim.
 *
 * Reproduced rather than patched because Chromium takes the **last** `--disable-features` on the
 * command line, so re-enabling one feature means re-stating the rest — and dropping the rest would
 * quietly lose protections this suite depends on (`HttpsUpgrades` alone would rewrite an `http://`
 * docker site to `https://`).
 *
 * Captured from **Playwright 1.61.1**. A version bump can change it, which the sibling spec pins:
 * it fails when the installed minor version moves, so the list is re-read deliberately instead of
 * drifting out of date in silence.
 */
export const PLAYWRIGHT_DISABLED_FEATURES: readonly string[] = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "BoundaryEventDispatchTracksNodeRemoval",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "Translate",
  "AutoDeElevate",
  FRAME_REUSE_FEATURE,
  "OptimizationHints",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
];

/** The Playwright minor version {@link PLAYWRIGHT_DISABLED_FEATURES} was read from. */
export const CAPTURED_FROM_PLAYWRIGHT = "1.61";

/**
 * Whether this run has somebody watching the browser, and so should trade Playwright's
 * `RenderDocument` default for a tab that keeps painting.
 *
 * True when {@link VISIBLE_BROWSER_ENV} is set to anything but `0`/`false` — which the `:headed` and
 * `:ui` npm scripts do — or when `PWDEBUG` is set, as Playwright's `--debug` exports it. Setting
 * {@link VISIBLE_BROWSER_ENV} to `0` forces the override off even then, which is the escape hatch if
 * enabling the feature ever misbehaves. A direct `npx playwright test --headed` needs the variable
 * exported by hand, for the worker-argv reason in this module's header.
 *
 * @param env - the environment, as `process.env`.
 */
export function wantsVisibleBrowser(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const forced = env[VISIBLE_BROWSER_ENV];
  if (forced !== undefined && forced !== "") {
    return forced !== "0" && forced.toLowerCase() !== "false";
  }
  const debugging = env.PWDEBUG;
  return debugging !== undefined && debugging !== "" && debugging !== "0";
}

/**
 * The `launchOptions` for this run: Playwright's defaults untouched, or the same defaults with
 * {@link FRAME_REUSE_FEATURE} re-enabled when {@link wantsVisibleBrowser}.
 *
 * Returns an empty object rather than an empty `args` array in the unattended case, so an ordinary
 * run's command line is byte-for-byte what Playwright would have produced on its own.
 *
 * @param env - the environment, as `process.env`.
 */
export function chromiumLaunchOptions(
  env: Readonly<Record<string, string | undefined>>,
): { readonly args?: string[] } {
  if (!wantsVisibleBrowser(env)) return {};
  const kept = PLAYWRIGHT_DISABLED_FEATURES.filter(
    (feature) => feature !== FRAME_REUSE_FEATURE,
  );
  return { args: [`--disable-features=${kept.join(",")}`] };
}
