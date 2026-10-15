import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GRACEFUL_FS_PATCH,
  PROBE_SENTINEL,
  probeImports,
  SETTLED,
  WATCHED_FUNCTIONS,
} from "./import-probe";

/**
 * The probe that proves a module leaves the process as it was must itself see every change it
 * claims to: "nothing changed" is only worth something from a probe that reports a change where there
 * is one. Each kind is shown with a small module written for the test.
 */

/** `src/common/config/`: `run-context.ts` loads `.env` (through `load-env.ts`) and stamps `RUN_ID`. */
const CONFIG_DIR = fileURLToPath(new URL("../config/", import.meta.url));

/** The test's own modules, by name: what each does as it is imported. */
const MODULES: Readonly<Record<string, string>> = {
  inert: "export const x = 1;",
  adds: 'process.env.E2E_PROBE_ADDED = "1";',
  changes: 'process.env.PATH = "/nowhere";',
  removes: "delete process.env.HOME;",
  listens: "process.on('SIGINT', () => {});",
  moves: "process.chdir('/');",
  "sets-exit-code": "process.exitCode = 3;",
  // Queued while the module runs, so it runs before the probe's own `setImmediate`: its file's.
  "defers-a-turn": "setImmediate(() => { process.env.E2E_PROBE_TURN = '1'; });",
  // An immediate queued from inside an immediate waits for the next turn of the loop, after the
  // probe has read the process: only the settled reading sees it.
  "defers-two-turns":
    "setImmediate(() => setImmediate(() => { process.env.E2E_PROBE_LATER = '1'; }));",
  forges:
    'process.env.E2E_PROBE_FORGED = "1"; process.on("exit", () => console.log("[]"));',
  exits: "process.exit(0);",
  "sets-umask": "process.umask(0);",
  "wraps-fetch":
    "const f = globalThis.fetch; globalThis.fetch = (...a) => f(...a);",
  "replaces-exit": "process.exit = () => undefined;",
  "sets-stack-trace-limit": "Error.stackTraceLimit = 0;",
  "sets-max-listeners": "process.setMaxListeners(0);",
  "sets-default-max-listeners":
    "import { EventEmitter } from 'node:events'; EventEmitter.defaultMaxListeners = 100;",
  "wraps-close":
    "import fs from 'node:fs'; const c = fs.close; fs.close = (...a) => c(...a);",
  "wraps-cwd": "const c = process.cwd; process.cwd = () => c.call(process);",
  // graceful-fs's marks on the closes and chdir, but a cwd that lies: not its patch.
  "mimics-graceful-fs": [
    "import fs from 'node:fs';",
    "const previous = Symbol.for('graceful-fs.previous');",
    "for (const name of ['close', 'closeSync']) {",
    "  const old = fs[name]; fs[name] = (...a) => old(...a); fs[name][previous] = old;",
    "}",
    "const chdir = process.chdir; process.chdir = (d) => chdir.call(process, d);",
    "Object.setPrototypeOf(process.chdir, chdir);",
    "process.cwd = () => '/elsewhere';",
  ].join("\n"),
  // Playwright's own bundle, which carries graceful-fs: its patch is the one accepted.
  "loads-graceful-fs": `import ${JSON.stringify(
    import.meta.resolve("playwright-core/lib/utilsBundle"),
  )};`,
};

/** Where {@link MODULES} are written, for the suite's lifetime. */
let modulesDir = "";

/** The absolute path of the test module `name`. */
function testModule(name: string): string {
  return join(modulesDir, `${name}.mjs`);
}

test.beforeAll(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "e2e-import-probe-spec-"));
  for (const [name, source] of Object.entries(MODULES)) {
    writeFileSync(testModule(name), `${source}\n`);
  }
});

test.afterAll(() => {
  rmSync(modulesDir, { recursive: true, force: true });
});

