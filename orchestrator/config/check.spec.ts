import { test, expect } from "@playwright/test";

import { checkConfig, serverOf, type CheckedProduct } from "./check";
import { ConfigError } from "./errors";
import { configSchema, type OrchestratorConfig } from "./schema";

/** A site on `host` over SSH, at `baseURL`. */
function sshSite(
  baseURL: string,
  host: string,
): CheckedProduct["sites"][string]["sites"][number] {
  return {
    baseURL,
    username: "admin",
    password: "pw",
    transport: {
      mode: "ssh",
      host,
      username: "ubuntu",
      privateKeyPath: "/k",
      rootDir: "/var/www",
    },
  };
}

/** Stand-in products: BackWPup with real, placeholder, mixed and empty cells; WP Rocket in Docker. */
const PRODUCTS: readonly CheckedProduct[] = [
  {
    name: "backwpup",
    sites: {
      "pro@nginx": {
        edition: "pro",
        sites: [
          sshSite("https://a.qa.test", "QA-LNMP"),
          sshSite("https://b.qa.test", "qa-lnmp"),
        ],
      },
      "free@nginx": {
        edition: "free",
        sites: [sshSite("https://c.qa.test", "qa-lnmp")],
      },
      "free@apache": {
        edition: "free",
        sites: [sshSite("https://d.qa.test", "qa-apache")],
      },
      "pro@apache": {
        edition: "pro",
        sites: [sshSite("https://pro.example.test", "localhost")],
      },
      mixed: {
        edition: "pro",
        sites: [
          sshSite("https://e.qa.test", "qa-lnmp"),
          sshSite("https://f.example.test", "localhost"),
        ],
      },
      empty: { edition: "pro", sites: [] },
    },
  },
  {
    name: "wp-rocket",
    sites: {
      nginx: {
        sites: [
          {
            baseURL: "http://localhost:8101",
            username: "admin",
            password: "pw",
            transport: { mode: "docker", container: "wp-nginx" },
          },
        ],
      },
    },
  },
];

/** A schema-checked config of these tasks (`[id, product, cell]`), with `extra` at its root. */
function configOf(
  tasks: readonly (readonly [
    string,
    string,
    string,
    Record<string, unknown>?,
  ])[],
  extra: Record<string, unknown> = {},
): OrchestratorConfig {
  return configSchema.parse({
    tasks: tasks.map(([id, product, cell, fields]) => ({
      id,
      type: "loop",
      product,
      cell,
      ...fields,
    })),
    ...extra,
  });
}

