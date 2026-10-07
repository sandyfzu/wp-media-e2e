import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTENT_COPY_DIR,
  CONTENT_COPY_FILE,
  ContentCopy,
  assertNoContentCopyLeft,
  benignCopyWarnings,
  copyArgv,
  parseCopyRoom,
  putBackArgv,
} from "./content-copy";
import type { LocalTransport } from "../../../common/config/types";

/**
 * The copy of `wp-content` taken around a restore that rewrites it.
 *
 * GNU tar is not on every runner (macOS ships bsdtar), so tar's own behaviour — `--recursive-unlink`
 * leaving the directory exactly as the copy holds it, links never followed, exit codes — was measured
 * against GNU tar 1.34 and 1.35 and is pinned here as argv. The copy's decisions run against a stubbed
 * `sudo` on `PATH`, which really makes and removes the copy's directory and answers `du` and `tar`
 * from the environment, and a stubbed `df`; every privileged argv is recorded.
 */

test.describe("tar arguments", () => {
  // Never `.` from inside: Ubuntu's GNU tar 1.35 then refuses to unlink `.` on the way back (exit 2,
  // measured live and in `ubuntu:24.04`).
  test("copy: wp-content itself, from the root; exclusions literal and anchored there", () => {
    expect(
      copyArgv("/s/.e2e_content_copy/wp-content.tar", "/s", [
        "plugins/backwpup-pro",
        "uploads/backwpup",
      ]),
    ).toEqual([
      "-cf",
      "/s/.e2e_content_copy/wp-content.tar",
      "--format=posix",
      "--no-wildcards",
      "--anchored",
      "--exclude=wp-content/plugins/backwpup-pro",
      "--exclude=wp-content/uploads/backwpup",
      "-C",
      "/s",
      "wp-content",
    ]);
  });

  test("put back: into the root, owners and modes kept, each directory emptied before it is filled", () => {
    expect(putBackArgv("/s/c.tar", "/s")).toEqual([
      "-xpf",
      "/s/c.tar",
      "--recursive-unlink",
      "-C",
      "/s",
    ]);
  });
});

test.describe("benignCopyWarnings", () => {
  test("accepts files that changed, or went, while they were read", () => {
    expect(
      benignCopyWarnings(
        "tar: ./debug.log: file changed as we read it\ntar: ./cache/x: File removed before we read it\n",
      ),
    ).toBe(true);
  });

  // `File shrank` pads with zeros; `sudo` exits 1 when it refuses; nothing at all is no warning.
  test("refuses anything else at exit 1", () => {
    for (const stderr of [
      "tar: ./cache/big.bin: File shrank by 49929856 bytes; padding with zeros",
      "sudo: a password is required",
      "tar: ./debug.log: file changed as we read it\nsudo: a password is required",
      "",
    ]) {
      expect(benignCopyWarnings(stderr), stderr).toBe(false);
    }
  });
});

test.describe("parseCopyRoom", () => {
  const DF =
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 101478960 72925244 28537332 72% /\n";

  test("reads the content's size and the free space", () => {
    expect(
      parseCopyRoom({ stdout: "281234\t/s/wp-content\n" }, { stdout: DF }),
    ).toEqual({ usedKb: 281234, freeKb: 28537332 });
  });

  // A refused `sudo du` answers nothing, which must not read as an empty directory.
  test("knows nothing from an empty or unexpected answer", () => {
    expect(parseCopyRoom({ stdout: "" }, { stdout: DF })).toBeUndefined();
    expect(
      parseCopyRoom({ stdout: "du: cannot read" }, { stdout: DF }),
    ).toBeUndefined();
    expect(parseCopyRoom({ stdout: "12\t/x" }, { stdout: "" })).toBeUndefined();
  });
});

