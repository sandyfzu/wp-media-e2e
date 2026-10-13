import type {
  FinishedScenario,
  RunFinishedEvent,
} from "../events/run-finished";
import type { RunStatus } from "../runs/outcome";
import { cut } from "../text";
import { DEFAULT_POST_TIMEOUT_MS, postJson, type Delivery } from "./post";

/**
 * Datator: one record per run that tested, for the dashboards that track results over time. Built
 * against Datator's own serializer (`wp-media/datator`, `e2e_tests`), which checks lengths, types
 * and URLs and nothing else — so every bound it enforces is enforced here first: a payload it would
 * refuse is a whole run lost.
 */

/** The statuses posted: runs that tested. A broken branch or site, or a stopped run, is not a regression. */
const POSTED: ReadonlySet<RunStatus> = new Set(["passed", "flaky", "failed"]);

/** AutoE2E's product codes, which Datator's series are keyed by; any other product goes by its name. */
export const DATATOR_PRODUCT_CODES: Readonly<Record<string, string>> = {
  backwpup: "backwpup",
  "wp-rocket": "wp_rocket",
};

/** Datator's longest `product`, `test_suite`, `git_commit` and `website_url`. */
export const MAX_RUN_FIELD = 255;

/** Datator's longest `feature_name` and `test_name`: 501 is refused. */
export const MAX_CASE_NAME = 500;

/** The longest `error_message` posted: the field is unbounded, the body is not. */
export const MAX_CASE_ERROR = 4_000;

/** What a nameless feature or scenario is posted as: Datator refuses a blank name. */
export const UNNAMED = "(unnamed)";

/** One scenario, as Datator records it. */
export interface DatatorTestCase {
  readonly feature_name: string;
  /** The scenario's name, after its Rule and Outline titles. */
  readonly test_name: string;
  /** `passed` (flaky included), `failed` or `skipped` — AutoE2E's three values. */
  readonly status: "passed" | "failed" | "skipped";
  readonly error_message: string | null;
}

/** A run, as Datator records it. */
export interface DatatorPayload {
  readonly product: string;
  /** The cell, then the task's filter when it has one: `pro@nginx @smoke`. */
  readonly test_suite: string;
  /** The run's start, ISO 8601 UTC. */
  readonly timestamp: string;
  readonly total_tests: number;
  /** Passed and flaky; a skipped scenario counts as neither passed nor failed. */
  readonly successful_tests: number;
  readonly failed_tests: number;
  /** The full commit built; `null` for a release's zip. */
  readonly git_commit: string | null;
  /** Whole seconds: Datator refuses `845.7`. */
  readonly test_duration_seconds: number;
  /** The pool's first site; `null` when unknown or not a URL Datator would accept. */
  readonly website_url: string | null;
  readonly test_cases: readonly DatatorTestCase[];
}

/**
 * The run's Datator record — only for a run that tested: `passed`, `flaky` or `failed`.
 *
 * @param event - the run's `run.finished`.
 * @returns the payload, or `undefined` for a run that is not posted.
 */
export function datatorPayload(
  event: RunFinishedEvent,
): DatatorPayload | undefined {
  if (!POSTED.has(event.status)) return undefined;
  const { counts, unit } = event;
  const suite =
    event.run.task.grep === null
      ? unit.cell
      : `${unit.cell} ${event.run.task.grep}`;
  return {
    product: text(
      DATATOR_PRODUCT_CODES[unit.product] ?? unit.product,
      MAX_RUN_FIELD,
    ),
    test_suite: text(suite, MAX_RUN_FIELD),
    timestamp: event.startedAt,
    total_tests: counts.total,
    successful_tests: counts.passed + counts.flaky,
    failed_tests: counts.failed,
    git_commit: isCommit(event.plugin.commit) ? event.plugin.commit : null,
    test_duration_seconds: Math.round(Math.max(0, event.durationMs) / 1000),
    website_url: acceptedUrl(event.sites[0]?.baseURL),
    test_cases: event.scenarios.map(testCase),
  };
}

