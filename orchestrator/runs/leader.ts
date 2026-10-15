import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import { errorCode } from "../error-code";

/**
 * Who leads a process group: its leader's start time, read as the leader is spawned and kept in the
 * run's record. A group id is only a number, and once the group has ended the system may hand it to
 * an unrelated process; the same number with a different start time is that stranger, never the run.
 *
 * The source, per system, as measured:
 * - **Linux** — `/proc/<pid>/stat`'s 22nd field, the start in clock ticks since boot (10 ms at the
 *   usual 100 Hz), with the boot's id (`/proc/sys/kernel/random/boot_id`), since ticks restart at
 *   each boot. No process to run, no locale, no time zone.
 * - **Elsewhere (macOS)** — `ps -o lstart= -p <pid>`, the start to the second. Its text follows `TZ`
 *   and the locale (`Tue Oct 13 18:57:39` became `mer. 14 oct. 08:57:39` under French and Tokyo), so
 *   `ps` runs with `LC_ALL=C` and `TZ=UTC` and nothing else, by its absolute path.
 *
 * A start that cannot be read is never a throw: the reader says the process is gone, or that it
 * cannot tell.
 */

/** A leader's start, as read now. */
export type LeaderStart =
  /** Its start, tagged with its source (`linux:<boot id>:<ticks>`, `ps:<time>`). */
  | { readonly kind: "start"; readonly value: string }
  /** No such process. */
  | { readonly kind: "gone" }
  /** It could not be read: the system error's code, or what was wrong. */
  | { readonly kind: "unknown"; readonly why: string };

/** Reads a process's start. Never rejects. */
export type LeaderStartReader = (pid: number) => Promise<LeaderStart>;

/** What the reader needs from the system: injected, so each answer it can give is tested. */
export interface LeaderStartDeps {
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Reads a small text file (procfs). */
  readonly readText: (path: string) => Promise<string>;
  /** Runs `ps` for one process ({@link runPs}). */
  readonly ps: (pid: number) => Promise<PsResult>;
}

/** How a `ps` run ended. */
export type PsResult =
  | { readonly kind: "exited"; readonly code: number; readonly stdout: string }
  /** It could not run, or did not finish in time: the error's code. */
  | { readonly kind: "failed"; readonly why: string };

/** `ps`'s path: absolute, so no `PATH` can put another program in its place. */
export const PS_PATH = "/bin/ps";

/** How long `ps` may take, in milliseconds: it answers in a few. */
export const PS_TIMEOUT_MS = 5_000;

/** The most of `ps`'s output kept: one date. */
const PS_MAX_BUFFER = 4096;

/** `ps`'s whole environment: its date in one fixed form, whatever the orchestrator's locale and zone. */
const PS_ENV = { LC_ALL: "C", TZ: "UTC" } as const;

/** Where Linux says which boot this is. */
export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/**
 * Reads a leader's start.
 *
 * @param pid - the leader's PID: its group's id.
 * @param deps - the system; the real one by default.
 * @returns its start, or that it is gone, or that it cannot tell.
 */
export async function readLeaderStart(
  pid: number,
  deps: LeaderStartDeps = SYSTEM,
): Promise<LeaderStart> {
  if (!Number.isSafeInteger(pid) || pid < 1)
    return { kind: "unknown", why: "not a process id" };
  try {
    return deps.platform === "linux"
      ? await readProcStart(pid, deps)
      : await readPsStart(pid, deps);
  } catch (error) {
    // A stand-in that throws: still an answer, never a rejection.
    return { kind: "unknown", why: errorCode(error) ?? "unknown error" };
  }
}

/**
 * The start from procfs, with the boot's id.
 *
 * @param pid - the process.
 * @param deps - the system.
 * @returns `linux:<boot id>:<ticks>`; `gone` when procfs has no such process; `unknown`, with why,
 *   when it cannot be read.
 */
