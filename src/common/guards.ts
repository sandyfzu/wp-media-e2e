/**
 * Generic type guards shared across the suite.
 *
 * These are intentionally domain-free — no error messages, no config knowledge — so any
 * module (config, steps, the future WordPress layer) can reuse them. Module-specific
 * validation (e.g. the `[sites]`-prefixed checks in config/sites.ts) builds on these but
 * stays local to its module.
 */

/** True for a non-null, non-array object (i.e. a plain JSON object). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a string with at least one non-whitespace character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
