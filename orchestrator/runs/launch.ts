import { spawn, type ChildProcess } from "node:child_process";
import { constants, writeFileSync } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { RESULTS_FILE } from "../../src/common/reporting/results-schema";
import { errorCode } from "../error-code";
import {
  checkOwnFolder,
  describeFolderProblem,
  PRIVATE_FOLDER,
  type OwnFolderCheck,
} from "../folders";

import type { Command, RunCommands } from "./commands";
import { variableNames } from "./environment";
import type { RunIdentity } from "./identity";
import { describeExit, type ProcessExit, type StopTaken } from "./outcome";
import {
  signalGroup,
  waitForEmptyGroup,
  type KillFn,
  type SleepFn,
} from "./process-group";
import {
  INITIAL_RUN_STOP,
  mayStartPlaywright,
  stepRunStop,
  type RunStopEvent,
  type StopAction,
  type StopLevel,
} from "./stop";
import { streamHasEnded } from "./stream-end";

/**
 * Starting a run and waiting for its end: `bddgen`, then — when it exited `0` and nothing asked the
 * run to stop — Playwright's runner. Each is spawned **detached**, in its own process group and
 * session, so the terminal's Ctrl-C reaches the orchestrator alone; each writes its output to the
 * run's log, under a header line of ours. A process has ended when its group is empty, not when it
 * exits: its workers still tear down after it. Stopping is {@link stepRunStop}'s; this module carries
 * out what it says, with the real `kill`, at once — never behind a log write, so a signal can never
 * reach a group after it emptied, nor a SIGINT come after the step that should follow it.
 *
 * One exception to the machine's word: no SIGINT once the run's tests are over (its stream holds
 * `run.end`). The runner then has no SIGINT handler left, and the signal would kill it in the middle
 * of writing its reports; it is left to finish, the kill budget still guarding a hang.
 */

/** What starts a run. */
export interface LaunchOptions {
  /** The run's folder, log and stop file, and its report folder, where its stream is. */
  readonly identity: Pick<
    RunIdentity,
    "dir" | "log" | "stopFile" | "reportDir"
  >;
  readonly commands: RunCommands;
  /** The checkout: both processes run in it. */
  readonly cwd: string;
  /** The run's whole environment ({@link runEnvironment}): nothing else is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Awaited just before each process is spawned, for the run's record (`startingRecord`): the process
   * is spawned only once it settles, so an orchestrator that dies between the spawn and
   * {@link LaunchOptions.onProcess}'s write leaves a record saying a process was starting — never one
   * naming the previous process's ended group, which would read as over while the new one runs. A
   * throw or a rejection spawns nothing: `bddgen`'s makes {@link launchRun} reject, the runner's ends
   * the run as one whose runner could not start, saying why in the log. A stop asked for while it is
   * awaited is honoured before the runner is spawned.
   */
  readonly onSpawning?: (
    process: "bddgen" | "playwright",
  ) => void | Promise<void>;
  /**
   * Told each process's group as it starts, for the run's record. A throw or a rejection is a log
   * line: the process is still watched to its end.
   */
  readonly onProcess?: (
    process: "bddgen" | "playwright",
    pgid: number,
  ) => void | Promise<void>;
  readonly kill?: KillFn;
  readonly sleep?: SleepFn;
  readonly now?: () => Date;
  /** How often an emptying group is asked; `GROUP_POLL_MS` by default. */
  readonly pollMs?: number;
  /** How long a group may outlive its process before it is killed; {@link LINGER_MS} by default. */
  readonly lingerMs?: number;
}

/** How a run's processes ended, and how far it was stopped. */
export interface LaunchResult {
  readonly bddgen: ProcessExit;
  /** Absent when the runner never started. */
  readonly playwright?: ProcessExit;
  readonly stop: StopTaken;
}

/** A started run. */
export interface LaunchedRun {
  /**
   * Stops it at least this far ({@link stepRunStop}); a stop that goes no further, or comes once the
   * run has ended, does nothing.
   */
  stop(level: StopLevel, why: string): void;
  /** Settles once both processes' groups are empty and the log is closed. Never rejects. */
  readonly done: Promise<LaunchResult>;
}

/**
 * How long a process group may outlive the process that led it before it is killed: past the
 * interrupt budget, so a worker's teardown is never cut short by this, only a process that hangs.
 */
export const LINGER_MS = 5 * 60_000;

/** The prefix of the lines the orchestrator writes into a run's log, which a reason never quotes. */
export const LOG_PREFIX = "[orchestrator]";

/**
 * How the log is opened: created, never one already there (a run's log is new by construction), never
 * through a symbolic link, never a FIFO — `"a"` would follow the one, block on the other and keep a
 * wider mode the file was made with. Read too, to see whether it ends mid-line.
 */
