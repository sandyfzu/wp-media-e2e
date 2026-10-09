import { test, expect } from "@playwright/test";

import { fullCommit, pinOf, requirePin } from "./pin";
import type { BuiltRef, Pin, PinRefusal } from "./pin";

/**
 * Unit tests for pinning a build: which `commit` values count as a full SHA, and the pin a later
 * run is given — a commit with its built version, a release tag, or a refusal when neither is safe.
 */

/** A real-shaped full SHA (the `develop` head measured on a cold BackWPup build). */
const SHA = "f1ebfd05c0ffee00112233445566778899aabbcc";

/** A release download as APVM reports it: `commit` is a label, `source.value` the resolved tag. */
function release(value: string, commit = `release-${value}`): BuiltRef {
  return { commit, source: { type: "release", value }, version: "5.7.6" };
}

/** The refusal's reason, or `undefined` when `pin` is a pin. */
function refusalOf(pin: Pin | PinRefusal): string | undefined {
  return "refused" in pin ? pin.refused : undefined;
}

test.describe("fullCommit", () => {
  test("keeps a 40-character lowercase hex SHA", () => {
    expect(fullCommit(SHA)).toBe(SHA);
  });

  for (const [label, value] of [
    ["a release label", "release-5.7.6"],
    ["a short SHA", "f1ebfd0"],
    ["an uppercase SHA", SHA.toUpperCase()],
    ["a 41-character value", `${SHA}a`],
    ["a SHA with surrounding whitespace", ` ${SHA}`],
    ["a SHA-256 object id", "a".repeat(64)],
    ["an empty string", ""],
  ] as const) {
    test(`drops ${label}`, () => {
      expect(fullCommit(value)).toBeUndefined();
    });
  }
});

test.describe("pinOf", () => {
  test("pins a git build to its full commit and the version built, whatever ref it came from", () => {
    for (const type of ["branch", "pull_request", "tag", "commit"]) {
      expect(
        pinOf({
          commit: SHA,
          source: { type, value: "x" },
          version: "3.23.5.1",
        }),
      ).toEqual({ ref: `commit:${SHA}`, version: "3.23.5.1" });
    }
  });

  test("pins a release download to its resolved tag, with no version", () => {
    expect(pinOf(release("5.7.6"))).toEqual({ ref: "release:5.7.6" });
  });

  test("keeps a release tag as git names it", () => {
    for (const tag of ["v5.7.6", "5.7.6-beta1", "rel/5.7"]) {
      expect(pinOf(release(tag))).toEqual({ ref: `release:${tag}` });
    }
  });

  test("pins a release to its tag even when APVM reports a full commit for it", () => {
    // A commit pin would build the source, not download the released zip this run tested.
    expect(pinOf(release("5.7.6", SHA))).toEqual({ ref: "release:5.7.6" });
  });

  for (const selector of [
    "latest-stable",
    "previous-stable",
    "latest",
    "previous-latest",
    "LATEST-STABLE",
    "Latest",
  ]) {
    test(`refuses a release still named by the selector "${selector}"`, () => {
      // APVM matches its selectors ignoring case, so a case variant would move too. The full
      // commit beside it must not rescue it either.
      expect(refusalOf(pinOf(release(selector, SHA)))).toMatch(
        /cannot pin this release download/,
      );
    });
  }

  for (const [label, value] of [
    ["empty", ""],
    ["with whitespace", "5.7.6 beta"],
    ["with a colon", "release:5.7.6"],
  ] as const) {
    test(`refuses a release tag that is ${label}`, () => {
      expect(refusalOf(pinOf(release(value)))).toMatch(
        /cannot pin this release download/,
      );
    });
  }

  test("refuses a git build without a full commit, naming what it got", () => {
    const pin = pinOf({
      commit: "f1ebfd0",
      source: { type: "branch", value: "develop" },
      version: "9.99.99",
    });
    expect(refusalOf(pin)).toMatch(
      /cannot pin this build.*"f1ebfd0".*branch "develop"/,
    );
  });
});

test.describe("requirePin", () => {
  test("returns the pin when there is one", () => {
    expect(requirePin(release("5.7.6"))).toEqual({ ref: "release:5.7.6" });
  });

  test("throws the refusal, so a caller can never proceed unpinned", () => {
    expect(() => requirePin(release("latest-stable"))).toThrow(
      /^\[artifacts\] cannot pin this release download: "latest-stable"/,
    );
  });
});
