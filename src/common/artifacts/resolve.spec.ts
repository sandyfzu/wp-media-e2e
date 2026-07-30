import { test, expect } from "@playwright/test";
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

import { resolveArtifacts, writeResolutionFile } from "./resolve";
import { parseResolution } from "./consume";
import type { ArtifactRequest, ResolvedArtifact, RoleOutcome } from "./types";

/**
 * The resolver's **provided-zip** path, which is the half that needs no APVM: validation
 * (suffix, existence, file-ness, and the containment guard), the wipe, the copy into the role
 * dir, and the `resolution.json` round-trip. The APVM build path is thin glue over the native
 * binding and is exercised end-to-end against a real cell instead.
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
  // Field-for-field equality, so the slug a worker reads back is the one that was verified.
  expect(parseResolution(raw, path).plugin).toEqual(artifact);
  expect(parseResolution(raw, path).plugin?.slug).toBe(SLUG);
  // The run stamp is what lets a consumer notice a resolution from a previous invocation.
  expect(raw).toHaveProperty("runId");
});
