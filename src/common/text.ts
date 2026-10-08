/** Small, pure string helpers shared across the suite. */

/**
 * `value` with every regular-expression metacharacter escaped, for safe interpolation into a
 * `RegExp` source — the same character set Playwright escapes in its own `--project` filter.
 *
 * @example
 * ```ts
 * new RegExp(`^${escapeRegExp("a.b")}$`).test("axb"); // false
 * ```
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
