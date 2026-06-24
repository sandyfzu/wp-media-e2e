import { readFileSync } from "node:fs";
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
 * Loads and validates a product's site pools from `sites.json`.
 *
 * `sites.json` is git-ignored (it holds credentials). When it is absent, the
 * committed `sites.example.json` is used so the suite still loads and lists —
 * with a clear warning, since the example holds placeholder data only.
 *
 * Every field is validated with an actionable error that names the offending
 * cell and index, so a malformed file fails fast instead of crashing later.
 */
export function loadSites(configDir: string): CellMap {
  const primary = join(configDir, "sites.json");
  const example = join(configDir, "sites.example.json");

  let raw: string;
  let source: string;
  try {
    raw = readFileSync(primary, "utf8");
    source = primary;
  } catch {
    try {
      raw = readFileSync(example, "utf8");
      source = example;
      console.warn(
        `[sites] ${primary} not found; using ${example} (placeholder data). ` +
          "Create sites.json for real runs.",
      );
    } catch {
      throw new Error(
        `[sites] Neither sites.json nor sites.example.json found in "${configDir}".`,
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`[sites] ${source} is not valid JSON.`, { cause });
  }

  return validateCellMap(parsed, source);
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
  switch (value.mode) {
    case "ssh":
      return {
        mode: "ssh",
        host: requireString(value.host, `${path}.host`),
        username: requireString(value.username, `${path}.username`),
        privateKeyPath: requireString(
          value.privateKeyPath,
          `${path}.privateKeyPath`,
        ),
        rootDir: requireString(value.rootDir, `${path}.rootDir`),
      };
    case "docker":
      return {
        mode: "docker",
        container: requireString(value.container, `${path}.container`),
      };
    case "local":
      return {
        mode: "local",
        ...(typeof value.rootDir === "string"
          ? { rootDir: value.rootDir }
          : {}),
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

/** Validates one entry into a {@link SiteInput}: its four required fields plus an optional `overrides` block. */
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
 * Validates the parsed file into a {@link CellMap} (cell name → {@link CellConfig}).
 * Editions are all-or-none across a product's cells: if any cell declares one, every cell
 * must, so an edition-ful product can never silently run a cell with no edition.
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

  const entries = Object.entries(result);
  const missing = entries
    .filter(([, cellConfig]) => cellConfig.edition === undefined)
    .map(([cell]) => cell);
  if (missing.length > 0 && missing.length !== entries.length) {
    throw new Error(
      `[sites] ${source}: editions are all-or-none across cells; these declare none: ${missing.join(", ")}.`,
    );
  }
  return result;
}
