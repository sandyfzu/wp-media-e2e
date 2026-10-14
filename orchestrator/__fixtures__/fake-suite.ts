import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { Command } from "../runs/commands";

/**
 * A stand-in for `bddgen` and Playwright's runner, so a run's launch, stop and end are tested with
 * real processes and signals — no Playwright, no site. One Node script, told how to behave by its
 * one argument (JSON). It writes {@link FAKE_LINES}`.ready` once its handlers are installed, then
 * each thing it sees. Its source spells each line in two halves: the run log's header quotes the
 * command, and a whole line in it would read as the fake having written it.
 */

/** How the fake behaves. */
export interface FakeBehaviour {
  /** Exits at once with this code. */
  readonly exitCode?: number;
  /** Otherwise exits `0` after this long, in milliseconds; 60 s by default. */
  readonly runMs?: number;
  /** Ignores SIGINT (writing that it got one), so only SIGKILL ends it. */
  readonly ignoreSigint?: boolean;
  /** Leaves a child in its group that outlives it by this long, then writes `childFile`. */
  readonly childMs?: number;
  /** The file the child writes as it ends. */
  readonly childFile?: string;
  /** Writes its environment's names, sorted, as JSON, to this file. */
  readonly envFile?: string;
  /**
   * Files it writes as it starts, their folders made — a runner's results stream, say — before it
   * exits or waits.
   */
  readonly writes?: readonly { readonly path: string; readonly text: string }[];
}

/** What the fake writes. */
export const FAKE_LINES = {
  ready: "fake ready",
  sigint: "got SIGINT",
  drained: "was drained",
} as const;

/** The fake's source, run by `node -e`; its behaviour is `process.argv[1]`. */
const SCRIPT = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const b = JSON.parse(process.argv[1]);
const say = (text) => process.stdout.write(text + "\n");
if (b.envFile) fs.writeFileSync(b.envFile, JSON.stringify(Object.keys(process.env).sort()));
for (const w of b.writes ?? []) {
  fs.mkdirSync(require("node:path").dirname(w.path), { recursive: true });
  fs.writeFileSync(w.path, w.text);
}
if (b.exitCode !== undefined) process.exit(b.exitCode);
process.on("SIGINT", () => {
  say("got " + "SIGINT");
  if (!b.ignoreSigint) process.exit(130);
});
if (b.childMs !== undefined) {
  const code = "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), " + b.childMs + ")";
  spawn(process.execPath, ["-e", code, b.childFile], { stdio: "ignore" }).unref();
}
const stopFile = process.env.E2E_INTERNAL_STOP_FILE;
setInterval(() => {
  if (stopFile && fs.existsSync(stopFile)) { say("was " + "drained"); process.exit(0); }
}, 10);
setTimeout(() => process.exit(0), b.runMs ?? 60000);
say("fake " + "ready");
`;

/**
 * A command running the fake.
 *
 * @param behaviour - how it behaves.
 */
export function fakeCommand(behaviour: FakeBehaviour = {}): Command {
  return {
    file: process.execPath,
    args: ["-e", SCRIPT, JSON.stringify(behaviour)],
  };
}

/**
 * Waits until a file holds `text`, for at most `timeoutMs`.
 *
 * @param path - the file.
 * @param text - what it must hold.
 * @param timeoutMs - how long at most.
 * @throws {@link Error} when it never does.
 */
export async function waitForText(
  path: string,
  text: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.includes(text)) return content;
    if (Date.now() > deadline)
      throw new Error(
        `${path} never held ${JSON.stringify(text)}:\n${content}`,
      );
    await delay(20);
  }
}
