import { test, expect } from "@playwright/test";

import {
  formatOwner,
  isWritableOwner,
  MAX_OWNER_BYTES,
  MAX_PID,
  MAX_RUN_PATH,
  parseOwner,
  type LockOwner,
} from "./lock-owner";

const OWNER: LockOwner = {
  pid: 123,
  token: "0123456789abcdef0123456789abcdef",
  start: "linux:f6fb3842-61ea-4a8e-8577-4be12500a66e:4242",
  space: {
    platform: "linux",
    host: "box",
    boot: "f6fb3842-61ea-4a8e-8577-4be12500a66e",
    pidns: "pid:[4026532829]",
    machine: null,
  },
};

/**
 * `OWNER`'s record with `changes` applied, as text.
 *
 * @param changes - fields replaced, or removed when `undefined`.
 */
function recordWith(changes: Record<string, unknown>): string {
  const record = JSON.parse(formatOwner(OWNER)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes))
    if (value === undefined) Reflect.deleteProperty(record, key);
    else record[key] = value;
  return `${JSON.stringify(record)}\n`;
}

test.describe("formatOwner / parseOwner", () => {
  test("round-trips an owner as one line of JSON", () => {
    const text = formatOwner(OWNER);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf("\n")).toBe(text.length - 1);
    expect(parseOwner(text)).toEqual({ kind: "owner", owner: OWNER });
  });

  test("round-trips unknown parts as null", () => {
    const owner: LockOwner = {
      ...OWNER,
      start: null,
      space: {
        platform: "darwin",
        host: null,
        boot: null,
        pidns: null,
        machine: null,
      },
    };
    expect(parseOwner(formatOwner(owner))).toEqual({ kind: "owner", owner });
  });

  test("tells the first orchestrators' lock apart, with its PID", () => {
    expect(parseOwner(`77\n${OWNER.token}\n`)).toEqual({
      kind: "legacy",
      pid: 77,
    });
  });

  for (const [why, text] of [
    ["empty", ""],
    ["garbage", "not a lock"],
    ["no trailing newline", formatOwner(OWNER).trimEnd()],
    ["two lines", `${formatOwner(OWNER)}${formatOwner(OWNER)}`],
    ["another version", recordWith({ v: 3 })],
    ["a PID of 0", recordWith({ pid: 0 })],
    ["a PID past 2^31 - 1", recordWith({ pid: MAX_PID + 1 })],
    ["a fractional PID", recordWith({ pid: 1.5 })],
    ["an uppercase token", recordWith({ token: OWNER.token.toUpperCase() })],
    ["no start", recordWith({ start: undefined })],
    ["a start with a newline", recordWith({ start: "a\nb" })],
    ["a host with a control character", recordWith({ host: "a\u001bb" })],
    ["a malformed boot id", recordWith({ boot: "x" })],
    ["a namespace of another kind", recordWith({ pidns: "net:[1]" })],
    ["a malformed machine id", recordWith({ machine: "x" })],
    ["an unknown key", recordWith({ extra: 1 })],
  ] as const)
    test(`refuses ${why}`, () => {
      expect(parseOwner(text)).toEqual({ kind: "invalid" });
    });

  test("takes the largest PID process.kill accepts", () => {
    expect(parseOwner(recordWith({ pid: MAX_PID }))).toMatchObject({
      kind: "owner",
      owner: { pid: MAX_PID },
    });
  });
});

test.describe("formatOwner / parseOwner — a cell's lock's run", () => {
  test("round-trips the run's record, and writes no run for an owner without one", () => {
    const owner: LockOwner = { ...OWNER, run: "/s/runs/bpng-3/run.json" };
    expect(parseOwner(formatOwner(owner))).toEqual({ kind: "owner", owner });
    expect(formatOwner(OWNER)).not.toContain('"run"');
  });

  test("refuses a run that is relative, holds a control character, or is past its length", () => {
    for (const run of [
      "runs/bpng-3/run.json",
      "/s/runs/bpng-3\n/run.json",
      "/s/\u001b[31m/run.json",
      `/${"a".repeat(4096)}`,
      "",
      7,
    ])
      expect(parseOwner(recordWith({ run }))).toEqual({ kind: "invalid" });
    expect(isWritableOwner({ ...OWNER, run: "relative/run.json" })).toBe(false);
  });

  test("refuses an owner whose text would pass the lock's byte cap, so no unreadable lock is written", () => {
    // 4,000 UTF-16 units — within MAX_RUN_PATH — but two bytes each in UTF-8.
    const run = `/${"é".repeat(4000)}/run.json`;
    expect(run.length).toBeLessThanOrEqual(MAX_RUN_PATH);
    expect(Buffer.byteLength(formatOwner({ ...OWNER, run }))).toBeGreaterThan(
      MAX_OWNER_BYTES,
    );
    expect(isWritableOwner({ ...OWNER, run })).toBe(false);
    const fits = `/${"a".repeat(4000)}/run.json`;
    expect(isWritableOwner({ ...OWNER, run: fits })).toBe(true);
  });

  test("round-trips a site's key, and refuses one with a control character or past its length", () => {
    const owner: LockOwner = { ...OWNER, key: "a.qa.test:8100/wp" };
    expect(parseOwner(formatOwner(owner))).toEqual({ kind: "owner", owner });
    expect(isWritableOwner({ ...OWNER, key: "a\u0007b" })).toBe(false);
    expect(isWritableOwner({ ...OWNER, key: "k".repeat(2049) })).toBe(false);
    expect(formatOwner(OWNER)).not.toContain('"key"');
  });

  test("round-trips a label, and refuses one with a control character", () => {
    const owner: LockOwner = { ...OWNER, label: "backwpup pro@nginx" };
    expect(parseOwner(formatOwner(owner))).toEqual({ kind: "owner", owner });
    expect(isWritableOwner({ ...OWNER, label: "a\nb" })).toBe(false);
  });
});

test.describe("isWritableOwner", () => {
  test("is an owner parseOwner reads back, and not one it refuses", () => {
    expect(isWritableOwner(OWNER)).toBe(true);
    expect(isWritableOwner({ ...OWNER, token: "short" })).toBe(false);
    expect(
      isWritableOwner({ ...OWNER, space: { ...OWNER.space, host: "a\nb" } }),
    ).toBe(false);
  });
});
