import { test, expect } from "@playwright/test";

import { cellOfProject, cellProjectNames, setupKindOf } from "./project-names";

/**
 * A cell's project names, and reading them back: the reporters tell a setup from a scenario, and a
 * setup's cell, by these names alone.
 */

test.describe("project names", () => {
  test("a cell's three projects", () => {
    expect(cellProjectNames("pro@nginx")).toEqual({
      setup: "setup:pro@nginx",
      artifacts: "artifacts:pro@nginx",
      scenarios: "pro@nginx",
    });
  });

  test("each name reads back as its setup kind and its cell", () => {
    for (const cell of ["pro@nginx", "apache", "a.b_c-1"]) {
      const names = cellProjectNames(cell);
      expect(setupKindOf(names.setup)).toBe("auth");
      expect(setupKindOf(names.artifacts)).toBe("artifacts");
      expect(setupKindOf(names.scenarios)).toBeUndefined();
      for (const name of Object.values(names)) {
        expect(cellOfProject(name), name).toBe(cell);
      }
    }
  });

  test("a name that merely contains a prefix is a cell's scenarios", () => {
    for (const name of ["setupx", "my-setup", "artifacts"]) {
      expect(setupKindOf(name), name).toBeUndefined();
      expect(cellOfProject(name), name).toBe(name);
    }
  });
});
