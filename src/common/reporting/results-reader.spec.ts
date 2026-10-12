import { test, expect } from "@playwright/test";

import { parseResults } from "./results-reader";

/**
 * Reading a stream that is still being written: complete lines only, what is not a version 1 event
 * skipped and counted, the half-written tail handed back.
 */

const BEGIN =
  '{"v":1,"type":"run.begin","at":"2026-10-12T00:00:00.000Z","runId":"r","product":"demo","mode":"test","scenarios":1,"setups":2,"retries":0,"workers":1}';
const END =
  '{"v":1,"type":"run.end","at":"2026-10-12T00:00:01.000Z","status":"passed","durationMs":1}';

test.describe("parseResults", () => {
  test("reads complete lines and hands back a partial last one", () => {
    const partial = END.slice(0, 20);
    const first = parseResults(`${BEGIN}\n${partial}`);
    expect(first.events.map((e) => e.type)).toEqual(["run.begin"]);
    expect(first.rest).toBe(partial);
    expect(first.skipped).toBe(0);

    const second = parseResults(`${first.rest}${END.slice(20)}\n`);
    expect(second.events.map((e) => e.type)).toEqual(["run.end"]);
    expect(second.rest).toBe("");
  });

  test("text with no newline yet is all rest", () => {
    expect(parseResults(BEGIN)).toEqual({
      events: [],
      skipped: 0,
      rest: BEGIN,
    });
    expect(parseResults("")).toEqual({ events: [], skipped: 0, rest: "" });
  });

  test("skips a bad line, another version, an unknown type, a line missing its stamp; ignores blank lines", () => {
    const lines = [
      "not json",
      '{"v":2,"type":"run.begin","at":"x"}',
      '{"v":1,"type":"run.paused","at":"x"}',
      '{"v":1,"type":"run.end"}',
      "[1,2]",
      "",
      "   ",
      END,
    ];
    const { events, skipped } = parseResults(`${lines.join("\n")}\n`);
    expect(events.map((e) => e.type)).toEqual(["run.end"]);
    expect(skipped).toBe(5);
  });

  test("keeps the fields of a known type it does not know about", () => {
    const line = END.replace(
      '"durationMs":1',
      '"durationMs":1,"later":"field"',
    );
    const [event] = parseResults(`${line}\n`).events;
    expect(event).toMatchObject({ type: "run.end", later: "field" });
  });
});
