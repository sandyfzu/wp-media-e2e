import { test, expect } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { REPO_ROOT, RUN_ID } from "../config/run-context";

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
 * Unit tests for the consumption reader, in three layers: the pure `resolution.json` parser; the
 * fixture-facing `readResolvedArtifact` guards (unsupported role, memo fast-path, missing file,
 * vanished zip); and the **cross-process channel** itself — a real document written to a temp
 * artifacts tree and read back, which is how every scenario actually obtains its zip.
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

/**
 * A resolved `plugin` artifact, as the registry / a parsed resolution would hold it. Its
 * `zipPath` points at a real temp file, because the reader asserts the zip is still on disk.
 */
let PLUGIN: ResolvedArtifact;
let tmp: string;

test.beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "artifact-consume-"));
  const zipPath = join(tmp, "wp-rocket-3.17.4.zip");
  writeFileSync(zipPath, "not a real zip, but a real file");
  PLUGIN = {
    role: "plugin",
    zipPath,
    zipFilename: "wp-rocket-3.17.4.zip",
    source: "default-ref",
    ref: "develop",
    commit: "a1b2c3d",
    version: "3.17.4",
    origin: "built",
    resolvedAt: "2026-07-14T00:00:00.000Z",
  };
});
test.afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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

  test("returns the artifact from the in-process memo, without a resolution.json", () => {
    // No file is written for this cell: a memo hit must satisfy the read on its own.
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

  test("throws when the resolution names a zip that is no longer on disk", () => {
    registerManifest("wp-rocket", PLUGIN_ONLY);
    registerArtifacts("wp-rocket", "nginx", {
      plugin: { ...PLUGIN, zipPath: join(tmp, "deleted.zip") },
    });
    // Never hand a caller a path that vanished: `wp plugin install` would fail with the
    // cause invisible.
    expect(() => readResolvedArtifact("wp-rocket", "nginx", "plugin")).toThrow(
      /resolved "plugin" zip .* is gone/s,
    );
  });
});

// ── The cross-process channel: a real resolution.json on disk ───────────────────
//
// Playwright workers never resolve; they read the file the setup project wrote. These cases
// drive that path for real — write the document and its zip, then read it back — because it is
// the only route by which a scenario obtains its artifact.

test.describe("readResolvedArtifact — from a resolution.json on disk", () => {
  const PRODUCT = "wp-rocket";
  const CELL = "spec-disk-cell";
  const ZIP_NAME = "wp-rocket-3.17.4.zip";

  let root: string;
  let savedRoot: string | undefined;
  let warnings: string[];
  let realWarn: typeof console.warn;

  /** Writes a cell's `resolution.json` plus the zip it names, optionally stamped with `runId`. */
  function writeResolution(runId?: string): string {
    const cellDir = join(root, PRODUCT, CELL);
    mkdirSync(join(cellDir, "plugin"), { recursive: true });
    const zipPath = join(cellDir, "plugin", ZIP_NAME);
    writeFileSync(zipPath, "zip bytes");
    writeFileSync(
      join(cellDir, "resolution.json"),
      JSON.stringify({
        ...(runId !== undefined ? { runId } : {}),
        resolvedAt: "2026-07-14T00:00:00.000Z",
        roles: {
          plugin: {
            zipPath,
            zipFilename: ZIP_NAME,
            source: "default-ref",
            ref: "develop",
            commit: "a1b2c3d",
            version: "3.17.4",
            origin: "built",
            resolvedAt: "2026-07-14T00:00:00.000Z",
          },
        },
      }),
    );
    return zipPath;
  }

  test.beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "artifact-disk-"));
    savedRoot = process.env.ARTIFACTS_ROOT;
    // `dirs()` yields REPO_ROOT-relative paths that the reader joins onto REPO_ROOT, so the
    // override has to be relative too — this is that same temp tree, expressed that way.
    process.env.ARTIFACTS_ROOT = relative(REPO_ROOT, root);
    warnings = [];
    realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    registerManifest(PRODUCT, PLUGIN_ONLY);
  });

  test.afterEach(() => {
    console.warn = realWarn;
    if (savedRoot === undefined) {
      Reflect.deleteProperty(process.env, "ARTIFACTS_ROOT");
    } else {
      process.env.ARTIFACTS_ROOT = savedRoot;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("reads the artifact this run wrote, silently, then serves it from the memo", () => {
    const zipPath = writeResolution(RUN_ID);

    const artifact = readResolvedArtifact(PRODUCT, CELL, "plugin");
    expect(artifact).toEqual({
      role: "plugin",
      zipPath,
      zipFilename: ZIP_NAME,
      source: "default-ref",
      ref: "develop",
      commit: "a1b2c3d",
      version: "3.17.4",
      origin: "built",
      resolvedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(warnings).toEqual([]);

    // Removing the document proves the second read came from the memo, not a re-read.
    unlinkSync(join(root, PRODUCT, CELL, "resolution.json"));
    expect(readResolvedArtifact(PRODUCT, CELL, "plugin")).toEqual(artifact);
  });

  test("warns — but still serves — a resolution a PREVIOUS execution wrote", () => {
    // The `--no-deps` case: usable (those zips were resolved and verified), never silent.
    writeResolution("2020-01-01T00-00-00-000Z-1");

    expect(readResolvedArtifact(PRODUCT, CELL, "plugin").zipFilename).toBe(
      ZIP_NAME,
    );
    expect(warnings.join("\n")).toMatch(
      /using the resolution a PREVIOUS execution wrote for "wp-rocket\/spec-disk-cell"/,
    );
  });

  test("stays quiet for a resolution written before the runId stamp existed", () => {
    writeResolution(undefined);
    expect(readResolvedArtifact(PRODUCT, CELL, "plugin").zipFilename).toBe(
      ZIP_NAME,
    );
    expect(warnings).toEqual([]);
  });

  test("reports a corrupt document with the path, not a raw JSON error", () => {
    mkdirSync(join(root, PRODUCT, CELL), { recursive: true });
    writeFileSync(join(root, PRODUCT, CELL, "resolution.json"), "{ not json");
    expect(() => readResolvedArtifact(PRODUCT, CELL, "plugin")).toThrow(
      /could not read ".*resolution\.json".*may be corrupt/s,
    );
  });
});

test("resolutionFilePath lands inside the cell's artifacts dir", () => {
  const path = resolutionFilePath("wp-rocket", "nginx");
  expect(path).toContain("/wp-rocket/nginx/");
  expect(path.endsWith("/resolution.json")).toBe(true);
});