async function readProcStart(
  pid: number,
  deps: LeaderStartDeps,
): Promise<LeaderStart> {
  let stat: string;
  try {
    stat = await deps.readText(`/proc/${String(pid)}/stat`);
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ESRCH"
      ? { kind: "gone" }
      : { kind: "unknown", why: code ?? "unknown error" };
  }
  const ticks = procStatStart(stat);
  if (ticks === undefined)
    return { kind: "unknown", why: "unreadable /proc stat" };
  let bootId: string;
  try {
    bootId = (await deps.readText(BOOT_ID_PATH)).trim();
  } catch (error) {
    return { kind: "unknown", why: errorCode(error) ?? "unknown error" };
  }
  if (!/^[0-9a-f-]{1,64}$/.test(bootId))
    return { kind: "unknown", why: "unreadable boot id" };
  return { kind: "start", value: `linux:${bootId}:${ticks}` };
}

/**
 * The start from `ps`.
 *
 * @param pid - the process.
 * @param deps - the system.
 * @returns `ps:<lstart>`; `gone` when `ps` exits 1 with nothing listed; `unknown`, with why,
 *   otherwise.
 */
async function readPsStart(
  pid: number,
  deps: LeaderStartDeps,
): Promise<LeaderStart> {
  const result = await deps.ps(pid);
  if (result.kind === "failed") return { kind: "unknown", why: result.why };
  const start = psLstart(result.stdout);
  if (result.code === 0 && start !== undefined)
    return { kind: "start", value: `ps:${start}` };
  // `ps` exits 1 with nothing on stdout for a PID no process has (measured, macOS and procps).
  if (result.code === 1 && result.stdout.trim() === "") return { kind: "gone" };
  return { kind: "unknown", why: `ps exited ${String(result.code)}` };
}

/**
 * The start field of a `/proc/<pid>/stat` line: the 22nd, in clock ticks since boot. The 2nd field,
 * the command's name in parentheses, may itself hold spaces and parentheses (`21 (x) y (z) R 1 …`),
 * so fields are counted from the **last** `)`: the 3rd field is the first after it.
 *
 * @param stat - the file's text.
 * @returns the ticks, as digits, or `undefined` when the text is not such a line.
 */
export function procStatStart(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0 || !/^\d+ \(/.test(stat)) return undefined;
  // Fields 3 onwards; field 22 is the 20th of them.
  const field = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19];
  return field !== undefined && /^\d{1,20}$/.test(field) ? field : undefined;
}

/**
 * The start in `ps -o lstart=`'s output: one line, `Tue Oct 13 23:57:39 2026` in the C locale, padded
 * with spaces.
 *
 * @param stdout - `ps`'s output.
 * @returns the date, spaces folded, or `undefined` when it is not one.
 */
export function psLstart(stdout: string): string | undefined {
  const text = stdout.trim().replace(/\s+/g, " ");
  return /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(
    text,
  )
    ? text
    : undefined;
}

/**
 * Runs `ps -o lstart= -p <pid>`: file and arguments, never a shell; its environment {@link PS_ENV}
 * alone; killed past {@link PS_TIMEOUT_MS}. Never rejects.
 *
 * @param pid - the process.
 * @returns how it ended.
 */
export function runPs(pid: number): Promise<PsResult> {
  return new Promise((resolve) => {
    execFile(
      PS_PATH,
      ["-o", "lstart=", "-p", String(pid)],
      {
        env: { ...PS_ENV },
        timeout: PS_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: PS_MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ kind: "exited", code: 0, stdout });
          return;
        }
        // A non-zero exit carries its code as a number; a spawn failure, a code like `ENOENT`.
        if (typeof error.code === "number" && error.killed !== true)
          resolve({ kind: "exited", code: error.code, stdout });
        else
          resolve({
            kind: "failed",
            why:
              error.killed === true
                ? "timed out"
                : (errorCode(error) ?? "unknown error"),
          });
      },
    );
  });
}

/** The real system. */
const SYSTEM: LeaderStartDeps = {
  platform: process.platform,
  readText: (path) => readFile(path, "utf8"),
  ps: runPs,
};
