/**
 * The orchestrator's terminal: standard output, made so that a terminal nobody reads does not freeze
 * the process.
 *
 * Node writes `process.stdout` **synchronously** when it is a terminal (`tty.WriteStream` sets its
 * handle blocking, on macOS and Linux), so a paused terminal — Ctrl-S, a frozen SSH client — stops the
 * whole event loop, timers and signal handlers included: a Ctrl-C is never handled. {@link
 * unblockTerminal} turns that handle back to non-blocking through Node's internal
 * `_handle.setBlocking(false)` — there is no public way — guarded, so a Node without it changes
 * nothing. Writes then queue in the stream ({@link Terminal.writableLength}) until the terminal takes
 * them, and the writer bounds that queue.
 *
 * Measured (Node 24, macOS and Linux, a pty nobody reads): blocking, the process never handles
 * SIGTERM; non-blocking, it does, and `process.exit` ends it at once. A shell sharing the terminal is
 * not affected, even after a SIGKILL: libuv reopens a terminal by its name before using it, so the
 * flag lands on the process's own open file description, not the shell's. When it cannot reopen it —
 * a terminal of another user's, as `sudo -u` in a plain SSH session — libuv keeps writing it
 * blocking whatever the flag, and the freeze remains (measured); `tmux` started by the orchestrator's
 * user gives it a terminal of its own. (Writing it through the thread pool instead, `fs.write`, was
 * measured too: the event loop then runs, but a write stuck in a pool thread holds even
 * `process.exit` until the terminal resumes.) Only standard output is changed: standard error, where
 * Node prints a crash, stays synchronous so a crash's last words are never lost.
 *
 * Two costs, accepted. A write still queued keeps Node's event loop alive, so a process that must end
 * while its terminal is paused ends through `process.exit`. And **whatever is still queued when the
 * process exits is lost from the terminal — a terminal that reads included**: the queue empties only
 * as fast as the terminal takes it, slower than a burst is written (measured on a pty read at once:
 * 200 KB then `process.exit` showed about 1 KB on macOS and 1.3 of 5 MB on Linux; 2,000 of the
 * logger's lines then its `close`, 78). So {@link stdoutTerminal} is called only once the orchestrator
 * starts its work — after the command line is parsed, so `--help`, a usage error and `--dry-run` print
 * through Node's blocking default — and before `process.exit` the queue is waited for, within a bound:
 * {@link drainTerminal} (the logger's `flush` and `close` do it for their lines). A paused terminal
 * then costs that bound, never more.
 *
 * A pipe needs nothing: Node writes it asynchronously on both systems (measured), and a pipe nobody
 * reads only grows the queue.
 */

/**
 * The terminal, as much of a `Writable` as the logger uses — `process.stdout` is one. A write may fail
 * by throwing, through its callback, or by an `error` event; all three mean the same.
 */
export interface Terminal {
  /**
   * Queues bytes for the terminal — bytes, not a string, so {@link Terminal.writableLength} counts
   * bytes: a string-mode stream (a terminal, a socket) counts a string by its UTF-16 units.
   *
   * @param chunk - the text, UTF-8 encoded.
   * @param callback - called once written, or with the error it failed with.
   * @returns whether the caller may go on writing without waiting (a `Writable`'s backpressure).
   */
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  /**
   * Listens for a failure not tied to one write's callback.
   *
   * @param event - always `error`.
   * @param listener - called with the error.
   */
  on(event: "error", listener: (error: Error) => void): unknown;
  /**
   * What is written but not yet taken by the terminal: what a stalled terminal piles up. In bytes for
   * bytes written; a string another writer wrote counts by its UTF-16 units.
   */
  readonly writableLength: number;
  /** `true` once the stream is destroyed: nothing still queued will be taken. */
  readonly destroyed?: boolean;
}

/**
 * What {@link unblockTerminal} reads of a stream: whether it is a terminal, and — not typed, as it is
 * Node's internal — its `_handle`.
 */
export interface TerminalStream {
  /** `true` for a terminal (`tty.WriteStream`). */
  readonly isTTY?: boolean;
}

