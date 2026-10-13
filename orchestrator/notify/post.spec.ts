import { test, expect } from "@playwright/test";

import { reply, startSink, type HttpSink } from "../__fixtures__/http-sink";
import {
  MAX_ANSWER_BYTES,
  MAX_DETAIL,
  postJson,
  type PostOptions,
} from "./post";

/** Success as Datator means it. */
const OPTIONS: PostOptions = {
  timeoutMs: 2_000,
  accept: (status) => status === 201,
};

/** The sinks a test started, closed after it. */
const sinks: HttpSink[] = [];

/** Starts a sink that is closed after the test. */
async function sink(...args: Parameters<typeof startSink>): Promise<HttpSink> {
  const started = await startSink(...args);
  sinks.push(started);
  return started;
}

test.afterEach(async () => {
  await Promise.all(sinks.splice(0).map((s) => s.close()));
});

test.describe("postJson", () => {
  test("posts the body as JSON with the given headers, and reports an accepted answer", async () => {
    const server = await sink(reply(201, '{"detail":"saved"}'));
    const sent = await postJson(
      `${server.url}/e2e_tests/results/`,
      { a: 1, b: "é" },
      { ...OPTIONS, headers: { "X-API-Key": "key-1234567" } },
    );
    expect(sent).toEqual({ ok: true, status: 201 });
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/e2e_tests/results/");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["x-api-key"]).toBe("key-1234567");
    expect(JSON.parse(request?.body ?? "")).toEqual({ a: 1, b: "é" });
  });

  test("lets the answer's body decide, as Slack's 200 ok does", async () => {
    const server = await sink(reply(200, "ok"));
    const accept = (status: number, body: string): boolean =>
      status === 200 && body === "ok";
    expect(await postJson(server.url, {}, { ...OPTIONS, accept })).toEqual({
      ok: true,
      status: 200,
    });
  });

  test("reports a refused answer with its status and its body, one masked line", async () => {
    const server = await sink(
      reply(400, "bad\n\u001b[31mkey secret-value-123\u001b[0m"),
    );
    const sent = await postJson(
      server.url,
      {},
      {
        ...OPTIONS,
        secrets: ["secret-value-123"],
      },
    );
    expect(sent).toEqual({ ok: false, status: 400, detail: "bad key ***" });
  });

  test("names the status when a refused answer has no body", async () => {
    const server = await sink(reply(503));
    expect(await postJson(server.url, {}, OPTIONS)).toEqual({
      ok: false,
      status: 503,
      detail: "HTTP 503",
    });
  });

  test("quotes at most the first 500 characters of an answer", async () => {
    const server = await sink(reply(400, "x".repeat(100_000)));
    const sent = await postJson(server.url, {}, OPTIONS);
    expect(sent.ok).toBe(false);
    expect(!sent.ok && Array.from(sent.detail)).toHaveLength(MAX_DETAIL);
  });

  test("reads no more of an endless answer than its cap", async () => {
    let written = 0;
    const server = await sink((_request, response) => {
      response.writeHead(400);
      // Writes until the client goes away.
      const chunk = "y".repeat(1024);
      const pump = (): void => {
        while (!response.destroyed && response.write(chunk))
          written += chunk.length;
        if (!response.destroyed) response.once("drain", pump);
      };
      pump();
    });
    const sent = await postJson(server.url, {}, OPTIONS);
    expect(sent).toMatchObject({ ok: false, status: 400 });
    expect(written).toBeGreaterThan(MAX_ANSWER_BYTES);
  });

  test("does not follow a redirect, which would drop the body: the redirect is the answer", async () => {
    const server = await sink((request, response) => {
      if (request.path === "/results") {
        response.writeHead(301, { Location: "/results/" });
        response.end();
      } else reply(201)(request, response);
    });
    const sent = await postJson(`${server.url}/results`, { a: 1 }, OPTIONS);
    expect(sent).toMatchObject({ ok: false, status: 301 });
    expect(server.requests.map((r) => r.path)).toEqual(["/results"]);
  });

  test("gives up at its time limit when no answer comes", async () => {
    const server = await sink(() => {
      // Never answers.
    });
    const started = Date.now();
    const sent = await postJson(server.url, {}, { ...OPTIONS, timeoutMs: 200 });
    expect(sent).toEqual({ ok: false, detail: "no answer within 200 ms" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("gives up when an answer's body stalls past the time limit", async () => {
    const server = await sink((_request, response) => {
      response.writeHead(400);
      response.write("partial");
    });
    const sent = await postJson(server.url, {}, { ...OPTIONS, timeoutMs: 200 });
    expect(sent).toEqual({ ok: false, detail: "no answer within 200 ms" });
  });

  test("stops when the caller's signal aborts", async () => {
    const server = await sink(() => {
      // Never answers.
    });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new Error("bus time limit"));
    }, 50);
    const sent = await postJson(
      server.url,
      {},
      {
        ...OPTIONS,
        signal: controller.signal,
      },
    );
    expect(sent).toEqual({ ok: false, detail: "cancelled" });
  });

  test("names a network failure by its code alone, never by fetch's message or the URL", async () => {
    const server = await sink(reply(201));
    const closedUrl = `${server.url}/services/T000/B000/secret-path`;
    await server.close();
    const sent = await postJson(closedUrl, {}, OPTIONS);
    expect(sent).toEqual({ ok: false, detail: "request failed: ECONNREFUSED" });
  });

  test("never rejects, whatever fetch throws", async () => {
    const hostile = {
      get code(): never {
        throw new Error("getter");
      },
    };
    for (const thrown of [hostile, null, "text", Object.create(null)]) {
      const sent = await postJson(
        "https://example.test/",
        {},
        {
          ...OPTIONS,
          fetch: () => Promise.reject(thrown as Error),
        },
      );
      expect(sent).toEqual({ ok: false, detail: "request failed" });
    }
  });

  test("never rejects on a body JSON cannot write", async () => {
    const sent = await postJson(
      "https://example.test/",
      { n: 1n },
      {
        ...OPTIONS,
        fetch: () => Promise.reject(new Error("not called")),
      },
    );
    expect(sent).toEqual({ ok: false, detail: "request failed" });
  });

  test("never shows the start of a secret the read cap cut through", async () => {
    const key = "dk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    for (const padding of [
      " ".repeat(8172),
      "​".repeat(2724),
      "x".repeat(8172),
    ]) {
      const server = await sink(reply(400, padding + key));
      const sent = await postJson(
        server.url,
        {},
        { ...OPTIONS, secrets: [key] },
      );
      expect(sent.ok).toBe(false);
      // No 4 characters of the key in a row survive.
      const detail = sent.ok ? "" : sent.detail;
      for (let at = 0; at + 4 <= key.length; at++)
        expect(detail).not.toContain(key.slice(at, at + 4));
    }
  });

  test("never shows the start of a credential with a shape, cut by the read cap", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const server = await sink(reply(400, " ".repeat(8180) + token));
    const sent = await postJson(server.url, {}, OPTIONS);
    expect(sent.ok ? "" : sent.detail).not.toContain("ghp_");
  });

  test("masks a secret echoed URL-encoded or inside a JSON string", async () => {
    const key = 'key"with\\quote/slash+';
    const server = await sink(
      reply(
        403,
        `${JSON.stringify({ k: key })} ${JSON.stringify({ k: key }).replaceAll("/", "\\/")} ${encodeURIComponent(key)}`,
      ),
    );
    const sent = await postJson(server.url, {}, { ...OPTIONS, secrets: [key] });
    expect(sent).toEqual({
      ok: false,
      status: 403,
      detail: '{"k":"***"} {"k":"***"} ***',
    });
  });

  test("withholds an answer that quotes a secret too short to mask", async () => {
    const server = await sink(reply(403, "bad key k3y-7ch"));
    expect(
      await postJson(server.url, {}, { ...OPTIONS, secrets: ["k3y-7ch"] }),
    ).toEqual({
      ok: false,
      status: 403,
      detail: "HTTP 403 (its answer is withheld: it quotes a secret)",
    });
  });

  test("never rejects on an invalid time limit or signal", async () => {
    for (const timeoutMs of [Number.NaN, -1, 0, 1.5, Infinity, 2 ** 53])
      expect(
        await postJson("https://example.test/", {}, { ...OPTIONS, timeoutMs }),
      ).toEqual({
        ok: false,
        detail: "not sent: invalid time limit",
      });
    expect(
      await postJson(
        "https://example.test/",
        {},
        {
          ...OPTIONS,
          signal: {} as AbortSignal,
          fetch: () => Promise.reject(new Error("not called")),
        },
      ),
    ).toEqual({ ok: false, detail: "request failed: ERR_INVALID_ARG_TYPE" });
  });
});
