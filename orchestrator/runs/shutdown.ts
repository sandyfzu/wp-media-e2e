import type { StopLevel } from "./stop";

/**
 * Stopping the orchestrator: how the signals it receives, and the time they take, become how far
 * every run is stopped. A pure reducer ({@link stepShutdown}) and a thin driver over injected timers
 * ({@link createShutdown}); the process's signal handlers are the command's.
 *
 * | Signal | Effect |
 * | --- | --- |
 * | SIGINT (Ctrl-C), first | Drain every run; after the drain budget (15 min), interrupt |
 * | SIGINT, second | Interrupt every run now; after the interrupt budget (4 min), kill |
 * | SIGINT, third | Kill every run now |
 * | SIGTERM, SIGHUP | As the first SIGINT when nothing is stopping yet; otherwise nothing |
 *
 * Signals less than a second after the last one counted count as one: a single Ctrl-C under `npm run`
 * delivers two SIGINTs, milliseconds apart — the terminal's and npm's relay. Only SIGINT escalates:
 * a SIGHUP (the SSH session closing) or a repeated SIGTERM (a service manager) after a Ctrl-C must
 * not cut the drain the operator chose short.
 */

/** The time each step is given before the next, and the signal debounce, in milliseconds. */
export interface ShutdownBudgets {
  /** From the drain to the interrupt. */
  readonly drainMs: number;
  /** From the interrupt to the kill. */
  readonly interruptMs: number;
  /** Signals closer than this to the last one counted are one. */
  readonly debounceMs: number;
}

/**
 * The budgets every start uses: 15 min for the drain, since a BackWPup scenario's timeout grows by
 * 10 min per backup; 4 min from the interrupt to the kill — a 120 s hook, 30 s of fixtures, 30 s of
 * browser close, then the reports; 1 s of debounce, since one Ctrl-C under npm arrives as two SIGINTs
 * 1–31 ms apart.
 */
export const DEFAULT_SHUTDOWN_BUDGETS: ShutdownBudgets = {
  drainMs: 15 * 60_000,
  interruptMs: 4 * 60_000,
  debounceMs: 1_000,
};

/** The signals the orchestrator stops on. */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** One of them. */
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** How far the orchestrator is stopping its runs, and why. */
export type ShutdownState =
  | { readonly level: "running" }
  | {
      readonly level: StopLevel;
      /** What stopped it first: `the orchestrator was stopped (SIGINT)`. */
      readonly cause: string;
      /** Why every run is stopped this far: the cause, and what escalated it. */
      readonly why: string;
      /** When the last signal counted was received, in the clock's milliseconds. */
      readonly lastSignalAt: number;
    };

/** What the reducer is told. */
export type ShutdownEvent =
  | {
      readonly type: "signal";
      readonly signal: ShutdownSignal;
      readonly at: number;
    }
  /** The budget armed with the last step ran out. */
  | { readonly type: "budget"; readonly at: number };

/** A transition's result. */
export interface ShutdownStep {
  readonly state: ShutdownState;
  /** Set when every run must now be stopped further. */
  readonly escalated?: { readonly level: StopLevel; readonly why: string };
  /** The budget to arm now, in milliseconds, replacing any armed; `null` disarms; absent keeps it. */
  readonly budgetMs?: number | null;
}

/**
 * One transition.
 *
 * @param state - how far it is stopping.
 * @param event - a signal, or a budget running out.
 * @param budgets - the budgets and the debounce.
 * @returns the next state, the escalation to apply and the budget to arm.
 */
export function stepShutdown(
  state: ShutdownState,
  event: ShutdownEvent,
  budgets: ShutdownBudgets = DEFAULT_SHUTDOWN_BUDGETS,
): ShutdownStep {
  if (event.type === "budget") return budgetRanOut(state, event.at, budgets);
  if (state.level === "running") {
    const cause = `the orchestrator was stopped (${event.signal})`;
    return {
      state: { level: "drained", cause, why: cause, lastSignalAt: event.at },
      escalated: { level: "drained", why: cause },
      budgetMs: budgets.drainMs,
    };
  }
  const debounced = event.at - state.lastSignalAt < budgets.debounceMs;
  if (event.signal !== "SIGINT" || debounced || state.level === "killed")
    return { state };
  return state.level === "drained"
    ? escalate(
        state,
        "interrupted",
        "a SIGINT while draining",
        event.at,
        budgets,
      )
    : escalate(
        state,
        "killed",
        "a SIGINT while interrupting",
        event.at,
        budgets,
      );
}

/**
 * The armed budget ran out: the next step, without a signal.
 *
 * @param state - the state.
 * @param at - now.
 * @param budgets - the budgets.
 * @returns the escalated step, or the state unchanged when a signal already passed that step.
 */
