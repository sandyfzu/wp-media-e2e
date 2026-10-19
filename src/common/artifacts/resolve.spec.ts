import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  builtArtifact,
  resolveArtifacts,
  writeResolutionFile,
} from "./resolve";
import { parseResolution } from "./consume";
import type {
  ArtifactRequest,
  BuildRequest,
  ResolvedArtifact,
  RoleOutcome,
} from "./types";
import type { JsBuildOutput } from "apvm-napi";

/**
 * The resolver's **provided-zip** path, which is the half that needs no APVM: validation
 * (suffix, existence, file-ness, and the containment guard), the wipe, the copy into the role
 * dir, the digest every role gets, and the `resolution.json` round-trip. Of the APVM build path,
 * the mapping of its output (`builtArtifact`) is tested here; the call itself is thin glue over the
 * native binding and is exercised end-to-end against a real cell instead.
 */

let tmp: string;

test.beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "artifact-resolve-"));
});
test.afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * The plugin slug this cell expects, as the identity preflight supplies it. The resolver stamps
 * it onto every role it produces; here it only has to arrive intact and round-trip on disk.
 */
const SLUG = "wp-rocket";

/** The cell's ephemeral artifacts dir for a test — the directory the resolver wipes. */
function artifactsDir(): string {
  return join(tmp, "artifacts", "wp-rocket", "nginx");
}

/** Writes a stand-in zip file (content is irrelevant here — identity is `verify.ts`'s job). */
function sourceZip(name: string, dir = tmp): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "zip bytes");
  return path;
}

/** A `plugin` zip request for `rawPath`. */
function zipRequest(rawPath: string): ArtifactRequest {
  return { kind: "zip", role: "plugin", source: "env-zip", rawPath };
}

/** Narrows an outcome to its resolved artifact, failing the test otherwise. */
function resolvedOf(outcome: RoleOutcome | undefined): ResolvedArtifact {
  if (outcome?.kind !== "resolved") {
    throw new Error(
      `expected a resolved outcome, got ${outcome?.kind ?? "none"}: ${
        outcome?.kind === "failed" ? outcome.error : ""
      }`,
    );
  }
  return outcome.artifact;
}

/** Narrows an outcome to its failure message, failing the test otherwise. */
function failureOf(outcome: RoleOutcome | undefined): string {
  if (outcome?.kind !== "failed") {
    throw new Error(
      `expected a failed outcome, got ${outcome?.kind ?? "none"}`,
    );
  }
  return `${outcome.error}\n${outcome.hint ?? ""}`;
}

