import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isNonEmptyString, isObject } from "../guards";
import type {
  CellConfig,
  CellMap,
  Edition,
  FtpServiceConfig,
  S3ServiceConfig,
  ServiceOverrides,
  SiteInput,
  Transport,
} from "./types";

/**
 * Loads and validates a product's site pools from its sites file(s).
 *
 * Reads `sites.json` (primary) plus any `sites.<name>.json` overlays present in
 * `configDir` — e.g. `sites.docker.json`, `sites.local.json`, `sites.ssh.json`.
 * Each file declares a disjoint set of cells; a cell name appearing in more than one
 * file is a hard error. Files are merged in stable order: `sites.json` first, then
 * overlays alphabetically.
 *
 * When no real sites files exist the committed `sites.example.json` is loaded with a
 * warning, so the suite still starts and lists tests on a fresh checkout.
 *
 * Every field is validated with an actionable error naming the offending cell/index,
 * so a malformed file fails fast instead of crashing later in the test run.
 */
export function loadSites(configDir: string): CellMap {
  const files = findSitesFiles(configDir);

  if (files.length === 0) {
    return loadFallback(configDir);
  }

  const loaded: { source: string; cells: CellMap }[] = [];
  for (const filePath of files) {
    loaded.push({ source: filePath, cells: loadAndValidateFile(filePath) });
  }

  return mergeCellMaps(loaded, configDir);
}

/**
 * True for a placeholder/example site — its `baseURL` is on the reserved `.example.test`
 * domain used only by the committed `sites.example.json`. The auth setup skips these so
 * the scaffold stays green before a real `sites.json` exists.
 */
export function isPlaceholderSite(site: { readonly baseURL: string }): boolean {
  try {
    return new URL(site.baseURL).hostname.endsWith(".example.test");
  } catch {
    return false;
  }
}

// ── File discovery ─────────────────────────────────────────────────────────────

/**
 * Returns the list of sites files to load from `configDir`, in merge order:
 * `sites.json` first (if present), then `sites.<name>.json` overlays alphabetically.
 * `sites.example.json` is never included — it is the fallback used only when NO real
 * files exist. Files whose names contain more than one dot between "sites" and ".json"
 * (e.g. `sites.a.b.json`) are ignored to keep the pattern unambiguous.
 */
function findSitesFiles(configDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(configDir);
  } catch {
    return [];
  }

  const files: string[] = [];

  if (entries.includes("sites.json")) {
    files.push(join(configDir, "sites.json"));
  }

  // Matches sites.<single-segment>.json — one dot between "sites" and ".json",
  // with the segment containing no dots itself. Excludes sites.example.json explicitly.
  const overlayRe = /^sites\.[^.]+\.json$/;
  const overlays = entries
    .filter((name) => name !== "sites.example.json" && overlayRe.test(name))
    .sort();

  for (const name of overlays) {
    files.push(join(configDir, name));
  }

  return files;
}

// ── Single-file loading ────────────────────────────────────────────────────────

/** Loads the committed `sites.example.json` (placeholder data) with a warning; used when no real sites file exists. */
function loadFallback(configDir: string): CellMap {
  const example = join(configDir, "sites.example.json");
  console.warn(
    `[sites] No sites.json or sites.*.json found in "${configDir}"; ` +
      `using ${example} (placeholder data). Create sites.json for real runs.`,
  );
  return loadAndValidateFile(example);
}

/** Reads, JSON-parses, and validates one sites file into a {@link CellMap}, throwing an actionable error on read/parse/schema failure. */
function loadAndValidateFile(filePath: string): CellMap {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new Error(`[sites] Cannot read "${filePath}".`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`[sites] "${filePath}" is not valid JSON.`, { cause });
  }

  return validateCellMap(parsed, filePath);
}

// ── Merging ────────────────────────────────────────────────────────────────────

/**
 * Merges the per-file {@link CellMap}s (in load order) into one. A cell defined in two files is a
 * hard error naming both; edition consistency is re-checked across the merged set.
 */
