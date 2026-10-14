import type { ServerResponse } from "node:http";

import { test, expect } from "@playwright/test";

import {
  reply,
  startSink,
  type HttpSink,
  type SunkRequest,
} from "../__fixtures__/http-sink";
import { finishedEvent } from "../__fixtures__/run-finished";
import { createEventBus, type EventBus } from "../events/bus";
import type { RunFinishedEvent } from "../events/run-finished";
import type { RunStatus } from "../runs/outcome";
import {
  notificationLine,
  NOTIFICATIONS_SUBSCRIBER,
  subscribeNotifications,
  type NotificationConfig,
  type NotificationOptions,
} from "./subscribe";

/** The webhook's token: the last segment of its path, the credential. */
const TOKEN = "whsecret0123456789abcdef";

/** Datator's key. */
const API_KEY = "datator-key-0123456789";

/** A secret a run receives, which an answer might quote. */
const GITHUB_TOKEN = "ghp_0123456789abcdefABCDEF0123456789abcd";

/** The webhook's path on the sink. */
const WEBHOOK_PATH = `/services/T0AAAAAAA/B0BBBBBBB/${TOKEN}`;

/** Datator's path on the sink. */
const DATATOR_PATH = "/e2e_tests/results/";

/** An answer for each request, chosen by the sender it came from. */
type Answer = (request: SunkRequest, response: ServerResponse) => void;

/** An answer that never comes: the request hangs until the sink closes. */
const never: Answer = () => undefined;

/**
 * Answers Slack's and Datator's requests each its own way.
 *
 * @param slack - Slack's answer.
 * @param datator - Datator's answer.
 */
function route(slack: Answer, datator: Answer): Answer {
  return (request, response) => {
    (request.path === WEBHOOK_PATH ? slack : datator)(request, response);
  };
}

/**
 * An answer given after a delay.
 *
 * @param ms - the delay.
 * @param answer - the answer.
 */
function later(ms: number, answer: Answer): Answer {
  return (request, response) => {
    setTimeout(() => {
      answer(request, response);
    }, ms);
  };
}

/**
 * A config with the senders asked for, pointing at the sink.
 *
 * @param base - the sink's URL.
 * @param senders - which are configured.
 * @param secrets - the runs' secrets beside {@link GITHUB_TOKEN}.
 */
function configFor(
  base: string,
  senders: { slack?: boolean; datator?: boolean },
  secrets: Readonly<Record<string, string>> = {},
): NotificationConfig {
  return {
    instance: "AutoE2E nginx",
    secrets: { GITHUB_TOKEN, ...secrets },
    reports: { sshHost: "auto-e2e" },
    notifications: {
      ...(senders.slack === true
        ? { slack: { webhookUrl: `${base}${WEBHOOK_PATH}` } }
        : {}),
      ...(senders.datator === true
        ? { datator: { url: `${base}${DATATOR_PATH}`, apiKey: API_KEY } }
        : {}),
    },
  };
}

/** A subscribed bus, its lines, and what the bus itself logged. */
interface Harness {
  readonly bus: EventBus<RunFinishedEvent>;
  readonly notifications: ReturnType<typeof subscribeNotifications>;
  /** The logger's lines, `<scope>  <text>`. */
  readonly lines: string[];
  /** The bus's own failure lines. */
  readonly busLines: string[];
}

/**
 * Subscribes the senders a config names to a real bus.
 *
 * @param config - the config.
 * @param options - the senders' options; the bus's time limit as `busTimeoutMs`.
 */
function harness(
  config: NotificationConfig,
  options: NotificationOptions & { busTimeoutMs?: number } = {},
): Harness {
  const lines: string[] = [];
  const busLines: string[] = [];
  const bus = createEventBus<RunFinishedEvent>({
    timeoutMs: options.busTimeoutMs ?? 10_000,
    log: (line) => busLines.push(line),
  });
  const notifications = subscribeNotifications(
    bus,
    config,
    { line: (scope, text) => lines.push(`${scope}  ${text}`) },
    options,
  );
  return { bus, notifications, lines, busLines };
}

