/**
 * Resolution: turn the pure planner's {@link ArtifactRequest}s into real zips on disk. For each
 * role it either builds a git ref through APVM or copies an operator-provided zip, into a wiped
 * `.artifacts/<product>/<cell>/<role>/` dir. Every execution wipes and re-resolves —
 * refs re-run (a cache hit is a cheap copy), provided zips are copied in — so the only
 * cross-execution reuse layer is APVM's own cache (`~/.apvm/cache`), which we never touch here.
 *
 * Failures are captured **per role** as {@link RoleOutcome} values, not thrown, so one role's
 * failure never prevents another from resolving; the setup project feeds every outcome to the
 * aggregated preflight (`verify.ts`). Resolution runs sequentially for readable logs.
 */

import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { errorMessage } from "../guards";
import { REPO_ROOT } from "../config/run-context";
import { assertToken, createBuildReporter, getApvm } from "./apvm";
import { ARTIFACT_ENV_VARS } from "./request";
import type {
  ArtifactOrigin,
  ArtifactRequest,
  BuildRequest,
  ResolvedArtifact,
  RoleOutcome,
  ZipRequest,
} from "./types";
import type { BuildOptions, JsProducedArtifact } from "apvm-napi";

/** Inputs to {@link resolveArtifacts}. */
export interface ResolveParams {
  /** The per-role requests from the pure planner (`buildArtifactPlan`). */
  readonly requests: readonly ArtifactRequest[];
  /** Absolute path to the cell's artifacts dir (`REPO_ROOT` + `dirs().artifacts`); wiped here. */
  readonly artifactsDir: string;
}

/**
 * A resolution error carrying an optional actionable hint, surfaced under the message in the
 * aggregated report. Thrown internally per role and converted to a failed {@link RoleOutcome}.
 */
class ResolveError extends Error {
  /** Actionable next step shown beneath the error, when one adds value. */
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ResolveError";
    if (hint !== undefined) this.hint = hint;
  }
}

/**
 * Wipes the cell's artifacts dir, then resolves each request into its own role subdir, collecting
 * a {@link RoleOutcome} per role. Sequential by design. Never rejects for a per-role
 * failure — only for an I/O fault wiping/creating the base dir, which is a genuine environment
 * problem.
 */
export async function resolveArtifacts(
  params: ResolveParams,
): Promise<RoleOutcome[]> {
  const { requests, artifactsDir } = params;
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  const outcomes: RoleOutcome[] = [];
  for (const request of requests) {
    outcomes.push(await resolveRole(request, artifactsDir));
  }
  return outcomes;
}

/** Resolves one role into its subdir, converting any thrown error into a failed outcome. */
async function resolveRole(
  request: ArtifactRequest,
  artifactsDir: string,
): Promise<RoleOutcome> {
  const roleDir = join(artifactsDir, request.role);
  console.log(`[artifacts] resolving "${request.role}" — ${describe(request)}`);
  try {
    await mkdir(roleDir, { recursive: true });
    const artifact =
      request.kind === "zip"
        ? await resolveZipRequest(request, roleDir)
        : await resolveBuildRequest(request, roleDir);
    return { role: request.role, kind: "resolved", artifact };
  } catch (error) {
    const hint = error instanceof ResolveError ? error.hint : undefined;
    return {
      role: request.role,
      kind: "failed",
      error: errorMessage(error),
      ...(hint !== undefined ? { hint } : {}),
    };
  }
}

/** A one-line description of what a request will do, for the pre-resolution log line. */
function describe(request: ArtifactRequest): string {
  if (request.kind === "zip") return `zip ${request.rawPath}`;
  const variant = request.params.variants?.[0];
  return `build ${request.params.gitRef}${variant !== undefined ? ` [${variant}]` : ""}`;
}

// ── Provided-zip resolution ─────────────────────────────────────────────────────

/**
 * Validates an operator-provided zip (exists, is a file, ends in `.zip`) and copies it into the
 * role dir, so the on-disk layout is uniform and immune to the source moving mid-run.
 * A relative path resolves against {@link REPO_ROOT}, never `process.cwd()`.
 *
 * @throws {@link ResolveError} naming the env var and path on any validation failure.
 */
