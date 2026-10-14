import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import {
  BOOT_ID_PATH,
  procStatStart,
  psLstart,
  readLeaderStart,
  runPs,
  type LeaderStartDeps,
  type PsResult,
} from "./leader";

/** A `/proc/<pid>/stat` line as Linux writes it (Ubuntu 24.04, kernel 7.0), start time `1347811`. */
const STAT =
  "21 (tail) R 1 1 1 0 -1 4194304 84 0 0 0 0 0 0 0 20 0 1 0 1347811 397312 0 18446744073709551615 1 2 3 0 0 0 0 6 0 0 0 0 17 8 0 0 0 0 0 4 5 6 7 8 9 10 0\n";

const BOOT_ID = "f6fb3842-61ea-4a8e-8577-4be12500a66e\n";

/**
 * A Linux system answering from the given files.
 *
 * @param files - path → text, or an error code to throw.
 */
function linux(
  files: Record<string, string | { code: string }>,
): LeaderStartDeps {
  return {
    platform: "linux",
    readText: (path) => {
      const file = files[path];
      if (file === undefined)
        return Promise.reject(Object.assign(new Error(), { code: "ENOENT" }));
      return typeof file === "string"
        ? Promise.resolve(file)
        : Promise.reject(Object.assign(new Error(), file));
    },
    ps: () => Promise.reject(new Error("ps must not run on Linux")),
  };
}

/**
 * A macOS system whose `ps` answers this.
 *
 * @param result - `ps`'s answer.
 */
function darwin(result: PsResult): LeaderStartDeps {
  return {
    platform: "darwin",
    readText: () => Promise.reject(new Error("no procfs on macOS")),
    ps: () => Promise.resolve(result),
  };
}

/**
 * Starts a process that waits until it is killed.
 *
 * @returns it, once spawned.
 */
async function sleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  await once(child, "spawn");
  return child;
}

/**
 * Kills a process and waits for its end.
 *
 * @param child - the process.
 */
async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

test.describe("procStatStart", () => {
  test("reads the 22nd field", () => {
    expect(procStatStart(STAT)).toBe("1347811");
  });

  test("counts from the last parenthesis: a name may hold spaces and parentheses", () => {
    // Measured: a program named `x) y (z` reads `21 (x) y (z) R …`.
    expect(procStatStart(STAT.replace("(tail)", "(x) y (z)"))).toBe("1347811");
    expect(procStatStart(STAT.replace("(tail)", "(a b c d e f)"))).toBe(
      "1347811",
    );
    expect(procStatStart(STAT.replace("(tail)", "())) ) )"))).toBe("1347811");
  });

  test("refuses what is not such a line", () => {
    expect(procStatStart("")).toBeUndefined();
    expect(procStatStart("21 tail R 1")).toBeUndefined();
    // A whole line, but without the PID before the name.
    expect(procStatStart(STAT.replace("21 ", ""))).toBeUndefined();
    // Cut short before the 22nd field.
    expect(
      procStatStart("21 (tail) R 1 1 1 0 -1 4194304 84 0 0 0 0 0 0 0 20 0 1 0"),
    ).toBeUndefined();
    expect(procStatStart(STAT.replace("1347811", "13x7811"))).toBeUndefined();
  });
});

test.describe("psLstart", () => {
  test("reads the C locale's date, its padding folded", () => {
    expect(psLstart("Tue Oct 13 23:57:39 2026    \n")).toBe(
      "Tue Oct 13 23:57:39 2026",
    );
    expect(psLstart("Sat Oct  3 09:05:01 2026\n")).toBe(
      "Sat Oct 3 09:05:01 2026",
    );
  });

  test("refuses a localised date, or none", () => {
    // Measured under LC_ALL=fr_FR.UTF-8: the reason ps runs with LC_ALL=C.
    expect(psLstart("mer. 14 oct. 08:57:39 2026  \n")).toBeUndefined();
    expect(psLstart("")).toBeUndefined();
    expect(psLstart("Tue Oct 13 23:57:39 2026\nTue Oct 13 23:57:40 2026")).toBe(
      undefined,
    );
  });
});

