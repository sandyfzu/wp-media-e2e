import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STOPPED_ANNOTATION,
  STOP_FILE_ENV,
  assertStopFileFolder,
  drainReason,
  stopFileFromEnv,
  wasDrained,
} from "./drain";

/**
 * The drain gate's policy: which variable names the stop file, which attempts it skips, and how the
 * After hook recognises a scenario it skipped. The fixture that applies it is a thin binding in
 * `../fixtures.ts`; that a skip there runs no Before hook but still runs the After hook was measured
 * on a real run, which is what {@link wasDrained} exists for.
 */

const STOP = "/srv/orchestrator/runs/42/stop";

/** An `exists` that must never be called: the answer was already decided without the filesystem. */
function untouched(path: string): boolean {
  throw new Error(`the filesystem was consulted for ${path}`);
}

test.describe("stopFileFromEnv", () => {
  test("no variable, no gate", () => {
    expect(stopFileFromEnv({})).toBeUndefined();
  });

  test("a blank variable reads as unset, like every other variable of the suite", () => {
    for (const blank of ["", "   "]) {
      expect(stopFileFromEnv({ [STOP_FILE_ENV]: blank })).toBeUndefined();
    }
  });

  test("returns an absolute path verbatim", () => {
    expect(stopFileFromEnv({ [STOP_FILE_ENV]: STOP })).toBe(STOP);
  });

  // A relative path resolves against whatever the working directory is, so the gate could look
  // somewhere other than where the stop file is created and never close.
  test("refuses a relative path, naming the variable and its value", () => {
    for (const relative of ["runs/42/stop", "./stop", "stop"]) {
      expect(() => stopFileFromEnv({ [STOP_FILE_ENV]: relative })).toThrow(
        `${STOP_FILE_ENV} must be an absolute path with no surrounding whitespace, got ${JSON.stringify(relative)}`,
      );
    }
  });

  // Not trimmed: a stray space or newline would otherwise name a file nobody creates, silently. A
  // trailing one is the dangerous case — the path is still absolute.
  test("refuses a path with surrounding whitespace rather than trimming it", () => {
    for (const padded of [` ${STOP}`, `${STOP} `, `${STOP}\n`, `\t${STOP}`]) {
      expect(() => stopFileFromEnv({ [STOP_FILE_ENV]: padded })).toThrow(
        `must be an absolute path with no surrounding whitespace, got ${JSON.stringify(padded)}`,
      );
    }
  });

  test("reads process.env by default", () => {
    const saved = process.env[STOP_FILE_ENV];
    try {
      process.env[STOP_FILE_ENV] = STOP;
      expect(stopFileFromEnv()).toBe(STOP);
    } finally {
      if (saved === undefined)
        Reflect.deleteProperty(process.env, STOP_FILE_ENV);
      else process.env[STOP_FILE_ENV] = saved;
    }
  });
});

test.describe("assertStopFileFolder", () => {
  /** Root ignores directory permissions, so the "may not be searched" case cannot be provoked. */
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  let root: string;

  test.beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drain-"));
  });

  test.afterEach(() => {
    // Searchable again first, or the removal itself is refused.
    const locked = join(root, "locked");
    if (existsSync(locked)) chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts a stop file whose folder exists, though the file itself does not yet", () => {
    expect(() => {
      assertStopFileFolder(join(root, "stop"));
    }).not.toThrow();
  });

  test("refuses a folder that does not exist, naming the variable, the folder and the cause", () => {
    const stopFile = join(root, "missing", "stop");
    expect(() => {
      assertStopFileFolder(stopFile);
    }).toThrow(
      `${STOP_FILE_ENV}=${JSON.stringify(stopFile)}: its folder ${join(root, "missing")} cannot be read (ENOENT)`,
    );
  });

  test("refuses a folder that is a file", () => {
    writeFileSync(join(root, "plain"), "");
    expect(() => {
      assertStopFileFolder(join(root, "plain", "stop"));
    }).toThrow(/its folder .*plain is not a directory/);
  });

  test("refuses a folder under a file, which cannot be read at all", () => {
    writeFileSync(join(root, "plain"), "");
    expect(() => {
      assertStopFileFolder(join(root, "plain", "deeper", "stop"));
    }).toThrow(/cannot be read \(ENOTDIR\)/);
  });

  // The case the check exists for: `existsSync` cannot see into the folder, so it answers "absent"
  // even once the stop file is there — proved here first, then refused.
  test("refuses a folder this process may not search", () => {
    test.skip(isRoot, "root ignores directory permissions");
    const locked = join(root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "stop"), "");
    chmodSync(locked, 0o600);

    expect(existsSync(join(locked, "stop"))).toBe(false);
    expect(() => {
      assertStopFileFolder(join(locked, "stop"));
    }).toThrow(/its folder .*locked may not be searched by this process/);
  });
});

test.describe("drainReason", () => {
  /** A first attempt with nothing failed yet — the moment the gate normally runs. */
  const FIRST = { retry: 0, status: "passed" } as const;

  test("no stop file named: every attempt runs, and the filesystem is never asked", () => {
    expect(drainReason(undefined, FIRST, untouched)).toBeUndefined();
    expect(
      drainReason(undefined, { ...FIRST, retry: 1 }, untouched),
    ).toBeUndefined();
  });

  test("a first attempt runs while the stop file does not exist", () => {
    const asked: string[] = [];
    const reason = drainReason(STOP, FIRST, (path) => {
      asked.push(path);
      return false;
    });
    expect(reason).toBeUndefined();
    expect(asked).toEqual([STOP]);
  });

  test("a first attempt is skipped once the stop file exists, with a reason", () => {
    expect(drainReason(STOP, FIRST, () => true)).toBe(
      "the run was asked to stop before this scenario began, so it was not started",
    );
  });

  // A retry finishes a scenario that already ran: skipping it would turn its failure into "flaky".
  test("a retry always runs, even with the stop file there", () => {
    for (const retry of [1, 2]) {
      expect(drainReason(STOP, { ...FIRST, retry }, untouched)).toBeUndefined();
    }
  });

  // The gate runs late only after something before it failed. A skip then would become the
  // attempt's verdict and skip its retry unrun, so a broken site would read "flaky".
  test("an attempt that has already failed is left to its verdict", () => {
    for (const status of ["failed", "timedOut", "interrupted"] as const) {
      expect(
        drainReason(STOP, { ...FIRST, status }, untouched),
        status,
      ).toBeUndefined();
    }
  });
});

test.describe("wasDrained", () => {
  test("true for a scenario carrying the stopped annotation", () => {
    expect(wasDrained([{ type: STOPPED_ANNOTATION }, { type: "skip" }])).toBe(
      true,
    );
  });

  // A scenario skipped for any other reason may have run its Before hook, so it is not left alone.
  test("false for no annotations, or only others — a plain skip included", () => {
    expect(wasDrained([])).toBe(false);
    expect(wasDrained([{ type: "skip" }, { type: "issue" }])).toBe(false);
  });
});
