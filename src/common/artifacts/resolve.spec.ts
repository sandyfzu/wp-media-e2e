import { test, expect } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    });

    const artifact = resolvedOf(outcomes[0]);
    expect(artifact.zipPath).toBe(join(dir, "plugin", "wp-rocket-3.17.4.zip"));
    expect(artifact.source).toBe("env-zip");
    expect(artifact.origin).toBe("copied");
    expect(existsSync(artifact.zipPath)).toBe(true);
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
    });
    expect(resolvedOf(outcomes[0]).zipFilename).toBe("beside.zip");
  });

  test("reports a missing path, a non-zip suffix, and a directory, each actionably", async () => {
    const dir = artifactsDir();
    mkdirSync(join(tmp, "a-directory.zip"), { recursive: true });
    const outcomes = await resolveArtifacts({
      requests: [zipRequest(join(tmp, "absent.zip"))],
      artifactsDir: dir,
    });
    expect(failureOf(outcomes[0])).toMatch(/does not exist/);

    expect(
      failureOf(
        (
          await resolveArtifacts({
            requests: [zipRequest(sourceZip("plugin.tar.gz"))],
            artifactsDir: dir,
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
    });
    expect(outcomes.map((o) => o.kind)).toEqual(["failed", "resolved"]);
    expect(resolvedOf(outcomes[1]).zipFilename).toBe("prev.zip");
  });
});

test("writeResolutionFile round-trips through the consumer's parser", async () => {
  const dir = artifactsDir();
  const outcomes = await resolveArtifacts({
    requests: [zipRequest(sourceZip("wp-rocket-3.17.4.zip"))],
    artifactsDir: dir,
  });
  const artifact = resolvedOf(outcomes[0]);
  await writeResolutionFile(dir, [artifact]);

  const path = join(dir, "resolution.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  expect(parseResolution(raw, path).plugin).toEqual(artifact);
  // The run stamp is what lets a consumer notice a resolution from a previous invocation.
  expect(raw).toHaveProperty("runId");
});
