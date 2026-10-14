import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { finishedEvent } from "../__fixtures__/run-finished";
import type { LeaderStart, LeaderStartReader } from "./leader";
import {
  createRecordWriter,
  endedRecord,
  leaderProcess,
  lostRecord,
  matchLeader,
  readRecord,
  readRecordSummary,
  readRunningRecord,
  runningRecord,
  writeRunRecord,
  type RecordWriter,
  type RunRecord,
} from "./record";

/** Fails a test that reached a value it should not have. */
function assertNever(): never {
  throw new Error("unreachable");
}

/** A leader's start as macOS's `ps` reads it. */
const START = "ps:Tue Oct 13 23:57:39 2026";

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
      runId: IDENTITY.runId,
      taskId: "bpng",
      startedAt: "2026-10-13T10:15:31.042Z",
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

  test("sorts a record's text: running, over, or malformed", () => {
    const running = runningRecord(IDENTITY, "bpng", {
      name: "bddgen",
      pgid: 77,
    });
    expect(readRecord(JSON.stringify(running)).kind).toBe("running");
    const ended = endedRecord(
      IDENTITY,
      "bpng",
      { bddgen: { code: 0, signal: null }, stop: { level: "none" } },
      finishedEvent(),
    );
    expect(readRecord(JSON.stringify(ended))).toEqual({ kind: "over" });
    const lost = lostRecord(
      readRunningRecord(JSON.stringify(running)) ?? assertNever(),
      "process group ended",
      new Date("2026-10-13T11:00:00.000Z"),
    );
    expect(readRecord(JSON.stringify(lost))).toEqual({ kind: "over" });
    for (const text of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ ...ended, v: 2 }),
      JSON.stringify({ ...ended, state: "paused" }),
      JSON.stringify({ ...running, v: 2 }),
    ])
      expect(readRecord(text)).toEqual({ kind: "malformed" });
  });

  test("reads a running record only when every field a message quotes is the orchestrator's", () => {
    const running = runningRecord(IDENTITY, "bpng", {
      name: "bddgen",
      pgid: 77,
    });
    const variants: Record<string, unknown>[] = [
      // Not a task's id, or a run id with a control character in it.
      { ...running, taskId: "BPNG" },
      { ...running, id: "bpng-12\u001b[2J" },
      // A run of another task, or a RUN_ID that is not this run's.
      { ...running, id: "bqng-12" },
      { ...running, runId: "2026-10-13T10-15-31-042Z-bpng-13" },
      { ...running, runId: "not a run id" },
      { ...running, startedAt: "yesterday" },
      { ...running, id: "bpng-0", runId: IDENTITY.runId.replace("-12", "-0") },
    ];
    for (const variant of variants)
      expect(readRecord(JSON.stringify(variant))).toEqual({
        kind: "malformed",
      });
  });

  test("a lost record keeps who the run was, when it was found and why", () => {
    const read =
      readRunningRecord(
        JSON.stringify(
          runningRecord(IDENTITY, "bpng", {
            name: "playwright",
            pgid: 78,
            leaderStart: START,
          }),
        ),
      ) ?? assertNever();
    expect(
      lostRecord(read, "leader differs", new Date("2026-10-13T11:00:00.000Z")),
    ).toEqual({
      v: 1,
      state: "lost",
      id: "bpng-12",
      runId: IDENTITY.runId,
      taskId: "bpng",
      startedAt: "2026-10-13T10:15:31.042Z",
      foundAt: "2026-10-13T11:00:00.000Z",
      reason: "leader differs",
    });
  });

  test("reads back the leader's start, and a record without one", () => {
    const process = { name: "bddgen", pgid: 77, leaderStart: START } as const;
    expect(
      readRunningRecord(
        JSON.stringify(runningRecord(IDENTITY, "bpng", process)),
      )?.process,
    ).toEqual(process);
    // Written before the start was recorded, or when it could not be read.
    expect(
      readRunningRecord(
        JSON.stringify(
          runningRecord(IDENTITY, "bpng", { name: "bddgen", pgid: 77 }),
        ),
      )?.process,
    ).toEqual({ name: "bddgen", pgid: 77 });
    expect(
      readRunningRecord(
        JSON.stringify(
          runningRecord(IDENTITY, "bpng", { ...process, leaderStart: "" }),
        ),
      ),
    ).toBeUndefined();
  });

  test("reads back any record's identity, start and state, and nothing that is not a record", () => {
    const summary = {
      v: 1,
      id: "bpng-12",
      taskId: "bpng",
      startedAt: "2026-10-13T10:15:31.042Z",
    };
    const running = JSON.stringify(runningRecord(IDENTITY, "bpng"));
    expect(readRecordSummary(running)).toEqual({
      ...summary,
      state: "running",
    });
    const ended = JSON.stringify(
      endedRecord(
        IDENTITY,
        "bpng",
        { bddgen: { code: 0, signal: null }, stop: { level: "none" } },
        finishedEvent(),
      ),
    );
    expect(readRecordSummary(ended)).toEqual({ ...summary, state: "ended" });
    expect(readRecordSummary("{not json")).toBeUndefined();
    expect(readRecordSummary("null")).toBeUndefined();
    expect(
      readRecordSummary(JSON.stringify({ ...summary, state: "paused" })),
    ).toBeUndefined();
    expect(
      readRecordSummary(JSON.stringify({ ...summary, v: 2, state: "ended" })),
    ).toBeUndefined();
    // No start, or one that is no text: no record.
    expect(
      readRecordSummary(
        JSON.stringify({ v: 1, id: "bpng-12", taskId: "bpng", state: "ended" }),
      ),
    ).toBeUndefined();
    expect(
      readRecordSummary(
        JSON.stringify({ ...summary, startedAt: 1, state: "ended" }),
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

/**
 * A start reader answering this for every PID, and remembering what it was asked.
 *
 * @param answer - its answer.
 */
function reader(answer: LeaderStart): LeaderStartReader & { asked: number[] } {
  const asked: number[] = [];
  return Object.assign(
    (pid: number) => {
      asked.push(pid);
      return Promise.resolve(answer);
    },
    { asked },
  );
}

test.describe("the leader", () => {
  const recorded = {
    process: { name: "playwright", pgid: 4242, leaderStart: START },
  } as const;

  test("matches only the process that started when the record says", async () => {
    const same = reader({ kind: "start", value: START });
    expect(await matchLeader(recorded, same)).toBe("matches");
    expect(same.asked).toEqual([4242]);
  });

  test("a reused PID — another start — or no process at all differs", async () => {
    expect(
      await matchLeader(
        recorded,
        reader({ kind: "start", value: "ps:Tue Oct 13 23:58:00 2026" }),
      ),
    ).toBe("differs");
    expect(await matchLeader(recorded, reader({ kind: "gone" }))).toBe(
      "differs",
    );
  });

  test("a start not recorded can never match; one unreadable now is said so", async () => {
    const alive = reader({ kind: "start", value: START });
    expect(
      await matchLeader({ process: { name: "bddgen", pgid: 4242 } }, alive),
    ).toBe("unrecorded");
    expect(await matchLeader({}, alive)).toBe("unrecorded");
    expect(alive.asked).toEqual([]);
    expect(
      await matchLeader(
        recorded,
        reader({ kind: "unknown", why: "timed out" }),
      ),
    ).toBe("unreadable");
  });

  test("a process's record keeps its leader's start, or none when unreadable", async () => {
    expect(
      await leaderProcess(
        "bddgen",
        77,
        reader({ kind: "start", value: START }),
      ),
    ).toEqual({ name: "bddgen", pgid: 77, leaderStart: START });
    expect(await leaderProcess("bddgen", 77, reader({ kind: "gone" }))).toEqual(
      { name: "bddgen", pgid: 77 },
    );
    expect(
      await leaderProcess(
        "bddgen",
        77,
        reader({ kind: "unknown", why: "EACCES" }),
      ),
    ).toEqual({ name: "bddgen", pgid: 77 });
  });
});

/**
 * A writer whose writes are recorded, each taking as long as asked.
 *
 * @param fail - the states whose write fails.
 */
function recordingWriter(fail: readonly RunRecord["state"][] = []): {
  writer: RecordWriter;
  written: string[];
} {
  const written: string[] = [];
  const writer = createRecordWriter("run.json", async (_path, record) => {
    await delay(5);
    if (fail.includes(record.state)) throw new Error("disk full");
    written.push(
      record.state === "running"
        ? `running:${record.process?.name ?? "none"}`
        : "ended",
    );
  });
  return { writer, written };
}

/**
 * A record resolved after `ms`.
 *
 * @param record - the record.
 * @param ms - when.
 */
async function later(record: RunRecord, ms: number): Promise<RunRecord> {
  await delay(ms);
  return record;
}

test.describe("the record writer", () => {
  const ended = endedRecord(
    IDENTITY,
    "bpng",
    { bddgen: { code: 0, signal: null }, stop: { level: "none" } },
    finishedEvent(),
  );
  const playwright = runningRecord(IDENTITY, "bpng", {
    name: "playwright",
    pgid: 78,
  });

  test("applies writes in the order asked, however long each takes to be ready", async () => {
    const { writer, written } = recordingWriter();
    const results = await Promise.all([
      writer.write(runningRecord(IDENTITY, "bpng")),
      // A leader's start read slowly: the next write still waits for it.
      writer.write(
        later(
          runningRecord(IDENTITY, "bpng", { name: "bddgen", pgid: 77 }),
          30,
        ),
      ),
      writer.write(playwright),
    ]);
    expect(results).toEqual(["written", "written", "written"]);
    expect(written).toEqual([
      "running:none",
      "running:bddgen",
      "running:playwright",
    ]);
  });

  test("drops a running record asked for after the end: a late onProcess never replaces it", async () => {
    const { writer, written } = recordingWriter();
    const results = await Promise.all([
      writer.write(ended),
      writer.write(playwright),
      writer.write(later(playwright, 10)),
    ]);
    expect(results).toEqual(["written", "dropped", "dropped"]);
    expect(written).toEqual(["ended"]);
  });

  test("still drops it when the end's write failed: the run is over either way", async () => {
    const { writer, written } = recordingWriter(["ended"]);
    const end = writer.write(ended);
    const late = writer.write(playwright);
    await expect(end).rejects.toThrow("disk full");
    expect(await late).toBe("dropped");
    expect(written).toEqual([]);
  });

  test("a failed write, or a record that never came, rejects alone: the next still applies", async () => {
    const { writer, written } = recordingWriter(["running"]);
    const failed = writer.write(playwright);
    const never = writer.write(
      (async (): Promise<RunRecord> => {
        await delay(5);
        throw new Error("no record");
      })(),
    );
    const end = writer.write(ended);
    await expect(failed).rejects.toThrow("disk full");
    await expect(never).rejects.toThrow("no record");
    expect(await end).toBe("written");
    expect(written).toEqual(["ended"]);
  });

  test("writes the file through the atomic write by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-record-"));
    try {
      const path = join(dir, "run.json");
      const writer = createRecordWriter(path);
      await Promise.all([writer.write(ended), writer.write(playwright)]);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        state: "ended",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
