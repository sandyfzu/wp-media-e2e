/**
 * The consumption side of the artifact capability: how a test (via the `pluginArtifact`
 * fixture) reads back a role's resolved zip for its cell. The setup project resolves and
 * verifies the zips once and writes `resolution.json`; this module reads that
 * map — through the per-process registry memo first, then the file — and hands the caller a
 * {@link ResolvedArtifact}.
 *
 * Two guards make an unverified or missing artifact impossible to consume silently:
 *  - requesting a role the product's manifest does not declare (e.g. `previous` on BackWPup)
 *    throws an error **before** any file is read — a comparison test cannot run against a
 *    role that was never resolved or verified;
 *  - a missing `resolution.json` (the setup did not run for this cell, e.g. a `--no-deps`
 *    invocation) throws an actionable error naming the fix.
 *
 * The pure {@link parseResolution} is split out so the on-disk contract is unit-testable
 * without a filesystem; `readResolvedArtifact` is the thin fixture-facing entry point.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { errorMessage, isNonEmptyString, isObject } from "../guards";
import { REPO_ROOT, RUN_ID, dirs } from "../config/run-context";
import { isSha256 } from "./digest";
import { rolesOf } from "./manifest";
import { getManifest, peekArtifacts, registerArtifacts } from "./registry";
import type {
  ArtifactOrigin,
  ArtifactRole,
  ArtifactSource,
  CellArtifacts,
  ResolvedArtifact,
} from "./types";

/** The valid {@link ArtifactSource} values, for validating a parsed `resolution.json`. */
const SOURCES: ReadonlySet<string> = new Set<ArtifactSource>([
  "default-ref",
  "env-ref",
  "env-zip",
]);

/** The valid {@link ArtifactOrigin} values, for validating a parsed `resolution.json`. */
const ORIGINS: ReadonlySet<string> = new Set<ArtifactOrigin>([
  "built",
  "cache",
  "downloaded",
  "copied",
]);

/**
 * Returns the resolved artifact for a `(product, cell)`'s role — the value the
 * `pluginArtifact` fixture hands to a scenario.
 *
 * @throws Error if the product's manifest does not declare `role` (the unsupported-role
 * guard), or if no `resolution.json` exists for the cell (the setup did not run), or if a
 * supported role is unexpectedly absent from the resolution.
 */
export function readResolvedArtifact(
  product: string,
  cell: string,
  role: ArtifactRole,
): ResolvedArtifact {
  // Unsupported-role guard first: reject a role the product does not support before
  // touching the filesystem, so a comparison test can never consume a role that was never
  // resolved or verified.
  if (!rolesOf(getManifest(product)).includes(role)) {
    throw new Error(
      `[artifacts] the "${role}" role is not configured for product "${product}". ` +
        `This product has no "${role}" artifact configured yet. Declare a "${role}" ` +
        "default ref (and version) in the product manifest before a test consumes it.",
    );
  }

  const artifacts = loadCellArtifacts(product, cell);
  const artifact = artifacts[role];
  if (artifact === undefined) {
    throw new Error(
      `[artifacts] the "${role}" role is supported by "${product}" but absent from this cell's ` +
        `resolution — the artifacts setup may not have completed. Re-run the setup for "${cell}".`,
    );
  }
  // The resolution names a zip; confirm it is still there. Handing a caller a path that no
  // longer exists only defers the failure to `wp plugin install`, where the cause is invisible.
  if (!existsSync(artifact.zipPath)) {
    throw new Error(
      `[artifacts] the resolved "${role}" zip for "${product}/${cell}" is gone ` +
        `("${artifact.zipPath}" no longer exists). The artifacts directory is ephemeral — ` +
        "re-run the artifacts setup for this cell (run it with E2E_CELL=<cell>, not --no-deps).",
    );
  }
  return artifact;
}

/**
 * Returns a cell's resolved artifacts, reading `resolution.json` at most once per process:
 * the registry memo is probed first (a same-process hit — or a prior worker-side read), and
 * a fresh disk read is memoized back into it. Playwright workers never resolve, so this file
 * read is the cross-process channel the setup project wrote.
 *
 * @throws Error if the cell has no `resolution.json` — the setup did not run for it in this
 * execution (e.g. a `--no-deps` BDD run).
 */
function loadCellArtifacts(product: string, cell: string): CellArtifacts {
  const memo = peekArtifacts(product, cell);
  if (memo !== undefined) return memo;

  const path = resolutionFilePath(product, cell);
  if (!existsSync(path)) {
    throw new Error(
      `[artifacts] no resolution found for "${product}/${cell}" ("${path}" is missing). ` +
        "The artifacts setup did not run for this cell in this execution — run it with " +
        "E2E_CELL=<cell> (not --no-deps).",
    );
  }

  const doc = readResolutionDoc(path);
  warnIfStale(doc, product, cell);
  const artifacts = parseResolution(doc, path);
  registerArtifacts(product, cell, artifacts);
  return artifacts;
}

