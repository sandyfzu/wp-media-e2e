import { expect } from "@playwright/test";

import { Given, Then, When } from "../fixtures";
import {
  describeFootprint,
  isFootprintEmpty,
  listBackwpupArchives,
  readBackwpupFootprint,
} from "../support/footprint";
import { isPluginInstalled } from "../../../common/wp/plugin";

/**
 * Steps for removing the plugin through wp-admin, and for what that removal leaves behind.
 *
 * Two conventions, both about not believing the screen that performed the action:
 *
 *  - **The removal is asserted from WP-CLI, not from the DOM.** The page object already re-reads
 *    the reloaded plugins screen before it returns, so a `Then` repeating that would only prove the
 *    same query twice. Asking the site instead is a genuinely independent witness, and it is the one
 *    that notices a row disappearing from a screen while the directory is still there.
 *  - **What deletion cleared is read with the plugin's own code gone.** `readBackwpupFootprint`
 *    loads WordPress without plugins, so what comes back is what the site has persisted rather than
 *    what something still running would put back while being asked.
 */

/**
 * A plugin sitting installed but switched off — the state a user reaches Delete from most often,
 * since WordPress only offers the action once a plugin is inactive.
 *
 * Deactivated through the screen rather than through WP-CLI: the scenario is about what a user can
 * do from the plugins page, and its own precondition should not arrive by a route the user has not
 * got. The page object asserts the outcome, so a deactivation that silently failed stops here rather
 * than turning into a confusing deletion failure.
 */
Given("BackWPup is deactivated", async ({ site, pluginArtifact, plugins }) => {
  await plugins.goto();
  await plugins.deactivate(pluginArtifact("plugin").slug);
  expect(
    await isPluginInstalled(site.transport, pluginArtifact("plugin").slug),
    "deactivating should leave the plugin installed",
  ).toBe(true);
});

/**
 * The user-facing deletion: the Delete action on the plugins screen, with the confirmation it
 * raises and the reload that settles it.
 *
 * All of that lives in the plugins page object's `delete`, which deactivates first when it has to,
 * accepts the native `confirm()`, waits for the slug's own AJAX call so the reload cannot race it,
 * and then re-asserts against server-backed DOM. The step is a single call on purpose — a scenario
 * that spelled those out would be describing WordPress's implementation rather than the user's
 * intent.
 */
When(
  "I delete BackWPup from the plugins screen",
  async ({ pluginArtifact, plugins }) => {
    await plugins.goto();
    await plugins.delete(pluginArtifact("plugin").slug);
  },
);

/** The site's own answer, independent of the screen that just claimed to remove it. */
Then(
  "BackWPup is no longer installed on the site",
  async ({ site, pluginArtifact }) => {
    expect(
      await isPluginInstalled(site.transport, pluginArtifact("plugin").slug),
      "the plugin's files should be gone from the site",
    ).toBe(false);
  },
);

/**
 * The half the replaced suite never checked: deleting through wp-admin runs the plugin's
 * `uninstall.php`, so nothing of it should be left in the database.
 *
 * Every kind is reported at once rather than asserted one at a time, because *which* kind survived
 * is the diagnosis — options left behind mean the cleanup did not run at all, roles left behind mean
 * it ran and its role handling is wrong.
 */
Then("the site holds nothing of BackWPup in its database", async ({ site }) => {
  const footprint = await readBackwpupFootprint(site.transport);
  expect(
    isFootprintEmpty(footprint),
    `deleting the plugin should have cleared its database footprint, but the site still holds:\n${describeFootprint(footprint)}`,
  ).toBe(true);
});

/**
 * The other half of the bargain: a user's backups are not the installer's to delete.
 *
 * Counted off the filesystem, since the plugin whose WP-CLI commands would normally answer this has
 * just been removed — which is the whole point. An exact count rather than "at least one": an
 * uninstall that removed *some* archives would slip past a presence check.
 */
Then(
  "the {int} backup(s) it had made is/are still on the site",
  async ({ site }, expected: number) => {
    expect(
      await listBackwpupArchives(site.transport),
      "the archives the plugin made should outlive it",
    ).toHaveLength(expected);
  },
);
