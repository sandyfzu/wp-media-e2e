import { test, expect } from "@playwright/test";

import { parseOwnerSpec } from "./file-owner";

/**
 * The `transport.fileOwner` rule, tested where it lives.
 *
 * It is enforced twice — once by the sites loader, so a typo fails where it was written, and again
 * by the ownership layer before a privileged command is composed. Pinning it here is what makes
 * those two enforcement points provably the same rule rather than two that happen to agree.
 */

/** The parser with a fixed context, so each case reads as the value under test alone. */
const spec = (declared: string) => parseOwnerSpec(declared, "[test] fileOwner");

test.describe("parseOwnerSpec", () => {
  test("never quotes a refused value: it comes from the sites file", () => {
    expect(() => spec("Hunter2Secret")).toThrow(
      /^\[test\] fileOwner must be .* got a text of 13 characters \(never quoted/,
    );
    expect(() => spec("Hunter2Secret")).not.toThrow(/Hunter2/);
  });

  test("accepts a user:group pair", () => {
    expect(spec("www-data:www-data")).toEqual({
      user: "www-data",
      group: "www-data",
    });
    expect(spec("  sftp_backwpup:www-data  ")).toEqual({
      user: "sftp_backwpup",
      group: "www-data",
    });
  });

  test("accepts numeric ids, which chown takes as readily as names", () => {
    expect(spec("33:33")).toEqual({ user: "33", group: "33" });
  });

  // The group is what lets the web server write when the docroot's owner is a deployment account,
  // so leaving it implicit is the failure this rejects.
  test("rejects a bare user", () => {
    expect(() => spec("www-data")).toThrow(/must be "user:group"/);
  });

  test("rejects empty halves, extra segments and whitespace", () => {
    for (const bad of [
      "",
      ":",
      ":www-data",
      "www-data:",
      "a:b:c",
      "www data:www-data",
      "www-data: www-data",
      // A value chown would read as one of its own options. Measured: without the `--` the command
      // also passes, `chown -Rh --reference=/etc/hostname <path>` took ownership from that file.
      "--reference=/etc/hostname:x",
      "-R:www-data",
      "www-data:-R",
    ]) {
      expect(() => spec(bad), bad).toThrow(/must be "user:group"/);
    }
  });
});
