/**
 * A Node system error's code (`ENOENT`, `ESRCH`, `ELOOP`), the one way the orchestrator names a
 * failed file, process or spawn call: never by the error's message, which may name a path or an
 * argument.
 */

/**
 * A system error's code, when it has one.
 *
 * @param error - what was thrown.
 * @returns the code, or `undefined` when `error` carries no string `code`.
 */
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
