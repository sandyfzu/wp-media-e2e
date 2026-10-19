import type { StopTaken } from "./outcome";

/**
 * Stopping one run: a pure state machine. It is told what the run is doing (which process runs) and
 * how far the orchestrator wants it stopped; it answers with what to do. Whoever drives it carries
 * the actions out — `launch.ts` with the real `kill`, the specs with none.
 *
 * The escalation is the suite's contract, one step at a time and each at most once:
 *
 * 1. **drain** — create the run's stop file: every scenario's first attempt is skipped from then on,
 *    while the one in flight finishes;
 * 2. **interrupt** — **one** SIGINT to the runner's PID: it stops its tests at once, still writing its
 *    reports (once its tests are over it has no handler left, so the launch then sends none);
 * 3. **kill** — SIGKILL to the runner's whole process group.
 *
 * Never SIGTERM, never a second SIGINT. While `bddgen` runs, its group is killed outright: generation
 * has nothing to drain, and nothing was tested yet — so that stop is taken as `drained`, and the run
 * reads `stopped`, not `killed`. A stop before or between the two processes is taken the same way,
 * and the driver then starts nothing more ({@link mayStartPlaywright}).
 *
 * Once the runner has exited on its own, its group still tearing down (`lingering`), it is past
 * stopping: a drain or an interrupt has nothing left to reach and is not taken, so the runner's own
 * end stays the run's verdict — a crash still reads as one. A kill still SIGKILLs what is left of the
 * group, once, without being taken either. `bddgen` exiting changes nothing: killing its group keeps
 * the runner from starting, a real stop whether `bddgen` itself is still there or not.
 */

/** How far a stop may go. */
export type StopLevel = Exclude<StopTaken["level"], "none">;

/** What the run is doing. */
export type RunPhase =
  | { readonly name: "starting" }
  | { readonly name: "bddgen"; readonly pgid: number }
  | { readonly name: "between" }
  /** The runner: its PID is its group's id, since it is spawned detached. */
  | { readonly name: "playwright"; readonly pid: number }
  /**
   * The runner exited on its own, its group not empty yet. `asked`: the furthest stop asked for so far,
   * the one taken before included — never taken from here on ({@link RunStopState.taken} stays).
   */
  | {
      readonly name: "lingering";
      readonly pgid: number;
      readonly asked: StopTaken["level"];
    }
  | { readonly name: "ended" };

/** The machine's state: the run's phase, and how far it has been stopped. */
export interface RunStopState {
  readonly phase: RunPhase;
  readonly taken: StopTaken;
}

/** What the machine is told. */
export type RunStopEvent =
  /** The orchestrator wants the run stopped at least this far. */
  | { readonly type: "stop"; readonly level: StopLevel; readonly why: string }
  /** A process started: `bddgen` from `starting`, the runner from `between`. */
  | {
      readonly type: "started";
      readonly process: "bddgen" | "playwright";
      readonly pid: number;
    }
  /** The running process itself exited; its group may still hold processes. */
  | { readonly type: "leaderExited" }
  /** The running process's group is empty. */
  | { readonly type: "exited" };

/** What the driver must do. */
export type StopAction =
  | { readonly type: "createStopFile" }
  /** One SIGINT to the runner — never to its group. */
  | { readonly type: "interrupt"; readonly pid: number }
  /** SIGKILL to the whole group. */
  | { readonly type: "killGroup"; readonly pgid: number };

/** A transition's result. */
export interface RunStopStep {
  readonly state: RunStopState;
  readonly actions: readonly StopAction[];
}

/** A run not yet started, not stopped. */
export const INITIAL_RUN_STOP: RunStopState = {
  phase: { name: "starting" },
  taken: { level: "none" },
};

/** Each level's rank: a stop only ever goes further. */
export const STOP_RANK: Readonly<Record<StopTaken["level"], number>> = {
  none: 0,
  drained: 1,
  interrupted: 2,
  killed: 3,
};

/**
 * One transition.
 *
 * @param state - the machine's state.
 * @param event - what happened, or what is asked.
 * @returns the next state, and the actions to carry out, in order.
 * @throws {@link Error} for a process starting or exiting out of order — a driver's bug, never a
 *   run's doing.
 */
export function stepRunStop(
  state: RunStopState,
  event: RunStopEvent,
): RunStopStep {
  switch (event.type) {
    case "stop":
      return stop(state, event.level, event.why);
    case "started":
      return started(state, event.process, event.pid);
    case "leaderExited":
      return leaderExited(state);
    case "exited":
      return exited(state);
  }
}

/**
 * Whether the runner may start once `bddgen` has ended: only while nothing has asked the run to stop.
 *
 * @param state - the machine's state.
 * @returns `true` between the two processes with no stop taken.
 */
export function mayStartPlaywright(state: RunStopState): boolean {
  return state.phase.name === "between" && state.taken.level === "none";
}

/**
 * A stop: as far as asked, from wherever the run is.
 *
 * @param state - the state.
 * @param level - how far.
 * @param why - why, for the run's reason.
 * @returns the new state and its actions; unchanged, with none, for a stop no further than one
 *   taken or a run already ended.
 */
