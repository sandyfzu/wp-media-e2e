import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runBegin,
  runEnd,
  scenarioEnd,
  streamOf,
} from "../__fixtures__/results";
import { hasRunEnd, STREAM_END_BYTES, streamHasEnded } from "./stream-end";

/** A fresh folder per test, removed after it. */
let root: string;
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e2e-stream-end-"));
});
test.afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const RUNNING = streamOf([runBegin(2), scenarioEnd("a", "passed")]);
const ENDED = RUNNING + streamOf([runEnd("passed", { total: 1, passed: 1 })]);

test.describe("hasRunEnd", () => {
  test("finds a whole run.end line, and nothing that merely names it", () => {
    expect(hasRunEnd(ENDED)).toBe(true);
    expect(hasRunEnd(RUNNING)).toBe(false);
    // A scenario named "run.end", a line cut short, a value that is not an event.
    expect(
      hasRunEnd(
        streamOf([scenarioEnd("a", "passed", { scenario: '"run.end"' })]),
      ),
    ).toBe(false);
    expect(
      hasRunEnd(streamOf([scenarioEnd("a", "passed", { feature: "run.end" })])),
    ).toBe(false);
    expect(hasRunEnd('{"v":1,"type":"run.end"')).toBe(false);
    expect(hasRunEnd('"run.end"\nnull\n')).toBe(false);
  });
});

test.describe("streamHasEnded", () => {
  test("reads the stream's end", async () => {
    const path = join(root, "results.jsonl");
    await writeFile(path, RUNNING);
    expect(streamHasEnded(path)).toBe(false);
    await writeFile(path, ENDED);
    expect(streamHasEnded(path)).toBe(true);
  });

  test("finds run.end after a stream longer than what it reads", async () => {
    const path = join(root, "results.jsonl");
    await writeFile(path, `${"x".repeat(STREAM_END_BYTES * 4)}\n${ENDED}`);
    expect(streamHasEnded(path)).toBe(true);
  });

  test("reads a missing stream, a folder or a FIFO as not over, without waiting", () => {
    expect(streamHasEnded(join(root, "none"))).toBe(false);
    expect(streamHasEnded(root)).toBe(false);
    const fifo = join(root, "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(streamHasEnded(fifo)).toBe(false);
  });
});