async function resolveZipRequest(
  request: ZipRequest,
  roleDir: string,
): Promise<ResolvedArtifact> {
  const varName = ARTIFACT_ENV_VARS[request.role].zip;
  const absPath = isAbsolute(request.rawPath)
    ? request.rawPath
    : join(REPO_ROOT, request.rawPath);

  if (!request.rawPath.toLowerCase().endsWith(".zip")) {
    throw new ResolveError(
      `${varName} must point to a ".zip" file, but got "${request.rawPath}".`,
    );
  }
  if (!existsSync(absPath)) {
    throw new ResolveError(
      `${varName} points to "${absPath}", which does not exist.`,
      "Use an absolute path, or one relative to the repo root.",
    );
  }
  if (!statSync(absPath).isFile()) {
    throw new ResolveError(
      `${varName} points to "${absPath}", which is not a file.`,
    );
  }

  const filename = basename(absPath);
  const dest = join(roleDir, filename);
  await copyFile(absPath, dest);
  return {
    role: request.role,
    zipPath: dest,
    zipFilename: filename,
    source: "env-zip",
    origin: "copied",
    resolvedAt: new Date().toISOString(),
  };
}

// ── APVM-build resolution ────────────────────────────────────────────────────────

/**
 * Builds a role through APVM into the role dir. Asserts a token first for private-source products
 * (so a missing one fails before any clone), then runs the build, enriching a
 * failure with the builder's reason and last output lines.
 *
 * @throws {@link ResolveError} on a missing token or a build failure; a plain `Error` from the
 * token assertion also propagates (already carries the fix).
 */
async function resolveBuildRequest(
  request: BuildRequest,
  roleDir: string,
): Promise<ResolvedArtifact> {
  const { params } = request;
  const apvm = await getApvm();
  assertToken(apvm, params.project);

  const label = `${request.role} ${params.gitRef}`;
  const reporter = createBuildReporter(label);
  const options: BuildOptions = {
    project: params.project,
    gitRef: params.gitRef,
    outputDir: roleDir,
    ...(params.version !== undefined ? { version: params.version } : {}),
    ...(params.variants !== undefined
      ? { variants: [...params.variants] }
      : {}),
  };

  const output = await apvm
    .build(options, reporter.onProgress)
    .catch((error: unknown) => {
      throw new ResolveError(
        `APVM build of ${label} failed: ${errorMessage(error)}${reporter.failureContext()}`,
      );
    });

  const artifact = pickArtifact(output.result.artifacts, params.variants?.[0]);
  return {
    role: request.role,
    zipPath: artifact.path,
    zipFilename:
      artifact.filename !== "" ? artifact.filename : basename(artifact.path),
    source: request.source,
    ref: params.gitRef,
    commit: output.commitShort,
    version: output.result.version,
    origin: toOrigin(artifact.origin),
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Selects the single artifact a role expects from APVM's output: the one matching the requested
 * variant, else the sole artifact when exactly one was produced.
 *
 * @throws {@link ResolveError} when the output is not the expected single artifact (0, or >1 with
 * no variant match) — every role resolves to exactly one zip.
 */
function pickArtifact(
  artifacts: readonly JsProducedArtifact[],
  variant: string | undefined,
): JsProducedArtifact {
  if (variant !== undefined) {
    const match = artifacts.find((a) => a.variantId === variant);
    if (match !== undefined) return match;
  }
  const [only, ...rest] = artifacts;
  if (only !== undefined && rest.length === 0) return only;
  throw new ResolveError(
    `APVM produced ${String(artifacts.length)} artifact(s); expected exactly one for this role` +
      `${variant !== undefined ? ` (variant "${variant}")` : ""}.`,
  );
}

/** Narrows APVM's artifact `origin` string to our {@link ArtifactOrigin}, defaulting defensively. */
function toOrigin(origin: string): ArtifactOrigin {
  return origin === "built" || origin === "cache" || origin === "downloaded"
    ? origin
    : "built";
}

// ── Persistence (the cross-process channel to worker fixtures) ───────────────────

/**
 * Writes `resolution.json` into the (wiped) cell dir — the execution's role→artifact map that
 * separate Playwright worker processes read (they never resolve). Living inside the wiped dir, it
 * can never describe a previous execution; it also gives version-aware tests their build metadata
 * for free. Non-secret. Called only after every role resolved and verified.
 */
export async function writeResolutionFile(
  artifactsDir: string,
  resolved: readonly ResolvedArtifact[],
): Promise<void> {
  const doc = {
    resolvedAt: new Date().toISOString(),
    roles: Object.fromEntries(
      resolved.map((a) => [
        a.role,
        {
          zipPath: a.zipPath,
          zipFilename: a.zipFilename,
          source: a.source,
          ...(a.ref !== undefined ? { ref: a.ref } : {}),
          ...(a.commit !== undefined ? { commit: a.commit } : {}),
          ...(a.version !== undefined ? { version: a.version } : {}),
          origin: a.origin,
          resolvedAt: a.resolvedAt,
        },
      ]),
    ),
  };
  await writeFile(
    join(artifactsDir, "resolution.json"),
    JSON.stringify(doc, null, 2) + "\n",
    "utf8",
  );
}
