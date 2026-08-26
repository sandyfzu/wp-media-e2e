import {
  DebugLogFatalError,
  PluginActivationFailedError,
  SiteResidueRemovalFailedError,
} from "../wp/errors";
import { clearDebugLog, scanDebugLog } from "../wp/log";
import { ensurePluginAbsent, isPluginActive } from "../wp/plugin";
import { prepareSiteDataDirs, removeSiteResidue } from "../wp/residue";
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
 *  - {@link teardownPluginUnderTest} — judge what PHP wrote, then restore the baseline: remove the
 *    plugin *and* the data it left on disk, which its uninstall deliberately keeps.
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
 * Last, the plugin's own **data directories are opened to both users** that share this site's
 * docroot. On a real cell WP-CLI and the web server are different users, and whichever of them
 * creates one of those directories first would otherwise lock the other out of it — see
 * {@link prepareSiteDataDirs} for the fatal that caused.
 *
 * @param transport - the target site's transport.
 * @param artifact - the resolved artifact under test. Its `slug` addresses the plugin without
 * knowing the edition, and its `zipPath` is staged onto the site first — a runner path means
 * nothing to a remote `wp`.
 * @param residue - the product's declared data paths (`ProductConfig.siteResidue`), the same list the
 * teardown clears. Defaults to none, so a product that declares nothing pays nothing.
 * @throws Error if the removal, the install or the directory preparation fails, or
 * {@link PluginActivationFailedError} if the plugin is not active afterwards.
 */
export async function installPluginUnderTest(
  transport: Transport,
  artifact: ResolvedArtifact,
  residue: readonly string[] = [],
): Promise<void> {
  await clearDebugLog(transport);
  await ensurePluginAbsent(transport, artifact.slug);
  await stageAndInstallPlugin(transport, artifact.zipPath, { activate: true });
  if (!(await isPluginActive(transport, artifact.slug))) {
    throw new PluginActivationFailedError(artifact.slug);
  }
  // After the install, because a fresh install is what removes the previous scenario's copy of these
  // directories; before any scenario step, because the first writer is otherwise whoever gets there
  // first. See `prepareSiteDataDirs` for the failure this prevents.
  await prepareSiteDataDirs(transport, residue);
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
 * Closes out a plugin scenario: judge what PHP wrote to `debug.log`, remove the plugin, then clear
 * the data it left on disk.
 *
 * **All three duties always run, whatever the ones before them did.** That independence is the
 * point of the third: uninstalling a plugin does not delete the files it wrote — nor should it, for
 * a real user — so a suite that reinstalls per scenario accumulates them until the cell runs out of
 * disk. Skipping the sweep because the uninstall failed would lose exactly the runs most likely to
 * have left a mess behind.
 *
 * When more than one fails, the **debug-log verdict wins**: it is a statement about the product
 * under test, whereas a cleanup failure is about the environment. Cleanup failures are never merely
 * swallowed though — the first is thrown when no fatal claimed the verdict (a site left with a
 * half-removed plugin breaks later scenarios for a reason none of them can explain), and logged when
 * one did. The exception is leftover data the transport's user is not *permitted* to remove, which
 * is reported rather than thrown — see {@link sweepResidue}.
 *
 * The log is judged **as the scenario left it**, before any cleanup, so the verdict is about the
 * scenario and not about this hook's own work. A removal the scenario itself performs is a step, so
 * it falls inside that window and is judged normally.
 *
 * @param transport - the target site's transport.
 * @param slug - the plugin slug to remove; from the resolved artifact, so no edition branching.
 * @param options - the product's `debug.log` scan preset (`ignore` / `source` patterns).
 * @param residue - the product's declared leftover paths, relative to the WordPress root. Empty
 * for a product that leaves nothing behind, which then costs nothing.
 * @param report - the scenario's result and attachment sink.
 * @throws {@link DebugLogFatalError} when PHP logged a fatal, else the first cleanup failure —
 * from {@link ensurePluginAbsent}, or from a residue path that is not a usable declaration.
 */
export async function teardownPluginUnderTest(
  transport: Transport,
  slug: string,
  options: ScanDebugLogOptions,
  residue: readonly string[],
  report: ScenarioReport,
): Promise<void> {
  let failure: Error | undefined;

  try {
    await checkDebugLog(transport, options, report);
  } catch (error) {
    failure = toError(error);
  }

  /** Runs one cleanup duty, keeping the first failure and logging any that a verdict outranks. */
  const cleanUp = async (duty: () => Promise<void>): Promise<void> => {
    try {
      await duty();
    } catch (error) {
      if (failure === undefined) {
        failure = toError(error);
      } else {
        console.error(
          `[hooks] a cleanup step also failed, after the failure reported above: ${errorMessage(error)}`,
        );
      }
    }
  };

  await cleanUp(() => ensurePluginAbsent(transport, slug));
  await cleanUp(() => sweepResidue(transport, residue, report));

  if (failure !== undefined) throw failure;
}

/**
 * Clears the product's leftovers, treating "the transport user is not allowed to" as a fact about
 * the environment rather than a failure of the scenario.
 *
 * The split matters, and it is between two different kinds of wrong:
 *
 *  - **A path that survives removal** is almost always ownership: plugins write as the web-server
 *    user, and a directory that user created without group/other write cannot have its contents
 *    unlinked by whoever WP-CLI runs as. Removal escalates for exactly that reason, so reaching here
 *    means privileges did not close the gap either — the site cannot escalate, or something other
 *    than permissions is holding the paths. Nothing the scenario did caused it and nothing it does
 *    can fix it, and unlike a half-removed plugin it breaks no later scenario. Failing every run over
 *    it would be a poor trade, so it is warned about, with the next step in the message.
 *  - **Anything else** — a path that is not a usable residue declaration, a transport that cannot
 *    run a command — is a defect in our own configuration or environment setup, and is thrown so it
 *    is dealt with.
 *
 * The warning still reaches the report: a passing scenario prints it, a failing one carries it as an
 * attachment, so a cell quietly accumulating data cannot go unnoticed for long.
 */
async function sweepResidue(
  transport: Transport,
  residue: readonly string[],
  report: ScenarioReport,
): Promise<void> {
  try {
    await removeSiteResidue(transport, residue);
  } catch (error) {
    if (!(error instanceof SiteResidueRemovalFailedError)) throw error;
    // The error already names every survivor and the next step for this site's elevation state, so
    // this adds only what it cannot know: which scenario left them behind.
    const message = `[hooks] after "${report.title}": ${error.message}`;
    console.warn(message);
    await report
      .attach("uncleared-site-data", message)
      .catch((attachError: unknown) => {
        console.warn(
          `[hooks] could not attach the uncleared-data report: ${errorMessage(attachError)}`,
        );
      });
  }
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
