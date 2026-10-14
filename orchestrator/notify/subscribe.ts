import type { OrchestratorConfig } from "../config/schema";
import { secretValues } from "../config/secrets";
import type { EventBus } from "../events/bus";
import type { RunFinishedEvent } from "../events/run-finished";
import type { Logger } from "../log";
import { failureLine, safeLine, textOf } from "../text";
import { datatorPayload, sendDatator, type DatatorPayload } from "./datator";
import { MAX_DETAIL, type Delivery } from "./post";
import { sendSlack, slackMessage } from "./slack";

/**
 * Slack and Datator on the event bus: each configured one is sent every `run.finished`, both at once,
 * and the run's task logs one line saying how each went — `slack ✓ · datator ✓ 201`, or `✗` and the
 * masked reason. One subscriber for both, so the line waits for both and its order never depends on
 * which answered first. Nothing here throws into the bus: the senders never reject, and a formatter
 * that throws is told as that sender's `✗`.
 */

/** The name the bus logs a failed delivery under (its own time limit). */
export const NOTIFICATIONS_SUBSCRIBER = "notifications";

/** The senders, in the order the line names them. */
export const SENDERS = ["slack", "datator"] as const;

/** A sender. */
export type SenderName = (typeof SENDERS)[number];

/** What the subscribers read from the config. */
export type NotificationConfig = Pick<
  OrchestratorConfig,
  "instance" | "secrets" | "notifications" | "reports"
>;

/** How one sender went for one run. */
export type SenderOutcome =
  | { readonly name: SenderName; readonly delivery: Delivery }
  /** Sent nothing, on purpose: Datator records only runs that tested. */
  | { readonly name: SenderName; readonly notPosted: string };

/** A configured sender: its name, and how it sends one run. */
interface Sender {
  /** Its name, in the line and in {@link Notifications.senders}. */
  readonly name: SenderName;
  /** Sends one run, cancelled by the bus's `signal`; may throw (a formatter's error). */
  readonly send: (
    event: RunFinishedEvent,
    signal: AbortSignal,
  ) => Promise<SenderOutcome>;
}

/** What {@link subscribeNotifications} subscribed, and the Datator record a run's `run.json` keeps. */
export interface Notifications {
  /** The senders subscribed, in {@link SENDERS} order; none when nothing is configured. */
  readonly senders: readonly SenderName[];
  /**
   * The record Datator is (or was) sent for `event`, to keep in its `run.json` — the very object
   * posted, whichever is asked first; `undefined` when Datator is not configured or the run did not
   * test. Call it with the event object that is published. Frozen, `test_cases` and each case too:
   * what is kept can never differ from what is posted.
   *
   * @throws what building the record throws — nothing, for an event `buildRunFinished` made.
   */
  datatorPayload(event: RunFinishedEvent): DatatorPayload | undefined;
}