test.describe("probeImports", () => {
  test("sees run-context load .env and stamp RUN_ID", async () => {
    const file = `${CONFIG_DIR}run-context.ts`;
    const [entry] = await probeImports([file]);
    expect(entry?.file).toBe(file);
    expect(entry?.effects).toEqual(
      expect.arrayContaining([`env ${PROBE_SENTINEL}`, "env RUN_ID"]),
    );
  });

  test("charges a change to the first import that made it, not to a module loaded again", async () => {
    const loadEnv = `${CONFIG_DIR}load-env.ts`;
    // Alone, load-env loads .env ...
    expect((await probeImports([loadEnv]))[0]?.effects).toEqual([
      `env ${PROBE_SENTINEL}`,
    ]);
    // ... but after run-context, which imports it, it runs no more and changes nothing.
    const [first, second] = await probeImports([
      `${CONFIG_DIR}run-context.ts`,
      loadEnv,
    ]);
    expect(first?.effects).toContain(`env ${PROBE_SENTINEL}`);
    expect(second).toEqual({ file: loadEnv, effects: [] });
  });

  test("reports a variable added, changed or removed, a listener, the working directory and the exit code", async () => {
    const names = [
      "adds",
      "changes",
      "removes",
      "listens",
      "moves",
      "sets-exit-code",
      "inert",
    ];
    expect(await probeImports(names.map(testModule))).toEqual([
      { file: testModule("adds"), effects: ["env E2E_PROBE_ADDED"] },
      { file: testModule("changes"), effects: ["env PATH"] },
      { file: testModule("removes"), effects: ["env HOME"] },
      { file: testModule("listens"), effects: ["listener SIGINT +1"] },
      { file: testModule("moves"), effects: ["cwd"] },
      { file: testModule("sets-exit-code"), effects: ["exitCode"] },
      { file: testModule("inert"), effects: [] },
      { file: SETTLED, effects: [] },
    ]);
  });

  test("reports the umask, listener limits, the stack trace limit and each watched function replaced", async () => {
    const names = [
      "sets-umask",
      "wraps-fetch",
      "replaces-exit",
      "sets-stack-trace-limit",
      "sets-max-listeners",
      "sets-default-max-listeners",
      "wraps-close",
      "wraps-cwd",
    ];
    expect(await probeImports(names.map(testModule))).toEqual([
      { file: testModule("sets-umask"), effects: ["umask"] },
      { file: testModule("wraps-fetch"), effects: ["function fetch"] },
      { file: testModule("replaces-exit"), effects: ["function process.exit"] },
      {
        file: testModule("sets-stack-trace-limit"),
        effects: ["Error.stackTraceLimit"],
      },
      { file: testModule("sets-max-listeners"), effects: ["maxListeners"] },
      {
        file: testModule("sets-default-max-listeners"),
        effects: ["defaultMaxListeners"],
      },
      { file: testModule("wraps-close"), effects: ["function fs.close"] },
      { file: testModule("wraps-cwd"), effects: ["function process.cwd"] },
      { file: SETTLED, effects: [] },
    ]);
  });

  test("accepts graceful-fs's patch, as Playwright's bundle applies it, and nothing that only resembles it", async () => {
    const watched: readonly string[] = WATCHED_FUNCTIONS;
    expect(GRACEFUL_FS_PATCH.every((name) => watched.includes(name))).toBe(
      true,
    );
    expect(await probeImports([testModule("loads-graceful-fs")])).toEqual([
      { file: testModule("loads-graceful-fs"), effects: [] },
      { file: SETTLED, effects: [] },
    ]);
    // Its marks on three of the four, but a cwd answering another folder: each is reported.
    expect(await probeImports([testModule("mimics-graceful-fs")])).toEqual([
      {
        file: testModule("mimics-graceful-fs"),
        effects: [
          "cwd",
          "function fs.close",
          "function fs.closeSync",
          "function process.chdir",
          "function process.cwd",
        ],
      },
      { file: SETTLED, effects: [] },
    ]);
    // The patch, then a wrapped fetch: only the fetch.
    expect(
      await probeImports([
        testModule("loads-graceful-fs"),
        testModule("wraps-fetch"),
      ]),
    ).toEqual([
      { file: testModule("loads-graceful-fs"), effects: [] },
      { file: testModule("wraps-fetch"), effects: ["function fetch"] },
      { file: SETTLED, effects: [] },
    ]);
  });

  test("charges a change deferred by one turn to its file, and a later one to the settled reading", async () => {
    expect(
      await probeImports([
        testModule("defers-a-turn"),
        testModule("defers-two-turns"),
      ]),
    ).toEqual([
      { file: testModule("defers-a-turn"), effects: ["env E2E_PROBE_TURN"] },
      { file: testModule("defers-two-turns"), effects: [] },
      { file: SETTLED, effects: ["env E2E_PROBE_LATER"] },
    ]);
  });

  test("cannot be fooled by a module that prints a result as the process exits", async () => {
    expect(await probeImports([testModule("forges")])).toEqual([
      {
        file: testModule("forges"),
        effects: ["env E2E_PROBE_FORGED", "listener exit +1"],
      },
      { file: SETTLED, effects: [] },
    ]);
  });

  test("fails, saying so, when a module ends the process during its import", async () => {
    await expect(probeImports([testModule("exits")])).rejects.toThrow(
      /the import probe never finished: a module ended the process/,
    );
  });

  test("fails, naming the child's error, when an import fails", async () => {
    await expect(
      probeImports([`${CONFIG_DIR}no-such-module.ts`]),
    ).rejects.toThrow(/child Node failed .*no-such-module/s);
  });

  test("refuses a relative path, which the child would resolve against its own folder", async () => {
    await expect(probeImports(["src/common/config/env.ts"])).rejects.toThrow(
      'probeImports needs absolute paths, got "src/common/config/env.ts"',
    );
  });

  test("imports nothing and reports only the settled reading for an empty list", async () => {
    expect(await probeImports([])).toEqual([{ file: SETTLED, effects: [] }]);
  });
});
