import { test, expect } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importable, runInChildNode } from "../__fixtures__/child-node";
import {
  DOTENV_SWITCH_ENV,
  applyDotenv,
  describeIgnoredSwitch,
  loadDotenv,
  readDotenvFile,
} from "./dotenv";

/**
 * `.env` loading: what it sets, what wins over it, the switch that turns it off — and, in a fresh
 * Node, that the real side-effect module does the same.
 */

const LOAD_ENV = join(import.meta.dirname, "load-env.ts");

let dir: string;

test.beforeEach(() => {
  // Real path: a child's working directory reads back resolved (macOS's /var is a link).
  dir = realpathSync(mkdtempSync(join(tmpdir(), "e2e-dotenv-")));
});

test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A reader that fails the test if the file is read at all. */
function mustNotRead(): never {
  throw new Error("the file was read");
}

test.describe("applyDotenv", () => {
  test("sets only the keys the environment lacks; a real variable wins, even a blank one", () => {
    const target: NodeJS.ProcessEnv = { KEPT: "real", BLANK: "" };
    const result = applyDotenv(
      "KEPT=file\nBLANK=file\nNEW=1\nNEW=2\nEMPTY=\n",
      target,
    );
    expect(target).toEqual({ KEPT: "real", BLANK: "", NEW: "2", EMPTY: "" });
    // `parseEnv` does not keep the file's order.
    expect([...result.applied].sort()).toEqual(["EMPTY", "NEW"]);
    expect(result.ignoredSwitch).toBeUndefined();
  });

  test("reports a valid switch in the file and still sets it, so forked processes stay quiet", () => {
    const target: NodeJS.ProcessEnv = {};
    const result = applyDotenv(`${DOTENV_SWITCH_ENV}=false\nA=1\n`, target);
    expect(result.ignoredSwitch).toBe("false");
    expect(target).toEqual({ [DOTENV_SWITCH_ENV]: "false", A: "1" });
  });

  test("reports an invalid switch in the file but never sets it, so no forked process throws on it", () => {
    const target: NodeJS.ProcessEnv = {};
    const result = applyDotenv(`${DOTENV_SWITCH_ENV}=nope\nA=1\n`, target);
    expect(result).toEqual({ applied: ["A"], ignoredSwitch: "nope" });
    expect(target).toEqual({ A: "1" });
  });

  test("does not report a blank switch, nor one the environment already holds", () => {
    expect(
      applyDotenv(`${DOTENV_SWITCH_ENV}=\n`, {}).ignoredSwitch,
    ).toBeUndefined();
    const target: NodeJS.ProcessEnv = { [DOTENV_SWITCH_ENV]: "true" };
    expect(
      applyDotenv(`${DOTENV_SWITCH_ENV}=false\n`, target).ignoredSwitch,
    ).toBeUndefined();
    expect(target[DOTENV_SWITCH_ENV]).toBe("true");
  });
});

test.describe("applyDotenv — keys named like Object members", () => {
  test("sets them, as process.loadEnvFile() does, rather than taking an inherited member as present", () => {
    const target: NodeJS.ProcessEnv = {};
    applyDotenv("toString=t\nconstructor=c\n", target);
    expect(Object.hasOwn(target, "toString")).toBe(true);
    expect({ ...target }).toEqual({ toString: "t", constructor: "c" });
  });
});

test.describe("loadDotenv", () => {
  test("loads the file by default, and when the switch is blank or on", () => {
    for (const value of [undefined, " ", "true", "1"]) {
      const target: NodeJS.ProcessEnv =
        value === undefined ? {} : { [DOTENV_SWITCH_ENV]: value };
      const outcome = loadDotenv("/x/.env", target, () => "A=1\n");
      expect(outcome, JSON.stringify(value)).toEqual({
        kind: "loaded",
        path: "/x/.env",
        applied: ["A"],
        ignoredSwitch: undefined,
      });
      expect(target.A).toBe("1");
    }
  });

  test("never reads the file when the switch is off", () => {
    for (const value of ["false", "0", " FALSE "]) {
      const target: NodeJS.ProcessEnv = { [DOTENV_SWITCH_ENV]: value };
      expect(loadDotenv("/x/.env", target, mustNotRead), value).toEqual({
        kind: "off",
      });
      expect(target).toEqual({ [DOTENV_SWITCH_ENV]: value });
    }
  });

  test("refuses a switch that is not a boolean, naming it and its value, before reading", () => {
    expect(() =>
      loadDotenv("/x/.env", { [DOTENV_SWITCH_ENV]: "flase" }, mustNotRead),
    ).toThrow(
      `"${DOTENV_SWITCH_ENV}" must be a boolean (true/false/1/0), got "flase"`,
    );
  });

  test("leaves the environment alone when there is no file", () => {
    const target: NodeJS.ProcessEnv = {};
    expect(loadDotenv("/x/.env", target, () => undefined)).toEqual({
      kind: "absent",
      path: "/x/.env",
    });
    expect(target).toEqual({});
  });
});

