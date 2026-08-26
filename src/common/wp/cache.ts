import { errorMessage } from "../guards";
import { wpCli } from "./exec";
import type { Transport } from "../config/types";

/**
 * Discarding WordPress's object cache, so that "removed" means removed *to WordPress* and not just
 * on disk.
 *
 * **These cells are not expected to run a persistent object cache, and this module is not a bet
 * that they do.** By default WordPress keeps the object cache in PHP memory for one request and
 * throws it away at the end, so nothing can outlive a WP-CLI call and there is nothing here to fix.
 * A cell that *does* have a `object-cache.php` drop-in is a different environment, and the risk it
 * introduces is specific: a plugin that clears its own state with raw SQL — BackWPup's
 * `uninstall.php` runs `DELETE FROM {$wpdb->options} WHERE option_name LIKE '%backwpup_%'` — never
 * calls `delete_option()`, so the cache is never told. WordPress would keep serving values whose
 * rows are gone, and the next install would read its predecessor's state as its own.
 *
 * That is a **conditional** hazard we choose to close rather than to depend on being absent: one
 * WP-CLI call per plugin removal is cheaper than a class of cross-scenario failure that reproduces
 * only on hosts configured differently from ours.
 *
 * **It is best-effort by construction, and the reason is that it is housekeeping.** Flushing is not
 * a claim about the product under test, so failing to flush must never fail a scenario — it is
 * reported and stepped over. Deliberately the opposite discipline to the rest of this layer, where
 * an unverified outcome is a failure.
 */

/**
 * What {@link flushObjectCache} managed to do.
 *
 * - `flushed` — WP-CLI reported success. Also the answer on a site with **no** persistent cache at
 *   all, where the flush is a harmless no-op: core's own `WP_Object_Cache::flush()` empties the
 *   per-request array and always returns `true`, so WP-CLI exits 0. So this value means "nothing
 *   stale can be left", not "a cache existed".
 * - `refused` — the flush did not happen. Two causes, deliberately not distinguished because
 *   neither is actionable here: a drop-in whose `wp_cache_flush()` returned false (WP-CLI "errors
 *   if the object cache can't be flushed" — e.g. a Redis backend it cannot reach), or a command
 *   that could not run at all (see `./exec`, which throws for that rather than returning a code).
 */
export type ObjectCacheFlush = "flushed" | "refused";

/**
 * Empties WordPress's object cache on the site, and **never throws**.
 *
 * @param transport - the target site's transport.
 * @returns whether the cache was flushed. Callers are free to ignore it; it exists so a caller that
 * wants to say something about a cell can, and so this is unit-testable without reading stdout.
 */
export async function flushObjectCache(
  transport: Transport,
): Promise<ObjectCacheFlush> {
  let outcome: string;
  try {
    const { exitCode, stderr, stdout } = await wpCli(transport, [
      "cache",
      "flush",
    ]);
    if (exitCode === 0) return "flushed";
    outcome = `exit ${String(exitCode)}: ${(stderr || stdout).trim() || "no output"}`;
  } catch (error) {
    // `wpCli` throws when the command could never run — a missing binary, an unreachable host. That
    // is worth saying out loud, but not here: whatever this cleanup was part of will fail on its
    // own next call, with a message about the thing the run actually cared about.
    outcome = errorMessage(error);
  }
  console.warn(
    `[wp/cache] could not flush this site's object cache (${outcome}). Continuing: a plugin that ` +
      "clears its options with raw SQL can leave a persistent cache serving rows that no longer " +
      "exist, so a later scenario may see the previous one's state.",
  );
  return "refused";
}
