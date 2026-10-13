import { test, expect } from "@playwright/test";

import { formatRunId, isUsableRunId, parseRunId } from "./run-id";

/**
 * The RUN_ID's one formatter and its strict parser: the report pruning dates a run by its folder's
 * name, so a name that does not round-trip must read as undated, never as some other date.
 */

const START = new Date("2026-06-19T14:03:22.123Z");

test.describe("formatRunId", () => {
  test("is the ISO time with : and . turned to -, then the suffix", () => {
    expect(formatRunId(START, "48217")).toBe("2026-06-19T14-03-22-123Z-48217");
    expect(formatRunId(START, "orch.run_7-b")).toBe(
      "2026-06-19T14-03-22-123Z-orch.run_7-b",
    );
  });

  test("refuses a suffix that could not round-trip, an invalid date or a year past 9999", () => {
    for (const suffix of ["", "a/b", "a b", "ü", "x\n"]) {
      expect(() => formatRunId(START, suffix), suffix).toThrow(RangeError);
    }
    expect(() => formatRunId(new Date(Number.NaN), "1")).toThrow(RangeError);
    expect(() => formatRunId(new Date(Date.UTC(10000, 0, 1)), "1")).toThrow(
      /four-digit year/,
    );
  });

  test("refuses a year it could not read back: below 0100, as Date.UTC reads 0050 as 1950", () => {
    const year50 = new Date(Date.UTC(2000, 0, 1));
    year50.setUTCFullYear(50);
    expect(() => formatRunId(year50, "1")).toThrow(RangeError);
    const year100 = new Date(Date.UTC(2000, 0, 1));
    year100.setUTCFullYear(100);
    expect(parseRunId(formatRunId(year100, "1"))?.time).toBe(year100.getTime());
  });

  test("sorts lexically in time order", () => {
    const earlier = formatRunId(new Date("2026-06-19T09:59:59.999Z"), "9");
    const later = formatRunId(new Date("2026-06-19T10:00:00.000Z"), "1");
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

test.describe("parseRunId", () => {
  test("reads today's stamps: the time and the process id", () => {
    expect(parseRunId("2026-06-19T14-03-22-123Z-48217")).toEqual({
      time: START.getTime(),
      suffix: "48217",
    });
    expect(parseRunId("2026-10-12T19-50-17-875Z-7958")?.time).toBe(
      Date.parse("2026-10-12T19:50:17.875Z"),
    );
  });

  test("reads an orchestrator's run id as the suffix, dashes and dots included", () => {
    expect(
      parseRunId("2026-06-19T14-03-22-123Z-01J9ZQ-task.42_run-7")?.suffix,
    ).toBe("01J9ZQ-task.42_run-7");
  });

  test("round-trips whatever formatRunId makes", () => {
    for (const iso of [
      "1970-01-01T00:00:00.000Z",
      "2024-02-29T23:59:59.999Z",
      "2026-12-31T00:00:00.001Z",
      "9999-12-31T23:59:59.999Z",
    ]) {
      const date = new Date(iso);
      const id = formatRunId(date, "1");
      expect(parseRunId(id), iso).toEqual({
        time: date.getTime(),
        suffix: "1",
      });
    }
  });

  test("rejects impossible dates rather than rolling them over", () => {
    for (const id of [
      "2026-02-30T00-00-00-000Z-1", // would roll to March 2
      "2025-02-29T00-00-00-000Z-1", // not a leap year
      "2026-13-01T00-00-00-000Z-1",
      "2026-00-10T00-00-00-000Z-1",
      "2026-04-31T00-00-00-000Z-1",
      "2026-06-19T24-00-00-000Z-1",
      "2026-06-19T23-60-00-000Z-1",
      "2026-06-19T23-59-60-000Z-1",
      "0050-06-19T00-00-00-000Z-1", // Date.UTC reads year 50 as 1950
      "9999-13-01T00-00-00-000Z-1", // would roll into the year 10000…
      "9999-12-31T24-00-00-000Z-1", // …which no formatter takes back: never a throw
    ]) {
      expect(parseRunId(id), id).toBeUndefined();
    }
  });

  test("rejects garbage and near misses", () => {
    for (const id of [
      "",
      "run-1",
      "nightly",
      "2026-06-19T14-03-22-123Z", // no suffix
      "2026-06-19T14-03-22-123Z-", // an empty suffix
      "2026-06-19T14:03:22.123Z-1", // not the folder form
      "2026-06-19T14-03-22-12Z-1", // two-digit milliseconds
      "2026-06-19T14-03-22-123-1", // no Z
      "2026-06-19t14-03-22-123Z-1",
      " 2026-06-19T14-03-22-123Z-1",
      "2026-06-19T14-03-22-123Z-1/..",
      "+012026-06-19T14-03-22-123Z-1",
    ]) {
      expect(parseRunId(id), JSON.stringify(id)).toBeUndefined();
    }
  });
});

test.describe("isUsableRunId", () => {
  test("takes a stamp, an orchestrator's id and a free-form single name", () => {
    for (const id of [
      "2026-06-19T14-03-22-123Z-48217",
      "run-1",
      "nightly 42",
    ]) {
      expect(isUsableRunId(id), id).toBe(true);
    }
  });

  test("refuses what would leave the cell's folder, hide it, or break a folder name", () => {
    for (const id of [
      "",
      ".",
      "..",
      "../x",
      "a/b",
      "a\\b",
      ".pruning-1-2-abcdef12",
      ".hidden",
      "a\u0000b",
      "a\nb",
      "a\u0085b", // C1: a control character, too
      "x".repeat(256),
      "é".repeat(128), // 256 bytes
    ]) {
      expect(isUsableRunId(id), JSON.stringify(id)).toBe(false);
    }
    expect(isUsableRunId("x".repeat(255))).toBe(true);
  });
});