/** `checkConfig`'s ConfigError message for `config`; fails the test when it does not throw. */
function problemsOf(config: OrchestratorConfig): string {
  try {
    checkConfig(config, PRODUCTS, "/x/config.json");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error("expected a ConfigError");
}

test.describe("checkConfig", () => {
  test("joins each task to its product and cell, servers once each in pool order", () => {
    const { tasks, warnings } = checkConfig(
      configOf([
        ["bpng", "backwpup", "pro@nginx"],
        ["wrng", "wp-rocket", "nginx"],
      ]),
      PRODUCTS,
      "/x/config.json",
    );
    expect(warnings).toEqual([]);
    expect(tasks.map(({ task }) => task.id)).toEqual(["bpng", "wrng"]);
    expect(tasks[0]?.product).toBe(PRODUCTS[0]);
    expect(tasks[0]?.cell).toBe(PRODUCTS[0]?.sites["pro@nginx"]);
    expect(tasks[0]?.servers).toEqual(["qa-lnmp"]);
    expect(tasks[1]?.servers).toEqual(["this machine"]);
  });

  test("refuses an unknown product by its path, naming the suite's — never quoting what was written", () => {
    expect(
      problemsOf(
        configOf([["bpng", "ghp_pastedTokenInTheWrongPlace", "nginx"]]),
      ),
    ).toBe(
      [
        "The orchestrator config /x/config.json names what the suite cannot run:",
        "  tasks[0].product: names no product of the suite; its products: backwpup, wp-rocket",
      ].join("\n"),
    );
  });

  test("refuses an unknown cell by its path, naming the product's — an inherited name included", () => {
    for (const cell of ["pro@lamp", "constructor", "__proto__", "toString"])
      expect(problemsOf(configOf([["bpng", "wp-rocket", cell]]))).toBe(
        [
          "The orchestrator config /x/config.json names what the suite cannot run:",
          "  tasks[0].cell: names no cell of wp-rocket; its cells: nginx",
        ].join("\n"),
      );
  });

  test("refuses a cell with any placeholder site, or with none", () => {
    expect(
      problemsOf(configOf([["bpap", "backwpup", "pro@apache"]])),
    ).toContain(
      "  tasks[0].cell: backwpup pro@apache has 1 placeholder site (.example.test) of 1: every site a run binds to must be real — declare the cell's real sites in the product's sites file",
    );
    expect(problemsOf(configOf([["bpmx", "backwpup", "mixed"]]))).toContain(
      "  tasks[0].cell: backwpup mixed has 1 placeholder site (.example.test) of 2: ",
    );
    expect(problemsOf(configOf([["bpem", "backwpup", "empty"]]))).toContain(
      "  tasks[0].cell: backwpup empty has no sites: give it a pool in the product's sites file",
    );
  });

  test("counts placeholder sites in the plural", () => {
    const twoPlaceholders: readonly CheckedProduct[] = [
      {
        name: "backwpup",
        sites: {
          "pro@nginx": {
            edition: "pro",
            sites: [
              sshSite("https://a.example.test", "x"),
              sshSite("https://b.example.test", "x"),
            ],
          },
        },
      },
    ];
    expect(() =>
      checkConfig(
        configOf([["bpng", "backwpup", "pro@nginx"]]),
        twoPlaceholders,
        "f",
      ),
    ).toThrow("has 2 placeholder sites (.example.test) of 2: ");
  });

  test("lists every task it cannot run, in order", () => {
    const message = problemsOf(
      configOf([
        ["bpng", "backwpup", "pro@nginx"],
        ["k7qx", "imagify", "nginx"],
        ["w4tz", "backwpup", "pro@apache"],
      ]),
    );
    expect(message.split("\n").slice(1)).toEqual([
      expect.stringMatching(/^ {2}tasks\[1\]\.product: /),
      expect.stringMatching(/^ {2}tasks\[2\]\.cell: /),
    ]);
  });

  test("counts only the selected tasks on a server; none selected counts every task", () => {
    const config = configOf([
      ["bpng", "backwpup", "pro@nginx"],
      ["bfng", "backwpup", "free@nginx"],
    ]);
    const crowded = { ...config, serverWarningThreshold: 2 };
    expect(
      checkConfig(crowded, PRODUCTS, "/x/config.json", ["bpng"]).warnings,
    ).toEqual([]);
    for (const selected of [undefined, [], ["bpng", "bfng"]])
      expect(
        checkConfig(crowded, PRODUCTS, "/x/config.json", selected).warnings,
      ).toEqual([
        "qa-lnmp carries 2 tasks at once (serverWarningThreshold 2): bpng (backwpup pro@nginx), bfng (backwpup free@nginx)",
      ]);
  });

  test("warns when a release: ref comes with a version the suite will ignore", () => {
    const { warnings } = checkConfig(
      configOf([
        [
          "bpng",
          "backwpup",
          "pro@nginx",
          { plugin: { ref: "release:latest-stable", version: "9.99.99" } },
        ],
        [
          "bfng",
          "backwpup",
          "free@nginx",
          { plugin: { ref: "develop", version: "9.99.99" } },
        ],
        [
          "bfap",
          "backwpup",
          "free@apache",
          { plugin: { ref: "release:5.4.0" } },
        ],
      ]),
      PRODUCTS,
      "/x/config.json",
    );
    expect(warnings).toEqual([
      "tasks[0].plugin.version is ignored: a release: ref builds the version its tag names",
    ]);
  });

  test("warns about a server that the threshold of tasks or more reach, and only then", () => {
    const tasks = [
      ["bpng", "backwpup", "pro@nginx"],
      ["bfng", "backwpup", "free@nginx"],
      ["bfap", "backwpup", "free@apache"],
    ] as const;
    expect(
      checkConfig(configOf(tasks, { serverWarningThreshold: 3 }), PRODUCTS, "f")
        .warnings,
    ).toEqual([]);
    expect(
      checkConfig(configOf(tasks, { serverWarningThreshold: 2 }), PRODUCTS, "f")
        .warnings,
    ).toEqual([
      "qa-lnmp carries 2 tasks at once (serverWarningThreshold 2): bpng (backwpup pro@nginx), bfng (backwpup free@nginx)",
    ]);
    // A task whose two sites share a server counts once.
    expect(
      checkConfig(
        configOf([tasks[0]], { serverWarningThreshold: 2 }),
        PRODUCTS,
        "f",
      ).warnings,
    ).toEqual([]);
  });
});

test.describe("serverOf", () => {
  test("an SSH site's host, lowercased; anything else is this machine", () => {
    expect(serverOf(sshSite("https://a.test", "QA-LNMP.example"))).toBe(
      "qa-lnmp.example",
    );
    const nginx = PRODUCTS[1]?.sites.nginx?.sites[0];
    if (nginx === undefined) throw new Error("no stand-in site");
    expect(serverOf(nginx)).toBe("this machine");
    expect(
      serverOf({ ...nginx, transport: { mode: "local", rootDir: "/srv/wp" } }),
    ).toBe("this machine");
  });
});
