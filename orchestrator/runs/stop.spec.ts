import { test, expect } from "@playwright/test";

import {
  INITIAL_RUN_STOP,
  mayStartPlaywright,
  stepRunStop,
  type RunStopEvent,
  type RunStopState,
  type StopAction,
} from "./stop";

/**
 * Runs events through the machine from its start.
 *
 * @param events - the events, in order.
 * @returns the last state, and every action asked for, in order.
 */
function run(events: readonly RunStopEvent[]): {
  state: RunStopState;
  actions: StopAction[];
} {
  let state = INITIAL_RUN_STOP;
  const actions: StopAction[] = [];
  for (const event of events) {
    const step = stepRunStop(state, event);
    state = step.state;
    actions.push(...step.actions);
  }
  return { state, actions };
}

const BDDGEN: RunStopEvent = { type: "started", process: "bddgen", pid: 100 };
const RUNNER: RunStopEvent = {
  type: "started",
  process: "playwright",
  pid: 200,
};
const EXITED: RunStopEvent = { type: "exited" };
const LEADER_EXITED: RunStopEvent = { type: "leaderExited" };
const toRunner = [BDDGEN, EXITED, RUNNER] as const;

/**
 * A stop event.
 *
 * @param level - how far.
 * @param why - why.
 */
function stop(
  level: "drained" | "interrupted" | "killed",
  why: string = level,
): RunStopEvent {
  return { type: "stop", level, why };
}

test.describe("stepRunStop — the runner", () => {
  test("drains by creating the stop file, and nothing else", () => {
    const { state, actions } = run([...toRunner, stop("drained", "SIGINT")]);
    expect(actions).toEqual([{ type: "createStopFile" }]);
    expect(state.taken).toEqual({ level: "drained", why: "SIGINT" });
  });

  test("escalates one step at a time: stop file, one SIGINT to the runner, SIGKILL to its group", () => {
    const { state, actions } = run([
      ...toRunner,
      stop("drained"),
      stop("interrupted"),
      stop("killed"),
    ]);
    expect(actions).toEqual([
      { type: "createStopFile" },
      { type: "interrupt", pid: 200 },
      { type: "killGroup", pgid: 200 },
    ]);
    expect(state.taken.level).toBe("killed");
  });

  test("drains first when asked to interrupt at once", () => {
    expect(run([...toRunner, stop("interrupted")]).actions).toEqual([
      { type: "createStopFile" },
      { type: "interrupt", pid: 200 },
    ]);
  });

  test("kills the group alone when asked to kill at once", () => {
    expect(run([...toRunner, stop("killed")]).actions).toEqual([
      { type: "killGroup", pgid: 200 },
    ]);
  });

  test("never sends a second SIGINT, nor repeats any step", () => {
    const { state, actions } = run([
      ...toRunner,
      stop("interrupted", "first"),
      stop("interrupted", "again"),
      stop("drained", "lower"),
      stop("killed", "kill"),
      stop("killed", "kill again"),
    ]);
    expect(
      actions.filter((action) => action.type === "interrupt"),
    ).toHaveLength(1);
    expect(
      actions.filter((action) => action.type === "killGroup"),
    ).toHaveLength(1);
    expect(
      actions.filter((action) => action.type === "createStopFile"),
    ).toHaveLength(1);
    expect(state.taken).toEqual({ level: "killed", why: "kill" });
  });

  test("never signals with anything but SIGINT to the runner and SIGKILL to its group", () => {
    const { actions } = run([
      ...toRunner,
      stop("drained"),
      stop("interrupted"),
      stop("killed"),
    ]);
    expect(new Set(actions.map((action) => action.type))).toEqual(
      new Set(["createStopFile", "interrupt", "killGroup"]),
    );
  });

  test("does nothing once the run has ended", () => {
    const { state, actions } = run([...toRunner, EXITED, stop("killed")]);
    expect(actions).toEqual([]);
    expect(state).toEqual({
      phase: { name: "ended" },
      taken: { level: "none" },
    });
  });
});

