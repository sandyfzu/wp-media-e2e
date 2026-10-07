import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";

import { isObject } from "../guards";
import {
  CELL_PIN_ENV,
  assertPinKnown,
  assertSelectionFitsPin,
  matchesProjectFilter,
  pinnedCell,
} from "./cell-pin";

/**
 * The cell pin's own rules: reading `E2E_CELL`, refusing a pin the product does not have, and
 * refusing a `--project` the pinned config cannot satisfy — matched by Playwright's own rule,
 * which this spec checks against Playwright itself.
 */

const ORIGINAL_PIN = process.env[CELL_PIN_ENV];

test.afterEach(() => {
  if (ORIGINAL_PIN === undefined)
    Reflect.deleteProperty(process.env, CELL_PIN_ENV);
  else process.env[CELL_PIN_ENV] = ORIGINAL_PIN;
});

test.describe("pinnedCell", () => {
  test("is undefined when E2E_CELL is unset", () => {
    Reflect.deleteProperty(process.env, CELL_PIN_ENV);
    expect(pinnedCell()).toBeUndefined();
  });

  test("is undefined when E2E_CELL is blank, like every variable of the suite", () => {
    for (const blank of ["", "   "]) {
      process.env[CELL_PIN_ENV] = blank;
      expect(pinnedCell(), JSON.stringify(blank)).toBeUndefined();
    }
  });

  test("returns the value verbatim, surrounding whitespace included", () => {
    process.env[CELL_PIN_ENV] = "pro@nginx";
    expect(pinnedCell()).toBe("pro@nginx");
    process.env[CELL_PIN_ENV] = " pro@nginx";
    expect(pinnedCell()).toBe(" pro@nginx");
  });
});

test.describe("assertPinKnown", () => {
  const CELLS = ["free@nginx", "pro@nginx"];

  test("accepts a cell of the product", () => {
    expect(() => {
      assertPinKnown("pro@nginx", "backwpup", CELLS);
    }).not.toThrow();
  });

  test("refuses any other value, naming the variable, the value, the cells and the fix", () => {
    for (const pin of ["pro@ngnx", "PRO@nginx", " pro@nginx", "pro@nginx "]) {
      expect(() => {
        assertPinKnown(pin, "backwpup", CELLS);
      }, pin).toThrow(
        `[cell] E2E_CELL=${JSON.stringify(pin)} is not a cell of backwpup; its cells: ` +
          "free@nginx, pro@nginx. Set E2E_CELL to one of them, or unset it",
      );
    }
  });

  test("says so when the product has no cells at all", () => {
    expect(() => {
      assertPinKnown("a", "demo", []);
    }).toThrow("its cells: (none).");
  });
});

/** Playwright's own `--project` filter, `projectUtils.filterProjects`. */
type FilterProjects = (
  projects: readonly { readonly project: { readonly name: string } }[],
  names: readonly string[],
) => readonly { readonly project: { readonly name: string } }[];

/** Loads Playwright's filter from the runner it ships, or throws if it moved. */
function playwrightFilter(): FilterProjects {
  const runner: unknown = createRequire(import.meta.url)(
    "playwright/lib/runner",
  );
  const utils = isObject(runner) ? runner.projectUtils : undefined;
  const filter = isObject(utils) ? utils.filterProjects : undefined;
  if (typeof filter !== "function") {
    throw new Error(
      "playwright/lib/runner no longer exports projectUtils.filterProjects",
    );
  }
  return filter as FilterProjects;
}

/** The names of `projects` Playwright's filter selects with `filter` alone; none if it throws. */
function selectedByPlaywright(
  filter: string,
  projects: readonly string[],
): string[] {
  try {
    return playwrightFilter()(
      projects.map((name) => ({ project: { name } })),
      [filter],
    ).map(({ project }) => project.name);
  } catch {
    return [];
  }
}

test.describe("matchesProjectFilter — Playwright's own rule", () => {
  const PROJECTS = [
    "setup:pro@nginx",
    "artifacts:pro@nginx",
    "pro@nginx",
    "free@nginx",
    "a.b",
  ];
  const FILTERS = [
    "pro@nginx",
    "PRO@NGINX", // case is ignored
    "pro@ngin", // a prefix is not a match
    "*",
    "pro*",
    "*nginx",
    "setup:*",
    "*:pro@nginx",
    "free*",
    "a.b",
    "a?b", // no metacharacter but `*` means anything
    "a*b",
    "axb",
    ".*", // a regex in disguise matches only names that start with "."
    "",
  ];

  test("selects exactly what Playwright's filterProjects selects, filter by filter", () => {
    for (const filter of FILTERS) {
      const ours = PROJECTS.filter((name) =>
        matchesProjectFilter(filter, name),
      );
      expect(ours, JSON.stringify(filter)).toEqual(
        selectedByPlaywright(filter, PROJECTS),
      );
    }
  });
});

test.describe("assertSelectionFitsPin", () => {
  const PIN = "pro@nginx";
  const PROJECTS = ["setup:pro@nginx", "artifacts:pro@nginx", "pro@nginx"];

  test("accepts no --project, the cell, one of its setups, or a filter selecting them", () => {
    for (const selection of [
      [],
      ["pro@nginx"],
      ["artifacts:pro@nginx"],
      ["setup:pro@nginx", "pro@nginx"],
      ["PRO@nginx"],
      ["*"],
      ["pro*"],
    ]) {
      expect(() => {
        assertSelectionFitsPin(PIN, PROJECTS, selection);
      }, JSON.stringify(selection)).not.toThrow();
    }
  });

  test("refuses another cell, naming it, the pin, its projects and the fix", () => {
    expect(() => {
      assertSelectionFitsPin(PIN, PROJECTS, ["free@nginx"]);
    }).toThrow(
      '[cell] --project "free@nginx" selects nothing in this run: E2E_CELL pins it to ' +
        '"pro@nginx", whose projects are setup:pro@nginx, artifacts:pro@nginx, pro@nginx. ' +
        "Drop --project (the pin selects the cell), or set E2E_CELL to the cell you meant",
    );
  });

  test("names every stray value, even beside one that fits", () => {
    expect(() => {
      assertSelectionFitsPin(PIN, PROJECTS, [
        "pro@nginx",
        "free@nginx",
        "free*",
      ]);
    }).toThrow('--project "free@nginx", "free*" selects nothing');
  });
});
