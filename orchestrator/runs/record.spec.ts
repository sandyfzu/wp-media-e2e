import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { finishedEvent } from "../__fixtures__/run-finished";
import type { LeaderStart, LeaderStartReader } from "./leader";
import {
  MAX_RECORD_BYTES,
  RUN_STATES,
  createRecordWriter,
  endedRecord,
  leaderProcess,
  lostRecord,
  MAX_RECORD_WORDS,
  recordWords,
  parseRunRecord,
  readRunRecordFile,
  runningRecord,
  writeRunRecord,
  type RecordWriter,
  type RunningRecordRead,
  type RunRecord,
} from "./record";

/** A leader's start as macOS's `ps` reads it. */
const START = "ps:Tue Oct 13 23:57:39 2026";

const IDENTITY = {
  id: "bpng-12",
  runId: "2026-10-13T10-15-31-042Z-bpng-12",
  startedAt: new Date("2026-10-13T10:15:31.042Z"),
};

/** How the run's processes ended, for an ended record. */
const LAUNCH = {
  bddgen: { code: 0, signal: null },
  stop: { level: "none" },
} as const;

/**
 * A record read back as running, or the test fails.
 *
 * @param record - the record written.
 */
function readBack(record: RunRecord): RunningRecordRead {
  const read = parseRunRecord(JSON.stringify(record), record.id);
  if (read.kind !== "running") throw new Error(`read as ${read.kind}`);
  return read.record;
}

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

  test("a lost record keeps who the run was, its process, when it was found and why", () => {
    const process = {
      name: "playwright",
      pgid: 78,
      leaderStart: START,
    } as const;
    const found = new Date("2026-10-13T11:00:00.000Z");
    expect(
      lostRecord(
        readBack(runningRecord(IDENTITY, "bpng", process)),
        "leader differs",
        found,
      ),
    ).toEqual({
      v: 1,
      state: "lost",
      id: "bpng-12",
      runId: IDENTITY.runId,
      taskId: "bpng",
      startedAt: "2026-10-13T10:15:31.042Z",
      process,
      foundAt: "2026-10-13T11:00:00.000Z",
      reason: "leader differs",
    });
    expect(
      lostRecord(
        readBack(runningRecord(IDENTITY, "bpng")),
        "no process recorded",
        found,
      ),
    ).not.toHaveProperty("process");
  });

  test("is written as JSON", async () => {
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

test.describe("parseRunRecord", () => {
  const running = runningRecord(IDENTITY, "bpng", { name: "bddgen", pgid: 77 });
  const ended = endedRecord(IDENTITY, "bpng", LAUNCH, finishedEvent());
  const over = {
    v: 1,
    id: "bpng-12",
    runId: IDENTITY.runId,
    taskId: "bpng",
    startedAt: "2026-10-13T10:15:31.042Z",
  };

  test("reads a running record back whole", () => {
    expect(parseRunRecord(JSON.stringify(running), "bpng-12")).toEqual({
      kind: "running",
      record: {
        v: 1,
        state: "running",
        id: "bpng-12",
        runId: IDENTITY.runId,
        taskId: "bpng",
        startedAt: "2026-10-13T10:15:31.042Z",
        process: { name: "bddgen", pgid: 77 },
      },
    });
  });

  test("reads the leader's start back, or why it was not read, or neither (an older record)", () => {
    for (const process of [
      { name: "bddgen", pgid: 77, leaderStart: START },
      { name: "playwright", pgid: 77, leaderStartUnread: "gone" },
      {
        name: "playwright",
        pgid: 77,
        leaderStartUnread: "unreadable /proc stat",
      },
      { name: "bddgen", pgid: 77 },
    ] as const)
      expect(
        readBack(runningRecord(IDENTITY, "bpng", process)).process,
      ).toEqual(process);
  });

  test("reads an ended or lost record back as over: its identity, start and state", () => {
    expect(parseRunRecord(JSON.stringify(ended), "bpng-12")).toEqual({
      kind: "over",
      record: { ...over, state: "ended" },
    });
    const lost = lostRecord(
      readBack(running),
      "process group ended",
      new Date("2026-10-13T11:00:00.000Z"),
    );
    expect(parseRunRecord(JSON.stringify(lost), "bpng-12")).toEqual({
      kind: "over",
      record: { ...over, state: "lost" },
    });
    // A running record a person marked over by hand, as the orphan refusal says to.
    expect(
      parseRunRecord(JSON.stringify({ ...running, state: "lost" }), "bpng-12"),
    ).toMatchObject({ kind: "over", record: { state: "lost" } });
    expect(RUN_STATES).toEqual(["running", "ended", "lost"]);
  });

  test("a record is only its own folder's", () => {
    for (const record of [running, ended])
      expect(parseRunRecord(JSON.stringify(record), "bpng-13")).toEqual({
        kind: "malformed",
        why: "another run's record",
      });
  });

  test("anything else is malformed, and says why", () => {
    expect(parseRunRecord("{not json", "bpng-12")).toEqual({
      kind: "malformed",
      why: "not JSON",
    });
    for (const text of [
      "null",
      "[]",
      "",
      JSON.stringify({ ...ended, v: 2 }),
      JSON.stringify({ ...ended, state: "paused" }),
      JSON.stringify({ ...running, v: 2 }),
      // A group id that would reach every process, or the orchestrator's own, is no run's.
      JSON.stringify({ ...running, process: { name: "bddgen", pgid: 1 } }),
      JSON.stringify({ ...running, process: { name: "bddgen", pgid: 0 } }),
      JSON.stringify({ ...running, process: { name: "bddgen", pgid: 7.5 } }),
      JSON.stringify({ ...running, process: { name: "node", pgid: 77 } }),
      // An empty start, or words a message cannot quote.
      JSON.stringify({
        ...running,
        process: { name: "bddgen", pgid: 77, leaderStart: "" },
      }),
      JSON.stringify({
        ...running,
        process: { name: "bddgen", pgid: 77, leaderStartUnread: "a\u001b[2Jb" },
      }),
    ])
      expect(parseRunRecord(text, "bpng-12"), text).toMatchObject({
        kind: "malformed",
      });
  });

  test("reads a record only when every field a message quotes is the orchestrator's, consistent", () => {
    const variants: Record<string, unknown>[] = [
      // Not a task's id, or a run id with a control character in it.
      { taskId: "BPNG" },
      { id: "bpng-12\u001b[2J" },
      { id: "bpng-0", runId: IDENTITY.runId.replace("-12", "-0") },
      // A run of another task, its RUN_ID consistent with that id: only the task tells it.
      { id: "bqng-12", runId: IDENTITY.runId.replace("bpng", "bqng") },
      // A RUN_ID of another run, or none, or of another start.
      { runId: "2026-10-13T10-15-31-042Z-bpng-13" },
      { runId: "not a run id" },
      { runId: "2026-10-13T10-15-31-043Z-bpng-12" },
      // A start in any form but the one the orchestrator writes.
      { startedAt: "yesterday" },
      { startedAt: "2026-10-13T10:15:31.042" },
      { startedAt: "2026-10-13T10:15:31Z" },
      { startedAt: 1 },
    ];
    for (const record of [running, ended])
      for (const variant of variants) {
        const text = JSON.stringify({ ...record, ...variant });
        const id = typeof variant.id === "string" ? variant.id : "bpng-12";
        expect(parseRunRecord(text, id), text).toEqual({
          kind: "malformed",
          why: "not a run record this orchestrator reads",
        });
      }
  });
});

test.describe("readRunRecordFile", () => {
  let dir: string;
  test.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "e2e-record-"));
  });
  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads and sorts a record", async () => {
    const path = join(dir, "run.json");
    await writeRunRecord(path, runningRecord(IDENTITY, "bpng"));
    expect(await readRunRecordFile(path, "bpng-12")).toMatchObject({
      kind: "running",
      record: { id: "bpng-12" },
    });
    await writeFile(path, "{");
    expect(await readRunRecordFile(path, "bpng-12")).toEqual({
      kind: "malformed",
      why: "not JSON",
    });
  });

  test("never through a link, nor a FIFO, nor past its cap", async () => {
    const outside = join(dir, "outside.json");
    await writeRunRecord(outside, runningRecord(IDENTITY, "bpng"));
    const link = join(dir, "link.json");
    await symlink(outside, link);
    expect(await readRunRecordFile(link, "bpng-12")).toEqual({
      kind: "unreadable",
      code: "ELOOP",
    });
    const fifo = join(dir, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    expect(await readRunRecordFile(fifo, "bpng-12")).toEqual({
      kind: "unreadable",
      code: "not a file",
    });
    // 1 MiB and a byte: a literal, so a cap raised by mistake fails here.
    expect(MAX_RECORD_BYTES).toBe(1024 * 1024);
    const large = join(dir, "large.json");
    await writeFile(large, Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect(await readRunRecordFile(large, "bpng-12")).toEqual({
      kind: "tooLarge",
      bytes: 1024 * 1024 + 1,
    });
    expect(await readRunRecordFile(join(dir, "none"), "bpng-12")).toEqual({
      kind: "missing",
    });
  });
});

