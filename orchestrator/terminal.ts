/**
 * The orchestrator's terminal: standard output, made so that a terminal nobody reads does not freeze
 * the process.
 *
 * Node writes `process.stdout` **synchronously** when it is a terminal (`tty.WriteStream` sets its
 * handle blocking, on macOS and Linux), so a paused terminal — Ctrl-S, a frozen SSH client — stops the
 * whole event loop, timers and signal handlers included: a Ctrl-C is never handled. {@link
 * unblockTerminal} turns that handle back to non-blocking through Node's internal
 * `_handle.setBlocking(false)` — there is no public way — guarded, so a Node without it changes
 * nothing. Writes then queue in the stream ({@link Terminal.writableLength}) while the terminal is
 * paused, and the writer bounds that queue.
 *
 * Measured (Node 24, macOS and Linux, a pty nobody reads): blocking, the process never handles
 * SIGTERM; non-blocking, it does, and `process.exit` ends it at once. A shell sharing the terminal is
 * not affected, even after a SIGKILL: libuv reopens a terminal by its name before using it, so the
 * flag lands on the process's own open file description, not the shell's. When it cannot reopen it —
 * a terminal of another user's, as `sudo -u` in a plain SSH session — libuv keeps writing it
 * blocking whatever the flag, and the freeze remains (measured); `tmux` started by the orchestrator's
 * user gives it a terminal of its own. (Writing it through the thread pool instead, `fs.write`, was
 * measured too: the event loop then runs, but a write stuck in a pool thread holds even
 * `process.exit` until the terminal resumes.) Two costs, accepted: a write still queued keeps Node's event
 * loop alive, so a process that must end while its terminal is paused ends through `process.exit`;
 * and lines still queued at the exit are lost from the terminal (the log file has them). Only standard
 * output is changed: standard error, where Node prints a crash, stays synchronous so a crash's last
 * words are never lost.
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
   * Queues text for the terminal.
   *
   * @param chunk - the text.
   * @param callback - called once written, or with the error it failed with.
   * @returns whether the caller may go on writing without waiting (a `Writable`'s backpressure).
   */
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
  /**
   * Listens for a failure not tied to one write's callback.
   *
   * @param event - always `error`.
   * @param listener - called with the error.
   */
  on(event: "error", listener: (error: Error) => void): unknown;
  /** Bytes written but not yet taken by the terminal: what a stalled terminal piles up. */
  readonly writableLength: number;
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
 * terminal ({@link unblockTerminal}).
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