test.describe("ContentCopy", () => {
  let binDir: string;
  let root: string;
  let realPath: string;
  const local = (): LocalTransport => ({ mode: "local", rootDir: root });
  const none = (): Promise<readonly string[]> => Promise.resolve([]);
  const dir = (): string => join(root, CONTENT_COPY_DIR);
  const archive = (): string => join(dir(), CONTENT_COPY_FILE);
  const log = (): string[] =>
    existsSync(join(binDir, "log"))
      ? readFileSync(join(binDir, "log"), "utf8").trim().split("\n")
      : [];
  const ENV = [
    "COPY_DU_KB",
    "COPY_DU_EMPTY",
    "COPY_TAR_EXIT",
    "COPY_TAR_ERR",
    "COPY_LIST_EXIT",
    "COPY_PUT_EXIT",
    "COPY_FREE_KB",
  ];

  /** A stub on `PATH` that records its argv, then runs `body`. */
  function stub(name: string, body: string): void {
    writeFileSync(
      join(binDir, name),
      `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "${join(binDir, "log")}"\n${body}\n`,
    );
    chmodSync(join(binDir, name), 0o755);
  }

  test.beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "bwp-copy-bin-"));
    root = mkdtempSync(join(tmpdir(), "bwp-copy-root-"));
    mkdirSync(join(root, "wp-content"));
    realPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${realPath}`;
    // `sudo -n -- <file> <args>`: the directory work done for real, the rest answered as configured.
    stub(
      "sudo",
      `shift 2
case "$1" in
  true) exit 0 ;;
  mkdir|chmod|rm|rmdir) exec "$@" ;;
  du) [ -n "$COPY_DU_EMPTY" ] && exit 1; printf '%s\\t%s\\n' "\${COPY_DU_KB:-1000}" "$4"; exit 0 ;;
  tar)
    case "$2" in
      -cf) : > "$3"; [ -n "$COPY_TAR_ERR" ] && printf '%s\\n' "$COPY_TAR_ERR" >&2; exit "\${COPY_TAR_EXIT:-0}" ;;
      -tf) [ "\${COPY_LIST_EXIT:-0}" = 0 ] && printf 'wp-content/\\nwp-content/index.php\\n'; exit "\${COPY_LIST_EXIT:-0}" ;;
      -xpf) [ "\${COPY_PUT_EXIT:-0}" != 0 ] && echo "tar: ./f1: Cannot open: File exists" >&2; exit "\${COPY_PUT_EXIT:-0}" ;;
    esac ;;
esac
exit 0`,
    );
    stub(
      "df",
      `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
