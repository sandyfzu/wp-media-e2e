import { test, expect } from "@playwright/test";

import { stdoutTerminal, unblockTerminal } from "./terminal";

/**
 * A stream stand-in with Node's internal handle.
 *
 * @param isTTY - whether it is a terminal.
 * @param setBlocking - the handle's `setBlocking`, or anything in its place.
 */
function stream(isTTY: boolean | undefined, setBlocking: unknown) {
  const calls: unknown[][] = [];
  const handle = {
    setBlocking:
      typeof setBlocking === "function"
        ? (...args: unknown[]) => {
            calls.push(args);
            return (setBlocking as (...a: unknown[]) => unknown)(...args);
          }
        : setBlocking,
  };
  return { stream: { isTTY, _handle: handle }, calls };
}

test.describe("unblockTerminal", () => {
  test("makes a terminal's handle non-blocking", () => {
    const { stream: tty, calls } = stream(true, () => 0);
    expect(unblockTerminal(tty)).toBe(true);
    expect(calls).toEqual([[false]]);
  });

  test("leaves a stream that is not a terminal alone", () => {
    for (const isTTY of [false, undefined]) {
      const { stream: pipe, calls } = stream(isTTY, () => 0);
      expect(unblockTerminal(pipe)).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test("changes nothing when Node offers no such handle, and never throws", () => {
    expect(unblockTerminal({ isTTY: true })).toBe(false);
    expect(
      unblockTerminal(Object.assign({ isTTY: true }, { _handle: null })),
    ).toBe(false);
    expect(unblockTerminal(stream(true, "not a function").stream)).toBe(false);
    expect(
      unblockTerminal(
        stream(true, () => {
          throw new Error("EBADF");
        }).stream,
      ),
    ).toBe(false);
  });

  test("says so when the handle refuses", () => {
    expect(unblockTerminal(stream(true, () => -22).stream)).toBe(false);
  });
});

test.describe("stdoutTerminal", () => {
  test("is standard output by default", () => {
    expect(stdoutTerminal()).toBe(process.stdout);
  });

  test("makes a terminal non-blocking on first use, and only then", () => {
    const { stream: tty, calls } = stream(true, () => 0);
    const terminal = Object.assign(tty, {
      write: () => true,
      on: () => undefined,
      writableLength: 0,
    });
    expect(stdoutTerminal(terminal)).toBe(terminal);
    expect(stdoutTerminal(terminal)).toBe(terminal);
    expect(calls).toEqual([[false]]);
  });
});
