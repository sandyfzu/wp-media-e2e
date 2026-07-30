import { DebugLogFatalError, PluginActivationFailedError } from "../wp/errors";
import { clearDebugLog, scanDebugLog } from "../wp/log";
import { ensurePluginAbsent, isPluginActive } from "../wp/plugin";
import { stageAndInstallPlugin } from "../wp/staging";
import { errorMessage } from "../guards";
import type { ScanDebugLogOptions } from "../wp/log";
import type { ResolvedArtifact } from "../artifacts/types";
import type { Transport } from "../config/types";

/**
 * The policy behind the {@link PLUGIN_TAG} scenario hooks: what "a freshly installed plugin under
 * test, and a verdict on what PHP logged" actually means. Split out from `./plugin.hooks.ts` so
 * it is unit-testable against a stub `wp`, leaving that file a thin binding to the BDD runtime.
 *
 * Two operations, mirroring the hook pair:
 *  - {@link installPluginUnderTest} — scope the log, guarantee a clean baseline, install.
 *  - {@link teardownPluginUnderTest} — judge what PHP wrote, then restore the baseline.
 */

/**
 * Tag that opts a scenario into the plugin lifecycle: the artifact under test is installed and
 * activated before it runs, `debug.log` is scoped to it and checked afterwards, and the plugin is
 * removed again. Opt-in rather than automatic, because scenarios that assert on a site *without*
 * the plugin (or need no site at all) must not pay for an install.
 */
export const PLUGIN_TAG = "@plugin";

/**
 * Budget for one hook's worth of WP-CLI round-trips and file transfer. Generous because the work is
 * remote. Measured per phase against an SSH-hosted staging box, installing a 9.2 MB / 5822-file
 * plugin: clear ~1.5 s, remove-when-absent ~1.5 s, upload ~4.5 s, install+activate ~3.5 s,
 * re-assert ~2 s ⇒ **Before ≈ 13 s**; scan ~2 s, remove-when-present ~10 s ⇒ **After ≈ 12 s**.
 * A plugin whose uninstall procedure does more, a slower link, or a busier host multiply those, so
 * the budget keeps room for roughly a 4–5× worse environment before it fires.
 *
 * Applied per hook — so a hang is reported as a hook timeout naming the hook, rather than as an
 * opaque scenario timeout — **and** added to the scenario's own budget by {@link extendedTimeout},
 * since Playwright times a scenario and its hooks against one clock. The trade-off of raising it
 * is how long a genuinely stuck scenario takes to fail: a default 30 s scenario becomes 30 s + 2 ×
 * this.
 */
export const HOOK_TIMEOUT_MS = 120_000;

/**
 * Cap on the `debug.log` body attached to a report, in characters. A fatal inside a loop, or one
 * raised by a hook that fires per row, turns a scenario's log into megabytes; attaching that to
 * every failing scenario bloats reports and CI artifact uploads for no diagnostic gain. ~256k
 * characters is thousands of lines — far more than anyone reads.
 */
export const MAX_ATTACHED_LOG_CHARS = 256 * 1024;

/**
 * Bounds a log for attachment, keeping the **start**: the first occurrence is the root cause, and
 * everything after a repeating fatal is that same line again. A truncated body says so and gives
 * both sizes, so nobody mistakes it for the whole log.
 *
 * Counted in characters, not bytes — a plain `.length` check, which for a PHP error log is
 * effectively the same thing and never needs the log encoded twice just to measure it.
 */
export function boundLogForAttachment(raw: string): string {
  if (raw.length <= MAX_ATTACHED_LOG_CHARS) return raw;
  return (
    `${raw.slice(0, MAX_ATTACHED_LOG_CHARS)}\n\n` +
    `[truncated by the test suite: first ${String(MAX_ATTACHED_LOG_CHARS)} of ` +
    `${String(raw.length)} characters; the rest is not retained]\n`
  );
}

/**
 * The scenario timeout a {@link PLUGIN_TAG} scenario needs: its own budget plus room for both
 * lifecycle hooks. Additive on purpose — a scenario that asked for more time (a slow backup job)
 * keeps every millisecond it asked for.
 *
 * @param current - the scenario's effective timeout, `testInfo.timeout`.
 * @returns the extended timeout, or `0` unchanged — zero means "no timeout" in Playwright, so
 * adding to it would silently impose one.
 */
export function extendedTimeout(current: number): number {
  return current === 0 ? 0 : current + 2 * HOOK_TIMEOUT_MS;
}

/**
 * Prepares a site for a scenario that tests a plugin: clears `debug.log`, removes any existing
 * copy of the plugin, then installs and activates the resolved artifact.
 *
 * The order is deliberate. Clearing **first** scopes the log to this scenario yet still captures
 * anything the removal itself triggers — a fatal in the outgoing plugin's uninstall procedure is
 * a real defect and must not be cleared away. Removing before installing is what makes the
 * install *fresh*: `ensurePluginAbsent` runs that uninstall procedure, so leftover options and
 * tables from an earlier (or crashed) run cannot leak into this scenario's assertions.
 *
 * The install is followed by an explicit **is-it-active?** check rather than trusting
 * `wp plugin install --activate` to fail loudly, mirroring the discipline the removal path already
 * applies to WP-CLI's ambiguous exit codes. It is also the one assertion that catches an archive
 * installing under a different directory than the slug the artifact promised: every tagged
 * scenario assumes an *active* plugin at that slug, and without this check a silent
 * non-activation would surface much later as a baffling UI failure.
 *
 * @param transport - the target site's transport.
 * @param artifact - the resolved artifact under test. Its `slug` addresses the plugin without
 * knowing the edition, and its `zipPath` is staged onto the site first — a runner path means
 * nothing to a remote `wp`.
 * @throws Error if the removal or the install fails, or
 * {@link PluginActivationFailedError} if the plugin is not active afterwards.
 */
