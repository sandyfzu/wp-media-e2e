import "./load-env";
import { argv, env as processEnv, pid } from "node:process";

import { isNonEmptyString } from "../guards";
import { env } from "./env";

/**
 * Run context: resolves the namespaced artifact directories for a (product, cell) and
 * the per-run report token. Artifacts split into two lifecycles (plan §3.5):
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
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(pid)}`;
}

/** Resolves the run token: a non-blank inherited `RUN_ID`, else a fresh stamp pinned into env. */
function resolveRunId(): string {
  const provided = processEnv.RUN_ID;
  if (isNonEmptyString(provided)) return provided;
  const stamped = stamp();
  // Pin it so every worker process (which re-imports this module) inherits one token.
  processEnv.RUN_ID = stamped;
  return stamped;
}

/** One RUN_ID for the whole invocation. Only the report directory is namespaced by it. */
export const RUN_ID: string = resolveRunId();

/**
 * The cells a run targets. A correct invocation selects exactly one (so the global
 * `parallelIndex` stays in range — plan §3.2); this returns ALL requested values so the
 * config factory can reject an unsafe multi-cell selection fail-fast. Sources: the `CELL`
 * env var (orchestrator) plus every `--project` form on the command line (`--project=x`,
 * `--project x`, the variadic `--project x y`, and repeats). A `*` wildcard is returned
 * verbatim and resolves to no real cell (→ a safe serial run).
 */
export function selectedCells(): string[] {
  const cells = new Set<string>();

  const fromEnv = processEnv.CELL;
  if (isNonEmptyString(fromEnv)) cells.add(fromEnv.trim());

  const eq = "--project=";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith(eq)) {
      cells.add(arg.slice(eq.length));
    } else if (arg === "--project") {
      // Variadic: consume consecutive non-flag tokens (`--project a b`).
      for (let j = i + 1; j < argv.length; j += 1) {
        const next = argv[j];
        if (next === undefined || next.startsWith("-")) break;
        cells.add(next);
        i = j;
      }
    }
  }
  return [...cells];
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
  };
}