test.describe("readDotenvFile", () => {
  test("reads a file, and returns undefined for a missing one", () => {
    const file = join(dir, ".env");
    writeFileSync(file, "A=1\n");
    expect(readDotenvFile(file)).toBe("A=1\n");
    expect(readDotenvFile(join(dir, "missing"))).toBeUndefined();
  });

  test("throws on one that exists but cannot be read, naming it, the reason and the way out", () => {
    const folder = join(dir, ".env");
    mkdirSync(folder);
    let thrown: unknown;
    try {
      readDotenvFile(folder);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      `Cannot read "${folder}" (EISDIR). Fix or remove it, or set ${DOTENV_SWITCH_ENV}=false ` +
        "to run without it.",
    );
    expect((thrown as Error).cause).toMatchObject({ code: "EISDIR" });
  });

  test("throws on a link to a missing file rather than reading it as no file", () => {
    const link = join(dir, ".env");
    symlinkSync(join(dir, "gone.env"), link);
    expect(() => readDotenvFile(link)).toThrow(
      `Cannot read "${link}" (a link to a missing file).`,
    );
  });
});

test.describe("describeIgnoredSwitch", () => {
  test("names the file and the value, and says to remove it and how to skip the file instead", () => {
    const message = describeIgnoredSwitch("/x/.env", "false");
    expect(message).toContain(
      `${DOTENV_SWITCH_ENV}=false in "/x/.env" has no effect`,
    );
    expect(message).toContain(
      `Remove it from the file; to skip the file, set it in the environment (${DOTENV_SWITCH_ENV}=false`,
    );
  });
});

test.describe("load-env.ts, imported in a fresh Node", () => {
  /** Imports the module from `dir` with `env` added; returns the probes and the warnings. */
  async function importLoadEnv(
    env: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    return runInChildNode(
      `
      const warnings = [];
      console.warn = (message) => warnings.push(String(message));
      await import(${importable(LOAD_ENV)});
      console.log(JSON.stringify({
        unknown: process.env.E2E_SPEC_UNKNOWN_KEY ?? null,
        kept: process.env.E2E_SPEC_KEPT ?? null,
        warnings,
      }));
      `,
      { cwd: dir, env },
    );
  }

  test.beforeEach(() => {
    writeFileSync(
      join(dir, ".env"),
      "E2E_SPEC_UNKNOWN_KEY=from-file\nE2E_SPEC_KEPT=from-file\n",
    );
  });

  test("loads every key of the working directory's .env, unknown ones included; the environment wins", async () => {
    expect(await importLoadEnv({ E2E_SPEC_KEPT: "from-env" })).toEqual({
      unknown: "from-file",
      kept: "from-env",
      warnings: [],
    });
  });

  test("loads nothing with the switch off", async () => {
    expect(
      await importLoadEnv({
        [DOTENV_SWITCH_ENV]: "false",
        E2E_SPEC_KEPT: "from-env",
      }),
    ).toEqual({ unknown: null, kept: "from-env", warnings: [] });
  });

  test("fails the process when .env exists but cannot be read, naming it", async () => {
    rmSync(join(dir, ".env"));
    mkdirSync(join(dir, ".env"));
    await expect(importLoadEnv()).rejects.toThrow(
      `Cannot read "${join(dir, ".env")}" (EISDIR)`,
    );
  });

  test("never touches an unreadable .env with the switch off", async () => {
    rmSync(join(dir, ".env"));
    mkdirSync(join(dir, ".env"));
    expect(await importLoadEnv({ [DOTENV_SWITCH_ENV]: "0" })).toEqual({
      unknown: null,
      kept: null,
      warnings: [],
    });
  });

  test("fails the process on a mistyped switch, naming its value", async () => {
    await expect(importLoadEnv({ [DOTENV_SWITCH_ENV]: "off" })).rejects.toThrow(
      `got "off"`,
    );
  });

  test("warns once that a switch in the file had no effect, and loads the file anyway", async () => {
    writeFileSync(
      join(dir, ".env"),
      `${DOTENV_SWITCH_ENV}=false\nE2E_SPEC_UNKNOWN_KEY=from-file\n`,
    );
    const result = await importLoadEnv();
    expect(result).toMatchObject({ unknown: "from-file" });
    expect((result as { warnings: string[] }).warnings).toEqual([
      describeIgnoredSwitch(join(dir, ".env"), "false"),
    ]);
  });
});
