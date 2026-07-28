/**
 * The identity preflight: static, read-only inspection that asserts each resolved zip is the
 * exact plugin **and edition** the cell expects. It runs on both built and
 * operator-provided zips, needs no WordPress, mutates nothing, and takes milliseconds.
 *
 * Aggregation is the user-visible contract: every role is verified even when an earlier one
 * failed to resolve or verify, and all findings are collected into one formatted report (same
 * {@link CheckResult} + `styleText` style as `setup/preflight.ts`). `resolve.ts` produces the
 * {@link RoleOutcome}s; `artifacts.setup.ts` renders the report and attaches the JSON summary.
 */

import { styleText } from "node:util";

import AdmZip from "adm-zip";

import { errorMessage } from "../guards";
import type { CheckResult } from "../setup/preflight";
import type { Edition } from "../config/types";
import { resolveIdentity } from "./manifest";
import type {
  ArtifactIdentity,
  ArtifactRole,
  CellArtifacts,
  ProductArtifacts,
  ResolvedArtifact,
  RoleOutcome,
} from "./types";

// ── Report shape ─────────────────────────────────────────────────────────────

/** One role's verification: the checks run (resolution + identity) plus its informational fields. */
export interface RoleReport {
  readonly role: ArtifactRole;
  /** Every check for this role, in order. The role passed iff all are `ok`. */
  readonly checks: readonly CheckResult[];
  /** The resolved artifact, when resolution succeeded; absent for a failed resolution. */
  readonly artifact?: ResolvedArtifact;
  /** Informational (reported, never asserted): version, source, origin, ref, commit. */
  readonly info: Readonly<Record<string, string>>;
}

