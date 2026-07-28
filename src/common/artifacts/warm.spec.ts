import { test, expect } from "@playwright/test";

import { warmArtifacts } from "./warm";
import type { WarmOne, WarmUnit } from "./warm";
import type { ApvmBuildParams, ArtifactEnv, ProductArtifacts } from "./types";

/**
 * Unit tests for the pure warm orchestration: deduping build requests, skipping provided zips,
 * surfacing planner warnings once, and collecting per-unit plan failures and per-request warm
 * failures without aborting the batch. The real APVM call (`createApvmWarmer`) is thin glue and
 * exercised end-to-end; here `warmOne` is a recording double.
 */

/** WP Rocket-like: editionless, embedded version, both roles — yields two build requests. */
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

/** BackWPup-like: editionful, required version, `plugin` only — yields one build request per cell. */
const BWU: ProductArtifacts = {
  project: "backwpup",
  defaultRef: { plugin: "develop" },
  version: { kind: "required", defaultVersion: { plugin: "9.99.99" } },
  edition: {
    kind: "editionful",
    byEdition: {
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
    },
  },
};

/** Empty overrides — the common case where warming plans pure defaults. */
const NO_ENV: ArtifactEnv = {};

/** A `warmOne` double that records every request it is handed and reports a cache hit. */
function recorder(): { warmOne: WarmOne; calls: ApvmBuildParams[] } {
  const calls: ApvmBuildParams[] = [];
  const warmOne: WarmOne = (params) => {
    calls.push(params);
    return Promise.resolve({ fromCache: true });
  };
  return { warmOne, calls };
}

test("warms each distinct request once, recording every unit that wanted it", async () => {
  const units: WarmUnit[] = [
    { label: "wp-rocket/nginx", manifest: WPR, edition: undefined },
    { label: "wp-rocket/apache", manifest: WPR, edition: undefined },
  ];
  const { warmOne, calls } = recorder();
  const summary = await warmArtifacts(units, NO_ENV, warmOne);

  // Two cells, identical defaults ⇒ two distinct requests (develop, tag:latest-stable), each once.
  expect(calls.map((c) => c.gitRef).sort()).toEqual([
    "develop",
    "tag:latest-stable",
  ]);
  expect(summary.ok).toBe(true);
  for (const result of summary.results) {
    expect(result.wantedBy).toEqual(["wp-rocket/nginx", "wp-rocket/apache"]);
  }
});

test("produces APVM params identical to the resolver's plan (parity invariant)", async () => {
  const units: WarmUnit[] = [
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
  ];
  const { warmOne, calls } = recorder();
  await warmArtifacts(units, NO_ENV, warmOne);

  expect(calls).toEqual([
    {
      project: "backwpup",
      gitRef: "develop",
      version: "9.99.99",
      variants: ["pro-en"],
    },
  ]);
});

test("skips operator-provided zips (nothing to warm)", async () => {
  const units: WarmUnit[] = [
    { label: "wp-rocket/nginx", manifest: WPR, edition: undefined },
  ];
  const env: ArtifactEnv = { pluginZip: "/local/wp-rocket.zip" };
  const { warmOne, calls } = recorder();
  const summary = await warmArtifacts(units, env, warmOne);

  // `plugin` is a provided zip ⇒ skipped; only `previous` (a ref) is warmed.
  expect(calls.map((c) => c.gitRef)).toEqual(["tag:latest-stable"]);
  expect(summary.skipped).toEqual([
    {
      label: "wp-rocket/nginx",
      role: "plugin",
      rawPath: "/local/wp-rocket.zip",
    },
  ]);
});

test("collects planner warnings once, even across units sharing the env", async () => {
  const units: WarmUnit[] = [
    { label: "backwpup/free@nginx", manifest: BWU, edition: "free" },
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
  ];
  // `previous` vars on a product without that role ⇒ one warning, not one per unit.
  const env: ArtifactEnv = { previousRef: "tag:latest-stable" };
  const { warmOne } = recorder();
  const summary = await warmArtifacts(units, env, warmOne);

  const previousWarnings = summary.warnings.filter((w) =>
    w.includes("E2E_PREVIOUS_REF"),
  );
  expect(previousWarnings).toHaveLength(1);
});

test("collects a per-unit plan failure without aborting the batch", async () => {
  const units: WarmUnit[] = [
    { label: "wp-rocket/nginx", manifest: WPR, edition: undefined },
    // Editionful product with no edition ⇒ its plan throws; the other unit must still warm.
    { label: "backwpup/broken", manifest: BWU, edition: undefined },
  ];
  const { warmOne, calls } = recorder();
  const summary = await warmArtifacts(units, NO_ENV, warmOne);

  expect(summary.planFailures.map((f) => f.label)).toEqual(["backwpup/broken"]);
  expect(calls.map((c) => c.gitRef).sort()).toEqual([
    "develop",
    "tag:latest-stable",
  ]);
  expect(summary.ok).toBe(false);
});

test("collects a per-request warm failure and marks the summary not ok", async () => {
  const units: WarmUnit[] = [
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
    { label: "wp-rocket/nginx", manifest: WPR, edition: undefined },
  ];
  const warmOne: WarmOne = (params) =>
    params.project === "backwpup"
      ? Promise.reject(new Error("boom"))
      : Promise.resolve({ fromCache: false });
  const summary = await warmArtifacts(units, NO_ENV, warmOne);

  const backwpup = summary.results.find((r) => r.params.project === "backwpup");
  expect(backwpup?.ok).toBe(false);
  expect(backwpup?.error).toContain("boom");
  expect(summary.results.filter((r) => r.ok).length).toBe(2); // both wp-rocket refs
  expect(summary.ok).toBe(false);
});

test("an empty unit list is a clean no-op", async () => {
  const { warmOne, calls } = recorder();
  const summary = await warmArtifacts([], NO_ENV, warmOne);
  expect(calls).toHaveLength(0);
  expect(summary).toEqual({
    results: [],
    skipped: [],
    planFailures: [],
    warnings: [],
    ok: true,
  });
});
