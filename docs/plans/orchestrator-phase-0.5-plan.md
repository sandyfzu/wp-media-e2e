# Orchestrator Phase 0.5 — The minimal orchestrator

> **Status:** in implementation, in §7's order. **Done:** step 0, the scaffold (2026-10-12, §7.1; audited 2026-10-13, §7.2); step 0.1,
> what that audit left open (2026-10-13, §7.3–§7.4; audited the same day, §7.5); step 1, M2 configuration (2026-10-13, §7.6; audited the same day, §7.7);
> step 2, M4's pure parts and M6's builder and bus (2026-10-13, §7.8; audited the same day, §7.9); step 3, the
> Slack and Datator formatters and senders (2026-10-13, §7.10; audited the same day, §7.11); step 4, M4's
> launch and end and M5's stop machines (2026-10-13, §7.12; audited the same day, §7.13).
> **Next:** step 5, M3 and M1 with M9, in §7.14's sub-phases (5A first). Runs after [Phase 0](orchestrator-phase-0-plan.md),
> before Phase 1 (not planned yet).
> **Date:** 2026-10-05.
> **Parent:** the [orchestrator plan](orchestrator-plan.md) keeps the concept and lists this phase in
> its §7. Verification rows continue the parent's numbering, from V114 (§11).
> **Measured with:** Node 24.21.0, npm 12.0.2, tsx 4.23.15, Playwright 1.63.0 on the macOS runner;
> [`wp-media/auto-e2e`](https://github.com/wp-media/auto-e2e) @ `fa0a5b6`; `wp-media/datator` @
> `0cff7bc`; APVM `cli/v3.0.0`.

---

## TL;DR

The smallest orchestrator that replaces AutoE2E's BackWPup instances: **one foreground command that
cycles one or more cells**, each run building its own plugin through the suite, and reporting each
run to Slack and Datator through a one-event bus. It is the parent's design cut to the bone, not a
copy of AutoE2E: every piece is the first version of a piece the parent plans, in the shape later
phases extend.

| AutoE2E today (V114–V116) | Phase 0.5 |
| --- | --- |
| One PM2 process per Linux user, one suite each, under `xvfb-run` | One process, any number of cells — `npm run orchestrator -- start`, kept in `tmux`; headless, no X server (V126) |
| A cycle every 5 min while idle | `loop` tasks: again after a cooldown (default 5 min) once a run ends |
| Clones and compiles the plugin with its own scripts | The run builds it: the suite's `artifacts:<cell>` step, through APVM (V123) |
| `git reset --hard origin/develop` of the suite every cycle | Updated by hand while stopped (D3) |
| Cucumber JSON parsed afterwards | The suite's results stream and run facts (Phase 0E, 0D) |
| Slack: ✅/❌, counts, failed names, WP/PHP (WP-CLI), `scp` hint; "Script Error!" on a crash | Slack: the same, with the plugin and commit, the site's real PHP (V28), the reason a run could not test |
| Datator over `curl`, an HTTP error unnoticed | Datator over `fetch`, anything but `201` logged; only runs that tested |
| Results kept 4 days | The suite's pruning (Phase 0F): 20 per cell by default, configurable |
| One log line per step to `auto-e2e.log` | The orchestrator's log, plus one log per run |

**Out, for later phases:** systemd, the socket API, the dashboard, other task types (scheduled,
on-demand, watch), groups, provided zips, run once (`run --ref`), any command but `start`, editing
anything while it runs, the orchestrator's own builds (warm, pin), backoff after errors, the disk
warning, the cleanup chain after a kill, Allure generation, APVM cache cleaning.

## 1. Scope

- **Cells run in `loop` only** — the parent's name for AutoE2E's cycle: a run, a cooldown, the next
  run. No schedule, no cron.
- **Fixed configuration**: one JSON file read at start — tasks, secrets, notification targets. A change
  needs a restart.
- **The run builds its plugin**: the task's ref (default the product's, `develop`) goes to the run as
  `E2E_PLUGIN_REF`; its `artifacts:<cell>` step builds through APVM or hits APVM's cache. No warming,
  no pinning. That reverses the parent's "the orchestrator builds; a run never does" for this phase
  only; Phase 1 restores it by changing what the run is given, nothing else (§8).
- **One event**, `run.finished`, with the payload the parent specifies (§2 Events), delivered to two
  subscribers: Slack and Datator.
- **Safety kept** because it is cheap and its absence corrupts sites: never two runs of one cell, never
  two orchestrators on one state directory, a graceful stop (Phase 0C).

## 2. AutoE2E, the floor (V114–V116)

- **Process.** `node auto-e2e.js <suite>` under PM2, one Linux user per instance (`auto-e2e-bkwp`,
  `-bkwp-apache`, `-wpr`, `-wpr-apache`), wrapped in `xvfb-run -a -s "-screen 0 1920x1080x24"`; PM2
  restarts it 5 s after a crash and `pm2 save` brings it back after a reboot. `e2em` (a bash script)
  starts, stops, lists and tails all four.
- **Cycle.** First at once, then `setInterval` every 5 min; a tick that finds a cycle running is
  skipped, so the next cycle starts 0–5 min after the last ends. Per cycle: fetch and `reset --hard`
  the plugin to `origin/develop`; compile with a script kept outside the repo (BackWPup `--ver
  5.99.99`; WP Rocket after copying a pre-filled `licence-data.php`); move the zip where the legacy
  suite reads it; `reset --hard` the suite to `origin/develop`; `npm run <suite>`, output inherited;
  move `test-results/*` to `test-results-storage/<timestamp>/`, deleting folders older than 4 days;
  parse `cucumber-report.json`.
- **Slack**, one plain-text message per cycle through an incoming webhook: `✅ Auto E2E tests <suite>
  Ran Successfully!` with the passed count, or `❌ … Failed!` with the failed count and `Feature -
  Scenario` names; `WordPress: x | PHP: y` from WP-CLI over SSH; an `scp` command for the Cucumber
  HTML, the host masked as `xx.xx.xx.xx`; an optional `*[AUTO_E2E_INSTANCE_NAME]*` prefix. Any
  exception sends `❌ Auto E2E Script Error!`, with no detail.
- **Datator**, per cycle that produced a report: `product` (`wp_rocket`/`backwpup`), `test_suite` (the
  npm script, `test:bwpup`), `timestamp` (cycle start), counts, `git_commit` (the plugin clone's
  `HEAD`), `test_duration_seconds` (the whole cycle, build included), `website_url` (since
  2026-10-02, V115) and every scenario's feature, name, status and first error. A scenario with a
  skipped step counts as failed.
- **Weak spots not to copy:** `curl` without `-f` (an HTTP error reads as sent), JSON quoted into a
  shell command, a crash message with no reason, WP-CLI's PHP version (wrong on nginx, V28), skipped
  counted as failed.

## 3. What it needs from Phase 0

Phase 0.5 starts once Phase 0 is done; this is why each item matters here.

| Phase 0 item | Needed for | |
| --- | --- | --- |
| 0A.1 the cell pin (`E2E_CELL`) — **done 2026-10-06** | Two cells of one product side by side (2 of 80 failed without it, V29) | required |
| 0A.2 output folders — **done 2026-10-06** | A `test:unit` or manual run on the runner not deleting running cells' traces | recommended |
| 0B.1 `E2E_LOAD_DOTENV` — **done 2026-10-08** | Runs not changed by a `.env` on the runner | required |
| 0B.3 one product list — **done 2026-10-05** | Validating a task's product (`productByName`) and finding its config (`playwrightConfigFor`) | required |
| 0C the drain, `stopRunningWork` first | A graceful stop; a killed run's next run recovering the site | required |
| 0D.1 run facts, 0D.2 full commit (**done 2026-10-08**), 0D.3 site versions | Slack and Datator: plugin, commit, site, WordPress, PHP | required |
| 0E results stream | Counts, scenarios and first errors — the suite writes no Cucumber JSON | required |
| 0F pruning | A loop writes ~25 reports a day per cell (V125) | required |
| 0B.2 (**done 2026-10-08**), 0A.3–0A.5 | The orchestrator's own builds and scheduling — later phases | not used |

## 4. Design

### 4.1 M1 — The command

- `npm run orchestrator -- start [--config <file>] [--task <id>…] [--once] [--dry-run]` — commander,
  entry `orchestrator/cli.ts`, script `"orchestrator": "tsx orchestrator/cli.ts"`.
- **Every task in the config runs**, at once, each in its own loop — any number of cells, of any
  product, one task per product × cell (§4.3).
- **Foreground.** It holds the terminal until stopped, like AutoE2E's `node auto-e2e.js`; on a server,
  inside `tmux`, so it outlives the SSH session and can be watched again (§6). Closing the session
  without `tmux` stops it (SIGHUP, §4.5). The same process later runs under systemd unchanged
  (`Type=simple`; it already stops on SIGTERM).
- `--task` runs only those tasks; `--once` runs each selected task once and exits — `0` if every run
  passed or was flaky, `1` otherwise, `130` if stopped. It is how a deployment is tried (§6).
- `--dry-run` validates the config and prints what would run — each task, its sites and their servers,
  the warnings — and runs nothing; exit `0` or `1`. Choosing a machine and its cells (D4) is then:
  edit the config, dry-run, `--once`.
- **Terminal**: one timestamped line per event, never a run's own output (runs interleave); the same
  lines go to `orchestrator.log`:

  ```text
  10:15:30 orchestrator  started · 2 tasks · .orchestrator/ · pid 4242
  10:15:31 bpng  bpng-12 started · backwpup pro@nginx · develop · .orchestrator/runs/bpng-12/run.log
  11:09:41 bpng  bpng-12 ✔ passed · 52 scenarios: 51 passed, 1 flaky · 54m 10s · reports/backwpup/pro@nginx/<RUN_ID>
  11:09:42 bpng  slack ✓ · datator ✓ 201
  11:09:42 bpng  next run 11:14:42 (cooldown 5m)
  ```

### 4.2 M2 — Configuration

`.orchestrator/config.json` by default — git-ignored like the sites files, `0600` (a wider mode is
warned about). The state lives in the config file's directory, so `--config` is the one switch. A
committed `orchestrator/config.example.json` documents it.

```json
{
  "instance": "AutoE2E nginx",
  "tasks": [
    {
      "id": "bpng",
      "name": "BackWPup Pro on nginx",
      "type": "loop",
      "product": "backwpup",
      "cell": "pro@nginx",
      "plugin": { "ref": "develop", "version": "9.99.99" },
      "cooldownMinutes": 5,
      "grep": "@smoke"
    }
  ],
  "runs": { "retries": 2, "reportsKeep": 20 },
  "secrets": { "GITHUB_TOKEN": "…", "BWP_S3_ACCESS_KEY_ID": "…" },
  "notifications": {
    "slack": { "webhookUrl": "https://hooks.slack.com/services/…" },
    "datator": { "url": "https://datator.wp-media.me/e2e_tests/results/", "apiKey": "…" }
  },
  "reports": { "sshHost": "auto-e2e" },
  "serverWarningThreshold": 5
}
```

