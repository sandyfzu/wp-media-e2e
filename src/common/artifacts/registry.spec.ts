import { test, expect } from "@playwright/test";

import {
  getArtifacts,
  registerArtifacts,
  resetArtifactsRegistry,
} from "./registry";
import type { CellArtifacts, ResolvedArtifact } from "./types";

/**
 * Unit tests for the per-process resolved-artifacts registry. The registry is module-global
 * (like `metadata.ts`'s pool registry), so each test resets it first for isolation.
 */

/** A minimal valid resolved artifact for the `plugin` role. */
const PLUGIN: ResolvedArtifact = {
  role: "plugin",
  zipPath: "/tmp/.artifacts/wp-rocket/nginx/plugin/wp-rocket-3.17.4.zip",
  zipFilename: "wp-rocket-3.17.4.zip",
  source: "default-ref",
  ref: "develop",
  commit: "a1b2c3d",
  version: "3.17.4",
  origin: "built",
  resolvedAt: "2026-07-14T00:00:00.000Z",
};

const CELL: CellArtifacts = { plugin: PLUGIN };

test.beforeEach(() => {
  resetArtifactsRegistry();
});

test("register then get returns the same artifacts", () => {
  registerArtifacts("wp-rocket", "nginx", CELL);
  expect(getArtifacts("wp-rocket", "nginx")).toEqual(CELL);
});

test("keys are namespaced by product and cell", () => {
  registerArtifacts("wp-rocket", "nginx", CELL);
  expect(() => getArtifacts("wp-rocket", "apache")).toThrow();
  expect(() => getArtifacts("backwpup", "nginx")).toThrow();
});

test("get throws an actionable error when nothing was registered", () => {
  expect(() => getArtifacts("wp-rocket", "nginx")).toThrow(
    /no resolved artifacts registered for "wp-rocket\/nginx".*--project=<cell>/s,
  );
});

test("re-registering the same cell overwrites the prior entry", () => {
  registerArtifacts("wp-rocket", "nginx", CELL);
  const next: CellArtifacts = {
    plugin: { ...PLUGIN, version: "3.18.0", origin: "cache" },
  };
  registerArtifacts("wp-rocket", "nginx", next);
  expect(getArtifacts("wp-rocket", "nginx").plugin?.version).toBe("3.18.0");
});

test("reset clears all entries", () => {
  registerArtifacts("wp-rocket", "nginx", CELL);
  resetArtifactsRegistry();
  expect(() => getArtifacts("wp-rocket", "nginx")).toThrow();
});
