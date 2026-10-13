import { test, expect } from "@playwright/test";

import { ARTIFACT_ENV_VARS } from "../../src/common/artifacts/request";
import { CELL_PIN_ENV } from "../../src/common/config/cell-pin";
import { DOTENV_SWITCH_ENV } from "../../src/common/config/dotenv";
import { STOP_FILE_ENV } from "../../src/common/config/drain";
import {
  REPORTS_KEEP_ENV,
  REQUESTED_REF_ENV,
  RETRIES_ENV,
  RUN_NAME_ENV,
} from "../../src/common/config/run-env";
import {
  INHERITED_VARIABLES,
  runEnvironment,
  variableNames,
  type RunEnvironmentInput,
} from "./environment";

/** A task with nothing optional, and an orchestrator's environment full of what must not pass. */
const BARE: RunEnvironmentInput = {
  inherited: {
    PATH: "/usr/bin",
    HOME: "/home/qa",
    LANG: "en_US.UTF-8",
    TMPDIR: "/tmp/qa",
    RUN_ID: "the-orchestrators-own",
    CI: "true",
    E2E_PLUGIN_REF: "inherited",
    GITHUB_TOKEN: "inherited-token",
    PLAYWRIGHT_BDD_CONFIGS: "x",
    BWP_S3_ACCESS_KEY_ID: "inherited",
  },
  task: { cell: "pro@nginx" },
  config: {},
  runId: "2026-10-13T10-15-31-042Z-bpng-12",
  stopFile: "/srv/e2e/.orchestrator/runs/bpng-12/stop",
};

test.describe("runEnvironment", () => {
  test("passes only the allowlisted variables and the run's own, nothing else the orchestrator holds", () => {
    expect(runEnvironment(BARE)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/qa",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp/qa",
      E2E_LOAD_DOTENV: "false",
      RUN_ID: BARE.runId,
      E2E_CELL: "pro@nginx",
      E2E_INTERNAL_STOP_FILE: BARE.stopFile,
    });
  });

  test("leaves out an inherited variable that is unset or empty", () => {
    const environment = runEnvironment({
      ...BARE,
      inherited: { PATH: "/usr/bin", HOME: "", LANG: undefined },
    });
    expect(Object.keys(environment)).not.toContain("HOME");
    expect(Object.keys(environment)).not.toContain("LANG");
    expect(Object.keys(environment)).not.toContain("TMPDIR");
  });

  test("adds the task's plugin, name, the run settings and the secrets when configured", () => {
    const environment = runEnvironment({
      ...BARE,
      task: {
        cell: "pro@nginx",
        name: "BackWPup Pro on nginx",
        plugin: { ref: "develop", version: "9.99.99" },
      },
      config: {
        runs: { retries: 0, reportsKeep: 0 },
        secrets: { GITHUB_TOKEN: "ghp_x", BWP_FTP_PASSWORD: " pass " },
      },
    });
    expect(environment).toMatchObject({
      E2E_PLUGIN_REF: "develop",
      E2E_PLUGIN_VERSION: "9.99.99",
      E2E_REQUESTED_REF: "develop",
      E2E_RUN_NAME: "BackWPup Pro on nginx",
      E2E_RETRIES: "0",
      E2E_REPORTS_KEEP: "0",
      GITHUB_TOKEN: "ghp_x",
      BWP_FTP_PASSWORD: " pass ",
    });
  });

  test("sets a version alone without naming a ref, so the product's default ref still applies", () => {
    const environment = runEnvironment({
      ...BARE,
      task: { cell: "pro@nginx", plugin: { version: "9.99.99" } },
    });
    expect(environment.E2E_PLUGIN_VERSION).toBe("9.99.99");
    expect(Object.keys(environment)).not.toContain("E2E_PLUGIN_REF");
    expect(Object.keys(environment)).not.toContain("E2E_REQUESTED_REF");
  });

  test("returns a fresh object each time", () => {
    expect(runEnvironment(BARE)).not.toBe(runEnvironment(BARE));
  });

  test("spells every variable as the suite reads it", () => {
    const names = Object.keys(
      runEnvironment({
        ...BARE,
        task: { cell: "c", name: "n", plugin: { ref: "r", version: "v" } },
        config: { runs: { retries: 1, reportsKeep: 1 } },
      }),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        DOTENV_SWITCH_ENV,
        CELL_PIN_ENV,
        STOP_FILE_ENV,
        ARTIFACT_ENV_VARS.plugin.ref,
        ARTIFACT_ENV_VARS.plugin.version,
        REQUESTED_REF_ENV,
        RUN_NAME_ENV,
        RETRIES_ENV,
        REPORTS_KEEP_ENV,
      ]),
    );
    expect(INHERITED_VARIABLES).toEqual(["PATH", "HOME", "LANG", "TMPDIR"]);
  });
});

test.describe("variableNames", () => {
  test("lists the names, sorted, never a value", () => {
    expect(variableNames({ B: "secret", A: "x" })).toEqual(["A", "B"]);
  });
});
