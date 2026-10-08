import { test, expect } from "@playwright/test";

import { boolEnv, env, intEnv, parseBoolean, requireEnv } from "./env";

/** The typed environment accessors: blank means unset, and a malformed value throws by name. */

const NAME = "E2E_SPEC_ENV_PROBE";

test.afterEach(() => {
  Reflect.deleteProperty(process.env, NAME);
});

test.describe("env / requireEnv", () => {
  test("return the value, and treat blank as unset", () => {
    process.env[NAME] = "x";
    expect(env(NAME, "d")).toBe("x");
    expect(requireEnv(NAME)).toBe("x");
    process.env[NAME] = "  ";
    expect(env(NAME, "d")).toBe("d");
    expect(() => requireEnv(NAME)).toThrow(
      `Missing required environment variable "${NAME}". Set it in the environment (a CI secret ` +
        "store), or in .env unless E2E_LOAD_DOTENV=false.",
    );
  });
});

test.describe("intEnv", () => {
  test("falls back when blank, and refuses a non-integer or out-of-range value by name", () => {
    expect(intEnv(NAME, 7)).toBe(7);
    process.env[NAME] = "3";
    expect(intEnv(NAME, 7, 0, 10)).toBe(3);
    for (const bad of ["3.5", "abc", "-1", "11"]) {
      process.env[NAME] = bad;
      expect(() => intEnv(NAME, 7, 0, 10), bad).toThrow(
        `"${NAME}" must be an integer in [0, 10], got "${bad}".`,
      );
    }
  });
});

test.describe("parseBoolean", () => {
  test("reads true/false/1/0 in any case and spacing; anything else is undefined", () => {
    for (const yes of ["true", "TRUE", " 1 "])
      expect(parseBoolean(yes)).toBe(true);
    for (const no of ["false", "False", "0\n"])
      expect(parseBoolean(no)).toBe(false);
    for (const other of ["", "  ", "yes", "no", "off", "2", "fals"])
      expect(parseBoolean(other), JSON.stringify(other)).toBeUndefined();
  });
});

test.describe("boolEnv", () => {
  test("falls back when unset or blank", () => {
    expect(boolEnv(NAME, true)).toBe(true);
    process.env[NAME] = " ";
    expect(boolEnv(NAME, false)).toBe(false);
  });

  test("throws on an unrecognised value, naming the variable and the value", () => {
    process.env[NAME] = "yes";
    expect(() => boolEnv(NAME, true)).toThrow(
      `Environment variable "${NAME}" must be a boolean (true/false/1/0), got "yes".`,
    );
  });

  test("reads the given source instead of process.env", () => {
    process.env[NAME] = "true";
    expect(boolEnv(NAME, true, { [NAME]: "0" })).toBe(false);
    expect(boolEnv(NAME, false, {})).toBe(false);
  });
});
