/**
 * Types for the plugin-artifact capability: how a product declares the zips it needs,
 * what an execution resolves them into, and the requests that drive APVM.
 *
 * The domain has two **roles** per product (plan §2.1): `plugin` (the artifact under
 * test, always present) and `previous` (the older artifact some tests compare against —
 * e.g. an update path — present only when the product's manifest declares a default for
 * it). Everything downstream — env vars, on-disk dirs, fixtures — is keyed by these two
 * words.
 *
 * This module is types only (no runtime code, no `apvm-napi` import), so it stays cheap
 * to import from pure logic and its unit tests. See:
 *   - `manifest.ts` — pure accessors over {@link ProductArtifacts}.
 *   - `request.ts`  — env reading + the pure {@link ArtifactPlan} builder.
 *   - `registry.ts` — the per-process {@link CellArtifacts} registry.
 */

import type { Edition } from "../config/types";

// ── Roles ────────────────────────────────────────────────────────────────────

/**
 * The artifact a product build/verify step can address.
 *
 * - `plugin` — the artifact under test; every product has it.
 * - `previous` — the older artifact to compare against; a product opts in by declaring a
 *   `previous` default ref in its manifest (see {@link RoleMap}). Absent ⇒ the role is
 *   unsupported and its `E2E_PREVIOUS_*` env vars are ignored (plan §2.2 rule 5, §5).
 */
export type ArtifactRole = "plugin" | "previous";

/**
 * A value supplied per role. `plugin` is mandatory; `previous` is optional and its
 * presence is the single signal that a product supports the previous-version role.
 *
 * @typeParam T - the per-role value (e.g. a default git ref, or a default version).
 */
export interface RoleMap<T> {
  readonly plugin: T;
  readonly previous?: T;
}

// ── Provenance & origin (for the resolution report, plan §2.5) ─────────────────

/**
 * Where a resolved artifact's input came from — surfaced in the resolution report so a
 * reader can tell a defaulted build from an operator override at a glance.
 *
 * - `default-ref` — the manifest's default ref (no env override).
 * - `env-ref` — a git ref from `E2E_<ROLE>_REF`.
 * - `env-zip` — a prebuilt zip path from `E2E_<ROLE>_ZIP`.
 */
export type ArtifactSource = "default-ref" | "env-ref" | "env-zip";

/**
 * How the delivered zip came to exist, for reporting.
 *
 * `built` / `cache` / `downloaded` are reported verbatim by APVM (`JsProducedArtifact.origin`);
 * `copied` is ours, used when an operator-provided zip (`env-zip`) is copied into the
 * role dir rather than produced by APVM.
 */
export type ArtifactOrigin = "built" | "cache" | "downloaded" | "copied";

// ── APVM request parameters ────────────────────────────────────────────────────

/**
 * The APVM inputs that determine a build's identity — the subset of `apvm-napi`'s
 * `BuildOptions` shared by `build()` and `warmCache()`, i.e. everything **except**
 * `outputDir`/`noCache` (which do not affect what is produced).
 *
 * Keeping this subset as the single computed value is what guarantees the pre-warm
 * parity invariant (plan §2.7): the warmer and the resolver build the same object, so a
 * warmed cache entry is always the one a later build looks up.
 */
export interface ApvmBuildParams {
  /** APVM project id: `"wp-rocket"`, `"backwpup"`, or `"imagify"`. */
  readonly project: string;
  /** Any APVM-accepted ref (branch/tag/commit/PR/`release:*`/keyword) — passed through verbatim. */
  readonly gitRef: string;
  /**
   * Version to build. Present for BackWPup (required by its builder) and for any product
   * when an operator pins one; omitted when the version is embedded in source and no
   * override was given, and always omitted for `release:*` refs (plan §2.2 rule 4).
   */
  readonly version?: string;
  /**
   * APVM variants to build (e.g. `["free"]`, `["pro-en"]`). Present only for edition-ful
   * products; omitted for single-output products (WP Rocket, Imagify).
   */
  readonly variants?: readonly string[];
}

// ── Requests (the output of the pure planner) ──────────────────────────────────

/** A role to be produced by APVM from a git ref (built, or copied from cache/a release). */
export interface BuildRequest {
  readonly kind: "build";
  readonly role: ArtifactRole;
  /** Ref provenance — a build is never sourced from a zip, so never `"env-zip"`. */
  readonly source: "default-ref" | "env-ref";
  readonly params: ApvmBuildParams;
}

