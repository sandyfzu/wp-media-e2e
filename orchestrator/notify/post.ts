import { cut, oneLine, safeLine, secretForms } from "../text";

/**
 * The one HTTP call the notifiers make: a JSON `POST`, bounded in time and in what it reads back, and
 * reported as a {@link Delivery} — never a throw. What goes wrong is told in words of our own (a
 * status, an error code, "timed out"), never in `fetch`'s, so the URL — for Slack, the webhook's path
 * is the credential — cannot reach a log; and whatever is quoted from the far end is masked anyway.
 */

/** How a notification went. */
export type Delivery =
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false;
      /** The HTTP status, when an answer came. */
      readonly status?: number;
      /** What went wrong, one masked line: the answer's body, or why there was none. */
      readonly detail: string;
    };

/** How a notification is posted. */
export interface PostOptions {
  /** Headers beside `Content-Type: application/json`, such as an API key. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Aborts the request from outside — the event bus's time limit. */
  readonly signal?: AbortSignal;
  /** The request's own time limit, answer included. */
  readonly timeoutMs: number;
  /** Whether an answer is a success: Slack's `200 ok`, Datator's `201`. */
  readonly accept: (status: number, body: string) => boolean;
  /** Secret values the answer might echo (a key, the webhook's path), masked in `detail`. */
  readonly secrets?: readonly string[];
  /** The `fetch` to use; the global one by default. A seam for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The default time limit for one notification: 15 s. */
export const DEFAULT_POST_TIMEOUT_MS = 15_000;

/** The most of an answer's body read, in bytes: enough for any error a service sends. */
export const MAX_ANSWER_BYTES = 8_192;

/** The longest `detail`, in code points: an answer's first 500 characters. */
export const MAX_DETAIL = 500;

/**
 * How much of a cut answer's end is never quoted, at least, in code points: a credential the cut went
 * through is no longer whole, so neither its value nor its shape can be recognised — its start must
 * not be shown. The longest secret's length when that is more.
 */
export const CUT_TAIL = 256;

/** The longest time limit a timer takes: 2³¹ − 1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Posts `body` as JSON to `url`. A redirect is not followed: `fetch` would follow a `301` with a
 * `GET`, dropping the body, and report the page it landed on — the redirect is the answer.
 *
 * @param url - where to post.
 * @param body - what to post; serialised with `JSON.stringify`.
 * @param options - headers, time limits, what counts as success, secrets to mask.
 * @returns how it went; never rejects — an invalid time limit or signal included.
 *
 * @example
 * ```ts
 * const sent = await postJson(webhookUrl, { text }, {
 *   timeoutMs: DEFAULT_POST_TIMEOUT_MS,
 *   accept: (status, body) => status === 200 && body === "ok",
 * });
 * if (!sent.ok) log(`slack ✗ ${sent.detail}`);
 * ```
 */
export async function postJson(
  url: string,
  body: unknown,
  options: PostOptions,
): Promise<Delivery> {
  const secrets = options.secrets ?? [];
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_TIMEOUT_MS
  )
    return { ok: false, detail: "not sent: invalid time limit" };
  const timeout = AbortSignal.timeout(options.timeoutMs);
  try {
    // Inside the `try`: `AbortSignal.any` throws on something that is not a signal.
    const signal =
      options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      headers: { ...options.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    });
    const answer = await readCapped(response, MAX_ANSWER_BYTES);
    if (options.accept(response.status, answer.text))
      return { ok: true, status: response.status };
    return {
      ok: false,
      status: response.status,
      detail: describeAnswer(response.status, answer, secrets),
    };
  } catch (error: unknown) {
    return { ok: false, detail: whyNoAnswer(error, timeout, options) };
  }
}

/** The start of an answer's body, and whether it was cut there. */
interface Answer {
  readonly text: string;
  /** Whether the body may go on past `text` (it filled the cap). */
  readonly cut: boolean;
}

/**
 * Every form a secret may show in a clean line, as masking reads it: trimmed, and as cleaning writes
 * it ({@link oneLine}, trimmed) — one holding an invisible character reads without it — each in every
 * written form ({@link secretForms}). A secret of nothing but spaces has none.
 *
 * @param secrets - the secret values.
 * @returns their forms, each once, none empty.
 */
function shownForms(secrets: readonly string[]): string[] {
  const values = secrets
    .flatMap((secret) => [secret.trim(), oneLine(secret).trim()])
    .filter((value) => value !== "");
  return [...new Set(values.flatMap(secretForms))];
}

/**
 * A refused answer as one line safe to log: its start, masked ({@link safeLine}); when the body was
 * cut, without its last {@link CUT_TAIL} code points, where a credential the cut went through would
 * show its start. Withheld whole when a secret, in any form ({@link shownForms}), still shows — one
 * too short to mask by value (under 8 characters).
 *
 * @param status - the HTTP status.
 * @param answer - what was read of the body.
 * @param secrets - the secret values.
 * @returns the detail.
 */
function describeAnswer(
  status: number,
  answer: Answer,
  secrets: readonly string[],
): string {
  const forms = shownForms(secrets);
  const line = safeLine(answer.text, Number.MAX_SAFE_INTEGER, secrets);
  const tail = Math.max(CUT_TAIL, ...forms.map((form) => form.length));
  const kept = answer.cut
    ? Array.from(line).slice(0, -tail).join("").trimEnd()
    : line;
  const said = kept === "" ? "" : cut(kept, MAX_DETAIL);
  if (forms.some((form) => said.includes(form)))
    return `HTTP ${String(status)} (its answer is withheld: it quotes a secret)`;
  return said === "" ? `HTTP ${String(status)}` : said;
}

/**
 * At most `maxBytes` of a response's body, as text; the rest is never downloaded. A body cut in the
 * middle of a character ends in U+FFFD.
 *
 * @param response - the response.
 * @param maxBytes - the most bytes read.
 * @returns the body's start, and whether it was cut.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Answer> {
  if (response.body === null) return { text: "", cut: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  try {
    while (read < maxBytes) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), cut: false };
      const chunk = value.subarray(0, maxBytes - read);
      read += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    return { text: text + decoder.decode(), cut: true };
  } finally {
    // Stops the download of whatever is left; a body already read whole is unaffected.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Why no answer came, in our own words: the time limit, a cancellation, or the network error's code
 * (`ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`) — never `fetch`'s message, which may name the URL.
 *
 * @param error - what `fetch` or reading the body threw.
 * @param timeout - the request's own time limit, to tell it from a cancellation.
 * @param options - the time limit, for the message.
 * @returns one line.
 */
function whyNoAnswer(
  error: unknown,
  timeout: AbortSignal,
  options: PostOptions,
): string {
  if (timeout.aborted)
    return `no answer within ${String(options.timeoutMs)} ms`;
  if (options.signal?.aborted === true) return "cancelled";
  const code = errorCode(error);
  return code === undefined ? "request failed" : `request failed: ${code}`;
}

/**
 * A network error's code, from the error or its `cause` (undici wraps it: `fetch failed`, caused by
 * `connect ECONNREFUSED …`); only an upper-case identifier, so nothing else of it is quoted.
 *
 * @param error - what was thrown.
 * @returns the code, or `undefined` — also when reading the error throws (a getter).
 */
function errorCode(error: unknown): string | undefined {
  try {
    for (let current = error, depth = 0; depth < 4; depth++) {
      if (typeof current !== "object" || current === null) return undefined;
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code))
        return code;
      current = cause;
    }
  } catch {
    // Unreadable: no code.
  }
  return undefined;
}
