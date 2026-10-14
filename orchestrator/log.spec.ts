import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import {
  clockTime,
  createLogger,
  formatLine,
  openLogFile,
  openLogger,
  refuseLogFile,
  type LogFile,
  type Terminal,
} from "./log";

/** A fixed local time, so a line's clock reads the same in every time zone: 10:15:30. */
const AT = new Date(2026, 9, 13, 10, 15, 30);

/** A system error with a code, as Node raises one. */
function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: failed`), { code });
}

/** A file stand-in: what was appended, in order; each append may be held or made to fail. */
function fakeFile(
  append: (text: string) => Promise<void> = () => Promise.resolve(),
) {
  const lines: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let closed = 0;
  const file: LogFile = {
    async append(text) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await append(text);
        lines.push(text);
      } finally {
        inFlight--;
      }
    },
    close() {
      closed++;
      return Promise.resolve();
    },
  };
  return {
    file,
    lines,
    maxInFlight: () => maxInFlight,
    closed: () => closed,
  };
}

/** A terminal collecting what it is written; `fail` makes its writes fail with that code. */
function fakeTerminal(fail?: string) {
  const written: string[] = [];
  const terminal = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (fail !== undefined) {
        callback(systemError(fail));
        return;
      }
      written.push(chunk.toString());
      callback();
    },
  });
  return { terminal, written };
}

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets pending callbacks and `error` events run. */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

test.describe("clockTime", () => {
  test("shows local hours, minutes and seconds, each two digits", () => {
    expect(clockTime(new Date(2026, 9, 13, 9, 5, 3))).toBe("09:05:03");
    expect(clockTime(new Date(2026, 9, 13, 23, 59, 59))).toBe("23:59:59");
  });

  test("shows midnight as 00:00:00, not 24:00:00", () => {
    expect(clockTime(new Date(2026, 9, 14, 0, 0, 0))).toBe("00:00:00");
  });
});

test.describe("formatLine", () => {
  test("reads time, scope, two spaces, then the text", () => {
    expect(formatLine(AT, "bpng", "bpng-12 started")).toBe(
      "10:15:30 bpng  bpng-12 started",
    );
  });

  test("masks a secret value as written, URL-encoded and JSON-escaped, in the text and the scope", () => {
    const secret = 'pa"ss/w rd&12';
    const line = formatLine(
      AT,
      `x${secret}`,
      [
        `plain ${secret}`,
        `url ${encodeURIComponent(secret)}`,
        `json ${JSON.stringify(secret)}`,
        `php ${JSON.stringify(secret).replaceAll("/", "\\/")}`,
      ].join(" "),
      [secret],
    );
    expect(line).toBe('10:15:30 x***  plain *** url *** json "***" php "***"');
  });

  test("masks credentials by their shape, with no value given", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const line = formatLine(
      AT,
      "bpng",
      `https://user:hunter22@example.test/ and ${token}`,
    );
    expect(line).not.toContain("hunter22");
    expect(line).not.toContain(token);
    expect(line).toContain("***");
  });

  test("masks a secret split by a terminal code or a zero-width character", () => {
    const line = formatLine(
      AT,
      "bpng",
      "a secr\u001b[31metvalue1 and secret​value1",
      ["secretvalue1"],
    );
    expect(line).toBe("10:15:30 bpng  a *** and ***");
  });

  test("flattens a text of several lines into one line", () => {
    expect(formatLine(AT, "bpng", "one\ntwo\r\n  three four\tfive")).toBe(
      "10:15:30 bpng  one two three four five",
    );
  });

  test("cuts a text past 2000 code points with an ellipsis", () => {
    const text = formatLine(AT, "bpng", "x".repeat(5000)).split("  ")[1] ?? "";
    expect(Array.from(text)).toHaveLength(2000);
    expect(text.endsWith("…")).toBe(true);
  });
});

