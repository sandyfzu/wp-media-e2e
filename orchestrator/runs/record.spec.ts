import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finishedEvent } from "../__fixtures__/run-finished";
import {
  endedRecord,
  readRunningRecord,
  runningRecord,
  writeRunRecord,
} from "./record";

const IDENTITY = {
  id: "bpng-12",
  runId: "2026-10-13T10-15-31-042Z-bpng-12",
  startedAt: new Date("2026-10-13T10:15:31.042Z"),
};

test.describe("run records", () => {
  test("a running record names the run, and its group once a process runs", () => {
    expect(runningRecord(IDENTITY, "bpng")).toEqual({
      v: 1,
      state: "running",
      id: "bpng-12",
      runId: IDENTITY.runId,
      taskId: "bpng",
      startedAt: "2026-10-13T10:15:31.042Z",
    });
    expect(
      runningRecord(IDENTITY, "bpng", { name: "playwright", pgid: 4242 })
        .process,
    ).toEqual({
      name: "playwright",
      pgid: 4242,
    });
  });

  test("an ended record keeps how the processes ended, the stop and the event", () => {
    const event = finishedEvent();
    const launch = {
      bddgen: { code: 0, signal: null },
      playwright: { code: 1, signal: null },
      stop: { level: "none" },
    } as const;
    expect(endedRecord(IDENTITY, "bpng", launch, event)).toEqual({
      v: 1,
      state: "ended",
      id: "bpng-12",
      runId: IDENTITY.runId,
      taskId: "bpng",
      startedAt: "2026-10-13T10:15:31.042Z",
      endedAt: event.endedAt,
      ...launch,
      event,
    });
  });

  test("reads back only a record still running: the run lost with its group", () => {
    const running = JSON.stringify(
      runningRecord(IDENTITY, "bpng", { name: "bddgen", pgid: 77 }),
    );
    expect(readRunningRecord(running)).toEqual({
      v: 1,
      state: "running",
      id: "bpng-12",
      process: { name: "bddgen", pgid: 77 },
    });
    const ended = endedRecord(
      IDENTITY,
      "bpng",
      { bddgen: { code: 0, signal: null }, stop: { level: "none" } },
      finishedEvent(),
    );
    expect(readRunningRecord(JSON.stringify(ended))).toBeUndefined();
    expect(readRunningRecord("{not json")).toBeUndefined();
    // A group id that would reach every process, or the orchestrator's own, is no record.
    expect(readRunningRecord(running.replace("77", "1"))).toBeUndefined();
    expect(
      readRunningRecord(
        running.replace('"v": 1', '"v": 2').replace('"v":1', '"v":2'),
      ),
    ).toBeUndefined();
  });

  test("is written as JSON, readable by its owner only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-record-"));
    try {
      const path = join(dir, "run.json");
      await writeRunRecord(path, runningRecord(IDENTITY, "bpng"));
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        state: "running",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
