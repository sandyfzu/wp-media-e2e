import "./src/common/config/load-env";

import { styleText } from "node:util";

import { readArtifactEnv } from "./src/common/artifacts/request";
import { createApvmWarmer, warmArtifacts } from "./src/common/artifacts/warm";
import type { WarmSummary, WarmUnit } from "./src/common/artifacts/warm";
import { isNonEmptyString } from "./src/common/guards";
import { isPlaceholderSite } from "./src/common/config/sites";
import type { ProductConfig } from "./src/common/config/types";
import { backwpup } from "./src/projects/backwpup/config/backwpup.config";
import { wpRocket } from "./src/projects/wp-rocket/config/wp-rocket.config";

/**
 * Pre-warm the APVM cache for the plugin zips a run will need, standalone — a CI
 * pre-step or local prep long before an orchestrator exists,
 * which later imports the same `warmArtifacts` before spawning cells.
 *
 * For every `(product × cell)` with real sites it plans the build requests exactly as a real
 * `--project=<cell>` run would (the parity invariant), deduplicates them, and warms each once so
 * the subsequent per-cell `build()` is a cache copy. `--product`/`--cell` narrow the set; global
 * `E2E_*` overrides apply (they warm what a same-env run would then build). Placeholder-only
 * cells are skipped, so a fresh checkout warms nothing and needs no GitHub token.
 *
 * Usage: `npm run artifacts:warm [-- --product=<p>] [--cell=<c>]`. Exits `0` when every warm
 * succeeded, `1` if any plan or warm failed.
 */

const PRODUCTS: readonly ProductConfig[] = [wpRocket, backwpup];

const RULE = "─".repeat(72);

/** Reads a `--name=value` / `--name value` flag from argv, normalizing blank to `undefined`. */
function readFlag(name: string): string | undefined {
  const args = process.argv;
  const eq = `--${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith(eq)) return normalize(arg.slice(eq.length));
    if (arg === `--${name}`) {
      // Space form (`--name value`): treat a following flag (or end of args) as "no value",
      // mirroring run-context's `selectedCells`, so `--product --cell=x` never misreads the flag.
      const next = args[i + 1];
      return next !== undefined && !next.startsWith("-")
        ? normalize(next)
        : undefined;
    }
  }
  return undefined;
}

/** Blank/absent → `undefined`; otherwise the trimmed value. */
function normalize(value: string | undefined): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

/** A cell excluded from warming because it has no real sites (placeholder-only). */
interface SkippedCell {
  readonly product: string;
  readonly cell: string;
}

/** The result of turning the product configs (filtered) into warmable units. */
interface Discovery {
  readonly units: WarmUnit[];
  readonly skippedCells: SkippedCell[];
}

/**
 * Builds a {@link WarmUnit} for each `(product, cell)` that has at least one real site, honoring
 * the `--product` / `--cell` filters. Placeholder-only cells are recorded as skipped, never
 * warmed — priming a cache for a cell that will not run is wasted work (and, for BackWPup, would
 * demand a token a fresh checkout does not have).
 */
function discover(
  products: readonly ProductConfig[],
  productFilter: string | undefined,
  cellFilter: string | undefined,
): Discovery {
  const units: WarmUnit[] = [];
  const skippedCells: SkippedCell[] = [];

  for (const product of products) {
    if (productFilter !== undefined && product.name !== productFilter) continue;
    for (const cell of Object.keys(product.sites)) {
      if (cellFilter !== undefined && cell !== cellFilter) continue;
      const config = product.sites[cell];
      const real = (config?.sites ?? []).filter((s) => !isPlaceholderSite(s));
      if (real.length === 0) {
        skippedCells.push({ product: product.name, cell });
        continue;
      }
      units.push({
        label: `${product.name}/${cell}`,
        manifest: product.artifacts,
        edition: config?.edition,
      });
    }
  }
  return { units, skippedCells };
}

/** Prints the banner and what is about to be warmed. */
function printHeader(
  units: readonly WarmUnit[],
  skipped: readonly SkippedCell[],
): void {
  console.log(styleText(["bold", "cyan"], RULE));
  console.log(
    styleText(
      ["bold", "cyan"],
      "  wp-media-projects-e2e — Warm plugin artifacts",
    ),
  );
  console.log(styleText(["bold", "cyan"], RULE));
  console.log(
    styleText(
      ["dim"],
      `  Priming APVM's cache for ${String(units.length)} cell(s): ` +
        `${units.map((u) => u.label).join(", ") || "(none)"}.`,
    ),
  );
  for (const s of skipped) {
    console.log(
      `  ${styleText(["yellow"], "⚠")} ${s.product}/${s.cell} — ` +
        styleText(["yellow"], "skipped (placeholder-only, will not run)"),
    );
  }
  console.log("");
}

