import { failureLine, safeLine } from "../text";

/**
 * The orchestrator's event bus: whoever announces something publishes it, and each subscriber —
 * Slack, Datator — gets it on its own. A subscriber never holds up the run that published: `publish`
 * returns before any handler starts, every handler runs concurrently with a time limit, and a failure
 * or a timeout is logged with the subscriber's name — masked, one line — and goes no further. Nothing
 * a handler or the log does can make the bus throw or reject. At shutdown, `settle` waits for what is
 * in flight.
 *
 * The time limit bounds waiting, not computing: a handler's synchronous work cannot be interrupted,
 * so a handler does its work in I/O (`fetch`), not in a loop.
 */

/** Any event: a `type` that subscribers choose by. */
export interface BusEvent {
  readonly type: string;
}

/**
 * A subscriber's handler. `signal` aborts when its time is up: hand it to `fetch`, so a request that
 * hangs is cancelled rather than left open.
 */
export type EventHandler<E extends BusEvent> = (
  event: E,
  signal: AbortSignal,
) => Promise<void> | void;

/** The bus. */
export interface EventBus<E extends BusEvent> {
  /**
   * Subscribes a handler to one type of event.
   *
   * @param type - the event type.
   * @param handler - what to do with each such event.
   * @param name - the subscriber's name, which a failure is logged under: `slack`.
   */
  on<T extends E["type"]>(
    type: T,
    handler: EventHandler<Extract<E, { type: T }>>,
    name: string,
  ): void;
  /**
   * Hands an event to every subscriber of its type, and returns before any of them starts.
   *
   * @param event - the event.
   */
  publish(event: E): void;
  /**
   * Waits until every delivery published so far, and any published meanwhile, has ended. Never
   * rejects; each delivery is bounded by the bus's time limit.
   */
  settle(): Promise<void>;
}

/** How a bus is made. */
export interface EventBusOptions {
  /** How long one handler may take before it is abandoned (and its signal aborted). */
  readonly timeoutMs: number;
  /** Where a failed delivery is told: one line. Should it throw, the line is dropped. */
  readonly log: (line: string) => void;
  /** Secret values a failure might quote (a webhook URL, a key): masked in the line. */
  readonly secrets?: readonly string[];
}

/** The default time limit for one delivery: 30 s. */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;

/**
 * The longest failure a delivery's log line quotes, in code points: a handler's thrown error or its
 * timeout, as long as the detail a sender keeps of an answer (`MAX_DETAIL`, `notify/post.ts`).
 */
const MAX_DELIVERY_FAILURE_LENGTH = 500;

/** The longest subscriber name or event type a log line quotes, in code points. */
const MAX_NAME_LENGTH = 100;

/** A subscription: its handler, under its name. */
interface Subscription<E extends BusEvent> {
  readonly name: string;
  readonly handler: EventHandler<E>;
}

/**
 * Makes an event bus.
 *
 * @param options - the time limit per delivery, the log for failures and the secrets they mask.
 * @returns the bus.
 * @throws {@link RangeError} for a time limit that is not a positive whole number of milliseconds.
 *
 * @example
 * ```ts
 * const bus = createEventBus<RunFinishedEvent>({
 *   timeoutMs: DEFAULT_DELIVERY_TIMEOUT_MS,
 *   log: (line) => logger.line("orchestrator", line),
 *   secrets,
 * });
 * bus.on("run.finished", (event, signal) => sendToSlack(event, signal), "slack");
 * bus.publish(event);
 * await bus.settle(); // at shutdown
 * ```
 */
export function createEventBus<E extends BusEvent>(
  options: EventBusOptions,
): EventBus<E> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new RangeError(
      "An event bus's time limit must be a positive whole number of milliseconds.",
    );
  const subscriptions = new Map<string, Subscription<E>[]>();
  const inFlight = new Set<Promise<void>>();

  /**
   * Tells a failed delivery. A log that fails — a full disk, a closed terminal — has nowhere left to
   * report to, and must not crash the process: the line is dropped.
   *
   * @param line - the failure, already masked and on one line.
   */
  function tell(line: string): void {
    try {
      options.log(line);
    } catch {
      // Dropped, on purpose: see above.
    }
  }

  /**
   * Runs one handler, bounded and caught; removes itself from {@link inFlight} as it ends.
   *
   * @param subscription - the handler, under the name a failure is told by.
   * @param event - what it is handed.
   */
  function deliver(subscription: Subscription<E>, event: E): void {
    const delivery = runBounded(subscription, event, options).then(
      (failure) => {
        if (failure !== undefined)
          tell(
            `${safeLine(subscription.name, MAX_NAME_LENGTH)}: ${safeLine(event.type, MAX_NAME_LENGTH)} not delivered: ${failure}`,
          );
      },
    );
    inFlight.add(delivery);
    void delivery.finally(() => inFlight.delete(delivery));
  }

  return {
    /**
     * Adds a subscriber; each event of `type` published later reaches it, after those added earlier.
     *
     * @param type - the event type it receives.
     * @param handler - what it does with each event.
     * @param name - the name its failures are told by.
     */
    on(type, handler, name) {
      const list = subscriptions.get(type) ?? [];
      list.push({ name, handler: handler as EventHandler<E> });
      subscriptions.set(type, list);
    },
    /**
     * Starts one delivery per subscriber of the event's type — those subscribed at this moment — and
     * returns before any handler runs.
     *
     * @param event - the event to hand out.
     */
    publish(event) {
      for (const subscription of [...(subscriptions.get(event.type) ?? [])])
        deliver(subscription, event);
    },
    /**
     * Waits for every delivery in flight, including those a handler publishes meanwhile.
     *
     * @returns once none is left; never rejects.
     */
    async settle() {
      // A delivery may publish another: wait until none is left.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

/**
 * Runs a handler within the time limit, a turn after it is called — so `publish` returns first, and a
 * handler that publishes never re-enters it. Never rejects.
 *
 * @param subscription - the handler and its name.
 * @param event - the event.
 * @param options - the time limit and the secrets to mask.
 * @returns `undefined` when it succeeded, else what went wrong, as one line.
 */
async function runBounded<E extends BusEvent>(
  subscription: Subscription<E>,
  event: E,
  options: EventBusOptions,
): Promise<string | undefined> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("timed out"));
      resolve(`timed out after ${String(options.timeoutMs)} ms`);
    }, options.timeoutMs);
  });
  const run = (async () => {
    // A turn first: everything before the first `await` would run inside `publish`.
    await Promise.resolve();
    // Called inside the async body, so a handler that throws synchronously is caught too.
    await subscription.handler(event, controller.signal);
    return undefined;
  })().catch((error: unknown) =>
    failureLine(error, MAX_DELIVERY_FAILURE_LENGTH, options.secrets ?? []),
  );
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