/**
 * A start reader answering each ask with the next of `answers` (the last repeats), remembering what
 * it was asked.
 *
 * @param answers - its answers, in order.
 */
function reader(
  ...answers: readonly LeaderStart[]
): LeaderStartReader & { asked: number[] } {
  const asked: number[] = [];
  return Object.assign(
    (pid: number) => {
      asked.push(pid);
      const answer = answers[Math.min(asked.length, answers.length) - 1];
      return answer === undefined
        ? Promise.reject(new Error("no answer"))
        : Promise.resolve(answer);
    },
    { asked },
  );
}

test.describe("leaderProcess", () => {
  test("keeps the leader's start, read once", async () => {
    const read = reader({ kind: "start", value: START });
    expect(await leaderProcess("bddgen", 77, read)).toEqual({
      name: "bddgen",
      pgid: 77,
      leaderStart: START,
    });
    expect(read.asked).toEqual([77]);
  });

  test("asks once more when the first read cannot tell", async () => {
    const read = reader(
      { kind: "unknown", why: "EAGAIN" },
      { kind: "start", value: START },
    );
    expect(await leaderProcess("playwright", 78, read)).toEqual({
      name: "playwright",
      pgid: 78,
      leaderStart: START,
    });
    expect(read.asked).toEqual([78, 78]);
  });

  test("records why the start is unread: still unknown, or the leader already gone", async () => {
    const unknown = reader(
      { kind: "unknown", why: "EAGAIN" },
      { kind: "unknown", why: "EACCES" },
    );
    expect(await leaderProcess("bddgen", 77, unknown)).toEqual({
      name: "bddgen",
      pgid: 77,
      leaderStartUnread: "EACCES",
    });
    expect(unknown.asked).toEqual([77, 77]);
    // Gone is an answer: asking again cannot bring it back.
    const gone = reader({ kind: "gone" }, { kind: "start", value: START });
    expect(await leaderProcess("bddgen", 77, gone)).toEqual({
      name: "bddgen",
      pgid: 77,
      leaderStartUnread: "gone",
    });
    expect(gone.asked).toEqual([77]);
  });

  test("records only what the record's reader reads back, so a live run is never passed over as malformed", async () => {
    expect(MAX_RECORD_WORDS).toBe(200);
    const whys = [
      "x".repeat(201),
      "ERR_ü",
      "line\nbreak\u0007",
      "   ",
      "\u202e",
    ];
    for (const why of whys) {
      const process = await leaderProcess(
        "bddgen",
        77,
        reader({ kind: "unknown", why }, { kind: "unknown", why }),
      );
      const read = readBack(runningRecord(IDENTITY, "bpng", process));
      expect(read.process?.leaderStartUnread, why).toBe(recordWords(why));
    }
    // A start the reader would refuse is recorded as unread, never as a start no record reads back.
    for (const value of ["s".repeat(201), "ps:dé"]) {
      const process = await leaderProcess(
        "bddgen",
        77,
        reader({ kind: "start", value }),
      );
      expect(
        readBack(runningRecord(IDENTITY, "bpng", process)).process,
      ).toEqual({
        name: "bddgen",
        pgid: 77,
        leaderStartUnread: "start not recordable",
      });
    }
  });
});

