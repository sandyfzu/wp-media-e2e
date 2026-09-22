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
 * fatal to `debug.log` while the scenario ran (see ./log.ts), and
 * {@link SiteResidueRemovalFailedError} is about what a plugin left on the *filesystem* after it
 * was removed (see ./residue.ts).
 */

// Type-only, so it is erased at runtime and this module stays free of a cycle with the exec layer.
import type { ElevationSupport } from "./exec";

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

/**
 * The operator's next step after residue survived, which depends entirely on how far privileges
 * reached — "make it writable" is useless advice if the delete already ran as root, and misleading
 * if elevation was switched off.
 */
function residueAdvice(elevation: ElevationSupport): string {
  switch (elevation) {
    case "available":
      return (
        "These survived an elevated `rm -rf`, so permissions are not what is holding them: look " +
        "for a read-only mount, an immutable attribute, or a process still writing to them."
      );
    case "unavailable":
      return (
        "The transport's user cannot unlink inside them, and it has no passwordless `sudo` on " +
        "this host to fall back on. Grant it that, or make the paths writable by it."
      );
    case "disabled":
      return (
        "The transport's user cannot unlink inside them, and this site declares " +
        "`transport.elevate: false`, so cleanup did not escalate. Allow elevation, or make the " +
        "paths writable by that user."
      );
    default: {
      const exhaustive: never = elevation;
      throw new Error(`unsupported elevation state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Data a plugin wrote to the site's filesystem is still there after cleanup tried to remove it.
 *
 * Distinct from a failed uninstall: the plugin may be perfectly gone while the archives, logs or
 * caches it produced remain — residue that accumulates across runs until the cell runs out of disk
 * (see ./residue.ts). Naming every survivor at once, because a cleanup that half-worked is more
 * confusing than one that did not run.
 */
export class SiteResidueRemovalFailedError extends Error {
  /** The absolute paths that were still present after removal. */
  readonly paths: readonly string[];

  /** How far privileges could go on this site — what makes the advice in the message actionable. */
  readonly elevation: ElevationSupport;

  constructor(paths: readonly string[], elevation: ElevationSupport) {
    super(
      `Left-over plugin data could not be removed from the site; ${String(paths.length)} ` +
        `path(s) survived:\n${paths.map((path) => `  ${path}`).join("\n")}\n` +
        `  ${residueAdvice(elevation)}`,
    );
    this.name = "SiteResidueRemovalFailedError";
    this.paths = paths;
    this.elevation = elevation;
  }
}

/**
 * A plugin's database footprint is still there after the sweep tried to remove it.
 *
 * Unlike its filesystem counterpart this has no permissions dimension to excuse it — the same
 * WP-CLI connection that read the rows is the one that deleted them — so reaching here means
 * something is actively putting them back, which is what a still-installed copy of the plugin does
 * on every request. Naming every survivor at once, because the *shape* of what stayed is the clue:
 * options alone point at a filter, the table alone at a second process re-creating it.
 */
export class SiteDbResidueRemovalFailedError extends Error {
  /** The option names still present after removal. */
  readonly options: readonly string[];

  /** The tables still present after removal, at their full prefixed names. */
  readonly tables: readonly string[];

  constructor(options: readonly string[], tables: readonly string[]) {
    const survivors = [
      ...options.map((option) => `  option ${option}`),
      ...tables.map((table) => `  table  ${table}`),
    ];
    super(
      `A plugin's leftover database footprint could not be removed from the site; ` +
        `${String(survivors.length)} item(s) survived:\n${survivors.join("\n")}\n` +
        "  Check that the plugin is really uninstalled — an installed copy re-creates its own " +
        "options and tables on every request, so nothing can be swept while it is there.",
    );
    this.name = "SiteDbResidueRemovalFailedError";
    this.options = options;
    this.tables = tables;
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
