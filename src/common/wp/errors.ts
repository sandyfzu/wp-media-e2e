/**
 * Distinct error types for the WordPress automation layer, so steps and reports can tell apart
 * its failure modes — including the two that WP-CLI's ambiguous plugin-removal exit codes cannot
 * (see ./plugin.ts): "expected present but absent" and "still present after removal". The WP-CLI
 * path removes plugins with `wp plugin uninstall` ({@link PluginUninstallFailedError}); the
 * admin-UI Delete action removes them through the browser ({@link PluginDeletionFailedError},
 * see ../pages/plugins.page.ts). {@link PluginActivationFailedError} and
 * {@link PluginDeactivationFailedError} each cover both paths: the admin-UI actions
 * (../pages/plugins.page.ts) and WP-CLI's own (./plugin.ts).
 * {@link DebugLogFatalError} is the one that is not about a plugin action at all: PHP wrote a
 * fatal to `debug.log` while the scenario ran (see ./log.ts).
 */

/** A plugin expected to be installed is absent (e.g. before a removal-under-test). */
export class PluginNotInstalledError extends Error {
  constructor(slug: string) {
    super(`Plugin "${slug}" was expected to be installed, but is absent.`);
    this.name = "PluginNotInstalledError";
  }
}

/**
 * A plugin is not active when it should be — the admin-UI Activate action did not take, or a
 * WP-CLI install with `--activate` left it inactive. Raised from a re-check of the state rather
 * than from an exit code, so it also catches an archive that installed under a directory other
 * than the slug it was expected to carry.
 */
export class PluginActivationFailedError extends Error {
  constructor(slug: string) {
    super(`Plugin "${slug}" could not be activated.`);
    this.name = "PluginActivationFailedError";
  }
}

/** A plugin could not be deactivated (admin UI or WP-CLI). */
export class PluginDeactivationFailedError extends Error {
  constructor(slug: string) {
    super(`Plugin "${slug}" could not be deactivated.`);
    this.name = "PluginDeactivationFailedError";
  }
}

/** A plugin is still installed after a WP-CLI `plugin uninstall` — a genuine uninstall failure. */
export class PluginUninstallFailedError extends Error {
  constructor(slug: string) {
    super(
      `Plugin "${slug}" is still installed after uninstall; uninstall FAILED.`,
    );
    this.name = "PluginUninstallFailedError";
  }
}

/** A plugin is still installed after the admin-UI Delete action — a genuine deletion failure. */
export class PluginDeletionFailedError extends Error {
  constructor(slug: string) {
    super(`Plugin "${slug}" is still installed after delete; deletion FAILED.`);
    this.name = "PluginDeletionFailedError";
  }
}

/** How many fatal lines a {@link DebugLogFatalError} quotes before it truncates. */
const QUOTED_FATALS = 5;

/**
 * PHP wrote one or more fatals to `debug.log` during a scenario — a defect a UI assertion can
 * easily pass straight over, so the scenario fails on it regardless of what the browser saw.
 *
 * The message quotes the first few fatals so the failure is diagnosable from the reporter alone;
 * the full log is attached separately by the caller.
 */
export class DebugLogFatalError extends Error {
  /** Every fatal line the scan matched, in log order. */
  readonly fatals: readonly string[];

  constructor(fatals: readonly string[]) {
    const shown = fatals.slice(0, QUOTED_FATALS);
    const more = fatals.length - shown.length;
    super(
      `PHP wrote ${String(fatals.length)} fatal error(s) to debug.log during this scenario:\n` +
        shown.map((line) => `  ${line.trim()}`).join("\n") +
        (more > 0
          ? `\n  …and ${String(more)} more (see the attached debug.log).`
          : ""),
    );
    this.name = "DebugLogFatalError";
    this.fatals = fatals;
  }
}