- **Tasks use the parent's task fields** (§2 Tasks), so Phase 1 imports them as they are: `id` (the
  parent's 4-character rule), `type` (`loop`, the only value accepted here — explicit, so a later
  default cannot change its meaning), `product`, `cell`, `plugin` (`ref` and `version`; both optional,
  falling back to the product's defaults; no `zip` yet), and the extras `name` and `grep`.
- **Validated at start** with zod; each error names its path (`tasks[1].cell`) and stops the start:
  - the product is known (0B.3) and the cell is real — in the product's sites files, with real sites;
  - ids are unique, and so are product × cell pairs (a cell never runs twice, V1);
  - `secrets` holds only `GITHUB_TOKEN`, `GH_TOKEN` and `BWP_*` — what a run may receive (Phase 0 §2);
  - the Slack URL is `https://hooks.slack.com/…`; the Datator URL is HTTPS and **ends with `/`** —
    without it Datator answers `301` (V119), and the redirect drops the POST body.
- Omitting `notifications.slack` or `notifications.datator` turns that subscriber off, as AutoE2E does
  with an empty key. `instance` prefixes Slack messages, like `AUTO_E2E_INSTANCE_NAME`. `sshHost` turns
  the report path in Slack into an `scp` command.

### 4.3 M3 — The loop

- One loop per task, all concurrent: create a run → wait for it to end → publish `run.finished` → wait
  the cooldown → again. The first runs start at once.
- A task runs one run at a time and owns its cell, so no cell ever runs twice. **No limit per server**
  (decided; 0A.3): at start, servers reached by `serverWarningThreshold` or more tasks are warned about
  — the server, its cells, the threshold. All tasks loop at once, so that count is the live one.
- The cooldown counts from the run's end; a stop during it ends the loop at once.
- **No backoff**: a broken site or branch fails every cycle and says so each time, as AutoE2E does. The
  parent's backoff comes with Phase 1.

### 4.4 M4 — A run

- **Identity.** `<task>-<n>` (`bpng-12`), `n` from a counter in `tasks/<task>.json`, written atomically
  (temporary file, then rename). `RUN_ID` is `<formatRunId(start)>-<run id>`, with 0F's formatter. Its
  folder `runs/<run id>/` holds `run.log`, `run.json` and the stop file.
- **Launch** — Phase 0's run contract (its §2), unchanged: `node node_modules/playwright-bdd/dist/cli/index.js
  --config playwright.<product>.config.ts`, then, if it exited `0`, `node node_modules/@playwright/test/cli.js
  test --config playwright.<product>.config.ts` (plus `--grep=<grep>` when the task has one — one argument, so a value starting with `-` cannot read as an option, V368). Each `detached`
  (its own process group and session, V121), both writing to `run.log` with a header line (command,
  variable names — never values — start, exit code or signal). The working directory is the checkout.
- **Environment, from an allowlist** — never the orchestrator's own:
  - `PATH`, `HOME` (APVM's cache and `gh` live under it), `LANG` and `TMPDIR` when set;
  - `E2E_LOAD_DOTENV=false`, `RUN_ID`, `E2E_CELL`, `E2E_INTERNAL_STOP_FILE`;
  - the task's plugin: `E2E_PLUGIN_REF` and `E2E_PLUGIN_VERSION` when set, and `E2E_REQUESTED_REF`
    (display) — equal to the ref here; when Phase 1 pins, only `E2E_PLUGIN_REF` changes;
  - `E2E_RUN_NAME` (the task's name), `E2E_RETRIES` and `E2E_REPORTS_KEEP` when configured;
  - the configured secrets.
- **End.** A run has ended when the Playwright process has exited **and** its process group is empty
  (`kill(-pgid, 0)` → `ESRCH`; Phase 0C).
- **Outcome**, from `<report dir>/results.jsonl` (0E) and `run-facts.json` (0D.1); the report dir is
  `reports/<product>/<cell>/<RUN_ID>`, built by a side-effect-free helper beside 0F's `run-id.ts` —
  importing `run-context.ts` would stamp the orchestrator's own `RUN_ID` and load `.env` (V84):

  | When | Status |
  | --- | --- |
  | the orchestrator killed it | `killed` |
  | it was stopped (drained or interrupted) | `stopped` |
  | `bddgen` failed; Playwright ended without `run.end`; a setup project failed; no scenario ran | `error`, with the reason: the setup's or `bddgen`'s first error, else the exit code or signal and the log's last lines |
  | any final `failed` | `failed` |
  | any `flaky` | `flaky` |
  | otherwise | `passed` |

- **Run record.** `run.json`: the `run.finished` payload, the process group, the exit codes. Written at
  start (`running`, with the group) and at the end.
- **Orphans.** A detached run outlives an orchestrator killed by SIGKILL or a crash, and nothing
  reports it. At start, a task whose last record still says `running` with a live group is **not
  started**: the start fails, naming the run, its group and the command that kills it — a second run
  on that cell would share its sites (V1).

### 4.5 M5 — Stopping

The orchestrator's half of Phase 0C, per run: drain (create the stop file) → one SIGINT to the
Playwright process → SIGKILL to the group; ended on `ESRCH`. Never SIGTERM a run, never a second
SIGINT. While `bddgen` runs, its group is killed outright: generation has nothing to drain.

| Signal to the orchestrator | Effect |
| --- | --- |
| Ctrl-C (SIGINT), first | No new run; cooldowns end; every run drains. After 15 min, interrupt |
| Ctrl-C, second | Interrupt every run now. After 4 min, kill |
| Ctrl-C, third | Kill every run now |
| SIGTERM, SIGHUP | As the first Ctrl-C, with the same budgets |

- **SIGINTs less than 1 s apart count as one** (as in Playwright). Measured: one Ctrl-C under `npm run`
  delivers **two** SIGINTs, 1–31 ms apart — the terminal's and npm's relay (V122). Without this, one
  Ctrl-C would skip the drain.
- Runs are detached, so the terminal's Ctrl-C reaches the orchestrator alone (V121). SIGHUP covers an
  SSH session closed outside `tmux`; writes to the closed terminal are then ignored.
- Stopped and killed runs are still announced (`run.finished`); the process exits once every run has
  ended and every delivery has settled (each bounded by its timeout). Exit code `130`.
- A killed run leaves its site dirty until that cell's next run; 0C's `stopRunningWork`-first Before
  path recovers it (Phase 0 L3). The parent's cleanup chain after a kill comes later.

### 4.6 M6 — Events

- `orchestrator/events/`: `createEventBus({ timeoutMs, log })` with `on(type, handler, name)` and
  `publish(event)`. Handlers run concurrently, each timed out (30 s) and caught; a failure is logged
  with the subscriber's name and never reaches the run (parent §2: a subscriber never holds up a run).
  `publish` does not block the loop; `settle()` waits for deliveries in flight, at shutdown.
- **One event: `run.finished`, schema `v: 1`** — the parent's payload (§2 Events) minus the dashboard
  link:

  | Field | Content |
  | --- | --- |
  | `v`, `type`, `at` | `1`, `"run.finished"`, ISO time |
  | `run` | `id`, `runId` (`RUN_ID`), `name`, `trigger` (`"loop"`), `task` (`id`, `name`, `grep` — Datator's `test_suite` needs it) |
  | `unit` | `product`, `cell`, `edition` |
  | `plugin` | `requestedRef`, `ref`, `commit` (full), `version` |
  | `sites` | per site of the pool, in pool order: `baseURL`, `wordpress`, `php` |
  | `status`, `reason` | the run's status (§4.4); the reason for `error`, `stopped`, `killed` |
  | `startedAt`, `endedAt`, `durationMs` | |
  | `counts` | `total`, `passed`, `failed`, `flaky`, `skipped`, `didNotRun` |
  | `scenarios` | per scenario: `feature`, `name`, `path` (rule/outline), `status`, `attempts`, `durationMs`, `error` (the first error; ANSI stripped, capped) |
  | `report` | `dir`, `log` |

- Built by a pure function from the run record, `results.jsonl` and `run-facts.json`, so every field
  is unit-testable. Later events (`run.queued`, `build.*`, …) add types; this one does not change.

### 4.7 M7 — Slack

- One message per run, every status, to the incoming webhook: `POST` `{ "text": … }` with `fetch`,
  15 s timeout. Success is `200` with body `ok`; anything else — Slack answers `invalid_payload`,
  `no_service`, `channel_is_archived`, … (V120) — is logged with status and body. No retry.
- Text, `&`, `<` and `>` escaped as Slack requires (V120); at most 20 scenarios listed, then "…and N
  more"; well under Slack's 40,000-character truncation:

  ```text
  *[AutoE2E nginx]* ❌ FAILED — BackWPup Pro · pro@nginx
  52 scenarios: 49 passed · 1 flaky · 2 failed, in 54m 10s
  Plugin: BackWPup Pro 9.99.99 · develop @ f1ebfd0
  Site: https://simple.e2e.rocketlabsqa.ovh · WordPress 7.1.2 · PHP 8.5.10
  Failed:
  • Backups › A backup runs on demand — Expected "Done", received "Error" …
  • CLI › Logs are listed — Timeout 30000ms exceeded …
  Flaky:
  • Onboarding › The first backup is offered
  Report: scp -r auto-e2e:/home/…/reports/backwpup/pro@nginx/<RUN_ID> .
  ```

  Headlines: `✅ PASSED`, `⚠️ FLAKY`, `❌ FAILED`, `🚫 COULD NOT TEST` (with the reason and the run's
  log path instead of the scenario lists), `■ STOPPED`, `■ KILLED`. More than one site: one `Site:`
  line each.

### 4.8 M8 — Datator

- `POST` the configured URL, `X-API-Key`, JSON; success is `201`, anything else is logged with its
  status and the body's first 500 characters. 15 s timeout, no retry; `run.json` keeps the payload.
- **Only runs that tested** — `passed`, `flaky`, `failed`. Not `error`, `stopped` or `killed`: a broken
  branch or site is not a regression (parent §2), and AutoE2E posted nothing when a cycle crashed.
- **Mapping**, against Datator's own serializer (V117, V118):

  | Field | Value |
  | --- | --- |
  | `product` | AutoE2E's codes: `backwpup`, `wp_rocket` (`wp-rocket`); otherwise the product's name |
  | `test_suite` | the cell, `pro@nginx`; with a filter, `pro@nginx @smoke` (D1) |
  | `timestamp` | the run's start, ISO UTC |
  | `total_tests` / `successful_tests` / `failed_tests` | every scenario / `passed` + `flaky` / `failed`; `skipped` is in neither (D2) |
  | `git_commit` | the full commit; `null` when there is none (a `release:` build) |
  | `test_duration_seconds` | the run's duration, an **integer** — `845.7` is refused (V118) |
  | `website_url` | the pool's first site's `baseURL` |
  | `test_cases` | per scenario: `feature_name` and `test_name` cut to **500 characters** (501 is refused, V118) — the name prefixed with its rule/outline path when it has one; `status` `passed`, `failed` or `skipped` (`flaky` → `passed`, D2); `error_message` the first error, capped at 4,000 characters |

- Datator itself checks nothing else: no enum on `product`, `test_suite` or `status`, no
  `total = successful + failed` (V117, V118). The caps keep a full run's body near 100 KB; the app
  accepted 2.6 MB, but whatever sits in front of it in production is unknown.

### 4.9 M9 — State, logs and retention

```text
.orchestrator/
  config.json        git-ignored, 0600
  orchestrator.lock  pid; a second start on this directory refuses, a dead pid's lock is taken over
  orchestrator.log   the terminal's lines
  tasks/<id>.json    the run counter
  runs/<run id>/     run.log, run.json, stop
```

- **Reports** are pruned by the suite at each run's end (0F), per cell — one task per cell here, so
  per task too. `runs.reportsKeep` sets `E2E_REPORTS_KEEP` (default 20, the suite's; `0` lifts only the
  cap, the 30- and 182-day rules still run). At ~55 min a
  cycle, 20 reports cover about 18 hours; AutoE2E kept 4 days — raise it if that history is wanted.
- **Run folders** follow the same policy at each run's end, through 0F's pure `planRetention` (group:
  the task; never the run in progress).
- `orchestrator.log` grows by a few lines per run — no rotation.
- The orchestrator never reads `E2E_*` variables (parent §1); only its config and flags.

### 4.10 Not planned here, on purpose

The disk warning (0A.3) needs a remote `df` per run; per-run progress in the terminal needs the
stream read live; a test message for Slack, `status`, `logs` and `stop` commands need the API. All
belong with Phase 1's service.

## 5. Code layout

```text
orchestrator/
  cli.ts                  commander: start
  config.example.json     the committed example (§4.2)
  config/                 schema (zod), checks against the suite, loader
  tasks/loop.ts           the cycle
  runs/                   identity, env, launch, stop, outcome, record
  events/                 bus, run-finished (types + builder)
  notify/                 slack, datator — pure formatters, thin senders
  state/                  lock, counter, retention
  log.ts                  a Logger interface; terminal + file now, pino behind it later
```

- `tsconfig.json` includes `orchestrator/**/*`; `playwright.unit.config.ts` also collects
  `orchestrator/**/*.spec.ts` (with `node_modules` still excluded); ESLint's TypeScript globs already
  match. New dependencies: `commander` 15, `zod` 4 (both ESM; Node ≥ 22.12 and none, V127). Hono,
  SQLite, pino and React wait for the phases that need them.
- It imports from the suite only modules that leave the process as it was: the product list (0B.3),
  the sites loader, 0F's `run-id.ts` and `retention.ts` (V340). The product list is not free of
  effects: importing it reads every product's sites files once, prints a `[sites]` warning for a
  product with none, and **throws** on one that is not valid JSON (V342) — so M1 loads it through
  `loadProductList` (step 0.1a) inside its error handling, and a broken sites file is a config error,
  not a crash. Never `run-context.ts`, nor `resolve.ts`,
  `consume.ts` or `project.ts`, which import it (V84, V130). Importing any of those would load
  `.env` into the orchestrator's own process and stamp its `RUN_ID`. The child environment's
  allowlist (Phase 0 §2) keeps that state out of runs, but it should not exist at all.
  **Enforced twice**, because a lint rule sees only an import's own path, not what that module
  imports in turn, and misses a dynamic `import()` (V135):
  - **ESLint**, a `no-restricted-imports` block on `orchestrator/**`: anything under `src/` is
    refused except the modules above, an allowlist, so a new import is a decision (the `src/common/`
    block in `eslint.config.js` is the model);
  - **a spec** that imports every orchestrator module except the command's entry (which runs on
    import) in a child Node, and asserts the environment is unchanged. This is the
    `products.spec.ts` probe (V130), moved into a shared test helper. It catches a side effect an
    allowed module picks up later. As built, the spec also judges every import where it leads and
    walks all an admitted module can load (§7.1–§7.2).
- `.gitignore`: `/.orchestrator/`.

## 6. Running it on the runner

Which machine is D4. On it:

1. **Tools**: Node ≥ 24.16 and npm; git; for BackWPup builds npm, composer (PHP CLI) and `gulp-cli`
   (V123); Chromium and its system libraries (`npx playwright install --with-deps chromium`, once,
   with `sudo`); `tmux`. No X server.
2. **Checkout** of `develop` and `npm ci`; the cells' `sites.json` (`0600`), with SSH keys reaching the
   WordPress servers; `npm run healthcheck` passing for those cells — the parent's setup step.
3. **GitHub**: `gh auth login` as that user, or `secrets.GITHUB_TOKEN` (BackWPup's repo is private).
4. **Config**: copy `orchestrator/config.example.json` to `.orchestrator/config.json` (`0600`), add
   one task per cell and the AutoE2E Slack webhook and Datator key (D5); check it with
   `npm run orchestrator -- start --dry-run`; try one cell with `… start --task <id> --once`.
5. **Stop AutoE2E's instance for those cells first** — the sites are dedicated (parent §1). AutoE2E's
   WP Rocket instances stay: this suite has only WP Rocket's three scaffolding scenarios (V125).
6. **Start**, detached: `tmux new -d -s orchestrator 'npm run orchestrator -- start'`. Watch:
   `tmux attach -t orchestrator` (leave with Ctrl-b d), or `tail -f .orchestrator/orchestrator.log`.
   Stop: `tmux send-keys -t orchestrator C-c` (the drain, §4.5), or attach and Ctrl-C.
7. **Update** (D3): stop, wait for the drain; `git pull --ff-only && npm ci`; start again.

## 7. Implementation order

Each step ships with its unit specs and passes the four gates (CLAUDE.md).

0. The scaffold, before any module, so none lands unchecked: `orchestrator/` in `tsconfig.json`'s
   `include` (or `tsc` skips it) and in the unit config, the `.gitignore` line, and both import
   guards (§5). Prove each guard fails on a forbidden import, e.g. one of `run-context.ts`.
   **Done 2026-10-12** (§7.1).
0.1. What the step-0 audit left open (§7.3): 0.1a the product list loaded where a broken sites file is
   a config error; 0.1b an absolute `ARTIFACTS_ROOT` kept where it points; 0.1c the boundary's cheap
   remaining routes closed, the rest stated. **Done 2026-10-13** (§7.4).
1. M2 configuration — schema, loader, example. **Done 2026-10-13** (§7.6; audited, §7.7).
2. M4's pure parts — identity, environment, the outcome table; M6's builder and bus. **Done 2026-10-13** (§7.8).
3. M7 and M8 formatters (pure), then their senders. **Done 2026-10-13** (§7.10; audited, §7.11).
4. M4's launch and end, M5's stop state machine (an injected clock and `kill`). **Done 2026-10-13** (§7.12; audited, §7.13).
5. M3 and M1 — the loop and the command; M9 — lock, counter, retention, logs. Broken into 5A–5K (§7.14).
6. Docs: a new `docs/guides/orchestrator.md` (operating it: §6, the config, stopping), `CLAUDE.md`
   (structure, the script, the docs map), `README.md`, `.env.example` untouched (no `E2E_*`).

### 7.1 Step 0 — Implemented (2026-10-12, V332–V335)

As planned, plus (as first built; §7.2 records what the audit changed):

- **One allowlist, two readers.** The admitted suite modules live in `orchestrator/suite-imports.json`
  (repository paths), read by ESLint's block (`import … with { type: "json" }`, turned into the
  pattern's alternatives) and by the spec, so both read one list. Admitted now: §5's four —
  `run-id.ts`, `sites.ts`, `retention.ts`, `products.ts` — each proved to leave `process.env` as it
  was (V333). Test code (`*.spec.ts`, `__fixtures__/`) is exempt from both: it never runs in the
  process.
- **The spec** (`orchestrator/import-boundary.spec.ts`) resolves every import form with TypeScript's
  scanner — anything leaving `orchestrator/` that is not admitted fails, root files such as
  `playwright.config.ts` included, which the lint rule (it sees `src/` spellings only) does not catch
  — then imports the admitted modules in a fresh Node, and every orchestrator module but the root
  `cli.ts` in another, a change charged to the first import that made it.
- **Shared helpers**, as §5 asked: the probe moved out of `products.spec.ts` into
  `src/common/__fixtures__/env-probe.ts` (`envChangesOnImport`, its own spec keeping the check that it
  sees `run-context.ts` load `.env` and stamp `RUN_ID`), and `src/common/import-boundary.spec.ts`'s
  scanner into `import-scan.ts` (`localImports`, `isInside`), now also counting absolute specifiers.
- **The unit config** has one project per folder (`src`, `orchestrator`): a `testDir` at the
  repository turns off Playwright's `.gitignore` filtering and would run every worktree's specs (V334,
  V338). A path filter is a regex on the absolute path, so in this worktree `orchestrator/` matches
  every spec; use `--project=orchestrator`.

### 7.2 Audit (2026-10-13, V336–V346)

Two adversarial reviewers, each in its own copy of the worktree, plus my own checks; every finding
reproduced before it was believed, every fix proved by a test that fails with it undone (V344), and
every reviewer bypass rebuilt against the final tests (V343).

- **The scanner was blind (high).** `ts.preProcessFile` is a token scanner: a regex literal holding a
  backtick, `/*` or a quote hid every import after it — in both boundary specs (V336). Both now read
  TypeScript's syntax tree (`importsIn`), which also reports a computed `import()` path; the
  orchestrator's scan refuses one, and so does `src/common/`'s outside test code (none today, V341).
- **The scan judged spelling, not destination.** It now resolves each import with the repository's
  own TypeScript options (`createResolver`: `.js` → `.ts`, `#` imports, `paths`, index files) and
  judges where it leads (V337); a path that leads nowhere outside `orchestrator/` is refused.
- **Holes:** production code could import its own test code, which neither guard reads — refused now
  by both; `.mts`/`.cts`/`.tsx`/`.js` files were read by neither — the scan reads every dialect,
  ESLint the ones it can parse; the allowlist accepted `src/../x.ts`, `./` spellings, specs and
  fixtures — refused now (`allowlistProblems`).
- **An admitted module could gain a lazy import** of `run-context.ts`, invisible to an import-time
  probe. The spec walks everything the admitted modules can load (`localClosure`: 38 files, V341) and
  refuses one that reaches `load-env.ts` or `run-context.ts`, or a load it cannot follow.
- **The probe saw only `process.env`, at the import's instant, and trusted stdout.** `probeImports`
  (was `envChangesOnImport`) also compares process listeners — one `SIGINT` listener turns off Node's
  exit on Ctrl-C — the working directory and the exit code; gives each import one turn of the event
  loop and reads once more when the process goes idle; and returns through a file, so a module that
  prints, or ends the process, cannot forge or garble the verdict (V340). Its tests now show a
  variable changed and removed, not only added, and the charging rule with a module that would
  change something on its own (`load-env.ts`).
- **ESLint** matches only relative, absolute and `file:` paths (a package's own `src/` is fine),
  accepts an admitted module's `.js`/`.ts` spelling, refuses test code, a computed `import()` and
  `createRequire`, and reads `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`. A spec runs the real
  `eslint.config.js` block through ESLint's `Linter` over one table of imports beside the scan's
  verdict, so where the two differ is written down: ESLint misses a literal `import()` (V345),
  `typeof import()`, root files and `#` imports; it is stricter on a `../` detour.
- **Corrected claims:** the unit config's reason (V338); UI mode ticks only the first project until
  a choice is saved (V338); the `.prettierignore` line was redundant, Prettier already honours
  `.gitignore` — removed (V339); "free of import side effects" overclaimed — the product list reads
  and validates sites files at import (V342, §5).
- **Stated limits** (the boundary catches mistakes, not evasion): a `require` made by `createRequire`
  under another name, a `Worker`, code read and evaluated, a module's output and globals, an unref'd
  timer, and anything a package does. A type-only import from the suite needs admitting like any
  other: admit its types module.
- **Out of scope, reported:** an absolute `ARTIFACTS_ROOT` is joined under the checkout
  (`artifacts.setup.ts`, `consume.ts`: `join(REPO_ROOT, …)`), so `results-stream.run.spec.ts`, which
  passes one, leaves empty `private/var/folders/…` folders in the checkout on every unit run (V346).

### 7.3 Step 0.1 — What the step-0 audit left open

**TL;DR.** Three small, independent fixes before M2. **0.1a**: the orchestrator loads the product list
through one function of its own, so a broken sites file stops it with one line naming the file
instead of a stack trace. **0.1b**: the suite resolves `ARTIFACTS_ROOT` as it already resolves
`REPORT_ROOT` and `AUTH_ROOT`, so an absolute root stays where it points — and a unit run stops
leaving empty folders in the checkout. **0.1c**: the import boundary refuses the three builtins the
orchestrator never needs and which open a route around it (`module`, `worker_threads`, `vm`), and
`eval`; what remains is stated.

| Sub-step | Depends on | Parallel with | Touches |
| --- | --- | --- | --- |
| 0.1a | 0 | 0.1b, 0.1c | new `orchestrator/config/product-list.ts` (+ spec), `orchestrator/config/errors.ts` |
| 0.1b | — | 0.1a, 0.1c | `src/common/artifacts/artifacts.setup.ts`, `consume.ts` (+ spec), `configuration.md`, TSDoc |
| 0.1c | 0 | 0.1a, 0.1b | `eslint.config.js`, `orchestrator/__fixtures__/import-boundary.ts`, `orchestrator/import-boundary.spec.ts` |

#### 0.1a — The product list, loaded where a failure is a config error (V342)

**Finding.** Importing `src/projects/products.ts` builds every product's config at import, and with it
runs `loadSites` for every product: it reads each sites file once (credentials included), prints a
`[sites]` warning for a product with none, reads `BWP_*`, and **throws** on a file that is not valid
JSON (`[sites] "…/sites.json" is not valid JSON`). A static import would let a broken WP Rocket sites
file kill the orchestrator at startup, with a stack trace, even when it runs only BackWPup cells.

**Recommended.**

- `orchestrator/config/product-list.ts`: `loadProductList(importList?)` — the one place the
  orchestrator gets `PRODUCTS`, `productByName` and `playwrightConfigFor`. The default `importList` is
  a literal `import("../../src/projects/products")` (an admitted path, which both guards judge); a
  throw becomes a `ConfigError` (`orchestrator/config/errors.ts`, which M2 reuses) saying the product
  list could not be loaded, with the cause's own words — they name the sites file. The command calls it
  once, at start, inside its error handling (M1): exit `1`, one line. `[sites]` warnings print once,
  there.
- Its spec injects the importer: a list returned as is; a throw turned into a `ConfigError` keeping the
  cause's message; the real importer returns the real list. It is the first orchestrator module, so
  the boundary spec's walk and probe stop being vacuous with it.

**Rejected.**

- A static import: the crash above, and a sites edit that can never be reported as a config error.
- Making the product list lazy (each product's sites read on first use), which would also let a
  broken WP Rocket file leave BackWPup cells running: it changes the import contract of every entry
  point that spans products (the bare config, the healthcheck, the artifact warm), which validate
  every product up front by design. Worth reconsidering only if a broken other-product file proves a
  real problem on the runner.

**Done when** `loadProductList` and its spec are in, the boundary spec covers the module (no effects
at import, no forbidden import), and the four gates pass.

#### 0.1b — An absolute `ARTIFACTS_ROOT` (V346)

**Finding.** `dirs()` (`run-context.ts`) returns each root with `<product>/<cell>` appended, relative or
absolute as the variable was given. `REPORT_ROOT` and `AUTH_ROOT` are made absolute with
`resolve(REPO_ROOT, …)` (`project.ts:123`, `:324`), which keeps an absolute root; the artifacts folder
with `join(REPO_ROOT, …)` (`artifacts.setup.ts:73`, `consume.ts:148`), which nests it under the
checkout. `results-stream.run.spec.ts:155` passes an absolute `ARTIFACTS_ROOT`, so every unit run
leaves empty `private/<tmpdir>/…/artifacts/resultsprobe` folders in the checkout; an operator's absolute
root would put the zips under a mirrored path inside it.

**Recommended.**

- `resolve(REPO_ROOT, …)` at both call sites, as for the report and auth roots; the TSDoc of
  `RunDirs.artifacts` (`run-context.ts`) and `resolve.ts:47` say so; `configuration.md` says each
  `*_ROOT` is relative to the repository or absolute.
- A spec that pins an absolute `ARTIFACTS_ROOT` and expects the artifacts folder and
  `resolution.json` at that root, failing with `join`.
- Once a unit run is shown to leave no `private/` folder, remove the empty leftovers from the checkout
  (`find private -type f` must print nothing first).

**Rejected.** Refusing an absolute root: the report and auth roots accept one, and a root outside the
checkout (another disk) is a legitimate choice.

**Done when** both call sites resolve, the spec fails with `join` and passes with `resolve`, a full
unit run leaves no `private/` folder, and the four gates pass.

#### 0.1c — The boundary's stated limits (V343)

**Finding.** The guards catch mistakes, not evasion, and the step-0 spec states what they cannot see:
a `require` made by `createRequire` under another name — a dynamic `import("node:module")` or
`process.getBuiltinModule("module")` gets one past the ESLint ban on importing `createRequire`; a
`Worker` sharing the environment (`SHARE_ENV`); code read and evaluated (`eval`, `vm`; `new Function`
and string timers are already refused by `@typescript-eslint/no-implied-eval`, a plain `eval()` is
not — `no-eval` is off, measured); a
module's output and globals; an unref'd timer; anything a package does.

**Recommended.** Close the routes that cost a few lines and that the orchestrator never needs; state
the rest.

- Refuse, in every form, the builtins `module`, `worker_threads` and `vm` (`node:` prefixed or
  not): ESLint's `no-restricted-imports` `paths`, whole modules (replacing the `createRequire`-only
  entries), and the scan, which judges the specifier — so a dynamic `import("node:module")` is
  refused too. The orchestrator spawns processes; it needs neither threads, a VM nor `require`.
- Refuse `process.getBuiltinModule` (a function on Node 24.21, measured): ESLint `no-restricted-properties`,
  and the scan reports the call from the syntax tree.
- Turn on `no-eval` for `orchestrator/**`.
- Each one a row of the spec's import table (both readers' verdicts), each proved by a mutation.
- **Stated, not closed:** a module's output and globals (the product list prints `[sites]` warnings
  by design); an unref'd timer; what a package does — none can be judged without running everything.

**Rejected.** Capturing output in the probe: the product list's warnings are by design, so it would
fail an admitted module. Accepting every limit as it stands: each cheap route closed removes a whole
way around the boundary for a few lines.

**Done when** the new refusals are in both readers and the spec's table, each mutation-proved; the
spec's stated limits list only what stays open; the four gates pass.

### 7.4 Step 0.1 — Implemented (2026-10-13, V347–V351)

As planned, plus:

- **0.1a.** `loadProductList` returns the list's three members, frozen — never `productFromEnv`, which
  reads the environment. The `ConfigError` keeps the failure's own message and **no cause**:
  `JSON.parse`'s message quotes the text around the error, credentials included, and a logged error
  prints its causes (V347). Its spec drives the real sites loader on a broken file holding a fake
  password.
- **0.1b.** One helper, `cellArtifactsDir` (`consume.ts`), resolves the folder for the setup and the
  readers alike, so the two cannot drift. `dirs()`'s TSDoc says its paths are relative or absolute and
  are resolved, never joined; `.env.example`, `execution-model.md` and `plugin-artifacts.md` say it
  too. A full unit run left no `private/` folder; the 176 empty leftover folders (0 files) are gone
  (V348).
- **0.1c.** Two more builtins refused, measured as routes around the boundary: `inspector`
  (`Runtime.evaluate` runs code in the process) and `repl` (fed a stream, it does too) — V349.
  `eval` is refused by the scan as well as by `no-eval`, so the authority refuses it; the scan reads
  both names from the syntax tree by spelling — an identifier, a property after a dot, a string key
  in brackets or destructuring — never from a comment or an ordinary string (`forbiddenNames`;
  `boundaryViolations` = imports + names). ESLint's `no-restricted-properties` names the property on
  any object, so `globalThis.process.getBuiltinModule` is caught too. Where the readers differ, the
  table says so: ESLint's boundary block misses `import("node:module")` and `require("node:vm")`;
  the full config refuses the `require` (`@typescript-eslint/no-require-imports`), and only the scan
  sees the `import()` (V350). The builtin list is written out in the spec, so dropping a name from
  both readers still fails.
- **Stated limits** now: a module's output and globals; what an unref'd timer or a function does
  after the import; what a package does; a name built at run time
  (`process["get" + "BuiltinModule"]`).
- **Proved** by 20 mutations, each failing the test meant to catch it (V348, V351).

### 7.5 Audit of step 0.1 (2026-10-13, V352–V358)

Every claim re-measured, every fix proved by a mutation that fails the test meant to catch it (V357).

- **`new Function` was open (medium).** §7.3 took it as refused by `@typescript-eslint/no-implied-eval`,
  which lints `.ts` only: in an orchestrator `.js` or `.mjs`, `new Function("…")` passed both readers,
  and `Reflect.construct(Function, …)` passed them in every dialect (V353). Now the scan refuses the
  name `Function` and ESLint runs `no-new-func`; the dialect test checks `eval` and `new Function` in
  each.
- **CommonJS was open (medium).** A `.cts` or `.cjs` file, or a `.js` under a nested `package.json`
  saying `"commonjs"`, gets `require` and `module.require`, which load a computed name, and neither
  guard follows a `require` once renamed (V352). An ES-module `.ts` under tsx has neither. The spec
  now refuses such files in `orchestrator/` (`commonJsFiles`; test code and declaration files exempt).
- **0.1a's point had no test (medium).** Nothing proved that importing `product-list.ts` loads nothing
  of the suite: a static import of the list passed every test. A child Node with an invalid
  `BWP_FTP_PORT` — which makes the list throw as it loads — now imports the module, then gets the
  `ConfigError` from the call alone.
- **Weaker than claimed (low).** The "never quotes it" test read `String(error)`, which never held a
  cause; it now reads `util.inspect`, after proving the loader's own error does quote the file. The
  scan missed a string key in a computed destructuring (`{ ["getBuiltinModule"]: g } = process`),
  which ESLint caught; it reads it now. The fixture's builtin list was not pinned — an added name went
  untested; the spec now pins it.
- **0.1b through the real setup (low).** Only the pure helper was tested. The run spec whose cell `y`
  fails its artifacts setup offline now asserts the cell's folder at the absolute root and nothing
  under the checkout — with `join` it fails, and leaves exactly the old `private/…` folders (V358).
- **Undocumented (low).** Node keeps a module as its first import left it: the sites files are read
  once per process, and a failed load is final — a second call fails even once the file is fixed
  (V355). The TSDoc says so; it fits "once, at start".
- **Inexact doc (low).** "Every caller resolves a root against `REPO_ROOT`": Playwright and
  playwright-bdd resolve `outputDir` against the config's folder, which is the repository (V356);
  `execution-model.md` now says who resolves.
- **Stated limits, completed:** a refused name reached through a string (`Reflect.get(process,
  "getBuiltinModule")`) or built at run time; a constructor reached at run time
  (`(async () => {}).constructor` runs code, V354); Node's internals (`process.binding("contextify")`
  hands out the VM's own classes, deprecated) and native addons (`process.dlopen`); a module's output
  and globals; timers and functions after the import; packages. Not a route: a string timer — Node
  refuses one (V354).

### 7.6 Step 1 — Implemented (2026-10-13, V359–V364)

M2 as planned (§4.2), in four modules under `orchestrator/config/` and the example beside them. As
corrected by the audit (§7.7), which added a fifth, `json-keys.ts`:

- **`schema.ts`** — the zod schema: every rule the file alone can settle. Every object is strict, so a
  misspelt key is an error, never a setting silently ignored. Ids unique, product × cell unique (a
  repeat is named at its own path: `tasks[2].cell: repeats tasks[0]'s product and cell`); zod skips
  these two while a field has an *aborting* issue — a wrong type, a refused key, an aborting check —
  and runs them beside any other (V360). **`parse.ts`** turns the issues into one `ConfigError`, one `path: problem` line each.
  **`check.ts`** needs the suite: the product exists, the cell is one of its, and every site of the
  cell is real; it reads only a product's `name` and `sites`, so its spec uses stand-ins, and gives the
  caller back the product it passed. **`load.ts`** reads the file and composes the three:
  `loadConfig(file, PRODUCTS)` → the config, its tasks joined to product and cell, the state directory
  (the file's own), and the warnings.
- **No message quotes a value** — the file holds the run's secrets. Zod's own messages name types and
  bounds (V360), every message of ours is written the same way, and a spec puts a secret-shaped value
  into every field and finds it in none of the lines. A product or cell the suite does not know is
  named by its path. A key is shown only when it is a name (`describeKey`, §7.7), never raw. A file
  that is not JSON is named by where the error is when V8 says so in digits, never by `JSON.parse`'s
  message, which quotes the text (V361).
- **Decided here:**
  - `serverWarningThreshold` defaults to **5**: up to four suites at once share a QA server well, so
    the warning starts at five (§4.2's example first said 4). At most 1000.
  - `cooldownMinutes`: whole minutes, **1 to 1440**, default 5. Zero would hammer a broken site; a
    day or more is a schedule, which later phases add. Every bounded number has one message,
    `must be a whole number from A to B`, whichever way it misses.
  - A cell runs only if **every** site of its pool is real: a placeholder in a real pool is a mistake,
    and a worker bound to it would fail.
  - `secrets`: `GITHUB_TOKEN`, `GH_TOKEN` and **any `BWP_*`** (Phase 0 §2: by prefix, never a hand-kept
    list). A value becomes an environment variable: at most 32,768 characters, no control character
    or broken Unicode. A token is printable ASCII without spaces; a `BWP_*` value keeps its spaces, as
    the suite reads a storage password (V365).
  - Slack: `https://hooks.slack.com/services/<hook>` only — an incoming webhook, the payload §4.7
    sends. Both URLs are written exactly as `URL` reads them back, with no user, password, port, query
    or fragment; Datator's path ends with `/`, its key is printable ASCII (an HTTP header's value).
  - `grep` is checked as Playwright reads it: `/source/flags` with `g` or `i`, anything else as a
    source with `gi` (V362).
  - `reports.sshHost`: a host or `user@host`, neither part starting with `-`, so it can never read as
    an `scp` option.
  - `runs.retries` 0–10 (the suite's `E2E_RETRIES` bounds); `runs.reportsKeep` 0–`MAX_REPORTS_KEEP`
    (retention's).
  - The file: at most 1 MiB, UTF-8; a leading byte-order mark is skipped; a mode with any group or
    other bit is a warning naming `chmod 600`; a missing file says to copy the example.
  - A version set with a `release:` ref is a warning — the suite ignores it, as it warns itself.
  - Servers are counted by an SSH site's host, lowercased; a Docker or local site is "this machine".
- **The example** has a second task on `free@apache` instead of `free@nginx`: its spec checks every
  task names a cell of the product's `sites.example.json`, so a fresh checkout's `--dry-run` reaches the
  placeholder check, not "no cell".
- **zod 4.6.7** (V359), a dev dependency like every package here.
- **Proved** by 26 mutations, each failing a test (V363); a full unit run passes, the import boundary
  importing the new modules unchanged (V364).

### 7.7 Audit of step 1 (2026-10-13, V365–V371)

Two reviewers, one on security and one on correctness, each on its own copy; every finding reproduced,
then fixed, and every fix proved by a mutation (V370). None blocking; no secret value reached any
message.

- **Keys printed raw (medium).** Zod quotes an unknown key as written, so a key holding a newline
  forged a line of the error and one holding `ESC[2J` cleared the terminal; a token pasted in a key's
  place (`"ghp_…": "GITHUB_TOKEN"`) was printed. Now every key in a message or path goes through
  `describeKey`: shown only when it is a name of at most 40 characters not shaped like a GitHub token,
  else `a key of N characters`.
- **Storage passwords refused (medium).** Surrounding whitespace was refused in every secret, but the
  suite reads `BWP_FTP_PASSWORD` and `BWP_S3_SECRET_ACCESS_KEY` untrimmed on purpose (V365). Only
  tokens are now strict.
- **The file could change under the reader (low).** `stat` then `readFile` by path: a link swapped in
  between loaded a 30 MiB file 200 times in 400, and one swapped to a FIFO hung the process. Now one
  non-blocking handle is opened, checked, measured and read, never past the cap: 0 in 400, no hang
  (V367).
- **Keys lost without a word (low).** JSON keeps the last of two equal keys, so a second `"secrets"`
  replaced the first; zod's record drops `__proto__`. `lostKeys` (`json-keys.ts`) scans the text
  JSON already accepted and refuses both, with their paths (V366).
- **"One line" only for C0 (low).** U+2028, U+0085, C1 controls, bidi overrides, zero-width
  characters and lone surrogates passed. Text fields now refuse `\p{Cc}`, `\p{Cf}`, `\p{Zl}`,
  `\p{Zp}`, `\p{Cs}`; secrets `\p{Cc}`, `\p{Cs}`.
- **Invalid UTF-8 changed a secret (low).** Decoding replaced a Latin-1 `é` with U+FFFD. Now refused.
- **URLs read as text (low).** Datator's `/` was tested on the raw string, so `…/results#/` passed with
  path `/results` — the 301 the rule prevents; newlines, spaces, a query (`?api_key=`), backslashes
  and an empty Slack hook passed too. Now a URL must be written as `URL` reads it back, with no user,
  password, port, query or fragment.
- **Smaller (low):** `sshHost` accepted `a@-oProxyCommand` and `a@b@c` (OpenSSH refuses both, V368);
  a ref or version may no longer start with `-`; Datator's key must be what `Headers` takes (V369); a
  secret is capped below Linux's 128 KiB per environment string; `1e300` read "must be a whole
  number"; the product and cell a file names are no longer quoted; a mixed or empty pool had the wrong
  message; the `chmod` hint is shell-quoted; the code named plans and phases.
- **Wrong in this plan:** §7.6 and V360 said the uniqueness checks run only once every field is valid;
  they run beside any issue that does not abort (V360, corrected). `formatIssues` keeps the schema's
  order, not the file's.
- **For step 4:** Playwright's command line takes a value starting with `-` as `--grep`'s argument, and
  `--grep --` swallowed the next argument (V368): pass `--grep=<value>`.
- **Kept, on purpose:** an equivalent mutant (Datator's `/` read from the path or the text, once the
  text must equal the parsed URL); keys up to 40 name characters are shown, so a short random key
  pasted as a key would be. Linux's limit is from its source, not measured here (no Linux host).

### 7.8 Step 2 — Implemented (2026-10-13, V372–V376)

M4's pure parts and M6 as planned (§4.4, §4.6): nothing here starts a process or touches a site.

- **`runs/identity.ts`** — `runIdOf` (`bpng-12`; a task's id and a number from 1) and `runIdentity`:
  the `RUN_ID` (`formatRunId(start, id)`, which the pruning dates back to the start, V372), the run's
  folder `runs/<id>/` with `run.log`, `run.json` and `stop`, and its report folder — all absolute. The
  counter that hands out the number is step 5's.
- **`runReportDir`**, added to the suite's `run-id.ts` and now used by `run-context.ts`'s `dirs`: the
  one place `<root>/<product>/<cell>/<RUN_ID>` is spelled, so the suite and the orchestrator cannot
  drift. The orchestrator joins it to `reports` (retention's `DEFAULT_REPORT_ROOT`): runs never get
  `REPORT_ROOT`.
- **`runs/environment.ts`** — §4.4's allowlist exactly: `PATH`, `HOME`, `LANG`, `TMPDIR` when set and
  not empty; `E2E_LOAD_DOTENV=false`, `RUN_ID`, `E2E_CELL`, `E2E_INTERNAL_STOP_FILE`; the task's ref,
  version, requested ref and name, `E2E_RETRIES`, `E2E_REPORTS_KEEP` when configured; the secrets.
  `variableNames` gives the log header names, never values. A spec checks every name against the
  suite's own constants.
- **`runs/results.ts`** reads `results.jsonl` through the suite's `parseResults` (the last
  `scenario.end`/`setup.end` per id, in first-ended place; a last line without its newline read too);
  `scenarioCounts` takes `run.end`'s counts, else counts the ended scenarios, the rest as not run.
  **`runs/facts.ts`** reads only what is reported from `run-facts.json` — edition, requested ref, the
  `plugin` role's name, version, ref and commit, each site's WordPress and PHP, the failed setups — each
  field checked with zod, a malformed one read as unknown and never an error.
- **`runs/outcome.ts`** — §4.4's table, first match wins. Decided here, where the table was silent:
  - **A drain that skipped nothing** (asked for as the last scenario ended: `run.end` present, not
    interrupted, `drained` 0) is judged by its results, not `stopped` — it tested everything, and its
    results reach Datator. An interrupt is always `stopped`.
  - **Stopped from outside** — `run.end` `interrupted`, or a drained scenario, with no stop from the
    orchestrator — is `stopped` too: someone signalled the run by hand.
  - **`error`** also covers: an error outside any test (`run.error`), even beside scenarios that ran —
    the suite calls that run failed, but its results cannot be trusted as a regression; the run's time
    limit (`timedout`); a run whose every scenario was skipped (nothing tested); and a Playwright exit
    its results do not explain (code 0 for a failed run, 1 for a passed one, a signal).
  - The reason is one line: the failed setup's line from the facts, else the stream's; for `bddgen`,
    the log's first line naming an error, else its exit; otherwise the exit and the log's last three
    lines. Credentials masked by shape (the suite's `redactSecrets`) before it is cut to 500 code points.
- **`events/run-finished.ts`** — `run.finished` v1 and `buildRunFinished`, from the run, its outcome,
  results and facts. Unknown facts are `null`, never absent, so a subscriber reads every field. Beyond
  §4.6: **`plugin.name`** (the `Plugin Name:` header — Slack's "BackWPup Pro 9.99.99"); an interrupted
  scenario counts as **`didNotRun`** (the six counts stay §4.6's); a scenario's error keeps its lines,
  ANSI stripped, capped at 2,000 code points (the stream's own cap).
- **`events/bus.ts`** — `createEventBus({ timeoutMs, log })`: `on`, `publish` (returns at once),
  `settle` (until nothing is in flight, an event published meanwhile included). Each handler gets an
  `AbortSignal` that aborts at its time limit — for `fetch` — and a throw, a rejection or a timeout is
  one masked log line under the subscriber's name. Default 30 s.
- **`text.ts`** — `cut` (by code point), `oneLine` (the suite's `plain`, whitespace collapsed),
  `safeLine` (masked, then one line, then cut).
- **Admitted** to `suite-imports.json`: `results-reader.ts` and `results-schema.ts` (the stream's
  reader and types) and `text.ts` (`plain`, `redactSecrets`) — each pure, the boundary spec passing
  with them (V375). `run-facts.ts` is not: it imports the reporter's whole summary; `facts.ts` reads
  the file itself, and a spec checks the file name against the suite's.
- **For step 3:** a Slack webhook URL is a credential with no shape `redactSecrets` knows. A sender
  must never put its URL or key in an error; the bus masks them by value when given `secretValues`
  (§7.9).
- **For step 4:** the stop machine reports how far it went (`StopTaken`). A stop while `bddgen` runs
  kills its group, but nothing was tested yet: report it as `drained`, so the run reads `stopped`, not
  `killed`.

### 7.9 Audit of step 2 (2026-10-13, V377–V382)

Two reviewers, one on security and one on correctness, each on its own copy; the correctness reviewer
drove the suite's real reporters through 13 run shapes (pass, fail, flaky, failed setup, all skipped,
drained, `afterAll` failure, a real SIGINT, `--max-failures`, a filter matching nothing,
`globalTimeout`) and checked the code against all 24 real streams in `reports/` (V377). Every finding
was reproduced, then fixed, and every fix proved by a mutation (V381).

- **The bus could crash the orchestrator (medium; both reviewers, and our own review).** A `log` that
  throws (a full disk), or a handler throwing something `String()` cannot print (`Object.create(null)`,
  a `message` getter that throws, a `message` that is not text), made the delivery reject: `settle`
  rejected and the voided `finally` became an unhandled rejection — exit 1 (V378). Now a failing log
  drops its line, `describeFailure` is total, and nothing in the bus can reject.
- **Masking before cleaning let a credential through (medium).** `safeLine` masked, then cleaned: a
  token split by a terminal code, a zero-width space, a bidi override or a soft hyphen was missed, then
  joined whole by the cleaning (`ghp_\u200b…` → `ghp_…`). Masking only after cleaning fails the other
  way: a URL password holding a control character becomes two words. Now masked on both sides; the log
  tail's lines too, which were cleaned before any masking.
- **Untrusted fields reached the outcome and the event (medium).** The suite's reader trusts a known
  line's fields: `run.end` with `scenarios: null` crashed `runOutcome`; an `error.message` that is not
  text crashed `buildRunFinished`; a 200,000-deep `path` built an event `JSON.stringify` cannot write; an
  unknown status corrupted the counts (`constructor: "function Object() …1"`). Now `results.ts` checks
  every field it uses with zod: a line of the wrong shape is dropped, a count of the wrong type reads as
  0, a `path` is text and at most 8 deep.
- **Secrets the orchestrator holds were masked only by shape (low).** A storage password, a legacy
  40-hex token, the webhook's path have no shape. `secretValues(config)` (`config/secrets.ts`) lists
  them — the runs' secrets, the webhook whole and its path, Datator's key — and the reason, the event's
  text and the bus's lines mask them by value, the longest first: a value inside a longer one, masked
  first, left the longer one's rest in clear — found by the audit's own test.
- **The event carried raw text (low).** Names, versions, URLs and errors are now made safe: masked,
  terminal codes removed, control and invisible characters dropped; a name or fact one line, an error a
  block whose line feeds are kept (CR, U+0085, U+2028 become line feeds). Slack must still escape `&`,
  `<`, `>` (step 3).
- **`publish` ran handlers inside itself (low).** An async wrapper runs up to its first `await`, so a
  handler's synchronous part ran in `publish`, and a handler publishing again re-entered it (1,235 deep,
  then a stack overflow). A handler now starts a turn later: 2,000 synchronous re-publishes run at depth
  1. The spec claiming "returns before any handler has run" passed only because its flag was set after
  an `await` (fixed). Synchronous work still cannot be interrupted by the time limit; the doc says so.
- **Two reasons could never appear (low).** The stream writes every `onError`: a filter matching nothing
  writes "No tests found" (and Playwright then drops the setups too), and `globalTimeout` writes "Timed
  out waiting …" before `run.end` `timedout` (Playwright 1.63 `runner/index.js:6182–6186`). Both read
  as "an error outside any test". "No tests found" is now skipped by the suite's own rule (a spec checks
  the copy against `isNoTestsFound`), and the time limit is checked first.
- **Smaller (low):** `cut` returned more than `max` for `max < 1` — now a `RangeError`; four variable
  names were literals in `project.ts` the orchestrator copied — now `run-env.ts`, used by both, admitted
  (V380); a `run.end` `failed` with no failed scenario and no error read `passed` — now `error` (not seen
  in practice: Playwright fails a run only for a failed test or an `onError`, V377); `facts.ts` read a
  `requestedRef` nothing used — removed.
- **Added to `run.finished` v1 before anything consumes it:** `run.task.grep`, which Datator's
  `test_suite` needs (D1).
- **Wrong in this plan:** §7.8 said `publish` "returns at once" (its handlers ran inside it) and
  that reasons are masked by shape only (now by value too); V373 said every name is checked against the
  suite's constants (four were not, until `run-env.ts`).
- **Checked sound:** the allowlist (an inherited `NODE_OPTIONS`, `GITHUB_TOKEN`, `RUN_ID`,
  `E2E_LOAD_DOTENV=true` dropped); paths (cell names cannot hold `..` or `/`); `facts.ts` on 200,000-deep
  nesting and wrong types; the bus's timers; the admitted modules; the report folder equal to
  `run-context.ts`'s in a child process; every outcome row against real runs. `__proto__` in `secrets`
  is refused by step 1's `lostKeys` before the schema runs (a reviewer tested the schema alone).
- **For step 4:** read `results.jsonl` with a size cap — `readRunResults` takes the whole text (a 50 MB
  stream: 169 ms, 423 MB resident). Pass `secretValues(config)` to `runOutcome`, `buildRunFinished` and
  the bus.

### 7.10 Step 3 — Implemented (2026-10-13, V383–V386)

M7 and M8 as planned (§4.7, §4.8), in `orchestrator/notify/`: pure formatters, thin senders. Nothing is
subscribed to the bus yet — that is step 5's wiring.

- **`post.ts`** — `postJson`, the one HTTP call: a JSON `POST` with `fetch`, 15 s by default and the
  bus's signal too (`AbortSignal.any`), answering a `Delivery` (`ok` and the status, or the status and
  a `detail`) and **never rejecting**. A **redirect is not followed** (`redirect: "manual"`): `fetch`
  would follow Datator's `301` with a `GET` and report the page it landed on (V384). At most 8 KiB of
  an answer is read, the rest cancelled; `detail` is its first 500 characters, one masked line. With
  no answer, `detail` is in our own words — the time limit, `cancelled`, or the network error's code
  (`ECONNREFUSED`) — never `fetch`'s message, so the URL cannot reach a log.
- **`slack.ts`** — `slackMessage(event, { instance, sshHost })`, §4.7's text. Decided here, where §4.7
  was silent: the headline names `plugin.name`, else the product; a count shows only when not 0
  (`skipped`, `did not run` too); `Reason:` for every status that has one, so a stopped run's message
  says why beside what it tested; `COULD NOT TEST` drops the counts and lists and adds `Took:` and
  `Log:`; the 20 listed scenarios are failed first, then flaky, each list ending "…and N more" when
  cut; a scenario's error is its first non-blank line. Every piece is escaped and bounded **after**
  escaping (`escapeCut`, never inside `&amp;`), so the worst event is under 20,000 characters (§7.11). A path
  becomes `scp [-r] <host>:<path> .`, single-quoted when a shell would split it. `sendSlack` succeeds
  only on `200` with body `ok`, and masks the webhook — whole and its path — in Slack's answer.
- **`datator.ts`** — `datatorPayload(event)`, §4.8's mapping, `undefined` for `error`, `stopped`,
  `killed`. Guards for what Datator's serializer refuses — each refusal measured against its own code
  (V385), and each one loses the whole run: a name blank after trimming is `(unnamed)`; a lone
  surrogate becomes U+FFFD (`toWellFormed`); a commit that is not 40 or 64 hex digits is `null`;
  `website_url` is `null` unless Django's `URLValidator` surely accepts it — `http://wp-apache`, a
  Docker cell's host, is refused. An interrupted scenario is `skipped`; `test_suite` cut to 255.
  `sendDatator` succeeds only on `201`, and masks the key in the answer.
- **For step 5:** subscribe both with `secretValues(config)`, hand each the bus's signal, and turn a
  failed `Delivery` into the terminal's `slack ✗ …` line; keep the Datator payload in `run.json`.

### 7.11 Audit of step 3 (2026-10-13, V387–V392)

Two reviewers, one on security and one on correctness, each on its own copy, over real local servers,
Datator's own app and OpenSSH's `scp` against a fake `ssh`. Every finding was reproduced, then fixed,
and every fix proved by a mutation (V391).

- **A secret the read cap cut through showed its start (medium).** The 8 KiB cap came before masking:
  a key straddling it was neither whole (value) nor recognisable (shape), and padding the cleaning
  collapses (spaces, zero-width characters) put its first 20 characters at the head of `detail`
  (V387). Now a cut answer loses its last 256 code points — or the longest secret's length — after
  cleaning and masking, before the 500-character cut.
- **Datator's URL check was weaker than §7.10 said (medium-low).** `acceptedUrl` judged the host
  `new URL` had rewritten but returned the text as written: `http://010.1.1.1/`, `http://127.1/`,
  `ex%61mple.com`, a space or tab in the path, `http:/a.com` passed it, and Datator refused the whole
  record (V388). Now a URL is kept only when the parser writes it back unchanged (a trailing `/`
  aside): of 2,790 URLs, none it keeps is refused by Django (V389).
- **Secrets echoed in another form were not masked (low).** A service may quote a value URL-encoded
  or inside a JSON string (`\"`, and PHP's `\/`). `secretForms` (`text.ts`) gives each form, and every
  mask — the event's, the bus's, the senders' — masks them all.
- **What masking cannot cover is withheld (low).** A value under 8 characters is never masked by value
  (it would mask words), and the config does not bound Datator's key, whose length Datator's docs do
  not state. An answer still quoting any secret, in any form, is now withheld: `HTTP 403 (its answer is
  withheld: it quotes a secret)`.
- **The webhook's token alone was not masked (low).** Only the whole URL and its path were; the last
  segment is the token. `webhookSecrets` (`config/secrets.ts`) gives all three to `secretValues` and
  `sendSlack`.
- **`postJson` could reject (low).** `AbortSignal.timeout` refused a time limit out of range and
  `AbortSignal.any` a non-signal, both outside its `try`. Now an invalid time limit is a failed
  delivery, and the signals are built inside the `try`.
- **Slack (low).** The site lines were not bounded (100 sites: 60,723 characters): at most 10 now,
  then "…and N more sites", the worst message under 20,000. A lone surrogate reached Slack's JSON:
  `escapeSlack` makes it U+FFFD. Links are not previewed (`unfurl_links`, `unfurl_media` false — the
  fields Slack's own webhook client sends). `Report:` and `Log:` are code, so an `_` in a path is not
  italics, unless the path holds a backtick. A commit with no ref read `· @ abc`: now `commit abc1234`;
  a scenario with no name at all is `(unnamed)`. `escapeCut` refuses a bound under 1, as `cut` does.
- **Stated, not changed:** the `scp` quoting serves the local shell; the far end still reads the path
  — a `*`, `?` or `[` is a pattern in scp's SFTP mode, and legacy `-O` hands it to a remote shell
  unquoted (V390). The paths are the checkout's and the state directory's. Slack's formatting (`*`,
  `_`, a bare link, `:emoji:`) is left to it: a run can style its text, not ping or hide a link.
  Node's fetch honours proxy variables only with `NODE_USE_ENV_PROXY`, the operator's choice.
- **Checked sound:** redirects not followed; errors carry only a code; a 500 MB gzip answer (509 KB on
  the wire) read in 6 ms, 13 MB resident; endless and trickled bodies bounded; escaping never split;
  run text masked before escaping, so `&amp;` cannot hide a secret; `formatDuration`'s rounding; the
  list cap's room never negative; Datator's trim and lengths (code points) matching Python's; no NUL
  reaches it; the tests 1,000 out of 1,000 at `--repeat-each 20`.

### 7.12 Step 4 — Implemented (2026-10-13, V393–V398)

M4's launch and end and M5 as planned (§4.4, §4.5), in `orchestrator/runs/` and `orchestrator/state/`.
Nothing is wired to a loop or to signals yet — that is step 5's.

- **`commands.ts`** — `suiteCommands`: Node itself running `bddgen`'s and the runner's own entry
  scripts (their `bin`), with `--config playwright.<product>.config.ts`; the filter is one argument,
  `--grep=<value>` (V368).
- **`process-group.ts`** — `groupAlive` (`kill(-pgid, 0)`: only `ESRCH` is empty, `EPERM` is alive),
  `signalGroup`, `waitForEmptyGroup` (an injected `kill` and `sleep`); a group id under 2 is refused,
  since `-0` and `-1` reach the orchestrator's own group or every process.
- **`stop.ts`** — the run's stop machine, pure: `stepRunStop(state, event)` → state and actions
  (`createStopFile`, `interrupt` — one SIGINT to the runner's PID —, `killGroup`). A stop only goes
  further, each step at most once; an interrupt asked for at once drains first; a kill needs nothing
  before it. While `bddgen` runs, any stop kills its group and is taken as `drained` (§7.8); before or
  between the processes it is a drain with nothing to do, and `mayStartPlaywright` then refuses the
  runner. A process starting once a stop was taken is killed at once.
- **`shutdown.ts`** — the orchestrator's stop, a pure reducer (`stepShutdown`) and a driver over
  injected timers (`createShutdown`): §4.5's table and budgets, SIGINTs under 1 s after the last one
  counted are one. Decided here, where §4.5 was silent: **only SIGINT escalates** — SIGTERM and SIGHUP
  start the drain when nothing is stopping, and otherwise do nothing, so an SSH session closing after a
  Ctrl-C, or a service manager repeating SIGTERM, cannot cut the drain the operator chose short. The
  reason names the cause and the escalation (`…(SIGINT); interrupted: the drain took over 15 min`).
  The process's handlers are step 5's.
- **`launch.ts`** — `launchRun`: refuses a stop file already there, opens `run.log` (`0600`), spawns
  each process `detached` with exactly the environment given, its output into the log under our
  `[orchestrator]` lines (the variables' names, each command, each exit, each stop — never a value),
  waits for each group to empty, and carries out the stop machine's actions in order; a failed action
  is a log line, never a throw. Decided here: **a group that outlives its process by 5 min is killed**
  (`LINGER_MS`, past the interrupt budget, so a worker's teardown is never cut, only a hang) — not a
  stop, the run's results stand. A command Node refuses or cannot start ends the run with no code and
  its error's code in the log.
- **`end.ts`** — `endRun`: reads `results.jsonl` (at most 32 MiB; 8 MiB since §7.13), `run-facts.json` (1 MiB) and the
  log's last 40 lines (from its last 64 KiB, ours left out), opened non-blocking and only when a
  regular file (a FIFO there would block an `open`, V367); then `runOutcome` and `buildRunFinished`, both
  given the secrets. Only the outcome and the event leave it — never the files' raw text. A stream
  over the cap is reported as such (`resultsUnread`, added to the outcome), not as a run that never
  finished.
- **`record.ts`** — `run.json`: `running` (with the process and its group once one runs) and `ended`
  (the exits, the stop, the event); `readRunningRecord` reads back what step 5's orphan check needs.
  **`state/atomic.ts`** — `writeJsonAtomic` (a `wx` temporary file beside it, `0600`, then `rename`),
  for the record and step 5's counter.
- **A fake suite** (`__fixtures__/fake-suite.ts`): one `node -e` script that traps SIGINT, watches the
  stop file and can leave a child in its group; the launch specs run against it with real signals.
- **For step 5:** call `signal` from `process.on` for the three signals and stop every run on
  `onEscalate`; `dispose` once every run has ended. Write the record on `onProcess` and at the end; the
  orphan check reads `running` records with a live group (`groupAlive`). `SHUTDOWN_SIGNALS` lists the
  handlers to install. See also §7.13's notes for step 5.

### 7.13 Audit of step 4 (2026-10-13, V399–V405)

Two reviewers, one on security and one on correctness, each on its own copy; the correctness reviewer
drove `launchRun` and `endRun` through the real `bddgen` and runner, on a placeholder product of its
own that touches no site, with a reporter slow on purpose. Every finding was reproduced, then fixed,
and every fix proved by a mutation (V404).

- **A SIGINT after the tests killed the runner mid-report (medium).** Playwright 1.63 disarms its SIGINT
  watcher once the tests are over, and with the last handler gone it removes its process `SIGINT`
  listener (`runner/index.js:6097–6110, 6176`): a SIGINT while the reporters write — HTML, Cucumber,
  Allure, the summary, the pruning — took the default action, the reports cut, and a run whose stream
  said `passed` read `stopped` (V399). Phase 0 only ever measured a SIGINT during tests. Now the launch
  sends no SIGINT once the stream holds `run.end` (`stream-end.ts`: the suite writes it synchronously,
  before the slow reporters), and logs that it did not; the kill budget still guards a hang. An
  interrupt that came too late — the runner then ending on its own with a complete run — is judged by
  its results, like a drain that skipped nothing; one whose runner a signal ended stays `stopped`.
  Checked against the real runner: an interrupt during `onEnd` or `onExit` now lets both finish, exit 0,
  `passed`; one during the tests still gives exit 130, `stopped` (V400).
- **A failing `onProcess` orphaned the run (medium; both reviewers, and our own review).** A throw left
  `bddgen`'s detached group running unwatched and rejected `launchRun` (or `done`, on the runner); an
  async callback's rejection ended the orchestrator on an unhandled rejection, the group left behind.
  Step 5 writes the record there. Now a throw or a rejection is a log line, and the run is watched to
  its end.
- **The log was opened through whatever was there (low-medium).** `open(log, "a")` followed a symbolic
  link, blocked for ever on a FIFO (and kept the process from exiting), and kept a wider mode. Now it is
  created exclusively (`O_CREAT|O_EXCL|O_NOFOLLOW`, `0600`): a run's log is new, so anything there is
  refused before anything is spawned. The run folder must be a real folder of this user's, mode `0700`
  — `mkdir` keeps an existing one as it was.
- **Signals waited behind log writes (low; our own review).** The stop machine's actions ran in the
  log's queue: a SIGINT could come after the step that should follow it, and a signal after its group
  emptied. Now they run at once, synchronously — the stop file with `writeFileSync`.
- **A stop as the log was flushed changed the run (low).** After a failed `bddgen` the phase stays
  "between", so a stop arriving while the log closed turned `error` into `stopped`, losing `bddgen`'s
  error, and wrote to a closed log. Now no stop changes a run once nothing runs any more.
- **Our lines ran into a process's last output (low; both reviewers).** Output without a newline put our
  next line on its line, and the reason quoted it. Now our line starts on a line of its own, and the
  tail strips one of ours from anywhere in a line.
- **Smaller (low):** the log tail dropped a whole line the window started on (now one byte before the
  window decides); the shutdown's debounce read the wall clock, so a clock stepped back ignored every
  Ctrl-C (now `performance.now()`); a group that could not be killed after the linger read as ended
  while it still held the cell (now the wait goes on, and the log says why); a 32 MiB stream of nested
  brackets took 2.3 GB to parse (V401) — the cap is now 8 MiB and a line over 256 KiB is skipped
  unparsed; a spec claiming "ignores a stop once the run has ended" could not fail (it asserted a result
  taken before the stop).
- **Kept, on purpose — equivalent mutants (V404):** `O_NOFOLLOW` (`O_CREAT|O_EXCL` already refuses a
  link); `streamHasEnded`'s regular-file check (a non-blocking read of a FIFO fails anyway, and a
  failure reads as "not over") — both kept as the stated rule, against a device.
- **Checked sound:** the child's environment exactly as given (`NODE_OPTIONS` not inherited), no file
  descriptor of the orchestrator's but `run.log` inherited (`lsof`), groups and sessions their own (`Ss`),
  only SIGINT to the runner and SIGKILL to `-pgid`; `run.json` and the atomic write never written through
  a link, `0600` under `umask 0`, 200 concurrent writers with no torn read; the shutdown table, re-entrant
  `onEscalate`; no flakiness at `--repeat-each 40 --workers 16` with the CPU loaded.
- **For step 5:** a `running` record names a group by its number only: after a crash, once that group
  has ended, the number can lead an unrelated one, and the orphan check would refuse the task and name a
  stranger's group to kill (V402). Record what identifies the leader — its start time, read at spawn —
  and treat a record whose leader no longer matches as stale. Serialise each run's record writes: a late
  `running` write must never replace `ended`.

### 7.14 Step 5 — Broken down (2026-10-13)

**TL;DR.** Five small parts first, each a module and its spec that need nothing else new: the logger,
the lock and counter, the leader's identity with serialised records, run-folder retention, and the
notification subscribers. Then two compositions: one run (5F) and the task loop (5G). Then the process
itself (5H) and the command (5I). It ends with the live checks (5J) and an audit (5K). Every phase
passes the four gates. Every module takes its clock, filesystem paths, `kill` and launch as arguments,
so the fake suite (§7.12) can drive everything up to 5I with real signals and no site.

**Stack:** what is already here (Node ≥ 24.16, TypeScript 6, zod 4, the Playwright unit runner), plus
**commander 15.0.0**, the latest stable (`npm view`, 2026-10-13), added in 5I and nowhere else.

| Phase | Goal | Depends | Parallel with |
| --- | --- | --- | --- |
| 5A | `log.ts`: the logger | — | 5B–5E |
| 5B | `state/lock.ts`, `state/counter.ts` | — | 5A, 5C–5E |
| 5C.1 | The leader's identity, serialised record writes (V402) | — | 5A, 5B, 5D, 5E |
| 5C.2 | `state/orphans.ts`: the orphan check | 5C.1 | 5A, 5B, 5D, 5E |
| 5D | `state/run-retention.ts`: run folders pruned | — | 5A–5C, 5E |
| 5E | `notify/subscribe.ts`: Slack and Datator on the bus | 5A | 5B–5D |
| 5F | `tasks/cycle.ts`: one run, from counter to `run.finished` | 5A–5E | — |
| 5G | `tasks/loop.ts`: the cycle, cooldown, `--once` | 5F | 5I.1 |
| 5H | `start.ts`: the process — lock, orphans, signals, loops, exit | 5G | 5I.1 |
| 5I.1 | `--dry-run`'s report, pure | — (step 1) | 5A–5H |
| 5I.2 | `cli.ts` with commander, the `orchestrator` script | 5H, 5I.1 | — |
| 5J | Live checks (§9) on `bwu2`/`bwu3` | 5I.2 | — |
| 5K | Audit: reviewers, mutations, V-rows | 5J | — |

- **5A — The logger** (`orchestrator/log.ts`). A `Logger` interface (`line(scope, text)`) with two
  outputs: the terminal and `orchestrator.log`. The file is appended through one queue and opened
  without following a link, `0600`. Each line is `HH:MM:SS <scope> <text>` (§4.1) and passes through
  `text.ts`'s safe line, masked by the config's secret values. A closed terminal (`EPIPE`, `EIO` after
  SIGHUP) stops writes to the terminal; the file keeps them. **Done:** the spec covers the format, the
  masking, the terminal failing while the file still writes, and an injected clock.
- **5B — Lock and counter.** `orchestrator.lock` is created exclusively and holds the pid. A live pid
  refuses the start and names that pid; a dead pid's lock is taken over. The lock goes when the
  process ends. `tasks/<id>.json` stores the run counter through `writeJsonAtomic`, and the number is
  saved **before** the run starts, so a crash never hands it out twice. A counter that cannot be read
  is a refusal, never a silent reset to 1. **Done:** specs cover a race between two starts, a dead
  pid, `EPERM` read as alive, a corrupt counter, and a mode of `0600`.
- **5C.1 — The leader's identity (V402).** At spawn, read the leader's start time. Measure the source
  on macOS and on Linux (Ubuntu 24.04) before choosing it (`ps -o lstart=`, `/proc/<pid>/stat`).
  Record it next to `pgid` in the `running` record, and add `leaderMatches(record)`. Record writes go
  through a per-run queue, and once `ended` is written, a later `running` write is dropped.
  **Done:** a spec shows a late `onProcess` write never replaces `ended`, and that a reused pid with a
  different start time reads as not matching.
- **5C.2 — The orphan check.** Read every `runs/*/run.json` that is still `running`, through
  `readRunningRecord`, and sort them into two kinds. **Orphan:** the group is alive (`groupAlive`) and
  the leader matches. **Stale:** anything else; it is rewritten as ended-unknown, so it is not read
  again. An orphan refuses the start, naming the task, the run and `kill -KILL -<pgid>`. **Done:** a
  spec covers each kind, plus a malformed record (a warning, never a crash).
- **5D — Run-folder retention.** List `runs/<task>-<n>/` for one task. Date each folder from its
  record's `startedAt`, never its mtime. Then call `planRetention` and `applyRetention` with the
  config's `reportsKeep`, never touching the run in progress (§4.9). **Done:** a spec runs on a fake
  tree and covers an undated folder being kept and the current run being kept.
- **5E — Subscribers.** `subscribeNotifications(bus, config, logger)`: subscribes Slack and Datator
  when each is configured, with `secretValues(config)` and the bus's signal. It prints one line per
  run, `slack ✓ · datator ✓ 201`, or `✗` with the masked reason. The Datator payload is returned so it
  can be kept in `run.json`. **Done:** specs against `http-sink.ts` cover each one alone, both, one
  failing, a timeout, and an unconfigured sender left out.
- **5F — One run.** `runOnce(task, deps)`: takes the counter's next number, builds the identity and
  the environment, then calls `launchRun` with `onProcess` writing the record (5C.1) and logging the
  "started" line. Then `endRun` writes the `ended` record (with the payload), logs the outcome line,
  publishes `run.finished`, and prunes (5D). It exposes `stop(level)` for 5H. The launch is injected.
  **Done:** fake-suite specs show passed, failed, `bddgen` failing, a stop at each stage, and that a
  throw from any dependency is logged and the run is still recorded.
- **5G — The loop.** `runTask(task, deps)`: runs the cycle, then the cooldown counted from the run's
  end, then the next cycle. A stop during the cooldown ends at once, and no run starts after a stop.
  `--once` gives one cycle and its status. It logs the `next run HH:MM:SS (cooldown Nm)` line.
  **Done:** specs with an injected clock cover the cooldown, a stop in the cooldown, a stop mid-run,
  and `--once`.
- **5H — The process.** `start(options, deps)`: loads the product list (`loadProductList`) and the
  config, then takes the lock, runs the orphan check, sets up the bus and subscribers, and starts every
  task's loop at once. It installs `SHUTDOWN_SIGNALS` → `shutdown.signal`, and on `onEscalate` stops
  every run. It waits for every loop, then `bus.settle()`, `dispose`, and releases the lock. It returns
  the exit code: `0`/`1` with `--once`, `130` when stopped, `1` on a config error. `process` is
  injected (signals and exit). **Done:** fake-suite specs cover two tasks at once, a refused lock, a
  refused orphan, one, two and three SIGINTs, SIGTERM, and that all handlers are removed at the end.
- **5I.1 — Dry run.** `dryRunReport(checked)`, pure: each task, its sites and their servers, and the
  warnings, never a secret. **Done:** a spec over the example config.
- **5I.2 — The command.** `cli.ts`: commander 15, `start [--config] [--task…] [--once] [--dry-run]`,
  and `"orchestrator": "tsx orchestrator/cli.ts"`. It is the boundary spec's one exclusion, and
  `suite-imports.json` stays unchanged. **Done:** a child-process spec covers `--help`, an unknown
  task, `--dry-run` on the example config, and exit codes.
- **5J — Live (§9).** First, name to the user the sites to be used. Then: both cells `--once`
  together; two cycles at a 1-minute cooldown; one Ctrl-C mid-scenario (drained, `stopped`, site as
  found); two Ctrl-C; SIGTERM; SIGKILL of the orchestrator, then a start that refuses on the orphan.
  Slack and Datator go to the local sink and the local Datator only (D5, D6). Run under `caffeinate -i`.
- **5K — Audit.** As for steps 1–4: a reviewer on security and one on correctness, each on its own
  copy; mutations of every phase; findings fixed and proven; V-rows in §11.

## 8. What later phases change, and keep

| Here | Later | Kept |
| --- | --- | --- |
| Tasks in a JSON file, read once | The task store (SQLite), edited through the API | The task fields and ids — imported as they are |
| The run builds its plugin | The orchestrator builds and pins (`E2E_PLUGIN_REF=commit:<sha>`) | Everything else the run is given |
| The suite prunes reports per cell | The orchestrator prunes per task, the suite's end-of-run pruning off — by a switch still to add (`E2E_REPORTS_KEEP=0` lifts only the cap; Phase 0 §8.3) | 0F's planner |
| `start` in the foreground, in `tmux` | The same process under systemd; the command talks to it over the socket | Signals, stop, loop |
| One event, two subscribers | More events; dashboard, `watch` | The bus and `run.finished` v1 |
| Run records as JSON | Rows in the store | The record's fields |
| A `Logger` writing lines | pino | The interface |

## 9. Verification plan

- **Unit**: config errors by path; the environment (exact keys; nothing else inherited); the outcome
  table, row by row; `run.finished` from recorded `results.jsonl`/`run-facts.json` fixtures; Slack text
  (escaping, caps, every headline); the Datator mapping (500-character cuts, integer duration, flaky,
  skipped, `null` commit); the bus (a slow and a throwing subscriber); the stop machine (debounce,
  budgets, `ESRCH`, never SIGTERM); the lock; retention.
- **A fake suite**: the launch command is injectable, so the loop, stop and orphan paths run against a
  small Node script that writes a `results.jsonl` and traps SIGINT — no Playwright, no site.
- **Datator without production** while developing: every payload goes to a local Datator built from
  its own `e2e_tests` app (V118's harness, as a server), and must get `201`. Production receives its
  first post from the first real run (D6).
- **Slack**: a local sink while developing; AutoE2E's webhook from the first real run (D5).
- **Live** on `bwu2`/`bwu3`, named to the user first: both cells `--once` together (one product, side
  by side); two loop cycles at a 1-minute cooldown; one Ctrl-C mid-scenario (drained, `stopped`, site
  as found); two Ctrl-C; SIGTERM; SIGKILL of the orchestrator, then a start that refuses on the orphan.
- **On the runner**: §6 end to end, and V122 again on Linux — one Ctrl-C under `npm run` must still
  read as one.

## 10. Decisions

| # | Question | Decision |
| --- | --- | --- |
| D1 | Datator's `test_suite` for these runs | **The cell** (`pro@nginx`; `pro@nginx @smoke` when filtered) — decided 2026-10-05. Reusing AutoE2E's `test:bwpup` would merge two different suites into one series; dashboards filtering on `test:bwpup` need the new value |
| D2 | A flaky scenario in Datator | **`passed`**, as AutoE2E's three values — decided 2026-10-05. `flaky` is accepted (V118) but unknown to the dashboards; `skipped` scenarios count as neither passed nor failed, unlike AutoE2E |
| D3 | Updating the suite on the runner | **By hand, while stopped** (§6.7), until the planned update exists — decided 2026-10-05. One checkout serves every cell, and a run reads its files while it runs (`bddgen`, step files, `node_modules`), so updating it under a running cell breaks that run; AutoE2E avoids this with one checkout per instance. The planned update — a new-version notice, auto-update, "update now" after a y/N — is in the parent's §3, Updating the suite |
| D4 | The machine, and the cells and sites it runs | **The user's, after this phase** (2026-10-05). The phase keeps it easy: the example config, `--dry-run`, `--once`, and §6 as a copy-paste guide in `docs/guides/orchestrator.md` |
| D5 | Slack destination | **AutoE2E's**: the same incoming webhook, so the same channel (`#wpmedia_auto-e2e-reports`) — decided 2026-10-05 |
| D6 | The first production Datator post | **The first real run** — decided 2026-10-05; development posts go to the local Datator only |

## 11. Verification

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| V114 | AutoE2E's cycle: first at once, then a 5-minute `setInterval` that skips while a cycle runs; per cycle, plugin and suite `reset --hard origin/develop`, an out-of-repo compile script, `npm run <suite>` with output inherited, results moved to `test-results-storage/<timestamp>` and folders over 4 days deleted, `cucumber-report.json` parsed (a scenario with a skipped step counts as failed) | ✅ source | `auto-e2e.js` @ `fa0a5b6`: `start`, `runCycle`, `cloneOrUpdatePlugin`, `zipPlugin`, `updateE2ERepo`, `runE2ETests`, `saveTestResults`, `deleteOldTestResults`, `analyzeCucumberReport` |
| V115 | AutoE2E's messages: Slack text with an optional `*[instance]*` prefix, ✅/❌ and counts, failed `Feature - Scenario` names, WP-CLI versions, an `scp` hint with a masked host; `❌ Auto E2E Script Error!` with no reason on any exception. Datator through `curl` without `-f` — an HTTP error is not noticed — with `website_url` added on 2026-10-02 (PR #19; V23 predates it); nothing sent when a cycle throws | ✅ source | `auto-e2e.js` @ `fa0a5b6`: `sendSlackMessage`, `sendDataToDatator`, `getWebsiteUrl`; `git log` (`408dd79`, `fa0a5b6`) |
| V116 | AutoE2E runs as four PM2 processes, one per Linux user, under `xvfb-run -a -s "-screen 0 1920x1080x24"`, restarted 5 s after a crash; suites `test:bwpup` and `test:e2e` | ✅ source | `scripts/manage-e2e/manage-e2e.sh` (`get_suite_arg`, `start`), its README |
| V117 | Datator's E2E API: `POST /e2e_tests/results/`, `X-API-Key` compared to `E2E_TESTS_API_KEY` (else `403`); `201` on success, `400` with field errors; `product`, `test_suite` free text ≤ 255; `timestamp` a datetime; three required integers; `git_commit` ≤ 255, `test_duration_seconds` integer, `website_url` URL ≤ 255 — all three optional; `test_cases` optional, each `feature_name`/`test_name` ≤ 500, `status` ≤ 20 free text, `error_message` text. No enum, no cross-field check; DRF authentication classes empty | ✅ source | `wp-media/datator` @ `0cff7bc`: `e2e_tests/models.py`, `api/serializers.py`, `api/views.py`, `urls.py`, migrations `0001`–`0002`, `settings/base.py` |
| V118 | Datator's own view, run locally, accepts the planned payload and refuses its edges: `201` for a typical run, `flaky`, `total ≠ successful + failed`, `null` URL or commit, `release-5.7.6` as commit, `845.0`, a zone-less timestamp, no or empty `test_cases`, Unicode, a 2.6 MB body; `400` for a 501-character `test_name` or `feature_name`, a 21-character `status`, `845.7`; `403` without or with a wrong key | ✅ 2026-10-05 | Django 4.2.1 + DRF 3.14.0 (Datator's pins) in a venv, Datator's `e2e_tests` app unmodified, SQLite in memory, its URL and view through Django's test client; 22 payloads |
| V119 | Production answers at the URL AutoE2E uses: `GET` → `405`; without the trailing slash → `301` to it | ✅ 2026-10-05 | `curl` to `https://datator.wp-media.me/e2e_tests/results/` and `…/results` — read-only, nothing stored |
| V120 | Slack incoming webhooks: success is `200` with body `ok`; only `&`, `<`, `>` need escaping (as `&amp;`, `&lt;`, `&gt;`); `text` beyond 40,000 characters is truncated; errors include `invalid_payload`, `no_service`, `channel_is_archived`, `action_prohibited` | ✅ docs | docs.slack.dev (via Context7): success is HTTP `200` with the plain-text body `ok`; formatting, "truncating really long messages", "sending messages using incoming webhooks" |
| V121 | A `detached` child is the leader of a new process group and session; a terminal-style SIGINT to the orchestrator's group reaches the orchestrator and an attached child, not a detached one; SIGKILL to the detached group works | ✅ docs + macOS | Node v24.21.0 `child_process.md:913`; a probe: parent and attached child got SIGINT, the detached child stayed alive, `kill(-pgid)` ended it. Linux not measured |
| V122 | One Ctrl-C reaches a program as: **2 SIGINTs** 1–31 ms apart under `npm run` (npm then waits for it); 2 under `npx tsx`; **3** under `npm exec`, whose npm exits in 76 ms and the program never finishes; **1** under `tsx` or `node --import tsx`. SIGTERM to `npm run` is relayed once | ✅ 2026-10-05, macOS | A signal-logging probe started each way in its own process group, which then got one group SIGINT; npm 12.0.2, tsx 4.23.15 |
| V123 | APVM's BackWPup build runs `composer install`, `npm install`, `gulp buildAssets`, `npx tailwindcss`, `gulp free/pro`; it declares npm, composer and gulp (`npm install --global gulp-cli`) as required tools, git underneath; the project is private (a token is required); v3.0.0 ships `linux-x64-gnu` and `linux-arm64-gnu` binaries | ✅ source | APVM `cli/v3.0.0`: `crates/core/src/build/plugins/bwu.rs` (`tool_dependencies`, `setup_commands`, `build_commands`), `projects/registry.rs`, the tag's file list |
| V124 | APVM's cache grows ~17 MB per BackWPup commit built (Free 8.4 MB + Pro 9.8 MB); `develop` had 9 commits in the last 30 days | ✅ 2026-10-05 | `~/.apvm/cache/backwpup/commits/9.99.99/*` (5 entries, 17 MB each); GitHub commits API since 2026-09-05 |
| V125 | The suite holds 61 BackWPup scenarios in 12 features (9 of them in the two `@pro` features 6F.4 added); WP Rocket has 3 scaffolding scenarios, all `@noauth`. A full BackWPup run took about 50 minutes per cell at 42 scenarios | ✅ | `src/projects/*/features/*.feature`; phase-6 plan: 42/42 in 51.9 min (`pro@nginx`) and 49.2 min (`free@nginx`) |
| V126 | The suite never sets `headless`, so Playwright's default (headless) applies; only `*:headed` scripts and the healthcheck's `--headed` show a browser — no X server needed | ✅ source | `grep` of `src/`, `playwright*.config.ts`, `package.json`, `healthcheck.ts` |
| V127 | `commander` 15.0.0 is ESM with `node >= 22.12.0`; `zod` 4.6.5 is ESM with no engine constraint | ✅ registry | `npm view` |
| V332 | Each guard fails on a forbidden import, and only then: ESLint flags a static import of `run-context.ts`, `../../src`, `../../src/`, `guards`, a type-only `types` and a missing module, passes `products` (with or without `.ts`), `run-id` and `sites`, exempts a spec — and misses a dynamic `import()`, as expected; the spec's scan flags the static and the dynamic one; its probe reports a module that sets a variable and one importing `run-context.ts` (`E2E_PROBE_SENTINEL`, `RUN_ID`); a root `cli.ts` that sets one is skipped, a `sub/cli.ts` is not | ✅ 2026-10-12 | Throwaway files under `orchestrator/zz/`, `npx eslint orchestrator/`, `--project orchestrator`; removed after. ESLint's spelling rules changed in the audit (V337) |
| V333 | The four admitted modules (`run-id.ts`, `sites.ts`, `retention.ts`, `products.ts`) leave `process.env` unchanged on import; the probe with its `.env` write removed fails its own two checks | ✅ 2026-10-12 | `orchestrator/import-boundary.spec.ts`; `env-probe.spec.ts` against a mutated `env-probe.ts` |
| V334 | Playwright 1.63.0's file discovery skips `node_modules/` but walks dot-folders: a `testDir: "."` config listed `.dotprobe/a.spec.ts`, not `node_modules/zzprobe/a.spec.ts` — with an explicit `testDir`, which turns `.gitignore` filtering off (V338) | ✅ 2026-10-12 | A throwaway `playwright.zzprobe.config.ts`, `--list`; removed after |
| V335 | Playwright's ESM loader refuses a JSON import without `with { type: "json" }` ("needs an import attribute"); TypeScript 6.0.3 and ESLint 10.11.0 (its config) accept the attribute | ✅ 2026-10-12 | The first unit run; `tsc`, `eslint .` |
| V336 | `ts.preProcessFile` misses every import after a regex literal holding a backtick (`/`/g`), `/*` (`/\/*$/`) or a quote (`/"/`); TypeScript's syntax tree reads them all. Reproduced in an orchestrator module that passed every gate before the fix and leaked `.env` and `RUN_ID` when called | ✅ 2026-10-13 | A script over both readers; reviewer A's `slack-format.ts`; the regex cases in `src/common/import-boundary.spec.ts` |
| V337 | `tsc` refuses an import ending in `.ts` (TS5097, no `allowImportingTsExtensions`) and accepts `.js`; ESLint compiles a `no-restricted-imports` `regex` case-insensitively (`"iu"`); TypeScript's bundler resolution maps `.js` to `.ts`, resolves `#` imports from `package.json`, and returns no resolution for `node:` builtins (ambient types) | ✅ 2026-10-13 | `tsc` on probe files; ESLint source (reviewer A); `import-scan.spec.ts` |
| V338 | Playwright 1.63.0 sets `respectGitIgnore` to `!projectConfig.testDir && !config.testDir`; its UI mode, with no saved project choice, ticks the first project only, and saves the choice per config file | ✅ 2026-10-13 | `playwright/lib/common/index.js:610`; `playwright-core/lib/vite/traceViewer/uiMode.CU5KtEkS.js` (`…r.set(r.entries().next().value[0],!0)`) |
| V339 | Prettier 3.9 honours `.gitignore`: a malformed `.orchestrator/config.json` passes `--check` without the `.prettierignore` line, and fails once `.gitignore` no longer lists it | ✅ 2026-10-13 | Reviewer B, a probe folder and the copy |
| V340 | Under `node --import tsx`, the first TS import adds no process listener (baseline: `newListener` 2, `removeListener` 2, `warning` 1); the four admitted modules add none, keep the working directory and exit code, and leave nothing running (`beforeExit` fires) | ✅ 2026-10-13 | A child probe importing a trivial module, then each admitted one, one turn apart |
| V341 | The admitted modules can load 38 repository files and three packages (`@playwright/test`, execa, node-ssh), none of them `load-env.ts` or `run-context.ts`, with no computed `import()`; the only computed `import()` under `src/` is in `run-facts.spec.ts` | ✅ 2026-10-13 | A closure walk with TypeScript's resolver, then `localClosure` in the spec |
| V342 | Importing `src/projects/products.ts` with a wp-rocket `sites.json` of `{ broken` throws `[sites] "…/sites.json" is not valid JSON`; with no sites file it prints a `[sites]` warning | ✅ 2026-10-13 | Reproduced by both reviewers and again in my copy |
| V343 | Every reviewer bypass, rebuilt against the final tests, fails the spec: a regex literal hiding a lazy import; `cli.ts` importing `__fixtures__/` code that imports `run-context.ts`; a computed `import()` by product name; an `.mts` re-export; a `SIGINT` listener and `chdir` at import; a module forging `[]` at exit; a change made 50 ms later; a lazy `import("./run-context")` appended to `sites.ts`; a `#suite/*` import through `package.json` `imports` | ✅ 2026-10-13 | A harness in a copy of the worktree, `--project=orchestrator`, baseline green after each restore |
| V344 | 25 mutations of the fixes — scanner back to `preProcessFile`, `require`/`typeof import()`/parentheses/computed/`file:` unread, `__fixtures__` not test code, builtins unresolved, closure silent, probe blind to listeners/cwd, no turn, baseline after its own listener, allowlist checks dropped, own test code importable, lexical judging, `.ts`-only lister, declaration files probed, five ESLint rule changes — each fails at least one test | ✅ 2026-10-13 | A mutation harness in a copy of the worktree; the baseline mutation was rewritten once, having changed nothing |
| V345 | ESLint 10.11.0's core `no-restricted-imports` does not check an `import()` expression: a literal `import("../../src/common/config/run-context")` gets no error | ✅ 2026-10-13 | The `Linter` table in `orchestrator/import-boundary.spec.ts` |
| V346 | `artifacts.setup.ts:73` and `consume.ts:148` build the artifacts folder as `join(REPO_ROOT, dirs().artifacts)`, so an absolute `ARTIFACTS_ROOT` lands under the checkout; `results-stream.run.spec.ts` passes one, and the worktree holds only empty `private/var/folders/…/artifacts/resultsprobe` folders (0 files) | ✅ 2026-10-13 | `find private -type f` (0); source; not fixed (out of scope) |
| V347 | Node 24.21.0's `JSON.parse` quotes the text around the error (`Unexpected token 's', ..."assword": s3cret }" is not valid JSON`); the sites loader's own message names only the file. `loadProductList` on a broken WP Rocket `sites.json` holding a fake password: one `ConfigError` line naming the file, no cause, and `util.inspect` of the error holds no credential | ✅ 2026-10-13 | `node -e` probe; a copy of the worktree under `node --import tsx`; `product-list.spec.ts` |
| V348 | With `join`, the two new absolute-`ARTIFACTS_ROOT` tests fail; with `resolve`, they pass. A full unit run (2070 passed, 8 skipped by their environment guards) adds no folder under `private/`; its 176 empty folders (0 files, no links) were then removed | ✅ 2026-10-13 | `consume.spec.ts` against a mutated `consume.ts`; `find private` before and after `npm run test:unit`; `find private -depth -type d -empty -delete` |
| V349 | `node:inspector` (`Session.post("Runtime.evaluate")`) and `node:repl` (`repl.start` fed a stream) each run code in the importing process — both set a variable; `process.getBuiltinModule` is a function on Node 24.21.0 and returns `node:vm` | ✅ 2026-10-13 | `node --input-type=module -e` probes |
| V350 | ESLint 10.11.0: `no-restricted-properties` with `property` alone catches `process.getBuiltinModule(…)`, `globalThis.process["getBuiltinModule"]` and destructuring by name or string key; `no-eval` catches `eval()` and `globalThis.eval`; the `paths` of `no-restricted-imports` miss `import("node:module")` and `require("node:vm")` — the full config refuses the `require` (`@typescript-eslint/no-require-imports`), not the `import()` | ✅ 2026-10-13 | The `Linter` table in `orchestrator/import-boundary.spec.ts`; `npx eslint` on a throwaway `orchestrator/zzprobe/probe.ts`, removed after |
| V351 | 18 mutations of 0.1a and 0.1c — a raw rethrow, `String(error)`, the whole module or an unfrozen list returned, a cause kept, no `name`; the scan blind to builtins, to `repl`, to `node:`, to bracket access, to destructured string keys, to `eval`, names left out of `boundaryViolations`, any string read as a name; ESLint without `repl`, without `node:` forms, without `no-eval`, `getBuiltinModule` only on `process` — each fails the test meant to catch it | ✅ 2026-10-13 | A mutation harness in a copy of the worktree, `--project=orchestrator`, baseline green before and after |
| V352 | tsx 4.23.15, file entry: an ES-module `.ts` sees no `require` and no `module`; a `.cts` sees `require` and `module.require` as functions, and a `.js` under a nested `package.json` of `{"type":"commonjs"}` sees `require`. (Node's `-e` mode puts builtins such as `module` on `globalThis`, so an `-e` probe misleads.) | ✅ 2026-10-13 | Probe files under `orchestrator/zz/` in a copy of the worktree, removed after |
| V353 | ESLint 10.11.0, the full config: in an orchestrator `.js`, `new Function("…")` and `Function("…")` get no error (`@typescript-eslint/no-implied-eval` lints `.ts` only); `Reflect.construct(Function, …)` gets none in `.ts` either. With `no-new-func`, both direct forms are refused in every dialect | ✅ 2026-10-13 | `npx eslint` on probe files in a copy; the spec's dialect test and table |
| V354 | Node 24.21.0: `setTimeout("…")` throws `ERR_INVALID_ARG_TYPE`; `(async () => {}).constructor("…")` runs code in the process; `process.binding("contextify")` returns `compileFunction` and `ContextifyScript` (DEP0111); `process.dlopen` is a function | ✅ 2026-10-13 | `node --input-type=module -e` probes |
| V355 | A second `loadProductList()` in one process, after the broken sites file is removed, fails with the first error: Node keeps a module whose evaluation threw | ✅ 2026-10-13 | A tsx entry in a copy of the worktree |
| V356 | Playwright 1.63.0 resolves a project's `outputDir` with `path.resolve(configDir, …)`; playwright-bdd 9.2.1 resolves its `outputDir` the same way | ✅ 2026-10-13 | `playwright/lib/common/index.js:587` (`pathResolve`, `:616`); `playwright-bdd/dist/config/index.js:81` (`resolveOutputDir`) |
| V357 | 29 mutations of step 0.1 and its audit fixes — V351's 18, plus: a static import of the list, a cause's message kept, `join` back in `cellArtifactsDir`, a builtin added to the fixture only, `Function` not refused, no `no-new-func`, computed keys unread, `package.json` or `.cjs` not counted as CommonJS, declaration files counted — each fails the test meant to catch it; the static import fails only the new laziness test | ✅ 2026-10-13 | The mutation harness in a copy of the worktree, `--project=orchestrator` (and the two `src` specs for `join`), baseline green before and after |
| V358 | With `join`, the real artifacts setup of the run spec's cell `y` creates `private/…/artifacts/resultsprobe/y` under the checkout, and the new assertions fail; with `resolve`, nothing is created there | ✅ 2026-10-13 | The `join` mutation in a copy of the worktree, which then held `private/var` |
| V359 | `zod` 4.6.7 is the latest release (2026-10-12), ESM, with no dependencies; it and 4.6.5 were published by GitHub Actions as a trusted publisher, with SLSA provenance | ✅ registry | `npm view zod@4.6.7 dependencies dist.attestations _npmUser` |
| V360 | Zod 4.6.7's messages name types and bounds, never the input (`Invalid input: expected string, received number`) — but `Unrecognized key: "…"` quotes a key raw (`util.js` `stringifyPrimitive`), so it is rebuilt (§7.7); a refused record key arrives as `invalid_key` "Invalid key in record", the key schema's message inside it; an object's `superRefine` is skipped only after an aborting issue (wrong type, refused key, `abort: true`) and runs beside any other — corrected by the audit, which reproduced both; `abort: true` stops a field's later checks | ✅ 2026-10-13 | A tsx probe over the schema; `schema.spec.ts` |
| V361 | Node 24.21.0's `JSON.parse`: an unexpected token is reported by quoting the text, with no position (`Unexpected token 's', "{"a": s3cret }" is not valid JSON`); other errors give `at position N (line L column C)`; an empty text gives `Unexpected end of JSON input` | ✅ 2026-10-13 | `node -e` probe; `load.spec.ts` |
| V362 | Playwright 1.63.0 reads `--grep` with `forceRegExp`: `/source/flags` (flags `g`, `i`) as written, anything else as `new RegExp(pattern, "gi")`; with `v` added, `[(]` would be refused | ✅ source | `playwright/lib/util.js:152`, `playwright/lib/common/index.js:353`; `node -e` |
| V363 | 26 mutations of step 1 — id alphabet, either uniqueness rule, the secret names, Datator's slash, Slack's path, a URL's port, the cooldown floor and default, a non-strict object, `grep`'s flags, the `invalid_key` message, path quoting, `in` for `Object.hasOwn`, placeholder counting, an empty pool, server case and duplicates, the threshold's `>=`, the `release:` condition, the mode mask, `JSON.parse`'s message, the BOM, the size cap, the state directory, path resolution — each fails a test. `grep`'s flags survived first; a `[(]` case now kills it | ✅ 2026-10-13 | A mutation harness in a copy of the worktree, `orchestrator/config`, baseline green before and after |
| V364 | The four gates pass; a full unit run: 2132 passed, 8 skipped by their environment guards — the import-boundary spec among them, importing every new module in a child Node | ✅ 2026-10-13 | `npm run typecheck`, `lint`, `format`, `test:unit` |
| V365 | The suite reads `BWP_FTP_PASSWORD` and `BWP_S3_SECRET_ACCESS_KEY` through `env()`, which does not trim, on purpose: "`env()` also serves credentials … whose trailing whitespace can be part of the secret" | ✅ source | `src/common/artifacts/request.ts:68–70`; `backwpup.config.ts:30,36` |
| V366 | Node 24.21.0's `JSON.parse` keeps the last of two equal keys with no error; zod 4.6.7's `z.record` skips an own `__proto__` key (no issue, no pollution: the prototype stays `Object.prototype`); strict objects report it | ✅ 2026-10-13 | Reviewer probes `proto2.ts`, `files.ts`; `json-keys.spec.ts`, `load.spec.ts` |
| V367 | `stat` then `readFile` by path: a symbolic link swapped between a small config and a 30 MiB one loaded the large one 200 times in 400; swapped to a FIFO, `readFile` blocked and the process outlived `process.exit`. With one `open(O_RDONLY \| O_NONBLOCK)` handle: 0 in 400, and 50 FIFO swaps never hang — a FIFO opens at once and `fstat` says it is not a file | ✅ 2026-10-13, macOS | Reviewer A's `race.ts`, `race-fifo3.ts`, before and after; `load.spec.ts` (a FIFO with no writer) |
| V368 | OpenSSH 10.3 refuses `ssh -G 'u@-oProxyCommand'` ("hostname contains invalid characters"); Playwright 1.63.0's CLI takes `-foo`, `-h` and `--list` as `--grep`'s value, and `--grep --` swallowed the next argument | ✅ 2026-10-13 | Reviewer A |
| V369 | `new Headers({ "X-API-Key": "keyĀ" })` throws "Cannot convert argument to a ByteString", without the value; `TextDecoder("utf-8", { fatal: true })` refuses a stray `0xE9`, a truncated sequence and an encoded surrogate, and drops a leading BOM; `/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u` matches a lone surrogate, U+0085, U+009B, U+2028, U+202E and U+200B but not an emoji pair | ✅ 2026-10-13 | Reviewer A; `node -e` probes; `load.spec.ts`, `schema.spec.ts` |
| V370 | 48 mutations of the audit's fixes — the key scanner (index, repeats, `__proto__`, commas, escapes, paths), `describeKey` (token prefixes, length), the rebuilt message, path masking, each Unicode class in text and secrets, the secret cap, `-`, every URL condition (exact form, user, password, port, query, fragment, Slack's hook path), Datator's key, token strictness, whole numbers, `sshHost`'s user part, the threshold cap, the non-blocking open, the read limit, the size test, fatal decoding, lost keys, shell quoting, the mode mask, the pool messages — and reviewer B's 7 survivors of the first specs: all fail a test but one equivalent (Datator's `/` from the path or the text). Four survived first; three tests were added for them, and the fourth turned out to be a malformed mutant (perl expanded `@-`) that still showed a missing case | ✅ 2026-10-13 | The mutation harness in a reviewer's copy, `orchestrator/config`, baseline green before and after |
| V371 | The four gates pass after the audit; a full unit run: 2167 passed, 8 skipped by their environment guards — the orchestrator's 116 among them, the import-boundary spec importing `json-keys.ts` in a child Node | ✅ 2026-10-13 | `npm run typecheck`, `lint`, `format`, `test:unit` |
| V372 | A run's `RUN_ID` (`2026-10-13T10-15-31-042Z-bpng-12`) parses back to its start and its id; a report folder from `runReportDir` matches `run-context.ts`'s, which now calls it | ✅ 2026-10-13 | `identity.spec.ts`, `run-id.spec.ts`; the suite's specs unchanged and passing |
| V373 | The run environment holds exactly §4.4's names, nothing else the orchestrator holds (`RUN_ID`, `CI`, an inherited `GITHUB_TOKEN` or `BWP_*`, `PLAYWRIGHT_BDD_CONFIGS` tried); the suite's spellings match its own constants | ✅ 2026-10-13 | `environment.spec.ts` |
| V374 | 52 mutations of step 2 — every outcome row, the drain-without-effect rule, the setup, error-line and log-tail reasons, the stream's last-wins and last-line rules, the counts' fallbacks, the facts' role, cell, version and leniency, the event's fallbacks and caps, the bus's abort, timer, settle, await and bounds, the cut and the report path, the masking (dropped, applied after the cut, left out of a reason or of the bus) — each fails a test. Three survived first (a second `run.begin`; masking after the cut, whose test checked only the password's whole word; a mutation prettier had reflowed): tests now kill the first two, the third was re-run. Equivalent, kept: `bddgen`'s `signal === null` (Node never gives a code with a signal) | ✅ 2026-10-13 | A mutation harness in a copy of the worktree, the step's specs, baseline green before and after |
| V375 | `results-reader.ts`, `results-schema.ts` and `text.ts` admitted: imported in a child Node they change nothing in the process, and nothing they can load reaches `load-env.ts` or `run-context.ts` | ✅ 2026-10-13 | `import-boundary.spec.ts` |
| V376 | The four gates pass; a full unit run: 2245 passed, 8 skipped by their environment guards — the orchestrator's 193 among them | ✅ 2026-10-13 | `npm run typecheck`, `lint`, `format:check`, `test:unit` |
| V377 | The suite's real reporters, driven through 13 run shapes, and all 24 real streams in `reports/`: the outcome matches the suite's own verdict where they share a meaning (flaky → `flaky`, a SIGKILL without `run.end` → `error`, by design); Playwright 1.63 exits 130 interrupted, 0 passed, 1 otherwise; a `failed` run.end without a failed test always came with a `run.error` | ✅ 2026-10-13 | The correctness reviewer's harness in its copy, `judge.ts` over the real streams |
| V378 | Before the fix: a `log` that throws, `throw Object.create(null)`, or a `message` that is not text made `settle` reject and Node exit 1 on the unhandled rejection; after it, `settle` resolves and no rejection is unhandled | ✅ 2026-10-13 | Both reviewers' scripts; `bus.spec.ts` |
| V379 | Before the fix: `safeLine` returned `ghp_…` whole for a token split by `\u200b`, `\u202e`, `\u00ad` or a terminal code, and `run.end` `scenarios: null` threw in `runOutcome`; after it, each is masked or read as 0 | ✅ 2026-10-13 | `text.spec.ts`, `results.spec.ts`, `outcome.spec.ts` |
| V380 | `run-env.ts` admitted: imported in a child Node it changes nothing; `project.ts` reads the four names through it | ✅ 2026-10-13 | `import-boundary.spec.ts` |
| V381 | 37 mutations of the audit's fixes — masking before and after cleaning, by value and in order, `cut`'s bound, `safeBlock`'s breaks, controls and format characters, `secretValues`' webhook path, key and duplicates, every zod rule `results.ts` adds, "No tests found", the failed-status rule, the reason's and log lines' masking, the bus's log, turn, totality, secrets and names, the event's grep, error, names, facts and URL, a misspelt variable — each fails a test. Two survived first (`safeBlock` without its first mask; an unknown status, whose test line lacked a feature anyway): tests now kill both; one prettier had reflowed was re-run | ✅ 2026-10-13 | The mutation harness in a copy of the worktree, `--project=orchestrator`, baseline green before and after |
| V382 | The four gates pass after the audit; a full unit run: 2275 passed, 8 skipped by their environment guards | ✅ 2026-10-13 | `npm run typecheck`, `lint`, `format:check`, `test:unit` |
| V383 | `orchestrator/notify/`: 50 unit specs, over a real local HTTP server and the real `fetch` — success and refusal, masking, the 500-character cut, an endless body read only to its cap, a time limit with no answer and with a stalled body, the caller's abort, a refused connection named by its code, a hostile thrown value, an unserialisable body; every headline, escaping, caps, the worst-case size; every Datator field | ✅ 2026-10-13 | `post.spec.ts`, `slack.spec.ts`, `datator.spec.ts` |
| V384 | Node 24.21.0's `fetch` with `redirect: "manual"` returns the `301` itself, one request made; Django's `CommonMiddleware` answers `301` to Datator's URL without its `/` | ✅ 2026-10-13 | `post.spec.ts` (a sink), and the V385 harness: `sendDatator` to `/e2e_tests/results` → `{ ok: false, status: 301 }` |
| V385 | Datator's own app (`0cff7bc`, unmodified; Django 4.2.1, DRF 3.14.0, Python 3.14.8, served over HTTP) answers `201` to 12 `datatorPayload` payloads — typical, passed, flaky with `grep`, release (`null` commit, no site), SHA-256 commit, a Docker host (dropped), `localhost`, 500-code-point emoji names with a 4,000-character error, blank names and a lone surrogate, a 500-character `grep`, 500 failed scenarios (2 MB), none — and `403` to a wrong key. Without the guards it answers `400`: `http://wp-apache` ("Enter a valid URL"), a lone surrogate ("Surrogate characters are not allowed"), a blank `feature_name`, 501 characters, `845.7`; 500 emoji pass (it counts code points), and a blank `error_message` passes | ✅ 2026-10-13 | Datator's `e2e_tests` app behind `CommonMiddleware`, SQLite in memory, `wsgiref`; posted by `sendDatator` |
| V386 | 20 mutations of `notify/` — redirect followed, the read cap, the cancellation, the masked detail, `&` escaping, the escaped bound, the webhook masked whole and by path, the shared list cap, Slack's `ok`, shell quoting, posted statuses, flaky as successful, whole seconds, `toWellFormed`, `(unnamed)`, the URL check, `201` only, the key masked, the error cap — each fails a test; one (the webhook masked whole) survived first, a test now kills it | ✅ 2026-10-13 | The mutation harness in a copy of the worktree |
| V387 | A 40-character key after 8,172 spaces (or 2,724 zero-width spaces) of a refused answer: `detail` was the key's first 20 characters; now no 4 of its characters in a row, nor a `ghp_` token's prefix | ✅ 2026-10-13 | Security reviewer's probe; `post.spec.ts` |
| V388 | Datator's app answers `400` "Enter a valid URL" to `http://010.1.1.1/`, `https://a.com/my site`, `http:/a.com`, `http://127.1/`, all of which the first `acceptedUrl` kept | ✅ 2026-10-13 | Correctness reviewer, Datator's app over HTTP |
| V389 | 2,790 URLs (6 schemes × 31 hosts × 15 endings): the fixed `acceptedUrl` keeps 240, and DRF 3.14.0's `URLField(max_length=255)` on Django 4.2.1 accepts every one; the 12 payloads of V385 still get `201` | ✅ 2026-10-13 | `acceptedUrl` in tsx, then DRF's field in the V385 venv |
| V390 | OpenSSH 10.3's `scp`, through `-S` to a fake `ssh`: the default sends the `sftp` subsystem and the path as given (globbed there); `-O` sends `scp -r -f /srv/my e2e/r` unquoted. Locally, `sh -c` hands a quoted path holding `'`, `$(…)`, a backtick or `;` to `scp` as one argument, nothing run | ✅ 2026-10-13 | Both reviewers |
| V391 | 25 mutations of the audit's fixes — the cut tail, its length, the cut flag, withholding, the time-limit check, URL and JSON forms (both), the forms used, the webhook's token, `unfurl_*`, both `toWellFormed`, `escapeCut`'s bound, the site cap and its line, `commit`, `(unnamed)`, code spans (both ways), the URL round trip (both) — and step 3's first 20 again: each fails a test but one, a second `toWellFormed` in `escapeCut` that `escapeSlack` made redundant, now removed | ✅ 2026-10-13 | The mutation harness in a copy of the worktree, `--project=orchestrator` |
| V392 | The four gates pass after the audit; a full unit run: 2340 passed, 8 skipped by their environment guards | ✅ 2026-10-13 | `npm run typecheck`, `lint`, `format`, `test:unit` |
| V393 | `orchestrator/runs/` and `state/`: 66 new unit specs (65 in eight new files, one more in `outcome.spec.ts`) — the stop machine's every transition, the shutdown's table, debounce boundary and budgets on a fake clock, the group probes, the launch against a fake suite with real processes and signals (drain, one SIGINT, kill of the whole group, `bddgen` killed, a lingering group waited for and then killed, a command that cannot start or that Node refuses, the environment exactly as given), the end's caps, FIFO and log tail, the record and the atomic write | ✅ 2026-10-13 | `npm run test:unit`; the launch and end specs 20 times over (440 passed) |
| V394 | macOS adds `__CF_USER_TEXT_ENCODING` to the environment of every process it starts, whatever the parent passes; nothing else was added to a spawned run's environment | ✅ 2026-10-13, macOS | `launch.spec.ts` (the fake writes its variables' names) |
| V395 | 31 mutations of step 4 — no drain before an interrupt, a `bddgen` stop not taken as a drain, a kill preceded by a SIGINT, a level repeated, a late process left running, the runner started after a stop or after a failed `bddgen`, the debounce boundary, SIGHUP escalating, a budget resetting the debounce, the kill leaving a timer, `dispose` ignored, `EPERM` read as empty, group 1 allowed, the leader alone signalled, the wait's limit off by one, SIGTERM for SIGINT, the environment inherited, not detached, no stop-file check, no linger kill, values logged, our lines in the tail, a cut line kept, a folder read, no cap, the unread reason, a record's group 1, a temporary file kept, a wider mode, `--grep` split — each fails a test (the wait's limit only once its test was tightened) | ✅ 2026-10-13 | A mutation harness in a copy of the worktree |
| V396 | The real suite, launched by `launchRun` with `suiteCommands` and `runEnvironment` on `backwpup` `pro@nginx` with `--grep=@no-such-tag-e2e`: `bddgen` 0, the runner 1, "No tests found", no setup run, no site touched; `endRun` reads the stream: `error`, "no scenario ran: none matched". The log holds the variables' names only | ✅ 2026-10-13 | A tsx script in the scratchpad; the run's suite pruning removed 9 old local `pro@nginx` reports |
| V397 | The same, stopped 300 ms in: `bddgen` ended by SIGKILL, the runner never started, the run `stopped` with its reason; no `playwright-bdd` process left | ✅ 2026-10-13 | The same script; `ps -A -o pgid,command` |
| V398 | The four gates pass; a full unit run: 2406 passed, 8 skipped by their environment guards — the import-boundary spec importing every new module in a child Node | ✅ 2026-10-13 | `npm run typecheck`, `lint`, `format`, `test:unit` |
| V399 | Playwright 1.63.0, one SIGINT from `launchRun` while a reporter's `onEnd` (or `onExit`) runs, after `run.end` `passed` is in the stream: the runner is ended by SIGINT, the reporter never finishes, and the run read `stopped`; during the tests the same SIGINT gives exit 130 and `run.end` `interrupted`. Source: the watcher disarmed and the `SIGINT` listener removed once its handlers are gone | ✅ 2026-10-13 | Correctness reviewer's slow-reporter probe; `playwright/lib/runner/index.js:6097–6110, 6176` |
| V400 | The same probe on the fixed code: an interrupt at 4.5 s (in `onEnd`) and at 9 s (in `onExit`) is skipped, logged, both reporters finish, exit 0, `passed`; at 2.5 s (a test running) exit 130, `stopped` | ✅ 2026-10-13 | The probe in the reviewer's copy with the fixed `runs/` |
| V401 | `readRunResults` on a line of nested brackets: 4 MiB took 418 MB resident, 32 MiB 2.3 GB; the largest real stream in this checkout is 12 KB (25 streams) | ✅ 2026-10-13 | `/usr/bin/time -l` on a tsx probe; `find … -name results.jsonl` |
| V402 | `groupAlive` answers `true` for an unrelated live group whose number a stale record names | ✅ 2026-10-13 | Security reviewer's probe |
| V403 | Before the fixes, each reproduced: a throwing `onProcess` left a live unwatched group and an async one exited the orchestrator 1; a symlinked `run.log` was written through and a FIFO blocked `launchRun` past `process.exit`; a stop during a failed `bddgen`'s flush read `stopped`; output without a newline put our line in the reason; a whole line at the tail's window start was dropped; a wall clock stepped back 1 h ignored every Ctrl-C; a failed SIGKILL after the linger ended the run with its group alive | ✅ 2026-10-13 | Both reviewers' probes; the new specs fail on the old code |
| V404 | 23 mutations of the audit's fixes — the skipped SIGINT, the stop after the run, the rejection handled, the exclusive log, the folder checks (three), the newline guard, the wait after a failed kill, actions at once, the tail's boundary and shift, ours stripped mid-line, the late interrupt both ways, the line cap both ways, `run.end` by type, the monotonic clock — each fails a test but three equivalent ones (`O_NOFOLLOW`, the stream's file check, a no-op on the throw path); two redundant guards reduced to one; and step 4's first 30 again, all caught | ✅ 2026-10-13 | The mutation harness in a copy of the worktree |
| V405 | The four gates pass after the audit; a full unit run: 2422 passed, 8 skipped by their environment guards; the real suite again on `pro@nginx` with no matching scenario (`error`, "no scenario ran: none matched") and stopped during `bddgen` (`stopped`), a reused run folder refused (`EEXIST` on `run.log`) | ✅ 2026-10-13 | `npm run typecheck`, `lint`, `format`, `test:unit`; the V396 script |
