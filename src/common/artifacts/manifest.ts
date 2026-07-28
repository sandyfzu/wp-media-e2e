/**
 * Pure accessors over a {@link ProductArtifacts} manifest.
 *
 * These answer the two edition-dependent questions the rest of the capability asks —
 * "which roles does this product support?", "which variants / identity apply for this
 * cell's edition?" — in one place, so the request planner (`request.ts`) and the identity
 * preflight (`verify.ts`) never re-derive them and can never disagree. All functions are
 * pure and total or throw an actionable error; none read the environment or filesystem.
 */

import type { Edition } from "../config/types";
import type { ArtifactIdentity, ArtifactRole, ProductArtifacts } from "./types";

/**
 * Whether the product supports the `previous` role — i.e. its manifest declares a default
 * ref for it. Drives both which requests are planned and whether `E2E_PREVIOUS_*` env vars
 * are applicable.
 */
export function hasPreviousRole(manifest: ProductArtifacts): boolean {
  return manifest.defaultRef.previous !== undefined;
}

/**
 * The roles this product supports, in stable order (`plugin` first). `plugin` is always
 * present; `previous` is included iff {@link hasPreviousRole}.
 */
export function rolesOf(manifest: ProductArtifacts): ArtifactRole[] {
  return hasPreviousRole(manifest) ? ["plugin", "previous"] : ["plugin"];
}

/**
 * The default git ref for a supported role. Callers pass only roles from {@link rolesOf},
 * so a `previous` ref is guaranteed present here.
 *
 * @throws Error if `role` is `previous` but the manifest declares no `previous` default —
 * a programming error (the caller should have consulted {@link rolesOf} first).
 */
export function defaultRefFor(
  manifest: ProductArtifacts,
  role: ArtifactRole,
): string {
  if (role === "plugin") return manifest.defaultRef.plugin;
  const ref = manifest.defaultRef.previous;
  if (ref === undefined) {
    throw new Error(
      `[artifacts] internal: requested the "previous" default ref for project "${manifest.project}", ` +
        "which declares none. Consult rolesOf() before addressing a role.",
    );
  }
  return ref;
}

/**
 * The APVM variant to build for a cell's edition, or `undefined` for an editionless product
 * (whose builder takes no variant). A single id — each role resolves to exactly one zip;
 * the caller wraps it in APVM's `variants` array.
 *
 * @param edition - the cell's edition; required for edition-ful products, ignored otherwise.
 * @throws Error if the product is edition-ful but `edition` is absent or not in the manifest
 * — a programming error, since the sites loader already enforces a valid edition per cell.
 */
export function resolveVariant(
  manifest: ProductArtifacts,
  edition: Edition | undefined,
): string | undefined {
  if (manifest.edition.kind === "editionless") return undefined;
  return editionData(manifest, edition).variant;
}

/**
 * The identity a resolved zip must match for a cell's edition. For an
 * editionless product this is the single declared identity; for an edition-ful one it is
 * the edition's identity.
 *
 * @param edition - the cell's edition; required for edition-ful products, ignored otherwise.
 * @throws Error under the same conditions as {@link resolveVariants}.
 */
export function resolveIdentity(
  manifest: ProductArtifacts,
  edition: Edition | undefined,
): ArtifactIdentity {
  if (manifest.edition.kind === "editionless") return manifest.edition.identity;
  return editionData(manifest, edition).identity;
}

/**
 * Looks up an edition-ful product's per-edition data, validating that a known edition was
 * supplied. Centralizes the "edition-ful needs an edition" guard shared by
 * {@link resolveVariant} and {@link resolveIdentity}.
 *
 * @throws Error if `edition` is absent or absent from the manifest's `byEdition` map.
 */
function editionData(
  manifest: ProductArtifacts,
  edition: Edition | undefined,
): { readonly variant: string; readonly identity: ArtifactIdentity } {
  if (manifest.edition.kind !== "editionful") {
    throw new Error(
      `[artifacts] internal: editionData called for editionless project "${manifest.project}".`,
    );
  }
  if (edition === undefined) {
    throw new Error(
      `[artifacts] project "${manifest.project}" is edition-ful, but no edition was supplied for this cell. ` +
        "Edition-ful cells must declare an edition.",
    );
  }
  // `byEdition` is a `Record<Edition, …>` with literal keys, so a valid edition always
  // resolves — a manifest that omitted an edition would fail to type-check.
  return manifest.edition.byEdition[edition];
}
