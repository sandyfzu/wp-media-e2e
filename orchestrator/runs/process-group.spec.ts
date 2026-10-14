import { test, expect } from "@playwright/test";

import {
  groupAlive,
  signalGroup,
  waitForEmptyGroup,
  type KillFn,
} from "./process-group";

/**
 * A system error with a code, as `process.kill` throws.
 *
 * @param code - its code.
 */
function systemError(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code });
}

/**
 * A `kill` that answers each call with the next of `answers`: `undefined` succeeds, a code throws.
 *
 * @param answers - one per call; the last repeats.
 */
function scriptedKill(answers: readonly (string | undefined)[]): {
  kill: KillFn;
  calls: [number, NodeJS.Signals | 0][];
} {
  const calls: [number, NodeJS.Signals | 0][] = [];
  const kill: KillFn = (pid, signal) => {
    calls.push([pid, signal]);
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (answer !== undefined) throw systemError(answer);
  };
  return { kill, calls };
}

test.describe("groupAlive", () => {
  test("asks the group with signal 0, and only ESRCH means empty", () => {
    const alive = scriptedKill([undefined]);
    expect(groupAlive(4242, alive.kill)).toBe(true);
    expect(alive.calls).toEqual([[-4242, 0]]);
    expect(groupAlive(4242, scriptedKill(["ESRCH"]).kill)).toBe(false);
    // A member we may not signal is still a member.
    expect(groupAlive(4242, scriptedKill(["EPERM"]).kill)).toBe(true);
  });

  test("throws any other error", () => {
    expect(() => groupAlive(4242, scriptedKill(["EINVAL"]).kill)).toThrow(
      "kill EINVAL",
    );
  });

  test("refuses an id that would reach the orchestrator's own group or every process", () => {
    const { kill, calls } = scriptedKill([undefined]);
    for (const pgid of [0, 1, -5, 2.5, Number.NaN])
      expect(() => groupAlive(pgid, kill)).toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});

test.describe("signalGroup", () => {
  test("signals the whole group, and an empty group is no error", () => {
    const sent = scriptedKill([undefined]);
    expect(signalGroup(4242, "SIGKILL", sent.kill)).toBe(true);
    expect(sent.calls).toEqual([[-4242, "SIGKILL"]]);
    expect(signalGroup(4242, "SIGKILL", scriptedKill(["ESRCH"]).kill)).toBe(
      false,
    );
    expect(() =>
      signalGroup(4242, "SIGKILL", scriptedKill(["EPERM"]).kill),
    ).toThrow("kill EPERM");
    expect(() => signalGroup(1, "SIGKILL", sent.kill)).toThrow(RangeError);
  });
});

test.describe("waitForEmptyGroup", () => {
  test("asks until the group is empty, sleeping between asks", async () => {
    const { kill, calls } = scriptedKill([undefined, undefined, "ESRCH"]);
    const sleeps: number[] = [];
    const emptied = await waitForEmptyGroup(4242, {
      kill,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      pollMs: 50,
    });
    expect(emptied).toBe(true);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([50, 50]);
  });

  test("gives up once its time limit has passed", async () => {
    const { kill } = scriptedKill([undefined]);
    let slept = 0;
    const emptied = await waitForEmptyGroup(4242, {
      kill,
      sleep: (ms) => {
        slept += ms;
        return Promise.resolve();
      },
      pollMs: 100,
      timeoutMs: 200,
    });
    // It gives up as soon as it has waited its limit: never one poll more.
    expect(emptied).toBe(false);
    expect(slept).toBe(200);
  });
});
