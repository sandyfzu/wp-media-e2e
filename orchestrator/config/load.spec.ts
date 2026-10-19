import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import type { CheckedProduct } from "./check";
import { ConfigError } from "./errors";
import {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  MAX_CONFIG_BYTES,
  decodeUtf8,
  modeWarning,
  parseJson,
} from "./load";
import { parseConfig } from "./parse";

/** The repository's root. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** One stand-in product with one real cell. */
const PRODUCTS: readonly CheckedProduct[] = [
  {
    name: "backwpup",
    sites: {
      "pro@nginx": {
        edition: "pro",
        sites: [
          {
            baseURL: "https://a.qa.test",
            username: "admin",
            password: "pw",
            transport: {
              mode: "ssh",
              host: "qa-lnmp",
              username: "ubuntu",
              privateKeyPath: "/k",
              rootDir: "/var/www",
            },
          },
        ],
      },
    },
  },
];

/** A config the stand-in products can run. */
const VALID = {
  tasks: [{ id: "bpng", type: "loop", product: "backwpup", cell: "pro@nginx" }],
  secrets: { GITHUB_TOKEN: "s3cret-token" },
};

/** What `run` rejects with; fails the test when it resolves. */
async function rejectionOf(run: () => Promise<unknown>): Promise<ConfigError> {
  const outcome = await run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ConfigError);
  return outcome as ConfigError;
}

test.describe("loadConfig", () => {
  /** A fresh folder per test, as the state directory. */
  let dir = "";

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-orchestrator-config-"));
  });

  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Writes `content` (JSON unless a string) as `config.json` in `dir`, at `mode`. */
  function writeConfig(content: unknown, mode = 0o600): string {
    const file = join(dir, "config.json");
    writeFileSync(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    chmodSync(file, mode);
    return file;
  }

  test("loads, checks and places the state beside the file", async () => {
    const file = writeConfig(VALID);
    const loaded = await loadConfig(file, PRODUCTS);
    expect(loaded.file).toBe(file);
    expect(loaded.stateDir).toBe(dir);
    expect(loaded.config.secrets).toEqual({ GITHUB_TOKEN: "s3cret-token" });
    expect(loaded.tasks.map(({ task, product }) => [task.id, product])).toEqual(
      [["bpng", PRODUCTS[0]]],
    );
    expect(loaded.warnings).toEqual([]);
  });

  test("resolves a relative path against the working directory", async () => {
    const file = writeConfig(VALID);
    const loaded = await loadConfig(relative(process.cwd(), file), PRODUCTS);
    expect(loaded.file).toBe(file);
  });

  test("warns about a file others can read, and the check's own warnings after it", async () => {
    const file = writeConfig({ ...VALID, serverWarningThreshold: 1 }, 0o644);
    expect((await loadConfig(file, PRODUCTS)).warnings).toEqual([
      `${file} is mode 0644 and holds secrets: chmod 600 ${file}`,
      "qa-lnmp carries 1 task at once (serverWarningThreshold 1): bpng (backwpup pro@nginx)",
    ]);
  });

  test("names a missing file and how to make one", async () => {
    const file = join(dir, "config.json");
    expect((await rejectionOf(() => loadConfig(file, PRODUCTS))).message).toBe(
      `No orchestrator config at ${file}: copy orchestrator/config.example.json there, chmod 600, and fill it in.`,
    );
  });

  test("refuses a folder, a FIFO without hanging on it, and a file too large to be a config", async () => {
    const folder = join(dir, "config.json");
    mkdirSync(folder);
    expect(
      (await rejectionOf(() => loadConfig(folder, PRODUCTS))).message,
    ).toBe(`The orchestrator config ${folder} is not a file.`);
    rmSync(folder, { recursive: true });
    // Nothing ever writes to it: a blocking open would wait forever, and the test time out.
    const fifo = join(dir, "config.json");
    execFileSync("mkfifo", [fifo]);
    expect((await rejectionOf(() => loadConfig(fifo, PRODUCTS))).message).toBe(
      `The orchestrator config ${fifo} is not a file.`,
    );
    rmSync(fifo);
    const file = writeConfig(" ".repeat(MAX_CONFIG_BYTES + 1));
    expect((await rejectionOf(() => loadConfig(file, PRODUCTS))).message).toBe(
      `The orchestrator config ${file} is over the ${String(MAX_CONFIG_BYTES)} bytes a config can be.`,
    );
  });

  test("reads a file of exactly the largest size", async () => {
    const json = JSON.stringify(VALID);
    const file = writeConfig(json + " ".repeat(MAX_CONFIG_BYTES - json.length));
    expect((await loadConfig(file, PRODUCTS)).tasks).toHaveLength(1);
  });

  test("follows a symbolic link, and reads the mode of what it points to", async () => {
    const target = writeConfig(VALID, 0o640);
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    const loaded = await loadConfig(link, PRODUCTS);
    expect(loaded.stateDir).toBe(dir);
    expect(loaded.warnings).toEqual([
      `${link} is mode 0640 and holds secrets: chmod 600 ${link}`,
    ]);
  });

  test("refuses bytes that are not UTF-8 rather than changing a secret", async () => {
    const file = join(dir, "config.json");
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from('{ "secrets": { "BWP_FTP_PASSWORD": "caf'),
        Buffer.from([0xe9]),
        Buffer.from('" } }'),
      ]),
    );
    chmodSync(file, 0o600);
    expect((await rejectionOf(() => loadConfig(file, PRODUCTS))).message).toBe(
      `The orchestrator config ${file} is not UTF-8: save it as UTF-8.`,
    );
  });

  test("refuses a key JSON would lose, before the schema sees what is left", async () => {
    const file = writeConfig(
      '{ "tasks": [], "secrets": { "__proto__": { "GH_TOKEN": "x" } }, "tasks": [] }',
    );
    expect((await rejectionOf(() => loadConfig(file, PRODUCTS))).message).toBe(
      [
        `The orchestrator config ${file} loses keys:`,
        '  secrets: no setting is named "__proto__", and JSON tools drop it',
        '  (root): the key "tasks" appears more than once; JSON keeps only the last',
      ].join("\n"),
    );
  });

  test("names a file it may not read by the error's code", async () => {
    test.skip(process.getuid?.() === 0, "root reads any file");
    const file = writeConfig(VALID, 0o000);
    expect((await rejectionOf(() => loadConfig(file, PRODUCTS))).message).toBe(
      `The orchestrator config ${file} cannot be read (EACCES).`,
    );
  });

  test("never quotes a file that is not JSON", async () => {
    const file = writeConfig('{ "secrets": { "GITHUB_TOKEN": s3cret-token } }');
    const error = await rejectionOf(() => loadConfig(file, PRODUCTS));
    expect(error.message).toBe(
      `The orchestrator config ${file} is not valid JSON.`,
    );
    expect(inspect(error)).not.toContain("s3cret");
  });

  test("passes on the schema's and the check's errors, and reads a file with a byte-order mark", async () => {
    const schema = writeConfig(`\uFEFF${JSON.stringify({ tasks: [] })}`);
    expect(
      (await rejectionOf(() => loadConfig(schema, PRODUCTS))).message,
    ).toBe(
      `The orchestrator config ${schema} is invalid:\n  tasks: must list at least one task`,
    );
    const check = writeConfig({
      tasks: [
        { id: "bpng", type: "loop", product: "backwpup", cell: "free@nginx" },
      ],
    });
    expect((await rejectionOf(() => loadConfig(check, PRODUCTS))).message).toBe(
      `The orchestrator config ${check} names what the suite cannot run:\n  tasks[0].cell: names no cell of backwpup; its cells: pro@nginx`,
    );
  });
});