function mergeCellMaps(
  loaded: { source: string; cells: CellMap }[],
  configDir: string,
): CellMap {
  const result: Record<string, CellConfig> = {};
  const cellSource: Record<string, string> = {};

  for (const { source, cells } of loaded) {
    for (const [cell, config] of Object.entries(cells)) {
      const prior = cellSource[cell];
      if (prior !== undefined) {
        throw new Error(
          `[sites] Cell "${cell}" is defined in both "${prior}" and "${source}". ` +
            "Each cell must appear in only one sites file.",
        );
      }
      result[cell] = config;
      cellSource[cell] = source;
    }
  }

  // Edition consistency must hold across the full merged set. The per-file
  // validateCellMap already catches within-file problems early; this catches
  // across-file problems (e.g. one file editionless, another edition-ful).
  const sourceList = loaded.map((l) => l.source).join(", ");
  checkEditionConsistency(
    result,
    `merged sites in "${configDir}" (${sourceList})`,
  );

  return result;
}

// ── Validation helpers ─────────────────────────────────────────────────────────

/** Returns `value` when it is a non-empty string; otherwise throws an error naming `path`. */
function requireString(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`[sites] ${path} must be a non-empty string.`);
  }
  return value;
}

/** Validates a site's `transport` block into a typed {@link Transport} (discriminated on `mode`). */
function validateTransport(value: unknown, path: string): Transport {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  // Shared across all three modes; omitted from the result when absent so the optional
  // property is genuinely missing rather than present-and-undefined.
  const stagingDir = optionalString(value.stagingDir, `${path}.stagingDir`);
  const base = stagingDir !== undefined ? { stagingDir } : {};
  switch (value.mode) {
    case "ssh":
      return {
        ...base,
        mode: "ssh",
        host: requireString(value.host, `${path}.host`),
        username: requireString(value.username, `${path}.username`),
        privateKeyPath: requireString(
          value.privateKeyPath,
          `${path}.privateKeyPath`,
        ),
        rootDir: requireString(value.rootDir, `${path}.rootDir`),
      };
    case "docker": {
      // Optional for docker: the container's WORKDIR is the WP root in the images we use.
      const rootDir = optionalString(value.rootDir, `${path}.rootDir`);
      return {
        ...base,
        mode: "docker",
        container: requireString(value.container, `${path}.container`),
        ...(rootDir !== undefined ? { rootDir } : {}),
      };
    }
    case "local":
      return {
        ...base,
        mode: "local",
        rootDir: requireString(value.rootDir, `${path}.rootDir`),
      };
    default:
      throw new Error(
        `[sites] ${path}.mode must be "ssh" | "docker" | "local" (got ${JSON.stringify(value.mode)}).`,
      );
  }
}

/** Validates an optional string field; absent → `undefined`, present-but-wrong → throws. */
function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireString(value, path);
}

/** Validates an optional finite-number field. */
function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`[sites] ${path} must be a finite number.`);
  }
  return value;
}

/** Validates an optional boolean field. */
function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`[sites] ${path} must be a boolean.`);
  }
  return value;
}

