import "./load-env";

import { fileURLToPath } from "node:url";

import { isNonEmptyString } from "../guards";
import { env } from "./env";

/**
 * Absolute repo root, derived from this module's own location
 * (`…/src/common/config/run-context.ts` → three levels up), so callers can absolutize the
 * repo-root-relative paths {@link dirs} returns **without depending on `process.cwd()`** —
 * which the artifacts resolver needs (APVM requires an absolute `outputDir`, and a
 * relative `E2E_*_ZIP` must resolve against the repo, not the process cwd).
 */
export const REPO_ROOT: string = fileURLToPath(
  new URL("../../../", import.meta.url),
);

// Read the `process` global directly (as env.ts / project.ts do) rather than destructuring
// `node:process`: `process.argv` is reassigned by our own tests and by tooling, and a
// destructured `argv` binding can snapshot a stale array under some loaders. Reading it live
// keeps cell selection loader-independent.

/**
 * Run context: resolves the namespaced artifact directories for a (product, cell) and
 * the per-run report token. Artifacts split into two lifecycles:
 *
 *  - report  → ACCUMULATES under `<REPORT_ROOT>/<product>/<cell>/<RUN_ID>` (one per
 *              run; pruned to the newest N by a later `report:prune` utility).
 *  - output / auth / bdd → EPHEMERAL, stable per (product, cell); overwritten in place
 *              each run, so they never accumulate.
 *
 * The `*_ROOT` env vars and `RUN_ID` are the only knobs (an orchestrator may pin RUN_ID
 * so every cell of a batch shares one token). The `<product>/<cell>` namespace is always
 * appended, so cells never collide. Running a cell manually needs no environment at all.
 */

