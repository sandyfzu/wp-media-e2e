import { test, expect } from "@playwright/test";

import {
  createShutdown,
  DEFAULT_SHUTDOWN_BUDGETS,
  NODE_TIMERS,
  describeBudget,
  stepShutdown,
  type ShutdownEvent,
  type ShutdownState,
  type ShutdownTimers,
} from "./shutdown";
import type { StopLevel } from "./stop";

/** A clock the test moves by hand, with the timers armed on it. */
class FakeClock implements ShutdownTimers {
  private time = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private next = 1;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** How many timers are armed. */
  get armed(): number {
    return this.timers.size;
  }

  /**
   * Moves the clock, firing each timer due on the way.
   *
   * @param ms - how far.
   */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = end;
  }
}

/** A driver on a fake clock, with every escalation it made. */
function driver(): {
  clock: FakeClock;
  shutdown: ReturnType<typeof createShutdown>;
  escalations: { level: StopLevel; why: string }[];
} {
  const clock = new FakeClock();
  const escalations: { level: StopLevel; why: string }[] = [];
  const shutdown = createShutdown({
    timers: clock,
    onEscalate: (level, why) => escalations.push({ level, why }),
  });
  return { clock, shutdown, escalations };
}

const { drainMs, interruptMs } = DEFAULT_SHUTDOWN_BUDGETS;
const CAUSE = "the orchestrator was stopped (SIGINT)";

test.describe("createShutdown", () => {
  test("drains on the first SIGINT, interrupts once the drain's budget runs out, then kills", () => {
    const { clock, shutdown, escalations } = driver();
    shutdown.signal("SIGINT");
    expect(escalations).toEqual([{ level: "drained", why: CAUSE }]);
    clock.advance(drainMs - 1);
    expect(escalations).toHaveLength(1);
    clock.advance(1);
    expect(escalations[1]).toEqual({
      level: "interrupted",
      why: `${CAUSE}; interrupted: the drain took over 15 min`,
    });
    clock.advance(interruptMs);
    expect(escalations[2]).toEqual({
      level: "killed",
      why: `${CAUSE}; killed: the interrupt took over 4 min`,
    });
    expect(clock.armed).toBe(0);
  });

  test("interrupts on a second SIGINT and kills on a third, each at once", () => {
    const { clock, shutdown, escalations } = driver();
    shutdown.signal("SIGINT");
    clock.advance(5_000);
    shutdown.signal("SIGINT");
    clock.advance(5_000);
    shutdown.signal("SIGINT");
    expect(escalations.map((escalation) => escalation.level)).toEqual([
      "drained",
      "interrupted",
      "killed",
    ]);
    expect(escalations[1]?.why).toBe(
      `${CAUSE}; interrupted: a SIGINT while draining`,
    );
    expect(escalations[2]?.why).toBe(
      `${CAUSE}; killed: a SIGINT while interrupting`,
    );
    // The kill disarmed the interrupt's budget; nothing fires later.
    expect(clock.armed).toBe(0);
  });

  test("counts SIGINTs less than a second after the last one counted as one", () => {
    const { clock, shutdown, escalations } = driver();
    shutdown.signal("SIGINT");
    clock.advance(31);
    shutdown.signal("SIGINT");
    clock.advance(968);
    shutdown.signal("SIGINT");
    expect(escalations).toHaveLength(1);
    clock.advance(1);
    shutdown.signal("SIGINT");
    expect(escalations.map((escalation) => escalation.level)).toEqual([
      "drained",
      "interrupted",
    ]);
  });

  test("restarts the interrupt's budget from a SIGINT, not from the drain", () => {
    const { clock, shutdown, escalations } = driver();
    shutdown.signal("SIGINT");
    clock.advance(drainMs - 10_000);
    shutdown.signal("SIGINT");
    clock.advance(10_000);
    expect(escalations).toHaveLength(2);
    clock.advance(interruptMs - 10_000);
    expect(escalations.at(-1)?.level).toBe("killed");
  });

  test("drains on SIGTERM or SIGHUP, which then never escalate", () => {
    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
      const { clock, shutdown, escalations } = driver();
      shutdown.signal(signal);
      clock.advance(2_000);
      shutdown.signal("SIGTERM");
      shutdown.signal("SIGHUP");
      expect(escalations).toEqual([
        { level: "drained", why: `the orchestrator was stopped (${signal})` },
      ]);
      // A SIGINT still escalates.
      shutdown.signal("SIGINT");
      expect(escalations.at(-1)?.level).toBe("interrupted");
    }
  });

  test("ignores a SIGHUP after a Ctrl-C: closing the session does not cut the drain short", () => {
    const { clock, shutdown, escalations } = driver();
    shutdown.signal("SIGINT");
    clock.advance(5_000);
    expect(shutdown.signal("SIGHUP")).toBeUndefined();
    expect(escalations).toHaveLength(1);
  });

  test("does nothing after the kill, nor once disposed", () => {
    const { clock, shutdown, escalations } = driver();
    for (let i = 0; i < 3; i++) {
      shutdown.signal("SIGINT");
      clock.advance(2_000);
    }
    shutdown.signal("SIGINT");
    expect(escalations).toHaveLength(3);
    const second = driver();
    second.shutdown.signal("SIGINT");
    second.shutdown.dispose();
    expect(second.clock.armed).toBe(0);
    second.clock.advance(drainMs * 2);
    second.clock.advance(2_000);
    second.shutdown.signal("SIGINT");
    expect(second.escalations).toHaveLength(1);
  });

  test("reports its state", () => {
    const { shutdown } = driver();
    expect(shutdown.state).toEqual({ level: "running" });
    shutdown.signal("SIGTERM");
    expect(shutdown.state).toMatchObject({
      level: "drained",
      cause: "the orchestrator was stopped (SIGTERM)",
    });
  });
});