/** The aggregated result across every role of a `(product × cell)`. */
export interface ArtifactReport {
  readonly roles: readonly RoleReport[];
  /** True iff every role resolved and passed every identity check. */
  readonly ok: boolean;
  /** The successfully-resolved artifacts, for persistence (`resolution.json`) and the registry. */
  readonly resolved: readonly ResolvedArtifact[];
  /** The same artifacts keyed by role, for the in-process registry. */
  readonly artifacts: CellArtifacts;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Verifies every resolution outcome against the identity the manifest+edition expects, collecting
 * per-role results into one {@link ArtifactReport}. A failed resolution becomes a single failed
 * `resolved` check for that role; a successful one is inspected by {@link verifyArtifact}. No
 * role is skipped because another failed.
 *
 * @param edition - the cell's edition; the same expected identity applies to every role of a
 * `(product, cell)`, since a cell is a single edition.
 * @throws Error only for a manifest/programming fault surfaced by {@link resolveIdentity}
 * (edition-ful product with no edition) — never for a bad artifact, which is a reported failure.
 */
export function verifyResolved(
  outcomes: readonly RoleOutcome[],
  manifest: ProductArtifacts,
  edition: Edition | undefined,
): ArtifactReport {
  const expected = resolveIdentity(manifest, edition);
  const roles: RoleReport[] = [];
  const resolved: ResolvedArtifact[] = [];

  for (const outcome of outcomes) {
    if (outcome.kind === "failed") {
      roles.push({
        role: outcome.role,
        checks: [
          {
            name: "resolved",
            ok: false,
            detail: outcome.error,
            ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
          },
        ],
        info: {},
      });
      continue;
    }
    const { checks, headerVersion } = verifyArtifact(
      outcome.artifact.zipPath,
      expected,
    );
    roles.push({
      role: outcome.role,
      checks,
      artifact: outcome.artifact,
      info: infoFor(outcome.artifact, headerVersion),
    });
    resolved.push(outcome.artifact);
  }

  const ok = roles.every(roleOk);
  return { roles, ok, resolved, artifacts: toCellArtifacts(resolved) };
}

// ── Single-artifact identity checks ───────────────────────────────────────────

/**
 * Inspects one resolved zip against its expected {@link ArtifactIdentity}, returning ordered
 * {@link CheckResult}s and the artifact's own `Version:` header (informational). Read-only:
 * opens the central directory and reads a single entry. Checks gate in sequence — if the archive
 * will not parse, or has no single top-level directory, later checks cannot run and are omitted.
 *
 * The main file is looked up under the archive's **actual** top-level directory (not the expected
 * slug), so the `Plugin Name` header is still read — and reported — on a slug mismatch, giving a
 * wrong-edition zip two independent witnesses (slug and header).
 *
 * @param zipPath - absolute path to the resolved zip (inside its wiped role dir).
 * @returns the checks, plus `headerVersion` when a `Version:` header was found.
 */
export function verifyArtifact(
  zipPath: string,
  expected: ArtifactIdentity,
): { checks: CheckResult[]; headerVersion?: string } {
  const checks: CheckResult[] = [];

  let zip: AdmZip;
  let entries: readonly { readonly entryName: string }[];
  try {
    zip = new AdmZip(zipPath);
    entries = zip.getEntries();
  } catch (error) {
    checks.push({
      name: "archive readable",
      ok: false,
      detail: `could not open the zip: ${errorMessage(error)}`,
      hint: "The artifact is not a readable zip archive — the build or copy may have produced a corrupt file.",
    });
    return { checks };
  }
  checks.push({
    name: "archive readable",
    ok: true,
    detail: `${String(entries.length)} entries.`,
  });

  const top = topLevelDir(entries);
  if (top.kind !== "single") {
    checks.push({
      name: "single top-level directory",
      ok: false,
      detail: top.detail,
      hint: `A plugin zip must contain exactly one top-level directory (the slug "${expected.slug}").`,
    });
    return { checks };
  }
  checks.push({
    name: "single top-level directory",
    ok: true,
    detail: `"${top.dir}/".`,
  });

  // Slug — the one check that pins both product and edition.
  checks.push(
    top.dir === expected.slug
      ? { name: "plugin slug", ok: true, detail: `"${top.dir}".` }
      : {
          name: "plugin slug",
          ok: false,
          detail: `expected "${expected.slug}", found "${top.dir}".`,
          hint: `This zip is "${top.dir}", not "${expected.slug}" — a different plugin or edition than this cell expects. Pass a matching zip/ref, or drop the override.`,
        },
  );

  const mainEntry = zip.getEntry(`${top.dir}/${expected.mainFile}`);
  if (mainEntry === null) {
    checks.push({
      name: "main file",
      ok: false,
      detail: `"${expected.mainFile}" not found under "${top.dir}/".`,
      hint: "The zip does not contain the plugin's expected main file.",
    });
    return { checks };
  }
  checks.push({
    name: "main file",
    ok: true,
    detail: `"${top.dir}/${expected.mainFile}".`,
  });

  // Plugin Name header — exact equality, so "BackWPup" can never satisfy "BackWPup Pro".
  const header = headerBlock(mainEntry.getData());
  const foundName = parseHeader(header, "Plugin Name");
  checks.push(
    foundName === expected.pluginName
      ? { name: "plugin name", ok: true, detail: `"${foundName}".` }
      : {
          name: "plugin name",
          ok: false,
          detail: `expected "${expected.pluginName}", found ${foundName === undefined ? "no Plugin Name header" : `"${foundName}"`}.`,
          hint: "The main file's Plugin Name header does not match this cell's expected plugin/edition.",
        },
  );

  const headerVersion = parseHeader(header, "Version");
  return headerVersion === undefined ? { checks } : { checks, headerVersion };
}

// ── Zip structure & header parsing ─────────────────────────────────────────────

/** The top-level structure of a zip: a single directory, or why it is not one. */
type TopLevel =
  | { readonly kind: "single"; readonly dir: string }
  | {
      readonly kind: "empty" | "root-files" | "multiple";
      readonly detail: string;
    };

/**
 * The resource-fork sidecar macOS's zipper writes beside the real payload. WordPress's own
 * unzipper skips it explicitly (`unzip_file()` ignores anything under `__MACOSX/`), so a
 * plugin zip produced by Finder's "Compress" installs perfectly — the identity check must not
 * reject the same archive. Only ever relevant for an operator-provided `E2E_*_ZIP`; APVM's
 * builds never contain it.
 */
const OS_SIDECAR_DIR = "__MACOSX";

/**
 * Derives the archive's top-level structure from its entry names, tolerant of whether an explicit
 * directory entry (`"slug/"`) is present and of macOS's {@link OS_SIDECAR_DIR} sidecar. A valid
 * plugin zip has exactly one top-level directory and no files at the root.
 */
function topLevelDir(
  entries: readonly { readonly entryName: string }[],
): TopLevel {
  const names = entries.map((e) => e.entryName).filter((n) => n.length > 0);
  if (names.length === 0) return { kind: "empty", detail: "the zip is empty." };

  const top = new Set<string>();
  let rootFile = false;
  for (const name of names) {
    const slash = name.indexOf("/");
    const head = slash === -1 ? name : name.slice(0, slash);
    if (head === OS_SIDECAR_DIR) continue;
    if (slash === -1) rootFile = true;
    top.add(head);
  }

  const only = [...top];
  const dir = only[0];
  if (only.length === 1 && !rootFile && dir !== undefined) {
    return { kind: "single", dir };
  }
  if (only.length === 0) {
    return {
      kind: "empty",
      detail: `the zip holds only "${OS_SIDECAR_DIR}" metadata entries.`,
    };
  }
  const found = only.map((t) => `"${t}"`).join(", ");
  return {
    kind: rootFile ? "root-files" : "multiple",
    detail: `found ${found} at the top level.`,
  };
}

/** The first 8 KB of a plugin file, decoded and newline-normalized — WordPress's header window. */
function headerBlock(data: Buffer): string {
  return data.subarray(0, 8192).toString("utf8").replace(/\r\n?/g, "\n");
}

/**
 * Extracts a WordPress plugin header field (e.g. `Plugin Name`, `Version`) from a header block,
 * mirroring core's `get_file_data`: line-anchored, case-insensitive, tolerant of leading comment
 * punctuation. Returns the cleaned value, or `undefined` when the header is absent or blank.
 */
function parseHeader(block: string, field: string): string | undefined {
  const match = new RegExp(
    `^[ \\t/*#@]*${escapeRegExp(field)}:(.*)$`,
    "im",
  ).exec(block);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const value = cleanHeaderValue(raw);
  return value === "" ? undefined : value;
}

/**
 * Trims a header value the way WordPress's `_cleanup_header_comment()` does: everything from a
 * comment or PHP close tag onwards is dropped, so a header whose line also closes the docblock
 * still yields exactly what core would read. Without this the exact-equality name check could
 * reject an artifact WordPress itself reads correctly.
 */
function cleanHeaderValue(raw: string): string {
  return raw.replace(/\s*(?:\*\/|\?>).*/, "").trim();
}

/** Escapes a literal string for safe interpolation into a `RegExp` source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Report formatting (failure report, success summary, JSON attachment) ────────

/** Whether every check of a role passed. */
function roleOk(role: RoleReport): boolean {
  return role.checks.every((check) => check.ok);
}

/** The informational fields surfaced for a resolved artifact (reported, never asserted). */
function infoFor(
  artifact: ResolvedArtifact,
  headerVersion: string | undefined,
): Record<string, string> {
  // Prefer the version read from the zip's own header (the ground truth) over the build's report.
  const version = headerVersion ?? artifact.version;
  return {
    source: artifact.source,
    origin: artifact.origin,
    ...(artifact.ref !== undefined ? { ref: artifact.ref } : {}),
    ...(artifact.commit !== undefined ? { commit: artifact.commit } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/** Collapses a cell's resolved artifacts into a role-keyed {@link CellArtifacts} for the registry. */
function toCellArtifacts(resolved: readonly ResolvedArtifact[]): CellArtifacts {
  const map: Partial<Record<ArtifactRole, ResolvedArtifact>> = {};
  for (const artifact of resolved) map[artifact.role] = artifact;
  return map;
}

/** Renders a role's info map as a single compact `key=value` line, or `undefined` when empty. */
function renderInfo(
  info: Readonly<Record<string, string>>,
): string | undefined {
  const parts = Object.entries(info).map(([key, value]) => `${key}=${value}`);
  return parts.length === 0 ? undefined : parts.join("  ");
}

/** The bold header line for a role: its name and the resolved filename (or a failed-resolution note). */
function roleLabel(role: RoleReport): string {
  return `${role.role} — ${role.artifact?.zipFilename ?? "(resolution failed)"}`;
}

/** Appends a role's ✓/✗ header, its per-check lines with hints, and its info line to `lines`. */
function appendRole(lines: string[], role: RoleReport): void {
  const mark = roleOk(role)
    ? styleText(["green"], "✓")
    : styleText(["bold", "red"], "✗");
  lines.push(`  ${mark} ${styleText(["bold"], roleLabel(role))}`);

  for (const check of role.checks) {
    if (check.ok) {
      lines.push(
        `    ${styleText(["green"], "✓")} ${check.name}: ${check.detail}`,
      );
      continue;
    }
    lines.push(
      `    ${styleText(["red"], "✗")} ${styleText(["bold"], check.name)}: ${check.detail}`,
    );
    if (check.hint !== undefined) {
      for (const hintLine of check.hint.split("\n")) {
        lines.push(`      ${styleText(["yellow"], "→")} ${hintLine}`);
      }
    }
  }

  const info = renderInfo(role.info);
  if (info !== undefined) lines.push(`    ${styleText(["dim"], info)}`);
  lines.push("");
}

/**
 * Formats the aggregated failure report thrown by the setup project: a per-role breakdown with
 * ✓/✗ on every check, expected-vs-found on mismatches, and actionable hints — mirroring the
 * pre-flight report so the two read as one family.
 */
export function formatFailureReport(
  report: ArtifactReport,
  product: string,
  cell: string,
): string {
  const total = report.roles.length;
  const failed = report.roles.filter((role) => !roleOk(role)).length;
  const lines: string[] = [];

  lines.push(
    styleText(
      ["bold"],
      `[artifacts] Plugin artifact verification failed — ${String(failed)} of ${String(total)} role(s) for "${product}/${cell}" did not pass.`,
    ),
  );
  lines.push("Fix the issues below before re-running:\n");

  for (const role of report.roles) appendRole(lines, role);

  const passed = total - failed;
  lines.push(
    passed > 0
      ? `${String(passed)} of ${String(total)} role(s) passed. Resolve the issues above and re-run.`
      : "All roles failed. Resolve the issues above and re-run.",
  );
  return lines.join("\n");
}

/** Formats the concise success summary logged when every role resolved and verified. */
export function formatSuccessSummary(
  report: ArtifactReport,
  product: string,
  cell: string,
): string {
  const lines: string[] = [
    styleText(
      ["bold"],
      `[artifacts] Verified ${String(report.resolved.length)} artifact(s) for "${product}/${cell}":`,
    ),
  ];
  for (const role of report.roles) {
    const info = renderInfo(role.info);
    lines.push(
      `  ${styleText(["green"], "✓")} ${role.role.padEnd(9)}${role.artifact?.zipFilename ?? ""}` +
        (info !== undefined ? `  ${styleText(["dim"], `(${info})`)}` : ""),
    );
  }
  return lines.join("\n");
}

/**
 * Builds the JSON summary attached to the setup test (`testInfo.attach`), so the per-role checks
 * and resolved build metadata land in the HTML/Allure reports. Contains only non-secret data.
 */
export function reportSummary(
  report: ArtifactReport,
  product: string,
  cell: string,
): unknown {
  return {
    product,
    cell,
    ok: report.ok,
    roles: report.roles.map((role) => ({
      role: role.role,
      ok: roleOk(role),
      checks: role.checks.map((check) => ({
        name: check.name,
        ok: check.ok,
        detail: check.detail,
        ...(check.hint !== undefined ? { hint: check.hint } : {}),
      })),
      info: role.info,
      ...(role.artifact !== undefined ? { artifact: role.artifact } : {}),
    })),
  };
}
