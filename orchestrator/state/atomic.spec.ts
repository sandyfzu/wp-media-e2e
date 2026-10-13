import { test, expect } from "@playwright/test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic";

/** A fresh folder per test, removed after it. */
let dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-atomic-"));
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test.describe("writeJsonAtomic", () => {
  test("replaces a file with the value's JSON, owner-only, leaving no temporary file", async () => {
    const path = join(dir, "task.json");
    await writeFile(path, "old");
    await writeJsonAtomic(path, { next: 13 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ next: 13 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["task.json"]);
  });

  test("fails without a trace when the value cannot be written, keeping the old file", async () => {
    const path = join(dir, "task.json");
    await writeFile(path, "old");
    await expect(writeJsonAtomic(path, { big: 1n })).rejects.toThrow(TypeError);
    expect(await readFile(path, "utf8")).toBe("old");
    expect(await readdir(dir)).toEqual(["task.json"]);
  });

  test("fails, removing its temporary file, when the target cannot be replaced", async () => {
    // A folder in the way: the rename refuses it.
    const path = join(dir, "busy");
    await writeFile(join(dir, "keep"), "");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(join(path, "inner"), { recursive: true }),
    );
    await expect(writeJsonAtomic(path, { a: 1 })).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(["busy", "keep"]);
  });
});
