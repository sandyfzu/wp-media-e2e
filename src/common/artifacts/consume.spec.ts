import { test, expect } from "@playwright/test";

import {
  parseResolution,
  readResolvedArtifact,
  resolutionFilePath,
} from "./consume";
import {
  registerArtifacts,
  registerManifest,
  resetArtifactsRegistry,
} from "./registry";
import type { ProductArtifacts, ResolvedArtifact } from "./types";

/**
 * Unit tests for the consumption reader: the pure `resolution.json` parser and the
 * fixture-facing `readResolvedArtifact` (the unsupported-role guard, the memo fast-path, and the
 * missing-file error). The filesystem read itself is thin glue and exercised end-to-end
 * against a real cell; the meaty logic tested here needs no files.
 */

/** An editionless manifest supporting only the `plugin` role (like WP Rocket without `previous`). */
const PLUGIN_ONLY: ProductArtifacts = {
  project: "wp-rocket",
  defaultRef: { plugin: "develop" },
  version: { kind: "embedded" },
  edition: {
    kind: "editionless",
    identity: {
      slug: "wp-rocket",
      mainFile: "wp-rocket.php",
      pluginName: "WP Rocket",
    },
  },
};

/** A resolved `plugin` artifact, as the registry / a parsed resolution would hold it. */
const PLUGIN: ResolvedArtifact = {
  role: "plugin",
  zipPath: "/repo/.artifacts/wp-rocket/nginx/plugin/wp-rocket-3.17.4.zip",
  zipFilename: "wp-rocket-3.17.4.zip",
  source: "default-ref",
  ref: "develop",
  commit: "a1b2c3d",
  version: "3.17.4",
  origin: "built",
  resolvedAt: "2026-07-14T00:00:00.000Z",
};

test.beforeEach(() => {
  resetArtifactsRegistry();
});

test.describe("parseResolution", () => {
  /** A minimal on-disk document with one role entry (no `role` field — it is the key). */
  const doc = {
    resolvedAt: "2026-07-14T00:00:00.000Z",
    roles: {
      plugin: {
        zipPath: "/a/plugin/wp-rocket-3.17.4.zip",
        zipFilename: "wp-rocket-3.17.4.zip",
        source: "default-ref",
        ref: "develop",
        commit: "a1b2c3d",
        version: "3.17.4",
        origin: "built",
        resolvedAt: "2026-07-14T00:00:00.000Z",
      },
    },
  };

  test("reattaches the role key and passes optional fields through", () => {
    const artifacts = parseResolution(doc, "test");
    expect(artifacts.plugin).toEqual({ role: "plugin", ...doc.roles.plugin });
  });

  test("parses both roles when present", () => {
    const two = {
      roles: {
        plugin: doc.roles.plugin,
        previous: {
          zipPath: "/a/previous/wp-rocket-3.16.zip",
          zipFilename: "wp-rocket-3.16.zip",
          source: "default-ref",
          origin: "cache",
          resolvedAt: "2026-07-14T00:00:00.000Z",
        },
      },
    };
    const artifacts = parseResolution(two, "test");
    expect(artifacts.plugin?.role).toBe("plugin");
    expect(artifacts.previous?.role).toBe("previous");
    expect(artifacts.previous?.origin).toBe("cache");
  });

  test("omits absent optional fields (a provided zip has no ref/commit)", () => {
    const zipOnly = {
      roles: {
        plugin: {
          zipPath: "/a/plugin/custom.zip",
          zipFilename: "custom.zip",
          source: "env-zip",
          origin: "copied",
          resolvedAt: "2026-07-14T00:00:00.000Z",
        },
      },
    };
    const plugin = parseResolution(zipOnly, "test").plugin;
    expect(plugin).not.toHaveProperty("ref");
    expect(plugin).not.toHaveProperty("commit");
    expect(plugin).not.toHaveProperty("version");
  });

  test("ignores unknown role keys", () => {
    const extra = { roles: { plugin: doc.roles.plugin, bogus: { x: 1 } } };
    expect(Object.keys(parseResolution(extra, "test"))).toEqual(["plugin"]);
  });

  test("throws when the document has no roles map", () => {
    expect(() => parseResolution({ resolvedAt: "…" }, "f.json")).toThrow(
      /malformed resolution in "f\.json"/,
    );
  });

  test("throws naming a role with a missing required field", () => {
    const bad = { roles: { plugin: { zipFilename: "x.zip" } } };
    expect(() => parseResolution(bad, "f.json")).toThrow(
      /malformed "plugin" entry in "f\.json".*zipPath/s,
    );
  });

  test("throws on an unknown source/origin enum value", () => {
    const bad = {
      roles: { plugin: { ...doc.roles.plugin, origin: "teleported" } },
    };
    expect(() => parseResolution(bad, "f.json")).toThrow(/unknown origin/);
  });
});

test.describe("readResolvedArtifact", () => {
  test("throws when the product does not support the requested role", () => {
    registerManifest("wp-rocket", PLUGIN_ONLY);
    expect(() =>
      readResolvedArtifact("wp-rocket", "nginx", "previous"),
    ).toThrow(
      /"previous" role is not configured for product "wp-rocket".*Declare a "previous"/s,
    );
  });

  test("returns the artifact from the in-process memo without reading disk", () => {
    registerManifest("wp-rocket", PLUGIN_ONLY);
    registerArtifacts("wp-rocket", "nginx", { plugin: PLUGIN });
    expect(readResolvedArtifact("wp-rocket", "nginx", "plugin")).toEqual(
      PLUGIN,
    );
  });

  test("throws an actionable error when no resolution.json exists", () => {
    registerManifest("wp-rocket", PLUGIN_ONLY);
    // A cell whose ephemeral dir does not exist ⇒ the setup never ran for it.
    expect(() =>
      readResolvedArtifact("wp-rocket", "does-not-exist-cell", "plugin"),
    ).toThrow(
      /no resolution found for "wp-rocket\/does-not-exist-cell".*--no-deps/s,
    );
  });
});

test("resolutionFilePath lands inside the cell's artifacts dir", () => {
  const path = resolutionFilePath("wp-rocket", "nginx");
  expect(path).toContain("/wp-rocket/nginx/");
  expect(path.endsWith("/resolution.json")).toBe(true);
});