test.describe("stepShutdown", () => {
  const drained: ShutdownState = {
    level: "drained",
    cause: CAUSE,
    why: CAUSE,
    lastSignalAt: 0,
  };

  test("ignores a budget running out when there is nothing it guarded", () => {
    const event: ShutdownEvent = { type: "budget", at: 10 };
    expect(stepShutdown({ level: "running" }, event)).toEqual({
      state: { level: "running" },
    });
    const killed: ShutdownState = { ...drained, level: "killed" };
    expect(stepShutdown(killed, event)).toEqual({ state: killed });
  });

  test("keeps the debounce counted from the last signal, not from a budget's escalation", () => {
    const step = stepShutdown(drained, { type: "budget", at: drainMs });
    expect(step.state).toMatchObject({ level: "interrupted", lastSignalAt: 0 });
  });

  test("takes its budgets as given", () => {
    const budgets = { drainMs: 1_000, interruptMs: 90_000, debounceMs: 0 };
    const step = stepShutdown(
      { level: "running" },
      { type: "signal", signal: "SIGINT", at: 0 },
      budgets,
    );
    expect(step.budgetMs).toBe(1_000);
    const next = stepShutdown(
      step.state,
      { type: "budget", at: 1_000 },
      budgets,
    );
    expect(next.escalated?.why).toBe(
      `${CAUSE}; interrupted: the drain took over 1 s`,
    );
    expect(next.budgetMs).toBe(90_000);
  });
});

test.describe("NODE_TIMERS", () => {
  test("reads a monotonic clock, never the wall clock an NTP step can move back", () => {
    expect(Math.abs(NODE_TIMERS.now() - performance.now())).toBeLessThan(1_000);
  });
});

test.describe("describeBudget", () => {
  test("says whole minutes in minutes, anything else in seconds", () => {
    expect(describeBudget(15 * 60_000)).toBe("15 min");
    expect(describeBudget(90_000)).toBe("90 s");
    expect(describeBudget(1_000)).toBe("1 s");
  });
});
