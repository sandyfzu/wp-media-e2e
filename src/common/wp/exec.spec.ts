import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  copyIntoTarget,
  dockerArgv,
  dockerCpArgv,
  elevationSupport,
  execElevated,
  sudoArgv,
  wpRootDir,
} from "./exec";
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

/**
 * Elevation, split the way the code is: the **invocation** is pure argv and checked as such, while
 * the **capability probe** is exercised against a fake `sudo` on `PATH`.
 *
 * The fake is not a security stand-in — it exists so the escalation policy can be observed on a
 * machine that has no passwordless root, which is most of them. Each test gets its own WordPress
 * root because probe results are cached per target.
 */

/** Answers the `sudo -n true` probe, then runs the command; `FAKE_SUDO_DENY=1` refuses everything. */
const FAKE_SUDO = `#!/usr/bin/env bash
if [ "$FAKE_SUDO_DENY" = "1" ]; then exit 1; fi
[ "$1" = "-n" ] && shift
[ "$1" = "--" ] && shift
if [ "$1" = "true" ]; then exit 0; fi
exec "$@"
`;

let sudoDir: string;
let sudoPath: string;

test.beforeAll(() => {
  sudoDir = mkdtempSync(join(tmpdir(), "wp-fake-sudo-"));
  writeFileSync(join(sudoDir, "sudo"), FAKE_SUDO);
  chmodSync(join(sudoDir, "sudo"), 0o755);
  sudoPath = `${sudoDir}:${process.env.PATH ?? ""}`;
});

test.afterAll(() => {
  rmSync(sudoDir, { recursive: true, force: true });
});

/** A fresh `local` transport, so each test probes rather than reading another's cached answer. */
function freshLocal(elevate?: boolean): LocalTransport {
  const rootDir = mkdtempSync(join(tmpdir(), "wp-elevate-root-"));
  return {
    mode: "local",
    rootDir,
    ...(elevate === undefined ? {} : { elevate }),
  };
}

test.describe("sudoArgv", () => {
  test("never prompts, and stops sudo parsing the command's own flags", () => {
    expect(sudoArgv("rm", ["-rf", "/var/www/html/site/x"])).toEqual([
      "-n",
      "--",
      "rm",
      "-rf",
      "/var/www/html/site/x",
    ]);
  });
});

test.describe("dockerArgv", () => {
  test("runs as the container's own user by default", () => {
    expect(dockerArgv("wpme-wpcli-nginx", "rm", ["-rf", "/x"])).toEqual([
      "exec",
      "wpme-wpcli-nginx",
      "rm",
      "-rf",
      "/x",
    ]);
  });

  // `sudo` is not an option here: the official `wordpress:cli` image does not ship it, and the
  // daemon is already root — so elevation is a choice of user, made by the client.
  test("asRoot selects uid 0 rather than shelling out to sudo", () => {
    expect(
      dockerArgv("wpme-wpcli-nginx", "rm", ["-rf", "/x"], { asRoot: true }),
    ).toEqual(["exec", "-u", "0:0", "wpme-wpcli-nginx", "rm", "-rf", "/x"]);
  });
});

test.describe("elevationSupport", () => {
  test("docker is always available: `-u 0:0` cannot be refused", async () => {
    const docker: DockerTransport = { mode: "docker", container: "never-run" };
    expect(await elevationSupport(docker)).toBe("available");
  });

  // No command may run for this: a site that opted out must not be probed at all, which is also
  // what makes the answer safe to trust on an unreachable host.
  test("a site declaring elevate:false is disabled, without probing", async () => {
    const original = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(await elevationSupport(freshLocal(false))).toBe("disabled");
    } finally {
      process.env.PATH = original;
    }
  });

  test("a passwordless sudo answers available", async () => {
    const original = process.env.PATH;
    process.env.PATH = sudoPath;
    try {
      expect(await elevationSupport(freshLocal())).toBe("available");
    } finally {
      process.env.PATH = original;
    }
  });

  test("a sudo that refuses answers unavailable", async () => {
    const original = process.env.PATH;
    process.env.PATH = sudoPath;
    process.env.FAKE_SUDO_DENY = "1";
    try {
      expect(await elevationSupport(freshLocal())).toBe("unavailable");
    } finally {
      process.env.PATH = original;
      delete process.env.FAKE_SUDO_DENY;
    }
  });

  // A host with no sudo binary makes the probe throw rather than exit non-zero (execa cannot start
  // it). That means the same thing, so it must not escape as an error from a cleanup path.
  test("a missing sudo binary answers unavailable rather than throwing", async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "wp-no-sudo-"));
    const original = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      expect(await elevationSupport(freshLocal())).toBe("unavailable");
    } finally {
      process.env.PATH = original;
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test("the probe is cached per target", async () => {
    const original = process.env.PATH;
    const transport = freshLocal();
    process.env.PATH = sudoPath;
    try {
      expect(await elevationSupport(transport)).toBe("available");
      // Same transport, no sudo reachable: a second probe would now answer differently.
      process.env.PATH = "/nonexistent";
      expect(await elevationSupport(transport)).toBe("available");
    } finally {
      process.env.PATH = original;
    }
  });
});

test.describe("execElevated", () => {
  // The opt-out is authoritative: a caller that forgot to check must fail, not quietly escalate.
  test("refuses a site that declared elevate:false", async () => {
    await expect(
      execElevated(freshLocal(false), "rm", ["-rf", "/tmp/nothing"]),
    ).rejects.toThrow(/elevate: false/);
  });
});