test.describe("parseJson", () => {
  test("says where a syntax error is when V8 does, and quotes nothing", () => {
    for (const [text, where] of [
      ['{ "a": 1, }', " (at position 10 (line 1 column 11))"],
      ['{ "a": s3cret }', ""],
      ["", ""],
    ] as const) {
      let error: unknown;
      try {
        parseJson(text, "/x/config.json");
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toBe(
        `The orchestrator config /x/config.json is not valid JSON${where}.`,
      );
    }
  });
});

test.describe("decodeUtf8", () => {
  test("decodes UTF-8, dropping a byte-order mark", () => {
    expect(decodeUtf8(Buffer.from('\uFEFF{ "a": "é😀" }'), "/c")).toBe(
      '{ "a": "é😀" }',
    );
  });

  test("refuses a stray byte, a truncated sequence and an encoded surrogate", () => {
    for (const bytes of [
      [0x63, 0xe9],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
    ])
      expect(() => decodeUtf8(Uint8Array.from(bytes), "/c")).toThrow(
        new ConfigError(
          "The orchestrator config /c is not UTF-8: save it as UTF-8.",
        ),
      );
  });
});

test.describe("modeWarning", () => {
  test("quotes a path the shell would split", () => {
    expect(modeWarning(0o100644, "/my e2e/c")).toEqual([
      "/my e2e/c is mode 0644 and holds secrets: chmod 600 '/my e2e/c'",
    ]);
  });

  test("is silent for 0600 and 0400, and names any bit for group or others", () => {
    expect(modeWarning(0o100600, "/c")).toEqual([]);
    expect(modeWarning(0o100400, "/c")).toEqual([]);
    for (const mode of [0o640, 0o604, 0o660, 0o777])
      expect(modeWarning(0o100000 | mode, "/c")).toEqual([
        `/c is mode 0${mode.toString(8)} and holds secrets: chmod 600 /c`,
      ]);
  });
});

test.describe("the defaults and the example", () => {
  test("the default config is .orchestrator/config.json in the checkout", () => {
    expect(DEFAULT_CONFIG_PATH).toBe(
      join(REPO_ROOT, ".orchestrator", "config.json"),
    );
  });

  test("the example is valid, and names cells every fresh checkout has", () => {
    const example = join(REPO_ROOT, "orchestrator", "config.example.json");
    const config = parseConfig(
      JSON.parse(readFileSync(example, "utf8")) as unknown,
      example,
    );
    for (const { product, cell } of config.tasks) {
      const sitesExample = join(
        REPO_ROOT,
        "src/projects",
        product,
        "config/sites.example.json",
      );
      const cells = Object.keys(
        JSON.parse(readFileSync(sitesExample, "utf8")) as object,
      );
      expect(cells, `${product} ${cell}`).toContain(cell);
    }
  });
});
