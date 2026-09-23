import { test, expect } from "@playwright/test";

import { PROBE_FAILURE_TOLERANCE, forgiving } from "./polling";

/**
 * The probe wrapper every wait here shares. What it must never do is the pair of mistakes it sits
 * between: end a ten-minute wait over one dropped connection, or keep a wait on a dead site alive
 * until its budget runs out.
 */

/** A probe that answers from a script of outcomes, one per call: a value, or an error to throw. */
function scripted(outcomes: readonly (number | Error)[]) {
  let call = 0;
  return () => {
    const outcome = outcomes[Math.min(call, outcomes.length - 1)];
    call += 1;
    return outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  };
}

const failure = (n: number): Error =>
  new Error(`dropped connection ${String(n)}`);

test.describe("forgiving", () => {
  test("passes a probe's answer straight through", async () => {
    expect(await forgiving(scripted([7]))()).toBe(7);
  });

  test("reads a failure as no answer yet, as long as the failures do not run on", async () => {
    const probe = forgiving(
      scripted([
        ...Array.from({ length: PROBE_FAILURE_TOLERANCE }, (_, n) =>
          failure(n),
        ),
        5,
      ]),
    );
    for (let n = 0; n < PROBE_FAILURE_TOLERANCE; n++) {
      expect(await probe()).toBeUndefined();
    }
    expect(await probe()).toBe(5);
  });

  test("gives up on the failure after the tolerated run, with that failure's own message", async () => {
    const outcomes = Array.from(
      { length: PROBE_FAILURE_TOLERANCE + 1 },
      (_, n) => failure(n),
    );
    const probe = forgiving(scripted(outcomes));
    for (let n = 0; n < PROBE_FAILURE_TOLERANCE; n++) await probe();
    await expect(probe()).rejects.toThrow(
      `dropped connection ${String(PROBE_FAILURE_TOLERANCE)}`,
    );
  });

  // A flaky link is tolerated indefinitely: only failures with no success between them count.
  test("starts counting again after every success", async () => {
    const outcomes: (number | Error)[] = [];
    for (let round = 0; round < 3; round++) {
      for (let n = 0; n < PROBE_FAILURE_TOLERANCE; n++)
        outcomes.push(failure(n));
      outcomes.push(round);
    }
    const probe = forgiving(scripted(outcomes));
    const answers: (number | undefined)[] = [];
    for (const _outcome of outcomes) answers.push(await probe());
    expect(answers.filter((answer) => answer !== undefined)).toEqual([0, 1, 2]);
  });
});
