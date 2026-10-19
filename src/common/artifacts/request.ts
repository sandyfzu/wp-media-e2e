/**
 * The artifact request model: read the `E2E_*` env vars, then turn a product's manifest +
 * a cell's edition + those vars into one {@link ArtifactRequest} per supported role.
 *
 * {@link buildArtifactPlan} is **pure** — no `process.env`, no filesystem — so the whole
 * precedence/validation matrix is unit-testable with plain inputs. It is
 * also the single source of truth shared by the resolver and the warmer,
 * which is what makes their APVM requests byte-identical (the pre-warm parity invariant). The only impurity lives in {@link readArtifactEnv}, a thin reader.
 *
 * Failure model: a genuine misconfiguration that would otherwise silently do the wrong
 * thing **throws** — a role's ref and zip both set in a cell run. Vars that are set but
 * cannot apply **warn** and are ignored: a version alongside a provided zip; a version
 * alongside a `release:*` ref; `previous` vars on a product without that role; and **any
 * override on a serial (cell-less) run**, which always uses defaults (a stray/shared
 * `E2E_*` var must never abort a broad serial run). Warnings are returned, not logged, to
 * keep the planner pure — the caller prints them.
 */

import type { Edition } from "../config/types";
import { env } from "../config/env";
import { defaultRefFor, hasPreviousRole, resolveVariant } from "./manifest";
import type {
  ApvmBuildParams,
  ArtifactEnv,
  ArtifactPlan,
  ArtifactRequest,
  ArtifactRole,
  ProductArtifacts,
} from "./types";

// ── Env variable names ─────────────────────────────────────────────────────────

/** The env var names for one role — the exact, project-scoped names operators set. */
interface RoleVars {
  readonly ref: string;
  readonly zip: string;
  readonly version: string;
}

/**
 * The `E2E_*` variable names per role — the one place they are spelled out, reused by the
 * reader, the planner's messages, and the docs. Kept in sync with `.env.example` and the
 * configuration guide.
 */
export const ARTIFACT_ENV_VARS: Readonly<Record<ArtifactRole, RoleVars>> = {
  plugin: {
    ref: "E2E_PLUGIN_REF",
    zip: "E2E_PLUGIN_ZIP",
    version: "E2E_PLUGIN_VERSION",
  },
  previous: {
    ref: "E2E_PREVIOUS_REF",
    zip: "E2E_PREVIOUS_ZIP",
    version: "E2E_PREVIOUS_VERSION",
  },
};

// ── Env reading (the only impure part) ──────────────────────────────────────────

/**
 * Reads the six artifact env vars into a normalized {@link ArtifactEnv}, treating a blank
 * value as unset so an empty `E2E_PLUGIN_REF=` never masks a default, and **trimming**
 * surrounding whitespace — a stray space is easy to introduce in `.env` or a CI YAML block
 * and would otherwise reach APVM as part of the ref, or `fs` as part of a zip path, failing
 * with a message that hides the real cause. This is the capability's single `process.env`
 * touch point for these vars.
 *
 * The trim belongs **here**, not in {@link env}: these six values are refs, paths and versions,
 * where surrounding whitespace is never meaningful, whereas `env()` also serves credentials
 * (e.g. `BWP_FTP_PASSWORD`) whose trailing whitespace can be part of the secret.
 */
export function readArtifactEnv(): ArtifactEnv {
  const read = (name: string): string | undefined => {
    const value = env(name).trim();
    return value === "" ? undefined : value;
  };
  return {
    pluginRef: read(ARTIFACT_ENV_VARS.plugin.ref),
    pluginZip: read(ARTIFACT_ENV_VARS.plugin.zip),
    pluginVersion: read(ARTIFACT_ENV_VARS.plugin.version),
    previousRef: read(ARTIFACT_ENV_VARS.previous.ref),
    previousZip: read(ARTIFACT_ENV_VARS.previous.zip),
    previousVersion: read(ARTIFACT_ENV_VARS.previous.version),
  };
}

