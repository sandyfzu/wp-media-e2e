import { test, expect } from "@playwright/test";
import { isAbsolute } from "node:path";

import { dirs, REPO_ROOT, selectedCells } from "./run-context";

/**
 * `selectedCells()` is the single source of truth for cell selection: it parses the
 * `--project` forms from `process.argv` (exactly what Playwright itself filters on).
 * These tests drive it by swapping `process.argv` and restoring it afterwards.
 */

const ORIGINAL_ARGV = process.argv;

/** Run `body` with `process.argv` set to a synthetic CLI, always restoring it after. */
function withArgv(tail: string[], body: () => void): void {
  process.argv = ["node", "playwright", ...tail];
  try {
    body();
  } finally {
    process.argv = ORIGINAL_ARGV;
  }
}

test.afterEach(() => {
  process.argv = ORIGINAL_ARGV;
});

test.describe("selectedCells (parses --project)", () => {
  test("parses the equals form --project=<cell>", () => {
    withArgv(["--project=nginx"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
  });

  test("parses the space form --project <cell>", () => {
    withArgv(["--project", "nginx"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
  });

  test("parses the variadic form --project a b", () => {
    withArgv(["--project", "apache", "nginx"], () => {
      expect(selectedCells()).toEqual(["apache", "nginx"]);
    });
  });

  test("stops the variadic scan at the next flag", () => {
    withArgv(["--project", "nginx", "--workers", "3"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
  });

  test("de-duplicates repeated selections of the same cell", () => {
    withArgv(["--project=nginx", "--project", "nginx"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
  });

  test("returns empty when no --project is given (serial fallback)", () => {
    withArgv([], () => {
      expect(selectedCells()).toEqual([]);
    });
  });
});

test.describe("dirs — artifacts directory", () => {
  const ARTIFACTS_ROOT = "ARTIFACTS_ROOT";
  const saved = process.env[ARTIFACTS_ROOT];

  test.afterEach(() => {
    if (saved === undefined)
      Reflect.deleteProperty(process.env, ARTIFACTS_ROOT);
    else process.env[ARTIFACTS_ROOT] = saved;
  });

  test("defaults to .artifacts, always namespaced by product/cell", () => {
    Reflect.deleteProperty(process.env, ARTIFACTS_ROOT);
    expect(dirs("wp-rocket", "nginx").artifacts).toBe(
      ".artifacts/wp-rocket/nginx",
    );
  });

  test("ARTIFACTS_ROOT overrides only the root prefix", () => {
    process.env[ARTIFACTS_ROOT] = "/tmp/artifacts";
    expect(dirs("backwpup", "pro@nginx").artifacts).toBe(
      "/tmp/artifacts/backwpup/pro@nginx",
    );
  });

  test("REPO_ROOT is absolute (so paths never depend on process.cwd())", () => {
    expect(isAbsolute(REPO_ROOT)).toBe(true);
  });
});