/**
 * Starts a sink, runs `body` with it, and closes it whatever happens.
 *
 * @param answer - the sink's answer.
 * @param body - the test.
 */
async function withSink(
  answer: Answer,
  body: (sink: HttpSink) => Promise<void>,
): Promise<void> {
  const sink = await startSink(answer);
  try {
    await body(sink);
  } finally {
    await sink.close();
  }
}

/**
 * Publishes an event and waits for its delivery.
 *
 * @param h - the harness.
 * @param event - the event.
 */
async function deliver(h: Harness, event: RunFinishedEvent): Promise<void> {
  h.bus.publish(event);
  await h.bus.settle();
}

/** The requests a sink got on one path. */
function requestsTo(sink: HttpSink, path: string): SunkRequest[] {
  return sink.requests.filter((request) => request.path === path);
}

test.describe("subscribeNotifications", () => {
  test("Slack alone: one message, one line, and no Datator record", async () => {
    await withSink(reply(200, "ok"), async (sink) => {
      const h = harness(configFor(sink.url, { slack: true }));
      const event = finishedEvent();
      await deliver(h, event);
      expect(h.notifications.senders).toEqual(["slack"]);
      expect(h.lines).toEqual(["bpng  slack ✓"]);
      expect(h.busLines).toEqual([]);
      const [request] = sink.requests;
      expect(sink.requests).toHaveLength(1);
      expect(request?.path).toBe(WEBHOOK_PATH);
      const body = JSON.parse(request?.body ?? "") as { text: string };
      // The config's instance and scp host reach the message.
      expect(body.text).toMatch(/^\*\[AutoE2E nginx\]\* ❌ FAILED/);
      expect(body.text).toContain("scp -r auto-e2e:");
      expect(h.notifications.datatorPayload(event)).toBeUndefined();
    });
  });

  test("Datator alone: the record posted is the one handed out for run.json", async () => {
    await withSink(reply(201, '{"id":1}'), async (sink) => {
      const h = harness(configFor(sink.url, { datator: true }));
      const event = finishedEvent();
      // Asked before the delivery, as a run records it before publishing.
      const kept = h.notifications.datatorPayload(event);
      await deliver(h, event);
      expect(h.notifications.senders).toEqual(["datator"]);
      expect(h.lines).toEqual(["bpng  datator ✓ 201"]);
      const [request] = sink.requests;
      expect(request?.path).toBe(DATATOR_PATH);
      expect(request?.headers["x-api-key"]).toBe(API_KEY);
      expect(kept).toBeDefined();
      expect(JSON.parse(request?.body ?? "")).toEqual(kept);
      // The very same object, every time it is asked for that event.
      expect(h.notifications.datatorPayload(event)).toBe(kept);
      expect(h.notifications.datatorPayload(finishedEvent())).not.toBe(kept);
    });
  });

  test("both: one line per run, under each run's task", async () => {
    await withSink(route(reply(200, "ok"), reply(201)), async (sink) => {
      const h = harness(configFor(sink.url, { slack: true, datator: true }));
      expect(h.notifications.senders).toEqual(["slack", "datator"]);
      await deliver(h, finishedEvent());
      const other = finishedEvent();
      await deliver(h, {
        ...other,
        run: { ...other.run, task: { ...other.run.task, id: "bpap" } },
      });
      expect(h.lines).toEqual([
        "bpng  slack ✓ · datator ✓ 201",
        "bpap  slack ✓ · datator ✓ 201",
      ]);
      expect(requestsTo(sink, WEBHOOK_PATH)).toHaveLength(2);
      expect(requestsTo(sink, DATATOR_PATH)).toHaveLength(2);
    });
  });

  test("the line names Slack first, whichever answers first", async () => {
    for (const [slack, datator] of [
      [later(150, reply(200, "ok")), reply(201)],
      [reply(200, "ok"), later(150, reply(201))],
    ] as const)
      await withSink(route(slack, datator), async (sink) => {
        const h = harness(configFor(sink.url, { slack: true, datator: true }));
        await deliver(h, finishedEvent());
        expect(h.lines).toEqual(["bpng  slack ✓ · datator ✓ 201"]);
      });
  });

  test("one failing: the other is still sent and told", async () => {
    await withSink(
      route(reply(404, "no_service"), reply(201)),
      async (sink) => {
        const h = harness(configFor(sink.url, { slack: true, datator: true }));
        await deliver(h, finishedEvent());
        expect(h.lines).toEqual([
          "bpng  slack ✗ 404 no_service · datator ✓ 201",
        ]);
        expect(h.busLines).toEqual([]);
      },
    );
    await withSink(
      route(
        reply(200, "ok"),
        reply(
          400,
          '{"test_duration_seconds":["A valid integer is required."]}',
        ),
      ),
      async (sink) => {
        const h = harness(configFor(sink.url, { slack: true, datator: true }));
        await deliver(h, finishedEvent());
        expect(h.lines).toEqual([
          'bpng  slack ✓ · datator ✗ 400 {"test_duration_seconds":["A valid integer is required."]}',
        ]);
      },
    );
  });

  test("both failing: an empty answer by its status, no server by its error code", async () => {
    // A sink closed before the run: nothing listens on its port.
    const closed = await startSink(reply(200, "ok"));
    await closed.close();
    const h = harness(configFor(closed.url, { slack: true, datator: true }));
    await deliver(h, finishedEvent());
    expect(h.lines).toEqual([
      "bpng  slack ✗ request failed: ECONNREFUSED · datator ✗ request failed: ECONNREFUSED",
    ]);
    await withSink(reply(500), async (sink) => {
      const both = harness(configFor(sink.url, { slack: true, datator: true }));
      await deliver(both, finishedEvent());
      expect(both.lines).toEqual([
        "bpng  slack ✗ HTTP 500 · datator ✗ HTTP 500",
      ]);
    });
  });

  test("a request with no answer ends at its own time limit", async () => {
    await withSink(never, async (sink) => {
      const h = harness(configFor(sink.url, { slack: true, datator: true }), {
        timeoutMs: 100,
      });
      await deliver(h, finishedEvent());
      expect(h.lines).toEqual([
        "bpng  slack ✗ no answer within 100 ms · datator ✗ no answer within 100 ms",
      ]);
      expect(h.busLines).toEqual([]);
    });
  });

  test("the bus's time limit cancels both requests through its signal", async () => {
    await withSink(never, async (sink) => {
      const h = harness(configFor(sink.url, { slack: true, datator: true }), {
        busTimeoutMs: 100,
      });
      const started = Date.now();
      await deliver(h, finishedEvent());
      expect(h.busLines).toEqual([
        `${NOTIFICATIONS_SUBSCRIBER}: run.finished not delivered: timed out after 100 ms`,
      ]);
      // The line follows the abort: the senders end as cancelled, not at their own 15 s.
      await expect
        .poll(() => h.lines)
        .toEqual(["bpng  slack ✗ cancelled · datator ✗ cancelled"]);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  test("nothing configured: nothing subscribed, nothing logged", () => {
    const subscribed: string[] = [];
    const lines: string[] = [];
    const notifications = subscribeNotifications(
      { on: (type) => subscribed.push(type) },
      { notifications: { datator: undefined } },
      { line: (_scope, text) => lines.push(text) },
    );
    expect(notifications.senders).toEqual([]);
    expect(subscribed).toEqual([]);
    expect(notifications.datatorPayload(finishedEvent())).toBeUndefined();
    const bare = subscribeNotifications(
      { on: (type) => subscribed.push(type) },
      {},
      { line: (_scope, text) => lines.push(text) },
    );
    expect(bare.senders).toEqual([]);
    expect(subscribed).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("an unconfigured sender is left out of the line and never sent", async () => {
    await withSink(reply(201), async (sink) => {
      const h = harness(configFor(sink.url, { datator: true }));
      await deliver(h, finishedEvent());
      expect(h.lines).toEqual(["bpng  datator ✓ 201"]);
      expect(requestsTo(sink, WEBHOOK_PATH)).toEqual([]);
    });
  });

  test("a run that did not test goes to Slack only; Datator says why not", async () => {
    for (const status of [
      "error",
      "stopped",
      "killed",
    ] as const satisfies readonly RunStatus[])
      await withSink(route(reply(200, "ok"), reply(201)), async (sink) => {
        const h = harness(configFor(sink.url, { slack: true, datator: true }));
        const event = finishedEvent({ status, reason: "the build failed" });
        await deliver(h, event);
        expect(h.lines).toEqual([
          `bpng  slack ✓ · datator not posted (${status})`,
        ]);
        expect(requestsTo(sink, DATATOR_PATH)).toEqual([]);
        expect(h.notifications.datatorPayload(event)).toBeUndefined();
      });
  });

  test("an answer quoting a secret never shows it", async () => {
    const slackEcho: Answer = reply(404, `no hook ${WEBHOOK_PATH}`);
    const datatorEcho: Answer = reply(
      403,
      `Invalid key ${API_KEY}; token ${GITHUB_TOKEN}`,
    );
    await withSink(route(slackEcho, datatorEcho), async (sink) => {
      const h = harness(configFor(sink.url, { slack: true, datator: true }));
      await deliver(h, finishedEvent());
      const [line] = h.lines;
      expect(h.lines).toHaveLength(1);
      for (const secret of [TOKEN, WEBHOOK_PATH, API_KEY, GITHUB_TOKEN])
        expect(line).not.toContain(secret);
      expect(line).toBe(
        "bpng  slack ✗ 404 no hook *** · datator ✗ 403 Invalid key ***; token ***",
      );
    });
  });

  test("an answer quoting a secret given beside the config's — a site's password — never shows it", async () => {
    const sitePassword = "site-Password-Of-No-Shape-4567";
    const echo: Answer = reply(403, `bad login ${sitePassword}`);
    await withSink(route(echo, echo), async (sink) => {
      const h = harness(configFor(sink.url, { slack: true, datator: true }), {
        secrets: [sitePassword],
      });
      await deliver(h, finishedEvent());
      expect(h.lines).toEqual([
        "bpng  slack ✗ 403 bad login *** · datator ✗ 403 bad login ***",
      ]);
    });
  });

  test("a sender that throws is told as its own failure, masked; the other still reports", async () => {
    await withSink(route(reply(200, "ok"), reply(201)), async (sink) => {
      const h = harness(configFor(sink.url, { slack: true, datator: true }));
      const event = finishedEvent();
      // Both formatters read the plugin: each throws, quoting a secret.
      Object.defineProperty(event, "plugin", {
        get(): never {
          throw new Error(`plugin unreadable\n${API_KEY}`);
        },
      });
      await deliver(h, event);
      expect(h.lines).toEqual([
        "bpng  slack ✗ not sent: plugin unreadable *** · datator ✗ not sent: plugin unreadable ***",
      ]);
      expect(h.busLines).toEqual([]);
      expect(sink.requests).toEqual([]);
    });
  });

  test("a thrown message that is not text, or is empty, still makes the line", async () => {
    await withSink(route(reply(200, "ok"), reply(201)), async (sink) => {
      for (const [message, said] of [
        [{ toString: () => `object ${API_KEY}` }, "object ***"],
        [42, "42"],
        ["", "failed"],
        [" \n ", "failed"],
      ] as const) {
        const h = harness(configFor(sink.url, { slack: true, datator: true }));
        const event = finishedEvent();
        Object.defineProperty(event, "plugin", {
          get(): never {
            const error = new Error("replaced");
            Object.defineProperty(error, "message", { value: message });
            throw error;
          },
        });
        await deliver(h, event);
        expect(h.lines).toEqual([
          `bpng  slack ✗ not sent: ${said} · datator ✗ not sent: ${said}`,
        ]);
        expect(h.busLines).toEqual([]);
      }
      expect(sink.requests).toEqual([]);
    });
  });

  test("a status that is not text still makes the line", async () => {
    await withSink(route(reply(200, "ok"), reply(201)), async (sink) => {
      const h = harness(configFor(sink.url, { slack: true, datator: true }));
      const status = 7 as unknown as RunStatus;
      await deliver(h, finishedEvent({ status }));
      expect(h.busLines).toEqual([]);
      expect(h.lines).toHaveLength(1);
      expect(h.lines[0]).toMatch(/ · datator not posted \(7\)$/);
      expect(requestsTo(sink, DATATOR_PATH)).toEqual([]);
    });
  });

  test("an answer quoting a secret too short to mask is withheld whole, by each sender", async () => {
    // Under 8 characters: masking it by value would mask ordinary words, so only the sender,
    // which knows the config's secrets, can see it and withhold the answer.
    const short = "abc1234";
    await withSink(
      route(reply(400, `bad hook ${short}`), reply(403, `denied ${short}`)),
      async (sink) => {
        const h = harness(
          configFor(
            sink.url,
            { slack: true, datator: true },
            { BWP_SHORT: short },
          ),
        );
        await deliver(h, finishedEvent());
        expect(h.lines).toEqual([
          "bpng  slack ✗ HTTP 400 (its answer is withheld: it quotes a secret) · datator ✗ HTTP 403 (its answer is withheld: it quotes a secret)",
        ]);
      },
    );
  });

  test("a shapeless secret of the config is masked in each form both answers quote it in", async () => {
    const password = "storage pw no shape 42";
    const echo = reply(
      400,
      `echo ${password} ${encodeURIComponent(password)} ${JSON.stringify(password)}`,
    );
    await withSink(echo, async (sink) => {
      const h = harness(
        configFor(
          sink.url,
          { slack: true, datator: true },
          { BWP_STORAGE_PW: password },
        ),
      );
      await deliver(h, finishedEvent());
      expect(h.lines).toEqual([
        'bpng  slack ✗ 400 echo *** *** "***" · datator ✗ 400 echo *** *** "***"',
      ]);
    });
  });

  test("an answer cut inside a long secret shows none of the secret's start", async () => {
    // 700 characters with no shape, longer than the 256 a cut answer always loses at its end: only
    // the sender, knowing it, drops enough. The body's first 8 KiB end 690 characters into it.
    const long = Array.from(
      { length: 700 },
      (_, index) => "qwertyuiopasdfghjklzxcvbnm"[(index * 7) % 26],
    ).join("");
    const head = "refused by policy";
    const body = `${head}${" ".repeat(8_192 - 690 - head.length)}${long}`;
    await withSink(reply(400, body), async (sink) => {
      const h = harness(
        configFor(sink.url, { slack: true, datator: true }, { BWP_LONG: long }),
      );
      await deliver(h, finishedEvent());
      expect(h.lines).toEqual([
        "bpng  slack ✗ 400 refused · datator ✗ 400 refused",
      ]);
    });
  });

  test("the two senders run at once: neither waits for the other", async () => {
    // Each ends at its own 100 ms; one after the other, they would pass the bus's 180 ms.
    await withSink(never, async (sink) => {
      const h = harness(configFor(sink.url, { slack: true, datator: true }), {
        timeoutMs: 100,
        busTimeoutMs: 180,
      });
      await deliver(h, finishedEvent());
      expect(h.lines).toEqual([
        "bpng  slack ✗ no answer within 100 ms · datator ✗ no answer within 100 ms",
      ]);
      expect(h.busLines).toEqual([]);
    });
  });

  test("the record handed out is frozen through: a change is refused and never posted", async () => {
    await withSink(reply(201), async (sink) => {
      const h = harness(configFor(sink.url, { datator: true }));
      const event = finishedEvent();
      const kept = h.notifications.datatorPayload(event);
      if (kept === undefined) throw new Error("no record");
      const loose = kept as unknown as {
        product: string;
        test_cases: { test_name: string }[];
      };
      const before = JSON.stringify(kept);
      // ES modules are strict: writing a frozen property throws.
      expect(() => {
        loose.product = "changed";
      }).toThrow(TypeError);
      expect(() => {
        loose.test_cases.push({ test_name: "added" });
      }).toThrow(TypeError);
      expect(loose.test_cases.length).toBeGreaterThan(0);
      expect(() => {
        (loose.test_cases[0] as { test_name: string }).test_name = "changed";
      }).toThrow(TypeError);
      await deliver(h, event);
      expect(JSON.stringify(kept)).toBe(before);
      expect(sink.requests[0]?.body).toBe(before);
    });
  });

  test("the fetch given is the one both senders use", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      return Promise.resolve(
        url.endsWith(WEBHOOK_PATH)
          ? new Response("ok", { status: 200 })
          : new Response(null, { status: 201 }),
      );
    };
    // An address nothing answers on: only the fetch given can make this pass.
    const h = harness(
      configFor("http://127.0.0.1:9", { slack: true, datator: true }),
      { fetch },
    );
    await deliver(h, finishedEvent());
    expect(h.lines).toEqual(["bpng  slack ✓ · datator ✓ 201"]);
    expect(calls).toEqual([
      `http://127.0.0.1:9${WEBHOOK_PATH}`,
      `http://127.0.0.1:9${DATATOR_PATH}`,
    ]);
  });

  test("the bus names a failed delivery `notifications`", () => {
    expect(NOTIFICATIONS_SUBSCRIBER).toBe("notifications");
  });
});

test.describe("notificationLine", () => {
  test("Datator's success shows its status, Slack's does not", () => {
    expect(
      notificationLine([
        { name: "slack", delivery: { ok: true, status: 200 } },
        { name: "datator", delivery: { ok: true, status: 201 } },
      ]),
    ).toBe("slack ✓ · datator ✓ 201");
  });

  test("a failure's status is shown once, before the answer", () => {
    expect(
      notificationLine([
        {
          name: "slack",
          delivery: { ok: false, status: 410, detail: "channel_is_archived" },
        },
        {
          name: "datator",
          delivery: { ok: false, status: 502, detail: "HTTP 502" },
        },
      ]),
    ).toBe("slack ✗ 410 channel_is_archived · datator ✗ HTTP 502");
  });

  test("a detail is one masked line, and never blank", () => {
    expect(
      notificationLine(
        [
          { name: "slack", delivery: { ok: false, detail: `a\nb ${API_KEY}` } },
          { name: "datator", delivery: { ok: false, detail: " \n " } },
        ],
        [API_KEY],
      ),
    ).toBe("slack ✗ a b *** · datator ✗ failed");
  });

  test("a run not posted says its status", () => {
    expect(notificationLine([{ name: "datator", notPosted: "stopped" }])).toBe(
      "datator not posted (stopped)",
    );
  });

  test("the status is shown unless the detail already names it, `HTTP <status>`", () => {
    expect(
      notificationLine([
        {
          name: "slack",
          delivery: {
            ok: false,
            status: 405,
            detail: "HTTP method not allowed",
          },
        },
        {
          name: "datator",
          delivery: {
            ok: false,
            status: 400,
            detail: "HTTP 400 (its answer is withheld: it quotes a secret)",
          },
        },
      ]),
    ).toBe(
      "slack ✗ 405 HTTP method not allowed · datator ✗ HTTP 400 (its answer is withheld: it quotes a secret)",
    );
    expect(
      notificationLine([
        {
          name: "datator",
          delivery: { ok: false, status: 400, detail: "HTTP 4000" },
        },
      ]),
    ).toBe("datator ✗ 400 HTTP 4000");
  });

  test("a status not posted is one masked line", () => {
    expect(
      notificationLine(
        [{ name: "datator", notPosted: `a\nb ${API_KEY}` }],
        [API_KEY],
      ),
    ).toBe("datator not posted (a b ***)");
  });

  test("values that are not text are shown, never thrown", () => {
    const odd = (value: unknown): never => value as never;
    expect(
      notificationLine([
        {
          name: "slack",
          delivery: { ok: false, status: odd("x"), detail: odd(42) },
        },
        {
          name: "datator",
          delivery: { ok: true, status: odd({ toString: () => "201" }) },
        },
        { name: "datator", notPosted: odd(7) },
        {
          name: "slack",
          delivery: {
            ok: false,
            detail: odd({
              toString: () => {
                throw new Error("unprintable");
              },
            }),
          },
        },
      ]),
    ).toBe(
      "slack ✗ x 42 · datator ✓ 201 · datator not posted (7) · slack ✗ failed",
    );
  });

  test("no outcomes, no words", () => {
    expect(notificationLine([])).toBe("");
  });
});
