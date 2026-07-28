import { test, expect } from "@playwright/test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyIntoTarget, dockerCpArgv, wpRootDir } from "./exec";
import type { DockerTransport, LocalTransport } from "../config/types";

// The transfer primitive and the WP-root resolution are exercised on the `local` transport
// (a real filesystem) and, for `docker`, through the pure argv builder — `docker cp` itself
// needs a running daemon, so it is verified against a real container instead of here.

let workDir: string;
let local: LocalTransport;

test.beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "wp-exec-"));
  local = { mode: "local", rootDir: workDir };
});

test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test.describe("wpRootDir", () => {
  test("returns the declared rootDir for local and ssh", async () => {
    expect(await wpRootDir(local)).toBe(workDir);
    expect(
      await wpRootDir({
        mode: "ssh",
        host: "h",
        username: "u",
        privateKeyPath: "/k",
        rootDir: "/var/www/html/site",
      }),
    ).toBe("/var/www/html/site");
  });

  test("prefers a declared rootDir for docker over probing the container", async () => {
    const docker: DockerTransport = {
      mode: "docker",
      container: "never-started",
      rootDir: "/var/www/html",
    };
    // No `docker` binary call happens: an unresolvable container would otherwise throw.
    expect(await wpRootDir(docker)).toBe("/var/www/html");
  });
});

test.describe("dockerCpArgv", () => {
  test("builds a `docker cp` (not `docker exec`) argv with the container-scoped target", () => {
    expect(
      dockerCpArgv("wpme-wpcli-nginx", "/tmp/a.zip", "/var/www/html/a.zip"),
    ).toEqual(["cp", "/tmp/a.zip", "wpme-wpcli-nginx:/var/www/html/a.zip"]);
  });
});

test.describe("copyIntoTarget — local transport", () => {
  test("copies a file to the target path", async () => {
    const source = join(workDir, "source.txt");
    const target = join(workDir, "target.txt");
    writeFileSync(source, "payload");

    await copyIntoTarget(local, source, target);
    expect(readFileSync(target, "utf8")).toBe("payload");
  });

  test("overwrites an existing target (staging must be idempotent)", async () => {
    const source = join(workDir, "new.txt");
    const target = join(workDir, "existing.txt");
    writeFileSync(source, "fresh");
    writeFileSync(target, "stale");

    await copyIntoTarget(local, source, target);
    expect(readFileSync(target, "utf8")).toBe("fresh");
  });

  test("skips a copy of a file onto itself instead of truncating it", async () => {
    const file = join(workDir, "self.zip");
    writeFileSync(file, "IMPORTANT");

    await copyIntoTarget(local, file, file);
    expect(readFileSync(file, "utf8")).toBe("IMPORTANT");

    // Same file reached through a symlink — dev+ino equality catches it too.
    const link = join(workDir, "self-link.zip");
    symlinkSync(file, link);
    await copyIntoTarget(local, file, link);
    expect(readFileSync(file, "utf8")).toBe("IMPORTANT");
  });

  test("throws naming both paths when the copy cannot happen", async () => {
    const target = join(workDir, "missing-dir", "x.txt");
    await expect(
      copyIntoTarget(local, join(workDir, "absent.txt"), target),
    ).rejects.toThrow(/could not copy .*absent\.txt.*to .*x\.txt/s);
  });
});