// ── The pure planner ────────────────────────────────────────────────────────────

/** Inputs to {@link buildArtifactPlan}. All are supplied explicitly to keep the planner pure. */
export interface PlanInput {
  /** The product's artifact manifest (`ProductConfig.artifacts`). */
  readonly product: ProductArtifacts;
  /** The cell's edition, or `undefined` for an editionless product/cell. */
  readonly edition: Edition | undefined;
  /**
   * Whether this is a serial (cell-less) run — no cell pinned (`E2E_CELL`) or selected
   * (`--project=<cell>`). Serial runs always use defaults; any applicable override is **warned
   * and ignored**, never fatal — so the operator sees it had no effect without the run aborting.
   */
  readonly serial: boolean;
  /** The already-read env vars (see {@link readArtifactEnv}). */
  readonly env: ArtifactEnv;
}

/**
 * Builds the per-role {@link ArtifactRequest}s for one `(product × cell)`.
 *
 * Precedence per role: an env zip wins over an env ref, which wins over the manifest
 * default; a role's ref and zip are mutually exclusive. Version
 * handling follows the product's policy. Inapplicable/inert vars are
 * collected as warnings; a ref+zip conflict in a cell run throws.
 *
 * A serial (cell-less) run always plans from defaults: env overrides cannot apply without a
 * selected cell, so they are dropped from an empty env and any that were set are warned
 * about — never fatal.
 *
 * @returns the requests (one per supported role) plus any warnings to surface.
 * @throws Error on a role's ref+zip conflict (cell run only), or on an edition-ful product
 * missing its cell edition.
 */
export function buildArtifactPlan(input: PlanInput): ArtifactPlan {
  const { product, edition, serial, env: vars } = input;
  const warnings: string[] = [];

  warnInapplicablePreviousVars(product, vars, warnings);

  // Serial runs use defaults unconditionally: plan from an empty env so overrides simply do
  // not apply (a serial ref+zip conflict thus can't throw either), and warn about any that
  // were set so their no-op is visible.
  const effectiveEnv: ArtifactEnv = serial ? {} : vars;
  if (serial) warnSerialOverridesIgnored(product, vars, warnings);

  const requests = rolesToPlan(product).map((role) =>
    requestForRole(product, role, edition, effectiveEnv, warnings),
  );

  warnDegenerateComparison(requests, warnings);
  return { requests, warnings };
}

// ── Per-role planning ────────────────────────────────────────────────────────────

/** The roles whose requests we actually emit: always `plugin`, plus `previous` when supported. */
function rolesToPlan(product: ProductArtifacts): ArtifactRole[] {
  return hasPreviousRole(product) ? ["plugin", "previous"] : ["plugin"];
}

/** The env slice (ref/zip/version) an operator supplied for one role. */
function envForRole(
  role: ArtifactRole,
  vars: ArtifactEnv,
): { ref?: string; zip?: string; version?: string } {
  return role === "plugin"
    ? { ref: vars.pluginRef, zip: vars.pluginZip, version: vars.pluginVersion }
    : {
        ref: vars.previousRef,
        zip: vars.previousZip,
        version: vars.previousVersion,
      };
}

/**
 * Resolves one role to a request, applying ref-XOR-zip (throws) and version rules (may warn).
 * Pushes any inert-var warnings onto `warnings`.
 */
