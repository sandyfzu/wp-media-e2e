import "./load-env";

import { isNonEmptyString } from "../guards";
import { env } from "./env";

// Read the `process` global directly (as env.ts / project.ts do) rather than destructuring
// `node:process`: `process.argv` is reassigned by our own tests and by tooling, and a
// destructured `argv` binding can snapshot a stale array under some loaders. Reading it live
// keeps cell selection loader-independent.

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
 * The cells a run targets, read from the `--project` forms on the command line
 * (`--project=x`, `--project x`, the variadic `--project x y`, and repeats). This is the
 * single source of truth for cell selection — the exact signal Playwright itself uses to
 * filter projects — so the config can never size workers for a cell Playwright is not
 * running (plan §3.2). A correct invocation selects exactly one cell; this returns ALL
 * requested values so the config factory can reject an unsafe multi-cell selection
 * fail-fast. A `*` wildcard is returned verbatim and resolves to no real cell (→ a safe
 * serial run).
 */
export function selectedCells(): string[] {
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
