import { isSkippableSlug } from "../wp/plugin";
import { describePluginDir } from "../wp/plugin-dir";
import type { ClearedPluginDir } from "../wp/plugin";
import type { Transport } from "../config/types";
import type { CheckResult } from "./preflight";

/**
 * A broken copy of the cell's **own** plugin that stops WordPress booting, before any scenario runs.
 *
 * A removal of an active plugin stopped part-way can keep its main file and lose part of `vendor`:
 * WordPress still lists it, still loads it, and every request dies on its fatal — WP-CLI with plugins
 * loaded and the login page alike (measured: `wp eval` exit 1, `wp-login.php` HTTP 500). The `@plugin`
 * Before hook would remove it, but the auth setup fails first, so no scenario ever runs. Blamed only
 * when WordPress boots with that one slug skipped: a site broken for any other reason fails as before.
 */

/** The check's report label. */
export const CELL_PLUGIN_CHECK = "Plugin under test";

/**
 * Removes the cell's plugin from a site — `ensurePluginAbsent` in the auth setup; absent in the
 * read-only healthcheck, which only reports.
 */
export type HealCellPlugin = (
  transport: Transport,
  slug: string,
) => Promise<ClearedPluginDir | undefined>;

/** The cell's plugin that WordPress cannot boot with, and the line its boot died on. */
export interface BrokenCellPlugin {
  readonly slug: string;
  readonly error: string;
}

/**
 * The first of the cell's slugs whose plugin alone stops WordPress booting — asked only after a boot
 * with every plugin loaded failed.
 *
 * @param slugs - the slug(s) the cell installs as.
 * @param bootsWithout - whether WordPress boots with that one plugin skipped.
 * @returns the slug, or `undefined` when skipping none of them helps — WordPress is broken for another
 * reason.
 */
export async function blameCellPlugin(
  slugs: readonly string[],
  bootsWithout: (slug: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const slug of slugs.filter(isSkippableSlug)) {
    if (await bootsWithout(slug)) return slug;
  }
  return undefined;
}

/** The sentence every verdict opens with. */
function cannotBoot(broken: BrokenCellPlugin): string {
  return (
    `WordPress cannot boot with the cell's plugin "${broken.slug}" loaded (${broken.error}), and ` +
    "boots without it: that copy is broken"
  );
}

/** How to remove the copy by hand, for a verdict that leaves it there. */
function byHand(slug: string): string {
  return (
    `remove it by hand: \`wp --skip-plugins plugin deactivate ${slug}\`, then delete ` +
    `wp-content/plugins/${slug}.`
  );
}

/**
 * The passing check once the setup removed the broken copy. Every `@plugin` scenario installs the
 * plugin fresh anyway, and sweeps the database footprint its uninstall could not take.
 *
 * @param broken - the plugin, and why WordPress could not boot with it.
 * @param cleared - what had to be removed by path; `undefined` when WordPress's own uninstall took it.
 */
export function healedCheck(
  broken: BrokenCellPlugin,
  cleared: ClearedPluginDir | undefined,
): CheckResult {
  const what =
    cleared === undefined
      ? "its own uninstall removed it"
      : `removed ${describePluginDir(cleared.dir)}`;
  return {
    name: CELL_PLUGIN_CHECK,
    ok: true,
    detail:
      `${cannotBoot(broken)}, so it was removed before logging in — ${what}. The next @plugin ` +
      "scenario installs it fresh.",
  };
}

/**
 * The failing check when the setup could not remove the broken copy.
 *
 * @param broken - the plugin, and why WordPress could not boot with it.
 * @param reason - why removing it failed.
 */
export function healFailedCheck(
  broken: BrokenCellPlugin,
  reason: string,
): CheckResult {
  return {
    name: CELL_PLUGIN_CHECK,
    ok: false,
    detail: `${cannotBoot(broken)}, and removing it failed: ${reason}`,
    hint: `Nothing can log in until it goes: ${byHand(broken.slug)}`,
  };
}

/**
 * The failing check where nothing may be changed — the healthcheck.
 *
 * @param broken - the plugin, and why WordPress could not boot with it.
 */
export function reportedCheck(broken: BrokenCellPlugin): CheckResult {
  return {
    name: CELL_PLUGIN_CHECK,
    ok: false,
    detail: `${cannotBoot(broken)}.`,
    hint:
      "Nothing can log in until it goes. A suite run on this cell removes it before logging in; or " +
      byHand(broken.slug),
  };
}
