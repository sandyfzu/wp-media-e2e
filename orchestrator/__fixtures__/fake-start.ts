import type { ProductList } from "../config/product-list";
import { setTimeout as delay } from "node:timers/promises";

import {
  prepareStart as realPrepareStart,
  start as realStart,
  type StartOptions,
} from "../start";
import type { ExitCode } from "../start-lines";
import { fakeCommand } from "./fake-suite";

/**
 * For specs: `orchestrator/start.ts` as the real `cli.ts` sees it once `swap-start.ts` is preloaded —
 * everything of the real module, but `start` runs every run as the fake runner (one that waits for a
 * stop) on a stand-in product, so the real command, its real process and its real signals are tested
 * with no site touched. The checkout the runs start in is `FAKE_CLI_CHECKOUT`; with
 * `FAKE_LATE_SIGNAL=SIGINT`, the process sends itself that signal once `start` has returned — after
 * `start` removed its handlers, before `process.exit`; with `FAKE_SLOW_PREPARE=1`, the dry run's
 * preparation says `preparing` on standard error, then waits 10 s — a dry run still in progress;
 * `FAKE_PARENT_WATCH_MS` reads the parent's PID that often instead of every second.
 */

export * from "../start";

/** A real-shaped SSH site no run ever reaches: the fake runner does not read it. */
const SITE = {
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
} as const;

/** The stand-in product list: BackWPup with one cell, `fake@cell` — a name no real sites file has, so that should the swap ever fail, the real `start` refuses the config instead of running the real suite. */
const PRODUCT_LIST = {
  PRODUCTS: [
    {
      name: "backwpup",
      sites: { "fake@cell": { edition: "pro", sites: [SITE] } },
    },
  ],
  productByName: () => {
    throw new Error("the fake suite's commands need no product");
  },
  playwrightConfigFor: () => "playwright.backwpup.config.ts",
} as unknown as ProductList;

/**
 * The real `start` over the fake suite.
 *
 * @param options - the command line's options.
 * @returns `start`'s exit code.
 */
export async function start(options: StartOptions): Promise<ExitCode> {
  const checkout = process.env.FAKE_CLI_CHECKOUT;
  if (checkout === undefined) throw new Error("FAKE_CLI_CHECKOUT is not set");
  const code = await realStart(options, {
    checkout,
    loadProductList: () => Promise.resolve(PRODUCT_LIST),
    loop: {
      commandsFor: () => ({
        bddgen: fakeCommand({ exitCode: 0 }),
        playwright: fakeCommand({ runMs: 60_000 }),
      }),
      launchOptions: { pollMs: 20 },
    },
    ...(process.env.FAKE_PARENT_WATCH_MS === undefined
      ? {}
      : {
          parentWatch: {
            parentPid: () => process.ppid,
            intervalMs: Number(process.env.FAKE_PARENT_WATCH_MS),
          },
        }),
  });
  const late = process.env.FAKE_LATE_SIGNAL;
  if (late !== undefined) process.kill(process.pid, late);
  return code;
}

/**
 * The real `prepareStart`, slowed down on request.
 *
 * @param args - its arguments.
 * @returns what it returns.
 */
export async function prepareStart(
  ...args: Parameters<typeof realPrepareStart>
): ReturnType<typeof realPrepareStart> {
  if (process.env.FAKE_SLOW_PREPARE === "1") {
    process.stderr.write("preparing\n");
    await delay(10_000);
  }
  return realPrepareStart(...args);
}
