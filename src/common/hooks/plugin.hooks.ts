import { After, Before } from "../fixtures";
import {
  getDebugLogOptions,
  getStopRunningWork,
  readRouting,
} from "../config/metadata";
import {
  HOOK_TIMEOUT_MS,
  PLUGIN_TAG,
  declaredResidue,
  extendedTimeout,
  installPluginUnderTest,
  teardownPluginUnderTest,
} from "./plugin-lifecycle";
import type { ScenarioReport } from "./plugin-lifecycle";
import type { TestInfo } from "@playwright/test";

/**
 * Product-agnostic scenario hooks for the plugin under test, scoped to `@plugin`.
 *
 * A tagged scenario gets the cell's own edition installed and activated beforehand, a `debug.log`
 * scoped to just that scenario, a failure if PHP logged a fatal, and a clean site afterwards —
 * clean including the **files** the plugin wrote, which its own uninstall keeps, and with any work
 * it left running stopped before it is removed. Neither the edition nor the product is named here:
 * the slug comes from the resolved artifact and the product policy from the product's own config,
 * so one hook pair serves `backwpup`, `backwpup-pro` and `wp-rocket` alike.
 *
 * **This file must be listed in every product's `steps` globs.** A hook file outside them is
 * never imported, so its hooks register silently and the lifecycle simply never runs — the
 * failure mode is a scenario that finds no plugin, not an error.
 *
 * The policy itself lives in `./plugin-lifecycle.ts`; this file only binds it to the runtime.
 */

/**
 * Adapts Playwright's `TestInfo` to the narrow {@link ScenarioReport} the teardown gate needs.
 * `status` is populated for `After` hooks (they run as `test.afterEach`), so the gate can tell a
 * scenario that already failed — and therefore wants the log attached — from a clean one.
 */
function scenarioReport(testInfo: TestInfo): ScenarioReport {
  return {
    title: testInfo.title,
    failed:
      testInfo.status !== undefined &&
      testInfo.status !== testInfo.expectedStatus,
    attach: (name, body) =>
      testInfo.attach(name, { body, contentType: "text/plain" }),
  };
}

Before(
  {
    name: "install the plugin under test",
    tags: PLUGIN_TAG,
    timeout: HOOK_TIMEOUT_MS,
  },
  async ({ site, pluginArtifact, $testInfo }) => {
    // Playwright times a scenario and its hooks against one clock, so make room for both hooks
    // before spending any of the budget.
    $testInfo.setTimeout(extendedTimeout($testInfo.timeout));
    const { product } = readRouting($testInfo.project.metadata);
    await installPluginUnderTest(
      site.transport,
      pluginArtifact("plugin"),
      declaredResidue(product),
    );
  },
);

After(
  {
    name: "check debug.log, stop the plugin's running work, remove it and its leftovers",
    tags: PLUGIN_TAG,
    timeout: HOOK_TIMEOUT_MS,
  },
  async ({ site, pluginArtifact, $testInfo }) => {
    const { product } = readRouting($testInfo.project.metadata);
    await teardownPluginUnderTest(
      site.transport,
      pluginArtifact("plugin").slug,
      getDebugLogOptions(product),
      declaredResidue(product),
      scenarioReport($testInfo),
      getStopRunningWork(product),
    );
  },
);