/** Prints the per-request outcomes, skips, plan failures, and planner warnings. */
function printSummary(summary: WarmSummary): void {
  for (const warning of summary.warnings) {
    console.warn(`  ${styleText(["yellow"], "⚠")} ${warning}`);
  }
  for (const skip of summary.skipped) {
    console.log(
      `  ${styleText(["dim"], "•")} ${skip.label} ${skip.role}: ` +
        styleText(["dim"], `provided zip (${skip.rawPath}) — nothing to warm.`),
    );
  }

  for (const result of summary.results) {
    const ref = `${result.params.project} ${result.params.gitRef}`;
    const variant = result.params.variants?.length
      ? ` [${result.params.variants.join(", ")}]`
      : "";
    const wantedBy = styleText(["dim"], `(${result.wantedBy.join(", ")})`);
    if (result.ok) {
      const note = result.fromCache === true ? "already cached" : "warmed";
      console.log(
        `  ${styleText(["green"], "✓")} ${ref}${variant} — ${note} ${wantedBy}`,
      );
    } else {
      console.log(
        `  ${styleText(["red", "bold"], "✗")} ${styleText(["bold"], `${ref}${variant}`)} ${wantedBy}`,
      );
      console.log(`      ${styleText(["red"], String(result.error))}`);
    }
  }

  for (const failure of summary.planFailures) {
    console.log(
      `  ${styleText(["red", "bold"], "✗")} ${styleText(["bold"], failure.label)} — could not plan`,
    );
    console.log(`      ${styleText(["red"], failure.error)}`);
  }
}

/** Prints the closing tally and returns the process exit code. */
function printFooter(summary: WarmSummary): number {
  const warmed = summary.results.filter((r) => r.ok).length;
  const failed =
    summary.results.filter((r) => !r.ok).length + summary.planFailures.length;

  console.log("");
  console.log(styleText(["bold"], RULE));
  if (summary.ok) {
    console.log(
      styleText(
        ["green", "bold"],
        `  ${String(warmed)} request(s) warmed. Cache is primed.`,
      ),
    );
    return 0;
  }
  console.log(
    styleText(
      ["red", "bold"],
      `  ${String(failed)} warm request(s) failed; ${String(warmed)} succeeded. See details above.`,
    ),
  );
  return 1;
}

async function main(): Promise<void> {
  const productFilter = readFlag("product");
  const cellFilter = readFlag("cell");

  const known = PRODUCTS.map((p) => p.name);
  if (productFilter !== undefined && !known.includes(productFilter)) {
    console.error(
      styleText(
        ["red", "bold"],
        `[artifacts:warm] unknown --product "${productFilter}".`,
      ) + ` Known products: ${known.join(", ")}.`,
    );
    process.exit(1);
  }

  const { units, skippedCells } = discover(PRODUCTS, productFilter, cellFilter);
  printHeader(units, skippedCells);

  if (units.length === 0) {
    console.log(
      styleText(
        ["yellow", "bold"],
        "  Nothing to warm — no real cells matched (placeholder/example data only, or the filter matched none).",
      ),
    );
    process.exit(0);
  }

  const summary = await warmArtifacts(
    units,
    readArtifactEnv(),
    createApvmWarmer(),
  );
  printSummary(summary);
  process.exit(printFooter(summary));
}

await main();
