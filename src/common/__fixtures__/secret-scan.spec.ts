import { test, expect } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AdmZip from "adm-zip";

import { findSecret } from "./secret-scan";

/**
 * The search the no-credential canary rests on: a miss here would make "found nowhere" a lie, so
 * every form a report stores a value in is planted and must be found.
 */

const SECRET = "canary0123456789abcdef";

let root = "";

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "secret-scan-"));
});

test.afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A zip holding `entries`, as bytes. */
function zipOf(entries: Record<string, Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(entries)) zip.addFile(name, data);
  return zip.toBuffer();
}

test.describe("findSecret", () => {
  test("finds the secret as text, in a nested folder", () => {
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(
      join(root, "a/b/result.json"),
      `{"title":"Fill \\"${SECRET}\\""}`,
    );
    writeFileSync(join(root, "clean.txt"), "nothing here");
    expect(findSecret(root, SECRET)).toEqual(["a/b/result.json"]);
  });

  test("finds its base64 form at each of the three byte alignments", () => {
    for (const prefix of ["", "x", "xy"]) {
      writeFileSync(
        join(root, `b64-${String(prefix.length)}.txt`),
        Buffer.from(`${prefix}${SECRET}!`).toString("base64"),
      );
    }
    expect(findSecret(root, SECRET).sort()).toEqual([
      "b64-0.txt",
      "b64-1.txt",
      "b64-2.txt",
    ]);
  });

  test("opens zips, nested ones too, naming each entry on the way", () => {
    const inner = zipOf({ "1-trace.trace": Buffer.from(`call ${SECRET}`) });
    writeFileSync(
      join(root, "trace.zip"),
      zipOf({ "inner.zip": inner, "clean.txt": Buffer.from("x") }),
    );
    expect(findSecret(root, SECRET)).toEqual([
      "trace.zip!inner.zip!1-trace.trace",
    ]);
  });

  test("decodes the HTML report's embedded zip", () => {
    const data = zipOf({ "report.json": Buffer.from(`step ${SECRET}`) });
    writeFileSync(
      join(root, "index.html"),
      `<script>window.playwrightReportBase64 = "data:application/zip;base64,${data.toString("base64")}";</script>`,
    );
    expect(findSecret(root, SECRET)).toEqual([
      "index.html!embedded!report.json",
    ]);
  });

  test("never follows a symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "secret-scan-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), SECRET);
      symlinkSync(outside, join(root, "linked-dir"));
      symlinkSync(join(outside, "secret.txt"), join(root, "linked-file"));
      expect(findSecret(root, SECRET)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses a secret short enough to match by chance", () => {
    expect(() => findSecret(root, "short")).toThrow(/match by chance/);
  });
});