function stop(state: RunStopState, level: StopLevel, why: string): RunStopStep {
  const { phase, taken } = state;
  const unchanged = { state, actions: [] };
  if (phase.name === "lingering") return lingeringStop(state, phase, level);
  if (phase.name === "ended" || STOP_RANK[level] <= STOP_RANK[taken.level])
    return unchanged;
  if (phase.name !== "playwright") {
    // Nothing was tested yet: any stop is a drain, and a drain only once.
    if (taken.level !== "none") return unchanged;
    return {
      state: { phase, taken: { level: "drained", why } },
      actions:
        phase.name === "bddgen"
          ? [{ type: "killGroup", pgid: phase.pgid }]
          : [],
    };
  }
  return {
    state: { phase, taken: { level, why } },
    actions: escalation(taken.level, level, phase.pid),
  };
}

/**
 * A stop once the runner has exited on its own: noted in the phase, never taken — nothing is left to
 * drain or interrupt, and the runner's end is its own. A kill still SIGKILLs what is left of its group.
 *
 * @param state - the state, its stop taken before the runner exited kept.
 * @param phase - its phase, lingering.
 * @param level - how far it is asked to go.
 * @returns the phase with the furthest stop asked, and a kill of the group the first time a kill is
 *   asked; the same state, with none, for a stop no further than one asked before.
 */
function lingeringStop(
  state: RunStopState,
  phase: Extract<RunPhase, { name: "lingering" }>,
  level: StopLevel,
): RunStopStep {
  if (STOP_RANK[level] <= STOP_RANK[phase.asked]) return { state, actions: [] };
  return {
    state: { phase: { ...phase, asked: level }, taken: state.taken },
    actions:
      level === "killed" ? [{ type: "killGroup", pgid: phase.pgid }] : [],
  };
}

/**
 * The runner's steps from one level to a further one. A kill needs nothing before it; an interrupt
 * drains first when the run was not drained yet, so no new scenario starts as the runner winds down.
 *
 * @param from - how far it was stopped.
 * @param to - how far it must be.
 * @param pid - the runner's PID, its group's id.
 * @returns the actions, in the order they must happen.
 */
function escalation(
  from: StopTaken["level"],
  to: StopLevel,
  pid: number,
): StopAction[] {
  if (to === "killed") return [{ type: "killGroup", pgid: pid }];
  const actions: StopAction[] = [];
  if (from === "none") actions.push({ type: "createStopFile" });
  if (to === "interrupted") actions.push({ type: "interrupt", pid });
  return actions;
}

/**
 * A process started. One that starts once a stop was taken is killed at once: the driver should not
 * have started it, and must not leave it running.
 *
 * @param state - the state.
 * @param process - which.
 * @param pid - its PID, its group's id.
 * @returns the new phase, and a kill of its group when a stop was already taken.
 * @throws {@link Error} when that process cannot start in the current phase — a driver bug.
 */
function started(
  state: RunStopState,
  process: "bddgen" | "playwright",
  pid: number,
): RunStopStep {
  const expected = process === "bddgen" ? "starting" : "between";
  if (state.phase.name !== expected)
    throw new Error(
      `A run's ${process} cannot start while it is ${state.phase.name}.`,
    );
  const phase: RunPhase =
    process === "bddgen"
      ? { name: "bddgen", pgid: pid }
      : { name: "playwright", pid };
  return {
    state: { ...state, phase },
    actions:
      state.taken.level === "none" ? [] : [{ type: "killGroup", pgid: pid }],
  };
}

/**
 * The running process itself exited, its group perhaps not empty yet: the runner is then lingering;
 * `bddgen` stays as it was, since killing its group still keeps the runner from starting.
 *
 * @param state - the state.
 * @returns the next phase, with no action.
 * @throws {@link Error} when neither process was running — a driver bug.
 */
function leaderExited(state: RunStopState): RunStopStep {
  const { phase, taken } = state;
  if (phase.name === "bddgen") return { state, actions: [] };
  if (phase.name === "playwright")
    return {
      state: {
        phase: { name: "lingering", pgid: phase.pid, asked: taken.level },
        taken,
      },
      actions: [],
    };
  throw new Error(`A run's process cannot exit while it is ${phase.name}.`);
}

/**
 * The running process's group emptied: after `bddgen`, the run is between its two processes; after
 * the runner, lingering or not, it has ended.
 *
 * @param state - the state.
 * @returns the next phase, with no action.
 * @throws {@link Error} when no process was running — a driver bug.
 */
function exited(state: RunStopState): RunStopStep {
  const { phase } = state;
  if (phase.name === "bddgen")
    return { state: { ...state, phase: { name: "between" } }, actions: [] };
  if (phase.name === "playwright" || phase.name === "lingering")
    return { state: { ...state, phase: { name: "ended" } }, actions: [] };
  throw new Error(`A run cannot exit while it is ${phase.name}.`);
}
