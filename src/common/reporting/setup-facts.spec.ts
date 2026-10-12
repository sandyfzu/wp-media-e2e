import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonAttachment } from "../__fixtures__/reporter-fakes";
import {
  parsePluginFacts,
  parseSiteFacts,
  readJsonAttachment,
} from "./setup-facts";

/**
 * Reading back what the setups attached: total parsers, so an attachment that is missing or of another
 * shape is "not known", never an error.
 */

/** The artifacts setup's attachment for a passing build, as `reportSummary` writes it. */
const RESOLVED = {
  product: "backwpup",
  cell: "pro@nginx",
  ok: true,
  pluginName: "BackWPup Pro",
  roles: [
    {
      role: "plugin",
      ok: true,
      checks: [{ name: "resolved", ok: true, detail: "ok" }],
      info: {
        source: "default-ref",
        ref: "develop",
        commit: "af1ab5c4d2e6f8a0b1c3d5e7f9a1b3c5d7e9f1a3",
      },
      artifact: {
        role: "plugin",
        slug: "backwpup-pro",
        zipPath: "/repo/.artifacts/backwpup/pro@nginx/plugin/backwpup-pro.zip",
        zipFilename: "backwpup-pro.zip",
        source: "default-ref",
        ref: "develop",
        commit: "af1ab5c4d2e6f8a0b1c3d5e7f9a1b3c5d7e9f1a3",
        version: "9.99.99",
        origin: "cache",
        resolvedAt: "2026-10-12T00:00:00.000Z",
      },
    },
  ],
};

test.describe("readJsonAttachment", () => {
  test("reads a body held in memory, or a file attached by path", () => {
    expect(
      readJsonAttachment(
        { attachments: [jsonAttachment("a.json", { x: 1 })] },
        "a.json",
      ),
    ).toEqual({ x: 1 });

    const dir = mkdtempSync(join(tmpdir(), "e2e-facts-"));
    try {
      const path = join(dir, "b.json");
      writeFileSync(path, "[1]");
      expect(
        readJsonAttachment(
          {
            attachments: [
              { name: "b.json", contentType: "application/json", path },
            ],
          },
          "b.json",
        ),
      ).toEqual([1]);
      // A file that went away, or holds no JSON, is not known.
      expect(
        readJsonAttachment(
          {
            attachments: [
              {
                name: "c.json",
                contentType: "application/json",
                path: join(dir, "missing"),
              },
            ],
          },
          "c.json",
        ),
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path that is not a regular file is not read: a folder, or a FIFO that would block", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-facts-"));
    try {
      const fifo = join(dir, "fifo.json");
      execFileSync("mkfifo", [fifo]);
      for (const path of [dir, fifo]) {
        expect(
          readJsonAttachment(
            {
              attachments: [
                { name: "a.json", contentType: "application/json", path },
              ],
            },
            "a.json",
          ),
          path,
        ).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file larger than any setup's attachment is not read", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-facts-"));
    try {
      const path = join(dir, "big.json");
      writeFileSync(path, `[${"1,".repeat(600_000)}1]`);
      expect(
        readJsonAttachment(
          {
            attachments: [
              { name: "a.json", contentType: "application/json", path },
            ],
          },
          "a.json",
        ),
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing attachment, or a body that is not JSON, is not known", () => {
    expect(readJsonAttachment({ attachments: [] }, "a.json")).toBeUndefined();
    expect(
      readJsonAttachment(
        {
          attachments: [
            {
              name: "a.json",
              contentType: "application/json",
              body: Buffer.from("{nope"),
            },
          ],
        },
        "a.json",
      ),
    ).toBeUndefined();
    expect(
      readJsonAttachment(
        { attachments: [{ name: "a.json", contentType: "application/json" }] },
        "a.json",
      ),
    ).toBeUndefined();
  });
});

test.describe("parsePluginFacts", () => {
  test("a verified build: name, version, ref, full commit, zip, source", () => {
    expect(parsePluginFacts(RESOLVED)).toEqual([
      {
        role: "plugin",
        ok: true,
        name: "BackWPup Pro",
        version: "9.99.99",
        ref: "develop",
        commit: "af1ab5c4d2e6f8a0b1c3d5e7f9a1b3c5d7e9f1a3",
        zip: "backwpup-pro.zip",
        source: "default-ref",
      },
    ]);
  });

  test("a release's pin, from the setup's info", () => {
    const release = structuredClone(RESOLVED);
    const role = release.roles[0];
    if (role === undefined) throw new Error("no role");
    Object.assign(role.info, { pin: "release:5.4.0" });
    expect(parsePluginFacts(release)[0]).toMatchObject({
      pin: "release:5.4.0",
    });
  });

  test("a failed role: its first failing check, one line", () => {
    const failed = {
      ok: false,
      pluginName: "BackWPup Pro",
      roles: [
        {
          role: "plugin",
          ok: false,
          checks: [
            { name: "archive readable", ok: true, detail: "ok" },
            {
              name: "plugin name",
              ok: false,
              detail: 'expected "BackWPup Pro", found "BackWPup".\nmore',
            },
          ],
          info: {},
        },
        { role: "previous", ok: false, checks: [], info: {} },
      ],
    };
    expect(parsePluginFacts(failed)).toEqual([
      {
        role: "plugin",
        ok: false,
        error: 'plugin name: expected "BackWPup Pro", found "BackWPup".',
      },
      { role: "previous", ok: false, error: "verification: failed" },
    ]);
  });

  test("anything else is no fact", () => {
    for (const value of [
      undefined,
      null,
      1,
      "x",
      [],
      {},
      { roles: "x" },
      { roles: [1, { ok: true }] },
    ]) {
      expect(parsePluginFacts(value), JSON.stringify(value)).toEqual([]);
    }
  });
});

test.describe("parseSiteFacts", () => {
  test("each site's versions, or why they are unknown — whitelisted fields only", () => {
    expect(
      parseSiteFacts([
        {
          baseURL: "https://a.example",
          versions: {
            wordpress: "7.1.2",
            php: "8.5.10",
            secret: "nope",
            database: 8,
          },
        },
        {
          baseURL: "https://b.example",
          error: "Site Health did not load\nstack",
        },
        { versions: {} },
        "junk",
      ]),
    ).toEqual([
      {
        baseURL: "https://a.example",
        versions: { wordpress: "7.1.2", php: "8.5.10" },
      },
      { baseURL: "https://b.example", error: "Site Health did not load" },
    ]);
  });

  test("anything but an array is no fact", () => {
    for (const value of [undefined, {}, "x", 1]) {
      expect(parseSiteFacts(value)).toEqual([]);
    }
  });
});