const LOG_FLAGS =
  constants.O_RDWR |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;

/** A process Node refused to spawn, and the error's code. */
interface NotStarted {
  readonly notStarted: string;
}

/** How a process ended when it could not be started at all. */
const NOT_STARTED: ProcessExit = { code: null, signal: null };

/**
 * Starts a run.
 *
 * @param options - the run, its commands, where and with what it runs.
 * @returns the run, once `bddgen` was spawned.
 * @throws {@link Error} when anything is already at the run's folder — a run of that id ran before,
 *   and sharing its folder would mix two runs' logs, records and stop files — when the folder is not
 *   a private folder of this user's, when its stop file or log is already there, or when any of them
 *   cannot be made; or when `onSpawning` fails for `bddgen`. Nothing is spawned then.
 */
export async function launchRun(options: LaunchOptions): Promise<LaunchedRun> {
  const { identity } = options;
  await mkdir(dirname(identity.dir), { recursive: true, mode: 0o700 });
  // Created here, never reused: a run number handed out twice fails now, before anything runs.
  await mkdir(identity.dir, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) !== "EEXIST") throw error;
    throw new Error(
      `The run's folder is already there (${identity.dir}): a run of that id ran before.`,
    );
  });
  await assertPrivateFolder(identity.dir);
  if (await exists(identity.stopFile))
    throw new Error(
      `The run's stop file is already there (${identity.stopFile}): a run of that id ran before.`,
    );
  const log = await openRunLog(identity.log);
  try {
    await options.onSpawning?.("bddgen");
  } catch (error) {
    await log.close().catch(() => undefined);
    throw new Error(
      `Recording that the run's bddgen starts failed (${errorCode(error) ?? "unknown error"}): nothing was spawned.`,
      { cause: error },
    );
  }
  return new Launch(options, log).start();
}

/**
 * Opens a run's new log, `0600` (a umask only narrows it). The run's folder is new and private by then,
 * so nothing should be there; refusing anything that is keeps that true if the folder ever is not.
 *
 * @param path - the log.
 * @returns the open log, for reading and appending.
 * @throws {@link Error} (`EEXIST`, `ELOOP`) when anything — a file, a link, a FIFO — is already there.
 */
export async function openRunLog(path: string): Promise<FileHandle> {
  return open(path, LOG_FLAGS, 0o600);
}

/**
 * Refuses a run folder anyone else could have prepared: it must be a real folder (not a link to one),
 * this user's, and closed to everyone else — `mkdir` keeps an existing folder as it was.
 *
 * @param dir - the run's folder.
 * @throws {@link Error} naming what is wrong.
 */
async function assertPrivateFolder(dir: string): Promise<void> {
  const check = await checkOwnFolder(dir, PRIVATE_FOLDER);
  if (check.kind !== "ok") throw new Error(runFolderRefusal(dir, check));
}

/**
 * Why a run's folder is refused, in words: what {@link checkOwnFolder} found — its owner's uid for a
 * folder of another user's, which its mode alone would not say.
 *
 * @param dir - the run's folder.
 * @param check - the failed check.
 * @returns the message.
 */
export function runFolderRefusal(
  dir: string,
  check: Exclude<OwnFolderCheck, { kind: "ok" }>,
): string {
  if (check.kind === "notFolder")
    return `The run's folder is not a folder: ${dir}.`;
  return `The run's folder must be this user's alone (mode 0700): ${dir} ${describeFolderProblem(check)}.`;
}

/** One run's processes and stop: the state {@link launchRun} hands out. */
class Launch {
  private state = INITIAL_RUN_STOP;
  /** Set once no process will run any more: a stop then changes nothing. */
  private over = false;
  /** Log lines, written one after another. */
  private queue: Promise<void> = Promise.resolve();
  private readonly kill: KillFn;
  private readonly sleep: SleepFn;
  private readonly now: () => Date;

  /**
   * @param options - the launch's options.
   * @param log - the run's log, open for appending.
   */
  constructor(
    private readonly options: LaunchOptions,
    private readonly log: FileHandle,
  ) {
    this.kill = options.kill ?? process.kill.bind(process);
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.now = options.now ?? (() => new Date());
  }

  /** Spawns `bddgen` and hands out the run. */
  start(): LaunchedRun {
    this.note(`variables: ${variableNames(this.options.env).join(", ")}`);
    const bddgen = this.spawn("bddgen", this.options.commands.bddgen);
    return {
      stop: (level, why) => {
        this.dispatch({ type: "stop", level, why });
      },
      done: this.finish(bddgen),
    };
  }

