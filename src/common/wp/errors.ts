/**
 * Distinct error types for the plugin lifecycle, so steps and reports can tell apart its
 * failure modes — including the two that `wp plugin delete`'s ambiguous exit code cannot
 * (see ./plugin.ts), and the UI-only deactivation step (see ../pages/plugins.page.ts).
 */

/** A plugin expected to be installed is absent (e.g. before a deletion-under-test). */
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

/** A plugin is still installed after a delete attempt — a genuine deletion failure. */
export class PluginDeletionFailedError extends Error {
  constructor(slug: string) {
    super(`Plugin "${slug}" is still installed after delete; deletion FAILED.`);
    this.name = "PluginDeletionFailedError";
  }
}
