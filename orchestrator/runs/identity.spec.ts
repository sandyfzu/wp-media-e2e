import { test, expect } from "@playwright/test";

import { parseRunId } from "../../src/common/config/run-id";
import { runIdOf, runIdentity, type RunIdentityInput } from "./identity";

/** A run of `bpng` on BackWPup's `pro@nginx`. */
const INPUT: RunIdentityInput = {
  taskId: "bpng",
  product: "backwpup",
  cell: "pro@nginx",
  number: 12,
  startedAt: new Date("2026-10-13T10:15:31.042Z"),
  stateDir: "/srv/e2e/.orchestrator",
  checkout: "/srv/e2e",
};

test.describe("runIdOf", () => {
  test("joins the task's id and the run's number", () => {
    expect(runIdOf("bpng", 1)).toBe("bpng-1");
    expect(runIdOf("k7qx", 12_345)).toBe("k7qx-12345");
  });

  test("refuses an id that is not a task's", () => {
    for (const id of ["", "BPNG", "bpn", "bpngx", "0abc", "../x", "bp-g"])
      expect(() => runIdOf(id, 1), id).toThrow(RangeError);
  });

  test("refuses a number that is not a positive safe integer", () => {
    for (const number of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53])
      expect(() => runIdOf("bpng", number), String(number)).toThrow(/from 1/);
  });
});

test.describe("runIdentity", () => {
  test("names the run, its RUN_ID, its folder's files and its report folder", () => {
    expect(runIdentity(INPUT)).toEqual({
      id: "bpng-12",
      runId: "2026-10-13T10-15-31-042Z-bpng-12",
      startedAt: INPUT.startedAt,
      dir: "/srv/e2e/.orchestrator/runs/bpng-12",
      log: "/srv/e2e/.orchestrator/runs/bpng-12/run.log",
      record: "/srv/e2e/.orchestrator/runs/bpng-12/run.json",
      stopFile: "/srv/e2e/.orchestrator/runs/bpng-12/stop",
      reportDir:
        "/srv/e2e/reports/backwpup/pro@nginx/2026-10-13T10-15-31-042Z-bpng-12",
    });
  });

  test("gives a RUN_ID the report pruning dates by the run's start, its suffix the run's id", () => {
    expect(parseRunId(runIdentity(INPUT).runId)).toEqual({
      time: INPUT.startedAt.getTime(),
      suffix: "bpng-12",
    });
  });

  test("refuses a relative state directory or checkout", () => {
    expect(() => runIdentity({ ...INPUT, stateDir: ".orchestrator" })).toThrow(
      /absolute/,
    );
    expect(() => runIdentity({ ...INPUT, checkout: "." })).toThrow(/absolute/);
  });

  test("refuses a start formatRunId cannot name", () => {
    expect(() =>
      runIdentity({ ...INPUT, startedAt: new Date(Number.NaN) }),
    ).toThrow(RangeError);
  });
});