function requestForRole(
  product: ProductArtifacts,
  role: ArtifactRole,
  edition: Edition | undefined,
  vars: ArtifactEnv,
  warnings: string[],
): ArtifactRequest {
  const names = ARTIFACT_ENV_VARS[role];
  const { ref, zip, version } = envForRole(role, vars);

  if (ref !== undefined && zip !== undefined) {
    throw new Error(
      `[artifacts] Both ${names.ref} and ${names.zip} are set. They are mutually exclusive ` +
        "and neither wins by default — unset one.",
    );
  }

  // Operator-provided zip: taken as-is (validated at resolution start). A version has
  // nowhere to go when nothing is built, so warn and ignore it.
  if (zip !== undefined) {
    if (version !== undefined) {
      warnings.push(
        `[artifacts] ${names.version} is set but ignored: ${names.zip} provides a prebuilt zip, so nothing is built.`,
      );
    }
    return { kind: "zip", role, source: "env-zip", rawPath: zip };
  }

  const gitRef = ref ?? defaultRefFor(product, role);
  const params = buildParams(product, role, edition, gitRef, version, warnings);
  return {
    kind: "build",
    role,
    source: ref !== undefined ? "env-ref" : "default-ref",
    params,
  };
}

/** Assembles the APVM params for a build request, resolving the variant and version. */
function buildParams(
  product: ProductArtifacts,
  role: ArtifactRole,
  edition: Edition | undefined,
  gitRef: string,
  envVersion: string | undefined,
  warnings: string[],
): ApvmBuildParams {
  // One variant per edition, wrapped into APVM's `variants` array here.
  const variant = resolveVariant(product, edition);
  const version = resolveVersion(product, role, gitRef, envVersion, warnings);
  return {
    project: product.project,
    gitRef,
    ...(version !== undefined ? { version } : {}),
    ...(variant !== undefined ? { variants: [variant] } : {}),
  };
}

/**
 * Resolves the version to send to APVM for a build, per the product's policy:
 * a `release:*` ref never carries a version (the release tag supplies it — an override is
 * warned and dropped); a `required`-version product falls back to its per-role default; an
 * `embedded`-version product sends only an explicit override (else lets the source version stand).
 */
function resolveVersion(
  product: ProductArtifacts,
  role: ArtifactRole,
  gitRef: string,
  envVersion: string | undefined,
  warnings: string[],
): string | undefined {
  if (isReleaseRef(gitRef)) {
    if (envVersion !== undefined) {
      warnings.push(
        `[artifacts] ${ARTIFACT_ENV_VARS[role].version} is set but ignored: "${gitRef}" is a release ref, ` +
          "whose version comes from the release tag.",
      );
    }
    return undefined;
  }
  if (product.version.kind === "required") {
    return envVersion ?? requiredDefaultVersion(product, role);
  }
  // Embedded: pass an override through (APVM rewrites the source version), else send nothing.
  return envVersion;
}

/**
 * The per-role default version for a `required`-version product.
 *
 * @throws Error if the manifest declares no default for this supported role — a manifest
 * bug (a `required`-version product must give every role it supports a default version).
 */
function requiredDefaultVersion(
  product: ProductArtifacts,
  role: ArtifactRole,
): string {
  if (product.version.kind !== "required") {
    throw new Error(
      `[artifacts] internal: requiredDefaultVersion called for non-required project "${product.project}".`,
    );
  }
  const version =
    role === "plugin"
      ? product.version.defaultVersion.plugin
      : product.version.defaultVersion.previous;
  if (version === undefined) {
    throw new Error(
      `[artifacts] project "${product.project}" requires a version to build but its manifest declares ` +
        `no default version for the "${role}" role. Add version.defaultVersion.${role}.`,
    );
  }
  return version;
}

/**
 * Whether a ref downloads a GitHub release (so its version is fixed by the tag). Matches the
 * explicit `release:` prefix only; a bare numeric ref (e.g. `"5.6.8"`) is left to APVM's own
 * detection and is treated here as a normal build ref.
 */
function isReleaseRef(gitRef: string): boolean {
  return gitRef.startsWith("release:");
}

// ── Cross-role validation (throws / warns) ──────────────────────────────────────

/**
 * Warns (and lets the caller ignore) `E2E_PREVIOUS_*` vars set for a product that has no
 * `previous` role — several products may share one CI environment, so this must not block
 * a run.
 */
