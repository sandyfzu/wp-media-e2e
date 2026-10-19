import { test, expect } from "@playwright/test";

import { createEventBus } from "./bus";

/** Two event types, so subscribers can choose. */
type TestEvent =
  { readonly type: "a"; readonly n: number } | { readonly type: "b" };

/** A bus with a short time limit, its log lines collected. */
function bus(timeoutMs = 50) {
  const lines: string[] = [];
  const created = createEventBus<TestEvent>({
    timeoutMs,
    log: (line) => lines.push(line),
  });
  return { bus: created, lines };
}

test.describe("createEventBus", () => {
  test("hands an event to every subscriber of its type, and to no other", async () => {
    const { bus: events } = bus();
    const seen: string[] = [];
    events.on(
      "a",
      (event) => {
        seen.push(`one:${String(event.n)}`);
      },
      "one",
    );
    events.on(
      "a",
      (event) => {
        seen.push(`two:${String(event.n)}`);
      },
      "two",
    );
    events.on(
      "b",
      () => {
        seen.push("b");
      },
      "three",
    );
    events.publish({ type: "a", n: 1 });
    await events.settle();
    expect(seen.sort()).toEqual(["one:1", "two:1"]);
  });

  test("publish returns before any handler has started, and settle waits for them to end", async () => {
    const { bus: events } = bus(1000);
    let started = false;
    let done = false;
    events.on(
      "a",
      async () => {
        // Set before any await: true here would mean the handler ran inside publish.
        started = true;
        await new Promise((r) => setTimeout(r, 20));
        done = true;
      },
      "slow",
    );
    events.publish({ type: "a", n: 1 });
    expect(started).toBe(false);
    await events.settle();
    expect(done).toBe(true);
  });

  test("a handler that publishes again never re-enters publish", async () => {
    const { bus: events } = bus(1000);
    let depth = 0;
    let deepest = 0;
    let delivered = 0;
    events.on(
      "a",
      (event) => {
        depth += 1;
        deepest = Math.max(deepest, depth);
        delivered += 1;
        // Synchronously, as a careless subscriber would.
        if (event.n < 2000) events.publish({ type: "a", n: event.n + 1 });
        depth -= 1;
      },
      "relay",
    );
    events.publish({ type: "a", n: 1 });
    await events.settle();
    expect(delivered).toBe(2000);
    expect(deepest).toBe(1);
  });

  test("runs handlers concurrently", async () => {
    const { bus: events } = bus(1000);
    const started: number[] = [];
    for (const name of ["x", "y"])
      events.on(
        "a",
        async () => {
          started.push(Date.now());
          await new Promise((r) => setTimeout(r, 100));
        },
        name,
      );
    const begin = Date.now();
    events.publish({ type: "a", n: 1 });
    await events.settle();
    expect(Date.now() - begin).toBeLessThan(190);
  });

  test("logs a handler that throws or rejects under its name, one line, and the others still run", async () => {
    const { bus: events, lines } = bus();
    let ran = false;
    events.on(
      "a",
      () => {
        throw new Error("sync\nboom");
      },
      "slack",
    );
    events.on("a", () => Promise.reject(new Error("refused: 500")), "datator");
    // A rejection that is not an Error is what this case is about.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    events.on("a", () => Promise.reject("plain"), "odd");
    events.on("a", () => Promise.reject(new Error("")), "empty");
    events.on(
      "a",
      () => {
        ran = true;
      },
      "ok",
    );
    events.publish({ type: "a", n: 1 });
    await events.settle();
    expect(ran).toBe(true);
    expect(lines.sort()).toEqual([
      "datator: a not delivered: refused: 500",
      "empty: a not delivered: failed",
      "odd: a not delivered: plain",
      "slack: a not delivered: sync boom",
    ]);
  });

  test("masks a credential a failure quotes, and cuts a long one", async () => {
    const { bus: events, lines } = bus();
    events.on(
      "a",
      () => Promise.reject(new Error("GET https://u:p4ssw0rd@x.test failed")),
      "leaky",
    );
    events.on("a", () => Promise.reject(new Error("x".repeat(2000))), "long");
    events.publish({ type: "a", n: 1 });
    await events.settle();
    expect(lines).toContain(
      "leaky: a not delivered: GET https://***@x.test failed",
    );
    expect(lines.find((line) => line.startsWith("long:"))?.endsWith("…")).toBe(
      true,
    );
  });

  test("never crashes nor rejects when the log itself throws", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const events = createEventBus<TestEvent>({
        timeoutMs: 1000,
        log: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      });
      events.on("a", () => Promise.reject(new Error("refused")), "slack");
      events.publish({ type: "a", n: 1 });
      await expect(events.settle()).resolves.toBeUndefined();
      // Unhandled rejections are reported after a macrotask turn.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("says what was thrown even when it cannot be printed, or its message is not text", async () => {
    const { bus: events, lines } = bus();
    const getterThrows = new Error("x");
    Object.defineProperty(getterThrows, "message", {
      get() {
        throw new Error("getter");
      },
    });
    const notText = new Error("x");
    (notText as { message: unknown }).message = { code: 1 };
    events.on(
      "a",
      () => Promise.reject(Object.create(null) as Error),
      "noproto",
    );
    events.on("a", () => Promise.reject(getterThrows), "getter");
    events.on("a", () => Promise.reject(notText), "nottext");
    events.publish({ type: "a", n: 1 });
    await expect(events.settle()).resolves.toBeUndefined();
    expect(lines.sort()).toEqual([
      "getter: a not delivered: failed",
      "noproto: a not delivered: failed",
      "nottext: a not delivered: [object Object]",
    ]);
  });

  test("masks the secret values it is given, and every line is one line", async () => {
    const lines: string[] = [];
    const webhook = "https://hooks.slack.com/services/T0/B0/XXXXXXXXXXXX";
    const events = createEventBus<TestEvent>({
      timeoutMs: 1000,
      log: (line) => lines.push(line),
      secrets: [webhook],
    });
    events.on(
      "a",
      () => Promise.reject(new Error(`POST ${webhook} failed\nsecond line`)),
      "slack\nforged",
    );
    events.publish({ type: "a", n: 1 });
    await events.settle();
    expect(lines).toEqual([
      "slack forged: a not delivered: POST *** failed second line",
    ]);
  });

  test("abandons a handler past its time limit, aborts its signal and logs it", async () => {
    const { bus: events, lines } = bus(30);
    let aborted = false;
    events.on(
      "a",
      (_event, signal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      "hangs",
    );
    const begin = Date.now();
    events.publish({ type: "a", n: 1 });
    await events.settle();
    expect(Date.now() - begin).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(lines).toEqual(["hangs: a not delivered: timed out after 30 ms"]);
  });

  test("never aborts a handler that finished in time", async () => {
    const { bus: events, lines } = bus(30);
    let signalSeen: AbortSignal | undefined;
    events.on(
      "a",
      (_event, signal) => {
        signalSeen = signal;
      },
      "quick",
    );
    events.publish({ type: "a", n: 1 });
    await events.settle();
    await new Promise((r) => setTimeout(r, 60));
    expect(signalSeen?.aborted).toBe(false);
    expect(lines).toEqual([]);
  });

  test("settle waits for an event a handler publishes meanwhile, and resolves at once when idle", async () => {
    const { bus: events } = bus(1000);
    const seen: string[] = [];
    events.on(
      "a",
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        events.publish({ type: "b" });
      },
      "relay",
    );
    events.on(
      "b",
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push("b");
      },
      "last",
    );
    await events.settle();
    events.publish({ type: "a", n: 1 });
    await events.settle();
    expect(seen).toEqual(["b"]);
  });

  test("an event nobody subscribes to is dropped quietly", async () => {
    const { bus: events, lines } = bus();
    events.publish({ type: "b" });
    await events.settle();
    expect(lines).toEqual([]);
  });

  test("refuses a time limit that is not a positive whole number of milliseconds", () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Infinity])
      expect(
        () => createEventBus({ timeoutMs, log: () => undefined }),
        String(timeoutMs),
      ).toThrow(RangeError);
  });
});