function budgetRanOut(
  state: ShutdownState,
  at: number,
  budgets: ShutdownBudgets,
): ShutdownStep {
  if (state.level === "drained")
    return escalate(
      state,
      "interrupted",
      `the drain took over ${describeBudget(budgets.drainMs)}`,
      at,
      budgets,
      false,
    );
  if (state.level === "interrupted")
    return escalate(
      state,
      "killed",
      `the interrupt took over ${describeBudget(budgets.interruptMs)}`,
      at,
      budgets,
      false,
    );
  // A budget firing after the step it guarded was passed by a signal: nothing to do.
  return { state };
}

/**
 * One step further.
 *
 * @param state - a stopping state.
 * @param level - the next level.
 * @param because - what escalated it.
 * @param at - now.
 * @param budgets - the budgets.
 * @param bySignal - whether a signal escalated it, which the debounce then counts from.
 * @returns the new state, the escalation to act on, and the next budget (`null` once killed).
 */
function escalate(
  state: Exclude<ShutdownState, { level: "running" }>,
  level: "interrupted" | "killed",
  because: string,
  at: number,
  budgets: ShutdownBudgets,
  bySignal = true,
): ShutdownStep {
  const why = `${state.cause}; ${level === "interrupted" ? "interrupted" : "killed"}: ${because}`;
  return {
    state: {
      level,
      cause: state.cause,
      why,
      lastSignalAt: bySignal ? at : state.lastSignalAt,
    },
    escalated: { level, why },
    budgetMs: level === "interrupted" ? budgets.interruptMs : null,
  };
}

/**
 * A budget in words: `15 min`, `90 s`.
 *
 * @param ms - milliseconds.
 * @returns whole minutes in minutes, anything else in rounded seconds.
 */
export function describeBudget(ms: number): string {
  return ms % 60_000 === 0
    ? `${String(ms / 60_000)} min`
    : `${String(Math.round(ms / 1_000))} s`;
}

/** The timers the driver uses: Node's own, or a fake clock's. */
export interface ShutdownTimers {
  /** A monotonic clock, in ms: what the signals' debounce measures. */
  now(): number;
  /**
   * Arms a budget.
   *
   * @param callback - run once it runs out.
   * @param ms - its length.
   * @returns the handle {@link ShutdownTimers.clearTimeout} takes.
   */
  setTimeout(callback: () => void, ms: number): unknown;
  /**
   * Disarms a budget.
   *
   * @param handle - what {@link ShutdownTimers.setTimeout} returned.
   */
  clearTimeout(handle: unknown): void;
}

/**
 * Node's timers. An armed budget does not keep the process alive by itself: while a run is stopping,
 * its launch's own waits keep the process alive, and once every loop has ended the budget has nothing
 * left to escalate — referenced, it would hold for up to 15 min a process (a spec's, a driver never
 * disposed) that has nothing else to do.
 */
export const NODE_TIMERS: ShutdownTimers = {
  // Monotonic: a wall clock stepped back would read every later signal as within the debounce.
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** The driver. */
export interface Shutdown {
  /**
   * Counts a signal.
   *
   * @param signal - the signal received.
   * @returns the escalation it caused, if any.
   */
  signal(signal: ShutdownSignal): ShutdownStep["escalated"];
  /** How far it is stopping. */
  readonly state: ShutdownState;
  /** Disarms the budget: every run has ended. */
  dispose(): void;
}

/** What the driver needs. */
export interface CreateShutdownOptions {
  /** Called on each escalation, a signal's or a budget's: stop every run this far. */
  readonly onEscalate: (level: StopLevel, why: string) => void;
  readonly timers?: ShutdownTimers;
  readonly budgets?: ShutdownBudgets;
}

/**
 * The reducer, driven: signals in, escalations out, the budget armed and disarmed as it says.
 *
 * @param options - the escalation's callback, the timers and the budgets.
 * @returns the driver.
 */
export function createShutdown(options: CreateShutdownOptions): Shutdown {
  const timers = options.timers ?? NODE_TIMERS;
  const budgets = options.budgets ?? DEFAULT_SHUTDOWN_BUDGETS;
  let state: ShutdownState = { level: "running" };
  let armed: unknown;
  let disposed = false;

  /** Clears the armed budget, if any. */
  const disarm = (): void => {
    if (armed !== undefined) timers.clearTimeout(armed);
    armed = undefined;
  };
  /**
   * Steps the machine on `event` and re-arms the budget it names; nothing once disposed.
   *
   * @param event - a signal or a budget run out.
   * @returns the escalation it caused, if any.
   */
  const apply = (event: ShutdownEvent): ShutdownStep["escalated"] => {
    if (disposed) return undefined;
    const step = stepShutdown(state, event, budgets);
    state = step.state;
    if (step.budgetMs !== undefined) {
      disarm();
      if (step.budgetMs !== null)
        armed = timers.setTimeout(() => {
          armed = undefined;
          apply({ type: "budget", at: timers.now() });
        }, step.budgetMs);
    }
    if (step.escalated !== undefined)
      options.onEscalate(step.escalated.level, step.escalated.why);
    return step.escalated;
  };

  return {
    signal: (signal) => apply({ type: "signal", signal, at: timers.now() }),
    get state() {
      return state;
    },
    dispose: () => {
      disposed = true;
      disarm();
    },
  };
}
