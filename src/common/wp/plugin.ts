import { PluginDeletionFailedError, PluginNotInstalledError } from "./errors";
import { wpCli } from "./exec";
import type { Transport } from "../config/types";

/**
 * WordPress plugin lifecycle over WP-CLI (transport-agnostic — see ./exec).
 *
 * Two delete intents are deliberately separated (plan §7.3): idempotent CLEANUP for
 * Before/After hooks (`ensurePluginAbsent` — already-absent ⇒ no-op) vs. asserted
 * DELETION-UNDER-TEST (`deletePlugin` — absent-when-expected ⇒ failure). `wp plugin delete`
 * exits non-zero for both "not found" and a real failure, so its exit code is not trusted;
 * removal is always re-checked with `is-installed` (exit 0 = installed, 1 = not — WP-CLI handbook).
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
 * CLEANUP (idempotent). For Before/After hooks: makes the plugin absent. Already-absent is
 * success (no-op); a genuine failure to delete throws {@link PluginDeletionFailedError}.
 */
export async function ensurePluginAbsent(
  transport: Transport,
  slug: string,
): Promise<void> {
  if (!(await isPluginInstalled(transport, slug))) return;
  await wpCli(transport, ["plugin", "delete", slug]); // exit code ambiguous — re-assert below
  if (await isPluginInstalled(transport, slug)) {
    throw new PluginDeletionFailedError(slug);
  }
}

/**
 * DELETION UNDER TEST. For scenarios that verify the delete flow: the plugin must be present
 * first (throws {@link PluginNotInstalledError} otherwise), then it is deleted and removal is
 * re-asserted (throws {@link PluginDeletionFailedError} if it survives).
 */
export async function deletePlugin(
  transport: Transport,
  slug: string,
): Promise<void> {
  if (!(await isPluginInstalled(transport, slug))) {
    throw new PluginNotInstalledError(slug);
  }
  await wpCli(transport, ["plugin", "delete", slug]);
  if (await isPluginInstalled(transport, slug)) {
    throw new PluginDeletionFailedError(slug);
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