/** Validates a partial FTP override (every field optional; absent keys are omitted, not set to undefined). */
function validateFtpOverride(
  value: unknown,
  path: string,
): Partial<FtpServiceConfig> {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  const host = optionalString(value.host, `${path}.host`);
  const username = optionalString(value.username, `${path}.username`);
  const password = optionalString(value.password, `${path}.password`);
  const port = optionalNumber(value.port, `${path}.port`);
  const secure = optionalBoolean(value.secure, `${path}.secure`);
  return {
    ...(host !== undefined ? { host } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(secure !== undefined ? { secure } : {}),
  };
}

/** Validates a partial S3 override (every field optional; absent keys are omitted, not set to undefined). */
function validateS3Override(
  value: unknown,
  path: string,
): Partial<S3ServiceConfig> {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  const accessKeyId = optionalString(value.accessKeyId, `${path}.accessKeyId`);
  const secretAccessKey = optionalString(
    value.secretAccessKey,
    `${path}.secretAccessKey`,
  );
  const bucket = optionalString(value.bucket, `${path}.bucket`);
  const region = optionalString(value.region, `${path}.region`);
  return {
    ...(accessKeyId !== undefined ? { accessKeyId } : {}),
    ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
    ...(bucket !== undefined ? { bucket } : {}),
    ...(region !== undefined ? { region } : {}),
  };
}

/** Validates a site's `overrides` into a typed {@link ServiceOverrides}; every part is optional. */
function validateOverrides(value: unknown, path: string): ServiceOverrides {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  if (value.storage === undefined) return {};
  if (!isObject(value.storage)) {
    throw new Error(`[sites] ${path}.storage must be an object.`);
  }
  const ftp =
    value.storage.ftp === undefined
      ? undefined
      : validateFtpOverride(value.storage.ftp, `${path}.storage.ftp`);
  const s3 =
    value.storage.s3 === undefined
      ? undefined
      : validateS3Override(value.storage.s3, `${path}.storage.s3`);
  return {
    storage: {
      ...(ftp !== undefined ? { ftp } : {}),
      ...(s3 !== undefined ? { s3 } : {}),
    },
  };
}

/** Validates one entry into a {@link SiteInput}: its required fields plus an optional `overrides` block. */
function validateSite(value: unknown, path: string): SiteInput {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  const base = {
    baseURL: requireString(value.baseURL, `${path}.baseURL`),
    username: requireString(value.username, `${path}.username`),
    password: requireString(value.password, `${path}.password`),
    transport: validateTransport(value.transport, `${path}.transport`),
  };
  if (value.overrides === undefined) return base;
  return {
    ...base,
    overrides: validateOverrides(value.overrides, `${path}.overrides`),
  };
}

/** Validates an optional `edition` value; absent → `undefined`, unknown value → throws. */
function validateEdition(value: unknown, path: string): Edition | undefined {
  if (value === undefined || value === "free" || value === "pro") return value;
  throw new Error(
    `[sites] ${path} must be "free" | "pro" (got ${JSON.stringify(value)}).`,
  );
}

/** Validates a site array into a pool, naming each offending index. */
function validatePool(value: unknown[], path: string): SiteInput[] {
  return value.map((site, index) =>
    validateSite(site, `${path}[${String(index)}]`),
  );
}

/**
 * Validates one cell entry into a {@link CellConfig}. A cell may be a bare site array
 * (editionless) or an object `{ edition?, sites }` (edition-ful, e.g. BackWPup).
 */
function validateCell(value: unknown, path: string): CellConfig {
  if (Array.isArray(value)) {
    return { sites: validatePool(value, path) };
  }
  if (!isObject(value)) {
    throw new Error(
      `[sites] ${path} must be a site array or an object { edition?, sites }.`,
    );
  }
  if (!Array.isArray(value.sites)) {
    throw new Error(`[sites] ${path}.sites must be an array of sites.`);
  }
  const edition = validateEdition(value.edition, `${path}.edition`);
  const sites = validatePool(value.sites, `${path}.sites`);
  return edition === undefined ? { sites } : { edition, sites };
}

/**
 * Editions are all-or-none across a set of cells: if any cell declares one, every cell
 * must. This is checked per-file (to surface problems early) and again on the merged
 * result (to catch cross-file inconsistencies).
 */
function checkEditionConsistency(
  cells: Record<string, CellConfig>,
  label: string,
): void {
  const entries = Object.entries(cells);
  const missing = entries
    .filter(([, cellConfig]) => cellConfig.edition === undefined)
    .map(([cell]) => cell);
  if (missing.length > 0 && missing.length !== entries.length) {
    throw new Error(
      `[sites] ${label}: editions are all-or-none across cells; ` +
        `these cells declare none: ${missing.join(", ")}.`,
    );
  }
}

/**
 * Validates the parsed JSON of one file into a {@link CellMap}. Checks edition
 * consistency within the file; cross-file consistency is checked after merging.
 */
function validateCellMap(value: unknown, source: string): CellMap {
  if (!isObject(value)) {
    throw new Error(
      `[sites] ${source} must be a JSON object mapping cell → sites.`,
    );
  }
  const result: Record<string, CellConfig> = {};
  for (const [cell, raw] of Object.entries(value)) {
    result[cell] = validateCell(raw, `${source} → ${cell}`);
  }
  checkEditionConsistency(result, source);
  return result;
}
