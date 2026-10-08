/**
 * Pre-warming: prime APVM's cache so N cells wanting the same uncached build do not build it N
 * times, and so build minutes do not count against test wall-time. `warmCache()`
 * runs the same build pipeline but delivers nothing; a later per-cell `build()` is then a cache
 * copy.
 *
 * The correctness property is the **parity invariant**: warming must produce the exact
 * `{project, gitRef, version, variants}` a real run would, or the warmed entry is never hit and
 * the warm is wasted. This module therefore plans through the **same** `buildArtifactPlan` the
 * resolver uses, with `serial: false` — the mode a real run of one cell plans in — so
 * overrides apply identically on both sides.
 *
 * {@link warmArtifacts} is pure orchestration (dedupe, skip provided zips, collect failures) with
 * the actual cache call injected as a {@link WarmOne}, so it is unit-testable without APVM;
 * {@link createApvmWarmer} supplies the real one. The standalone CLI (`warm-artifacts.ts`) and,
 * later, an orchestrator both call `warmArtifacts` with it.
 */

import {
  assertToken,
  createBuildReporter,
  getApvm,
  redactSecrets,
} from "./apvm";
import { errorMessage } from "../guards";
import { buildArtifactPlan } from "./request";
import type { ApvmBuildParams, ArtifactEnv, ProductArtifacts } from "./types";
import type { Edition } from "../config/types";
import type { WarmOptions } from "apvm-napi";

/** One `(product × cell)` to warm: its manifest, the cell's edition, and a display label. */
export interface WarmUnit {
  /** Human-readable `"<product>/<cell>"` identity, used in logs and the summary. */
  readonly label: string;
  /** The product's artifact manifest (`ProductConfig.artifacts`). */
  readonly manifest: ProductArtifacts;
  /** The cell's edition, or `undefined` for an editionless product. */
  readonly edition: Edition | undefined;
}

/** The outcome of warming one deduped build request. */
export interface WarmResult {
  /** The APVM params warmed (the deduped `{project, gitRef, version, variants}`). */
  readonly params: ApvmBuildParams;
  /** Labels of the units that requested this build (deduped requests are shared). */
  readonly wantedBy: readonly string[];
  readonly ok: boolean;
  /** Whether APVM served the whole warm from cache (no build ran); present on success. */
  readonly fromCache?: boolean;
  /** The failure message; present on failure. */
  readonly error?: string;
}

/** A build request skipped because it is an operator-provided zip — there is nothing to warm. */
export interface WarmSkip {
  readonly label: string;
  readonly role: string;
  /** The `E2E_<ROLE>_ZIP` path that made this role a provided zip. */
  readonly rawPath: string;
}

/** A unit whose plan could not be built (e.g. a ref+zip conflict) — collected, never fatal to the batch. */
export interface WarmPlanFailure {
  readonly label: string;
  readonly error: string;
}

/** The aggregate outcome of a warm run. `ok` iff every plan built and every warm succeeded. */
export interface WarmSummary {
  readonly results: readonly WarmResult[];
  readonly skipped: readonly WarmSkip[];
  readonly planFailures: readonly WarmPlanFailure[];
  /** Deduplicated planner warnings (inapplicable/ignored env vars). */
  readonly warnings: readonly string[];
  readonly ok: boolean;
}

/**
 * Warms one build request into APVM's cache. Injected into {@link warmArtifacts} so the
 * orchestration is testable without APVM; {@link createApvmWarmer} provides the real one.
 */
export type WarmOne = (
  params: ApvmBuildParams,
) => Promise<{ fromCache: boolean }>;

/**
 * Plans every unit (same code path as the resolver — the parity invariant), then warms each
 * **distinct** build request once, serially. Operator-provided zips are skipped (nothing to
 * build); per-unit plan failures and per-request warm failures are collected, never thrown, so
 * one bad unit never aborts the batch — the caller decides what to do with the summary.
 *
 * @param units - the `(product × cell)`s to warm.
 * @param env - the already-read `E2E_*` overrides ({@link ArtifactEnv}); applied because warm
 * plans in the same `serial: false` mode a real run of one cell does.
 * @param warmOne - the cache primer (real or a test double).
 */
