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

import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { errorMessage } from "../guards";
import { REPO_ROOT, RUN_ID } from "../config/run-context";
import {
  assertToken,
  createBuildReporter,
  getApvm,
  redactBuildText,
  toArtifactOrigin,
} from "./apvm";
import { sha256File } from "./digest";
import { fullCommit, pinOf } from "./pin";
import { ARTIFACT_ENV_VARS } from "./request";
import type {
  ArtifactRequest,
  ArtifactRole,
  BuildRequest,
  ResolvedArtifact,
  RoleOutcome,
  ZipRequest,
} from "./types";
import type {
  BuildOptions,
  JsBuildOutput,
  JsProducedArtifact,
} from "apvm-napi";

/** Inputs to {@link resolveArtifacts}. */
export interface ResolveParams {
  /** The per-role requests from the pure planner (`buildArtifactPlan`). */
  readonly requests: readonly ArtifactRequest[];
  /** Absolute path to the cell's artifacts dir (`REPO_ROOT` + `dirs().artifacts`); wiped here. */
  readonly artifactsDir: string;
  /**
   * The WordPress plugin slug every role of this cell must carry — the expected identity's slug
   * for the cell's edition. Stamped onto each {@link ResolvedArtifact} so consumers can address
   * the plugin without knowing the edition; the identity preflight then proves each archive
   * actually matches it, and nothing is persisted unless it does. One value per cell, because a
   * cell is a single edition.
   */
  readonly slug: string;
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
 * a {@link RoleOutcome} per role. Sequential by design. Never rejects for a per-role failure —
 * only for a provided zip the wipe would destroy (a configuration error caught before anything
 * is touched) or an I/O fault wiping/creating the base dir, a genuine environment problem.
 */
export async function resolveArtifacts(
  params: ResolveParams,
): Promise<RoleOutcome[]> {
  const { requests, artifactsDir, slug } = params;
  const zipRequests = requests.filter(
    (request): request is ZipRequest => request.kind === "zip",
  );

  // Abort BEFORE the wipe if a provided zip lives inside the directory about to be deleted:
  // continuing would destroy the operator's own file. Like the planner's ref+zip conflict this
  // is a configuration error, not an artifact failure, so it fails fast instead of joining the
  // aggregated report — and nothing has been touched when it does.
  assertZipsSurviveWipe(zipRequests, artifactsDir);

  // Validate the rest before the wipe too, so a "does not exist" verdict describes the
  // filesystem the operator configured rather than one we just modified.
  const sources = new Map<ArtifactRole, string | ResolveError>();
  for (const request of zipRequests) {
    sources.set(request.role, validateZipSource(request));
  }

  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  const outcomes: RoleOutcome[] = [];
  for (const request of requests) {
    outcomes.push(
      await resolveRole(request, artifactsDir, slug, sources.get(request.role)),
    );
  }
  return outcomes;
}

/**
 * What producing a role yields on its own: everything about the delivered zip except the cell's
 * expected {@link ResolvedArtifact.slug} and the zip's digest, which {@link resolveRole} adds — the
 * slug so neither producer has to know about identity, the digest so both are hashed in one place.
 */
export type ProducedArtifact = Omit<ResolvedArtifact, "slug" | "sha256">;

/**
 * Mode every resolved zip is normalised to: readable by anyone, writable only by its owner.
 *
 * A build lands `0600`, and getting it onto a site copies it verbatim — `docker cp` preserves the
 * host mode **and** the numeric owner, neither of which means anything inside the container, so
 * WP-CLI there (a different uid) cannot open the archive and `wp plugin install` fails with an
 * opaque `PCLZIP_ERR_READ_OPEN_FAIL`. The same applies to a `local` site whose `wp` runs as another
 * user. Normalising the artifact once, here, fixes every transport at no per-scenario cost, and is
 * the honest place for it: an artifact nothing but its creator can read is not yet usable.
 *
 * Safe to apply because what lands in the role dir is always a **copy** — a cache hit is copied,
 * not hard-linked — so this never reaches through to APVM's shared cache.
 */
const ARTIFACT_MODE = 0o644;

/** Resolves one role into its subdir, converting any thrown error into a failed outcome. */
async function resolveRole(
  request: ArtifactRequest,
  artifactsDir: string,
  slug: string,
  zipSource: string | ResolveError | undefined,
): Promise<RoleOutcome> {
  const roleDir = join(artifactsDir, request.role);
  console.log(`[artifacts] resolving "${request.role}" — ${describe(request)}`);
  try {
    await mkdir(roleDir, { recursive: true });
    const produced =
      request.kind === "zip"
        ? await resolveZipRequest(request, roleDir, zipSource)
        : await resolveBuildRequest(request, roleDir);
    // One funnel for both producers, so a built zip and an operator-provided one are equally
    // installable on every transport — and equally identified by the bytes this run will install.
    await chmod(produced.zipPath, ARTIFACT_MODE);
    const sha256 = await sha256File(produced.zipPath);
    return {
      role: request.role,
      kind: "resolved",
      artifact: { ...produced, slug, sha256 },
    };
  } catch (error) {
    const hint = error instanceof ResolveError ? error.hint : undefined;
    return {
      role: request.role,
      kind: "failed",
      // Redact at the funnel too (idempotent): the APVM call sites already scrub their own
      // rejections, but anything else thrown in here — an `Apvm` that failed to initialise,
      // future code — reaches the aggregated report through this one path.
      error: redactBuildText(errorMessage(error)),
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
 * Fails fast when a provided zip sits inside the cell's artifacts dir — the directory the next
 * statement deletes whole. Reusing "the zip the last run built" is an easy thing for an operator
 * to reach for, and without this guard the wipe silently destroys it and the run then reports
 * the file as missing. Checked for **every** provided zip, before anything is removed.
 *
 * @throws Error naming the variable, the path, and how to fix it.
 */
function assertZipsSurviveWipe(
  requests: readonly ZipRequest[],
  artifactsDir: string,
): void {
  for (const request of requests) {
    const absPath = resolve(REPO_ROOT, request.rawPath);
    if (!isInside(artifactsDir, absPath)) continue;
    const varName = ARTIFACT_ENV_VARS[request.role].zip;
    throw new Error(
      `[artifacts] ${varName} points to "${absPath}", which is inside this cell's ephemeral ` +
        `artifacts directory ("${artifactsDir}"). That directory is wiped whole at the start of ` +
        "every resolution, so the file would be deleted before it could be used. Copy the zip " +
        "somewhere outside it (e.g. the repo root or a temp dir) and point the variable there.",
    );
  }
}

/**
 * Validates an operator-provided zip — it ends in `.zip`, exists, and is a file — returning its
 * absolute path, or the {@link ResolveError} to report for that role. A relative path resolves
 * against {@link REPO_ROOT}, never `process.cwd()`. Runs *before* the wipe, so the checks see
 * the filesystem the operator described. Containment is already ruled out by
 * {@link assertZipsSurviveWipe}.
 */
function validateZipSource(request: ZipRequest): string | ResolveError {
  const varName = ARTIFACT_ENV_VARS[request.role].zip;
  const absPath = resolve(REPO_ROOT, request.rawPath);

  if (!absPath.toLowerCase().endsWith(".zip")) {
    return new ResolveError(
      `${varName} must point to a ".zip" file, but got "${request.rawPath}".`,
    );
  }
  if (!existsSync(absPath)) {
    return new ResolveError(
      `${varName} points to "${absPath}", which does not exist.`,
      "Use an absolute path, or one relative to the repo root.",
    );
  }
  try {
    if (!statSync(absPath).isFile()) {
      return new ResolveError(
        `${varName} points to "${absPath}", which is not a file.`,
      );
    }
  } catch (error) {
    return new ResolveError(
      `${varName} points to "${absPath}", which could not be read: ${errorMessage(error)}.`,
    );
  }
  return absPath;
}

/** Whether `path` sits at or below `dir` (both absolute), i.e. the wipe would remove it. */
function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), path);
  // "" ⇒ the same path; a `..` prefix or an absolute result ⇒ outside (or another volume).
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

/**
 * Copies a {@link validateZipSource}-approved zip into the role dir, so the on-disk layout is
 * uniform and immune to the source moving mid-run.
 *
 * @throws {@link ResolveError} carried over from validation, or if none was recorded (internal).
 */
async function resolveZipRequest(
  request: ZipRequest,
  roleDir: string,
  source: string | ResolveError | undefined,
): Promise<ProducedArtifact> {
  if (source === undefined) {
    throw new ResolveError(
      `internal: the "${request.role}" zip was not validated before the wipe.`,
    );
  }
  if (source instanceof ResolveError) throw source;

  const filename = basename(source);
  const dest = join(roleDir, filename);
  await copyFile(source, dest);
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
): Promise<ProducedArtifact> {
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
      // Not scrubbed here: `failureContext()` scrubs itself, and `resolveRole` scrubs every
      // message it turns into a failed outcome — which is the only way out of this function.
      throw new ResolveError(
        `APVM build of ${label} failed: ${errorMessage(error)}${reporter.failureContext()}`,
      );
    });

