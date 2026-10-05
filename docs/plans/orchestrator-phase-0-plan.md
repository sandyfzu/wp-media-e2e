# Orchestrator Phase 0 — Make the suite ready

> **Status:** investigated; **nothing implemented yet**. Every item has a verified finding and a
> recommended solution, with the alternatives it beat; implementation starts when approved.
> **Date:** 2026-09-25.
> **Parent:** the [orchestrator plan](orchestrator-plan.md) keeps the concept; this plan details its
> §6, Phase 0. Verification rows continue the parent's numbering, from V29 (§11).
> **Measured with:** Playwright 1.63.0, playwright-bdd 9.2.1, allure 3.18.0 + allure-playwright
> 3.12.2, apvm-napi 3.0.0, Node 24.21.0, npm 12.0.2, on the macOS runner. Live on the orchestrator
> worktree's own cells — `free@nginx` = `bwu2.e2e`, `pro@nginx` = `bwu3.e2e` — on host `qa-lnmp`.
> Line references are to `develop@e7f0b6b`, the worktree's base: re-check them against the branch the
> implementation starts from.

---

## TL;DR

The recommended solution per item. "—" means no suite change: the orchestrator does it.

| Item | Recommended | Suite change |
| --- | --- | --- |
| 0A.1 `bddgen` rewrites every cell | **Pin a run to one cell**: with `E2E_CELL=<cell>` the config holds only that cell, so `bddgen` touches only its specs | `run-context.ts`, `project.ts` |
| 0A.2 shared `test-results/` | Setup projects write in their cell's folder, unit runs in `_unit`, runs of no cell in `<product>/_all/<cell>`; cell names checked at load | `project.ts`, `run-context.ts`, `playwright.unit.config.ts`, `sites.ts` |
| 0A.3 shared hosts | Never two runs on one site or staging root. **No limit per server**: the user decides; a **warning** (command, dashboard, event) once a server's busy-run threshold — default 4, configurable — is reached, or its free disk is low | — |
| 0A.4 two runs on one site | Refuse a site listed by two cells of any product, compared on its normalized URL and location | — (optional loader check) |
| 0A.5 APVM's cache | Build in a **worker process per build**, detached, with a private `TMPDIR`: stop, cancel and timeout = SIGKILL its group and remove that folder. The cache survived every kill measured | — |
| 0B.1 a run's settings | `E2E_LOAD_DOTENV=false` makes the suite skip `.env`; the orchestrator builds each child's environment from an allowlist | `load-env.ts` |
| 0B.2 the built commit | The warm returns what it built — full commit, version, the ref that pins it; the run gets `commit:<sha>` (or `release:<tag>`) and then needs no network | `warm.ts` |
| 0B.3 one product list | `src/projects/products.ts`, with a drift-guard spec, replaces the three hard-coded lists; a misspelt `PRODUCT` fails instead of running WP Rocket | new `products.ts`; `healthcheck.ts`, `warm-artifacts.ts`, `playwright.config.ts` |
| 0C stopping a run | Spawn the Playwright CLI directly, in its own process group. Stop = **drain** (a stop file skips each scenario's first attempt), then **one** SIGINT, then SIGKILL of the group; never SIGTERM. The `@plugin` Before path stops running work first | `fixtures.ts`, `plugin-lifecycle.ts`, `plugin.hooks.ts` |
| 0D.1 reports say it up front | A *run facts* reporter, listed first: the HTML report's title, Allure's `environment.properties`, a banner on the Cucumber report, `run-facts.json` | new `src/common/reporting/`; `reporting.ts`, `scripts/allure.mjs` |
| 0D.2 commit and digest | Record the full commit, and a SHA-256 of **every** resolved zip | `resolve.ts`, `types.ts`, `consume.ts`, `verify.ts` |
| 0D.3 the site's versions | Read Site Health's "Copy site info" in the auth setup; keep only whitelisted keys | new page object + parser; `auth.setup.ts` |
| 0E results stream | A JSON-lines reporter (schema v1), always on, writing `<report dir>/results.jsonl` — nothing on the terminal; plus an end-of-run summary for people | new `src/common/reporting/results-stream.ts`, `run-summary.ts`; `reporting.ts` |
| 0F pruning | At most 20 reports per cell (FIFO, at each run's end), none older than 30 days, the newest complete one kept up to 6 months; `npm run report:prune` for every cell | new `run-id.ts`, `retention.ts`, `prune-reports.ts` |

## 1. Method

- **Nothing in the suite changed.** Experiments ran in throwaway copies of the suite holding only
  placeholder sites, or on the worktree's own cells — read, or run through the suite's own lifecycle.
- **Every claim carries its evidence** (§11): an experiment with its observed output, a line of the
  installed source, or the vendor's docs. What could not be verified says so.
- Five investigations ran in parallel — `bddgen` and output folders; stopping; report metadata; the
  results stream and pruning; env, builds and products — and their key claims were re-read in the
  installed source before being written here.

### 1.1 The cells

- `free@nginx` = `bwu2.e2e` (158 MB docroot), `pro@nginx` = `bwu3.e2e` (2.9 GB, 2.4 GB of it
  `wp-content/bigFiles`), in the worktree's own git-ignored sites file. Healthcheck: 7/7 on both.
- Same host as the main checkout's `bwu` (Free) and `simple` (Pro): **four BackWPup sites on one
  disk**, so a live run in either checkout never overlaps one in the other (phase-6 V72, V162).
- They match `bwu`/`simple` — WordPress 7.1.2, the PHP-FPM 8.5 pool, the nginx vhost, the debug
  constants, ownership, `sudo` — **except in cron** (V70–V72):
  - `bwu`/`simple` define `DISABLE_WP_CRON` and a system cron requests `wp-cron.php` every minute;
    `bwu2`/`bwu3` have neither. Measured on `bwu2`: no outside traffic runs its cron, but **every
    WP-CLI command and page load does**. BackWPup leans on WP-Cron while a job runs (a restart event
    every 60 s), so results would not carry over between the two pairs.
  - Done 2026-09-30 on every `bwu2`–`bwu9`, with the user's go: per site, a backup outside the docroot, the
    crontab line first — proven by a probe the next tick ran and by the cron log — then the constant
    (`wp config set`; on `bwu3` a one-line CRLF insert; on `bwu6` as the file's owner, `www-data`), then
    proof that WP-CLI and page loads no longer run cron. `bwu7`–`bwu9` followed once their QA sessions
    were idle (P1). The live stop checks of
    §5.1 did not wait: they test the suite's teardown, which their feature keeps independent of WP-Cron.
    Anything cron-dependent — the scheduled-job features, V6's measurement — should.
- Smaller differences, left as they are: no Imagify or Query Monitor on `bwu2`/`bwu3`; `bwu2` has no
  `bigFiles`.

## 2. The run contract

Phase 0's items meet in one place: how the orchestrator starts, feeds, watches and stops a run. The
recommendations below fit together as one contract.

- **Start.** Two direct spawns per run, never through npm or a shell (0C):
  `node <playwright-bdd cli> --config playwright.<product>.config.ts`, then
  `node <@playwright/test cli.js> test --config playwright.<product>.config.ts`. Each is `detached`
  into its own process group, writes stdout and stderr to the run's log file, and runs in the
  checkout's root.
- **Build first, in a worker of its own** (0A.5, 0B.2): the build returns the commit it built, and the
  run is pinned to it (`commit:<sha>`, or `release:<tag>`), so its artifacts step is a cache hit that
  opens no network connection.
- **Environment — built from an allowlist, never inherited** (0A.1, 0B.1). The orchestrator's own
  process can carry `RUN_ID` or `PLAYWRIGHT_BDD_CONFIGS` from importing suite modules (V32, V84):
  - `E2E_LOAD_DOTENV=false`, so no `.env` can reach the run;
  - `PATH`, `LANG`, `HOME` unchanged (APVM's cache is under it, and `gh`), the orchestrator's private
    `TMPDIR`;
  - `RUN_ID=<timestamp>-<run id>` and `E2E_CELL=<cell>`;
  - the plugin under test — `E2E_PLUGIN_REF=<pin>` or `E2E_PLUGIN_ZIP=<file>`, and the version the task
    sets — plus `E2E_PREVIOUS_*`, `E2E_RETRIES`, `REPORT_MODE` and the four `*_ROOT` roots;
  - display only: the run's name and the ref the task asked for (0D.1);
  - `E2E_INTERNAL_STOP_FILE=<path>` (0C);
  - from the orchestrator's own secrets: `GITHUB_TOKEN` (a private product's run asks for one even on a
    cache hit, V83) and, for BackWPup, **every `BWP_*` it holds, forwarded by prefix** — never a
    hand-kept list, which would silently blank a credential added later (V87);
  - `E2E_REPORTS_KEEP=0`, because the orchestrator prunes per task itself (0F);
  - `E2E_SITE_STAGING_DIR` only if the task sets it — a site's own `transport.stagingDir` wins anyway
    (V92);
  - never `CI`, `PRODUCT`, `E2E_INTERNAL_SELECTED_CELLS`, `HEALTHCHECK_*`, `CAPTURE_*`, or anything else.
- **Watch.** `<report dir>/results.jsonl` streams every attempt and the totals (0E);
  `<report dir>/run-facts.json` says what was tested (0D).
- **Stop.** Create the stop file (drain) → one SIGINT to the runner → SIGKILL to the group. The run
  has ended when its process group is empty (0C).
- **After.** The stream's `run.end` and the exit status give the run's status; the reports are
  complete once the group is empty; Allure is generated from `allure-results/`, titled from the facts.

## 3. 0A — Running side by side

### 3.1 0A.1 — `bddgen` rewrites every cell's specs

**Finding.**

- `bddgen` generates every BDD config the product's Playwright config registers — one per cell — and
  each generation deletes all of that cell's `*.spec.js` before writing them again (V2).
- What that breaks (V29, V30):
  - two runs of different cells of one product, started together: **2 of 80 failed** — one `bddgen`
    crashed (`ENOENT`) on a spec the other had just deleted, so its run never started. Staggered by
    0–5 s: 0 of 80;
  - a run whose test collection overlaps a regeneration (2–11 ms per cell) fails at start with
    `Cannot find module` (1 of 10 runs under a regeneration loop);
  - **not** content changes: workers run the code compiled at collection, so a rewritten spec is
    harmless; only a missing one breaks a worker that loads it.
- `bddgen` takes no `--project` (`unknown option`), and npm hands `-- args` only to a script's last
  command, so only the environment can tell `bddgen` which cell it is for (V31).

**Recommended — pin the run unit through the environment.**

- `E2E_CELL=<cell>`, read in every process of a run — `bddgen`, the runner, its workers; all inherit
  the environment:
  - `run-context.ts`: `selectedCells()` returns the pin first, so `isCellTargeted`, the report bucket
    and the worker count agree. Without that, the artifacts setup would drop the run's overrides (V32);
  - `createProductConfig`: an unknown pin throws, naming the product's cells; otherwise only the
    pinned cell's three projects, pool and BDD config exist — so `bddgen` rewrites only that cell's
    specs. Prototype: 0 of 80 failed, generation 0.4 s faster (V32).
- The orchestrator sets it for both spawns; `--project=<cell>` becomes optional, and Playwright
  rejects one that disagrees.
- Manual runs: `E2E_CELL=pro@nginx npm run test:backwpup` is safe side by side. The
  `-- --project=<cell>` form still works but regenerates every cell — document it as unsafe for
  concurrent runs.
- **Why no `--project` is needed** (V93–V95): npm hands `-- args` to the script's last command only, so
  `bddgen` never sees `--project` (its argv is just `--config …`), while `E2E_CELL` reaches `bddgen`, the
  runner and every worker. Pinned, the config holds only `setup:<cell>`, `artifacts:<cell>` and
  `<cell>`, and a run without `--project` runs every project — exactly what `--project=<cell>` selects.
  `--project` remains for a subset of the cell (`--project=artifacts:<cell>`: resolve the zips only) and
  for unpinned runs. Prototype: only the pinned cell's specs rewritten, 3 projects instead of 6, report
  under `<cell>/`, workers equal to its pool, `E2E_PLUGIN_*` applied; unpinned output identical to
  today's (V97).
- **What the terminal says** (V96, V99): today nothing names the chosen cell, and a `--project` that
  disagrees with the pin fails as Playwright's bare "Project(s) … not found", without naming
  `E2E_CELL` — worse when the pin comes from `.env`. So: a first-listed, runner-only reporter prints
  one line before `Running…` — `[cell] backwpup/pro@nginx, pinned by E2E_CELL (only its specs were
  regenerated); 1 worker, report in reports/backwpup/pro@nginx/<RUN_ID>` (with `--project` alone, it
  adds that every cell's specs were regenerated) — and the config refuses a disagreeing `--project` or
  an unknown pin by naming the variable, the valid cells and the fix (prototyped wording: V99). It
  cannot print from the config itself: the config is evaluated in every process of a run.

**Rejected.**

- Per-run spec folders keyed by `RUN_ID` — a manual `bddgen` and its runner stamp different RUN_IDs;
  every cell still regenerates; folders accumulate; path-derived identities (Allure's `fullName`)
  change every run.
- Generate once, then run without `bddgen` — any regeneration (a suite update) still deletes every
  cell's specs, and it does nothing for manual runs.
- Atomic generation (a temp folder and a rename, or a symlink swap) — `bddgen` writes straight into
  its `outputDir`, a non-empty folder cannot be swapped atomically, and it needs a wrapper.
- A generation lock — workers load specs until the end, so the lock would serialize whole runs.
- Upstream "write only what changed" — worth proposing (no issue exists), but it cannot cover real
  changes, and cannot be relied on.

**Risks.**

- Unpinned invocations on the same checkout — the `--project` form, `test:ui`, sweeps — still
  regenerate every cell, so on the server only the orchestrator runs from its checkout. (Optional
  hardening: unpinned runs generate under `.features-gen/<product>/_all/<cell>`, which makes pinned
  runs immune.)
- `E2E_CELL` in a `.env` would pin every run from that checkout: 0B.1 closes it for the orchestrator;
  document it for people.

**Verify when implemented.** Unit: the pin (unset, blank, valid, unknown); `selectedCells()` and
`isCellTargeted` honour it; the factory yields one cell's three projects. No site: the 80-run
simultaneous-start batch (0 failures), the inode check, a disagreeing `--project` fails, CI's smoke
unchanged. Live: pinned `free@nginx` and `pro@nginx` together on a database-only feature, then a full
pass per cell, one after the other.

### 3.2 0A.2 — The root `test-results/` is shared

**Finding.**

- Playwright deletes the output folder of every **selected** project before a run (V3). The setup
  projects and the unit config default to the root `test-results/`, so `npm run test:unit`,
  `--project=setup:<cell>`, `--project=artifacts:<cell>` and a run without `--project` each delete
  **every** cell's output, both products' (V3, re-measured).
- A failing setup project writes its trace there too (V33).
- What that costs a running cell (V34): the attachments made before the deletion are lost from all
  three reports, and a missing attachment file — a failed attempt's screenshot, or any file attached
  by path — **crashes the Cucumber reporter**. A reporter error fails the run even when no test failed
  (V67): measured with a passing run whose attached file had been deleted (exit 1, 0 failed).

**Recommended.**

```text
test-results/
  _unit/                  npm run test:unit
  <product>/<cell>/       a run of that cell: its scenarios, setup:<cell>, artifacts:<cell>
  <product>/_all/<cell>/  runs that select no cell (no --project, or a setup project alone)
```

- The setup projects get `outputDir: cellDirs.output` (`project.ts:135–149`). The unit config gets
  `<OUTPUT_ROOT>/_unit`, read with `env()` — not through `run-context.ts` (importing it stamps
  `RUN_ID`) nor `load-env` (unit runs stay independent of `.env`). Runs of no cell write under `_all`,
  decided by the selection the factory already computes — their reports already go there.
- Measured on a prototype: each of the five invocations deletes only its own folder (V35).
- `sites.ts` rejects, at load, a cell name that is not `^[a-z0-9][a-z0-9@._-]*$`, and `_all`: a `/`
  or `..` would escape `dirs()`, `_all` collides with the report bucket, and case alone would let
  Playwright's case-insensitive filter match two cells.
- Fix `execution-model.md`'s "concurrent cells never collide", which is false today.

**Rejected.** Setup folders alone (a run without `--project` still wipes its product's cells);
per-run output folders (they accumulate, and break `--last-failed`); preserving the output (the CLI
cannot; only UI and watch mode set `preserveOutputDir`, V3).

**Verify when implemented.** Unit: `dirs().output` for a cell, for a run of no cell, and with
`OUTPUT_ROOT`; the setup projects' `outputDir` equals their cell's. No site: the marker measurement
(each invocation deletes only its own folder) and the mid-run deletion experiment (identical to its
control). Live: a failing scenario on a real cell while `npm run test:unit` runs on the same checkout —
traces and videos intact in all three reports.

### 3.3 0A.3 — Cells that share a server

**Finding.**

- `qa-lnmp` (V36): 4 vCPU, 14.6 GB RAM, a 97 GB disk with **17 GB free**; one MySQL 8.0.46 for all
  four BackWPup sites (`max_connections` 151, 118 at peak since boot); **one PHP-FPM 8.5 pool for every
  PHP 8.5 site** (70 children, `max_execution_time` 30 s); 26 docroots, about 22 of them other
  people's. Its capacity is shared with work that is not ours.
- Disk: a default files job includes `wp-content/bigFiles` (phase-6 V50) — it made files backups of
  about 3 GB until the operator emptied those folders (2026-09-30); backups are normally about 150 MB,
  and the host had 34 GB free that day.
- Staging (V37): `.e2e_temp` resolves under each site's own root, but an **absolute**
  `transport.stagingDir` or `E2E_SITE_STAGING_DIR` is shared by every site of its host, and a worker's
  teardown removes the whole area — two runs on one host would delete each other's staged zips. No
  site uses an absolute root today.
- **V5, answered by the operator (2026-09-28)**: there are two WordPress servers. AutoE2E's
  `backwpup@nginx` and `wp-rocket@nginx` run on the nginx one — `qa-lnmp`, which also holds the dev
  cells — and `backwpup@apache` and `wp-rocket@apache` on the apache one. Of our cells only
  `pro@apache` is AutoE2E's (its instance stopped on 2026-09-28). The four instances (V38) keep their
  site details on AutoE2E's server; they are not needed now.
- **"One server, one orchestrator"** (parent §1) means one orchestrator *instance* per machine — not one
  run per WordPress host. The operator allows about four parallel suites on one server (e.g. four `bwu*`
  sites), asking only to be told which sites a run uses, since the same sites host AI-driven QA
  sessions. That lifts the earlier one-run-at-a-time rule (phase-6 V72, V162) and makes V6 measurable.

**Recommended — the orchestrator's scheduler; no suite change.**

- **A run holds resources**, derived from its cell's sites: each site's identity (0A.4), each
  transport host, each resolved staging root. Runs sharing a site or a staging root never overlap —
  correctness, not capacity: they would destroy each other's state.
- **No limit per server — decided by the user (2026-10-05).** The orchestrator never holds, queues or
  refuses a run because of how many already run on its WordPress server; how many is the user's call.
- **A warning instead**, once a server's busy-run **threshold** is reached — default **4** (the
  operator's estimate), configurable per server; runs are counted per transport host (resolved,
  0A.4). It never blocks:
  - **command** — starting a run (`run`, a task's trigger shown by `status`) that brings a server to or
    past its threshold prints a warning naming the server, its running cells and the threshold; `status`
    and the cells view mark that server while it stays there;
  - **dashboard** — a banner on the server and its cells while at or past the threshold, and the same
    warning in the "Run once…" confirmation before it is sent;
  - **events** — `server.threshold.reached` and `.cleared`, so a subscriber (e.g. Slack) may pass it
    on; the orchestrator's log records both.
- **Disk warning — never blocks (decided by the user, 2026-10-05).** Before starting a run, check each
  of its hosts' free space (`df`, through the suite's `exec`); below a configured threshold the run
  **starts anyway**, with a warning where the server warning goes — command, dashboard, events
  (`server.disk.low` and `.cleared`), the log — naming the host, its free space and the threshold. The
  threshold's default is to come from measuring a files backup's peak disk use while implementing —
  not measured yet.
- **Measure V6 per host**: one, two, then four cells at once, against one at a time — failures,
  durations, load, FPM children, MySQL threads, disk peak. On `qa-lnmp`: four of the orchestrator's own
  `bwu*` sites, named to the operator before starting; database-only features first, files backups
  last, `df` watched throughout.

**Rejected.** Namespacing staging by `RUN_ID` (the artifact plan's deferred remedy, §2.8 case 22): a
killed run's folder would then be cleaned by nobody, leaving staged zips in a web-reachable docroot.
Staging per site already exists; the scheduler only has to know which roots are shared.

### 3.4 0A.4 — Two runs on one site

**Finding.** The sites loader accepts one WordPress listed by three cells — `baseURL` differing only in
case and a trailing slash, `rootDir` only in a trailing slash — with no error, keeping the values
verbatim. It rejects only a cell defined in two files (V39).

**Recommended.**

- The orchestrator checks, at start and whenever a sites file changes, that no site appears in two
  cells of **any** product, comparing two normalized keys — a match on either is a conflict, reported
  naming both cells:
  - URL: the `URL` origin (host lowercased, default port dropped) plus the path without its trailing
    slash;
  - location: `ssh://<host, lowercased><rootDir, normalized>`, `docker://<container><rootDir>`,
    `local://<realpath of rootDir>`.
- Optional: the same check within one product, in `loadSites` — it protects manual runs, cheaply.
- Stated limits: an IP and a DNS name for one machine, or two URLs for one WordPress, are not seen
  statically. Resolving SSH hosts (`dns.lookup`) also serves the per-server warning (0A.3).

### 3.5 0A.5 — APVM's cache under concurrent processes

**Finding** (answers V11; V76–V78). Cold BackWPup `develop` builds (pro-en) into throwaway caches,
killed on purpose:

- **The cache stays consistent.** Seven build kills — SIGKILL, SIGTERM or SIGINT; during the clone,
  during composer, 71 ms after `build_succeeded` — and eight kills of a release's store at 0–30 ms:
  never a row without its file nor a file without its row, SQLite's integrity check `ok` every time,
  every re-warm byte-identical. A build from scratch in a cache where two builds had been killed ended
  with exactly one entry.
- **What a kill leaves**: `.apvm-tmp-*` part-files in the cache (no later store removes them), and a
  65–782 MB work folder in `TMPDIR` — handled failures clean theirs up, kills never do.
- **The library reacts to no signal**: SIGTERM or SIGINT ends the Node process within 4 ms, as SIGKILL
  does, and orphans its children — composer ran on for 27 s in one case and about 120 s, a download
  included, in another. They share the build's process group, so a SIGKILL of the group leaves no
  survivor.
- **A security leak**: during a private clone the GitHub token sits in
  `<TMPDIR>/backwpup-XXXXXX/backwpup-pro/.git/config` (mode 0644, folders 0755). APVM cleans the URL once
  the clone completes — so a kill during the clone leaves the token on disk for good (×3). On a Linux
  server's shared `/tmp`, other users could read it (not verified there).
- Work folders follow `TMPDIR`. A pinned run starts no build at all (V80), so all of this concerns the
  orchestrator's builds — and a manual run's artifacts setup, which builds in its runner.

**Recommended — the orchestrator; no suite change.**

- **Each build runs in its own worker process**, spawned detached (its own process group) with a
  private `TMPDIR` (mode 0700) under the orchestrator's state folder; progress and the result (0B.2)
  come back as JSON lines on its stdout.
- **Stop, cancel and timeout** are all: SIGKILL the worker's group, then remove its `TMPDIR`. That gives
  a working cancel today — the orchestrator's half of Q1a — and the cache stays consistent at every
  point measured.
- **On startup**, kill the recorded worker groups still alive (checking each process's start time
  against PID reuse), sweep stale `TMPDIR`s, and plan interrupted builds again: a warm is idempotent — a
  complete entry is a cache hit, anything else rebuilds. systemd's cgroup kill is the backstop after a
  crash.
- **Upstream, set aside for now** (P7): a `gc` in the Node library (the CLI's sweeps part-files), and no
  token in the clone's URL — or at least a 0700 work folder.

**Rejected.** Builds inside the orchestrator's process, as the parent has them: no cancel and no timeout,
a native crash takes the orchestrator down, and a crash orphans the build's children. Relying on systemd
alone: nothing for a live cancel, nor on developer machines.

**Not verified.** On Linux: the shared `/tmp`'s exposure, and systemd killing detached workers. Whether
APVM derives `~/.apvm` from `$HOME`, and whether the CLI's `gc` sweeps part-files (both needed a `HOME`
redirect, which the session refused). A kill inside a *build's* store (only a release's store window was
hit).

## 4. 0B — What a run is given

### 4.1 0B.1 — A run's settings

**Finding** (V81–V84):

- What the suite reads (source, excluding tests):

  | Variable | Read at | Default | Blank means |
  | --- | --- | --- | --- |
  | `E2E_PLUGIN_REF`/`_ZIP`/`_VERSION`, `E2E_PREVIOUS_*` | `request.ts:44–56` (trimmed) | the product's default | unset |
  | `E2E_RETRIES` | `project.ts:44` (`intEnv`, 0–10) | 2 | the default |
  | `E2E_SITE_STAGING_DIR` | `staging.ts:114` (a site's own `stagingDir` wins) | `.e2e_temp` | the default |
  | `REPORT_MODE` | `reporting.ts:24` | the portable report | the portable report |
  | `RUN_ID` | `run-context.ts:45–51` | a fresh stamp, **written into `process.env`** | a fresh stamp |
  | `REPORT_ROOT`, `OUTPUT_ROOT`, `AUTH_ROOT`, `ARTIFACTS_ROOT` | `run-context.ts:185–189`; `scripts/report.mjs`, `allure.mjs` | `reports`, `test-results`, `.auth`, `.artifacts` | the default |
  | `CI` | `project.ts:24` (`forbidOnly`) | off | off — but `"false"` and whitespace count as **on** |
  | `BWP_FTP_*`, `BWP_S3_*` | `backwpup.config.ts:27–37`, **read at import** | `""`, or the default port and region | the default |
  | `PRODUCT` | `playwright.config.ts:15` | wp-rocket | wp-rocket |
  | `E2E_INTERNAL_SELECTED_CELLS` | `run-context.ts:66` (to workers) | — | — |
  | the GitHub token | APVM: `GITHUB_TOKEN`, `GH_TOKEN`, then `gh` (`apvm.ts:42`) | — | — |
  | `E2E_CELL` (0A.1) | `bddgen`, the runner, its workers | — | — |

- `load-env.ts` is `process.loadEnvFile()` in a `try`: it loads **every** key of `./.env` — relative to
  the working directory, unknown keys included — into the runner and every worker. A real variable wins,
  even a blank one; a missing, unreadable or malformed file is silently ignored (V81).
- So blanking the known variables — the parent's plan, after V12 — blocks only those names: an unknown
  key still leaks, as would a variable the suite adds later, `NODE_OPTIONS`, Playwright's own, or a
  proxy's (V81).
- A private product's run asks APVM for a token even when its build is a cache hit, and the suite never
  sets APVM's cache folder (`~/.apvm/cache`), so a run shares the orchestrator's `HOME` and cache (V83).
- Importing `run-context.ts` — and so `resolve.ts` or `consume.ts` — loads `.env` and stamps `RUN_ID`;
  `products`, `warm`, `verify` and `sites` do neither (V84).

**Recommended.**

1. **Suite: `E2E_LOAD_DOTENV`**, a boolean (default true, read with `boolEnv`), checked in `load-env.ts`
   before the file is loaded. `false` or `0` loads nothing, in the runner or in any worker; a typo throws
   naming the value (prototype, V81).
2. **Orchestrator: each child's environment from an allowlist** plus the run's settings, never its own —
   always with `E2E_LOAD_DOTENV=false`. The list is in §2.

**Rejected.** Blanking every known variable (an unknown key still leaks, V81); keeping the server's
checkout free of `.env` (the first operator who writes one for a manual run or a healthcheck changes
every orchestrated run, silently); another working directory (the configs use repo-relative globs).

**BackWPup's storage credentials** (V86–V91, asked by the user):

- They are read from `BWP_*` when the product config is imported, in every process of a run (V86) — so
  they arrive the same way whether they came from `.env` or from the run's environment. Measured with
  the prototype: `E2E_LOAD_DOTENV=false` plus `BWP_FTP_HOST=from-env` gives every process `from-env`, and the
  `.env` values appear nowhere (V88).
- **Today nothing reads them**: no step, fixture or page object consumes the product's `services` or a
  site's `overrides`, the "merged over the product globals" the docs describe is not implemented, and
  no scenario uses storage credentials — a missing one changes nothing (V87). The risk starts with the
  storage scenarios (phase-6 6H, 6H.2): a credential the orchestrator does not pass is blank, and the
  planned skip gate would turn that into a green run with a scenario silently skipped. Hence: forward
  every `BWP_*` by prefix (§2), and make a skip's reason name the missing variable (already planned in
  6H), so the report shows it.
- Per-site `overrides.storage` is read from the sites file, so the switch never touches it (V88).
- `E2E_LOAD_DOTENV` set **inside** `.env` is inert (the file is already loaded when it is read), so
  `load-env.ts` should warn about it (V89). Until the switch exists, `E2E_LOAD_DOTENV=false` does nothing
  (V89) — the suite change must land before the orchestrator relies on it.
- A secrets file is not a reason for a path mode: Node's own `--env-file` on the orchestrator's direct
  spawn reaches the runner and every worker (V90).
- Fix when 6H lands: implement the documented merge, or correct `types.ts`, `configuration.md` and the
  modernization plan; and say in `.env.example`/`configuration.md` that `E2E_LOAD_DOTENV=false` skips the
  credentials in `.env`.

**Also.** `CI="false"` turning CI mode on is a small parsing bug of its own (V82). The allowlist never
passes `CI`, so the orchestrator does not depend on fixing it.

**Verify when implemented.** A unit spec on a temporary `.env`; then the runner-and-worker probes again
(every key loaded by default; nothing with `E2E_LOAD_DOTENV=false`; a typo rejected).

### 4.2 0B.2 — The build hands back its commit

**Finding** (V56, V79, V80):

- `warmCache()` and `build()` return a `JsBuildOutput`: `commit` (the full SHA), `commitShort`,
  `branch`, `description`, `fromCache`, `resolvedRef` (`input`, `source {type, value}`, `gitRef`,
  `commitSha?`) and `result` (`version`, `artifacts[]` with `variantId`, `path`, `filename`, `size`,
  `origin`) — and no digest (the cache's database has one; the API does not return it).
- Measured: a cold `develop` pro-en build (318.6 s) returned the full SHA `f1ebfd05…`, equal to
  `resolvedRef.commitSha`. `develop` then moved to `af1ab5c` within hours — exactly what pinning is for.
  `release:latest-stable` returned `commit: "release-5.7.6"` — not a SHA — with `source {release,
  5.7.6}` and no `commitSha`.
- V17, repeated on the current versions: the suite's own planner turned `commit:<sha>` into the same
  build, a cache hit in 0.7–0.9 s with the same SHA-256; `release:5.7.6` hit the entry a `latest-stable`
  warm had filled (0.58 s).
- Through a logging proxy: a pinned `commit:` or `release:` cache hit opens **no** network connection;
  a cached `develop` warm still opens `github.com` (git resolving the branch).

**Recommended.**

- `WarmOne` returns a `WarmedBuild` — `{ fromCache, commit, version, pinRef, artifacts[{ variant, path,
  origin }], resolvedRef }` — and `WarmResult` carries it.
- `pinRef` is a pure function: a 40-hex `commit` → `commit:<commit>`; else a `release` source →
  `release:<value>`; else the build step fails, so a run is never left unpinned.
- The run gets `E2E_PLUGIN_REF=<pinRef>` and the task's version, so it plans exactly as the warm did, and
  its artifacts step needs no network.
- The orchestrator plans through `warmArtifacts([unit], envFromTask, warmer)` — the environment is
  already injectable (`warm.ts:97–101`) — and never through `readArtifactEnv()`, which reads its own
  `process.env`.

**Rejected.** Handing the run the cached zip as `E2E_PLUGIN_ZIP`: it needs no network either, but the run
would then record a provided zip instead of its ref and commit, undoing 0D.

**Not verified.** A `commit:` pin hitting the cache for WP Rocket (its version is embedded) and for
`tag:` refs; a cold `commit:` rebuild of a pull request from a fork once its cache entry is gone.

**Verify when implemented.** `pinRef` over a SHA, a release, and anything else; `warm.spec` for the
result carried through; live: a warm of a moving ref, then a run pinned to it, with the report's commit
equal to the warm's.

### 4.3 0B.3 — One product list

**Finding** (V84, V85). Importing a product's config module runs `loadSites` (reading its sites files,
warning on the example fallback), and BackWPup's reads `BWP_*` at import — so the environment must be
final before it. `createProductConfig` and the per-process registries run only in
`playwright.<product>.config.ts`. A misspelt `PRODUCT` silently runs WP Rocket today.

**Recommended.**

- `src/projects/products.ts` — under `src/projects/`, so `src/common/` still never imports product code:
  `PRODUCTS` (static imports), `productByName(name)` (throws, listing the known ones) and
  `playwrightConfigFor(product)`. It replaces the lists in `healthcheck.ts:53`, `warm-artifacts.ts:30`
  and `playwright.config.ts:15`; blank still means wp-rocket, a typo fails.
- A drift-guard spec: the list names every folder of `src/projects/` once; each product has its entry
  config and a `test:<name>` script using it; a typo gets the error. Prototype: `tsc` and ESLint clean,
  63 unit tests passing, and the guard failing on an unlisted `src/projects/imagify/`.
- The orchestrator's import boundary: `products`, `warm`, `verify`, `manifest`, `request` and `sites`
  are safe; `resolve`, `consume`, `run-context` and `project` are not (they load `.env` and stamp
  `RUN_ID`). Enforce it with ESLint's `no-restricted-imports`, as for `src/common/` and product code.
- Left open: CI's smoke lines (`ci.yml:89–90`) are outside the guard; `orchestrator/` will need adding to
  `tsconfig.json`'s `include`.

**Rejected.** Lazy `import()` loaders: every consumer already imports both products, and async loading
would complicate Playwright's and `bddgen`'s config for no gain at two or three products.

## 5. 0C — Stopping a run

**Finding — what Playwright 1.63 does** (answers V8; V40–V50):

- **First SIGINT to the runner**: it stops dispatching and asks every worker to stop; SIGINTs within
  1 s of each other count once. Each worker **abandons whatever is running** — the step or hook goes
  on, uncancelled, until the worker exits — then runs the After hooks (up to max(project, test
  timeout), capped at 120 s by playwright-bdd) and fixture teardown (30 s), closes the browser, and
  exits. The runner writes every report and exits 130. Measured: 26.5 s with a 20 s After hook,
  128.4 s with a 130 s one.
- Graceful **only by timing** (V41): landing in a step, the teardown runs beside the abandoned step;
  landing in the Before hook, the install goes on past the teardown; landing in the After hook, the
  teardown is cut short.
- **A second SIGINT**, a second or more later: the runner writes its reports and exits while its
  workers finish orphaned (up to 30 s), and the scenario reads "did not run".
- **SIGTERM to the runner**: it has no handler — it dies at once, with **no Playwright HTML or JSON
  report and a 0-byte Cucumber file**; its workers finish orphaned within 30 s (V43). Workers ignore
  SIGINT and SIGTERM; they exit when the runner's IPC channel closes.
- **SIGKILL**: to the runner, the same orphaning, cut at 30 s — refining V7 (V43); to the whole
  process group, everything dies at once (V44).
- The reports then disagree on the interrupted scenario: Playwright says interrupted, JSON skipped,
  Allure failed — and **Cucumber never says interrupted**: passed in the lab, failed live with an error
  the teardown caused (V45, V73).
- **The launch path matters** (V46): npm and npx forward SIGINT and SIGTERM to their child, but with
  the suite's `bddgen && playwright test` scripts, macOS's bash kept the SIGINT from the runner — the
  run went on to exit 0.
- The process group outlives the runner while orphaned workers tear down: an empty group
  (`kill(-pgid, 0)` → `ESRCH`), not the runner's exit, marks the end (V47).
- systemd with `KillMode=mixed` (V49): `systemctl stop` signals the orchestrator only; after an
  orchestrator **crash** nothing is left to SIGTERM, so the cgroup is SIGKILLed at once — every run
  hard-killed.
- A gap: the `@plugin` Before path never stops the product's running work, so after a kill the next
  run uninstalls BackWPup under a job the killed run left running (V50).

**Live** (§5.1, V51, V73–V75): one SIGINT while the job ran left the site as found and every report
written — but the scenario's **remaining steps kept running beside the teardown**, and its last one
queried BackWPup after the plugin was gone, recording an error the product never made. A SIGKILL left
the plugin, its footprint, its folders and the staged zip, all recovered by the next normal run. A
SIGINT landing inside the After hook cut its last duty, leaving the plugin's folders, and reported a
scenario whose steps had passed as interrupted. Only the drain stops a run without any of this.

**Recommended.**

1. **Spawn directly** (§2). The PID held is the runner — the one process that turns SIGINT into a
   graceful stop — and its process group reaches everything else.
2. **Stop = drain** (a suite change). The orchestrator creates the run's stop file
   (`E2E_INTERNAL_STOP_FILE`); an auto test fixture in `src/common/fixtures.ts` skips a scenario's
   **first attempt** once the file exists, with a `stopped` annotation giving the reason; the
   `@plugin` After hook returns at once for such a scenario. The scenario in flight finishes as it
   would have, its retries included; the reports stay complete and true; the exit status reflects
   what ran. With the variable unset there is no gate, so manual runs are unchanged. Measured on a
   prototype (V48) — and gating retries too would turn a failure into "flaky", hence first attempts
   only.
3. **Stop now = one SIGINT** to the runner's PID, when the drain's budget runs out or on request.
   Record the run as stopped by interrupt: its scenario in flight may have been cut, and the reports
   misstate it (V45).
4. **Kill = SIGKILL to the process group** — never the runner alone, which orphans its workers.
   Record the run as killed; the results stream is then its only record (0E).
5. **Never SIGTERM a run, and never send a second SIGINT.**
6. **Budgets**, defaults to tune from 0E's durations: drain 15 min (BackWPup adds 10 min per backup to
   a scenario's timeout); interrupt to kill 4 min (a 120 s hook, 30 s of fixtures, 30 s of browser
   close, the reports).
7. **Orchestrator shutdown** (SIGTERM from systemd, or SIGINT): start nothing new; drain every run
   briefly (e.g. 2 min), interrupt (4 min), kill, exit. Set `TimeoutStopSec` above the drain plus the
   interrupt plus a margin (e.g. 6 min 30 s). On restart, runs still recorded as running are marked
   killed — a crash has already killed them.
8. **Queued or building runs** are cancelled by a stop; a build already under way still finishes into
   APVM's cache (V15).
9. **Suite:** the `@plugin` Before path calls `stopRunningWork` before `ensurePluginAbsent`, so
   recovering from a kill is complete (V50).
10. **After a kill**, or an interrupt that landed in a hook, the site can hold the plugin, its
    footprint, gigabytes of partial archives on a shared disk, and the staged zip. The orchestrator
    runs the suite's cleanup chain for that cell (`ensurePluginAbsent` → `removeSiteDbResidue` →
    `removeSiteResidue` → `cleanSiteStaging`) before anything else runs there, instead of waiting for
    the cell's next scenario.

**Rejected.** A plain SIGINT as the stop (it abandons hooks, leaves the scenario's remaining steps
running against a site being torn down — V73 — and Cucumber never says interrupted);
SIGTERM (no reports); the npm scripts (shell-dependent, V46); a second SIGINT (orphans the workers,
drops the scenario); Playwright's internal `PWTEST_*` timeouts (not public API); the test server's
`stopTests` (the same interrupt); gating `@plugin` scenarios only (misses the others); `KillMode=process`
or a systemd scope per run (a restarted orchestrator cannot wait on processes that are not its
children).

**Verify when implemented.** Unit: the gate as a pure function (file present or absent, variable
unset, retry 0 or 1); the After hook's early return; the Before path stopping work first. The
orchestrator's stop state machine, with an injected clock and a fake `kill`: drain → one SIGINT →
SIGKILL of the group; "ended" only on `ESRCH`; never SIGTERM, never a second SIGINT. Live: L1–L4
below, then L2 once the drain exists.

### 5.1 Live protocol (`free@nginx`, `bwu2`)

Each step runs one real `@plugin` scenario — "Watching a running backup waits for it to finish…", a
database backup paced to several seconds — spawned as recommended, signalled once its job is seen
running, with the site's state read before and after (plugin, footprint, running job, residue,
staging area, `debug.log`, `wp` processes).

| Step | Signal | Expect |
| --- | --- | --- |
| Control | none | pass; the site as found |
| L1 | one SIGINT to the runner | exit 130; the After hook stops the job and removes everything; the site as found; reports complete |
| L3 | SIGKILL to the group | the plugin, footprint, staging zip, the scenario's padding tables and perhaps the job left; the next normal run recovers them, the padding as its worker starts (phase-6 V188; V50's gap is visible there) |
| L4 | one SIGINT inside the After hook | a teardown cut short; one normal run restores the site |
| L2 | the drain, once built | the scenario in flight finishes, the next is skipped as stopped; exit 0/1; the site as found |

Results, 2026-09-25 at `develop@af1ab5c` (built from scratch in 4.2 min by the first run). They test the
suite's teardown and recovery, which this feature keeps independent of WP-Cron (the whole job runs in
one request), so they did not wait for cron parity:

