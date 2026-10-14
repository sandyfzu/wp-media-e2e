import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { errorCode } from "./runs/process-group";
import { safeLine } from "./text";

/**
 * The orchestrator's own log: one timestamped line per event, `HH:MM:SS <scope>  <text>`, written to
 * the terminal and appended to `orchestrator.log`. Never a run's output — runs interleave, and each
 * has its `run.log`. Every line is masked and made one line ({@link safeLine}) before it goes
 * anywhere.
 *
 * The terminal may vanish under the process — an SSH session closed outside `tmux` leaves writes
 * failing with `EIO`, a closed pipe with `EPIPE` — so its first failure stops terminal writes for
 * good while the file keeps every line. The file is written through one queue, in call order, and
 * its failure never reaches the caller: a log must not stop what it logs.
 *
 * The {@link Logger} interface is deliberately small, so a structured logger can later sit behind it
 * without touching its callers.
 */

/** The orchestrator's log. */
export interface Logger {
  /**
   * Logs one line, timestamped now: written to the terminal at once, queued for the file. A failing
   * output never makes it throw. A text of several lines is flattened into one; after
   * {@link Logger.close} it is dropped.
   *
   * @param scope - who speaks: `orchestrator`, or a task's id.
   * @param text - what happened.
   */
  line(scope: string, text: string): void;
  /** Settles once every line logged so far is in the file (or failed to be). Never rejects. */
  flush(): Promise<void>;
  /** Flushes, then closes the file; later lines are dropped. Idempotent; never rejects. */
  close(): Promise<void>;
}

/** Where the file's lines go: the open `orchestrator.log`, or a stand-in. */
export interface LogFile {
  /** Appends text; rejects when it could not. */
  append(text: string): Promise<void>;
  /** Closes it; rejects when it could not. */
  close(): Promise<void>;
}

/**
 * The terminal, as much of a `Writable` as the logger uses — `process.stdout` is one. A write may fail
 * by throwing, through its callback, or by an `error` event; all three mean the same.
 */
