import { test, expect } from "@playwright/test";

import { runSlowlyRead } from "./__fixtures__/slow-reader";
import {
  DRAIN_POLL_MS,
  drainTerminal,
  stdoutTerminal,
  unblockTerminal,
} from "./terminal";

/** This module, as a child imports it. */
const TERMINAL_MODULE = new URL("./terminal.ts", import.meta.url).href;

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

test.describe("drainTerminal", () => {
  test("settles at once, taken, when nothing waits, or the stream is destroyed", async () => {
    expect(await drainTerminal({ writableLength: 0 }, 1_000)).toBe(true);
    expect(
      await drainTerminal({ writableLength: 10, destroyed: true }, 1_000),
    ).toBe(true);
  });

  test("waits until the terminal has taken what waits for it", async () => {
    let backlog = 4096;
    setTimeout(() => (backlog = 0), 60);
    const started = performance.now();
    expect(
      await drainTerminal(
        {
          get writableLength() {
            return backlog;
          },
        },
        5_000,
      ),
    ).toBe(true);
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(55);
    expect(waited).toBeLessThan(60 + 20 * DRAIN_POLL_MS);
  });

  test("gives up on a stalled terminal after its wait, untaken", async () => {
    const started = performance.now();
    expect(await drainTerminal({ writableLength: 1 }, 50)).toBe(false);
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(49);
    expect(waited).toBeLessThan(1_000);
  });

  test("never rejects, even when the stream's getter throws", async () => {
    const throwing = {
      get writableLength(): number {
        throw new Error("EBADF");
      },
    };
    await expect(drainTerminal(throwing, 50)).resolves.toBe(true);
  });

  test("refuses a wait that is not a whole number of milliseconds a timer takes", () => {
    for (const wait of [-1, 1.5, Number.NaN, Infinity, 2 ** 31])
      expect(
        () => drainTerminal({ writableLength: 0 }, wait),
        String(wait),
      ).toThrow(RangeError);
  });

  /** A child writing 1 MiB in lines to its standard output, then exiting `0`; `drain` waits first. */
  function burst(drain: string): string {
    return `
      import { drainTerminal } from ${JSON.stringify(TERMINAL_MODULE)};
      let text = "";
      for (let i = 0; i < 8192; i++) text += "line " + String(i).padStart(5, "0") + " " + "y".repeat(116) + "\\n";
      process.stdout.write(text);
      ${drain}
      process.exit(0);
    `;
  }

  test("keeps what a process writes just before process.exit, when the reader is slower", async () => {
    // Without it, the exit cuts what the non-blocking stream still queued: the control shows the loss.
    const cut = await runSlowlyRead(burst(""), 300);
    expect(cut.code).toBe(0);
    expect(cut.stdout.length).toBeLessThan(1024 * 1024);
    const kept = await runSlowlyRead(
      burst("await drainTerminal(process.stdout, 15000);"),
      300,
    );
    expect(kept.code).toBe(0);
    expect(kept.stdout.length).toBe(1024 * 1024);
  });

  test("cannot hold a process past its wait when nobody reads", async () => {
    const result = await runSlowlyRead(
      burst(
        "const taken = await drainTerminal(process.stdout, 300); process.stderr.write(String(taken));",
      ),
      undefined,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("false");
    expect(result.ranMs).toBeLessThan(10_000);
  });
});
