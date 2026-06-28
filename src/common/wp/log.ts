import { exec, wpCli } from "./exec";
import type { Transport } from "../config/types";

/**
 * `wp-content/debug.log` access + scanning, transport-agnostic.
 *
 * Reads/clears via WP-CLI `wp eval` (PHP run inside WordPress), which resolves `WP_CONTENT_DIR`
 * itself — even when customised. But `wp eval` needs WordPress to BOOT, and the log matters most
 * precisely when a fatal has broken that boot. So when `wp eval` exits non-zero we log and fall
 * back to a direct file read/removal that does NOT load WordPress, targeting the conventional
 * `wp-content/debug.log` relative to the WP root — the same working directory the exec layer
 * already runs `wp` in (the container WORKDIR for `docker`, `rootDir` for `ssh`/`local`). A
 * genuinely unreachable transport still throws (the direct call can't run either), so a broken
 * environment is never mistaken for a clean log.
 *
 * Typical use: `clearDebugLog` in a Before hook to scope a scenario, then `scanDebugLog` in a
 * tag-scoped After hook — attaching `raw`, failing on `fatals`, and logging `warnings`/`notices`.
 */

// Run inside WP via `wp eval`; WP_CONTENT_DIR is resolved by WordPress itself.
const READ_DEBUG_LOG =
  'echo (file_exists($f = WP_CONTENT_DIR . "/debug.log") ? file_get_contents($f) : "");';
const CLEAR_DEBUG_LOG =
  'if (file_exists($f = WP_CONTENT_DIR . "/debug.log")) file_put_contents($f, "");';

// Fallback target when `wp eval` can't run: the default location, relative to the WP root.
const DEBUG_LOG_PATH = "wp-content/debug.log";

// PHP error severity tiers, matched against individual lines of debug.log.
// A line may match only one tier in practice (the prefixes are mutually exclusive), but each
// tier is checked independently so no line is silently dropped or double-counted.

/** Stop-or-throw level: fatal, parse, recoverable fatal, DB errors, uncaught exceptions. */
const FATAL_PATTERNS: readonly RegExp[] = [
  /PHP Fatal error/i,
  /PHP Parse error/i,
  /PHP Recoverable fatal error/i,
  /WordPress database error/i,
  /Uncaught (Error|Exception|TypeError)/i,
];

/** Non-fatal but suspicious: execution continues, something is likely wrong. */
const WARNING_PATTERNS: readonly RegExp[] = [/PHP Warning/i];

/** Informational: deprecated usage, strict-standards violations, notices. */
const NOTICE_PATTERNS: readonly RegExp[] = [
  /PHP Notice/i,
  /PHP Deprecated/i,
  /PHP Strict Standards/i,
];

/** Notes that the WP-CLI path failed and the direct file fallback is being used. */
function warnFallback(
  action: "read" | "clear",
  exitCode: number,
  stderr: string,
): void {
  console.warn(
    `[wp/log] \`wp eval\` could not ${action} debug.log (exit ${String(exitCode)}: ${stderr.trim() || "no stderr"}); ` +
      `falling back to a direct file ${action === "read" ? "read" : "removal"}.`,
  );
}

/** Reads `wp-content/debug.log`. Returns `""` when the log does not exist. */
export async function readDebugLog(transport: Transport): Promise<string> {
  const viaCli = await wpCli(transport, ["eval", READ_DEBUG_LOG]);
  if (viaCli.exitCode === 0) {
    return viaCli.stdout;
  }
  warnFallback("read", viaCli.exitCode, viaCli.stderr);
  // Direct read — no WordPress bootstrap. A non-zero exit here means the file is absent
  // (no log yet ⇒ no errors), so degrade to "".
  const direct = await exec(transport, "cat", [DEBUG_LOG_PATH]);
  return direct.exitCode === 0 ? direct.stdout : "";
}

/** Clears `wp-content/debug.log` (use in a Before hook to scope errors to one scenario). */
export async function clearDebugLog(transport: Transport): Promise<void> {
  const viaCli = await wpCli(transport, ["eval", CLEAR_DEBUG_LOG]);
  if (viaCli.exitCode === 0) {
    return;
  }
  warnFallback("clear", viaCli.exitCode, viaCli.stderr);
  // Direct removal — no WordPress bootstrap; WordPress recreates the log on its next write.
  // `rm -f` is a no-op when the file is already absent and is portable (Linux, macOS, BusyBox).
  const direct = await exec(transport, "rm", ["-f", DEBUG_LOG_PATH]);
  if (direct.exitCode !== 0) {
    throw new Error(
      `[wp/log] could not clear debug.log via \`wp eval\` or a direct \`rm\`: ${(direct.stderr || direct.stdout).trim()}`,
    );
  }
}

/** Options for {@link scanDebugLog}. */
export interface ScanDebugLogOptions {
  /** Lines matching any of these are excluded from all categories (known-benign noise). */
  readonly ignore?: readonly RegExp[];
  /**
   * Restrict categorisation to lines matching at least one of these patterns — typically a
   * plugin's path (e.g. `/wp-content\/plugins\/wp-rocket\//`), so a scan attributes entries to
   * that plugin. WordPress writes the originating file path on the same line as the PHP
   * severity prefix, so a path pattern keeps only that plugin's fatals/warnings/notices.
   * Omit to categorise every line (the default — catches errors from any source).
   */
  readonly source?: readonly RegExp[];
}

/** The outcome of scanning `debug.log`, broken down by PHP severity tier. */
export interface DebugLogScan {
  /** The full log contents (may be empty). */
  readonly raw: string;
  /** Fatal errors, parse errors, recoverable fatals, DB errors, uncaught exceptions. */
  readonly fatals: string[];
  /** PHP Warnings — non-fatal but suspicious. */
  readonly warnings: string[];
  /** PHP Notices, Deprecations, Strict Standards — informational. */
  readonly notices: string[];
}

/**
 * Reads `debug.log` and categorises each line by PHP severity tier. Lines matching an `ignore`
 * pattern are dropped; if `source` is set, only lines matching it are categorised. `raw` always
 * holds the complete log (for report attachment), regardless of `source`.
 */
export async function scanDebugLog(
  transport: Transport,
  options: ScanDebugLogOptions = {},
): Promise<DebugLogScan> {
  const raw = await readDebugLog(transport);
  const ignore = options.ignore ?? [];
  const source = options.source ?? [];

  const lines = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !ignore.some((p) => p.test(line)))
    .filter((line) => source.length === 0 || source.some((p) => p.test(line)));

  const match = (patterns: readonly RegExp[]): string[] =>
    lines.filter((line) => patterns.some((p) => p.test(line)));

  return {
    raw,
    fatals: match(FATAL_PATTERNS),
    warnings: match(WARNING_PATTERNS),
    notices: match(NOTICE_PATTERNS),
  };
}