printf '/dev/x 100 50 %s 50%% /\\n' "\${COPY_FREE_KB:-99999999}"`,
    );
  });

  test.afterEach(() => {
    process.env.PATH = realPath;
    for (const key of ENV) Reflect.deleteProperty(process.env, key);
    rmSync(binDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("copies once, as root, into a root-only directory, leaving out what it was told to", async () => {
    const copy = new ContentCopy(local(), () =>
      Promise.resolve(["plugins/backwpup-pro"]),
    );
    await copy.keep();
    await copy.keep();
    expect(
      log().filter((line) => line.startsWith("sudo -n -- tar -cf")),
    ).toEqual([
      `sudo -n -- tar -cf ${archive()} --format=posix --no-wildcards --anchored ` +
        `--exclude=wp-content/plugins/backwpup-pro -C ${root} wp-content`,
    ]);
    expect((statSync(dir()).mode & 0o777).toString(8)).toBe("700");
    expect(copy.kept).toBe(true);
  });

  test("refuses without elevation, before anything", async () => {
    const copy = new ContentCopy({ ...local(), elevate: false }, none);
    await expect(copy.keep()).rejects.toThrow(/passwordless sudo.*not run/s);
    expect(log().some((line) => /tar|mkdir|du/.test(line))).toBe(false);
    expect(existsSync(dir())).toBe(false);
  });

  test("refuses when the disk has no room for the copy", async () => {
    process.env.COPY_DU_KB = "5000000";
    process.env.COPY_FREE_KB = "5100000";
    await expect(new ContentCopy(local(), none).keep()).rejects.toThrow(
      /only 4980 MB are free.*not run/s,
    );
    expect(log().some((line) => line.includes("tar -cf"))).toBe(false);
  });

  // Measured: a `sudo` limited to other commands exits 1 with no output, which once read as 0 KB.
  test("refuses when the room cannot be told, rather than reading nothing as empty", async () => {
    process.env.COPY_DU_EMPTY = "1";
    await expect(new ContentCopy(local(), none).keep()).rejects.toThrow(
      /could not tell whether the disk has room.*not run/s,
    );
  });

  for (const [what, exit, stderr] of [
    ["tar failed", "2", "tar: ./x: Cannot open: Permission denied"],
    [
      "a file shrank while it was read",
      "1",
      "tar: ./big: File shrank by 9 bytes; padding with zeros",
    ],
    ["sudo refused the copy", "1", "sudo: a password is required"],
  ] as const) {
    test(`refuses a copy when ${what}, and leaves nothing behind`, async () => {
      process.env.COPY_TAR_EXIT = exit;
      process.env.COPY_TAR_ERR = stderr;
      await expect(new ContentCopy(local(), none).keep()).rejects.toThrow(
        new RegExp(`could not copy wp-content.*exit ${exit}.*not run`, "s"),
      );
      expect(existsSync(dir())).toBe(false);
    });
  }

  test("accepts a copy where a file changed while it was read", async () => {
    process.env.COPY_TAR_EXIT = "1";
    process.env.COPY_TAR_ERR = "tar: ./debug.log: file changed as we read it";
    const copy = new ContentCopy(local(), none);
    await copy.keep();
    expect(copy.kept).toBe(true);
  });

  test("refuses a copy that does not read back, and leaves nothing behind", async () => {
    process.env.COPY_LIST_EXIT = "2";
    await expect(new ContentCopy(local(), none).keep()).rejects.toThrow(
      /does not read back.*not run/s,
    );
    expect(existsSync(dir())).toBe(false);
  });

  // The earlier copy may be the only way back to that run's site; it is never overwritten.
  test("refuses when an earlier run's copy is still there, before anything", async () => {
    mkdirSync(dir());
    await expect(new ContentCopy(local(), none).keep()).rejects.toThrow(
      /an earlier run took is still in .*sudo tar -xpf .*--recursive-unlink.*not run/s,
    );
    expect(log().some((line) => /tar -cf|du /.test(line))).toBe(false);
    expect(existsSync(dir())).toBe(true);
  });

  test("refuses a content directory that is a link", async () => {
    rmSync(join(root, "wp-content"), { recursive: true });
    mkdirSync(join(root, "real-content"));
    symlinkSync(join(root, "real-content"), join(root, "wp-content"));
    await expect(new ContentCopy(local(), none).keep()).rejects.toThrow(
      /is a symbolic link.*not run/s,
    );
  });

  test("puts nothing back when no copy was taken", async () => {
    await new ContentCopy(local(), none).putBack();
    expect(log().some((line) => line.includes("tar -xpf"))).toBe(false);
  });

  test("puts the copy back once, emptying each directory first, then removes it", async () => {
    const copy = new ContentCopy(local(), none);
    await copy.keep();
    await copy.putBack();
    await copy.putBack();
    expect(
      log().filter((line) => line.startsWith("sudo -n -- tar -xpf")),
    ).toEqual([
      `sudo -n -- tar -xpf ${archive()} --recursive-unlink -C ${root}`,
    ]);
    expect(existsSync(dir())).toBe(false);
    expect(copy.kept).toBe(false);
  });

  // The copy is then the only way back, so it stays — with the way back spelled out.
  test("keeps the copy, and says how to put it back, when it will not go back", async () => {
    process.env.COPY_PUT_EXIT = "2";
    const copy = new ContentCopy(local(), none);
    await copy.keep();
    await expect(copy.putBack()).rejects.toThrow(
      new RegExp(
        `could not put wp-content back.*sudo tar -xpf ${archive().replace(/[.]/g, "\\.")} --recursive-unlink -C ${root.replace(/[.]/g, "\\.")}\``,
        "s",
      ),
    );
    expect(existsSync(dir())).toBe(true);
    expect(copy.kept).toBe(true);
  });

  test("a site holding an earlier run's copy is refused; one without is not", async () => {
    const site = { baseURL: "https://bwp.test", transport: local() };
    await expect(assertNoContentCopyLeft(site)).resolves.toBeUndefined();
    mkdirSync(dir());
    await expect(assertNoContentCopyLeft(site)).rejects.toThrow(
      /a copy of wp-content an earlier run took is still in/,
    );
    await expect(
      assertNoContentCopyLeft({ ...site, baseURL: "https://x.example.test" }),
    ).resolves.toBeUndefined();
    await expect(assertNoContentCopyLeft(undefined)).resolves.toBeUndefined();
  });
});