| Step | Measured |
| --- | --- |
| Control | 3 passed; runner exit 0 and the group empty together; the site as found |
| L1 | SIGINT at +62.5 s, job running → exit 130 after 21.4 s, group empty 0.1 s later. The After hook stopped job 3 and removed everything: **the site as found**; Playwright HTML, Cucumber and Allure all written. Meanwhile the abandoned body ran on to its last step, whose `wp backwpup log` failed — `'backwpup' is not a registered wp command` — because the teardown had already removed the plugin; that error is the scenario's in the reports (Allure failed; Cucumber 2 FAILED, 16 PASSED; nowhere "interrupted") |
| L3 | SIGKILL of the group at +61.8 s → group empty at once. Left: the plugin installed and active, its whole footprint (26 options, `wp_bwpup_backups`, 3 roles, 11 capabilities), both data folders, the staged zip; the job had ended within 15 s. The next normal run passed and restored the site (its uninstall ran the plugin's own cleanup, so the sweep found nothing). V50's race was not exercised — the job was over before that run began |
| L4 | SIGINT after the teardown's uninstall, before its last duty → exit 130 in 0.8 s. Left: both data folders (on a files job: gigabytes on a shared disk); the staging area was removed by the worker's teardown. The scenario, every step passed, reads interrupted. One normal run restored the site |
| Final | the site as found; nothing running |

## 6. 0D — Reports say what they tested

### 6.1 0D.1 — Up front in every report

**Finding** (V40, V52–V55, V67):

- **Playwright HTML**: its **title** is the only up-front slot — the `title` option or
  `PLAYWRIGHT_HTML_TITLE`, read in the reporter's own `onEnd`; one line (newlines collapse).
  `config.metadata` sits in a collapsed panel, and custom keys stay hidden without
  `#?show-metadata-other` in the URL. Keep `captureGitInfo` off: it records authors' emails and, under
  CI, a diff.
- **Cucumber HTML**: a fixed header (runtime, OS), no title or metadata option; non-BDD projects never
  appear, which is why the setup's attachment is absent; the file is complete by the end of its
  `onEnd`. A banner inserted before `</body>` and moved to the top renders above the header — in the
  normal mode, the rich mode, and with no scenario run.
- **Allure 3.18**: `allure-results/environment.properties` becomes the front page's Metadata (in file
  order, 8 visible), and `--name` the header. allure-playwright writes that file only when
  `environmentInfo` is configured — it is not — so a file of our own survives.