export async function warmArtifacts(
  units: readonly WarmUnit[],
  env: ArtifactEnv,
  warmOne: WarmOne,
): Promise<WarmSummary> {
  const warnings: string[] = [];
  const skipped: WarmSkip[] = [];
  const planFailures: WarmPlanFailure[] = [];
  const requests = new Map<
    string,
    { params: ApvmBuildParams; wantedBy: string[] }
  >();

  for (const unit of units) {
    collectUnit(unit, env, { warnings, skipped, planFailures, requests });
  }

  const results: WarmResult[] = [];
  for (const { params, wantedBy } of requests.values()) {
    results.push(await warmRequest(params, wantedBy, warmOne));
  }

  const ok = planFailures.length === 0 && results.every((r) => r.ok);
  return { results, skipped, planFailures, warnings, ok };
}

/** Accumulators threaded through {@link collectUnit} while planning the batch. */
interface Accumulators {
  readonly warnings: string[];
  readonly skipped: WarmSkip[];
  readonly planFailures: WarmPlanFailure[];
  readonly requests: Map<
    string,
    { params: ApvmBuildParams; wantedBy: string[] }
  >;
}

/**
 * Plans one unit and folds its requests into the batch: build requests are deduped by
 * {@link requestKey} (each unit that wants a request is recorded), provided-zip requests are
 * recorded as skips, planner warnings are collected once, and a plan throw becomes a captured
 * {@link WarmPlanFailure}.
 */
function collectUnit(
  unit: WarmUnit,
  env: ArtifactEnv,
  acc: Accumulators,
): void {
  let plan;
  try {
    plan = buildArtifactPlan({
      product: unit.manifest,
      edition: unit.edition,
      // Warm as a real run of one cell plans (overrides apply) — the parity invariant.
      serial: false,
      env,
    });
  } catch (error) {
    acc.planFailures.push({ label: unit.label, error: errorMessage(error) });
    return;
  }

  for (const warning of plan.warnings) {
    if (!acc.warnings.includes(warning)) acc.warnings.push(warning);
  }

  for (const request of plan.requests) {
    if (request.kind === "zip") {
      acc.skipped.push({
        label: unit.label,
        role: request.role,
        rawPath: request.rawPath,
      });
      continue;
    }
    const key = requestKey(request.params);
    const existing = acc.requests.get(key);
    if (existing === undefined) {
      acc.requests.set(key, { params: request.params, wantedBy: [unit.label] });
    } else if (!existing.wantedBy.includes(unit.label)) {
      existing.wantedBy.push(unit.label);
    }
  }
}

/** Warms one request, converting a thrown error into a failed {@link WarmResult}. */
async function warmRequest(
  params: ApvmBuildParams,
  wantedBy: readonly string[],
  warmOne: WarmOne,
): Promise<WarmResult> {
  try {
    const { fromCache } = await warmOne(params);
    return { params, wantedBy, ok: true, fromCache };
  } catch (error) {
    // Redact at the funnel too (idempotent): `createApvmWarmer` scrubs its own rejection, but
    // an `Apvm` that failed to initialise — or any other injected warmer — surfaces here.
    return {
      params,
      wantedBy,
      ok: false,
      error: redactSecrets(errorMessage(error)),
    };
  }
}

/**
 * The dedupe key for a build request: the tuple that fixes what APVM produces. Two requests
 * with the same key resolve to the same cache entry, so warming one covers both. (Distinct keys
 * that resolve to the same commit — e.g. `develop` vs `branch:develop` — are not merged here;
 * APVM's own cache absorbs that, re-resolving then hitting the cached commit build.)
 */
function requestKey(params: ApvmBuildParams): string {
  return [
    params.project,
    params.gitRef,
    params.version ?? "",
    (params.variants ?? []).join("+"),
  ].join("::");
}

/**
 * The real {@link WarmOne}: asserts a token for private-source products (before any clone),
 * then calls `apvm.warmCache` with a progress reporter, enriching a failure
 * with the builder's reason and last output lines.
 */
export function createApvmWarmer(): WarmOne {
  return async (params) => {
    const apvm = await getApvm();
    assertToken(apvm, params.project);

    const label = `${params.project} ${params.gitRef}`;
    const reporter = createBuildReporter(`warm ${label}`);
    const options: WarmOptions = {
      project: params.project,
      gitRef: params.gitRef,
      ...(params.version !== undefined ? { version: params.version } : {}),
      ...(params.variants !== undefined
        ? { variants: [...params.variants] }
        : {}),
    };

    const output = await apvm
      .warmCache(options, reporter.onProgress)
      .catch((error: unknown) => {
        // Redact: a private-repo warm's error text can echo the authenticated remote URL.
        throw new Error(
          `APVM warm of ${label} failed: ${redactSecrets(errorMessage(error))}${reporter.failureContext()}`,
        );
      });
    return { fromCache: output.fromCache };
  };
}
