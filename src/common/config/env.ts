/**
 * Typed environment-variable accessors.
 *
 * Validation happens only at this boundary, so the rest of the code can treat
 * configuration as total. The `.env` file is loaded once by `./load-env.ts`,
 * which every Playwright config entry imports first.
 */

import { isNonEmptyString } from "../guards";

/** Returns an environment variable's value, or `fallback` when it is unset or blank. */
export function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return isNonEmptyString(value) ? value : fallback;
}

/** Returns a REQUIRED environment variable; throws an actionable error when missing or blank. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!isNonEmptyString(value)) {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        "Set it in .env (local) or your CI secret store.",
    );
  }
  return value;
}

/**
 * Returns an integer environment variable within `[min, max]`. Falls back when unset or
 * blank; throws an actionable error on a non-integer or out-of-range value (so a typo
 * surfaces here, not as a silent `NaN` deep in a later layer).
 */
export function intEnv(
  name: string,
  fallback: number,
  min = 1,
  max = 65535,
): number {
  const raw = process.env[name];
  if (!isNonEmptyString(raw)) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Environment variable "${name}" must be an integer in [${String(min)}, ${String(max)}], got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * Returns a boolean environment variable. Accepts `true`/`false`/`1`/`0`
 * (case-insensitive); falls back when unset or blank; throws on anything else rather
 * than silently treating an unrecognized value as `false`.
 */
export function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!isNonEmptyString(raw)) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(
    `Environment variable "${name}" must be a boolean (true/false/1/0), got "${raw}".`,
  );
}
