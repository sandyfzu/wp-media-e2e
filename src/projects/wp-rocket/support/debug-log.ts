import type { ScanDebugLogOptions } from "../../../common/wp/log";

/**
 * Matches debug.log lines originating from WP Rocket's plugin directory. WordPress writes the
 * originating file path on PHP error lines, so this attributes an entry to the plugin.
 */
export const WP_ROCKET_PLUGIN_PATH = /wp-content\/plugins\/wp-rocket\//;

/**
 * Default `scanDebugLog` options for WP Rocket runs. Scans EVERY source (core + all plugins),
 * so a fatal triggered anywhere still surfaces. Add patterns to `ignore` for lines confirmed
 * benign from real test runs — discovered from output, not guessed.
 *
 *   const scan = await scanDebugLog(transport, WP_ROCKET_LOG_OPTIONS);
 *   if (scan.fatals.length > 0) throw new Error(scan.fatals.join("\n"));
 */
export const WP_ROCKET_LOG_OPTIONS: ScanDebugLogOptions = {
  ignore: [
    // Add verified benign patterns here as they are discovered from real test runs.
  ],
};

/**
 * Like {@link WP_ROCKET_LOG_OPTIONS} but restricted to WP Rocket's own entries (by plugin
 * path). Use when a step must assert specifically about WP Rocket and disregard unrelated
 * core/plugin noise.
 */
export const WP_ROCKET_OWN_LOG_OPTIONS: ScanDebugLogOptions = {
  ...WP_ROCKET_LOG_OPTIONS,
  source: [WP_ROCKET_PLUGIN_PATH],
};