test.describe("createLogger", () => {
  test("writes the same line to the terminal and the file", async () => {
    const { file, lines } = fakeFile();
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("orchestrator", "started");
    await logger.flush();
    expect(written).toEqual(["10:15:30 orchestrator  started\n"]);
    expect(lines).toEqual(written);
  });

  test("masks with the given secrets on both outputs", async () => {
    const { file, lines } = fakeFile();
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({
      file,
      terminal,
      now: () => AT,
      secrets: ["webhook-token-123"],
    });
    logger.line("bpng", "slack ✗ webhook-token-123");
    await logger.flush();
    expect(written).toEqual(["10:15:30 bpng  slack ✗ ***\n"]);
    expect(lines).toEqual(written);
  });

  test("writes each line with exactly one line end, even for a text of several lines", async () => {
    const { file, lines } = fakeFile();
    const logger = createLogger({
      file,
      terminal: fakeTerminal().terminal,
      now: () => AT,
    });
    logger.line("bpng", "a\nb\n");
    await logger.flush();
    expect(lines).toEqual(["10:15:30 bpng  a b\n"]);
  });

  test("reads the clock for each line", async () => {
    const { file, lines } = fakeFile();
    const times = [
      new Date(2026, 9, 13, 23, 59, 59),
      new Date(2026, 9, 14, 0, 0, 1),
    ];
    const logger = createLogger({
      file,
      terminal: fakeTerminal().terminal,
      now: () => times.shift() ?? AT,
    });
    logger.line("bpng", "one");
    logger.line("bpng", "two");
    await logger.flush();
    expect(lines).toEqual(["23:59:59 bpng  one\n", "00:00:01 bpng  two\n"]);
  });

  for (const code of ["EPIPE", "EIO"]) {
    test(`stops writing to a terminal whose write fails with ${code}, the file still getting every line`, async () => {
      const { file, lines } = fakeFile();
      const { terminal, written } = fakeTerminal(code);
      let writes = 0;
      const counted: Terminal = {
        write: (chunk, callback) => {
          writes++;
          return terminal.write(chunk, callback);
        },
        on: (event, listener) => terminal.on(event, listener),
      };
      const logger = createLogger({ file, terminal: counted, now: () => AT });
      logger.line("bpng", "one");
      await tick();
      logger.line("bpng", "two");
      logger.line("bpng", "three");
      await logger.flush();
      expect(writes).toBe(1);
      expect(written).toEqual([]);
      expect(lines).toEqual([
        "10:15:30 bpng  one\n",
        `10:15:30 log  terminal gone (${code}): lines go to the file only\n`,
        "10:15:30 bpng  two\n",
        "10:15:30 bpng  three\n",
      ]);
    });
  }

  test("stops writing to a terminal whose write throws", async () => {
    const { file, lines } = fakeFile();
    let writes = 0;
    const terminal: Terminal = {
      write: () => {
        writes++;
        throw systemError("EIO");
      },
      on: () => undefined,
    };
    const logger = createLogger({ file, terminal, now: () => AT });
    expect(() => {
      logger.line("bpng", "one");
    }).not.toThrow();
    logger.line("bpng", "two");
    await logger.flush();
    expect(writes).toBe(1);
    expect(lines).toEqual([
      "10:15:30 bpng  one\n",
      "10:15:30 log  terminal gone (EIO): lines go to the file only\n",
      "10:15:30 bpng  two\n",
    ]);
  });

  test("stops writing to a terminal that reports a failed write only through its callback", async () => {
    const { file, lines } = fakeFile();
    let writes = 0;
    const terminal: Terminal = {
      write: (_chunk, callback) => {
        writes++;
        callback(systemError("EPIPE"));
        return false;
      },
      on: () => undefined,
    };
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "one");
    logger.line("bpng", "two");
    await logger.flush();
    expect(writes).toBe(1);
    expect(lines).toEqual([
      "10:15:30 bpng  one\n",
      "10:15:30 log  terminal gone (EPIPE): lines go to the file only\n",
      "10:15:30 bpng  two\n",
    ]);
  });

  test("stops writing to a terminal that emits an error between writes", async () => {
    const { file, lines } = fakeFile();
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "one");
    // Emitted with no write pending: without the logger's listener this would crash the process.
    terminal.emit("error", systemError("EIO"));
    logger.line("bpng", "two");
    await logger.flush();
    expect(written).toEqual(["10:15:30 bpng  one\n"]);
    expect(lines).toEqual([
      "10:15:30 bpng  one\n",
      "10:15:30 log  terminal gone (EIO): lines go to the file only\n",
      "10:15:30 bpng  two\n",
    ]);
  });

  test("writes the file in call order, one write at a time, however long each takes", async () => {
    const delays = [30, 0, 15, 5, 0, 20];
    const { file, lines, maxInFlight } = fakeFile(
      () => new Promise((r) => setTimeout(r, delays.shift() ?? 0)),
    );
    const logger = createLogger({
      file,
      terminal: fakeTerminal().terminal,
      now: () => AT,
    });
    const expected = ["a", "b", "c", "d", "e", "f"];
    for (const text of expected) logger.line("bpng", text);
    await logger.flush();
    expect(lines).toEqual(expected.map((t) => `10:15:30 bpng  ${t}\n`));
    expect(maxInFlight()).toBe(1);
  });

  test("never throws when the file fails, tells the terminal once, and keeps trying later lines", async () => {
    let failures = 2;
    const { file, lines } = fakeFile(() =>
      failures-- > 0
        ? Promise.reject(systemError("ENOSPC"))
        : Promise.resolve(),
    );
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "one");
    logger.line("bpng", "two");
    logger.line("bpng", "three");
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(written).toEqual([
      "10:15:30 bpng  one\n",
      "10:15:30 bpng  two\n",
      "10:15:30 bpng  three\n",
      "10:15:30 log  writing the log file failed (ENOSPC): its lines may be missing\n",
    ]);
    expect(lines).toEqual(["10:15:30 bpng  three\n"]);
  });

  test("flush waits for every line logged so far", async () => {
    const held = deferred();
    const { file, lines } = fakeFile(() => held.promise);
    const logger = createLogger({
      file,
      terminal: fakeTerminal().terminal,
      now: () => AT,
    });
    logger.line("bpng", "one");
    let flushed = false;
    const flushing = logger.flush().then(() => {
      flushed = true;
    });
    await tick();
    expect(flushed).toBe(false);
    held.resolve();
    await flushing;
    expect(lines).toEqual(["10:15:30 bpng  one\n"]);
  });

  test("close waits for pending lines, closes the file once, and drops later lines", async () => {
    const held = deferred();
    const { file, lines, closed } = fakeFile(() => held.promise);
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "one");
    const closing = logger.close();
    expect(logger.close()).toBe(closing);
    await tick();
    expect(closed()).toBe(0);
    held.resolve();
    await closing;
    expect(closed()).toBe(1);
    logger.line("bpng", "late");
    await logger.flush();
    expect(lines).toEqual(["10:15:30 bpng  one\n"]);
    expect(written).toEqual(["10:15:30 bpng  one\n"]);
  });

  test("close never rejects when the file fails to close", async () => {
    const logger = createLogger({
      file: {
        append: () => Promise.resolve(),
        close: () => Promise.reject(systemError("EIO")),
      },
      terminal: fakeTerminal().terminal,
    });
    await expect(logger.close()).resolves.toBeUndefined();
  });
});