/** What the senders take besides the config: seams for tests. */
export interface NotificationOptions {
  /** Each request's own time limit; the senders' 15 s by default. */
  readonly timeoutMs?: number;
  /** The `fetch` the senders use; the global one by default. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Subscribes the configured senders to `run.finished`, each with every secret of the config to mask
 * and the bus's signal. With neither configured nothing is subscribed and nothing is logged.
 *
 * @param bus - the event bus.
 * @param config - the checked config: the senders, `instance`, `reports.sshHost` and the secrets.
 * @param logger - where each run's line goes, under its task's id.
 * @param options - the time limit and `fetch`; the defaults in production.
 * @returns the senders subscribed, and the Datator record of a run ({@link Notifications}).
 *
 * @example
 * ```ts
 * const notifications = subscribeNotifications(bus, config, logger);
 * const posted = notifications.datatorPayload(event); // kept in the run's `run.json`
 * bus.publish(event); // 11:09:42 bpng  slack ✓ · datator ✓ 201
 * ```
 */
export function subscribeNotifications(
  bus: Pick<EventBus<RunFinishedEvent>, "on">,
  config: NotificationConfig,
  logger: Pick<Logger, "line">,
  options: NotificationOptions = {},
): Notifications {
  const secrets = secretValues(config);
  const { slack, datator } = config.notifications ?? {};
  // One record per event object: what `run.json` keeps is what was posted.
  const payloads = new WeakMap<RunFinishedEvent, DatatorPayload | undefined>();
  const payloadOf = (event: RunFinishedEvent): DatatorPayload | undefined => {
    if (datator === undefined) return undefined;
    if (!payloads.has(event))
      payloads.set(event, frozen(datatorPayload(event)));
    return payloads.get(event);
  };
  const senders = [
    ...(slack === undefined
      ? []
      : [slackSender(config, slack.webhookUrl, secrets, options)]),
    ...(datator === undefined
      ? []
      : [datatorSender(datator, payloadOf, secrets, options)]),
  ];
  if (senders.length > 0)
    bus.on(
      "run.finished",
      async (event, signal) => {
        const outcomes = await Promise.all(
          senders.map((sender) => attempt(sender, event, signal, secrets)),
        );
        logger.line(event.run.task.id, notificationLine(outcomes, secrets));
      },
      NOTIFICATIONS_SUBSCRIBER,
    );
  return {
    senders: senders.map((sender) => sender.name),
    datatorPayload: payloadOf,
  };
}

/**
 * Slack's sender: the run's message to the webhook.
 *
 * @param config - `instance` and `reports.sshHost`, for the message.
 * @param webhookUrl - the webhook.
 * @param secrets - the values to mask in Slack's answer.
 * @param options - the time limit and `fetch`.
 * @returns the sender.
 */
function slackSender(
  config: NotificationConfig,
  webhookUrl: string,
  secrets: readonly string[],
  options: NotificationOptions,
): Sender {
  return {
    name: "slack",
    send: async (event, signal) => ({
      name: "slack",
      delivery: await sendSlack(
        slackMessage(event, {
          instance: config.instance,
          sshHost: config.reports?.sshHost,
        }),
        {
          webhookUrl,
          signal,
          secrets,
          timeoutMs: options.timeoutMs,
          fetch: options.fetch,
        },
      ),
    }),
  };
}

/**
 * Datator's sender: the run's record, when it tested ({@link datatorPayload}); else nothing posted.
 *
 * @param datator - the endpoint and its key.
 * @param payloadOf - the run's record, the one `run.json` keeps.
 * @param secrets - the values to mask in Datator's answer.
 * @param options - the time limit and `fetch`.
 * @returns the sender.
 */
function datatorSender(
  datator: { readonly url: string; readonly apiKey: string },
  payloadOf: (event: RunFinishedEvent) => DatatorPayload | undefined,
  secrets: readonly string[],
  options: NotificationOptions,
): Sender {
  return {
    name: "datator",
    send: async (event, signal) => {
      const payload = payloadOf(event);
      if (payload === undefined)
        return { name: "datator", notPosted: event.status };
      return {
        name: "datator",
        delivery: await sendDatator(payload, {
          url: datator.url,
          apiKey: datator.apiKey,
          signal,
          secrets,
          timeoutMs: options.timeoutMs,
          fetch: options.fetch,
        }),
      };
    },
  };
}

/**
 * Runs one sender, turning a throw — a formatter's, since the senders never reject — into its failed
 * delivery, so the other sender's outcome and the line survive it.
 *
 * @param sender - the sender.
 * @param event - the run's event.
 * @param signal - the bus's signal.
 * @param secrets - masked in the error's message.
 * @returns its outcome.
 */
async function attempt(
  sender: Sender,
  event: RunFinishedEvent,
  signal: AbortSignal,
  secrets: readonly string[],
): Promise<SenderOutcome> {
  try {
    return await sender.send(event, signal);
  } catch (error: unknown) {
    return {
      name: sender.name,
      delivery: {
        ok: false,
        detail: `not sent: ${failureLine(error, MAX_DETAIL, secrets)}`,
      },
    };
  }
}

/**
 * The run's line: each outcome in turn, joined by ` · ` — `slack ✓ · datator ✓ 201`,
 * `slack ✗ 404 no_service`, `datator ✗ no answer within 15000 ms`, `datator not posted (error)`.
 * Datator's success shows its status (`201`); Slack's is only ever `200 ok`, so it shows none. A failure
 * shows its status before Slack's or Datator's answer, unless its detail already names it. Every part
 * is masked and made one line.
 *
 * @param outcomes - how each sender went, in the order shown.
 * @param secrets - the values to mask.
 * @returns the line.
 */
export function notificationLine(
  outcomes: readonly SenderOutcome[],
  secrets: readonly string[] = [],
): string {
  return outcomes
    .map((outcome) => `${outcome.name} ${outcomeText(outcome, secrets)}`)
    .join(" · ");
}

/**
 * One outcome's words, after its sender's name. Total: every value is read as text
 * ({@link textOf}), so one that is not a string — a status of another type — is shown, not thrown.
 *
 * @param outcome - how it went.
 * @param secrets - the values to mask.
 * @returns the words.
 */
function outcomeText(
  outcome: SenderOutcome,
  secrets: readonly string[],
): string {
  if ("notPosted" in outcome)
    return `not posted (${safeLine(textOf(outcome.notPosted), 40, secrets)})`;
  const { delivery } = outcome;
  if (delivery.ok)
    return outcome.name === "slack"
      ? "✓"
      : `✓ ${safeLine(textOf(delivery.status), 40, secrets)}`;
  const detail = failureLine(delivery.detail, MAX_DETAIL, secrets);
  if (delivery.status === undefined) return `✗ ${detail}`;
  const status = safeLine(textOf(delivery.status), 40, secrets);
  // `HTTP 500`, or `HTTP 500 (its answer is withheld…)`, already names it.
  const named =
    detail === `HTTP ${status}` || detail.startsWith(`HTTP ${status} `);
  return named ? `✗ ${detail}` : `✗ ${status} ${detail}`;
}

/**
 * A Datator record frozen through: itself, `test_cases` and each case — so the object handed out for
 * `run.json` and the one posted cannot drift apart.
 *
 * @param payload - the record, or `undefined` for a run not posted.
 * @returns the same object, frozen.
 */
function frozen(
  payload: DatatorPayload | undefined,
): DatatorPayload | undefined {
  if (payload === undefined) return undefined;
  for (const testCase of payload.test_cases) Object.freeze(testCase);
  Object.freeze(payload.test_cases);
  return Object.freeze(payload);
}