- **Lifecycle**: reporters are built in config order, from a shallow copy of their options (a later
  mutation does not reach them); `onEnd` is awaited reporter by reporter, then every `onExit`. So values
  set in the **first** reporter's `onEnd` — `config.metadata`, `PLAYWRIGHT_HTML_TITLE` — reach the HTML
  report; setup attachments reach `onTestEnd` even when the setup then skips or fails; on SIGINT `onEnd`
  and `onExit` still run, on SIGTERM neither does.
- A reporter that throws turns a green run red (V67): a new reporter must catch everything and warn
  once.

**Recommended — a *run facts* reporter, listed first in `reporters()`.**

| Fact | From | Known at |
| --- | --- | --- |
| product, cell, edition, `RUN_ID` | the config factory, passed explicitly | `onBegin` |
| run name, requested ref | two display-only variables the orchestrator sets (§2; names: P5) | `onBegin` |
| plugin: ref, full commit or zip name, SHA-256, header version — or the failure | the existing `artifacts-resolution.json` attachment, extended by 0D.2 | after `artifacts:<cell>` |
| per site: `baseURL`, WordPress, PHP, SAPI, web server, database | a new `site-info.json` attachment (0D.3) | after `setup:<cell>` |
| the run's status | `onEnd` | the end |

- `onBegin` writes the known facts to `config.metadata` (flat keys), `<report dir>/run-facts.json` and
  `<report dir>/allure-results/environment.properties`. `onTestEnd` folds in the two attachments and
  rewrites both files, so a run killed later still leaves them. `onEnd` sets the final metadata and
  `PLAYWRIGHT_HTML_TITLE`. `onExit` writes the final `environment.properties`, then the Cucumber banner.
  All fail-soft.