test.describe("refuseLogFile", () => {
  const regular = { uid: 501, nlink: 1, isFile: () => true };

  test("accepts this user's regular file with one link", () => {
    expect(refuseLogFile(regular, 501)).toBeUndefined();
    expect(refuseLogFile(regular, undefined)).toBeUndefined();
  });

  test("refuses another user's file, a second hard link, and anything not a regular file", () => {
    expect(refuseLogFile(regular, 0)).toBe("is another user's");
    expect(refuseLogFile({ ...regular, nlink: 2 }, 501)).toBe(
      "has another hard link",
    );
    expect(refuseLogFile({ ...regular, isFile: () => false }, 501)).toBe(
      "is not a regular file",
    );
  });
});

test.describe("openLogFile and openLogger", () => {
  /** A fresh folder per test, removed after it. */
  let dir: string;
  test.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "e2e-log-"));
  });
  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates the log 0600 even under umask 0, and appends across opens", async () => {
    const path = join(dir, "orchestrator.log");
    const previous = process.umask(0);
    try {
      const first = await openLogger(path, {
        terminal: fakeTerminal().terminal,
        now: () => AT,
      });
      first.line("orchestrator", "started");
      await first.close();
    } finally {
      process.umask(previous);
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const second = await openLogger(path, {
      terminal: fakeTerminal().terminal,
      now: () => AT,
    });
    second.line("orchestrator", "started again");
    await second.close();
    expect(await readFile(path, "utf8")).toBe(
      "10:15:30 orchestrator  started\n10:15:30 orchestrator  started again\n",
    );
  });

  test("tightens a wider mode to 0600, and says so in the first line", async () => {
    const path = join(dir, "orchestrator.log");
    await writeFile(path, "");
    await chmod(path, 0o644);
    const { terminal, written } = fakeTerminal();
    const logger = await openLogger(path, { terminal, now: () => AT });
    await logger.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(written).toEqual([
      `10:15:30 log  ${path} was mode 0644: now 0600\n`,
    ]);
  });

  test("clears a set-id bit when tightening", async () => {
    const path = join(dir, "orchestrator.log");
    await writeFile(path, "");
    await chmod(path, 0o4600);
    const opened = await openLogFile(path);
    await opened.file.close();
    expect(opened.tightenedFrom).toBe(0o4600);
    expect((await stat(path)).mode & 0o7777).toBe(0o600);
  });

  test("leaves a 0600 log's mode and first line alone", async () => {
    const path = join(dir, "orchestrator.log");
    await writeFile(path, "old\n", { mode: 0o600 });
    const opened = await openLogFile(path);
    await opened.file.close();
    expect(opened.tightenedFrom).toBeUndefined();
  });

  test("refuses a symbolic link, leaving its target untouched", async () => {
    const target = join(dir, "target");
    await writeFile(target, "keep\n", { mode: 0o644 });
    const path = join(dir, "orchestrator.log");
    await symlink(target, path);
    await expect(openLogFile(path)).rejects.toThrow(
      `The orchestrator's log cannot be opened (ELOOP): ${path} must be a regular file, not a link, a FIFO or a folder.`,
    );
    expect(await readFile(target, "utf8")).toBe("keep\n");
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  test("refuses a dangling symbolic link without creating its target", async () => {
    const target = join(dir, "nowhere");
    const path = join(dir, "orchestrator.log");
    await symlink(target, path);
    await expect(openLogFile(path)).rejects.toThrow("(ELOOP)");
    await expect(lstat(target)).rejects.toThrow("ENOENT");
  });

  test("refuses a FIFO with no reader at once, never waiting for one", async () => {
    const path = join(dir, "orchestrator.log");
    execFileSync("mkfifo", [path]);
    await expect(openLogFile(path)).rejects.toThrow("(ENXIO)");
  });

  test("refuses a FIFO that has a reader, by its type", async () => {
    const path = join(dir, "orchestrator.log");
    execFileSync("mkfifo", [path]);
    const reader = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      await expect(openLogFile(path)).rejects.toThrow(
        `The orchestrator's log is refused: ${path} is not a regular file.`,
      );
    } finally {
      await reader.close();
    }
  });

  test("refuses a folder", async () => {
    const path = join(dir, "orchestrator.log");
    await mkdir(path);
    await expect(openLogFile(path)).rejects.toThrow("(EISDIR)");
  });

  test("refuses a file with a second hard link, writing nothing into it", async () => {
    const other = join(dir, "other");
    await writeFile(other, "keep\n", { mode: 0o644 });
    const path = join(dir, "orchestrator.log");
    await link(other, path);
    await expect(openLogFile(path)).rejects.toThrow(
      `The orchestrator's log is refused: ${path} has another hard link.`,
    );
    expect(await readFile(other, "utf8")).toBe("keep\n");
    expect((await stat(other)).mode & 0o777).toBe(0o644);
  });

  test("names the open's error code, and closes a handle it refuses", async () => {
    let closed = false;
    const path = join(dir, "orchestrator.log");
    await expect(
      openLogFile(path, () => Promise.reject(systemError("EACCES"))),
    ).rejects.toThrow(
      `The orchestrator's log cannot be opened (EACCES): ${path}.`,
    );
    const handle = await open(path, "w");
    const close = handle.close.bind(handle);
    await expect(
      openLogFile(path, () =>
        Promise.resolve(
          Object.assign(handle, {
            stat: () => Promise.reject(systemError("EIO")),
            close: () => {
              closed = true;
              return close();
            },
          }),
        ),
      ),
    ).rejects.toThrow("EIO");
    expect(closed).toBe(true);
  });

  test("keeps writing the file after the terminal is gone", async () => {
    const path = join(dir, "orchestrator.log");
    const { terminal } = fakeTerminal("EIO");
    const logger = await openLogger(path, { terminal, now: () => AT });
    logger.line("bpng", "one");
    await tick();
    logger.line("bpng", "two");
    await logger.close();
    expect(await readFile(path, "utf8")).toBe(
      [
        "10:15:30 bpng  one",
        "10:15:30 log  terminal gone (EIO): lines go to the file only",
        "10:15:30 bpng  two",
        "",
      ].join("\n"),
    );
  });
});
