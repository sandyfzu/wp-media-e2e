import { wpCli } from "./exec";
import type { Transport } from "../config/types";

/** Runs a SQL statement via `wp db query` and returns its stdout. Throws on a non-zero exit. */
export async function dbQuery(
  transport: Transport,
  sql: string,
): Promise<string> {
  const { stdout, stderr, exitCode } = await wpCli(transport, [
    "db",
    "query",
    sql,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[wp/db] query failed (exit ${String(exitCode)}): ${(stderr || stdout).trim()}`,
    );
  }
  return stdout;
}

/**
 * This install's database table prefix (e.g. `wp_`).
 *
 * Read from WordPress itself rather than from `wp-config.php`, so it is the prefix `$wpdb` actually
 * uses — which on multisite includes the per-blog segment a config file never shows.
 *
 * Needed wherever a plugin distinguishes *this* install's tables from other tables sharing the
 * database: a hard-coded `wp_` would quietly assert the wrong thing on any site not using the
 * default.
 *
 * The result is validated, not just non-empty. WordPress restricts a prefix to letters, digits and
 * underscores, and callers build selectors and SQL-ish comparisons out of it — so anything else
 * means the command printed something that is not a prefix at all (a notice, a warning, a banner),
 * and using it would silently target the wrong tables.
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if the command fails, or returns something that cannot be a prefix.
 */
export async function tablePrefix(transport: Transport): Promise<string> {
  const { stdout, stderr, exitCode } = await wpCli(transport, ["db", "prefix"]);
  const prefix = stdout.trim();
  if (exitCode !== 0 || !/^[A-Za-z0-9_]+$/.test(prefix)) {
    throw new Error(
      `[wp/db] \`wp db prefix\` exited ${String(exitCode)} without a usable prefix ` +
        `(letters, digits and underscores only): ` +
        ((stderr || stdout).trim() || "(no output)"),
    );
  }
  return prefix;
}