/** Filesystem-safe, lexically-sortable run token. Used ONLY to namespace the report directory. */
function stamp(): string {
  // e.g. 2026-06-19T14-03-22-123Z-48217
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(process.pid)}`;
}

/** Resolves the run token: a non-blank inherited `RUN_ID`, else a fresh stamp pinned into env. */
function resolveRunId(): string {
  const provided = process.env.RUN_ID;
  if (isNonEmptyString(provided)) return provided;
  const stamped = stamp();
  // Pin it so every worker process (which re-imports this module) inherits one token.
  process.env.RUN_ID = stamped;
  return stamped;
}

/** One RUN_ID for the whole invocation. Only the report directory is namespaced by it. */
export const RUN_ID: string = resolveRunId();

/**
 * Internal channel carrying this invocation's `--project` selection to forked worker
 * processes. Playwright forks a worker **without** the CLI argv but **with** the parent's
 * environment, and each worker re-imports the config from scratch — so `process.argv` in a
 * worker holds only `[node, workerProcessEntry.js]` and project `metadata` a worker reads is
 * the one *it* just rebuilt, not the runner's. Any argv-derived decision must therefore ride
 * the environment, exactly as {@link RUN_ID} does. Seeded by {@link seedSelectedCells} while
 * the runner builds the config; never set by hand.
 */
const SELECTED_CELLS_ENV = "E2E_INTERNAL_SELECTED_CELLS";

/**
 * Parses the `--project` forms out of the live `process.argv` (`--project=x`, `--project x`,
 * the variadic `--project x y`, and repeats) — the exact signal Playwright itself filters on.
 * Empty in a worker process, which never receives the CLI argv.
 */
function cellsFromArgv(): string[] {
  const cells = new Set<string>();
  const args = process.argv;
  const eq = "--project=";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith(eq)) {
      cells.add(arg.slice(eq.length));
    } else if (arg === "--project") {
      // Variadic: consume consecutive non-flag tokens (`--project a b`).
      for (let j = i + 1; j < args.length; j += 1) {
        const next = args[j];
        if (next === undefined || next.startsWith("-")) break;
        cells.add(next);
        i = j;
      }
    }
  }
  return [...cells];
}

/** Reads the selection the runner seeded for its workers; `[]` when absent or unreadable. */
function cellsFromEnv(): string[] {
  const raw = process.env[SELECTED_CELLS_ENV];
  if (!isNonEmptyString(raw)) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * The cells a run targets: the `--project` values from the command line, or — in a forked
 * worker, which has no argv — the selection {@link seedSelectedCells} published for it. This
 * is the single source of truth for cell selection, so the config can never size workers for
 * a cell Playwright is not running, and a worker can tell an explicitly selected cell from a
 * broad serial run. A correct invocation selects exactly one cell; this returns ALL requested
 * values so the config factory can reject an unsafe multi-cell selection fail-fast.
 *
 * Values come back **verbatim**, and callers compare them to cell names exactly. Playwright's
 * own project filter is looser — case-insensitive, and `*` wildcards expand — so a selection
 * like `--project='pro*'` runs a cell that no exact comparison here matches. That is deliberate:
 * such a selection is treated as broad, which for the artifacts setup means overrides
 * warn-and-drop rather than silently applying to cells the operator never named (and it keeps
 * the documented `--project='*'` ⇒ serial behaviour). Name the cell exactly to target it.
 */
export function selectedCells(): string[] {
  const fromArgv = cellsFromArgv();
  return fromArgv.length > 0 ? fromArgv : cellsFromEnv();
}

/**
 * Publishes the command line's cell selection into the environment so forked worker
 * processes can read it back through {@link selectedCells}. Called once while the config is
 * built: in the runner that captures the real selection, and in a worker (which rebuilds the
 * same config) it is a no-op — argv is empty there, so the inherited value is never clobbered.
 */
export function seedSelectedCells(): void {
  const fromArgv = cellsFromArgv();
  if (fromArgv.length > 0) {
    process.env[SELECTED_CELLS_ENV] = JSON.stringify(fromArgv);
  }
}

/**
 * Whether this invocation explicitly **targeted** one cell, as opposed to sweeping every cell.
 * The inverse of a "serial" run, and the gate on whether per-run overrides may apply: an
 * override the operator set for one cell must not leak into a broad sweep of all of them.
 *
 * True when the selection names the cell itself (`--project=<cell>`, whose dependency graph
 * pulls the per-cell setup projects in) or names the caller's own project
 * (`--project=artifacts:<cell>` — how you resolve a cell's zips without running its scenarios).
 * `projectName` is a parameter because only the caller knows which project it is running as.
 *
 * @param cell - the cell this project belongs to (from its routing metadata).
 * @param projectName - the running project's own name (`testInfo.project.name`).
 */
export function isCellTargeted(cell: string, projectName: string): boolean {
  const selected = selectedCells();
  return selected.includes(cell) || selected.includes(projectName);
}

export interface RunDirs {
  /** Accumulating per-run report directory. */
  readonly report: string;
  /** Ephemeral Playwright artifacts (traces/video/screenshots). */
  readonly output: string;
  /** Ephemeral per-site `storageState` directory. */
  readonly auth: string;
  /** Ephemeral generated BDD specs directory. */
  readonly bdd: string;
  /**
   * Ephemeral resolved-plugin-artifacts directory (the zips under test). Repo-root-relative
   * like the rest; the artifacts resolver joins it onto {@link REPO_ROOT} for the absolute
   * path APVM needs, and wipes it whole on every resolution.
   */
  readonly artifacts: string;
}

/**
 * Resolve the artifact directories for a (product, cell). All paths are repo-root-relative.
 * A `*_ROOT` override replaces only the root prefix; the `<product>/<cell>` namespace is
 * always appended, so concurrent cells never share a directory.
 */
export function dirs(product: string, cell: string): RunDirs {
  const cellNs = `${product}/${cell}`;
  return {
    report: `${env("REPORT_ROOT", "reports")}/${cellNs}/${RUN_ID}`,
    output: `${env("OUTPUT_ROOT", "test-results")}/${cellNs}`,
    auth: `${env("AUTH_ROOT", ".auth")}/${cellNs}`,
    bdd: `.features-gen/${cellNs}`,
    artifacts: `${env("ARTIFACTS_ROOT", ".artifacts")}/${cellNs}`,
  };
}