function warnInapplicablePreviousVars(
  product: ProductArtifacts,
  vars: ArtifactEnv,
  warnings: string[],
): void {
  if (hasPreviousRole(product)) return;
  const set = previousVarsSet(vars);
  if (set.length === 0) return;
  warnings.push(
    `[artifacts] ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set but ignored: project ` +
      `"${product.project}" has no "previous" role yet.`,
  );
}

/**
 * Warns that any **applicable** override is ignored on a serial (cell-less) run, which always
 * uses defaults. Applicable = the `plugin` vars always, plus the `previous`
 * vars when the product supports that role; inapplicable `previous` vars are already covered
 * by {@link warnInapplicablePreviousVars} and are not repeated here. Not an error — an override
 * simply cannot apply without a selected cell, and must never abort a broad serial run.
 */
function warnSerialOverridesIgnored(
  product: ProductArtifacts,
  vars: ArtifactEnv,
  warnings: string[],
): void {
  const ignored = [
    vars.pluginRef !== undefined ? ARTIFACT_ENV_VARS.plugin.ref : undefined,
    vars.pluginZip !== undefined ? ARTIFACT_ENV_VARS.plugin.zip : undefined,
    vars.pluginVersion !== undefined
      ? ARTIFACT_ENV_VARS.plugin.version
      : undefined,
    ...(hasPreviousRole(product) ? previousVarsSet(vars) : []),
  ].filter((name): name is string => name !== undefined);

  if (ignored.length === 0) return;
  warnings.push(
    `[artifacts] ${ignored.join(", ")} ${ignored.length === 1 ? "is" : "are"} ignored on a ` +
      "serial (cell-less) run — using defaults. Pin a cell with E2E_CELL=<cell> to apply overrides.",
  );
}

/** The `E2E_PREVIOUS_*` var names that are currently set, in a stable order. */
function previousVarsSet(vars: ArtifactEnv): string[] {
  return [
    vars.previousRef !== undefined ? ARTIFACT_ENV_VARS.previous.ref : undefined,
    vars.previousZip !== undefined ? ARTIFACT_ENV_VARS.previous.zip : undefined,
    vars.previousVersion !== undefined
      ? ARTIFACT_ENV_VARS.previous.version
      : undefined,
  ].filter((name): name is string => name !== undefined);
}

/**
 * Warns when the `plugin` and `previous` roles resolve to the **identical** request — same zip
 * path, or same build params — so a comparison/update-path test would pit an artifact against
 * itself. Allowed (not fatal): the config is valid, just degenerate.
 */
function warnDegenerateComparison(
  requests: readonly ArtifactRequest[],
  warnings: string[],
): void {
  const plugin = requests.find((r) => r.role === "plugin");
  const previous = requests.find((r) => r.role === "previous");
  if (plugin === undefined || previous === undefined) return;
  if (!sameRequest(plugin, previous)) return;
  warnings.push(
    '[artifacts] the "plugin" and "previous" roles resolve to the identical request — a ' +
      `comparison would be degenerate. Point one at a different ref/zip (e.g. ${ARTIFACT_ENV_VARS.previous.ref}) ` +
      "to compare distinct versions.",
  );
}

/** Whether two requests would produce the same artifact: same zip path, or same build params. */
function sameRequest(a: ArtifactRequest, b: ArtifactRequest): boolean {
  if (a.kind === "zip" && b.kind === "zip") return a.rawPath === b.rawPath;
  if (a.kind === "build" && b.kind === "build") {
    return (
      a.params.project === b.params.project &&
      a.params.gitRef === b.params.gitRef &&
      a.params.version === b.params.version &&
      sameVariants(a.params.variants, b.params.variants)
    );
  }
  return false;
}

/** Order-sensitive equality for two optional variant lists (both absent counts as equal). */
function sameVariants(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
