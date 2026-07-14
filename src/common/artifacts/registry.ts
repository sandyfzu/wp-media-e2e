/**
 * Per-process registry of resolved artifacts, keyed by `(product, cell)`.
 *
 * Mirrors the pool registry in `config/metadata.ts`: the artifacts setup project (Phase 2)
 * resolves + verifies a cell's zips once and registers the result here, and fixtures in the
 * **same** process read it back without re-resolving. Cross-**process** handoff (the setup
 * project resolves; separate worker processes consume) goes through `resolution.json` on
 * disk, not this map (plan §2.4) — this registry is only the in-process memo.
 *
 * The stored {@link CellArtifacts} is non-secret (paths + build metadata), so unlike the
 * credential-bearing pool registry it could ride in Playwright metadata; it does not only
 * because resolution happens after the config is built, when metadata is already fixed.
 */

import type { CellArtifacts } from "./types";

/** In-process store: `"<product>::<cell>"` → the cell's resolved artifacts. */
const registry = new Map<string, CellArtifacts>();

/** Composite key for the registry; mirrors `metadata.ts`'s pool key. */
function key(product: string, cell: string): string {
  return `${product}::${cell}`;
}

/**
 * Registers a cell's resolved artifacts. Called by the artifacts setup project after it
 * resolves and verifies them; a later call for the same `(product, cell)` overwrites the
 * prior entry (each execution resolves afresh).
 */
export function registerArtifacts(
  product: string,
  cell: string,
  artifacts: CellArtifacts,
): void {
  registry.set(key(product, cell), artifacts);
}

/**
 * Returns a cell's registered artifacts.
 *
 * @throws Error if nothing was registered for `(product, cell)` in this process — meaning
 * the artifacts setup did not run here (e.g. a `--no-deps` invocation, plan §2.8 case 16),
 * a programming/usage error rather than bad input.
 */
export function getArtifacts(product: string, cell: string): CellArtifacts {
  const artifacts = registry.get(key(product, cell));
  if (artifacts === undefined) {
    throw new Error(
      `[artifacts] no resolved artifacts registered for "${product}/${cell}" in this process. ` +
        "The artifacts setup project must run before they are read (run via --project=<cell>, not --no-deps).",
    );
  }
  return artifacts;
}

/** Clears the registry. For test isolation only — production code registers once per execution. */
export function resetArtifactsRegistry(): void {
  registry.clear();
}
