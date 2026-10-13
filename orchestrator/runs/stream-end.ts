import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/**
 * Whether a running run's tests are over: its results stream already holds `run.end`. The suite's
 * stream reporter writes that line synchronously as the runner ends its tests, before the slow
 * reporters (HTML, Cucumber, Allure, the summary, the pruning) — and from then on the runner has no
 * SIGINT handler left, so a SIGINT would kill it outright and cut those reports short.
 */

/** How much of the stream's end is read: `run.end` is its last line, well under this. */
export const STREAM_END_BYTES = 8 * 1024;

/**
 * Whether the stream at `path` ends with a `run.end` line. Synchronous, so a stop can decide on it
 * before signalling; opened without waiting and read only when a regular file, so nothing put in the
 * stream's place can block or flood it. Any failure reads as "not over".
 *
 * @param path - the run's `results.jsonl`.
 */
export function streamHasEnded(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return false;
    const length = Math.min(stats.size, STREAM_END_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, stats.size - length);
    return hasRunEnd(buffer.subarray(0, read).toString("utf8"));
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether any whole line of `text` is a `run.end` event.
 *
 * @param text - the end of a stream.
 */
export function hasRunEnd(text: string): boolean {
  return text.split("\n").some((line) => {
    if (!line.includes('"run.end"')) return false;
    try {
      const event: unknown = JSON.parse(line);
      return (
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "run.end"
      );
    } catch {
      return false;
    }
  });
}