test.describe("recordWords", () => {
  test("keeps printable ASCII as it is", () => {
    expect(recordWords("EACCES")).toBe("EACCES");
    expect(recordWords("y".repeat(200))).toBe("y".repeat(200));
  });

  test("makes each run of other characters one ?, a blank text unknown, and cuts past 200 characters", () => {
    expect(recordWords("ERR_üü\n\tx")).toBe("ERR_?x");
    expect(recordWords(" \n ")).toBe("unknown");
    expect(recordWords("")).toBe("unknown");
    expect(recordWords("z".repeat(201))).toBe(`${"z".repeat(197)}...`);
  });
});

/**
 * A writer whose writes are recorded, each taking as long as asked, on a path that is free.
 *
 * @param fail - the states whose write fails.
 */
function recordingWriter(fail: readonly RunRecord["state"][] = []): {
  writer: RecordWriter;
  written: string[];
} {
  const written: string[] = [];
  const writer = createRecordWriter("run.json", {
    taken: () => Promise.resolve(false),
    write: async (_path, record) => {
      await delay(5);
      if (fail.includes(record.state)) throw new Error("disk full");
      written.push(
        record.state === "running"
          ? `running:${record.process?.name ?? "none"}`
          : "ended",
      );
    },
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
  const ended = endedRecord(IDENTITY, "bpng", LAUNCH, finishedEvent());
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

  test("never overwrites what is already there: a run's record is new", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-record-"));
    try {
      const path = join(dir, "run.json");
      // An earlier run's record, under a number handed out twice.
      await writeRunRecord(path, ended);
      const before = await readFile(path, "utf8");
      const writer = createRecordWriter(path);
      await expect(writer.write(playwright)).rejects.toMatchObject({
        code: "EEXIST",
      });
      await expect(writer.write(ended)).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(await readFile(path, "utf8")).toBe(before);
      // A dangling link is something there too.
      const link = join(dir, "link.json");
      await symlink(join(dir, "nowhere"), link);
      await expect(
        createRecordWriter(link).write(playwright),
      ).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("checks the path once, before its first write: its own writes are no earlier run's", async () => {
    const asked: string[] = [];
    const writer = createRecordWriter("run.json", {
      taken: (path) => {
        asked.push(path);
        return Promise.resolve(asked.length > 1);
      },
      write: () => Promise.resolve(),
    });
    expect(await writer.write(playwright)).toBe("written");
    expect(await writer.write(ended)).toBe("written");
    expect(asked).toEqual(["run.json"]);
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
