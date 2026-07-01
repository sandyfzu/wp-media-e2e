/**
 * Distinct error types for the plugin lifecycle, so steps and reports can tell apart its
 * failure modes — including the two that WP-CLI's ambiguous plugin-removal exit codes cannot
 * (see ./plugin.ts): "expected present but absent" and "still present after removal". The WP-CLI
 * path removes plugins with `wp plugin uninstall` ({@link PluginUninstallFailedError}); the
 * admin-UI Delete action removes them through the browser ({@link PluginDeletionFailedError},
 * see ../pages/plugins.page.ts). Deactivation is UI-only.
 */

/** A plugin expected to be installed is absent (e.g. before a removal-under-test). */
export class PluginNotInstalledError extends Error {
  constructor(slug: string) {
    super(`Plugin "${slug}" was expected to be installed, but is absent.`);
    this.name = "PluginNotInstalledError";
  }
}

/** A plugin could not be activated through the admin UI. */
export class PluginActivationFailedError extends Error {
  constructor(slug: string) {
    super(`Plugin "${slug}" could not be activated.`);
    this.name = "PluginActivationFailedError";
  }
}

/** A plugin could not be deactivated through the admin UI. */
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