- What shows: the HTML title — `backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · develop @ <commit>
  · WordPress 7.1.2 · PHP 8.5.10 · <run>`; the same line as the Cucumber banner; Allure's `--name`
  (from `run-facts.json`, in `scripts/allure.mjs`) and its Metadata, most important first. A missing
  fact is said — "resolution failed", "site unknown: auth setup failed" — never left blank, and an
  interrupted run says so (V45).
- Only whitelisted fields: of the sites file, only `baseURL`. Values are HTML-escaped for the banner and
  escaped for the properties file.
- Placement: a pure `src/common/reporting/run-facts.ts` (merging, the title line, properties escaping,
  banner injection, the attachment parsers — unit-tested) and a thin `run-facts.reporter.ts`. 0E can
  reuse the facts; the orchestrator reads `run-facts.json` for its run record.

**Rejected.** Values at config time (the config is evaluated before the setups run, and again in every
worker); `config.metadata` alone (collapsed); a getter or later mutation of a reporter's options (frozen
by the shallow copy); allurerc `variables` (read at generation only); Cucumber hook messages (they render
below the scenarios); a "run info" test (it pollutes the counts); post-processing by the orchestrator
(manual runs would miss it, and the HTML report's data is a zipped blob).

**Verify when implemented.** Unit: the title line, properties escaping (`=`, `:`, `\`, newlines,
non-ASCII), banner injection with and without `</body>`, the attachment parsers. No site: render the
three reports for a normal run, a failed setup and a SIGINT, and assert their text. Live on
`bwu2`/`bwu3`: a normal run, a SIGINT and a SIGKILL — each report's SHA-256 equal to `shasum` of the zip
in `.artifacts/`.

### 6.2 0D.2 — The full commit, and a zip's SHA-256

**Finding.**

- APVM returns the full `commit` beside `commitShort`, and no digest (V56); the suite stores
  `commitShort` (`resolve.ts:324`). For a `release:*` download, `commit` is `release-<tag>`, not a SHA
  (V79).
- **Two builds of one commit are different files** (V57): the main checkout's `pro@nginx` and
  `pro@apache` zips — same name, size and commit (`f1ebfd0`) — have different SHA-256s;
  `languages/backwpup.pot` is regenerated at build time, and 1,070 entries differ in mtime. A commit
  names the source, not the artifact.
- Hashing a BackWPup zip costs 5–19 ms (V57). `.commit` is read only by the resolver,
  `resolution.json`, its parser and the verify info map.

**Recommended.**

- `resolve.ts` stores `output.commit` when it is 40 lowercase hex characters, and omits it otherwise —
  a release is then named by its ref (`release:5.7.6`); short forms are derived for display only.
- `resolveRole` hashes **every** resolved zip, right after its `chmod` — the one funnel built and
  provided zips share. For a provided zip, it double-checks the orchestrator's stored digest.
- `ResolvedArtifact.sha256` — optional in the type, always set by the resolver — is written by
  `writeResolutionFile`; `parseRole` accepts 64 lowercase hex characters, rejects a malformed value, and
  tolerates its absence (an older `resolution.json`, read only by `--no-deps` runs); `infoFor` carries
  it.

**Verify when implemented.** `consume.spec` (digest present, absent, malformed; a full-commit round
trip), `verify.spec` (`infoFor` carries it), `resolve.spec` (a provided zip hashed against a known
digest).

### 6.3 0D.3 — The site's own versions

**Finding** (V58, V59; live on `bwu2` and `bwu3`):

- After `loginViaUi`, `wp-admin/site-health.php?tab=debug` holds the "Copy site info" text on exactly
  one `getByRole('button', { name: 'Copy site info to clipboard' })`, in `data-clipboard-text`: about
  6.5 KB, 13 `### section ###` blocks of `key: value` lines, wrapped in lines of backticks. Ready 1.3–
  1.4 s after the login.
- Values: `wp-core.version` 7.1.2; `wp-server.php_version` `8.5.10 64bit`, `php_sapi` `fpm-fcgi`,
  `httpd_software` `nginx/1.24.0`; `wp-database.server_version` `8.0.46-0ubuntu0.24.04.4`. WP-CLI's PHP
  there is 8.3.33, so V28 holds.
- The text **omits WordPress's private fields** — the database user, host and name are absent — but
  holds paths, `WP_HOME`/`WP_SITEURL`, the user count, plugin and snippet names.
- The page requests `/wp-json/wp-site-health/v1/directory-sizes` by itself (89–223 ms on `bwu3`, with
  cached sizes); aborting it leaves the text intact.

**Recommended.**

- In the auth setup, per real site, after its login: a cross-product page object
  (`src/common/pages/site-health.page.ts`, with its locator-contract spec) returns the text; a pure
  parser keeps only the whitelisted keys (`wp-core.version`, `wp-server.php_version`, `php_sapi`,
  `httpd_software`, `wp-database.server_version`, `extension`); the setup attaches `site-info.json`,
  one entry per site with its `baseURL`. The `directory-sizes` request is aborted (`page.route`).
- **Best-effort**: a failure is a warning and "unknown" in the reports — never a failed setup.
- The whole text is never stored or attached.

**Verify when implemented.** The parser on a captured text (headers with counts, the backtick wrapping,
missing keys); the page object's locator-contract spec; live on both cells, values equal to the ones
above.

## 7. 0E — Machine-readable results

**Finding** (V60–V66):

- Reporters run only in the runner, and a CLI `--reporter` replaces the configured list — so the
  stream must be configured, not passed on the command line.
- `onBegin`'s total includes the cell's two setup tests (`--grep` filters scenarios only).
  `onTestEnd` fires **per attempt**; the final one is `!willRetry || status === "interrupted"` (an
  interrupted attempt is never retried).
- `titlePath()` is `["", project, spec, Feature, …Rule and Outline titles, scenario]`; `tags` carries
  the Gherkin tags; `test.id` is stable across runs of one cell, not across cells.
- Errors: a failing step carries its error (each Gherkin step is a `test.step`); a hook's error sits on
  `BeforeEach Hooks` or `AfterEach Hooks`; a crash leaves no failing step (`worker process exited
  unexpectedly`); messages carry ANSI codes. `TestStep.params` can carry `fill()` values — so the stream
  never serializes params, `pw:api` steps, attachments or stdout.
- A failed setup gives the cell's scenarios **no** `onTestEnd` at all: "could not test" is visible only
  through the setup's own result.
- No existing reporter streams: JSON, JUnit, blob and playwright-bdd's Cucumber formats (its NDJSON
  `message` one included) write only in `onEnd`; allure-playwright writes per attempt, but has no final
  or flaky flag, no totals and no end.
- A prototype streamed every event to a reader within its 200 ms poll, attributed every failure
  correctly, and left only complete lines after a SIGTERM.

**Recommended — `src/common/reporting/results-stream.ts`, schema v1.**

- Listed first in `reporters()`, so `run.end` lands before the slow reporters' `onEnd`. **Always on —
  decided** (P4), writing `<report dir>/results.jsonl`: the orchestrator knows the path from the
  `RUN_ID` it pins, every report describes itself, 0F prunes the stream with its report, and 0F uses it
  to recognise empty report folders. Measured: it changes **nothing** on the terminal — plain stdout and
  stderr identical line for line, a TTY screen identical but for two durations' digits (V100); a failed
  write adds one stderr line and leaves the exit code alone (V101). About 18.6 KB for 27 attempts.
- The file is created on the first write, inside the reporter's own `try`: the earlier prototype's
  `mkdirSync` outside it would have turned a run red (V67). Reporters also run for `--list` (mode
  `list`) and for "No tests found" (0 tests): both leave a report folder, which the stream marks (V104).
- **The manual run's terminal gets an end-of-run summary** — the user asked that it be "very good and
  understandable". Today a run's end names only the Playwright report, and only when stdin is a TTY and
  `CI` is unset; it never says what was tested, and a failed setup never says "could not test" (V102).
  A reporter listed **last**, printing in **`onExit`**, is the only slot below everything — the list's
  counts and the HTML hint included — on a pass, a failure, a failed setup and a SIGINT, and silent on
  SIGTERM and `--list` (V103):

  ```text
  ━━ backwpup · pro@nginx (pro) ━━ ✘ FAILED ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Result      2 failed · 1 flaky · 11 passed · 1 skipped, in 14.2m
    Plugin      BackWPup Pro 9.99.99 · develop @ af1ab5c…     (from 0D.2)
    Site        https://bwu3.e2e… · WordPress 7.1.2 · PHP 8.5.10 (from 0D.3)
    Playwright  npx playwright show-report reports/backwpup/pro@nginx/<RUN_ID>/playwright
    Cucumber    reports/backwpup/pro@nginx/<RUN_ID>/cucumber/index.html
    Allure      npm run report:allure -- backwpup pro@nginx --open
    Pruned      1 old report, 4.3 MB — beyond the newest 20 (E2E_REPORTS_KEEP)
  ```

  Verdicts: `✔ PASSED`, `✘ FAILED`, `✘ COULD NOT TEST` (a setup failed), `■ INTERRUPTED`, `NO TESTS`;
  "Result" counts scenarios, not setups; `Pruned` appears only when something was removed. It shares the
  facts of 0D.1's reporter. `report:allure` opens the cell's newest results, not this run's — a small
  follow-up lets it take a run folder.
- Every line has `v`, `type` and `at`:
  - `run.begin` — run id, product, cell, edition, scenario and setup counts, retries, workers;
  - `setup.end` — each setup project's status and error;
  - `scenario.begin` — per attempt ("running now", "stuck for how long");
  - `scenario.retry` — an attempt that will run again;
  - `scenario.end` — once, final: feature, scenario, feature file, rule/outline path, tags, status,
    outcome, attempts, duration, first error;
  - `run.end` — status, and counts including `didNotRun`; `run.error` — errors outside any scenario.
- Status: `interrupted` if the final attempt was, else passed, failed (timeouts included), flaky or
  skipped. The first error is the first failing Gherkin step, else the innermost failing hook, else —
  a crash, or a timeout outside any step — the last step begun; ANSI codes stripped, length capped.
- One `appendFileSync` per line, the file created fresh in `onBegin`. A failed write warns once and
  never throws (V67); `onEnd` returns nothing, since a returned status would replace the run's.
- The orchestrator reads complete lines from an offset and ignores unknown types and fields; `v` is
  bumped for any breaking change. No `run.end` means the runner died (the exit code says how: 130, 143,
  137); no file means Playwright never started.
- Run statuses (parent §2): `error` — a failed setup, no stream at all, or a death the orchestrator did
  not cause; `stopped` — after its own stop, a drained run's verdict or `run.end interrupted`; `killed`
  — killed, no `run.end`; otherwise failed, flaky or passed, from the counts.

**Rejected.** The JSON, JUnit, blob or Cucumber `message` reporters (end only, nothing on SIGTERM);
tailing `allure-results/` (no finality, no totals, a format that is not ours); parsing the `list`
reporter's text; final lines only (they lose "running now" and the retries).

**Verify when implemented.** Unit, on fake `TestCase`/`TestResult`/`TestStep` objects: failure
attribution (a step, a Background step, a `test.step` nested in a Gherkin step, hooks, a timeout, a
crash), the final-status table, ANSI stripping and truncation, the class driven into a temporary file
(order, counts, `didNotRun`; an unwritable path warns once and throws nothing), and the reader (a
partial last line, a bad line, an unknown type). No site: the prototype's features, with a SIGINT, a
SIGTERM and a failing setup. Live: a real cell, where a `DebugLogFatalError` is attributed to
`AfterEach Hooks`.

## 8. 0F — Report pruning

**Finding** (V68, V69):

- A run leaves `REPORT_ROOT/<product>/<cell>/<RUN_ID>/`: `playwright/` (written in `onEnd`),
  `cucumber/index.html` (created at start, filled in `onEnd`), `allure-results/` (per attempt),
  `allure/` (if generated) and, with 0E, `results.jsonl`. Beside the runs, at cell level,
  `allure-history.jsonl`, which references no run folder.
- **A killed run looks like one in progress**: no `playwright/`, and a 0-byte `cucumber/index.html`
  from its first second (6 of 153 real runs).
- The main checkout's tree: 153 runs, 662 MB; per run a median of 1.5 MB, p99 37 MB, at most 154 MB;
  durations a median of 0.8 min, at most 8.6 h (a sleeping runner).
- A RUN_ID is the ISO time with `:` and `.` turned to `-`, then `-<pid>`; the orchestrator's
  `-<run id>` suffix parses the same way. A pinned RUN_ID can be anything, and a strict parse must
  round-trip (`Date.UTC` silently rolls impossible dates over).

**Recommended.**

- `src/common/config/run-id.ts`: `formatRunId` and a strict, round-tripping `parseRunId`. `stamp()`
  uses the formatter, so producer and parser cannot drift; the orchestrator builds its RUN_IDs with it.
- `src/common/reporting/retention.ts`:
  - `listReportRuns(root)` never follows a symlink below the root; a run is a folder holding a report
    part, and anything else is skipped with a reason;
  - `planRetention(entries, policy, now, groupOf, protectedPaths)` is pure — keep or delete, each with
    its reason;
  - `applyRetention(plan)` removes, then confirms each folder is gone; one failure is reported, never
    thrown.
- Policy — **decided with the user (P6)**: at most **N = 20** reports per group (FIFO), no older than
  **X = 30 days**, but each group's newest complete report kept up to **Y = 182 days**. Per group
  (`product/cell` on a dev machine, the task in the orchestrator), newest first by RUN_ID time (else
  the newest mtime inside):
  1. an **empty** run — `--list` or "No tests found", recognised by its `results.jsonl` — never counts
     and is removed unless protected (without this, each such invocation evicted a real report, V104);
  2. a protected run (the run in progress, the orchestrator's active runs) is kept; so is a future-dated
     one;
  3. the group's **newest complete** report is kept while at most Y old — the cap never removes it, so a
     cell whose last 20 runs were killed keeps one readable report (N + 1 at most);
  4. a run older than X is removed; a run at rank N or beyond is removed; anything else is kept.
  Killed runs count toward N. `keep = 0` means no count limit. **X is never below 1 day.** The planner
  decides all 18 table cases (V105).
- **When**: automatically at the **end of each run, for that run's own cell**, from the last reporter's
  `onExit` — so "when a 21st run comes, the oldest is removed" holds literally. Measured: the new run
  counts and is never removed, a failing run still prunes, a SIGKILLed one does not (the next run
  does), `_all` and other cells are untouched; 10 ms (V106). At the start of a run instead, a run
  killed right after had already cost a complete report (V106). The summary prints what it removed.
  A cell that no longer runs is pruned only by `npm run report:prune` (all cells, a dry run unless
  `--apply`).
- **Orchestrator**: sets `E2E_REPORTS_KEEP=0` in its runs and prunes per **task** itself, at each run's
  end and on its schedule — several tasks can share a cell, and it also drops each report's logs and
  zips while keeping a summary record (parent §3).
- **Configurable**: `E2E_REPORTS_KEEP` (`intEnv`, 0–10000; a bad value fails at start, naming it —
  V107); `report:prune --keep <n> --older-than <n>m|h|d|w --keep-newest-for … --product --cell
  --apply` (a strict parser, exit 2 on a bad value); the orchestrator's own config.
- **Removal is not atomic** (V108): `rmSync` failing midway had already deleted part of a run. Rename
  the run's folder to a hidden name inside its group first (atomic on one filesystem), then remove it.
- `prune-reports.ts`, with `"report:prune": "tsx prune-reports.ts"` and an entry in `tsconfig.json`'s
  `include`: a dry run unless `--apply`, each decision printed with its reason and size;
  `--older-than` and `--keep-newest-for` (`<n>m|h|d|w`), `--product`, `--cell`; exit 0, 1 (a removal
  failed) or 2 (bad arguments).
- A dry run over the main checkout's tree (165 runs, 711.5 MB, 2026-09-28) would remove 109 runs
  (544.6 MB) — the cap alone 18 of them, in `free@nginx` and `pro@nginx` — keeping each cell's newest
  complete report, retired cells included (V109). Age alone: 91 runs, 468.3 MB.
- The orchestrator reuses both functions on its own schedule, grouped by task, protecting its active
  runs, and saves each run's summary from `results.jsonl` before the report goes.
- Fix the drift: `run-context.ts` and the modernization plan still describe "the newest N per cell";
  `execution-model.md` should name this policy.

**Rejected.** The newest N per cell alone (it ignores time: a 5-minute loop would keep minutes of
history — hence the cap *and* the age rules); age alone (a retired cell loses its last report, and a
busy cell is unbounded); mtime as the age (generating an Allure report makes an
old run look new); a `.running` marker (a writer in every run, and stale markers to handle — the 1-day
floor and the orchestrator's records already cover it); deleting by default.

**Risk.** The orchestrator's disk: 20 runs a day at the mean 4.3 MB keep about 2.6 GB per cell with
X = 30 days. Measure on the server before settling X.

**Verify when implemented.** `parseRunId` on today's stamps, orchestrator suffixes, impossible dates,
garbage, and a round trip; `planRetention` table-driven with a fixed `now` over every edge case (the
boundaries at exactly X and Y, protected paths, grouping by task); `listReportRuns` and
`applyRetention` on a temporary tree (a symlinked run skipped, a symlink inside a run unlinked with its
target intact, cell-level files kept, each removal verified).

## 9. Implementation order

Each step ships with its unit tests, passes the four gates, and gets the live check its section names,
on `bwu2`/`bwu3`, one cell at a time.

1. 0B.3, one product list — everything the orchestrator spawns starts from it.
2. 0A.2, the output folders and the cell-name rule — a hazard today.
3. 0A.1, the cell pin.
4. 0B.1, a run's environment.
5. 0D.2 with 0B.2 — the full commit, the digest, and the built commit (the artifacts code).
6. 0C's suite parts: the Before path stopping running work (worth having now), then the drain.
7. 0D.3, the site's versions.
8. 0D.1 and 0E, run facts and the results stream (the reporting code).
9. 0F, pruning.

0A.3, 0A.4 and 0A.5 belong to the orchestrator: no suite change but the optional loader check.

The [Phase 0.5 plan](orchestrator-phase-0.5-plan.md) — the minimal orchestrator — relies on every item but
0B.2 (its §3).

## 10. Open questions

| # | Question |
| --- | --- |
| P1 | Cron: **done 2026-09-30 for all of `bwu2`–`bwu9`** (`bwu7`–`bwu9` once their QA sessions were idle) — each verified (a probe run by the new line at the next tick and the cron log's `CMD` line; then WP-CLI and a page load no longer running cron). |
| P2 | ~~V5: which sites does AutoE2E run, on which hosts?~~ **Answered 2026-09-28**: two WordPress servers — AutoE2E's two nginx cells on the nginx one, its two apache cells on the apache one (§3.3); site details later, if needed. |
| P3 | ~~V6: may runs overlap on one server to measure it?~~ **Answered 2026-09-28**: yes — about four parallel suites per server are fine; name the sites before a run (§3.3). |
| P4 | ~~The results stream: always on, or orchestrator-only?~~ **Decided 2026-09-28**: always on — it writes nothing to the terminal (V100); manual runs get an end-of-run summary instead (§7). |
| P5 | ~~Variable names?~~ **Decided 2026-09-30** (the user left the choice to me): `E2E_CELL` (the pin), `E2E_LOAD_DOTENV` (`false` skips `.env`; a switch's name, so nobody passes it a file path), `E2E_INTERNAL_STOP_FILE` (internal), `E2E_REPORTS_KEEP` (default 20, `0` = no cap), and the display-only `E2E_RUN_NAME` and `E2E_REQUESTED_REF`. |
| P6 | ~~Retention defaults?~~ **Decided 2026-09-28**: at most 20 per cell (FIFO, configurable), 30 days, the newest complete kept up to 6 months (§8). |
| P7 | ~~File with APVM: the token left in a killed clone's `.git/config` (V78), and a `gc` in the Node library (V76)?~~ **Set aside 2026-09-28**: not a priority. The orchestrator's private build folders (§3.5) still keep the token out of shared temp space. |

## 11. Verification

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| V29 | Two runs of different cells of one product started together fail 2 of 80: one `bddgen` crashes (`ENOENT`) on a spec the other deleted. Staggered 0–5 s: 0 of 80 | ✅ 2026-09-25 | Placeholder wp-rocket cells, 40 iterations per mode; `generate/index.js:31–38`, `:124–130` |
| V30 | A regeneration leaves a cell's specs missing 2–11 ms (p50 3.8); a collection overlapping it fails with `Cannot find module` (1 of 10 runs under a regeneration loop). Workers run the code compiled at collection: a renamed scenario and a changed step ran as collected, while a spec deleted mid-run fails its tests | ✅ measured + source | A poller over 30 generations; 10 × 34 s runs; `common/index.js:135–141`, `:1262–1264`; `runner/index.js:5597` |
| V31 | `bddgen` accepts no `--project` (`unknown option`); npm passes `-- args` only to a script's last command; `npm run x --cell=…` fails (`EUNKNOWNCONFIG`) | ✅ measured | npm 12.0.2; re-run in the worktree |
| V32 | Pinning the config to one cell through the environment makes `bddgen` rewrite only that cell: 0 of 80 failures, CI's smoke unchanged, a disagreeing `--project` rejected. Unless `selectedCells()` honours the pin, `isCellTargeted` is false. An inherited `PLAYWRIGHT_BDD_CONFIGS` defeats any scoping; importing `run-context.ts` stamps `RUN_ID` | ✅ prototype + measured | Inode checks; the 40-iteration batch; environment probes |
| V33 | A failing setup project writes its trace and error context in the root `test-results/` | ✅ measured | A forced `artifacts:apache` failure |
| V34 | Deleting `test-results/` mid-run loses the attachments made before it from all three reports; a missing attachment file (a failed attempt's screenshot, a file attached by path) crashes the Cucumber reporter, failing a run with no failed test | ✅ measured + source | Control against deletion runs; `runner/index.js:3801–3809`; playwright-bdd `attachments/external.js:52–90` |
| V35 | With the setup projects in their cell's folder, unit runs in `_unit` and runs of no cell in `<product>/_all/<cell>`, each of five invocations deletes only its own folder | ✅ prototype | Marker measurement |
| V36 | `qa-lnmp`: 4 vCPU, 14.6 GB RAM; 97 GB disk, 17 GB free; MySQL 8.0.46 (`max_connections` 151, peak 118); one PHP-FPM 8.5 pool for every 8.5 site (70 children, 30 s, 128 MB); 26 docroots | ✅ 2026-09-25 | `nproc`, `free`, `df`, `SHOW VARIABLES`/`STATUS`, `pool.d/www.conf`, `/var/www/html` |
| V37 | The staging area resolves per site for a relative root and is shared by a host's sites for an absolute one; a worker's teardown removes the whole area | ✅ source | `staging.ts:113`, `:139–143`; `teardown.ts:33` |
| V38 | AutoE2E runs four instances — `auto-e2e-bkwp`, `-bkwp-apache`, `-wpr`, `-wpr-apache` — whose sites are defined only on its server | ✅ source | `wp-media/auto-e2e`: `scripts/manage-e2e/manage-e2e.sh:25–39`, README |
| V39 | `loadSites` accepts one site listed by three cells (URL case, trailing slashes), keeping the values verbatim | ✅ measured | A scratch sites file through the real loader |
| V40 | **Answers V8.** First SIGINT: the runner stops dispatching and stops its workers, which abandon the running step or hook, run the After hooks and fixture teardown, and exit; the runner writes every report and exits 130. SIGINTs within 1 s count once; a later one makes the runner write its reports and exit while its workers finish orphaned (up to 30 s). SIGTERM kills the runner at once, with no report. Workers ignore both signals | ✅ source + lab | `runner/index.js:6045–6111`, `:6136–6190`, `:2017–2037`, `:6313–6316`; `common/index.js:1916–1962`; lab cases 01–06, 26 |
| V41 | An interrupt abandons the running step or hook without cancelling it; landing in the After hook, it cuts the teardown short | ✅ lab + source | Cases 01, 18, 22; `workerProcessEntry.js:376–379` |
| V42 | Under an interrupt, the After hook gets max(project, test timeout), capped at 120 s by playwright-bdd; fixtures share 30 s. SIGINT to exit took 128.4 s with a 130 s hook | ✅ lab + source | Cases 10, 10b, 29; `workerProcessEntry.js:1661–1663`, `:1855–1857`; playwright-bdd `hooks/scenario.js:70–82` |
| V43 | Once their runner dies, workers finish gracefully within 30 s (internal `PWTEST_FORCE_EXIT_TIMEOUT`); killing only the runner cuts a longer teardown. Refines V7 | ✅ source + lab | `common/index.js:1917`, `:1953–1958`; cases 03, 07, 09, 09b, 09c |
| V44 | SIGKILL to the process group ends the runner, workers and browsers at once; only finished tests' Allure results and a 0-byte Cucumber file remain | ✅ lab (macOS) · ⏳ Linux | Case 08 |
| V45 | The reports disagree on an interrupted scenario: Playwright interrupted, JSON skipped, Allure failed; Cucumber never says interrupted — passed in the lab, failed live (with the error of V73) | ✅ lab + source + live | Case 01; playwright-bdd `messagesBuilder/TestStepRun.js:116–140`; L1 |
| V46 | npm and npx forward SIGINT and SIGTERM to their child; with the suite's `bddgen && playwright test` scripts, macOS's bash 3.2 kept SIGINT from the runner (the run finished, exit 0); dash execs the runner | ✅ lab (npm 12.0.2) | Cases 11–15b |
| V47 | The process group outlives the runner while orphaned workers tear down; `kill(-pgid, 0)` → `ESRCH` marks the end | ✅ lab | Case 26: runner gone at 18.9 s, group empty at 39.4 s |
| V48 | A drain gate — skip first attempts once a stop file exists, the After hook returning for gated scenarios — lets the scenario in flight finish (retries included) and skips the rest with a reason, the reports true; gating retries too turns a failure into flaky | ✅ lab prototype | Cases 23–25, 27; `runner/index.js:605–630`; `workerProcessEntry.js:1644`, `:1813` |
| V49 | systemd `KillMode=mixed`: a stop signals the main process only; after a crash nothing is left to SIGTERM, so the cgroup is SIGKILLed at once | ✅ source (systemd, via Context7) · ⏳ the server's version | `unit.c` `unit_kill_context`; `service.c` |
| V50 | The `@plugin` Before path never stops the product's running work | ✅ source · ⏳ live (L3 could not reach the race: the job ended within 15 s of the kill) | `plugin-lifecycle.ts:208–215` against the teardown's `:338–339` |
| V51 | One SIGINT during a real `@plugin` scenario on `free@nginx` leaves the site as found and every report written | ✅ live 2026-09-25 (L1) | §5.1: `site-state` before and after; the report folder |
| V52 | The HTML report's only up-front slot is its title (`title` or `PLAYWRIGHT_HTML_TITLE`, read in its `onEnd`); custom metadata sits in a collapsed panel | ✅ source + rendered | `runner/index.js:3471–3485`; rendered screenshots |
| V53 | Reporters are built in config order from a shallow copy of their options; `onEnd` is awaited in turn, `onExit` after all. `config.metadata` and `PLAYWRIGHT_HTML_TITLE` set in the first reporter's `onEnd` reach the HTML report; setup attachments reach `onTestEnd` even when the setup then skips or fails | ✅ source + measured | `runner/index.js:5208–5220`, `:1642–1653`; lab probes |
| V54 | The Cucumber report has a fixed header, omits non-BDD projects, and is complete by the end of its `onEnd`; a banner inserted before `</body>` renders above its header | ✅ source + rendered | playwright-bdd `messagesBuilder/Meta.js`, `messagesBuilder/index.js`, `reporter/cucumber/index.js`; screenshots |
| V55 | Allure 3.18 shows `environment.properties` as front-page Metadata, and `--name` as the header; allure-playwright writes that file only when `environmentInfo` is set | ✅ source + rendered | allure-js-commons `ReporterRuntime.js:409–413`; screenshots |
| V56 | APVM's `JsBuildOutput` carries the full `commit` beside `commitShort`, and no digest | ✅ types | apvm-napi 3.0.0 `index.d.ts` |
| V57 | Two builds of one commit differ in bytes (`languages/backwpup.pot` regenerated; 1,070 mtimes): only a SHA-256 identifies the zip tested, and it costs 5–19 ms | ✅ measured | The main checkout's `pro@nginx` and `pro@apache` zips at `f1ebfd0`; checked with `shasum` |
| V58 | Site Health's copy text: one button by role and name; about 6.5 KB, 1.3–1.4 s after login; the values above; private fields omitted, paths included; the page's `directory-sizes` request can be aborted | ✅ live 2026-09-25 | `bwu2`, `bwu3` |
| V59 | On `bwu2`/`bwu3` the web runs PHP 8.5.10 and WP-CLI 8.3.33 (`/usr/bin/php8.3`): V28 holds | ✅ live | Site Health against `wp eval` |
| V60 | `onBegin`'s total includes the cell's setup tests whatever `--grep` says; `config.projects` holds every cell; a CLI `--reporter` replaces the configured list | ✅ measured | 0E probes |
| V61 | `onTestEnd` fires per attempt; the final one is `!willRetry \|\| interrupted`; an interrupted attempt reads `outcome() === "skipped"` | ✅ source + measured | `runner/index.js:1295–1297`; 22 attempts for 14 tests |
| V62 | Gherkin steps are `test.step`s; a hook's error sits on `BeforeEach Hooks`/`AfterEach Hooks`; a crash leaves no failing step; `TestStep.params` can carry `fill()` values | ✅ measured + docs | 0E probes; `testReporter.d.ts:880–905` |
| V63 | A failed setup gives the cell's scenarios no `onTestEnd` | ✅ measured | 0E probes |
| V64 | The JSON, JUnit, blob and playwright-bdd Cucumber reporters (NDJSON included) write only in `onEnd`; allure-playwright writes per attempt, with no final status or totals | ✅ source + measured | `runner/index.js:4064`, `:4292`, `:3087–3135`; playwright-bdd `reporter/cucumber/index.js:46–52` |
| V65 | A JSON-lines reporter streams every event within a reader's 200 ms poll, and leaves only complete lines after a SIGTERM | ✅ prototype | 0E runs |
| V66 | `test.id` is stable across runs of one cell and differs across cells | ✅ measured | 12 of 12 identical across two runs |
| V67 | A reporter that throws is caught, but flags the run: `result()` returns `failed` with no failed test | ✅ source + measured | `runner/index.js:1673–1679`, `:6290`; the 0A.2 deletion runs |
| V68 | A killed run's report folder has no `playwright/` and a 0-byte `cucumber/index.html` — the same as a run in progress | ✅ measured | 6 of 153 real runs |
| V69 | The retention planner decides every edge case, and its removal never follows a symlink; with 30 and 182 days it would remove 72 of 153 real runs (230 MB) | ✅ prototype + dry run | A synthetic tree; the main checkout's `reports/` |
| V70 | `bwu2`/`bwu3` match `bwu`/`simple` except in cron (and Imagify, Query Monitor, `bigFiles` on `bwu2`); healthcheck 7/7 on both | ✅ live 2026-09-24/25 | WP-CLI, nginx vhosts, `wp-config.php` constants, `du` |
| V71 | On a site without `DISABLE_WP_CRON` (`bwu2`) one plain WP-CLI command runs a due WP-Cron event within 4 s, while no outside traffic ran it in 20 s | ✅ live | A probe event, checked by processes that cannot spawn cron (`--exec` defines the constant for them) |
| V72 | While a job runs, BackWPup reschedules a `restart` event every 60 s; its Information page shows "Disabled WP Cron" | ✅ source | `inc/class-cron.php:23`; `inc/class-page-settings.php:270` |
| V73 | After an interrupt, a scenario's **remaining steps** keep running beside its After hook: its last step queried BackWPup after the teardown had removed the plugin, and that error became the scenario's in every report | ✅ live (L1) | The interrupted run's output; its Allure and Cucumber results |
| V74 | A SIGKILL of the run's process group mid-job leaves the plugin active, its whole footprint, both data folders and the staged zip; the cell's next normal run restores the site | ✅ live (L3) | `site-state` after the kill and after the next run |
| V75 | An interrupt landing inside the After hook, after the uninstall, leaves the plugin's data folders, and reports a scenario whose steps passed as interrupted; the worker's teardown still removes the staging area | ✅ live (L4) | `site-state` after it; the run's output |
| V76 | **Answers V11.** APVM's cache stays consistent after a build killed mid-way: seven build kills (SIGKILL, SIGTERM, SIGINT — in the clone, in composer, 71 ms after `build_succeeded`) and eight kills of a release's store at 0–30 ms left no row without its file nor file without its row, integrity `ok`, byte-identical re-warms, one entry at the end. Left behind: `.apvm-tmp-*` part-files in the cache, 65–782 MB work folders in `TMPDIR` | ✅ 2026-09-25 | Throwaway caches; runs K1–K8b, K6 ×8 |
| V77 | APVM's library reacts to no signal: SIGTERM or SIGINT ends the Node process within 4 ms and orphans its children (composer ran on 27 s, and about 120 s with a download); a SIGKILL of the build's process group leaves no survivor; work folders follow `TMPDIR` | ✅ | K2, K4, K5, K8b; K4, K5, K7, K8 |
| V78 | A kill during a private clone leaves the GitHub token in `<TMPDIR>/…/.git/config` (mode 0644, folders 0755), for good; once the clone completes the URL is clean | ✅ ×3 · ⏳ exposure on the Linux server | K1, K5, K7 |
| V79 | A git build's `commit` is the full SHA, equal to `resolvedRef.commitSha`; a release's is `release-<tag>`, with no `commitSha` | ✅ | `develop` at `f1ebfd0…` and `af1ab5c…`, matching GitHub's head; release 5.7.6 |
| V80 | V17 on apvm-napi 3.0.0 and the current suite: `commit:<sha>` and `release:<tag>` pins are cache hits (0.6–0.9 s, same SHA-256) that open no network connection; a cached `develop` warm opens `github.com` | ✅ | A logging CONNECT proxy |
| V81 | `.env` loads every key — unknown ones included, relative to the working directory — into the runner and every worker; blanking named keys blocks only those; failures are swallowed; `E2E_LOAD_DOTENV=false` (prototype) blocks everything | ✅ source + measured | `load-env.ts`; probes E1–E7, W1, W2 |
| V82 | `CI` counts as set for `"false"` and for whitespace | ✅ source + measured | `project.ts:24`; probes E5, E5b |
| V83 | A private product's run asks APVM for a token even when its build is a cache hit; the suite never sets APVM's cache folder | ✅ source | `resolve.ts:291–293`; `apvm.ts:42` |
| V84 | Importing `run-context.ts` — and so `resolve.ts` or `consume.ts` — loads `.env` and stamps `RUN_ID`; `products`, `warm`, `verify` and `sites` do neither; a product config's import runs `loadSites` and reads `BWP_*` | ✅ measured | An import-effects probe |
| V85 | One product list type-checks and its guard catches an unlisted product folder; today a misspelt `PRODUCT` silently runs WP Rocket | ✅ prototype + source | `tsc`, ESLint clean; 63 unit tests; `playwright.config.ts:15` |
| V86 | `BWP_*` are read when the product config is imported, in every process of a run (`bddgen`, the runner, each worker); `.env` reaches them only through `load-env` | ✅ measured + source | `backwpup.config.ts:24–40`, `:114`; `playwright.backwpup.config.ts:1`; per-process probe records |
| V87 | Nothing reads the product's `services` nor a site's `overrides`; the documented merge of the two is not implemented; no scenario uses storage credentials, and a missing one changes nothing | ✅ source + measured | Search of `src/`, `scripts/`, entry configs (only `sites.ts:329–356` validates them); `storage.sidebar.ts:23`; a run with none: exit 0 |
| V88 | With `E2E_LOAD_DOTENV=false` and a value in the environment, every process holds the environment's value or the default, the `.env` values nowhere; per-site `overrides` still load | ✅ prototype | Cases A(b)–A(d) |
| V89 | `E2E_LOAD_DOTENV` set inside `.env` is inert; a typo stops `bddgen`, naming the value; today's suite ignores the variable and mixes both sources | ✅ prototype + measured | Cases A(e)–A(g) |
| V90 | Node's `--env-file` on the runner's spawn reaches the runner and every worker | ✅ measured | Case A(h) |
| V91 | execa gives its children the whole `process.env`, so an environment-borne credential reaches local `wp` and docker children from either source; SSH forwards nothing | ✅ source | execa `lib/arguments/options.js:53`, `:92`; `exec.ts:240` |
| V92 | §2's first allowlist omitted `E2E_SITE_STAGING_DIR`, which the suite reads | ✅ source | `staging.ts:56`, `:108` |
| V93 | With the complete pin, `bddgen` rewrites only the pinned cell (10 of 10 of the other kept), `--list` holds 3 projects and 54 tests (unpinned: 6 and 108), the report goes to `<cell>/`, the workers equal its pool (2 with a 2-site pool), and `isCellTargeted` is true | ✅ prototype | Inode snapshots; `--list` comparison; probes |
| V94 | With the factory pinned but `selectedCells()` unchanged, the pin sizes workers but the artifacts setup drops `E2E_PLUGIN_*` as a serial run | ✅ prototype | Probe P4 |
| V95 | `bddgen` never receives `-- --project` (its argv is `--config …`); `E2E_CELL` reaches `bddgen`, the runner and every worker | ✅ measured | Probes P1, P3 |
| V96 | A `--project` disagreeing with the pin fails as Playwright's "Project(s) … not found" without naming `E2E_CELL`, also when the pin comes from `.env`; an unknown pin fails in `bddgen`, naming the cells | ✅ measured | `B3`, `B-envpin`, `B4` logs |
| V97 | Without the pin, the output is identical to today's (the `--project` form regenerates both cells; CI's smoke unchanged) | ✅ measured | 19 and 26 lines identical; inode snapshots |
| V98 | Two pinned runs of different cells started together: 0 of 20 failed | ✅ prototype (small sample; the mechanism is V93) | 10 iterations |
| V99 | The entry config is evaluated once per process, so the cell notice belongs in a runner-only reporter; the notice, conflict and unknown-pin messages print as shown in §3.1 | ✅ prototype | Probe P1; UX1–UX6 logs |
| V100 | The always-on stream changes nothing on the terminal: plain stdout 719 = 719 and stderr 25 = 25 lines; a TTY screen 936 = 936, two lines differing only in a duration's digits | ✅ measured | Paired runs, normalised |
| V101 | A stream write failure (EISDIR, EACCES) adds one stderr line above `Running …` and never changes the exit code | ✅ measured | Three runs, one passing (exit 0) |
| V102 | Today a run's end names only the Playwright report, and only with a TTY stdin, `CI` unset and a test run; logs and piped output name none | ✅ source + measured | `runner/index.js:3486–3503`; captured ends |
| V103 | Output order: first reporter's `onEnd`, the list's lines, last reporter's `onEnd`, first reporter's `onExit`, the HTML hint, last reporter's `onExit`; the same on pass, fail, failed setup and SIGINT; nothing on SIGTERM — so a summary listed last, printing in `onExit`, is the final block | ✅ measured + prototype | Marker reporters; summary runs |
| V104 | Reporters run in `--list` mode and for "No tests found" (0 tests); both leave a complete-looking report folder of about 1.5 MB | ✅ source + measured | `runner/index.js:5195–5253`, `:6308–6317` |
| V105 | The combined retention policy decides all 18 table cases; on disk, FIFO removes the oldest, killed runs count, symlinks are never followed, cell-level files are kept | ✅ prototype | `plan-cases.mts`, `tree-cases.mts` |
| V106 | Pruning at the end of a run: the oldest go, the new run counts and is protected, a failing run prunes, a SIGKILLed one does not, `_all` and other cells are untouched, 10 ms; pruning at the start instead cost a complete report to a run killed right after | ✅ prototype | End-of-run and start-of-run experiments |
| V107 | `E2E_REPORTS_KEEP` read with `intEnv(…, 20, 0, 10000)`: blank → 20, `0` → no cap, a bad value fails at start naming it | ✅ measured | Parse cases |
| V108 | A failed removal is reported and harmless to the exit code, but partial — `rmSync` had already deleted the run's `playwright/` | ✅ measured | A locked-folder run |
| V109 | On the main checkout's tree (165 runs, 711.5 MB): age-only removes 91 runs (468.3 MB); with the cap of 20, 109 (544.6 MB) | ✅ dry run 2026-09-28 | `real-dryrun.mts` |