test.describe("readLeaderStart, Linux", () => {
  test("reads the start with the boot's id", async () => {
    expect(
      await readLeaderStart(
        21,
        linux({ "/proc/21/stat": STAT, [BOOT_ID_PATH]: BOOT_ID }),
      ),
    ).toEqual({
      kind: "start",
      value: "linux:f6fb3842-61ea-4a8e-8577-4be12500a66e:1347811",
    });
  });

  test("a PID with no process is gone; any other failure, unknown", async () => {
    expect(
      await readLeaderStart(21, linux({ [BOOT_ID_PATH]: BOOT_ID })),
    ).toEqual({ kind: "gone" });
    expect(
      await readLeaderStart(
        21,
        linux({ "/proc/21/stat": { code: "EACCES" }, [BOOT_ID_PATH]: BOOT_ID }),
      ),
    ).toEqual({ kind: "unknown", why: "EACCES" });
    expect(
      await readLeaderStart(
        21,
        linux({ "/proc/21/stat": "garbage", [BOOT_ID_PATH]: BOOT_ID }),
      ),
    ).toMatchObject({ kind: "unknown" });
  });

  test("no boot id, or an odd one, is unknown: ticks alone restart at each boot", async () => {
    expect(await readLeaderStart(21, linux({ "/proc/21/stat": STAT }))).toEqual(
      { kind: "unknown", why: "ENOENT" },
    );
    expect(
      await readLeaderStart(
        21,
        linux({ "/proc/21/stat": STAT, [BOOT_ID_PATH]: "x:y\n" }),
      ),
    ).toMatchObject({ kind: "unknown" });
  });
});

test.describe("readLeaderStart, macOS", () => {
  test("reads ps's date", async () => {
    expect(
      await readLeaderStart(
        21,
        darwin({
          kind: "exited",
          code: 0,
          stdout: "Tue Oct 13 23:57:39 2026    \n",
        }),
      ),
    ).toEqual({ kind: "start", value: "ps:Tue Oct 13 23:57:39 2026" });
  });

  test("ps exiting 1 with nothing is gone; anything else, unknown", async () => {
    expect(
      await readLeaderStart(
        21,
        darwin({ kind: "exited", code: 1, stdout: "" }),
      ),
    ).toEqual({ kind: "gone" });
    expect(
      await readLeaderStart(
        21,
        darwin({ kind: "exited", code: 2, stdout: "" }),
      ),
    ).toMatchObject({ kind: "unknown" });
    expect(
      await readLeaderStart(
        21,
        darwin({ kind: "exited", code: 0, stdout: "mer. 14 oct. 2026\n" }),
      ),
    ).toMatchObject({ kind: "unknown" });
    expect(
      await readLeaderStart(21, darwin({ kind: "failed", why: "timed out" })),
    ).toEqual({ kind: "unknown", why: "timed out" });
  });

  test("never rejects, whatever the system does", async () => {
    const throwing: LeaderStartDeps = {
      platform: "darwin",
      readText: () => Promise.reject(new Error()),
      ps: () => Promise.reject(Object.assign(new Error(), { code: "EMFILE" })),
    };
    expect(await readLeaderStart(21, throwing)).toEqual({
      kind: "unknown",
      why: "EMFILE",
    });
  });

  test("refuses what is not a PID without asking", async () => {
    for (const pid of [0, -1, 1.5, Number.NaN])
      expect(
        await readLeaderStart(pid, darwin({ kind: "failed", why: "asked" })),
      ).toEqual({ kind: "unknown", why: "not a process id" });
  });
});

test.describe("readLeaderStart, this system", () => {
  test("reads a live process's start twice the same, and another's differently", async () => {
    const first = await sleeper();
    let second: ChildProcess | undefined;
    try {
      const a = await readLeaderStart(first.pid ?? 0);
      expect(a).toMatchObject({
        kind: "start",
        value: process.platform === "linux" ? /^linux:/ : /^ps:/,
      });
      expect(await readLeaderStart(first.pid ?? 0)).toEqual(a);
      // `ps` reads to the second: start the other one in a later second.
      await delay(1100);
      second = await sleeper();
      const b = await readLeaderStart(second.pid ?? 0);
      expect(b.kind).toBe("start");
      expect(b).not.toEqual(a);
    } finally {
      await reap(first);
      if (second !== undefined) await reap(second);
    }
  });

  test("an ended process is gone", async () => {
    const child = await sleeper();
    const pid = child.pid ?? 0;
    await reap(child);
    expect(await readLeaderStart(pid)).toEqual({ kind: "gone" });
  });

  test("ps answers in the C locale and in UTC", async () => {
    test.skip(process.platform === "linux", "Linux reads procfs, not ps");
    const result = await runPs(process.pid);
    expect(result).toMatchObject({ kind: "exited", code: 0 });
    const start = psLstart(result.kind === "exited" ? result.stdout : "");
    expect(start).toBeDefined();
    // Read as UTC, it is when this process started — to ps's second.
    const started = Date.now() - process.uptime() * 1000;
    expect(Math.abs(Date.parse(`${start ?? ""} UTC`) - started)).toBeLessThan(
      2000,
    );
  });
});
