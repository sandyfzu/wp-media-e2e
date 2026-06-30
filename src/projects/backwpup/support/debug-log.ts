import type { ScanDebugLogOptions } from "../../../common/wp/log";

// BackWPup ships as two editions in DIFFERENT plugin directories, so a path pattern must name
// the edition. WordPress writes the originating file path on PHP error lines, so matching the
// directory attributes an entry to the plugin.

/** Free edition — plugin slug `backwpup`. */
export const BACKWPUP_FREE_PLUGIN_PATH = /wp-content\/plugins\/backwpup\//;

/** Pro edition — plugin slug `backwpup-pro`. */
export const BACKWPUP_PRO_PLUGIN_PATH = /wp-content\/plugins\/backwpup-pro\//;

/** Both editions — pass as a `source` to attribute entries to BackWPup regardless of edition. */
export const BACKWPUP_PLUGIN_PATHS: readonly RegExp[] = [
  BACKWPUP_FREE_PLUGIN_PATH,
  BACKWPUP_PRO_PLUGIN_PATH,
];

/**
 * Default `scanDebugLog` options for BackWPup runs. Scans EVERY source (core + all plugins),
 * so a fatal triggered anywhere still surfaces. Add patterns to `ignore` for lines confirmed
 * benign from real test runs — discovered from output, not guessed.
 *
 * @example
 * ```ts
 * const scan = await scanDebugLog(transport, BACKWPUP_LOG_OPTIONS);
 * if (scan.fatals.length > 0) throw new Error(scan.fatals.join("\n"));
 * ```
 */
export const BACKWPUP_LOG_OPTIONS: ScanDebugLogOptions = {
  ignore: [
    // Add verified benign patterns here as they are discovered from real test runs.
  ],
};

/**
 * Like {@link BACKWPUP_LOG_OPTIONS} but restricted to BackWPup's own entries — either edition.
 * The same object works for a Free or a Pro cell: only the installed edition's path appears in
 * the log, so matching both is safe. Use when a step must assert specifically about BackWPup
 * and disregard unrelated core/plugin noise.
 */
export const BACKWPUP_OWN_LOG_OPTIONS: ScanDebugLogOptions = {
  ...BACKWPUP_LOG_OPTIONS,
  source: BACKWPUP_PLUGIN_PATHS,
};