  /**
   * Waits for `bddgen`, runs Playwright when it may, and closes the log.
   *
   * @param bddgen - `bddgen`'s process.
   */
  private async finish(
    bddgen: ChildProcess | NotStarted,
  ): Promise<LaunchResult> {
    const bddgenExit = await this.waitFor("bddgen", bddgen);
    let playwrightExit: ProcessExit | undefined;
    if (isSuccess(bddgenExit) && mayStartPlaywright(this.state)) {
      const runner = await this.spawnRunner();
      if (runner !== undefined)
        playwrightExit = await this.waitFor("playwright", runner);
    }
    // Nothing runs any more: a stop from here on, while the log is flushed, must not change the run.
    this.over = true;
    await this.queue;
    await this.log.close().catch(() => undefined);
    return {
      bddgen: bddgenExit,
      ...(playwrightExit === undefined ? {} : { playwright: playwrightExit }),
      stop: this.state.taken,
    };
  }

  /**
   * Spawns the runner once `onSpawning` has settled — not when it failed, nor when a stop came
   * meanwhile.
   *
   * @returns its process, a refusal to start it, or `undefined` when a stop means it never starts.
   */
  private async spawnRunner(): Promise<ChildProcess | NotStarted | undefined> {
    try {
      await this.options.onSpawning?.("playwright");
    } catch (error) {
      return {
        notStarted: `recording that it starts failed (${errorCode(error) ?? "unknown error"})`,
      };
    }
    if (!mayStartPlaywright(this.state)) return undefined;
    return this.spawn("playwright", this.options.commands.playwright);
  }

  /**
   * Spawns one process, detached, its output into the log.
   *
   * @param name - which.
   * @param command - what.
   */
  private spawn(
    name: "bddgen" | "playwright",
    command: Command,
  ): ChildProcess | NotStarted {
    this.note(`${name} starts: ${describeCommand(command)}`);
    let child: ChildProcess;
    try {
      child = spawn(command.file, command.args, {
        cwd: this.options.cwd,
        env: { ...this.options.env },
        detached: true,
        stdio: ["ignore", this.log.fd, this.log.fd],
      });
    } catch (error) {
      // Refused before any process existed: an argument or variable Node will not pass.
      return { notStarted: errorCode(error) ?? "invalid command" };
    }
    if (child.pid !== undefined) {
      this.dispatch({ type: "started", process: name, pid: child.pid });
      this.tell(name, child.pid);
    }
    return child;
  }

  /**
   * Tells `onProcess` a process started. Its failure — thrown, or rejected by an async callback — is a
   * log line: it must neither leave the process unwatched nor reach the orchestrator unhandled.
   *
   * @param name - which.
   * @param pgid - its group.
   */
  private tell(name: "bddgen" | "playwright", pgid: number): void {
    const failed = (): void => {
      this.note(`recording ${name}'s process group failed`);
    };
    try {
      const answer = this.options.onProcess?.(name, pgid);
      if (answer instanceof Promise) answer.catch(failed);
    } catch {
      failed();
    }
  }

  /**
   * Waits until a process has exited and its group is empty — killing a group that outlives it past
   * the linger — then tells the machine.
   *
   * @param name - which.
   * @param child - its process.
   * @returns how it exited.
   */
  private async waitFor(
    name: "bddgen" | "playwright",
    child: ChildProcess | NotStarted,
  ): Promise<ProcessExit> {
    const exit =
      "notStarted" in child
        ? { ...NOT_STARTED, error: child.notStarted }
        : await exitOf(child);
    const pid = "notStarted" in child ? undefined : child.pid;
    if (pid === undefined) {
      this.note(`${name} could not start: ${exit.error ?? "unknown error"}`);
      return NOT_STARTED;
    }
    const wait = {
      kill: this.kill,
      sleep: this.sleep,
      pollMs: this.options.pollMs,
    };
    const emptied = await this.guard(() =>
      waitForEmptyGroup(pid, {
        ...wait,
        timeoutMs: this.options.lingerMs ?? LINGER_MS,
      }),
    );
    if (emptied === false) await this.killLingering(name, pid, wait);
    const ended = { code: exit.code, signal: exit.signal };
    this.note(`${name} ${describeExit(ended)}`);
    this.dispatch({ type: "exited" });
    return ended;
  }

  /**
   * Kills a group that outlived its process past the linger, and waits until it is empty. A kill that
   * fails (a member we may not signal) does not end the run: its group still holds the cell, so the
   * wait goes on, and the log says why.
   *
   * @param name - which process led it.
   * @param pid - the group's id.
   * @param wait - how to wait.
   */
  private async killLingering(
    name: "bddgen" | "playwright",
    pid: number,
    wait: { kill: KillFn; sleep: SleepFn; pollMs: number | undefined },
  ): Promise<void> {
    const linger = describeMs(this.options.lingerMs ?? LINGER_MS);
    try {
      signalGroup(pid, "SIGKILL", this.kill);
      this.note(`${name}'s process group outlived it by ${linger}: killed`);
    } catch (error) {
      this.note(
        `${name}'s process group outlived it by ${linger} and could not be killed (${errorCode(error) ?? "unknown error"}): waiting for it`,
      );
    }
    await this.guard(() => waitForEmptyGroup(pid, wait));
  }

