# Orchestrator Plan

> **Status:** concept agreed — tasks and runs, provided zips, builds, events, reports, controls (§2–§3);
> APVM additions filed upstream (Q1); stack decided (§3). **Phase 0 — make the suite ready
> (0A–0F) — investigated, not implemented**: findings and recommended solutions are in the
> [Phase 0 plan](orchestrator-phase-0-plan.md); it is implemented when approved. **Phase 0.5 — the
> minimal orchestrator — planned** in the [Phase 0.5 plan](orchestrator-phase-0.5-plan.md) (§7). Later
> phases are not planned yet.
> **Date:** 2026-09-24
> **Replaces:** §3.4 and Phase 9 of the [modernization plan](e2e-modernization-plan.md).
> **Name:** orchestrator — it lives in this repo, unlike today's separate AutoE2E tool. "AutoE2E" may
> still label some outputs (to define, §4).

---

## 1. What it is

A **long-running service** on one 24/7 Linux server that runs the suite's cells in the background and
lets people manage those runs. Personal machines don't run it: there, cells are run by hand
(`npm run test:<product> -- --project=<cell>`).

**What it replaces.** Today's AutoE2E ([`wp-media/auto-e2e`](https://github.com/wp-media/auto-e2e))
is a small Node tool: on one server, four Linux users each loop one instance of the legacy
`wp-rocket-e2e` (wp-rocket apache/nginx, backwpup-pro apache/nginx). It builds the plugin, drops the
zip where the legacy suite reads it, runs the suite, and reports every cycle to Slack and to Datator
(V23). Here the suite builds its own zips (`artifacts:<cell>`) and the orchestrator only pre-warms
them, so both share this repo.

- **One server, one orchestrator.** It runs any number of cells of any product at once, never the same
  cell twice (V1; two runs would share its sites' databases).
- **Dedicated sites.** Runs use the AutoE2E sites, which nothing else uses. The legacy AutoE2E runs on
  them today (e.g. `pro@apache`), so a cell moves over only once its legacy instance is stopped.
- **Real cells only.** Cells come from each product's sites files, as for a manual run;
  placeholder-only cells are skipped.
- **No health check.** `npm run healthcheck` is the operator's setup step. A site that breaks later
  fails its own run at the preflight (`setup:<cell>`), with the reason.
- **CI neither uses it nor runs real cells** (modernization Phase 8 dropped). Real-cell runs happen
  here, PRs included — `run --ref` now, `watch` tasks later; CI keeps its quality, unit and smoke jobs.
- **Not configured by the suite's env.** The orchestrator never reads `E2E_*` vars; a run's plugin
  settings come only from its task (§2).
- **APVM through its Node library only**, never its CLI — a rule for the whole repo (CLAUDE.md).
- **Lives in `orchestrator/`** at the repo root, apart from the test projects. It reuses suite modules
  (`warmArtifacts`, sites loading, the identity check); every change the suite needs is in Phase 0.

## 2. Tasks and runs

A **task** says what to run and when, and runs many times. Each execution is a **run**: one Playwright
invocation of the task's run unit (product × cell). Not "job": that is BackWPup's backup job, which
this suite tests and discusses constantly. Not "run unit": that already names product × cell.

**Task**

| Field | Notes |
| --- | --- |
| `id` | 4 chars: lowercase letters and digits without look-alikes (`0 o 1 l i`), starting with a letter — e.g. `k7qx`. Redrawn on a clash; `node:crypto`, no dependency. |
| `type` | `scheduled` (tentative default): once at a time, hourly, every *N* hours, daily, every *N* days, weekly… · `loop`: again after a cooldown (e.g. 5 min) once a run ends · `on-demand`: once, now · `watch`: runs when a watched ref gets a new commit, a PR opens or a release ships — deferred (it was `event`, a word Events below now owns). |
| `product`, `cell` | The run unit. One cell per task — it maps 1:1 onto logs, reports and the one-run-per-cell rule; "several cells" is a shortcut that creates several tasks. |
| `plugin` | For the `plugin` role (and `previous`, for products that test an update path): an APVM ref with the version where the product needs one — default the product's — **or a provided zip** (below). |
| extras | A name, paused, a test filter (tags / `--grep`). |

**Provided zips** — for a build devs hand over, with no commit behind it.

- A zip goes wherever a ref can: on a task (every run tests it) or on one run
  (`run <task> --zip <file>`; the task's next runs test its own plugin again).
- The dashboard uploads it; the command takes a file already on the server. The orchestrator keeps
  its own copy, named by its SHA-256, so the same zip is stored once and a run can always be repeated
  with exactly what it tested.
- It is checked on arrival with the suite's own identity check (`verifyArtifact` against the cell's
  `resolveIdentity`: top-level slug and `Plugin Name:` header), so a Free zip can't land on a Pro cell,
  nor another product's; its version is read from its header.
- Nothing to build: the build step skips it, as `warmArtifacts` already does, and the run receives it
  as `E2E_PLUGIN_ZIP` — an absolute path outside `.artifacts/`, which the suite requires (V24).
- A zip run records the zip's name, SHA-256 and header version where a built run records its commit;
  reports and events show the same. The suite records no digest for a zip yet (V22; Phase 0D.2).
- A zip is kept while a task uses it or a kept report refers to it.

**A busy cell:** a scheduled slot that finds the task's own previous run still going is skipped and
recorded; anything else queues — behind another task's run, or a manual run behind its task's own.

**Run once.** `run <task> --ref <ref>` or `--zip <file>`, optionally `--name "<name>"` (in the
dashboard: "Run once…" on the task, pre-filled), runs the task once, now, changing only what you
pass. The task itself is untouched, so nothing needs stopping, editing or reverting, and its next
runs test its own plugin again. The name labels that run in its history, reports and events; without
one it is the task's name. A busy cell makes it wait its turn — stop the current run to go first. It
shows in the task's history like any run, labeled with its ref and commit or its zip (as GitHub
Actions lists manual runs beside scheduled ones). With no task on the cell,
`run <product>/<cell> --ref <ref>` (or `--zip`) creates an on-demand one. To change every following
run, edit the task.