test.describe("stepRunStop — a runner that exited on its own", () => {
  test("takes no drain nor interrupt: nothing is left to reach, and its own end stands", () => {
    const { state, actions } = run([
      ...toRunner,
      LEADER_EXITED,
      stop("drained"),
      stop("interrupted"),
    ]);
    expect(actions).toEqual([]);
    expect(state).toEqual({
      phase: { name: "lingering", pgid: 200, asked: "interrupted" },
      taken: { level: "none" },
    });
  });

  test("kills what is left of its group, once, without taking the kill", () => {
    const { state, actions } = run([
      ...toRunner,
      LEADER_EXITED,
      stop("killed", "kill"),
      stop("killed", "kill again"),
      stop("interrupted"),
    ]);
    expect(actions).toEqual([{ type: "killGroup", pgid: 200 }]);
    expect(state.taken).toEqual({ level: "none" });
  });

  test("keeps the stop taken before it exited, and never repeats its steps", () => {
    const drained = run([
      ...toRunner,
      stop("drained", "first"),
      LEADER_EXITED,
      stop("drained"),
      stop("killed"),
    ]);
    expect(drained.actions).toEqual([
      { type: "createStopFile" },
      { type: "killGroup", pgid: 200 },
    ]);
    expect(drained.state.taken).toEqual({ level: "drained", why: "first" });
    // Killed before it exited: no second SIGKILL.
    const killed = run([
      ...toRunner,
      stop("killed", "kill"),
      LEADER_EXITED,
      stop("killed", "again"),
    ]);
    expect(killed.actions).toEqual([{ type: "killGroup", pgid: 200 }]);
    expect(killed.state.taken).toEqual({ level: "killed", why: "kill" });
  });

  test("hands back the very same state for a stop no further than one asked: the driver notes only a change", () => {
    const { state } = run([...toRunner, LEADER_EXITED, stop("killed")]);
    expect(stepRunStop(state, stop("killed", "again")).state).toBe(state);
    expect(stepRunStop(state, stop("drained")).state).toBe(state);
  });

  test("ends once its group is empty", () => {
    expect(run([...toRunner, LEADER_EXITED, EXITED]).state).toEqual({
      phase: { name: "ended" },
      taken: { level: "none" },
    });
  });

  test("bddgen exiting changes nothing: a stop still kills its group, taken as a drain", () => {
    const { state, actions } = run([BDDGEN, LEADER_EXITED, stop("drained")]);
    expect(actions).toEqual([{ type: "killGroup", pgid: 100 }]);
    expect(state).toEqual({
      phase: { name: "bddgen", pgid: 100 },
      taken: { level: "drained", why: "drained" },
    });
    expect(mayStartPlaywright(run([BDDGEN, LEADER_EXITED, EXITED]).state)).toBe(
      true,
    );
  });
});

test.describe("stepRunStop — before the runner", () => {
  test("kills bddgen's group outright, taken as a drain whatever was asked", () => {
    const { state, actions } = run([BDDGEN, stop("killed", "SIGINT")]);
    expect(actions).toEqual([{ type: "killGroup", pgid: 100 }]);
    expect(state.taken).toEqual({ level: "drained", why: "SIGINT" });
  });

  test("kills bddgen once, however far the stop then goes", () => {
    const { state, actions } = run([
      BDDGEN,
      stop("drained", "first"),
      stop("interrupted"),
      stop("killed"),
    ]);
    expect(actions).toEqual([{ type: "killGroup", pgid: 100 }]);
    expect(state.taken).toEqual({ level: "drained", why: "first" });
  });

  test("takes a stop before or between the processes as a drain with nothing to do", () => {
    expect(run([stop("interrupted", "early")])).toEqual({
      state: {
        phase: { name: "starting" },
        taken: { level: "drained", why: "early" },
      },
      actions: [],
    });
    expect(run([BDDGEN, EXITED, stop("killed", "between")]).actions).toEqual(
      [],
    );
  });

  test("lets the runner start only between the processes, and only when nothing asked to stop", () => {
    expect(mayStartPlaywright(run([BDDGEN, EXITED]).state)).toBe(true);
    expect(mayStartPlaywright(run([BDDGEN]).state)).toBe(false);
    expect(
      mayStartPlaywright(run([BDDGEN, EXITED, stop("drained")]).state),
    ).toBe(false);
    expect(
      mayStartPlaywright(run([BDDGEN, stop("drained"), EXITED]).state),
    ).toBe(false);
  });

  test("kills a process that starts once a stop was taken", () => {
    expect(run([stop("drained"), BDDGEN]).actions).toEqual([
      { type: "killGroup", pgid: 100 },
    ]);
    expect(run([BDDGEN, EXITED, stop("drained"), RUNNER]).actions).toEqual([
      { type: "killGroup", pgid: 200 },
    ]);
  });
});

test.describe("stepRunStop — a driver's mistakes", () => {
  test("refuses a process starting or exiting out of order", () => {
    expect(() => run([RUNNER])).toThrow(
      /playwright cannot start while it is starting/,
    );
    expect(() => run([BDDGEN, BDDGEN])).toThrow(
      /bddgen cannot start while it is bddgen/,
    );
    expect(() => run([EXITED])).toThrow(/cannot exit while it is starting/);
    expect(() => run([...toRunner, EXITED, EXITED])).toThrow(
      /cannot exit while it is ended/,
    );
    expect(() => run([LEADER_EXITED])).toThrow(
      /process cannot exit while it is starting/,
    );
    expect(() => run([...toRunner, LEADER_EXITED, LEADER_EXITED])).toThrow(
      /process cannot exit while it is lingering/,
    );
    expect(() => run([...toRunner, LEADER_EXITED, RUNNER])).toThrow(
      /playwright cannot start while it is lingering/,
    );
  });
});
