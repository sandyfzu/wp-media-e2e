import {
  PluginDeactivationFailedError,
  PluginNotInstalledError,
  PluginUninstallFailedError,
} from "./errors";
import { flushObjectCache } from "./cache";
import { wpCli } from "./exec";
import type { Transport } from "../config/types";

/**
 * WordPress plugin lifecycle over WP-CLI (transport-agnostic — see ./exec).
 *
 * Removal uses `wp plugin uninstall`, NOT `wp plugin delete`. `delete` only removes the plugin's
 * files ("without deactivating or uninstalling" — WP-CLI handbook), so it leaves the plugin's
 * database footprint (options, custom tables, cron events) behind. `uninstall` runs the plugin's
 * uninstall procedure — `uninstall.php`, or the callback registered via
 * `register_uninstall_hook()` — which is where a well-behaved plugin clears that state, and then
 * deletes the files (we do NOT pass `--skip-delete`).
 *
 * Deactivate and uninstall are always TWO SEPARATE WP-CLI calls — never `uninstall --deactivate`.
 * That flag deactivates and uninstalls in one PHP process, but the plugin's main file was already
 * `include`d for that process to boot, and PHP cannot unload an include: deactivating just flips
 * a DB flag, it doesn't remove the plugin's class from memory. So the uninstall procedure still
 * finds the plugin "loaded", and a well-behaved plugin guards its uninstall.php against exactly
 * that (loaded ⇒ might still be active ⇒ skip) — cleanup silently never runs. Deactivating first,
 * as its own WP-CLI call, means the second call (plain `uninstall`, no `--deactivate` — the
 * plugin is already inactive, so passing it would just draw a WP-CLI warning) starts a fresh PHP
 * process that never loads the plugin at all, so its guard passes and cleanup actually runs.
 *
 * Two removal intents are deliberately separated: idempotent CLEANUP for Before/After
 * hooks (`ensurePluginAbsent` — already-absent ⇒ no-op) vs. asserted REMOVAL-UNDER-TEST
 * (`uninstallPlugin` — absent-when-expected ⇒ failure). `wp plugin uninstall` exits non-zero for
 * both "not found" and a real failure, so its exit code is not trusted; removal is always
 * re-checked with `is-installed` (exit 0 = installed, 1 = not — WP-CLI handbook), which stays
 * authoritative because uninstall deletes the files too.
 */

/** True if the plugin is installed (regardless of active state). */
export async function isPluginInstalled(
  transport: Transport,
  slug: string,
): Promise<boolean> {
  const { exitCode } = await wpCli(transport, ["plugin", "is-installed", slug]);
  return exitCode === 0;
}

/** True if the plugin is installed AND active. */
export async function isPluginActive(
  transport: Transport,
  slug: string,
): Promise<boolean> {
  const { exitCode } = await wpCli(transport, ["plugin", "is-active", slug]);
  return exitCode === 0;
}

/**
 * CLEANUP (idempotent). Deactivates the plugin if it's active, then no-ops — nothing left to do.
 * A genuine failure to deactivate throws {@link PluginDeactivationFailedError}. Always its own
 * WP-CLI call, kept separate from uninstall — see the module doc for why.
 */
export async function ensurePluginDeactivated(
  transport: Transport,
  slug: string,
): Promise<void> {
  if (!(await isPluginActive(transport, slug))) return;
  await wpCli(transport, ["plugin", "deactivate", slug]);
  if (await isPluginActive(transport, slug)) {
    throw new PluginDeactivationFailedError(slug);
  }
}

/**
 * CLEANUP (idempotent). For Before/After hooks: uninstalls the plugin so both its files and its
 * database footprint are gone, leaving a clean baseline. Already-absent is success; a genuine
 * failure to uninstall throws {@link PluginUninstallFailedError}.
 *
 * **The object-cache flush runs even when there was nothing to uninstall**, which is the one place
 * this function is not a no-op on an already-absent plugin. The point of the flush is that "absent"
 * should mean absent *to WordPress*, and the state that can outlive a removal was not necessarily
 * written by the removal this call performed — a run that was killed between uninstall and teardown
 * leaves exactly that. Skipping it on the cheap path would make the baseline depend on which
 * previous run happened to end tidily. It is best-effort and cannot fail this call — see
 * {@link flushObjectCache}, which also explains why it is a no-op on a cell with no persistent
 * cache, as ours are expected to be.
 */
export async function ensurePluginAbsent(
  transport: Transport,
  slug: string,
): Promise<void> {
  if (await isPluginInstalled(transport, slug)) {
    // Deactivate first, as its own WP-CLI call — see the module doc for why `uninstall
    // --deactivate` can't be trusted to run the plugin's cleanup.
    await ensurePluginDeactivated(transport, slug);
    // Fires the uninstall procedure (DB cleanup) and deletes the files; exit code is ambiguous,
    // so re-assert removal below.
    await wpCli(transport, ["plugin", "uninstall", slug]);
    if (await isPluginInstalled(transport, slug)) {
      throw new PluginUninstallFailedError(slug);
    }
  }
  await flushObjectCache(transport);
}

/**
 * UNINSTALL UNDER TEST. For scenarios that verify the uninstall flow: the plugin must be present
 * first (throws {@link PluginNotInstalledError} otherwise), then deactivated (its own WP-CLI
 * call — see the module doc for why) and uninstalled — running its uninstall procedure and
 * deleting its files — and removal is re-asserted (throws {@link PluginUninstallFailedError} if
 * it survives).
 */
export async function uninstallPlugin(
  transport: Transport,
  slug: string,
): Promise<void> {
  if (!(await isPluginInstalled(transport, slug))) {
    throw new PluginNotInstalledError(slug);
  }
  await ensurePluginDeactivated(transport, slug);
  await wpCli(transport, ["plugin", "uninstall", slug]);
  if (await isPluginInstalled(transport, slug)) {
    throw new PluginUninstallFailedError(slug);
  }
}

/** Options for {@link installPlugin}. */
export interface InstallPluginOptions {
  /** Activate immediately after install. */
  readonly activate?: boolean;
  /** Reinstall/overwrite if already present (`--force`). */
  readonly force?: boolean;
}

/** Installs a plugin from a source (slug, local zip path, or URL). Throws on a non-zero exit. */
export async function installPlugin(
  transport: Transport,
  source: string,
  options: InstallPluginOptions = {},
): Promise<void> {
  const args = ["plugin", "install", source];
  if (options.force) args.push("--force");
  if (options.activate) args.push("--activate");
  const { exitCode, stderr } = await wpCli(transport, args);
  if (exitCode !== 0) {
    throw new Error(
      `[wp/plugin] install "${source}" failed (exit ${String(exitCode)}): ${stderr.trim()}`,
    );
  }
}

/** Activates an installed plugin. Throws on a non-zero exit. */
export async function activatePlugin(
  transport: Transport,
  slug: string,
): Promise<void> {
  const { exitCode, stderr } = await wpCli(transport, [
    "plugin",
    "activate",
    slug,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[wp/plugin] activate "${slug}" failed (exit ${String(exitCode)}): ${stderr.trim()}`,
    );
  }
}