  /**
   * Tells the machine, and carries out what it says at once.
   *
   * @param event - what happened, or what is asked.
   */
  private dispatch(event: RunStopEvent): void {
    if (this.over) return;
    const step = stepRunStop(this.state, event);
    if (event.type === "stop" && step.state !== this.state)
      this.note(`stop: ${step.state.taken.level} — ${event.why}`);
    this.state = step.state;
    for (const action of step.actions) this.perform(action);
  }

  /**
   * Carries out one action, synchronously; a failure is noted in the log, never thrown — the next
   * step of the stop still comes.
   *
   * @param action - what to do.
   */
  private perform(action: StopAction): void {
    try {
      switch (action.type) {
        case "createStopFile":
          writeFileSync(this.options.identity.stopFile, "", {
            flag: "wx",
            mode: 0o600,
          });
          return;
        case "interrupt":
          if (streamHasEnded(this.resultsFile())) {
            this.note(
              "interrupt skipped: the tests are over, and the runner is writing its reports",
            );
            return;
          }
          this.kill(action.pid, "SIGINT");
          return;
        case "killGroup":
          signalGroup(action.pgid, "SIGKILL", this.kill);
          return;
      }
    } catch (error) {
      // A stop file already there is a drain already asked for; a gone runner needs no SIGINT.
      const code = errorCode(error);
      if (code === "EEXIST" || code === "ESRCH") return;
      this.note(`${action.type} failed: ${code ?? "unknown error"}`);
    }
  }

  /** The run's results stream. */
  private resultsFile(): string {
    return join(this.options.identity.reportDir, RESULTS_FILE);
  }

  /**
   * Runs a group wait, noting a failure (a `kill` answering what it should not) instead of throwing,
   * so the run still ends.
   *
   * @param work - the wait.
   * @returns its answer, or `undefined` when it threw.
   */
  private async guard<T>(work: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      this.note(
        `watching the process group failed: ${errorCode(error) ?? "unknown error"}`,
      );
      return undefined;
    }
  }

  /**
   * Queues one of our lines for the log.
   *
   * @param text - the line, without its prefix and time.
   */
  private note(text: string): void {
    this.enqueue(() => this.write(text));
  }

  /**
   * Appends one of our lines to the log now, on a line of its own — a process's last output may lack
   * its newline. A failed write is dropped: the log is the run's, and losing a header line must not
   * lose the run.
   *
   * @param text - the line.
   */
  private async write(text: string): Promise<void> {
    try {
      const line = `${LOG_PREFIX} ${this.now().toISOString()} ${text}\n`;
      await this.log.appendFile(
        (await this.endsMidLine()) ? `\n${line}` : line,
      );
    } catch {
      // Dropped, as said.
    }
  }

  /** Whether the log's last byte is not a line end: a process's output without its newline. */
  private async endsMidLine(): Promise<boolean> {
    const { size } = await this.log.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await this.log.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  }

  /**
   * Runs `work` after everything queued before it.
   *
   * @param work - the work; it never rejects.
   */
  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work);
  }
}

/**
 * How a child ended: its `exit`, or the `error` that kept it from starting.
 *
 * @param child - the child.
 */
function exitOf(
  child: ChildProcess,
): Promise<ProcessExit & { readonly error?: string }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      // An error after the child started (a failed kill) is not its end: its `exit` still comes.
      if (child.pid === undefined)
        resolve({ ...NOT_STARTED, error: errorCode(error) ?? "unknown error" });
    });
  });
}

/**
 * A command as one line of the log: each argument JSON-quoted when it holds a space, a quote or a
 * backslash, so the line reads back as the arguments it was.
 *
 * @param command - the command.
 */
export function describeCommand(command: Command): string {
  return [command.file, ...command.args]
    .map((part) =>
      /[\s"'\\]/.test(part) || part === "" ? JSON.stringify(part) : part,
    )
    .join(" ");
}

/**
 * A duration in words: `5 min`, `100 ms`.
 *
 * @param ms - milliseconds.
 */
function describeMs(ms: number): string {
  return ms % 60_000 === 0 ? `${String(ms / 60_000)} min` : `${String(ms)} ms`;
}

/**
 * Whether a process exited `0`.
 *
 * @param exit - how it ended.
 */
function isSuccess(exit: ProcessExit): boolean {
  return exit.code === 0 && exit.signal === null;
}

/**
 * Whether a path exists — anything there, a dangling link included. Only "no such file" is absence:
 * a path that cannot be checked is not taken to be free.
 *
 * @param path - the path.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}