/**
 * Warns when the resolution on disk was written by a **different** invocation — i.e. the
 * artifacts setup did not run in this one (a `--no-deps` run, or a worker whose setup was
 * skipped). The zips are still whatever that earlier run resolved and verified, so consuming
 * them is workable and deliberately not fatal (it keeps the fast edit-run loop), but it must
 * never be silent: the scenario would otherwise test a stale ref while looking fresh.
 *
 * Fires at most once per `(product, cell)` per process — the caller memoizes this read. Stays
 * quiet for a resolution written before the stamp existed, and when an orchestrator pins one
 * `RUN_ID` across a batch (then the runs genuinely are one execution).
 */
function warnIfStale(raw: unknown, product: string, cell: string): void {
  const runId =
    isObject(raw) && isNonEmptyString(raw.runId) ? raw.runId : undefined;
  if (runId === undefined || runId === RUN_ID) return;
  console.warn(
    `[artifacts] using the resolution a PREVIOUS execution wrote for "${product}/${cell}" ` +
      `(run "${runId}", this run is "${RUN_ID}") — the artifacts setup did not run here. The ` +
      "zips may be older than the refs you expect; re-run with E2E_CELL=<cell> without --no-deps " +
      "to resolve them afresh.",
  );
}

/** Absolute path to a cell's `resolution.json` (inside its ephemeral artifacts dir). */
export function resolutionFilePath(product: string, cell: string): string {
  return join(REPO_ROOT, dirs(product, cell).artifacts, "resolution.json");
}

/** Reads and JSON-parses `resolution.json`, wrapping a parse failure with the path. */
function readResolutionDoc(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `[artifacts] could not read "${path}": ${errorMessage(error)}. ` +
        "The resolution file may be corrupt — re-run the artifacts setup for this cell.",
      { cause: error },
    );
  }
}

/**
 * Validates a parsed `resolution.json` and turns it into {@link CellArtifacts}, reattaching the
 * `role` (stored as the object key on disk) to each artifact. Pure — the on-disk contract is
 * unit-testable without a filesystem. Only known roles are accepted; any other key is ignored.
 *
 * @param raw - the JSON-parsed document.
 * @param source - a label for error messages (the file path, or a test-supplied name).
 * @throws Error if the document, its `roles` map, or any role entry is malformed.
 */
export function parseResolution(raw: unknown, source: string): CellArtifacts {
  if (!isObject(raw) || !isObject(raw.roles)) {
    throw new Error(
      `[artifacts] malformed resolution in "${source}": expected an object with a "roles" map.`,
    );
  }
  const artifacts: Partial<Record<ArtifactRole, ResolvedArtifact>> = {};
  for (const role of ["plugin", "previous"] as const) {
    const entry = raw.roles[role];
    if (entry !== undefined) {
      artifacts[role] = parseRole(role, entry, source);
    }
  }
  return artifacts;
}

/**
 * Validates one role entry from `resolution.json` into a {@link ResolvedArtifact}, checking the
 * required string fields, narrowing the `source`/`origin` enums, and passing optional
 * `ref`/`commit`/`pinRef`/`version` through when present. A `sha256` must be a well-formed digest when
 * present; its absence is tolerated, since a `resolution.json` written before it was recorded may
 * still be read by a `--no-deps` run.
 *
 * @throws Error naming the role and `source` on any missing/invalid field.
 */
function parseRole(
  role: ArtifactRole,
  entry: unknown,
  source: string,
): ResolvedArtifact {
  if (!isObject(entry)) {
    throw new Error(
      `[artifacts] malformed "${role}" entry in "${source}": expected an object.`,
    );
  }
  const fail = (detail: string): never => {
    throw new Error(
      `[artifacts] malformed "${role}" entry in "${source}": ${detail}.`,
    );
  };

  const slug = requireString(entry.slug, "slug", fail);
  const zipPath = requireString(entry.zipPath, "zipPath", fail);
  const zipFilename = requireString(entry.zipFilename, "zipFilename", fail);
  const resolvedAt = requireString(entry.resolvedAt, "resolvedAt", fail);
  const source_ = requireString(entry.source, "source", fail);
  const origin = requireString(entry.origin, "origin", fail);
  if (!SOURCES.has(source_)) fail(`unknown source "${source_}"`);
  if (!ORIGINS.has(origin)) fail(`unknown origin "${origin}"`);
  // A digest that is present but malformed is a corrupt file, not an old one: never pass it on.
  if (entry.sha256 !== undefined && !isSha256(entry.sha256)) {
    fail('"sha256" must be 64 lowercase hex characters');
  }

  return {
    role,
    slug,
    zipPath,
    zipFilename,
    source: source_ as ArtifactSource,
    origin: origin as ArtifactOrigin,
    resolvedAt,
    ...(isNonEmptyString(entry.ref) ? { ref: entry.ref } : {}),
    ...(isNonEmptyString(entry.commit) ? { commit: entry.commit } : {}),
    ...(isNonEmptyString(entry.pinRef) ? { pinRef: entry.pinRef } : {}),
    ...(isNonEmptyString(entry.version) ? { version: entry.version } : {}),
    ...(isSha256(entry.sha256) ? { sha256: entry.sha256 } : {}),
  };
}

/** Returns `value` as a non-empty string, or calls `fail` naming the offending `field`. */
function requireString(
  value: unknown,
  field: string,
  fail: (detail: string) => never,
): string {
  return isNonEmptyString(value)
    ? value
    : fail(`"${field}" must be a non-empty string`);
}