**Task status.** `active`, `paused`, or `done` (a one-off that has run). An active task is idle until
its next trigger, queued, running, or cooling down (loop), and shows its last result and next run.

**Groups** — tasks that fire as one. **First version: `rotate` only** — each firing runs the next task
in turn, then back to the first (e.g. `pro@nginx` one day, `free@nginx` the next); other modes are
deferred (§4). A group has what a task has for firing — an id (same id space as tasks), a name, a
type, paused, a status — plus an ordered list of tasks. Each task keeps its own settings. A task is in
at most one group, and while there its own trigger is suspended (restored if it leaves).

- **Like one task.** A firing lasts until its run has ended. A slot that finds the previous firing,
  or the run of the task whose turn it is, still going is skipped and recorded, and **the turn doesn't
  advance**: the next slot runs the skipped task, so skips never break the rotation. A cell busy with
  some other task's run makes the group's run queue, like any run.
- **The turn advances** when a firing launches its run, whatever the result, so a broken task can't
  stall the others. Paused members are passed over; a manual `run` of a member isn't its turn.
- `run <group>` fires the group once, now. Cells that share a host (0A.3) never run at once in a
  group.

**Run status**

| Status | Meaning |
| --- | --- |
| `queued` | Waiting to start, with the reason shown: its build (under way since the run was created; a cold one takes minutes, V9), its cell, a free slot, or a loop's cooldown. |
| `running` | With live progress: done / total, failures so far. |
| `stopping` | A graceful stop is under way. |
| `passed` · `flaky` · `failed` | `flaky`: passed only on retry. |
| `error` | Could not test — its build failed (Builds, below), the preflight or login failed, or the process died — so a broken branch or site never reads as a regression. |
| `stopped` · `killed` | By request, graceful or hard; a hard kill can leave the site dirty until the next run (0C). |

**A run records** its task, name, trigger, times and status; the plugin it was given — a ref, or a
zip's name and SHA-256 — and what it actually tested: the full commit (a ref like `develop` moves) or
the zip's header version, plus the site's own WordPress and PHP versions (V28); its output and its
reports. Its id is `<task>-<n>` (`k7qx-12`), and its `RUN_ID` is `<timestamp>-<run id>`, so the
report dir names its run and still sorts by time.

**Builds — the orchestrator builds; a run never does**

- **Build first.** A run's build starts the moment the run is created, in the orchestrator's own
  process, planned by the suite's request builder (`warmArtifacts`; the parity invariant). The run
  starts only once its build is in APVM's cache. A loop's next run is created as its last one ends,
  so its build overlaps the cooldown. A zip run has nothing to build.
- **One build per artifact.** Runs needing the same build share the one under way.
- **Pinned commit.** The run is handed the exact commit its build resolved (`develop` or a PR may move
  meanwhile), so its `artifacts:<cell>` step only copies from the cache (V17), and the run records
  what it really tested. The age-based cache clean (§3) never removes what a run is about to use:
  its build step has just used it (V18).
- **Place kept.** A run holds its place in its cell's line while it builds; if the cell frees first,
  the cell waits for it rather than let a later run jump ahead. E.g. `run k7qx --ref pr:123` while
  `k7qx` is at scenario 51/52: the PR builds meanwhile; if 52 ends first, the cell waits, runs the
  PR, then the loop resumes.
- **Side by side.** Different builds may run at once (APVM supports it within one process), capped so
  they don't starve running tests.