export interface Terminal {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** How a logger is made. */
export interface LoggerOptions {
  /** The file every line is appended to. */
  readonly file: LogFile;
  /** The terminal; `process.stdout` by default. */
  readonly terminal?: Terminal;
  /** Secret values to mask wherever a line holds them (`secretValues(config)`). */
  readonly secrets?: readonly string[];
  /** The clock a line's time is read from; local time is shown. */
  readonly now?: () => Date;
}

/** The longest scope a line shows, in code points: a task's id is four. */
const MAX_SCOPE_LENGTH = 40;

/** The longest text a line shows, in code points: an outcome line with its report path fits. */
const MAX_TEXT_LENGTH = 2_000;

/** The scope of the logger's own lines about its outputs; three characters, so never a task's id. */
const LOG_SCOPE = "log";

/**
 * How `orchestrator.log` is opened: appended to — it lives across starts — and created `0600` when
 * missing, but never through a symbolic link (`O_NOFOLLOW` refuses one, `ELOOP`), and never waiting
 * on a FIFO (`O_NONBLOCK`: one with no reader is refused, `ENXIO`; one with a reader opens, and is
 * refused by type after). A folder is refused by the open itself (`EISDIR`).
 */
const LOG_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

/** The open's error codes that mean the path is not a regular file: a link, a FIFO, a folder. */
const NOT_A_FILE = new Set(["ELOOP", "ENXIO", "EISDIR"]);

/** The mode the log is created with, and tightened to. */
const LOG_MODE = 0o600;

/**
 * A time as a line shows it: local `HH:MM:SS`, each part two digits.
 *
 * @param at - the time.
 * @returns e.g. `09:05:03`.
 */
export function clockTime(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/**
 * One log line, without its line end: `HH:MM:SS <scope>  <text>` — two spaces after the scope, so
 * the text stands apart from it whatever its length. Scope and text each pass through
 * {@link safeLine}: masked, one line, cut.
 *
 * @param at - when.
 * @param scope - who speaks.
 * @param text - what happened.
 * @param secrets - secret values to mask.
 * @returns the line.
 */
export function formatLine(
  at: Date,
  scope: string,
  text: string,
  secrets: readonly string[] = [],
): string {
  return `${clockTime(at)} ${safeLine(scope, MAX_SCOPE_LENGTH, secrets)}  ${safeLine(text, MAX_TEXT_LENGTH, secrets)}`;
}

/**
 * Makes a logger over an open file.
 *
 * @param options - the file, the terminal, the secrets, the clock.
 * @returns the logger.
 */
export function createLogger(options: LoggerOptions): Logger {
  return new TwoWayLogger(options);
}

/**
 * Opens `orchestrator.log` ({@link openLogFile}) and makes a logger over it. When the file had a
 * wider mode than `0600`, it was tightened, and the first line says so.
 *
 * @param path - the log's path; its folder must exist.
 * @param options - the terminal, the secrets, the clock.
 * @returns the logger.
 * @throws {@link Error} when the log cannot be opened or is refused ({@link openLogFile}).
 */
export async function openLogger(
  path: string,
  options: Omit<LoggerOptions, "file"> = {},
): Promise<Logger> {
  const opened = await openLogFile(path);
  const logger = createLogger({ ...options, file: opened.file });
  if (opened.tightenedFrom !== undefined)
    logger.line(
      LOG_SCOPE,
      `${path} was mode ${formatMode(opened.tightenedFrom)}: now ${formatMode(LOG_MODE)}`,
    );
  return logger;
}

/** An opened log, and the mode it was tightened from, if it was. */
export interface OpenedLogFile {
  readonly file: LogFile;
  readonly tightenedFrom?: number;
}

/**
 * Opens a log for appending, refusing what it must not write into: anything but a regular file (a
 * link, a FIFO, a folder, a device), a file of another user's, or one with a second hard link — a
 * name for another file of this user's, which lines would then be appended to. A file this user owns
 * with a wider mode is tightened to `0600` rather than refused: the lines are masked, so nothing was
 * exposed, and the start need not fail over it.
 *
 * @param path - the log's path.
 * @param openFile - how a file is opened; `fs.promises.open` by default.
 * @returns the log, and the mode it had when tightened.
 * @throws {@link Error} naming the path and what is wrong, or the open's error code.
 */
export async function openLogFile(
  path: string,
  openFile: (
    path: string,
    flags: number,
    mode: number,
  ) => Promise<FileHandle> = open,
): Promise<OpenedLogFile> {
  let handle: FileHandle;
  try {
    handle = await openFile(path, LOG_FLAGS, LOG_MODE);
  } catch (error) {
    const code = errorCode(error) ?? "unknown error";
    throw new Error(
      `The orchestrator's log cannot be opened (${code}): ${path}${NOT_A_FILE.has(code) ? " must be a regular file, not a link, a FIFO or a folder" : ""}.`,
      { cause: error },
    );
  }
  try {
    const stats = await handle.stat();
    const refusal = refuseLogFile(stats, process.getuid?.());
    if (refusal !== undefined)
      throw new Error(`The orchestrator's log is refused: ${path} ${refusal}.`);
    // Special bits included, so a set-id bit is cleared with the rest.
    const mode = stats.mode & 0o7777;
    if ((mode & ~LOG_MODE) !== 0) await handle.chmod(LOG_MODE);
    return {
      file: fileOf(handle),
      ...((mode & ~LOG_MODE) !== 0 ? { tightenedFrom: mode } : {}),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** What {@link refuseLogFile} reads of a file. */
export interface LogFileStats {
  readonly uid: number;
  readonly nlink: number;
  isFile(): boolean;
}

/**
 * Why an open file must not be the log, if it must not.
 *
 * @param stats - the open file's.
 * @param uid - this process's user, when the platform has one.
 * @returns the reason, or `undefined` when it may be.
 */
export function refuseLogFile(
  stats: LogFileStats,
  uid: number | undefined,
): string | undefined {
  if (!stats.isFile()) return "is not a regular file";
  if (uid !== undefined && stats.uid !== uid) return "is another user's";
  if (stats.nlink !== 1) return "has another hard link";
  return undefined;
}

/**
 * A file handle as a {@link LogFile}.
 *
 * @param handle - opened for appending.
 */
function fileOf(handle: FileHandle): LogFile {
  return {
    append: (text) => handle.appendFile(text),
    close: () => handle.close(),
  };
}

/**
 * A mode as `ls` would show its digits: `0644`.
 *
 * @param mode - the permission bits.
 */
function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

/** The logger {@link createLogger} hands out. */
class TwoWayLogger implements Logger {
  /** The file's writes, one after another. Never rejects. */
  private queue: Promise<void> = Promise.resolve();
  /** Set once the terminal failed: it is not written again. */
  private terminalGone = false;
  /** Set once a file write failed, so the failure is told once. */
  private fileFailed = false;
  private closing: Promise<void> | undefined;
  private readonly terminal: Terminal;
  private readonly secrets: readonly string[];
  private readonly now: () => Date;

  /** @param options - see {@link LoggerOptions}. */
  constructor(private readonly options: LoggerOptions) {
    this.terminal = options.terminal ?? process.stdout;
    this.secrets = options.secrets ?? [];
    this.now = options.now ?? (() => new Date());
    // Kept for the process's life, past `close`: an `error` from a write already issued may come
    // later, and an `error` event nobody listens to crashes the process.
    this.terminal.on("error", (error) => {
      this.loseTerminal(error);
    });
  }

  /** {@inheritDoc Logger.line} */
  line(scope: string, text: string): void {
    if (this.closing !== undefined) return;
    const line = `${formatLine(this.now(), scope, text, this.secrets)}\n`;
    // Queued first, so a terminal that throws has its failure told after the line it failed on.
    this.enqueue(line);
    this.toTerminal(line);
  }

  /** {@inheritDoc Logger.flush} */
  flush(): Promise<void> {
    return this.queue;
  }

  /** {@inheritDoc Logger.close} */
  close(): Promise<void> {
    this.closing ??= this.queue.then(() =>
      this.options.file.close().catch(() => undefined),
    );
    return this.closing;
  }

  /**
   * Writes a line to the terminal, unless it is gone; a failure, thrown or called back, makes it gone.
   *
   * @param line - the line, with its line end.
   */
  private toTerminal(line: string): void {
    if (this.terminalGone) return;
    try {
      this.terminal.write(line, (error) => {
        if (error) this.loseTerminal(error);
      });
    } catch (error) {
      this.loseTerminal(error);
    }
  }

  /**
   * Stops terminal writes for good, and says so in the file — once, however many ways the failure
   * is told (a callback and an `error` event both come for one failed write).
   *
   * @param error - what the terminal failed with.
   */
  private loseTerminal(error: unknown): void {
    if (this.terminalGone) return;
    this.terminalGone = true;
    if (this.closing !== undefined) return;
    this.enqueue(
      `${formatLine(this.now(), LOG_SCOPE, `terminal gone (${errorCode(error) ?? "unknown error"}): lines go to the file only`, this.secrets)}\n`,
    );
  }

  /**
   * Queues a line for the file, after every line before it. A failed write is told to the terminal
   * once; later lines are still tried, so a disk that frees up gets them again.
   *
   * @param line - the line, with its line end.
   */
  private enqueue(line: string): void {
    this.queue = this.queue.then(() =>
      this.options.file.append(line).catch((error: unknown) => {
        if (this.fileFailed) return;
        this.fileFailed = true;
        this.toTerminal(
          `${formatLine(this.now(), LOG_SCOPE, `writing the log file failed (${errorCode(error) ?? "unknown error"}): its lines may be missing`, this.secrets)}\n`,
        );
      }),
    );
  }
}
