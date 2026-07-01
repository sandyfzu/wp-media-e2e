import { PluginNotInstalledError, PluginUninstallFailedError } from "./errors";
import { wpCli } from "./exec";
import type { Transport } from "../config/types";

/**
 * WordPress plugin lifecycle over WP-CLI (transport-agnostic — see ./exec).
 *
 * Removal uses `wp plugin uninstall --deactivate`, NOT `wp plugin delete`. `delete` only removes
 * the plugin's files ("without deactivating or uninstalling" — WP-CLI handbook), so it leaves the
 * plugin's database footprint (options, custom tables, cron events) behind. `uninstall` runs the
 * plugin's uninstall procedure — `uninstall.php`, or the callback registered via
 * `register_uninstall_hook()` — which is where a well-behaved plugin clears that state, and then
 * deletes the files (we do NOT pass `--skip-delete`). `--deactivate` is required: WP-CLI only runs
 * the uninstall procedure on an inactive plugin and otherwise warns and skips, so without it an
 * active plugin would survive. The net effect is a clean baseline for the next scenario.
 *
 * Two removal intents are deliberately separated (plan §7.3): idempotent CLEANUP for Before/After
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
 * CLEANUP (idempotent). For Before/After hooks: uninstalls the plugin so both its files and its
 * database footprint are gone, leaving a clean baseline. Already-absent is success (no-op); a
 * genuine failure to uninstall throws {@link PluginUninstallFailedError}.
 */
export async function ensurePluginAbsent(
  transport: Transport,
  slug: string,
): Promise<void> {
  if (!(await isPluginInstalled(transport, slug))) return;
  // `uninstall --deactivate` fires the uninstall procedure (DB cleanup) and deletes the files;
  // exit code is ambiguous, so re-assert removal below.
  await wpCli(transport, ["plugin", "uninstall", slug, "--deactivate"]);
  if (await isPluginInstalled(transport, slug)) {
    throw new PluginUninstallFailedError(slug);
  }
}

/**
 * UNINSTALL UNDER TEST. For scenarios that verify the uninstall flow: the plugin must be present
 * first (throws {@link PluginNotInstalledError} otherwise), then it is uninstalled — running its
 * uninstall procedure and deleting its files — and removal is re-asserted (throws
 * {@link PluginUninstallFailedError} if it survives).
 */
export async function uninstallPlugin(
  transport: Transport,
  slug: string,
): Promise<void> {
  if (!(await isPluginInstalled(transport, slug))) {
    throw new PluginNotInstalledError(slug);
  }
  await wpCli(transport, ["plugin", "uninstall", slug, "--deactivate"]);
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