export async function installPluginUnderTest(
  transport: Transport,
  artifact: ResolvedArtifact,
): Promise<void> {
  await clearDebugLog(transport);
  await ensurePluginAbsent(transport, artifact.slug);
  await stageAndInstallPlugin(transport, artifact.zipPath, { activate: true });
  if (!(await isPluginActive(transport, artifact.slug))) {
    throw new PluginActivationFailedError(artifact.slug);
  }
}

/**
 * Where {@link teardownPluginUnderTest} reports to — the scenario's identity, its result so far,
 * and its attachment sink. Narrowed to just these, which is what lets the gate be tested without a
 * Playwright `TestInfo`.
 */
export interface ScenarioReport {
  /** The scenario's title, so a console line names which scenario it came from under parallelism. */
  readonly title: string;
  /** Whether the scenario has already failed (then the log is attached for diagnosis either way). */
  readonly failed: boolean;
  /** Attaches a text body to the scenario's report. */
  attach(name: string, body: string): Promise<void>;
}

/**
 * Closes out a plugin scenario: judge what PHP wrote to `debug.log`, then remove the plugin.
 *
 * Both duties always run, and the **debug-log verdict wins** when both fail — it is a statement
 * about the product under test, whereas a cleanup failure is about the environment. A cleanup
 * failure is never merely swallowed though: it is thrown when it is the only failure (a site left
 * with a half-removed plugin would break every later scenario on this worker for a reason none of
 * them can explain), and logged when a fatal already claimed the verdict.
 *
 * The log is judged **as the scenario left it**, before cleanup, so the verdict is about the
 * scenario and not about this hook's own uninstall. A removal the scenario itself performs is a
 * step, so it falls inside that window and is judged normally.
 *
 * @param transport - the target site's transport.
 * @param slug - the plugin slug to remove; from the resolved artifact, so no edition branching.
 * @param options - the product's `debug.log` scan preset (`ignore` / `source` patterns).
 * @param report - the scenario's result and attachment sink.
 * @throws {@link DebugLogFatalError} when PHP logged a fatal, else whatever
 * {@link ensurePluginAbsent} threw when cleanup was the only failure.
 */
export async function teardownPluginUnderTest(
  transport: Transport,
  slug: string,
  options: ScanDebugLogOptions,
  report: ScenarioReport,
): Promise<void> {
  let failure: Error | undefined;

  try {
    await checkDebugLog(transport, options, report);
  } catch (error) {
    failure = toError(error);
  }

  try {
    await ensurePluginAbsent(transport, slug);
  } catch (error) {
    if (failure === undefined) {
      failure = toError(error);
    } else {
      console.error(
        `[hooks] cleanup also failed while reporting the debug.log fatal above: ${errorMessage(error)}`,
      );
    }
  }

  if (failure !== undefined) throw failure;
}

/**
 * Narrows a caught `unknown` to an `Error`, passing a real one through untouched so the typed
 * error (e.g. {@link DebugLogFatalError}) survives all the way to the reporter.
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(errorMessage(value));
}

/**
 * Reads `debug.log` and turns it into a verdict on the scenario.
 *
 * A PHP fatal is a defect no UI assertion is guaranteed to notice — WordPress may render a
 * perfectly plausible page around it — so a fatal fails the scenario outright. Warnings and
 * notices are reported to the console instead: worth seeing, but too common in a real WordPress
 * install to gate on, and the product's `ignore` preset is the place to silence the ones
 * confirmed benign.
 *
 * The log is attached when it can help — on a fatal, or whenever the scenario failed for any
 * other reason, which is exactly when the log usually holds the cause; a passing, quiet scenario
 * attaches nothing, and what is attached is bounded ({@link boundLogForAttachment}), so reports
 * stay small either way.
 *
 * @throws {@link DebugLogFatalError} when the scan matched at least one fatal.
 */
async function checkDebugLog(
  transport: Transport,
  options: ScanDebugLogOptions,
  report: ScenarioReport,
): Promise<void> {
  const scan = await scanDebugLog(transport, options);

  if (scan.raw !== "" && (report.failed || scan.fatals.length > 0)) {
    // Attaching is diagnostics: a reporter fault must never replace the real verdict.
    const body = boundLogForAttachment(scan.raw);
    await report.attach("debug.log", body).catch((error: unknown) => {
      console.warn(
        `[hooks] could not attach debug.log: ${errorMessage(error)}`,
      );
    });
  }

  if (scan.warnings.length + scan.notices.length > 0) {
    // Named, because several workers write to one terminal — and the name is what tells you which
    // scenario to reproduce, or whose lines belong in the product's `ignore` preset.
    console.warn(
      `[hooks] debug.log for "${report.title}": ${String(scan.warnings.length)} warning(s), ` +
        `${String(scan.notices.length)} notice(s).`,
    );
  }

  if (scan.fatals.length > 0) throw new DebugLogFatalError(scan.fatals);
}