/** A role satisfied by an operator-provided prebuilt zip (`E2E_<ROLE>_ZIP`). */
export interface ZipRequest {
  readonly kind: "zip";
  readonly role: ArtifactRole;
  readonly source: "env-zip";
  /**
   * The path exactly as the env var gave it — **not** yet absolutized or checked. Existence,
   * file-ness, and the `.zip` suffix are validated at resolution start against the repo root
   * (plan §2.2 rule 6, §2.8 case 14), which is a Phase 2 concern; the pure planner never
   * touches the filesystem.
   */
  readonly rawPath: string;
}

/** One role's resolution instruction: build it from a ref, or take a provided zip. */
export type ArtifactRequest = BuildRequest | ZipRequest;

/**
 * The full result of planning a `(product × cell)`'s artifacts: one request per supported
 * role, plus any non-fatal warnings (ignored/inapplicable env vars — plan §2.2 rules 3–5,
 * §2.8, including overrides dropped on a serial run). The planner is pure, so it returns
 * warnings rather than logging them; the impure caller prints them. Only a genuine
 * misconfiguration (a ref+zip conflict in a cell run) throws instead of warning.
 */
export interface ArtifactPlan {
  readonly requests: readonly ArtifactRequest[];
  readonly warnings: readonly string[];
}

// ── Environment inputs ─────────────────────────────────────────────────────────

/**
 * The six `E2E_*` artifact env vars, already read from the environment and normalized so
 * that blank/absent both become `undefined`. Passed explicitly into the planner so the
 * decision logic stays pure and unit-testable (no `process.env` reads inside it).
 *
 * Per-role rule: `ref` and `zip` are mutually exclusive; `version` applies only to a build
 * (plan §2.2). See `request.ts` `readArtifactEnv` for the reader and `ARTIFACT_ENV_VARS`
 * for the exact variable names.
 */
export interface ArtifactEnv {
  readonly pluginRef?: string;
  readonly pluginZip?: string;
  readonly pluginVersion?: string;
  readonly previousRef?: string;
  readonly previousZip?: string;
  readonly previousVersion?: string;
}

// ── Manifest (a product's `artifacts` config) ──────────────────────────────────

/**
 * The identity a resolved zip must match, asserted by the Phase 2 preflight (plan §1.2,
 * §2.5). The slug alone pins both product and edition (`wp-rocket` ≠ `backwpup` ≠
 * `backwpup-pro`); the plugin-name header is a cheap second witness, compared for exact
 * equality so `"BackWPup"` can never satisfy a `"BackWPup Pro"` expectation.
 */
export interface ArtifactIdentity {
  /** The single top-level directory inside the zip (the WordPress plugin slug), e.g. `"backwpup-pro"`. */
  readonly slug: string;
  /** The main plugin file within `<slug>/`, e.g. `"backwpup.php"`. */
  readonly mainFile: string;
  /** The exact `Plugin Name:` header value, e.g. `"BackWPup Pro"`. Compared by equality, not prefix. */
  readonly pluginName: string;
}

/**
 * How a product's version is handled when building (plan §2.2 rule 4).
 *
 * - `embedded` — the version lives in source (WP Rocket, Imagify). No default is sent; an
 *   operator override, if given, is passed through and APVM rewrites the source version.
 * - `required` — APVM needs a version to build (BackWPup). Each supported role gets a
 *   default used when no override is given and the ref is not `release:*` (which always
 *   derives its version from the release tag). Defaults are intentionally staggered
 *   (`plugin` newer than `previous`) so an update-path test sees `previous` as older
 *   without any manual pinning.
 */
export type VersionPolicy =
  | { readonly kind: "embedded" }
  | { readonly kind: "required"; readonly defaultVersion: RoleMap<string> };

/** Per-edition build data for an edition-ful product: the APVM variant to build and the identity to expect. */
export interface EditionData {
  /**
   * The APVM variant id to build for this edition — APVM's build-facing vocabulary, a
   * *different namespace* from our behavioral {@link Edition}. The mapping is a projection,
   * not identity: edition `pro` builds variant `"pro-en"` (English; APVM's separate `"pro-de"`
   * we don't test, since pro-en and pro-de are the same except for licensing endpoints, so, pro-en e2e tests cover pro-de), while edition `free` → variant `"free"` merely coincides. Exactly one
   * variant per edition, because each role resolves to exactly one zip (plan §2.5); the request
   * builder wraps it in APVM's `variants` array.
   */
  readonly variant: string;
  /** The identity a zip of this edition must match (plan §1.2). */
  readonly identity: ArtifactIdentity;
}