test.describe("resolveArtifacts — provided zips", () => {
  test("copies the zip into the role dir and reports env-zip/copied", async () => {
    const dir = artifactsDir();
    const outcomes = await resolveArtifacts({
      requests: [zipRequest(sourceZip("wp-rocket-3.17.4.zip"))],
      artifactsDir: dir,
      slug: SLUG,
    });

    const artifact = resolvedOf(outcomes[0]);
    expect(artifact.zipPath).toBe(join(dir, "plugin", "wp-rocket-3.17.4.zip"));
    expect(artifact.source).toBe("env-zip");
    expect(artifact.origin).toBe("copied");
    // Every role carries the cell's expected slug, whatever the zip is called.
    expect(artifact.slug).toBe(SLUG);
    expect(existsSync(artifact.zipPath)).toBe(true);
  });

  test("records the SHA-256 of the zip it delivered", async () => {
    const source = sourceZip("wp-rocket-3.17.4.zip");
    const outcomes = await resolveArtifacts({
      requests: [zipRequest(source)],
      artifactsDir: artifactsDir(),
      slug: SLUG,
    });
    // Known bytes, hashed independently: the digest must be the zip's, not anything else's.
    expect(resolvedOf(outcomes[0]).sha256).toBe(
      createHash("sha256").update("zip bytes").digest("hex"),
    );
  });

  test("normalises the zip's mode so any user on the site can read it", async () => {
    // A source only its owner can read reaches a site unreadable: `docker cp` preserves the host
    // mode and numeric owner, so WP-CLI (a different uid in the container) then fails to open the
    // archive. Regression guard for that, checked on a deliberately owner-only source.
    const source = sourceZip("owner-only.zip");
    chmodSync(source, 0o600);

    const outcomes = await resolveArtifacts({
      requests: [zipRequest(source)],
      artifactsDir: artifactsDir(),
      slug: SLUG,
    });

    const mode = statSync(resolvedOf(outcomes[0]).zipPath).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  test("wipes the cell dir first, so a previous execution's files never survive", async () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, "plugin"), { recursive: true });
    const stale = join(dir, "plugin", "stale-from-last-run.zip");
    writeFileSync(stale, "old");
    writeFileSync(join(dir, "resolution.json"), "{}");

    await resolveArtifacts({
      requests: [zipRequest(sourceZip("fresh.zip"))],
      artifactsDir: dir,
      slug: SLUG,
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(dir, "resolution.json"))).toBe(false);
    expect(existsSync(join(dir, "plugin", "fresh.zip"))).toBe(true);
  });

  test("aborts before the wipe when a provided zip lives inside the artifacts dir", async () => {
    const dir = artifactsDir();
    // The trap: an operator reusing the last run's build as this run's input.
    const inside = sourceZip("reused.zip", join(dir, "plugin"));

    await expect(
      resolveArtifacts({
        requests: [zipRequest(inside)],
        artifactsDir: dir,
        slug: SLUG,
      }),
    ).rejects.toThrow(
      /inside this cell's ephemeral artifacts directory[\s\S]*wiped whole/,
    );

    // The decisive assertion: the operator's file was never deleted.
    expect(existsSync(inside)).toBe(true);
  });

  test("a zip merely NEAR the artifacts dir is fine (prefix match is not containment)", async () => {
    const dir = artifactsDir();
    const sibling = sourceZip("beside.zip", `${dir}-backup`);
    const outcomes = await resolveArtifacts({
      requests: [zipRequest(sibling)],
      artifactsDir: dir,
      slug: SLUG,
    });
    expect(resolvedOf(outcomes[0]).zipFilename).toBe("beside.zip");
  });

  test("reports a missing path, a non-zip suffix, and a directory, each actionably", async () => {
    const dir = artifactsDir();
    mkdirSync(join(tmp, "a-directory.zip"), { recursive: true });
    const outcomes = await resolveArtifacts({
      requests: [zipRequest(join(tmp, "absent.zip"))],
      artifactsDir: dir,
      slug: SLUG,
    });
    expect(failureOf(outcomes[0])).toMatch(/does not exist/);

    expect(
      failureOf(
        (
          await resolveArtifacts({
            requests: [zipRequest(sourceZip("plugin.tar.gz"))],
            artifactsDir: dir,
            slug: SLUG,
          })
        )[0],
      ),
    ).toMatch(/must point to a "\.zip" file/);

    expect(
      failureOf(
        (
          await resolveArtifacts({
            requests: [zipRequest(join(tmp, "a-directory.zip"))],
            artifactsDir: dir,
            slug: SLUG,
          })
        )[0],
      ),
    ).toMatch(/is not a file/);
  });

  test("a reported failure is scrubbed of anything credential-shaped", async () => {
    // Every per-role failure — including a rejection from deep inside the APVM call — becomes a
    // reported outcome through one funnel, and that outcome is embedded in the error a
    // Playwright report keeps. Prove the funnel scrubs by putting a token-shaped segment where
    // the message will quote it back.
    const token = "ghp_16CharsOrMoreAAAA";
    const outcomes = await resolveArtifacts({
      requests: [zipRequest(join(tmp, token, "missing.zip"))],
      artifactsDir: artifactsDir(),
      slug: SLUG,
    });
    const failure = failureOf(outcomes[0]);
    expect(failure).not.toContain(token);
    expect(failure).toContain("***");
  });

  test("one role's failure never stops another from resolving", async () => {
    const outcomes = await resolveArtifacts({
      requests: [
        zipRequest(join(tmp, "absent.zip")),
        { ...zipRequest(sourceZip("prev.zip")), role: "previous" },
      ],
      artifactsDir: artifactsDir(),
      slug: SLUG,
    });
    expect(outcomes.map((o) => o.kind)).toEqual(["failed", "resolved"]);
    const previous = resolvedOf(outcomes[1]);
    expect(previous.zipFilename).toBe("prev.zip");
    // One slug per cell: a cell is a single edition, so both roles resolve to the same plugin.
    expect(previous.slug).toBe(SLUG);
  });
});

