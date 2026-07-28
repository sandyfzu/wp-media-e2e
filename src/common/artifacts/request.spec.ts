import { test, expect } from "@playwright/test";

import {
  ARTIFACT_ENV_VARS,
  buildArtifactPlan,
  readArtifactEnv,
} from "./request";
import type {
  ArtifactEnv,
  ArtifactPlan,
  ArtifactRequest,
  ArtifactRole,
  BuildRequest,
  ProductArtifacts,
} from "./types";
import type { Edition } from "../config/types";

/**
 * The pure `buildArtifactPlan` precedence/validation matrix, plus
 * the `readArtifactEnv` boundary. Manifests mirror the real products:
 * WP Rocket (editionless, embedded version, `previous` role) and BackWPup (edition-ful,
 * required version, no `previous` role). A third, `BWU_PREV`, models the *future*
 * edition-ful + `previous` shape so the per-role required-version default is proven now.
 */

// ── Test manifests ───────────────────────────────────────────────────────────

const WPR: ProductArtifacts = {
  project: "wp-rocket",
  defaultRef: { plugin: "develop", previous: "tag:latest-stable" },
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

const BWU_IDENTITY = {
  free: {
    variant: "free",
    identity: {
      slug: "backwpup",
      mainFile: "backwpup.php",
      pluginName: "BackWPup",
    },
  },
  pro: {
    variant: "pro-en",
    identity: {
      slug: "backwpup-pro",
      mainFile: "backwpup.php",
      pluginName: "BackWPup Pro",
    },
  },
} as const;

const BWU: ProductArtifacts = {
  project: "backwpup",
  defaultRef: { plugin: "develop" },
  version: { kind: "required", defaultVersion: { plugin: "9.99.99" } },
  edition: { kind: "editionful", byEdition: BWU_IDENTITY },
};

/** BackWPup as it will look once comparison tests land: a `previous` role + its default version. */
const BWU_PREV: ProductArtifacts = {
  project: "backwpup",
  defaultRef: { plugin: "develop", previous: "release:latest-stable" },
  version: {
    kind: "required",
    defaultVersion: { plugin: "9.99.99", previous: "9.99.98" },
  },
  edition: { kind: "editionful", byEdition: BWU_IDENTITY },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Runs the planner with sensible defaults (non-serial, no env) overridable per call. */
function plan(
  product: ProductArtifacts,
  opts: {
    edition?: Edition;
    serial?: boolean;
    env?: ArtifactEnv;
  } = {},
): ArtifactPlan {
  return buildArtifactPlan({
    product,
    edition: opts.edition,
    serial: opts.serial ?? false,
    env: opts.env ?? {},
  });
}

/** Finds the (single) request for a role, throwing (failing the test) if absent. */
function role(p: ArtifactPlan, r: ArtifactRole): ArtifactRequest {
  const found = p.requests.find((req) => req.role === r);
  if (found === undefined) throw new Error(`expected a "${r}" request`);
  return found;
}

/** Narrows a request to a build request, throwing (failing the test) if it is a zip request. */
function build(req: ArtifactRequest): BuildRequest {
  if (req.kind !== "build") {
    throw new Error(`expected a build request, got "${req.kind}"`);
  }
  return req;
}

// ── Defaults & request shape ────────────────────────────────────────────

test.describe("defaults and request shape", () => {
  test("WP Rocket emits plugin + previous builds from defaults, no version/variants", () => {
    const p = plan(WPR);
    expect(p.requests.map((r) => r.role)).toEqual(["plugin", "previous"]);
    expect(p.warnings).toEqual([]);

    const plugin = build(role(p, "plugin"));
    expect(plugin.source).toBe("default-ref");
    expect(plugin.params).toEqual({ project: "wp-rocket", gitRef: "develop" });

    const previous = build(role(p, "previous"));
    expect(previous.params).toEqual({
      project: "wp-rocket",
      gitRef: "tag:latest-stable",
    });
  });

  test("BackWPup emits only a plugin build, with required default version + edition variant", () => {
    const p = plan(BWU, { edition: "pro" });
    expect(p.requests.map((r) => r.role)).toEqual(["plugin"]);

    const plugin = build(role(p, "plugin"));
    expect(plugin.params).toEqual({
      project: "backwpup",
      gitRef: "develop",
      version: "9.99.99",
      variants: ["pro-en"],
    });
  });

  test("BackWPup free selects the free variant", () => {
    const plugin = build(role(plan(BWU, { edition: "free" }), "plugin"));
    expect(plugin.params.variants).toEqual(["free"]);
  });

  test("edition-ful product without an edition throws", () => {
    expect(() => plan(BWU)).toThrow(/edition-ful, but no edition was supplied/);
  });
});

// ── Precedence: env ref > default ─────────────────────────────────

test.describe("env ref overrides the default", () => {
  test("plugin env ref replaces the default and is marked env-ref", () => {
    const plugin = build(
      role(plan(WPR, { env: { pluginRef: "pr:123" } }), "plugin"),
    );
    expect(plugin.source).toBe("env-ref");
    expect(plugin.params.gitRef).toBe("pr:123");
    // The untouched previous role still uses its default.
    const previous = build(
      role(plan(WPR, { env: { pluginRef: "pr:123" } }), "previous"),
    );
    expect(previous.source).toBe("default-ref");
  });

  test("a role's env ref does not affect the other role", () => {
    const p = plan(WPR, { env: { previousRef: "tag:3.10" } });
    expect(build(role(p, "plugin")).params.gitRef).toBe("develop");
    expect(build(role(p, "previous")).params.gitRef).toBe("tag:3.10");
  });
});

// ── Env zip ────────────────────────────────────────────────────

test.describe("env zip", () => {
  test("produces a zip request carrying the raw path, unvalidated", () => {
    const p = plan(WPR, { env: { pluginZip: "./dist/wp-rocket.zip" } });
    const req = role(p, "plugin");
    expect(req.kind).toBe("zip");
    if (req.kind === "zip") {
      expect(req.source).toBe("env-zip");
      expect(req.rawPath).toBe("./dist/wp-rocket.zip");
    }
  });

  test("ref + zip for the same role is a hard error naming both vars", () => {
    expect(() =>
      plan(WPR, { env: { pluginRef: "develop", pluginZip: "/a.zip" } }),
    ).toThrow(/E2E_PLUGIN_REF and E2E_PLUGIN_ZIP are set.*mutually exclusive/);
  });

  test("cross-role ref+zip mix is allowed", () => {
    const p = plan(WPR, {
      env: { pluginRef: "develop", previousZip: "/prev.zip" },
    });
    expect(role(p, "plugin").kind).toBe("build");
    expect(role(p, "previous").kind).toBe("zip");
  });
});

// ── Version policy ────────────────────────────────────────────────

test.describe("version policy", () => {
  test("embedded product sends no version by default, passes an override through", () => {
    expect(build(role(plan(WPR), "plugin")).params.version).toBeUndefined();
    const overridden = build(
      role(plan(WPR, { env: { pluginVersion: "3.15.0" } }), "plugin"),
    );
    expect(overridden.params.version).toBe("3.15.0");
  });

  test("required product uses its per-role default, overridable by env", () => {
    // plugin default 9.99.99; previous default 9.99.98 (needs a build-type ref).
    const def = plan(BWU_PREV, {
      edition: "pro",
      env: { previousRef: "branch:old" },
    });
    expect(build(role(def, "plugin")).params.version).toBe("9.99.99");
    expect(build(role(def, "previous")).params.version).toBe("9.99.98");

    const overridden = plan(BWU_PREV, {
      edition: "pro",
      env: {
        pluginVersion: "5.1.0",
        previousRef: "branch:old",
        previousVersion: "5.0.0",
      },
    });
    expect(build(role(overridden, "plugin")).params.version).toBe("5.1.0");
    expect(build(role(overridden, "previous")).params.version).toBe("5.0.0");
  });

  test("release refs never carry a version, even for a required product", () => {
    // previous defaults to release:latest-stable → no version despite required policy.
    const previous = build(
      role(plan(BWU_PREV, { edition: "pro" }), "previous"),
    );
    expect(previous.params.gitRef).toBe("release:latest-stable");
    expect(previous.params.version).toBeUndefined();
  });

  test("a version alongside a release ref is warned and ignored", () => {
    const p = plan(BWU_PREV, {
      edition: "pro",
      env: { previousVersion: "5.0.0" }, // previous default is a release ref
    });
    expect(build(role(p, "previous")).params.version).toBeUndefined();
    expect(p.warnings.join("\n")).toMatch(
      /E2E_PREVIOUS_VERSION is set but ignored.*release ref/,
    );
  });

  test("a version alongside a provided zip is warned and ignored", () => {
    const p = plan(WPR, {
      env: { pluginZip: "/a.zip", pluginVersion: "3.15.0" },
    });
    expect(role(p, "plugin").kind).toBe("zip");
    expect(p.warnings.join("\n")).toMatch(
      /E2E_PLUGIN_VERSION is set but ignored.*prebuilt zip/,
    );
  });
});

// ── Inapplicable previous vars ────────────────────────────────

test.describe("previous vars on a product without the role", () => {
  test("are warned and ignored, leaving only the plugin request", () => {
    const p = plan(BWU, {
      edition: "free",
      env: { previousRef: "tag:x", previousVersion: "1.0.0" },
    });
    expect(p.requests.map((r) => r.role)).toEqual(["plugin"]);
    expect(p.warnings.join("\n")).toMatch(
      /E2E_PREVIOUS_REF, E2E_PREVIOUS_VERSION .*ignored.*no "previous" role/,
    );
  });
});

// ── Serial (cell-less) runs: warn + defaults, never fatal ─────────

test.describe("serial (cell-less) runs", () => {
  test("succeed on defaults with no env, no warnings", () => {
    const p = plan(WPR, { serial: true });
    expect(p.requests).toHaveLength(2);
    expect(p.warnings).toEqual([]);
  });

  test("warn (never throw) and fall back to defaults for any applicable plugin override", () => {
    for (const env of [
      { pluginRef: "pr:1" },
      { pluginZip: "/a.zip" },
      { pluginVersion: "3.15.0" },
    ] satisfies ArtifactEnv[]) {
      const p = plan(WPR, { serial: true, env });
      // Both roles still planned from defaults — even a would-be zip becomes a default build.
      expect(p.requests.map((r) => r.role)).toEqual(["plugin", "previous"]);
      const plugin = build(role(p, "plugin"));
      expect(plugin.source).toBe("default-ref");
      expect(plugin.params.gitRef).toBe("develop");
      expect(p.warnings.join("\n")).toMatch(
        /ignored on a serial \(cell-less\) run — using defaults/,
      );
    }
  });

  test("warn and fall back to defaults for an applicable previous override", () => {
    const p = plan(WPR, { serial: true, env: { previousRef: "tag:x" } });
    expect(build(role(p, "previous")).params.gitRef).toBe("tag:latest-stable");
    expect(p.warnings.join("\n")).toMatch(
      /E2E_PREVIOUS_REF is ignored on a serial \(cell-less\) run/,
    );
  });

  test("a serial ref+zip conflict does NOT throw — env is ignored, defaults used", () => {
    const p = plan(WPR, {
      serial: true,
      env: { pluginRef: "pr:1", pluginZip: "/a.zip" },
    });
    expect(build(role(p, "plugin")).params.gitRef).toBe("develop");
    expect(p.warnings.join("\n")).toMatch(
      /E2E_PLUGIN_REF, E2E_PLUGIN_ZIP are ignored on a serial/,
    );
  });

  test("inapplicable previous vars (product without the role) warn once, not twice", () => {
    const p = plan(BWU, {
      edition: "free",
      serial: true,
      env: { previousRef: "tag:x" },
    });
    expect(p.requests.map((r) => r.role)).toEqual(["plugin"]);
    // Exactly one warning, and it is the no-previous-role one (not a serial-override dup).
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings.join("\n")).toMatch(/no "previous" role/);
  });
});

// ── Degenerate comparison: identical plugin/previous requests ────

test.describe("degenerate comparison warning", () => {
  test("distinct default requests (develop vs tag) do not warn", () => {
    expect(plan(WPR).warnings).toEqual([]);
  });

  test("identical build requests warn (previous ref equals the plugin default)", () => {
    const p = plan(WPR, { env: { previousRef: "develop" } });
    expect(build(role(p, "plugin")).params.gitRef).toBe("develop");
    expect(build(role(p, "previous")).params.gitRef).toBe("develop");
    expect(p.warnings.join("\n")).toMatch(/identical request.*degenerate/);
  });

  test("identical zip requests (same path for both roles) warn", () => {
    const p = plan(WPR, {
      env: { pluginZip: "/a.zip", previousZip: "/a.zip" },
    });
    expect(p.warnings.join("\n")).toMatch(/identical request.*degenerate/);
  });

  test("different zip paths per role do not warn", () => {
    const p = plan(WPR, {
      env: { pluginZip: "/a.zip", previousZip: "/b.zip" },
    });
    expect(p.warnings.join("\n")).not.toMatch(/degenerate/);
  });
});

// ── readArtifactEnv (the impure boundary) ───────────────────────────────────────

test.describe("readArtifactEnv", () => {
  const NAMES = [
    ARTIFACT_ENV_VARS.plugin.ref,
    ARTIFACT_ENV_VARS.plugin.zip,
    ARTIFACT_ENV_VARS.plugin.version,
    ARTIFACT_ENV_VARS.previous.ref,
    ARTIFACT_ENV_VARS.previous.zip,
    ARTIFACT_ENV_VARS.previous.version,
  ];
  const saved = new Map<string, string | undefined>();

  test.beforeEach(() => {
    for (const name of NAMES) {
      saved.set(name, process.env[name]);
      // Reflect.deleteProperty (not the `delete` operator) sidesteps no-dynamic-delete.
      Reflect.deleteProperty(process.env, name);
    }
  });
  test.afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    saved.clear();
  });

  test("reads set vars and normalizes blank/absent to undefined", () => {
    process.env[ARTIFACT_ENV_VARS.plugin.ref] = "pr:123";
    process.env[ARTIFACT_ENV_VARS.plugin.version] = "  "; // blank → undefined
    const env = readArtifactEnv();
    expect(env.pluginRef).toBe("pr:123");
    expect(env.pluginVersion).toBeUndefined();
    expect(env.previousRef).toBeUndefined();
  });

  test("trims surrounding whitespace (a stray space in .env / CI YAML is not part of the value)", () => {
    process.env[ARTIFACT_ENV_VARS.plugin.ref] = "  develop\n";
    process.env[ARTIFACT_ENV_VARS.plugin.zip] = " /tmp/plugin.zip ";
    process.env[ARTIFACT_ENV_VARS.previous.version] = "\t3.15.0 ";
    const env = readArtifactEnv();
    expect(env.pluginRef).toBe("develop");
    expect(env.pluginZip).toBe("/tmp/plugin.zip");
    expect(env.previousVersion).toBe("3.15.0");
  });
});