/**
 * One scenario's record: its names within Datator's bounds, `flaky` as `passed`, an interrupted one
 * as `skipped` (it never finished).
 */
function testCase(scenario: FinishedScenario): DatatorTestCase {
  const name = [...scenario.path, scenario.name]
    .filter((part) => part.trim() !== "")
    .join(" › ");
  return {
    feature_name: text(scenario.feature, MAX_CASE_NAME),
    test_name: text(name, MAX_CASE_NAME),
    status:
      scenario.status === "passed" || scenario.status === "flaky"
        ? "passed"
        : scenario.status === "failed"
          ? "failed"
          : "skipped",
    error_message:
      scenario.error === undefined || scenario.error.trim() === ""
        ? null
        : cut(scenario.error.toWellFormed(), MAX_CASE_ERROR),
  };
}

/**
 * Text Datator accepts in a required field: well-formed (it refuses a lone surrogate), trimmed as it
 * trims, {@link UNNAMED} when blank (it refuses blank), and at most `max` code points — the length it
 * counts.
 *
 * @param value - the text.
 * @param max - the most code points.
 * @returns the text.
 */
function text(value: string, max: number): string {
  const trimmed = value.toWellFormed().trim();
  return cut(trimmed === "" ? UNNAMED : trimmed, max);
}

/**
 * Whether `commit` is a full git commit — 40 (SHA-1) or 64 (SHA-256) hex digits; anything else is not
 * posted as one.
 */
function isCommit(commit: string | null): commit is string {
  return commit !== null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit);
}

/**
 * `url` when Datator's URL check (Django's `URLValidator`) would surely accept it: `http`/`https`, at
 * most {@link MAX_RUN_FIELD}, written as a URL parser writes it back (a trailing `/` aside) — so
 * nothing a parser rewrites, such as a space, a backslash, `%61` or the IPv4 shorthand `127.1` — and a
 * host that is `localhost`, an IPv4 address, or a name ending in a top-level domain of letters.
 * Anything else — a Docker service name such as `http://wp-apache` — is `null`: an optional field
 * Datator refuses would lose the whole record.
 *
 * @param url - the site's `baseURL`.
 * @returns the URL, or `null`.
 */
export function acceptedUrl(url: string | undefined): string | null {
  if (url === undefined || url.length > MAX_RUN_FIELD || !URL.canParse(url))
    return null;
  const { protocol, hostname, href } = new URL(url);
  if (href !== url && href !== `${url}/`) return null;
  const hostOk =
    hostname === "localhost" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9]{1,59})$/.test(
      hostname,
    );
  return (protocol === "https:" || protocol === "http:") && hostOk ? url : null;
}

/** Where and how a record is sent. */
export interface DatatorSendOptions {
  /** Datator's results endpoint, ending with `/`. */
  readonly url: string;
  /** Sent as `X-API-Key` — a credential: never logged. */
  readonly apiKey: string;
  /** The bus's signal, aborting at its time limit. */
  readonly signal?: AbortSignal;
  /** Secret values to mask in what Datator answers. */
  readonly secrets?: readonly string[];
  /** The time limit; {@link DEFAULT_POST_TIMEOUT_MS} by default. */
  readonly timeoutMs?: number;
  /** A seam for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Sends a record. Success is `201`; anything else — `400` with its field errors, `403` for the key —
 * is a failed {@link Delivery} carrying the answer's first 500 characters. No retry.
 *
 * @param payload - the record, as {@link datatorPayload} makes it.
 * @param options - the endpoint, the key, the signal, the secrets to mask.
 * @returns how it went; never rejects.
 */
export function sendDatator(
  payload: DatatorPayload,
  options: DatatorSendOptions,
): Promise<Delivery> {
  return postJson(options.url, payload, {
    headers: { "X-API-Key": options.apiKey },
    timeoutMs: options.timeoutMs ?? DEFAULT_POST_TIMEOUT_MS,
    accept: (status) => status === 201,
    signal: options.signal,
    secrets: [options.apiKey, ...(options.secrets ?? [])],
    fetch: options.fetch,
  });
}