  return builtArtifact(request, output);
}

/**
 * Describes the zip a build delivered for `request`, from APVM's output.
 *
 * Records the **full** commit, never `commitShort`: a short SHA can turn ambiguous. A release download
 * has none — APVM reports `release-<tag>` there. Either way it records the pinned ref, the only
 * record of the tag a `release:latest-stable` chose; a build that cannot be pinned is still
 * delivered — this run tested what it built — just without one.
 *
 * @param request - the role's build request.
 * @param output - what `apvm.build` resolved with.
 * @throws {@link ResolveError} when the output is not the one zip the role expects.
 */
export function builtArtifact(
  request: BuildRequest,
  output: JsBuildOutput,
): ProducedArtifact {
  const { params } = request;
  const artifact = pickArtifact(output.result.artifacts, params.variants?.[0]);
  const commit = fullCommit(output.commit);
  const pin = pinOf({
    commit: output.commit,
    source: output.resolvedRef.source,
    version: output.result.version,
  });
  return {
    role: request.role,
    zipPath: artifact.path,
    zipFilename:
      artifact.filename !== "" ? artifact.filename : basename(artifact.path),
    source: request.source,
    ref: params.gitRef,
    ...(commit !== undefined ? { commit } : {}),
    ...("ref" in pin ? { pinRef: pin.ref } : {}),
    version: output.result.version,
    origin: toArtifactOrigin(artifact.origin),
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

// ── Persistence (the cross-process channel to worker fixtures) ───────────────────

/**
 * Writes `resolution.json` into the (wiped) cell dir — the execution's role→artifact map that
 * separate Playwright worker processes read (they never resolve). Living inside the wiped dir, it
 * can never describe a previous execution; it also gives version-aware tests their build metadata
 * for free. The `runId` stamp lets a consumer notice it is reading a *previous* invocation's
 * resolution (a `--no-deps` run), which would otherwise look identical to a fresh one.
 * Non-secret. Called only after every role resolved and verified — which is what makes the
 * persisted {@link ResolvedArtifact.slug} a verified slug rather than a mere expectation.
 */
export async function writeResolutionFile(
  artifactsDir: string,
  resolved: readonly ResolvedArtifact[],
): Promise<void> {
  const doc = {
    runId: RUN_ID,
    resolvedAt: new Date().toISOString(),
    roles: Object.fromEntries(
      resolved.map((a) => [
        a.role,
        {
          slug: a.slug,
          zipPath: a.zipPath,
          zipFilename: a.zipFilename,
          source: a.source,
          ...(a.ref !== undefined ? { ref: a.ref } : {}),
          ...(a.commit !== undefined ? { commit: a.commit } : {}),
          ...(a.pinRef !== undefined ? { pinRef: a.pinRef } : {}),
          ...(a.version !== undefined ? { version: a.version } : {}),
          ...(a.sha256 !== undefined ? { sha256: a.sha256 } : {}),
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
