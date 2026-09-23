/**
 * Polling a site that is busy: what the waits in this product share.
 *
 * Every wait here probes a real site over WP-CLI — a round trip over SSH, often to a site that is in
 * the middle of writing an archive — so a single probe failing is noise rather than an answer, and
 * the probes are spaced for a round trip that costs a second, not for a DOM that answers in
 * microseconds.
 */

/**
 * How many *consecutive* probe failures a wait absorbs before giving up on the site.
 *
 * Small on purpose. It has to be greater than zero, because a probe is a WP-CLI round trip over SSH
 * to a site that is busy writing a multi-gigabyte archive, and a dropped connection there is noise
 * rather than an answer. It has to stay small, because a site that is genuinely broken should say so
 * in seconds rather than at the end of a ten-minute budget. At the poll intervals below, three
 * failures is about eight seconds.
 */
export const PROBE_FAILURE_TOLERANCE = 3;

/**
 * The pause between probes of a wait that may last minutes: it backs off quickly instead of
 * hammering the site the way Playwright's DOM-facing default would.
 */
export const PROBE_INTERVALS: readonly number[] = [1000, 2000, 5000];

/**
 * Wraps a probe so a transient failure keeps the wait alive, while a persistent one still ends it.
 *
 * `expect.poll` calls its function **outside** its own try/catch, so by default a probe that throws
 * ends the wait then and there — one lost connection during a ten-minute backup would be reported as
 * a WP-CLI error rather than as the thing being waited for. Returning `undefined` instead keeps the
 * poll going; one failure more than {@link PROBE_FAILURE_TOLERANCE}, with no success between them, is
 * taken as the site being unable to answer at all, and that last error is re-thrown with its own
 * message intact.
 *
 * The counter resets on every success, so a flaky link is tolerated indefinitely while a dead one is
 * not tolerated at all.
 */
export function forgiving<T>(
  probe: () => Promise<T>,
): () => Promise<T | undefined> {
  let consecutive = 0;
  return async () => {
    try {
      const value = await probe();
      consecutive = 0;
      return value;
    } catch (error) {
      consecutive += 1;
      if (consecutive > PROBE_FAILURE_TOLERANCE) throw error;
      return undefined;
    }
  };
}