test("writeResolutionFile round-trips through the consumer's parser", async () => {
  const dir = artifactsDir();
  const outcomes = await resolveArtifacts({
    requests: [zipRequest(sourceZip("wp-rocket-3.17.4.zip"))],
    artifactsDir: dir,
    slug: SLUG,
  });
  const artifact = resolvedOf(outcomes[0]);
  await writeResolutionFile(dir, [artifact]);

  const path = join(dir, "resolution.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  // Field-for-field equality, so the slug a worker reads back is the one that was verified.
  expect(parseResolution(raw, path).plugin).toEqual(artifact);
  expect(parseResolution(raw, path).plugin?.slug).toBe(SLUG);
  // The run stamp is what lets a consumer notice a resolution from a previous invocation.
  expect(raw).toHaveProperty("runId");
});

test.describe("builtArtifact", () => {
  /** A full SHA, as APVM reports a git build's `commit`. */
  const SHA = "f1ebfd05c0ffee00112233445566778899aabbcc";

  /** A BackWPup Pro `develop` build request. */
  const request: BuildRequest = {
    kind: "build",
    role: "plugin",
    source: "default-ref",
    params: {
      project: "backwpup",
      gitRef: "develop",
      version: "9.99.99",
      variants: ["pro-en"],
    },
  };

  /** APVM's build output for {@link request}; `over` replaces any top-level field. */
  function output(over: Partial<JsBuildOutput> = {}): JsBuildOutput {
    return {
      result: {
        artifacts: [
          {
            variantId: "pro-en",
            path: "/cell/plugin/backwpup-pro.zip",
            filename: "backwpup-pro.zip",
            size: 1,
            origin: "cache",
          },
        ],
        buildDir: "/tmp/build",
        version: "9.99.99",
        variantsBuilt: ["pro-en"],
        totalSize: 1,
        artifactCount: 1,
      },
      resolvedRef: {
        input: "develop",
        source: { type: "branch", value: "develop", description: "" },
        gitRef: "develop",
        commitSha: SHA,
      },
      commit: SHA,
      commitShort: SHA.slice(0, 7),
      branch: "develop",
      description: "",
      fromCache: true,
      ...over,
    };
  }

  test("records the full commit, never the short one, and the commit pin", () => {
    const artifact = builtArtifact(request, output());
    expect(artifact).toMatchObject({
      role: "plugin",
      zipPath: "/cell/plugin/backwpup-pro.zip",
      zipFilename: "backwpup-pro.zip",
      source: "default-ref",
      ref: "develop",
      commit: SHA,
      pinRef: `commit:${SHA}`,
      version: "9.99.99",
      origin: "cache",
    });
  });

  test("still delivers a build it cannot pin, without a pin", () => {
    // The run tested what it built; refusing it would only hide that. A warm is what must pin.
    const artifact = builtArtifact(
      request,
      output({ commit: "f1ebfd0", commitShort: "f1ebfd0" }),
    );
    expect(artifact).not.toHaveProperty("pinRef");
    expect(artifact).not.toHaveProperty("commit");
    expect(artifact.zipPath).toBe("/cell/plugin/backwpup-pro.zip");
  });

  test("records no commit for a release download, which APVM labels release-<tag>", () => {
    const artifact = builtArtifact(
      {
        ...request,
        params: { project: "backwpup", gitRef: "release:latest-stable" },
      },
      output({
        commit: "release-5.7.6",
        commitShort: "5.7.6",
        resolvedRef: {
          input: "release:latest-stable",
          source: { type: "release", value: "5.7.6", description: "" },
          gitRef: "5.7.6",
        },
      }),
    );
    expect(artifact).not.toHaveProperty("commit");
    expect(artifact.ref).toBe("release:latest-stable");
    // The only record of the tag the selector chose: the version comes from the zip's header.
    expect(artifact.pinRef).toBe("release:5.7.6");
  });

  test("a built artifact's ref, full commit, pin, version and digest survive resolution.json", async () => {
    // The provided-zip round trip has no ref, commit or version; this is the writer's other half.
    const dir = artifactsDir();
    mkdirSync(dir, { recursive: true });
    const artifact: ResolvedArtifact = {
      ...builtArtifact(request, output()),
      slug: "backwpup-pro",
      sha256: "b".repeat(64),
    };
    await writeResolutionFile(dir, [artifact]);

    const path = join(dir, "resolution.json");
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(parseResolution(raw, path).plugin).toEqual(artifact);
    expect(artifact).toMatchObject({
      ref: "develop",
      commit: SHA,
      pinRef: `commit:${SHA}`,
    });
  });

  test("refuses an output that is not the one zip the role expects", () => {
    const base = output();
    expect(() =>
      builtArtifact(
        { ...request, params: { ...request.params, variants: ["free"] } },
        output({
          result: {
            ...base.result,
            artifacts: [...base.result.artifacts, ...base.result.artifacts],
          },
        }),
      ),
    ).toThrow(/expected exactly one/);
  });
});
