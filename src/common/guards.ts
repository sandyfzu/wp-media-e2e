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

/**
 * Extracts a human-readable message from a caught `unknown`: an `Error`'s `message`, else the
 * value stringified. Use at `catch` boundaries so error reporting never has to re-narrow
 * `unknown` inline.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
