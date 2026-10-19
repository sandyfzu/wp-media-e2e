import { test, expect } from "@playwright/test";

import { ConfigError } from "./errors";
import { configProblems, describeKey, formatPath, parseConfig } from "./parse";

test.describe("describeKey", () => {
  test("shows a name: camelCase, snake_case or UPPER_SNAKE words, 40 at most", () => {
    for (const key of [
      "tasks",
      "cooldownMinutes",
      "serverWarningThreshold",
      "cooldown_minutes",
      "GH_TOKEN",
      "PATH",
      "BWP_",
      "BWP_S3_SECRET_ACCESS_KEY",
      "a".repeat(40),
    ])
      expect(describeKey(key)).toBe(key);
  });

  test("never shows a key shaped like a pasted credential", () => {
    for (const key of [
      "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3", // a legacy GitHub token
      "AKIAIOSFODNN7EXAMPLE", // an AWS key ID
      "Hunter2SuperSecret",
      "Xk9fQ2LmZp7Rt",
      "sk_live_4eC39HqLyjWDarjtT1zdp7dc",
      "_x",
      "token_2",
    ])
      expect(describeKey(key), key).toBe(
        `a key of ${String(key.length)} characters`,
      );
  });

  test("describes anything else by its length alone", () => {
    for (const [key, length] of [
      ["a".repeat(41), 41],
      ["BAD NAME", 8],
      ["1st", 3],
      ["x\ny", 3],
      ["a\u001b[2J", 5],
      ["a-b", 3],
      ["", 0],
    ] as const)
      expect(describeKey(key)).toBe(`a key of ${String(length)} characters`);
  });

  test("never shows a key shaped like a GitHub token", () => {
    for (const key of [
      "ghp_abc",
      "gho_abc",
      "ghu_x",
      "ghs_x",
      "ghr_x",
      "github_pat_x",
    ])
      expect(describeKey(key)).toBe(
        `a key of ${String(key.length)} characters`,
      );
    expect(describeKey("ghx_abc")).toBe("ghx_abc");
  });
});

test.describe("formatPath", () => {
  test("writes a path as an operator would", () => {
    expect(formatPath([])).toBe("(root)");
    expect(formatPath(["tasks"])).toBe("tasks");
    expect(formatPath(["tasks", 1, "cell"])).toBe("tasks[1].cell");
    expect(formatPath(["notifications", "slack", "webhookUrl"])).toBe(
      "notifications.slack.webhookUrl",
    );
    expect(formatPath([0])).toBe("[0]");
  });

  test("describes a key it would not show, in brackets", () => {
    expect(formatPath(["secrets", "BAD NAME"])).toBe(
      "secrets[a key of 8 characters]",
    );
    expect(formatPath(["secrets", "x\n  forged"])).toBe(
      "secrets[a key of 10 characters]",
    );
    expect(formatPath(["1st"])).toBe("[a key of 3 characters]");
    expect(formatPath([Symbol("s")])).toBe("[a key of 9 characters]");
  });
});

test.describe("configProblems", () => {
  test("is a ConfigError: a heading naming the file, then one indented line per problem", () => {
    const error = configProblems("/x/config.json", "is invalid", [
      "a: b",
      "c: d",
    ]);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe(
      "The orchestrator config /x/config.json is invalid:\n  a: b\n  c: d",
    );
  });
});

test.describe("parseConfig", () => {
  test("returns the config with its defaults", () => {
    const config = parseConfig(
      { tasks: [{ id: "bpng", type: "loop", product: "p", cell: "c" }] },
      "/x/config.json",
    );
    expect(config.tasks[0]?.cooldownMinutes).toBe(5);
  });

  test("throws one ConfigError naming the file and every issue, one per line", () => {
    let error: unknown;
    try {
      parseConfig(
        {
          tasks: [{ id: "BPNG", type: "loop", product: "p", cell: "c" }],
          secrets: { NPM_TOKEN: "x" },
        },
        "/x/config.json",
      );
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe(
      [
        "The orchestrator config /x/config.json is invalid:",
        "  tasks[0].id: must be 4 characters: a lowercase letter, then lowercase letters or digits, without 0, o, 1, l or i (e.g. k7qx)",
        "  secrets.NPM_TOKEN: is not a secret a run receives: only GITHUB_TOKEN, GH_TOKEN and BWP_*",
      ].join("\n"),
    );
  });
});