/**
 * Makes a terminal stream's writes non-blocking, if it is a terminal and Node's internal handle offers
 * it: a `_handle` whose `setBlocking` is a function. Anything else is left as it is.
 *
 * @param stream - the stream, e.g. `process.stdout`.
 * @returns whether its handle was made non-blocking (`setBlocking` answered `0`).
 */
export function unblockTerminal(stream: TerminalStream): boolean {
  if (stream.isTTY !== true) return false;
  const handle: unknown = Reflect.get(stream, "_handle");
  if (typeof handle !== "object" || handle === null) return false;
  const setBlocking: unknown = Reflect.get(handle, "setBlocking");
  if (typeof setBlocking !== "function") return false;
  try {
    return Reflect.apply(setBlocking, handle, [false]) === 0;
  } catch {
    return false;
  }
}

/** The streams {@link stdoutTerminal} already handled, so each is handled once. */
const handled = new WeakSet<object>();

/**
 * Standard output as the logger's {@link Terminal}, made non-blocking on first use when it is a
 * terminal ({@link unblockTerminal}). Call it only once the orchestrator starts its work, and wait for
 * the terminal ({@link drainTerminal}) before `process.exit`: see this module's description.
 *
 * @param stream - the stream; `process.stdout` by default.
 * @returns the stream.
 */
export function stdoutTerminal(
  stream: Terminal & TerminalStream = process.stdout,
): Terminal {
  if (!handled.has(stream)) {
    handled.add(stream);
    unblockTerminal(stream);
  }
  return stream;
}

/** How often {@link drainTerminal} looks at the terminal's queue, in milliseconds. */
export const DRAIN_POLL_MS = 10;

/** The longest wait a Node timer takes; a longer one would fire at once. */
export const MAX_WAIT_MS = 2 ** 31 - 1;

/**
 * Checks a wait's length.
 *
 * @param ms - the wait, in milliseconds.
 * @throws {@link RangeError} when it is not a whole number from 0 to {@link MAX_WAIT_MS}.
 */
export function assertWaitMs(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_WAIT_MS)
    throw new RangeError(
      `A wait is a whole number of milliseconds from 0 to ${String(MAX_WAIT_MS)}, got ${String(ms)}.`,
    );
}

/** What {@link drainTerminal} reads of a terminal. */
export type DrainableTerminal = Pick<Terminal, "writableLength" | "destroyed">;

/**
 * Waits until the terminal has taken everything written to it — its queue empty, or the stream
 * destroyed, so nothing left will be taken — or `maxWaitMs` passed. Call it before `process.exit`,
 * which drops what is still queued. Its timers keep the process alive while it waits, so the process
 * cannot end before it settles; and it is bounded, so a paused terminal costs `maxWaitMs` at most.
 *
 * @param terminal - the terminal; `process.stdout` is one.
 * @param maxWaitMs - the longest wait, in milliseconds.
 * @returns whether everything was taken. Never rejects.
 * @throws {@link RangeError} when `maxWaitMs` is not a whole number of milliseconds a timer takes.
 * @example
 * ```ts
 * await drainTerminal(process.stdout, 2_000);
 * process.exit(code);
 * ```
 */
export function drainTerminal(
  terminal: DrainableTerminal,
  maxWaitMs: number,
): Promise<boolean> {
  assertWaitMs(maxWaitMs);
  const deadline = performance.now() + maxWaitMs;
  return new Promise((resolve) => {
    const look = (): void => {
      if (holdsNothing(terminal)) {
        resolve(true);
        return;
      }
      const left = deadline - performance.now();
      if (left <= 0) {
        resolve(false);
        return;
      }
      setTimeout(look, Math.min(DRAIN_POLL_MS, Math.ceil(left)));
    };
    look();
  });
}

/**
 * Whether a terminal holds nothing it will still take. A getter that throws reads as nothing left, so
 * the wait never rejects.
 *
 * @param terminal - the terminal.
 * @returns `true` once its queue is empty or it is destroyed.
 */
function holdsNothing(terminal: DrainableTerminal): boolean {
  try {
    return terminal.writableLength === 0 || terminal.destroyed === true;
  } catch {
    return true;
  }
}