- **Failures.** A failed build ends every run waiting on it as `error`, with APVM's reason and the
  tail of its output (secrets redacted, as the suite's APVM wrapper already does) — in the run's log
  and status, its task's last result, the dashboard, the events and the orchestrator's log. No
  automatic retry (the task's next trigger or a `run` retries), and a loop backs off after `error`
  runs — its cooldown doubles, capped, and a run that tests resets it — so a broken branch or a down
  site isn't retried every few minutes. A GitHub outage surfaces the same way (V21).
- **No cancel.** APVM can neither cancel nor time out a build (V15, V27): a stopped run's build still
  finishes into the cache, and a hung one can't be cut short (Q1a).

**Output and logs**

- **Run output** — its build step, then the Playwright invocation's stdout/stderr — goes to one log per
  run and streams live: follow it while the run goes (`logs -f`, the dashboard), read it after.
- **The orchestrator's own log** — triggers, queue, starts, stops, errors.
- **Live progress** comes from the suite's results stream (Phase 0E); live counts and `run.finished`
  (Events) are both built from it. It pairs with modernization Phase 7's progress output.
- Tasks, groups (with whose turn it is), run records, logs and provided zips live in one state
  directory, so a restart loses nothing.

**Reports**

- **Listed** by task, run (scheduled or one-off), cell, product, status and date — in the command
  and the dashboard.
- **Say what they tested, up front** — product, cell, edition, run id and name, the plugin (ref and
  full commit, or zip name and SHA-256) and version, the site's WordPress and PHP versions — in every
  report: Playwright HTML, Cucumber and Allure. Today only the artifacts setup's attachment carries the
  ref and a short commit, in two of the three, and a zip carries no digest (V22): Phase 0D.
- **Opened from the dashboard** directly, behind its login: Playwright HTML with its trace viewer,
  Cucumber, and Allure, generated when the run ends. The command prints their paths.
- **Kept for a while, then removed** (§3 Report retention); any report can also be removed by hand.

**Events** — the orchestrator announces what happens, and any part of it can subscribe.

- **The events:** a run queued, started and finished; a build started, finished and failed; a task or
  group created, changed or removed; a new suite version found, an update started, finished and failed
  (§3 Updating the suite); the orchestrator started and stopping.
- **`run.finished`** fires once per run, whatever the outcome (`error`, `stopped` and `killed`
  included), carrying everything about it: task, run id and name, trigger; product, cell, edition; the
  plugin (ref and commit, or zip name and SHA-256) and version; the site's WordPress and PHP versions;
  status, times, duration; counts (total, passed, failed, flaky, skipped); every scenario with its
  feature, status and, for a failure, the first failing step's message; and where the reports are
  (path on the server, dashboard link). That covers what AutoE2E sends today (V23).
- **Subscribers** are modules inside the orchestrator. Each picks its events and can be scoped to
  tasks, groups or products. One stream feeds them all — the dashboard's live view, the command's
  `watch`, notifications — and later external tools (§3 API).
- **A subscriber never holds up a run**: a slow or failing one is timed out and logged, and no run's
  status depends on it.
- **Slack** — one message per run, like AutoE2E: outcome, counts, failed scenarios, the cell (what
  AutoE2E took from `AUTO_E2E_INSTANCE_NAME`), product, plugin (ref and commit, or zip), the site's
  WordPress and PHP versions (not WP-CLI's, which AutoE2E reports and which is wrong on both nginx
  cells, V28), the report's path and dashboard link. Through an incoming webhook, as AutoE2E does
  (V23).
- **Datator** — each run's results, as AutoE2E posts them (V23): product, cell (AutoE2E's
  `test_suite`), start time, counts, commit (none for a zip run), duration, and every scenario's
  feature, name, status and first error.
- **Secrets** — webhook URLs, API keys — live in the orchestrator's own config, never in the repo,
  and are masked in the API, the dashboard and the logs.

## 3. Planned

**Stack** — decided 2026-10-05.

| Layer | Choice | Why |
| --- | --- | --- |
| Host | A **separate runner server**, reaching the sites over SSH (the suite's `ssh` transport) | Keeps browsers and builds off the WordPress servers. How many instances share it is Q2. |
| Language | TypeScript on Node 24, run with `tsx` | The suite's 518 extension-less relative imports don't resolve under Node's own type stripping (V110); `tsx` already runs `healthcheck`. |
| State | SQLite through `node:sqlite`, one file in the state directory; plain SQL, numbered migrations, no ORM | Built in, no native addon; "Release candidate" in Node 24.21, no warning (V111). `better-sqlite3` is the fallback behind the same repository layer. |
| API | Hono + `@hono/node-server`: one app on a Unix socket (command) and on HTTP (dashboard) | Its typed client (`hc`) gives both clients the server's types — parity by construction; SSE and static serving built in (V112). |
| Validation | zod 4 | One schema per input — task, config, API body — typing server, command and dashboard alike. |
| Command | commander, colour through `node:util` `styleText` | ~40 subcommands are too many for `parseArgs`. |
| Scheduling | croner for calendar triggers; our own timer for loops and cooldowns | Time zones and DST handled for calendar triggers; loop timing is a small pure function. |
| Run supervision | `node:child_process` `spawn` with `detached` (own process group) | Phase 0C signals the **group** (stop file, one SIGINT, then SIGKILL; never SIGTERM); execa's `kill()` signals one pid. |
| Logs | pino for the orchestrator's log (its `redact` masks secrets); plain text per run | |
| Dashboard | React + Vite + Tailwind + shadcn/ui, built to static files the orchestrator serves | One process and one origin: the API, the dashboard and the reports share it. |
| Auth | `node:crypto` (scrypt passwords, hashed scoped API tokens); no login on the loopback listener (SSH tunnel); a login and session cookie only on a separate listener for other modes (the dashboard, below); TLS, when off a private network, from a reverse proxy | No auth dependency. Only the SSH tunnel is a confirmed way in (VPN, Tailscale unconfirmed). |
| Tests | The repo's unit runner (`*.spec.ts`); Playwright for the dashboard later | Same conventions as the suite. |

Versions are taken at implementation time (2026-10-05: hono 4.13, @hono/node-server 2.1, zod 4.6,
commander 15, croner 10, pino 10, react 19.3, vite 8.3, tailwindcss 4.3).

- **systemd keeps the orchestrator alive.** It is already on the server (PM2's own boot start is a
  systemd unit it generates, V14), and it tracks every process the orchestrator starts, so no run
  outlives a crash unseen. `KillMode=mixed` sends the stop signal to the orchestrator alone, which
  then stops its runs gracefully (0C); systemd SIGKILLs what is left after `TimeoutStopSec` (V13).
- **One instance at a time**, plus an optional cap on concurrent runs (each run already uses
  `pool.length` workers).
- **The command** — on the server only, over SSH: tasks (add, edit, pause, resume, remove, run once),
  groups (the same, plus add, move, remove and reorder their tasks), runs (list, status, logs and
  live output, results, stop, kill), reports (list, paths, remove), provided zips (add, list,
  remove), notifications (list, send a test), cells (busy or free, and their tasks), the orchestrator
  itself (status, stop), and a `watch` view.
- **The dashboard** — the same features in a polished web UI, plus opening reports and uploading zips.
  Bind: local only (reached over an SSH tunnel), local network (VPN, Tailscale), or remote. Only the
  **SSH tunnel is confirmed** (2026-10-05), so it is the default and the mode built first; VPN and
  Tailscale are unconfirmed. Off a private network it requires TLS — reports and traces carry site
  passwords. Over the tunnel (`ssh -L 8080:127.0.0.1:<port> runner`, then `http://localhost:8080`):
  - **Bind `127.0.0.1`** on the runner, and name `127.0.0.1` in `-L` — `localhost` there may resolve
    to `::1`.
  - **No login** (decided 2026-10-05): reaching the runner's loopback — an SSH login, or an account
    on the runner — is the access control.
  - **Decided by listener, never by client address.** The loopback listener has no login; any other
    mode is a **separate** listener that always requires it. A reverse proxy on the runner connects
    from `127.0.0.1` too, so "no login from 127.0.0.1" would wave every remote visitor through; it
    must point at the authenticated listener.
  - **`Origin` and `Host` are checked**, since no cookie stands in the way: any web page the user
    has open can send a request to `http://localhost:8080`. Every state-changing request needs an
    `Origin` equal to its own origin (plain form posts included), and `Host` must be `localhost`,
    `127.0.0.1` or `[::1]` on any port (the local port is the user's) — against DNS rebinding.
  - **When a login exists** (the authenticated listener), its cookie is `Secure` only on HTTPS:
    WebKit (Safari) drops a `Secure` cookie on `http://localhost`; Chromium and Firefox keep it
    (V113). Always `HttpOnly`, `SameSite=Strict`, a name of our own.
  - **Relative links only** inside the dashboard, so any local port works; links sent out (Slack,
    events) use a configured `dashboardUrl`, defaulting to the documented tunnel's
    `http://localhost:8080`.
  - **SSE** passes through the tunnel unchanged; a comment line every ~15 s keeps idle streams alive.
- **Parity** between the command and the dashboard: whatever one offers, the other does too, unless it
  makes no sense there — viewing an HTML report is the dashboard's; the command prints its path.
- **One API behind both** — the command over a local socket, the dashboard over HTTP — so their
  features match by construction. **It is also the door for external tools**, e.g. from our own
  machines: versioned from the start, each client with its own token and scopes (read-only or
  control), TLS off a private network, every control action audited, and the event stream exposed
  through it. No external client is planned yet; adding one needs no redesign.
- **One report per run, never merged** (modernization D4).
- **Report retention.** On a schedule, the orchestrator removes reports older than *X* — configurable,
  default **30 days** — with their logs and any zip only they referred to. Each task's newest report
  outlives *X*, but only up to *Y* — configurable, default **6 months** — and any report can be removed
  by hand (command, dashboard). A run's summary record stays (it is small), so history and trends
  survive. The same pruning runs by hand on a dev machine, per cell (Phase 0F).
- **Updating the suite** — decided 2026-10-05: **stop, update, resume**. One checkout serves every
  cell, and a run reads its files while it runs (`bddgen`, step files, `node_modules`), so nothing is
  updated under a running cell. Until this exists, the suite is updated by hand while the orchestrator
  is stopped (Phase 0.5, D3).
  - **A new version is announced.** The orchestrator checks the suite's branch (default `develop`) for
    a new commit; the dashboard and the command warn about it, naming the current and the new commit,
    and an event fires.
  - **Auto-update**, a setting: when on, a new commit is applied by itself — no new run starts, the
    running ones finish, then the update, then everything resumes.
  - **Update now** — a dashboard button, or the command — first says that every run will be stopped,
    and asks: **y/N** in the command, a **Continue / Cancel** modal in the dashboard. On confirming,
    every run stops gracefully (0C), the update runs, and everything resumes.
  - **Scheduled update** — *deferred*: a third choice in the same prompt, "at 04:00 UTC" (the time
    configurable), stopping everything then and updating. The first version offers y/N and
    Continue / Cancel only.
  - **The update**: a fast-forward pull of the branch, then `npm ci` (its `postinstall` also installs
    the matching Chromium), then the orchestrator restarts, since its own code lives in the checkout.
  - **To iterate**: how often to check, auto-update's default, a failed pull or install, the command's
    name, and what the y/N does without a terminal.
- **APVM cache retention** — *deferred until APVM's Node library can clean (Q1c; being planned in APVM, for a 3.3.0)*.
  The orchestrator will periodically remove cache entries unused for longer than *X* — configurable,
  default **10 days** — and log what it removed. Every cache hit refreshes an entry's last use (V18),
  so anything a task still builds stays. APVM's CLI can already clean, but this project never uses
  the CLI (CLAUDE.md), so it waits for the library.
- **Later optimization — one APVM build for Free and Pro.** When a Free and a Pro cell resolve the
  same ref and version (the default: both `develop`), warm both in one call instead of cloning and
  installing the same commit twice: group the warm's deduped requests on
  `{project, gitRef, version}` and union their `variants` (APVM's `free`/`pro-en`, not our
  editions). `buildArtifactPlan` already knows every cell's request up front and the warm already
  dedupes on it, so only the warmer changes; each cell's single-variant `build()` then hits the
  cache (V10). Measure the saving when implementing.

## 4. To explore

- **More group modes**, deferred from the first version: `sequence` — every task, one after another,
  each firing (their builds overlap; a failure doesn't stop the rest); `parallel` — every task at once.
- **Stream the headless browser's screen** through the dashboard.
- **`watch` tasks** (deferred): a new commit, PR or release — e.g. a GitHub webhook.
- **Zips from a link** (e.g. a CI artifact URL) instead of an upload.
- **Mark a site as in use** (e.g. with a support plugin), checked by the preflight: a safety net across
  machines. Needs an atomic take, an owner, an expiry (a crashed run must not lock a site forever), a
  release, and a preflight message naming the owner.
- **Run the orchestrator in a container** (e.g. the Playwright image: pinned browser and system
  packages, deterministic `@visual` rendering).
- **Retention of Allure history** (reports, run logs and APVM's cache are planned, §3).
- **Where "AutoE2E" appears** (outputs, dashboard).

## 5. Open questions

| # | Question | Notes |
| --- | --- | --- |
| Q1 | APVM additions (ours) | (a) **Cancel / timeout** for a build — it has neither (V15, V27): [APVM #2](https://github.com/wp-media/automation-plugin-version-manager/issues/2). (b) **Coordinate identical builds**: two processes that both miss the cache both build in full; the store itself is already locked and atomic (V25, V26): [APVM #3](https://github.com/wp-media/automation-plugin-version-manager/issues/3). (c) **Cache clean in the Node library** — not there even in 3.2.0 (V19); being planned in APVM for a 3.3.0, which cache retention waits for (§3): expose the storage crate's `ArtifactStore::clean` (e.g. `cleanCache({ olderThan, project, target, dryRun })` returning its `CleanReport`), so builds and cleaning share one dependency, one version and one cache handle. `apvm-napi` is updated only once that release is tagged. |
| Q2 | Instances on the runner server | One orchestrator instance per WordPress server (nginx, apache): do both run on the one runner server (two state directories, two systemd units, a combined cap on browsers), or on one runner each? Decide before the service is built. |

## 6. Phase 0 — Make the suite ready (investigated; implemented when approved)

Each item's verified findings, recommended solution and alternatives are in the
[Phase 0 plan](orchestrator-phase-0-plan.md); this section keeps the list.

The orchestrator relies on the suite behaving under it, so this comes first. **Done when** every item
is implemented — or, where the suite needs no change, its solution is decided and recorded here —
verified live where possible, with its evidence in §8.

**0A — Running side by side**

- **0A.1 — `bddgen` rewrites every cell's specs.** `bddgen --config <product>` generates all cells of
  the product, deleting each cell's spec files before rewriting them (V2). A run that starts while
  another cell of the same product runs rewrites that cell's specs under it. Two manual runs hit
  this today.
- **0A.2 — the root `test-results/` is shared.** A run deletes the output folder of every project it
  *selects* (V3). Cell projects use `test-results/<product>/<cell>/`, but both setup projects
  (`src/common/config/project.ts:136`, `:145`) and `playwright.unit.config.ts` default to the root,
  so `npm run test:unit`, a run without `--project`, or `--project=artifacts:<cell>` deletes the
  traces and videos of every running cell. Low risk for the orchestrator (it only runs
  `--project=<cell>`), real on any shared machine.
- **0A.3 — cells that share a server.** Side-by-side runs on one host share its CPU, disk, MySQL and
  PHP-FPM, and backups are disk-heavy. There are two WordPress servers: the nginx one holds the dev
  cells (V4) and AutoE2E's two nginx cells, the apache one AutoE2E's two apache cells (V5). "One
  server, one orchestrator" means one orchestrator *instance* per machine: cells on different sites of
  one server may run at once — the operator's estimate is that up to about four parallel suites per
  server are fine. Files backups of the dev sites with `bigFiles` are about 3 GB each (phase-6 V50), so
  disk still binds. The orchestrator **never limits runs per server** — the user decides — but
  **warns** (command, dashboard, events) once a server reaches its threshold of running cells:
  default 4, configurable (decided 2026-10-05). Measure it (V6) to tune that default — a group already
  keeps cells apart (§2 Groups). Also re-check the artifact plan's
  deferred remedy for sites sharing an absolute staging root (its §2.8 case 22).
- **0A.4 — two runs on one site.** Only the orchestrator uses the AutoE2E sites (§1), so its own guard
  suffices for now: never two runs of one cell, and no site listed by two cells of any product (the
  sites loader only rejects a cell *name* defined twice). The cross-machine mark is deferred (§4).
- **0A.5 — APVM's cache under concurrent processes.** Writes are safe — `StoreLock` serializes them
  and they are atomic (V25) — but nothing coordinates identical builds: two processes that both miss
  the cache both build in full (V26; Q1b). Under the orchestrator only its own process builds
  (§2 Builds), yet each run's `artifacts:<cell>` step still reads the cache from its own process, and
  two manual runs in two terminals still build side by side. What a build killed mid-way leaves
  behind is untested (V11).

**0B — What a run is given**

- **0B.1 — a run's `E2E_*` settings.** They must come only from its task (§1), but the suite also
  loads the repo's `.env`, which fills any var a run leaves unset. So each run's env sets every
  `E2E_*` var, blank meaning the product's default — a blank var does keep `.env` out (V12).
  **Superseded, done 2026-10-08:** blanking misses unknown keys, so the run gets
  `E2E_LOAD_DOTENV=false` and an allowlisted environment instead — Phase 0 plan §4.1.
- **0B.2 — the build step hands back the commit it built.** It plans each run alone, with that run's
  env, so `warmArtifacts`' one env per call is no obstacle; but it doesn't return the commit
  (`WarmOne` returns only `fromCache`), which pinning needs (§2 Builds; V16).
- **0B.3 — one product list.** `healthcheck.ts:53`, `warm-artifacts.ts:30` and `playwright.config.ts`
  each hard-code the products; the orchestrator would add another. Make it one list, outside
  `src/common` (which must not import product code).

**0C — Stopping a run.** A kill mid-scenario skips the `@plugin` After hook, so the plugin stays
installed until the next run's Before hook removes it; killing only the Playwright parent leaves its
worker alive to finish the teardown (V7). Check how Playwright handles SIGINT/SIGTERM (V8), then
define stop (graceful), kill (hard), and what runs do when the orchestrator stops or crashes (§3).

**0D — Reports say what they tested** (§2 Reports)

- **0D.1 — up front in every report** — Playwright HTML, Cucumber and Allure: product, cell, edition,
  run id and name, the plugin and its version, the site's WordPress and PHP versions (0D.3). Today
  only the artifacts setup's attachment has the ref and commit, in two of the three (V22).
- **0D.2 — the full commit, and a zip's SHA-256,** in the resolution the reports are built from
  (today: `commitShort`, and no digest — V22).
- **0D.3 — the site's own versions**, read once per run from Site Health → Info (the "Copy site info"
  text: `php_version`, `php_sapi`, `httpd_software`, WordPress and database versions) in the auth
  setup, which is already logged in. Never WP-CLI's PHP: it differs on both nginx cells (V28).

**0E — Machine-readable results.** A stream of each scenario's result — feature, name, tags, status,
retries, duration, first failing step's message — and the final totals, for live progress and
`run.finished` (§2 Output and logs, Events), from a small reporter in the suite, always on (decided:
the Phase 0 plan's P4), writing JSON lines.

**0F — Report pruning.** The pruning module the orchestrator's retention uses (§3), plus
`npm run report:prune` for dev machines: age-based, each cell's newest report kept up to the cap.

## 7. Phase 0.5 — The minimal orchestrator (planned)

Detailed in the [Phase 0.5 plan](orchestrator-phase-0.5-plan.md): verified findings, the design, the
its decisions (D1–D6, all taken), rows V114–V127. It comes after Phase 0, which it relies on (all but 0B.2),
and before Phase 1.

The smallest orchestrator that replaces AutoE2E's BackWPup instances: one foreground command,
`npm run orchestrator -- start`, kept in `tmux`, that **cycles** one or more cells — `loop` tasks only
— from a fixed JSON config. Each run builds its own plugin through the suite (no warm, no pin), runs
under Phase 0's run contract and stops through 0C's drain. One event, `run.finished` (this plan's §2
payload), reaches two subscribers: Slack, one message per run, and Datator, AutoE2E's payload for runs
that tested. Everything here is the first version of a piece §2–§3 plan, in the shape later phases
extend: the task fields, run ids, the event, the run contract, the stop. Out: systemd, the API, the
dashboard, other task types, groups, provided zips, the orchestrator's own builds.

## 8. Verification

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| V1 | `parallelIndex` is global per invocation, so one cell per run | ✅ | Playwright docs + maintainers (microsoft/playwright#38953); guarded in `project.ts` (modernization §3.2). Rechecked in 1.63.0's `TestInfo.parallelIndex` docs: `0` to `workers - 1`, never shared by workers running at once |
| V2 | `bddgen` regenerates every cell of a product, deleting before writing | ✅ source + measured; its effect on running cells measured in the Phase 0 plan (V29, V30) | playwright-bdd 9.2.1, as in 9.2.0: `dist/cli/commands/test.js` generates every registered config, the first in the main thread and the rest in parallel worker threads; `dist/generate/index.js:36` `clearOutputDir()` (`rm` of every `*.spec.js` in the cell's output dir), then `:37` `saveFiles()`. Measured 2026-09-24: one `bddgen --config playwright.backwpup.config.ts` gave all 10 specs of both cells new inodes (deleted, then written); the folder of a cell no longer registered was left alone |
| V3 | A run clears only its *selected* projects' output dirs; the setup projects and the unit config use the root `test-results/` | ✅ source + measured | Playwright 1.63.0, as in 1.62.1: `lib/runner/index.js` `createRemoveOutputDirsTask` removes each of `filteredProjects`' output dirs; `filterProjects` returns the projects named (wildcards allowed), never their dependencies, and every project without `--project`; `preserveOutputDir` is set only by the test server's `runTests` (UI and watch mode), never by the CLI. None of those configs sets `outputDir` (`project.ts:136`, `:145`; `playwright.unit.config.ts`). Measured 2026-09-24 with marker files: `--project=<cell>` deleted only its own folder; the unit config, `--project=artifacts:<cell>` and a run without `--project` each deleted all of `test-results/`, other products' cells included |
| V4 | The dev cells `pro@nginx` and `free@nginx` share one host | ✅ | `src/projects/backwpup/config/sites.json`. Orchestrator development runs the same two cells on two more sites of that host, `bwu2.e2e…` (Free) and `bwu3.e2e…` (Pro): four BackWPup docroots (3.6, 2.6, 0.16 and 2.9 GB) on a volume 84 % full with 17 GB free (2026-09-24; phase-6 V72 had 20 GB) |
| V5 | Which AutoE2E cells share a host | ✅ 2026-09-28 (the operator) | Two WordPress servers: `backwpup@nginx` and `wp-rocket@nginx` on the nginx one, `backwpup@apache` and `wp-rocket@apache` on the apache one. Site details on request, later |
| V6 | Side-by-side runs on one host stay reliable | ⏳ measure | 0A.3 — allowed up to about four parallel suites per server (the operator, 2026-09-28) |
| V7 | A mid-scenario kill leaves the plugin installed and the next run recovers; killing only the Playwright parent lets the worker finish teardown | ✅ live (`pro@apache`, `pro@nginx`) | Phase 6 plan V53, V61 |
| V8 | What Playwright runs on SIGINT/SIGTERM (After hooks, fixture teardown), and on a second signal | ✅ source + lab + live | Phase 0 plan V40–V47, V51, V73–V75 |
| V9 | A cold BackWPup build takes minutes: 13.7 min once, 5.4 min for `pro-en` alone | ✅ measured | an earlier real build; 2026-09-23, `develop` @ `f1ebfd0`, twice (V17, V20) |
| V10 | A multi-variant warm serves each cell's single-variant `build()` from cache | ✅ 2026-07-28 | real cache: per-variant zips side by side under `<project>/commits/<version>/<commit>/`; APVM's `origin` reports partial builds |
| V11 | APVM's cache stays consistent after a build killed mid-way | ✅ 2026-09-25 (Phase 0 plan V76–V78) | Concurrent writers are covered by V25–V26 |
| V12 | A blank `E2E_*` var in a run's env keeps the `.env` value out and reads as "product default" | ✅ Node 24.21 | `process.loadEnvFile()` fills only missing keys (blank stays `""`, unset takes `.env`'s value); `readArtifactEnv` reads `""` as unset |
| V13 | systemd `KillMode=mixed`: the stop signal goes to the main process only; the kill stage signals the whole cgroup | ✅ source | systemd `unit_kill_context()` (via Context7) |
| V14 | PM2 stops with SIGINT, then SIGKILL after 1.6 s by default; `pm2 startup` generates a systemd unit | ✅ docs | pm2.keymetrics.io (via Context7) |
| V15 | APVM's `build()` / `warmCache()` take no cancel, abort, signal or timeout option | ✅ | `apvm-napi` `index.d.ts` (3.0.0; byte-identical in 3.2.0, V19) |
| V16 | `warmCache()` returns the commit it built, and a later `build()` of the same ref is a cache hit; the suite's `WarmOne` passes on only `fromCache` | ✅ docs + code | `index.d.ts` (`JsBuildOutput.commit`, `fromCache`); `src/common/artifacts/warm.ts` |
| V17 | A `commit:<sha>` build is served from the cache a warm of a moving ref (`develop`, `pr:N`) filled at that commit | ✅ 2026-09-23 | Throwaway cache: a `develop` warm built `f1ebfd0` from scratch (325 s); `commit:f1ebfd0…`, planned by the suite from `E2E_PLUGIN_REF`, then came from the cache in 0.9 s — `fromCache: true`, origin `cache`, the same zip, no clone, no build |
| V18 | A cache hit through the Node library refreshes an entry's last use, so `cache clean --older-than` keeps it | ✅ 2026-09-23 | Same cache: after 75 s unused, `cache clean --older-than 1m --dry-run` listed the build; right after one library cache hit it listed none. The CLI (3.2.0) read the cache the library (3.0.0) wrote, and the library kept working after. The storage crate documents it too: `CleanOptions.older_than` spares "recently hit cache entries" (V19) |
| V19 | The Node library has no cache clean, in 3.0.0 or 3.2.0 (the latest); the CLI's `cache clean --older-than <d>` removes entries not used within the window (units `m h d w`; `--dry-run`, `--project`, `--builds` / `--releases`) | ✅ 2026-09-23 | Both versions installed and loaded: identical runtime exports, byte-identical `index.d.ts` (same git blob), `crates/napi` unchanged but `error.rs`. Cleaning lives in the Rust storage crate — `ArtifactStore::clean(CleanOptions { project, older_than, target, dry_run }) → CleanReport { builds_deleted, releases_deleted, bytes_freed, failures }`, plus `usage`, `gc`, `verify`, `repair` — which only the CLI calls. `apvm cache clean --help` (3.2.0) |
| V20 | A plain `build()` through the Node library fills the cache by itself — no `warmCache`, no CLI | ✅ 2026-09-23 | Throwaway cache, the same `build()` twice: `release:latest-stable` (5.7.6) downloaded, then from cache in 0.48 s; `develop` @ `f1ebfd0` built in 324 s, then from cache in 1.0 s |
| V21 | A build that can't reach GitHub throws `GenericFailure` carrying git's own message | ✅ observed 2026-09-23 | `git clone` / `git ls-remote` failed after the 75 s connect timeout: one GitHub address (`140.82.114.4`) was unreachable from the runner |
| V22 | Reports record the ref and commit only inside the artifacts setup's `artifacts-resolution.json` attachment — in the Playwright HTML and Allure reports, not the Cucumber one — with the short commit; a provided zip gets no digest | ✅ 2026-09-24 | Real `pro@nginx` / `free@nginx` reports: attachment present in Allure results and in the Playwright report's embedded data, absent from `cucumber/index.html`; the HTML report's top-level metadata holds only `actualWorkers`; `resolve.ts:324` records `output.commitShort`; `ResolvedArtifact` has no digest field |
| V23 | AutoE2E posts one Slack message per cycle through an incoming webhook — ✅/❌, counts, failed "Feature - Scenario" names, `WordPress: x \| PHP: y` (WP-CLI over SSH: `wp core version`, `wp eval "echo PHP_VERSION;"`), an `scp` command for the Cucumber HTML, an optional `AUTO_E2E_INSTANCE_NAME` prefix, and "❌ Auto E2E Script Error!" when a cycle crashes — and posts each run to Datator (`X-API-Key`: product, suite, start time, counts, full commit, duration, per test feature / name / status / error) | ✅ source | [`wp-media/auto-e2e`](https://github.com/wp-media/auto-e2e) @ `be4ed43`: `auto-e2e.js` (`sendSlackMessage`, `getSiteVersions`, `sendDataToDatator`, `analyzeCucumberReport`), `.env.example`, README README. Since `fa0a5b6` (2026-10-02) it also sends `website_url` (Phase 0.5 plan, V115) |
| V24 | A provided zip (`E2E_PLUGIN_ZIP`) is copied, not built, after checks (a `.zip`, exists, a file, not inside the cell's `.artifacts/` dir); it passes the same identity check as a build; the warm skips it; a version set alongside is ignored with a warning | ✅ code | `request.ts` (ref XOR zip), `resolve.ts` (`validateZipSource`, `assertZipsSurviveWipe`, `resolveZipRequest`), `warm.ts`, `verify.ts` (`verifyArtifact`, exported) |
| V25 | APVM's store serializes writes across processes — `StoreLock`, a blocking `flock` on `<cache>/.apvm.lock`, held by `store()`, `delete_build()`, release storage and maintenance; writes go through temp files + `persist`; SQLite in WAL with a 5 s busy timeout and upserts — but nothing is held from the cache lookup to `store()` | ✅ source | APVM `cli/v3.2.0`: `crates/storage/src/{lock.rs, store.rs:157, store.rs:398, fsx.rs, db/builds.rs}`; lookup in `crates/core/src/commands/build.rs:353` (`find_by_commit`), store at `:2158` |
| V26 | Two processes building the same thing at once both run the full build; the store stays consistent | ✅ 2026-09-24 | Throwaway cache, two `build()`s (`develop`, `pro-en`) started together in two processes: both missed the cache at 1 s and both cloned, checked out and ran composer; one finished in 278 s (`built`), the other died in `composer install` (exit 28) while GitHub connectivity was flaky (V21), so that failure proves nothing. A third build then came from the cache in 2.5 s with the finished build's zip (same SHA-256); the cache held one entry |
| V27 | tokio's `Command::kill_on_drop` defaults to false, and APVM's step runner sets neither it nor a timeout, so dropping a build leaves its processes running | ✅ docs + source | docs.rs `tokio::process::Command::get_kill_on_drop` ("Defaults to false"); APVM `crates/core/src/build/runner.rs:184–198` (`sh -c … .output().await`) |
| V28 | The site's own PHP version comes from Site Health → Info, not WP-CLI and not `X-Powered-By` | ✅ live 2026-09-24 | Logged in, the "Copy site info" button's `data-clipboard-text` (debug format, stable keys) gave `php_version` 8.5.10 on `pro@nginx` and `free@nginx` — where `wp eval "echo PHP_VERSION;"` answers 8.3.33 — and 8.3.33 on `pro@apache`, where the two agree; `php_sapi` `fpm-fcgi` everywhere; nginx 1.24.0 / Apache 2.4.58, WordPress 7.1.2 (WP-CLI agrees), MySQL 8.0.46 / MariaDB 10.11.14. `X-Powered-By` is absent on all three. About 1–1.3 s after login; read-only |

Rows V29–V109 — Phase 0 — are in the [Phase 0 plan](orchestrator-phase-0-plan.md)'s §11; V114–V127 —
Phase 0.5 — in the [Phase 0.5 plan](orchestrator-phase-0.5-plan.md)'s §11.

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| V110 | Node 24.21 strips types natively, but not for the suite's modules: their relative imports carry no extension | ✅ 2026-10-05 | 0 relative imports with `.ts`, 518 without, under `src/`; a standalone `.ts` ran under `node`, an extension-less `import "./b"` failed `ERR_MODULE_NOT_FOUND`; `typescript.md` at v24.21.0: "Stability: 2 - Stable" |
| V111 | `node:sqlite` works on Node 24.21 without a flag or warning; documented "Release candidate" | ✅ 2026-10-05 | `DatabaseSync(":memory:")` create/insert/select, SQLite 3.53.4, nothing on stderr; `sqlite.md` at v24.21.0: "Stability: 1.2 - Release candidate" |
| V112 | `@hono/node-server` listens on a Unix socket (`createAdaptorServer(app).listen(path)`) and serves static files (`serveStatic`) | ✅ docs | honojs/node-server README and API reference (via Context7) |
| V113 | Over plain `http://localhost` / `http://127.0.0.1` (what an SSH tunnel gives the browser), Chromium and Firefox keep a `Secure` (and `__Host-`) cookie; WebKit drops it and keeps only the non-`Secure` one. All three report a secure context | ✅ 2026-10-05 | Playwright on a Node server bound to `127.0.0.1`: Chromium 153, Firefox 155, WebKit 26.6, both hostnames, cookies echoed back by the server. Browser side only — an end-to-end tunnel to the runner is checked when the dashboard exists |
