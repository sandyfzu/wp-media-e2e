# Orchestrator Phase 0.5 — The minimal orchestrator

> **Status:** planned; **nothing implemented**. Runs after [Phase 0](orchestrator-phase-0-plan.md),
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
| 0A.1 the cell pin (`E2E_CELL`) | Two cells of one product side by side (2 of 80 failed without it, V29) | required |
| 0A.2 output folders | A `test:unit` or manual run on the runner not deleting running cells' traces | recommended |
| 0B.1 `E2E_LOAD_DOTENV` | Runs not changed by a `.env` on the runner | required |
| 0B.3 one product list | Validating a task's product and finding its config | required |
| 0C the drain, `stopRunningWork` first | A graceful stop; a killed run's next run recovering the site | required |
| 0D.1 run facts, 0D.2 full commit, 0D.3 site versions | Slack and Datator: plugin, commit, site, WordPress, PHP | required |
| 0E results stream | Counts, scenarios and first errors — the suite writes no Cucumber JSON | required |
| 0F pruning | A loop writes ~25 reports a day per cell (V125) | required |
| 0B.2, 0A.3–0A.5 | The orchestrator's own builds and scheduling — later phases | not used |

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
  "serverWarningThreshold": 4
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
  test --config playwright.<product>.config.ts` (plus `--grep` when the task has one). Each `detached`
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
  | `run` | `id`, `runId` (`RUN_ID`), `name`, `trigger` (`"loop"`), `task` (`id`, `name`) |
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
  per task too. `runs.reportsKeep` sets `E2E_REPORTS_KEEP` (default 20, the suite's). At ~55 min a
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
  config/                 schema (zod), loader, config.example.json
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
- It imports from the suite only modules without import side effects: the product list (0B.3), the
  sites loader, 0F's `run-id.ts` and `retention.ts`. Never `run-context.ts` (V84).
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

1. M2 configuration — schema, loader, example.
2. M4's pure parts — identity, environment, the outcome table; M6's builder and bus.
3. M7 and M8 formatters (pure), then their senders.
4. M4's launch and end, M5's stop state machine (an injected clock and `kill`).
5. M3 and M1 — the loop and the command; M9 — lock, counter, retention, logs.
6. Docs: a new `docs/guides/orchestrator.md` (operating it: §6, the config, stopping), `CLAUDE.md`
   (structure, the script, the docs map), `README.md`, `.env.example` untouched (no `E2E_*`).

## 8. What later phases change, and keep

| Here | Later | Kept |
| --- | --- | --- |
| Tasks in a JSON file, read once | The task store (SQLite), edited through the API | The task fields and ids — imported as they are |
| The run builds its plugin | The orchestrator builds and pins (`E2E_PLUGIN_REF=commit:<sha>`) | Everything else the run is given |
| The suite prunes reports per cell | The orchestrator prunes per task (`E2E_REPORTS_KEEP=0`) | 0F's planner |
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
