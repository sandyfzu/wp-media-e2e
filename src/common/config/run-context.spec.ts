import { test, expect } from "@playwright/test";
import { isAbsolute } from "node:path";

import unitConfig from "../../../playwright.unit.config";
import {
  dirs,
  isCellTargeted,
  NO_CELL,
  outputDirFor,
  REPO_ROOT,
  seedSelectedCells,
  selectedCells,
} from "./run-context";

/**
 * `selectedCells()` is the single source of truth for cell selection: it parses the
 * `--project` forms from `process.argv` (exactly what Playwright itself filters on) and, in a
 * forked worker — which receives the parent's environment but NOT its argv — falls back to the
 * selection `seedSelectedCells()` published. These tests drive both channels by swapping
 * `process.argv` / the env var and restoring them afterwards.
 */

const ORIGINAL_ARGV = process.argv;

/** The internal env channel `seedSelectedCells` writes; mirrored here so the test can drive it. */
const SELECTED_CELLS_ENV = "E2E_INTERNAL_SELECTED_CELLS";
const ORIGINAL_SEED = process.env[SELECTED_CELLS_ENV];

/** Run `body` with `process.argv` set to a synthetic CLI, always restoring it after. */
function withArgv(tail: string[], body: () => void): void {
  process.argv = ["node", "playwright", ...tail];
  try {
    body();
  } finally {
    process.argv = ORIGINAL_ARGV;
  }
}

/** Restores the seed env var to whatever the real process started with. */
function restoreSeed(): void {
  if (ORIGINAL_SEED === undefined) {
    Reflect.deleteProperty(process.env, SELECTED_CELLS_ENV);
  } else {
    process.env[SELECTED_CELLS_ENV] = ORIGINAL_SEED;
  }
}

test.beforeEach(() => {
  restoreSeed();
});

test.afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  restoreSeed();
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

test.describe("selection propagation to worker processes", () => {
  test("seedSelectedCells publishes the argv selection, selectedCells reads it back", () => {
    withArgv(["--project=pro@nginx"], () => {
      seedSelectedCells();
    });
    // A worker: no argv, but the seeded environment survives the fork.
    withArgv([], () => {
      expect(selectedCells()).toEqual(["pro@nginx"]);
    });
  });

  test("seedSelectedCells is a no-op without argv, so a worker never clobbers the seed", () => {
    withArgv(["--project=apache", "--project=nginx"], () => {
      seedSelectedCells();
    });
    withArgv([], () => {
      seedSelectedCells(); // the worker re-building the config
      expect(selectedCells()).toEqual(["apache", "nginx"]);
    });
  });

  test("argv wins over a stale seed", () => {
    withArgv(["--project=stale"], () => {
      seedSelectedCells();
    });
    withArgv(["--project=fresh"], () => {
      expect(selectedCells()).toEqual(["fresh"]);
    });
  });

  test("an unparseable seed degrades to a serial run rather than throwing", () => {
    process.env[SELECTED_CELLS_ENV] = "{not json";
    withArgv([], () => {
      expect(selectedCells()).toEqual([]);
    });
  });
});

test.describe("isCellTargeted (gates whether per-run overrides apply)", () => {
  const CELL = "pro@nginx";
  const PROJECT = `artifacts:${CELL}`;

  test("true when the cell itself is selected — the usual invocation", () => {
    withArgv([`--project=${CELL}`], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(true);
    });
  });

  test("true when the caller's own setup project is selected by name", () => {
    // How an operator resolves one cell's zips without running its scenarios.
    withArgv([`--project=${PROJECT}`], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(true);
    });
  });

  test("false with no selection — a broad sweep must not inherit one cell's overrides", () => {
    withArgv([], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(false);
    });
  });

  test("false for another cell's selection", () => {
    withArgv(["--project=apache"], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(false);
    });
  });

  test("false for a wildcard: broad by design, so overrides warn instead of applying", () => {
    withArgv(["--project=*"], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(false);
    });
  });

  test("reads the seeded selection, so it holds inside a worker (no argv there)", () => {
    withArgv([`--project=${CELL}`], () => {
      seedSelectedCells();
    });
    withArgv([], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(true);
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

test.describe("outputDirFor — only a run targeting a cell may own (and so empty) its folder", () => {
  const OUTPUT_ROOT = "OUTPUT_ROOT";
  const saved = process.env[OUTPUT_ROOT];

  test.beforeEach(() => {
    Reflect.deleteProperty(process.env, OUTPUT_ROOT);
  });

  test.afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, OUTPUT_ROOT);
    else process.env[OUTPUT_ROOT] = saved;
  });

  test("the targeted cell writes in its own folder", () => {
    expect(outputDirFor("backwpup", "pro@nginx", "pro@nginx")).toBe(
      "test-results/backwpup/pro@nginx",
    );
  });

  test("a run targeting no cell writes under _all/<cell>", () => {
    expect(NO_CELL).toBe("_all");
    expect(outputDirFor("backwpup", "pro@nginx", undefined)).toBe(
      "test-results/backwpup/_all/pro@nginx",
    );
  });

  test("another cell's project in a targeted run writes under _all/<cell> too", () => {
    expect(outputDirFor("backwpup", "free@nginx", "pro@nginx")).toBe(
      "test-results/backwpup/_all/free@nginx",
    );
  });

  test("OUTPUT_ROOT replaces only the root, for both kinds of run", () => {
    process.env[OUTPUT_ROOT] = "/srv/e2e-output";
    expect(outputDirFor("wp-rocket", "nginx", "nginx")).toBe(
      "/srv/e2e-output/wp-rocket/nginx",
    );
    expect(outputDirFor("wp-rocket", "nginx", undefined)).toBe(
      "/srv/e2e-output/wp-rocket/_all/nginx",
    );
  });

  test("unit runs write in a _unit folder of their own, which no product can be named", () => {
    expect(unitConfig.outputDir).toMatch(/\/_unit$/);
  });
});