/**
 * How a product's edition axis is configured (plan §2.3). The cell supplies the edition;
 * the manifest supplies the per-edition data.
 *
 * - `editionless` — one identity, no variants (WP Rocket, Imagify).
 * - `editionful` — variants + identity per edition (BackWPup); the request builder requires
 *   the cell's edition and throws if it is absent (a programming error, since the sites
 *   loader already enforces edition presence all-or-none).
 */
export type EditionPolicy =
  | { readonly kind: "editionless"; readonly identity: ArtifactIdentity }
  | {
      readonly kind: "editionful";
      readonly byEdition: Readonly<Record<Edition, EditionData>>;
    };

/**
 * A product's artifact manifest — the declarative source of truth the planner reads to
 * turn `(edition, env)` into {@link ArtifactRequest}s, and the preflight reads for its
 * identity expectations. Lives on `ProductConfig.artifacts` and is authored in each
 * product's `*.config.ts` (plan §2.3).
 */
export interface ProductArtifacts {
  /** APVM project id passed to `build()`/`warmCache()`: `"wp-rocket"`, `"backwpup"`, `"imagify"`. */
  readonly project: string;
  /**
   * Default git ref per role. `plugin` is mandatory; a `previous` entry both supplies its
   * default ref and marks the previous-version role as supported (its absence makes the
   * `E2E_PREVIOUS_*` vars inapplicable — plan §2.2 rule 5, §5).
   */
  readonly defaultRef: RoleMap<string>;
  /** Version handling for builds (plan §2.2 rule 4). */
  readonly version: VersionPolicy;
  /** Edition axis: identity/variants, keyed by edition for edition-ful products (plan §2.3). */
  readonly edition: EditionPolicy;
}

// ── Resolution (populated in Phase 2; the shape is fixed by plan §2.4) ──────────

/**
 * One role's resolved artifact for the current execution — the in-memory record the
 * Phase 2 resolver produces and the Phase 3 fixture hands to tests. A non-secret subset
 * is persisted to `resolution.json` so worker processes (which never resolve) can read it
 * (plan §2.4).
 */
export interface ResolvedArtifact {
  readonly role: ArtifactRole;
  /** Absolute path to the resolved zip on disk (inside the role's ephemeral dir). */
  readonly zipPath: string;
  /** The zip's filename (basename of {@link ResolvedArtifact.zipPath}). */
  readonly zipFilename: string;
  readonly source: ArtifactSource;
  /** The git ref, for build/downloaded artifacts; absent for a provided zip. */
  readonly ref?: string;
  /** The resolved commit SHA, when APVM produced the artifact; absent for a provided zip. */
  readonly commit?: string;
  /** The effective version (built, overridden, or read from the artifact); absent when unknown. */
  readonly version?: string;
  readonly origin: ArtifactOrigin;
  /** ISO-8601 timestamp of when this role was resolved. */
  readonly resolvedAt: string;
}

/**
 * A cell's resolved artifacts, keyed by role. `Partial` because a product may support only
 * `plugin`. This is the value the per-process registry (`registry.ts`) stores per
 * `(product, cell)` and the fixture reads.
 */
export type CellArtifacts = Readonly<
  Partial<Record<ArtifactRole, ResolvedArtifact>>
>;

/**
 * One role's resolution outcome (Phase 2, produced by `resolve.ts`, consumed by `verify.ts`):
 * either the built/copied {@link ResolvedArtifact}, or a captured failure. Failures are values,
 * not thrown, so a `plugin` failure never prevents `previous` from being resolved and verified —
 * every role reaches the single aggregated report (plan §2.5).
 */
export type RoleOutcome =
  | {
      readonly role: ArtifactRole;
      readonly kind: "resolved";
      readonly artifact: ResolvedArtifact;
    }
  | {
      readonly role: ArtifactRole;
      readonly kind: "failed";
      /** Why resolution failed (e.g. missing zip, APVM build error, missing token). */
      readonly error: string;
      /** Optional actionable next step, shown under the error in the report. */
      readonly hint?: string;
    };
