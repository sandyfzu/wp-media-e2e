# Orchestrator Phase 0 — Make the suite ready

> **Status:** in implementation, in §9's order. **Done:** 0B.3 (2026-10-05, §4.3), 0A.2
> (2026-10-06, §3.2), 0A.1 (2026-10-06, §3.1), 0B.1 (2026-10-08, §4.1), 0D.2 with 0B.2 (2026-10-08,
> §6.2, §4.2; audited the same day), 0C's suite parts (2026-10-08, §5;
> audited the same day), 0D.3 and 0D.4 (2026-10-09, §6.3, §6.4; audited the same day, §6.5), 0E
> (2026-10-12, §7.1; audited the same day, §7.2), 0D.1 (2026-10-12, §6.1.1; audited the same day,
> §6.1.2). The rest is
> investigated: every item has a verified finding and a recommended solution, with the
> alternatives it beat.
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
| 0A.1 `bddgen` rewrites every cell — **done** | **Pin a run to one cell**: with `E2E_CELL=<cell>` the config holds only that cell, so `bddgen` touches only its specs; a `[cell]` line names the cell and how it was chosen | new `cell-pin.ts`, `reporting/cell-notice.ts`; `run-context.ts`, `project.ts`, `reporting.ts` |
| 0A.2 shared `test-results/` — **done** | Setup projects write in their cell's folder, unit runs in `_unit`, runs of no cell in `<product>/_all/<cell>`; cell names checked at load; reports and logins absolute | `project.ts`, `run-context.ts`, `reporting.ts`, `playwright.unit.config.ts`, `sites.ts` |
| 0A.3 shared hosts | Never two runs on one site or staging root. **No limit per server**: the user decides; a **warning** (command, dashboard, event) once a server's busy-run threshold — default 4, configurable — is reached, or its free disk is low | — |
| 0A.4 two runs on one site | Refuse a site listed by two cells of any product, compared on its normalized URL and location | — (optional loader check) |
| 0A.5 APVM's cache | Build in a **worker process per build**, detached, with a private `TMPDIR`: stop, cancel and timeout = SIGKILL its group and remove that folder. The cache survived every kill measured | — |
| 0B.1 a run's settings — **done** | `E2E_LOAD_DOTENV=false` makes the suite skip `.env`; the orchestrator builds each child's environment from an allowlist | new `dotenv.ts`; `load-env.ts`, `env.ts` |
| 0B.2 the built commit — **done** | The warm returns what it built — full commit, version, the pin; the run gets `commit:<sha>` with the built version — a cache hit with no network — or `release:<tag>` (still asks GitHub's API) | new `pin.ts`; `warm.ts`, `apvm.ts`, `warm-artifacts.ts` |
| 0B.3 one product list — **done** | `src/projects/products.ts`, with a drift-guard spec, replaces the three hard-coded lists; a misspelt `PRODUCT` fails instead of running WP Rocket | new `products.ts`; `healthcheck.ts`, `warm-artifacts.ts`, `playwright.config.ts`, `eslint.config.js` |
| 0C stopping a run | Spawn the Playwright CLI directly, in its own process group. Stop = **drain** (a stop file skips each scenario's first attempt), then **one** SIGINT, then SIGKILL of the group; never SIGTERM. The `@plugin` Before path stops running work first | `fixtures.ts`, `plugin-lifecycle.ts`, `plugin.hooks.ts` |
| 0D.1 reports say it up front — **done** | A *run facts* reporter, before the reports: the HTML report's title, Allure's `environment.properties` and name, a banner on the Cucumber report, `run-facts.json` | new `run-facts.ts`, `run-facts.reporter.ts`, `report-files.ts`; `reporting.ts`, `project.ts`, `run-description.ts`, `setup-facts.ts`, `scripts/allure.mjs` |
| 0D.2 commit and digest — **done** | Record the full commit, and a SHA-256 of **every** resolved zip | new `digest.ts`; `resolve.ts`, `types.ts`, `consume.ts`, `verify.ts` |
| 0D.3 the site's versions — **done** | Read Site Health's "Copy site info" in the auth setup; keep only whitelisted keys | new page object + parser; `auth.setup.ts` |
| 0D.4 no credential in a report — **done** | Type a secret with `evaluate`, never `fill()`, and check it in the page; the auth setup traces without DOM snapshots and without the failure snapshot; each run's setup ends the session the previous run saved | new `secret-field.ts`, `session.ts`, `authenticate.ts`; `login.ts`, `auth.setup.ts`, `storage.sidebar.ts`, `project.ts` |
| 0E results stream — **done** | A JSON-lines reporter (schema v1), always on, writing `<report dir>/results.jsonl` — nothing on the terminal; plus an end-of-run summary for people | new `src/common/reporting/results-stream.ts`, `run-summary.ts` and their pure parts; `reporting.ts`, `project.ts` |
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
  run is pinned to it — `commit:<sha>` with the version built, a cache hit that needs no network; or
  `release:<tag>`, which still asks GitHub's API for the release (V176).
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

**Implemented** (2026-10-06, V145–V154). As recommended, plus:

- **Where it lives.** `src/common/config/cell-pin.ts` reads the pin (`pinnedCell`: blank means unset,
  surrounding whitespace kept so `" pro@nginx"` is refused rather than trimmed into a cell) and holds
  the two refusals. `run-context.ts` splits what was typed (`projectSelection`, the old argv-or-seed
  logic) from the cells a run targets (`selectedCells`, pin first). The factory builds `[pin]` only.
- **The `--project` check mirrors Playwright's own filter** (`matchesProjectFilter`: case-insensitive,
  `*` wildcards, everything else literal). A spec compares it with `projectUtils.filterProjects` from
  the installed Playwright, so an upgrade that changes the rule fails it (V145). It is stricter than
  Playwright in one case, on purpose: a wildcard selecting none of the pinned projects is refused even
  beside one that does.
- **Output folders keep 0A.2's rule** (`cellOwningOutput`): a pinned run owns the cell's folder only
  when it runs the cell whole — no `--project`, or `--project=<cell>`. `--project=setup:<cell>` or a
  wildcard alone writes under `_all/<cell>`, as without a pin. Its report goes to the pinned cell's
  folder (the report follows `selectedCells`, which is the pin); report folders are per `RUN_ID`, so
  nothing is overwritten.
- **The `[cell]` notice** is `src/common/reporting/cell-notice.ts`, first in `reporters()`. It says
  "bddgen generates …" rather than "… were regenerated": the runner cannot know whether a `bddgen` ran
  before it. Its worker count is the one Playwright's own "Running …" line prints
  (`metadata.actualWorkers`, else `workers`; corrected by the audit, V158). `printsToStdio()` is
  `false`: one line is not a progress reporter.
- **Hints.** The operator messages that recommended `--project=<cell>` (`consume.ts`, `registry.ts`,
  `request.ts`, `scripts/report.mjs`, `scripts/allure.mjs`) now recommend `E2E_CELL=<cell>`; the docs
  lead with the pin and call the `--project` form unsafe beside another run of the product.
- **Found while testing:** outside Playwright's loader, playwright-bdd resolves a BDD config's
  `outputDir` against the working directory (V148). Real runs are unaffected — Playwright's loader
  resolves it against the config's folder (V133) — but a spec building configs in a child Node must
  compare those paths relative to its own working directory.

**Not changed, by design:** the healthcheck and the artifact warm ignore the pin: they span cells by
design and take `--product`/`--cell`. (An inherited `PLAYWRIGHT_BDD_CONFIGS` was first left here too;
the audit made the pinned config refuse it, V157.)

**Found here, fixed by merging develop** (V153, V154): BackWPup `develop` (`ab4a2e2`) moved the
restore working folder to `uploads/backwpup-restore-<token>`. This branch neither opened it to both
users nor cleared it, so on `pro@nginx` 12 scenarios failed with "Restore working directory … is not
writable", and the folders — each with a `restore.dat` — piled up on both cells. A product change, not
the pin. The suite's `develop` already handled it (`cd9b146`: `support/restore-dir.ts` prepares the
folder after each install, `support/residue.ts` sweeps the whole family); merged in `de2633b`.

#### Audit (2026-10-07, V155–V162)

Three adversarial reviews (logic and edge cases; tests and docs; merge integration and the teardown
overrun), each read-only and required to prove its findings, then every finding verified here before
it was fixed. The merge itself was clean (`git show --cc` empty; develop adds nothing that reads the
selection). Fixed:

- **An inherited selection seed was believed** (both a reviewer and this audit, reproduced): a run
  started from inside another read the enclosing run's `E2E_INTERNAL_SELECTED_CELLS` as its own
  `--project` — pinned, a false "selects nothing"; unpinned, workers and report sized to a cell
  Playwright was not running. The seed now names its writer (`{"pid","cells"}`) and is believed only
  by that process's direct children — Playwright forks workers and its test loader straight from the
  runner (`runner/index.js:1915`, `:2092`, `:5451`); every other process overwrites it with its own,
  an empty one included (V155).
- **`--project` after `--` was parsed** although Playwright reads it as a test-file filter
  (`program.js:51–53`); the scan now stops at `--` (V156).
- **An inherited `PLAYWRIGHT_BDD_CONFIGS` defeated the pin** (measured: pinned to `free@nginx`, it
  rewrote all 14 `pro@nginx` specs, while the notice said "only its specs"). The pinned config now
  refuses one naming any other cell's generated folder, compared by its `<product>/<cell>` tail so a
  symlinked checkout still recognises its own and a format it cannot read is never refused (V157).
- **The notice's worker count** was `config.workers`, not what runs: workers 4 with one test printed
  "4 workers" beside Playwright's "using 1 worker" (V158).
- **The teardown overran its 120 s budget on accumulated leftovers** (the note left for this audit):
  ~6 sequential SSH commands per leftover family directory at ~0.78 s each (measured), so 28 of them
  took ~130 s. `removeSiteResidue` now resolves the root once, checks a family once through its parent
  (members come from `find -H -type d`, which never lists a link — measured on GNU and BSD), removes
  each pass in one `rm -rf` and re-reads it in one listing per family; a re-listing that fails while
  the parent is there counts every member as a survivor. Its command count no longer depends on the
  number found (V159, V160). Also read: playwright-bdd races a hook against its timeout
  (`Promise.race`, `utils/index.js:63–73`), so a timed-out teardown is abandoned, not cancelled. Not
  changed: with the sweep bounded, the budget is not reached.
- **Tests that proved less than they claimed:** the multi-cell fail-fast, the filter of the selection
  to known cells, the pinned report folder, short flags in the variadic scan, empty `.every(...)`, and
  a spec restoring rather than clearing an inherited seed — each now has a test that a mutation
  breaks (V161).
- **Docs and conventions:** the entry configs, `plugin-artifacts.md`, the warm's comments and the
  wildcard rule still described `--project` as the way or the rule; `.env`'s scope is the working
  directory, not the checkout; the orchestrator was described in the present tense; the healthcheck
  and the warm ignoring the pin was undocumented; `--reporter` drops the notice. `cell-pin.ts` now
  reads through `env()`, `escapeRegExp` is one shared helper (`src/common/text.ts`) instead of two
  copies, and every changed function has its `@param`s. V154 named three features; four ran.

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
- **Found in 0B.3's audit (V133), done in 0A.2 (V141): Allure's results follow the working directory.** Playwright
  resolves the config's paths, its report folders included, against the config's folder. But
  allure-playwright resolves `resultsDir` (`reporting.ts:33`, relative) against the working
  directory. A run started elsewhere splits its report: `allure-results/` there, the Playwright
  and Cucumber reports in the checkout. Make `resultsDir` absolute, from the repository root.
  Compute that root without importing `run-context.ts`, which loads `.env` and stamps `RUN_ID`.

**Rejected.** Setup folders alone (a run without `--project` still wipes its product's cells);
per-run output folders (they accumulate, and break `--last-failed`); preserving the output (the CLI
cannot; only UI and watch mode set `preserveOutputDir`, V3).

**Verify when implemented.** Unit: `dirs().output` for a cell, for a run of no cell, and with
`OUTPUT_ROOT`; the setup projects' `outputDir` equals their cell's. No site: the marker measurement
(each invocation deletes only its own folder) and the mid-run deletion experiment (identical to its
control). Live: a failing scenario on a real cell while `npm run test:unit` runs on the same checkout —
traces and videos intact in all three reports. No site: a run started from another working directory
writes all three reports into the same `reports/<product>/<cell>/<RUN_ID>/`.

**Implemented** (2026-10-06, V138–V144). As recommended, plus:

- **The rule, generalized** (`outputDirFor`): a project writes in its cell's folder only when the
  run targets that cell. Any other project writes in `_all/<cell>`, including another cell's
  project picked alongside a targeted run (`--project=a --project=artifacts:b`), which would
  otherwise empty `b`'s folder.
- **Unit runs:** develop's `fe7cd1e` had already moved them to `test-results/unit`. They now use
  `<OUTPUT_ROOT>/_unit`, as recommended. `products.spec.ts` requires product names like cell names
  (lowercase, no `_`), so no product can share that folder.
- **`.last-run.json`** goes into the first selected project's output folder (V139). With every
  project now in a folder of its own, runs no longer share it, and `--last-failed` works per
  selection.
- **`.auth/` followed the working directory too.** A relative `storageState` resolves against it,
  which V133 missed: its run skipped the auth setup. Logins are now absolute paths, like the report
  folder. `reporters()` refuses a relative folder.
- **Specs:** `outputDirFor` and the cell-name rule are unit-tested. `project.spec.ts` builds a real
  config per `--project` selection in a fresh Node, from another working directory. The child
  runner moved to `src/common/__fixtures__/child-node.ts`, shared with `products.spec.ts`.

**Out of scope, found here:** two runs of one cell still share its auth, bdd and artifacts folders.
`--project=setup:<cell>` or `artifacts:<cell>` alone, during a run of that cell, rewrites its logins
or wipes its zips (`resolve.ts:94`). This is 0A.4's ground: a cell takes one run at a time, and
the orchestrator never runs a setup project alone.

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
every orchestrated run, silently); another working directory (it would skip `.env`, but Allure's
results follow the working directory and would leave the run's report, V133).

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

**Implemented** (2026-10-08, V163–V166). As recommended, plus:

- **Where it lives.** `src/common/config/dotenv.ts` holds the policy, free of side effects (`loadDotenv`,
  `applyDotenv`, `readDotenvFile`); `load-env.ts` runs it once per process and prints the warning.
  `env.ts` gains `parseBoolean`, and `boolEnv` an optional source, so the switch is read by the suite's
  one boolean rule from an injectable environment.
- **The file is read and applied by the suite**, not by `process.loadEnvFile()`: `util.parseEnv` (the
  same parser, V163), then every key the environment lacks — so the switch can be read before the file
  and a copy of it inside the file detected.
- **A switch inside `.env`** warns, naming the file and the value, and the file loads. A valid one is
  still set, so the processes the run forks inherit it as present and do not repeat the warning (with
  `false` they also skip the file, whose keys they inherited); an invalid one is not set, so no worker
  throws on it, and each process warns once (V164). `bddgen` and the runner are separate processes, so
  `npm run test:*` prints it twice (V170).
- **A `.env` that exists but cannot be read now fails the run**, naming the file, the reason and the
  switch — a directory, no permission, a link to a missing file; it used to be silently skipped. A
  missing one is still fine, and a malformed line is still skipped (the same parser).
- **Not changed:** `CI="false"` still counts as on (V82); the allowlist never passes `CI`.
- **Not run live:** with the switch unset and no `.env` the suite behaves as before (the worktree has
  none), and the switch only changes what is read at config load, which V164 measured through a real
  runner and its workers. The orchestrator's spawn is where it is used.

#### Audit (2026-10-08, V167–V171)

Two adversarial reviews (logic and parity with `process.loadEnvFile()`; tests and docs), read-only and
required to prove each finding; every finding then reproduced here before it was fixed. None was high.
Fixed:

- **Keys named like `Object` members were dropped** — `toString`, `constructor`: presence was
  `target[key] !== undefined`, and `process.env` inherits `Object.prototype`. Now `Object.hasOwn`, which
  still sees a blank real variable (V167).
- **A link to a missing `.env` read as no file** (`ENOENT`), so a broken link to a shared secrets file
  would run without it. Now refused, by `lstat` (V167).
- **Nothing tested that an unreadable `.env` fails the run**: the error path was tested on the reader
  alone, and a swallowing wrapper in `load-env.ts` or as `loadDotenv`'s default passed every test. Two
  fresh-Node tests now cover it, the switch-off case included (V168).
- **`npm run report` and `report:allure` never read `.env`** (before 0B.1): a `REPORT_ROOT` set there
  made the run write where they never looked. They now import `load-env` and run under `tsx` (V169).
- **Messages and docs:** the warning advised `=false` even for `=true` in the file; `requireEnv` said
  "set it in .env" with the file switched off (it has no caller today); the `env.ts` and `load-env.ts`
  headers and `configuration.md` named the wrong set of importers; the forked-process sentence promised
  more than it does; `execution-model.md`, the parent plan's 0B.1 and the Phase 0.5 table still showed
  the old approach or no status; `intEnv`'s lower bound was untested.
- **Confirmed sound:** `util.parseEnv` and `process.loadEnvFile` are both stable since Node 24.10.0
  (the docs' history tables; no `ExperimentalWarning` under `--trace-warnings`), under the engines floor
  of 24.16; parity also holds for a BOM, CRLF, an empty file, a 2 MB value, invalid UTF-8, NUL bytes,
  odd key names and `NODE_OPTIONS` in the file; no other code reads `.env`.

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
  a cached `develop` warm still opens `github.com` (git resolving the branch). **Corrected by the
  audit (V175, V176):** the proxy never saw APVM's GitHub API client. With all network denied, a
  commit pin is a cache hit only given its version, and a release pin fails.

**Recommended.**

- `WarmOne` returns a `WarmedBuild` — `{ fromCache, commit, version, pinRef, artifacts[{ variant, path,
  origin }], resolvedRef }` — and `WarmResult` carries it.
- `pinRef` is a pure function: a 40-hex `commit` → `commit:<commit>`; else a `release` source →
  `release:<value>`; else the build step fails, so a run is never left unpinned.
- The run gets `E2E_PLUGIN_REF=<pinRef>` and the task's version, so it plans exactly as the warm did, and
  its artifacts step needs no network. **Corrected by the audit:** the version built, not the task's
  (V176); a release pin still needs network (V176).
- The orchestrator plans through `warmArtifacts([unit], envFromTask, warmer)` — the environment is
  already injectable (`warm.ts:97–101`) — and never through `readArtifactEnv()`, which reads its own
  `process.env`.

**Rejected.** Handing the run the cached zip as `E2E_PLUGIN_ZIP`: it needs no network either, but the run
would then record a provided zip instead of its ref and commit, undoing 0D.

**Not verified.** A `commit:` pin hitting the cache for WP Rocket (its version is embedded) and for
`tag:` refs; a cold `commit:` rebuild of a pull request from a fork once its cache entry is gone.
(The first two were measured by the audit — V176; the fork rebuild is still open.)

**Verify when implemented.** `pinRef` over a SHA, a release, and anything else; `warm.spec` for the
result carried through; live: a warm of a moving ref, then a run pinned to it, with the report's commit
equal to the warm's.

**Implemented** (2026-10-08, V172–V174). As recommended, plus:

- **Where it lives.** `pin.ts` is pure: `fullCommit` (40 lowercase hex, else nothing — shared with
  0D.2) and `pinRef` (since the audit, `pinOf` → a `Pin {ref, version?}`, and `requirePin`). `warm.ts`
  gains `toWarmedBuild`, which maps APVM's output and pins it;
  `WarmResult.fromCache` became `WarmResult.build` (`build.fromCache`). `toArtifactOrigin` moved to
  `apvm.ts`, shared by the resolver and the warm.
- **`pinRef` refuses more than "anything else":** a `release` source whose value is still a selector
  (`latest-stable`, `previous-stable`, `latest`, `previous-latest`), empty, or holding whitespace or
  a colon. A refusal is a failed warm (`warmArtifacts` collects it like any other).
- `WarmedBuild.resolvedRef` is flattened (`input`, `sourceType`, `sourceValue`, `gitRef`); the
  binding's `null` variant for a single-variant project is dropped rather than passed on.
- `npm run artifacts:warm` prints each request's pin and version.
- **Still not verified:** the items above, and that the pinned run opened no network connection —
  V80 measured that on these versions; this pass did not repeat the proxy. (The audit did, and
  more: V175–V176.)

#### Audit (2026-10-08, V175–V180) — 0B.2 and 0D.2

Two adversarial reviews (logic against APVM's own source at `cli/v3.0.0`, whose binary matches the
installed one; tests and docs, by mutation), read-only and required to prove each finding; each was
then reproduced or measured here before it was fixed.

- **A pinned run was not network-free, and V80's proxy could not see why** (V175, V176). APVM's GitHub
  API client ignores `HTTPS_PROXY` (a proxy logged nothing for a release pin that, sandboxed, fails on
  that API). Measured instead with every outbound connection denied by `sandbox-exec`: a commit pin
  with its version is a cache hit; WP Rocket's commit pin **without** a version fetches its version
  file, then clones; a release pin fails (`GitHub API error … (Connect)`). **Fixed:** a warm returns a
  `Pin {ref, version?}` — the version **built** for a commit, none for a release — and every doc says
  a release pin needs network. One review's advice to give WP Rocket no version was the opposite of
  what the sandbox showed.
- **A release chosen by a selector lost its tag** (V177): `commit` used to hold `commitShort`, which
  for a release is the tag; recording only full SHAs dropped it, leaving the header `version` (no `v`
  prefix). **Fixed:** every built artifact records `pinRef` (`release:5.7.7`), shown as `pin=` in the
  summary for a release, and round-tripped through `resolution.json`.
- **A release with a full commit would have pinned to the commit** — a source build, not the released
  zip. **Fixed:** a release source is checked first. **Selectors matched case-sensitively**, while
  APVM ignores case. **Fixed.**
- **A warm whose zips APVM failed to store still succeeded** (APVM stores best-effort; the paths it
  reports are then gone). **Fixed:** `assertCached` fails it, naming each missing path.
- **Tests that could not fail** (V178): hashing the source instead of the copy (that test is removed —
  it could not tell them apart; the claim stands on `sha256File(produced.zipPath)`); `toWarmedBuild`'s
  `fromCache`, `gitRef` and `sourceValue` (the fixture used one value for all three — now a PR); the
  writer dropping `commit` (now a built artifact round-trips); `pinRef`'s order; the real warmer's
  wiring (now `createApvmWarmer(deps)` takes APVM and the file check, and is tested with a fake).
- **Docs:** "the same version" was ambiguous and the CLI printed the wrong one; a run reports no
  pin; CLAUDE.md's structure and trigger lists lacked `pin.ts`/`digest.ts`; `WarmedBuild.artifacts`
  and `.resolvedRef` had no TSDoc; `apvm.ts` still named `resolve.ts` its sole caller; the hash used
  `pipeline` then `digest()`, which works but is undocumented — now `for await … update`.
- **Confirmed sound:** git builds always report the full SHA, annotated tags peeled; `commit:` takes
  7–40 hex; `release:<tag>` drops the version like `release:latest-stable`; the tag rule keeps
  `v5.7.6`, `5.7.6-beta1`, `rel/5.7`; hashing after the `chmod` has no race; a hash error is a failed,
  redacted role; nothing new prints a token; `pin.ts`/`digest.ts` import only Node, so `warm.ts` still
  loads neither `.env` nor `RUN_ID`; no `fromCache` reader is left.
- **Not fixed:** a hash failure has no test (it shares the resolver's generic catch, tested); the warm
  CLI's printing has none (root CLIs sit outside the unit config, as before).

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

**Implemented** (2026-10-05, V128–V132). As recommended, with these additions and differences:

- **`productFromEnv(value)`** carries the bare config's `PRODUCT` rule, so it can be unit-tested.
  Unset or blank means wp-rocket. Surrounding whitespace is ignored: `" backwpup"` used to run WP
  Rocket. Any other value throws, naming `PRODUCT`. `productByName` stays exact, for callers that
  have already validated their input.
- **The per-product entry configs still import only their own product**, never the list, so one
  product's run never loads another's sites files.
- **The guard checks more than planned:**
  - each product's features and own steps lie in its own folder;
  - its entry config builds that product, checked by importing it in a child Node and reading the
    projects' `metadata.product`;
  - no other root `playwright.*.config.ts` exists, and no npm script names an unlisted product.

  The import boundary is a test too: importing the list in a child Node changes no environment
  variable, and a control proves the probe sees `run-context.ts` load `.env` and stamp `RUN_ID`.
- **The `src/common/` boundary did not exist.** This section assumed an ESLint rule "as for
  `src/common/`"; there was none. Two checks now keep `src/common/**` from importing
  `src/projects/`. `no-restricted-imports` flags a static import. `src/common/import-boundary.spec.ts`
  also catches a dynamic `import()` or a `typeof import()` type, which the rule misses (V135, V136).
- **Moved to Phase 0.5:** the orchestrator's import boundary and its `tsconfig.json` entry. Both
  need the `orchestrator/` folder, so they are its step 0 ([Phase 0.5](orchestrator-phase-0.5-plan.md)
  §5, §7).
- **Left manual, on purpose: CI's smoke steps.** `ci.yml` runs one
  `npm run test:<product> -- --grep @noauth` step per product, written by hand, so a product
  added without one is never smoke-tested and nothing fails. The guard does not require the step:
  a new product may have no `@noauth` scenario yet, and its step would then fail with "No tests
  found". Two reminders instead: step 5 of `authoring-tests.md` → "Adding a product", and a
  comment above the steps in `ci.yml`.

**Audit** (2026-10-05, V133–V137). Every changed file was re-read and its claims re-measured.
Found and fixed:

- **A false reason in `playwrightConfigFor`'s TSDoc.** It said runs must start in the repository
  root "since the configs' globs are relative to it". Playwright resolves them against the
  config's folder. The real reasons are `.env` and Allure's results, which follow the working
  directory (V133). Allure's case splits a run's report, so it is now a 0A.2 item (§3.2). §4.1's
  rejected alternative gave the same false reason; corrected.
- **A hung child could hold the spec past its timeout.** The children ran under `spawnSync`,
  which the test timeout cannot interrupt: one held its worker 61 s, past the 30 s limit. They
  now run asynchronously with a 15 s limit (V134).
- **The boundary was overstated.** `no-restricted-imports` misses a dynamic `import()` and a
  `typeof import()` type. `import-boundary.spec.ts` now checks every form (V135, V136).
- **Wording:** the list's TSDoc described the orchestrator as already reading it; CLAUDE.md's
  tree line credited the guard to `products.ts`.

Confirmed, unchanged: `bddgen` stops on a `PRODUCT` typo too, and a malformed sites file's parse
error quotes no values (V137).

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

**Implemented 2026-10-08** (V181–V184; audited the same day, V185–V191, §5.2). The gate is
`config/drain.ts` (`stopFileFromEnv`, `assertStopFileFolder`, `drainReason`, `wasDrained`) bound by the
automatic `drainGate` fixture, which `storageState` depends on so it runs first; the config factory
refuses, as the run starts, a stop file the gate could never see (relative, padded with whitespace, or
in a missing or unsearchable folder). The `@plugin`
Before hook stops running work after clearing `debug.log` (so what the stop makes PHP write is judged)
and before `ensurePluginAbsent`; work found there is reported as `before "<scenario>"`, and work that
would not stop fails the Before hook without removing or installing anything. The Before hook gets
`LEFT_WORK_ALLOWANCE_MS` (90 s) on top of its 120 s for that stop, the bound every
`ProductConfig.stopRunningWork` must fit. A step's part-way
reinstall (`replacePluginUnderTest`) does not stop work: inside a scenario, its own work is its
business. BackWPup's stop messages no longer say "when the scenario ended", since the hook prefix
now says before or after. The orchestrator's half — the stop state machine, the budgets, the
post-kill cleanup chain — belongs to the orchestrator.

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
| L3' | SIGKILL to the group, then at once the shared install with the product's stop (the next run's Before path) | the job the kill left running is stopped before the removal; one normal run restores the site |

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

Results, 2026-10-08 at `feat/orchestrator` with 0C, BackWPup `develop@1dceea8`, spawned directly
(`bddgen`, then the Playwright CLI, `detached`), both cells at once:

| Step | Measured |
| --- | --- |
| L2 (`free@nginx`, `bwu2`) | `cli-running-job.feature`, 4 scenarios. Stop file created the moment the first job was seen running (+91 s) → that scenario finished and **passed**; the other 3 **skipped**, annotated `stopped`; runner exit **0** 38 s later, group empty 0.35 s after. The 3 skips took under 2 s in all — the After hook returned (one teardown is ≥ 20 s). Playwright HTML, Cucumber (1.06 MB) and Allure written, the reason in Allure. **The site as found** |
| L3' (`pro@nginx`, `bwu3`) | SIGKILL of the group the moment job 3 was seen running (+90 s); then `installPluginUnderTest` with `stopRunningJobs`, as the next Before hook calls it: **`[hooks] before "…": a backup of job 3 was still running; it was stopped before the plugin was removed.`** 6.5 s after the kill; the whole install 73.4 s (L2 running on the same server). Left after it: a fresh plugin, its footprint, the killed run's 80 padding tables, data folders, staging. One normal run of the scenario passed and **restored the site as found** |

V50's race could not be reached through a second full run: `bddgen`, the setups and the worker's padding
sweep take longer than the 11 s paced job, so L3' calls the Before path's own function directly. The
audit's L3'' (§5.2) then reached it through the real hook, by lengthening the killed run's job.

### 5.2 Audit (2026-10-08, V185–V191)

An adversarial pass over the code, the tests (by mutation) and the claims, each finding reproduced in a
lab or on a cell before it was fixed.

- **The Before hook's budget could be overrun, and an overrun is not a timeout** (V185). BackWPup's
  stop is bounded by 30 s + 30 s plus probes (~70 s); the install beside it measured 44–73 s; the
  hook had 120 s. playwright-bdd times a hook with `Promise.race` and never cancels it, so an overrun
  install would go on beside the teardown. **Fixed:** `LEFT_WORK_ALLOWANCE_MS` (90 s) on top for the
  Before hook, added to the scenario's extension; the bound is now `stopRunningWork`'s documented
  contract, and a spec fails if BackWPup's budgets outgrow it. Measured through the real hook after
  a kill: 63.1 s, stop included.
- **The gate was not first** (V186). Playwright's own automatic fixtures, registered before ours, set
  up the context options — our `storageState` override included — before `drainGate`. On a placeholder
  site that override throws, so a drained scenario failed; the gate then ran as the After hooks were
  prepared, its skip cancelled them, and Playwright reported the retry skipped without running it:
  "flaky". **Fixed:** `storageState` depends on `drainGate`.
- **A gate that runs late misreports a broken site** (V187). A worker fixture still precedes the gate
  (BackWPup's `contentCopyLeftover` refuses a damaged site); measured in the lab: failed, then a retry
  skipped unrun — "flaky". **Fixed:** the gate skips only an attempt whose status is still `passed`;
  the lab then reads failed, failed, as without a drain.
- **A stop file the gate could never see was accepted** (V188): `"/tmp/stop "`, `"/tmp/stop\n"` and a
  path in a missing folder — `existsSync` answers `false` when it cannot tell, so every stop would
  have become an interrupt. **Fixed:** surrounding whitespace is refused, and the factory checks the
  folder exists, is a directory and is searchable.
- **The bindings had no test** (V189): removing the After hook's early return, the ordering, the retry
  rule or the gate itself left every unit test green. **Fixed:** `config/drain.run.spec.ts` runs a
  synthetic product's two scenarios (`__fixtures__/drain/`) on a placeholder site through the real
  `bddgen`, runner and hooks, in a temporary folder, network-free, in ~2 s; each of those four
  mutations fails it.
- **Docs:** a comment claimed the teardown does not fail on work that would not stop (it does, after
  its other duties); `ProductConfig.stopRunningWork`, its registry and BackWPup's budgets still spoke
  of the teardown alone. **Fixed.**
- **For 0E** (V190): a drained scenario's result reads `skipped` with no error, but its "Before Hooks"
  step carries the skip as an error (`Test is skipped: …`; Allure draws it red). The stream must judge
  a scenario by its result's status, never by step errors.
- **Confirmed sound:** the setup projects and every unit spec import `@playwright/test` directly, so the
  gate reaches scenarios only; no feature runs in serial mode; the After hook ran and returned in
  0–1 ms per drained scenario on L2 (Allure); the stop's attachment lands under the Before hook's step;
  the spec's temporary folder (a `node_modules` symlink included) is removed without following links.
- **Outside 0C, scheduled as 0D.4 (§6.4):** Playwright titles a `fill()` step with its value, so the
  login's `Fill "<password>"` reaches every report's steps (Allure's result files included), and a
  retained trace holds the password and the session cookies.

Live, on the final code, both cells at once (V191):

| Step | Measured |
| --- | --- |
| L2 (`free@nginx`, `bwu2`) | Stop file at +94 s, job running → the scenario in flight passed, 3 skipped as `stopped`, runner exit 0 40 s later, group empty 0.03 s after. **The site as found** |
| L3'' (`pro@nginx`, `bwu3`) | 500 empty `wp_e2e_audit_NNN` tables first, so the paced dump outlasts a run's start-up; SIGKILL of run A's group once job 3 ran; run B (a plugin-deletion scenario) started at once. Its **real Before hook**: `[hooks] before "Deleting an active plugin…": a backup of job 3 was still running; it was stopped before the plugin was removed.` — the hook 63.1 s in all, the attachment in its step; the scenario passed. Audit tables dropped (500 → 0). **Both sites as found** |

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

### 6.1.1 Implemented (2026-10-12, V239–V249)

As recommended, with these specifics:

- **Modules.** `reporting/run-facts.ts` (pure): the facts (`beginFacts`, `withSetupAttachment`,
  `withSetupEnded`, `endFacts`), the title line, the entries (labels most important first), the
  properties escaping, the banner and where it goes (`bannerSplice`), `run-facts.json`'s text.
  `reporting/run-facts.reporter.ts` is the thin reporter; `reporting/report-files.ts` writes a file
  whole (temporary file + rename) and splices a file's end in place (its last 64 KB read). Reused:
  `setup-facts.ts` (the attachments, now with each zip's `sha256`, believed only as 64 lowercase hex),
  `RunTally`/`firstError` (`results.ts`), `verdictOf`, `describePlugin`, `describeSite`, `plain` and
  `cut` (`run-summary.ts`, `cut` now exported); `escapeHtml` is new in `text.ts`.
- **Placement — after `list`, before the reports, not first.** What needs the order is the HTML
  report reading the title and metadata in its own `onEnd`; the `[cell]` notice must stay first (it
  prints before "Running …") and the stream before `list` (its `run.end` before every report).
- **Lifecycle — the final files in `onEnd`, not `onExit`.** `onEnd` writes `run-facts.json` and
  `environment.properties` with the verdict, the metadata and `PLAYWRIGHT_HTML_TITLE`; `onExit` only
  splices the Cucumber banner, which needs every `onEnd` done. Earlier is safer: a kill between the two
  keeps the final facts. allure-playwright never writes that file (no `environmentInfo`) nor cleans the
  folder (V246). Nothing is written for `--list`.
- **The display-only variables**: `E2E_RUN_NAME` and `E2E_REQUESTED_REF` reach the reporters through the
  run description (`project.ts`, `run-description.ts`); the requested ref replaces, in the title, the
  pin the run was built from (`develop @ 1dceea8966`, not `commit:<40 hex> @ …`). Documented in
  `.env.example` and `configuration.md`.
- **What the title says**: `backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · develop @ 1dceea8966 ·
  WordPress 7.1.3 · PHP 8.5.11 64bit · <run name or RUN_ID>`, plus `RUNNING`, `INTERRUPTED`,
  `COULD NOT TEST` or `NO TESTS` — the states the reports cannot say themselves. A missing fact:
  `plugin unknown: artifacts setup failed` / `skipped` / `interrupted` / `did not run` / `not in this
  run` / `left no record`, `pending: … not finished` while it runs. The status entry of a killed run:
  `running — no end recorded yet; a run that is over and still says so was killed`.
- **Entries** (Allure's Metadata, the HTML metadata, the banner's disclosure): Status, Plugin, Plugin
  SHA-256, Site, Server, Cell, Run, Requested ref — Allure's eight — then the plugin's commit, ref, pin,
  zip and source, the RUN_ID, start and end. A second role, a pool's later sites and a run of every cell
  keep labels unique.
- **Kept out**: of the sites file only `baseURL`; every stored value is one plain line, credentials
  masked (`redactSecrets`, §6.1.3), at most 300 characters.
  `captureGitInfo` is guarded off by `project.spec.ts`. An operator's own `PLAYWRIGHT_HTML_TITLE` wins.
- **`scripts/allure.mjs`**: `--name` from `run-facts.json`'s `title` (else `product · cell`), and a run
  counts only when its `allure-results/` holds a `-result.json` — the facts' properties file alone made a
  `--list` run "the newest" (V254).

### 6.1.2 Audit (2026-10-12, V250–V256)

Every claim re-read against the diff and the installed sources; each fix proven by a test that fails
with it undone (V248), then live again on both cells.

- **A site's versions reached the title raw** (V250): `describeSite` made the entries plain, but the
  title read `versions.wordpress`/`php` directly, so an escape sequence or newline in Site Health's text
  would reach the HTML title, the banner and Allure's name. **Fixed:** every string a setup attaches is
  made a fact's text as it is folded in (`cleanStrings`), plugin facts included.
- **"pending: … running"** said a queued setup was running (V251): now `pending: … not finished`.
- **The banner's dark colours** did not follow the Cucumber report's own dark theme (V252): it now uses
  the report's panel colours (`#282a36`/`#f8f8f2`).
- **An untestable guard** (V253): `spliceIntoTail`'s regular-file check survived its mutation — a FIFO
  or device reports size 0, so nothing is read and nothing blocks. Removed; the FIFO spec stays.
- **`allure.mjs` and runs that ran nothing** (V254), found while building: fixed as above, measured on a
  synthetic report root.
- **Placement and timing** re-checked (V255, V256): after `list` and before `html` is enough, and the
  final files in `onEnd` survive a kill before `onExit`.
- **Confirmed, no change** (V242, V246): the HTML report's metadata panel lists all 15 facts with
  `#?show-metadata-other`, `actualWorkers` stays hidden; a killed run leaves no HTML report and a 0-byte
  Cucumber file (V68), so only `run-facts.json` and Allure's properties carry its facts — and Allure,
  generated from it, names it `RUNNING`.

### 6.1.3 Adversarial audit (2026-10-12, V257–V269)

Every claim re-measured; each fix proven by a test that fails with it undone (V263), then live on both
cells at once (V265).

- **The masking was aimed at the wrong source** (V257). APVM never quotes its token — nine failure modes,
  fake and real tokens, online and offline — and git hides a URL's user and password itself. What does
  quote a credential: Playwright's navigation errors, a basic-auth `baseURL` whole; and git, a URL
  parameter (`?access_token=`).
- **The summary and the stream masked nothing** (V258): a setup's error, a failed resolution's error, a
  site's URL went out as written — to the terminal, the orchestrator's log and `results.jsonl`; so did
  the site-info attachment and its `[site]` line. **Fixed** (approved): one `redactSecrets` in `text.ts`
  (moved from `apvm.ts`) — a GitHub token, a URL's user and password, a credential URL parameter —
  applied before any cut by `cleanMessage` (every stream error, hence the summary's and the facts'),
  `displayText` (the summary's and the facts' values), `readSiteInfo` and APVM's output. The facts'
  own copy is gone.
- **The facts' copy leaked** (V259): it stopped at the first `@`, leaving `ss@host` of a password
  `p@ss`, and had no token rule. Now to the authority's last `@`.
- **Quadratic matching** (V260): the URL pattern, APVM's copy included, tried a scheme from every `\b`
  — 0.4 s for 40,000 characters of `a.`, minutes for a megabyte; now on every stream message, so it
  starts only where a run of scheme characters does: 0.2 ms.
- **Every sink checked** (V261): the `[cell]` notice carries no error text; the stream's every error
  goes through `cleanMessage`; the facts, properties, banner, HTML title and metadata and Allure's name
  through `factText`. Playwright's own reports, traces and Allure's results keep its error as written —
  outside the suite's reach.
- **Test gaps** (V262, V263): label escaping, the requested ref on another role, a banner for a run
  that never ended, the cut after the mask — each survived its mutation; tests added. A reporter that
  throws now proven not to turn a green run red through the real runner (V264).
- **Docs**: §6.1.1 said a clone error could quote a token (V257: it cannot), now corrected; `--reporter`
  (no facts) said in `execution-model.md`; the masking said where the stream, the summary and APVM are
  documented.

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

**Implemented** (2026-10-08, V172–V174). As recommended, plus:

- `digest.ts` holds `sha256File` (streamed, so a large zip is never held in memory) and `isSha256`,
  the parser's check. The copy in the role dir is hashed — the bytes the run installs.
- The build path's mapping is now `builtArtifact`, exported and unit-tested (full commit kept, a
  release's `release-<tag>` dropped); before, only a live run exercised it.
- **"Double-checks the orchestrator's stored digest"** needs no suite input: the run records the
  digest of what it installed, and the orchestrator, which stores a zip by its SHA-256, compares the
  two. No variable was added (§10 P5's list stands).
- An older `resolution.json` with a short `commit` is still read (only `--no-deps` runs read one);
  `commit` is not format-checked, `sha256` is.
- **Audited** with 0B.2 (§4.2's audit, V175–V180): a release chosen by a selector had lost its tag —
  every built artifact now also records `pinRef` (`release:5.7.7` / `commit:<sha>`), the ref that
  rebuilds it; a release's shows in the summary as `pin=`.

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

**Implemented** (2026-10-09, V197–V199). As recommended, plus:

- `SiteHealthPage` (`goto`, `siteInfoText`) aborts the directory-sizes call under both permalink forms
  (`/wp-json/…` and `?rest_route=`), and checks the text in code — a failed attribute matcher would
  print all 6.5 KB into the report.
- `setup/site-info.ts`: `parseSiteInfo` (sections; a field only from its own section, never a list's
  tab-indented line; `undefined` read as absent), `describeSiteInfo` (the `[site]` line — "unknown"
  for a missing version, never blank) and `readSiteInfo`, which never throws: a failure is an
  `{ baseURL, error }` entry. The whitelist adds the database `extension` (mysqli).
- The setup prints one `[site]` line per site and attaches `site-info.json` even when a later site's
  login fails, so the reports keep what was read — the input 0D.1 folds in.
- The values moved since V58: WordPress 7.1.3 and PHP 8.5.11 on both cells (V199).

### 6.4 0D.4 — No credential in a report

Found in the 0C audit (§5.2), outside 0C, and scheduled with 0D.3: both change the auth setup's login.

**Finding** (V192–V196):

- **Every real run's reports hold the site's login password.** The auth setup types it with `fill()`,
  whose step Playwright titles `Fill "<password>"`: it is in that setup's Allure result and in the HTML
  report's embedded data — not in the Cucumber report (setup projects are left out of it, V54), nor in
  a passing run's `test-results/`.
- **A failed attempt's retained trace holds more**, and the HTML report copies it into its `data/`: the
  password in the fill's call, its log and the next action's DOM snapshot; and in a scenario's trace,
  the WordPress session cookies (`wordpress_logged_in_…` 95 times, `wordpress_sec_…` 24 in one
  report) — an admin session until it expires.
- **Playwright 1.63 masks nothing.** `Fill`, `Type` and `Insert` render the value into the step's
  title and params; a boxed step hides nothing; its docs say only to treat traces and reports as
  sensitive.
- **Measured fix (lab):** entering the value with `locator.evaluate` — the native `value` setter, then
  `input` and `change` events — leaves no title, param or Allure entry. The trace still gets it two
  ways: the next action's DOM snapshot, and `inputValue()`'s result. Entering by `evaluate`,
  checking the value **in the page** (only a boolean comes back), and a trace without DOM snapshots
  (`snapshots: { dom: false }`, which also stops network recording) left reporter steps, Allure and
  trace clean.
- **Phase 0.5 sends no report off the server** — Datator gets counts, names, statuses and first errors,
  Slack an `scp` path — so the exposure is a report folder copied or served elsewhere. Still, every
  report carries the password today, and nothing says so but CLAUDE.md.

**Recommended.**

- A shared helper in `src/common/pages/` — enter a secret into a field by `evaluate`, and check in
  the page that the field holds it — used for every secret the suite types: the login's password
  (`login.ts`, whose kept-value check becomes the in-page check), and the storage credentials
  BackWPup's `storage.sidebar.ts` types (6H). Usernames, paths and the rest keep `fill()`. A side effect
  to confirm live: `evaluate` writes the field directly, so the login page's re-focus cannot divert
  the password — the race `login.ts` guards against today.
- The auth setup project traces with `snapshots: { dom: false }`: it only logs in, so it loses little
  (screenshots stay), and its trace then holds no password and no `Set-Cookie`.
- **Scenario traces and their session cookies — measure, then choose:** (a) keep them, and say in
  every report that a trace is a credential; (b) `snapshots: { dom: false }` for orchestrator runs —
  no cookie, but no DOM or network to debug with; (c) end the run's session at the end of the run
  (WordPress's `WP_Session_Tokens::destroy` with the token from the saved login's cookie, over WP-CLI),
  so a cookie in a trace is dead by the time anyone reads it, without touching other users' sessions.
  (c) looks best — debugging intact, nothing live in the artifacts — if it holds up live.
- Correct the docs: CLAUDE.md's "Traces carry site credentials" note, and the modernization plan's
  claim that no credential appears in any report (its acceptance line and risk table).

**Implemented** (2026-10-09, V200–V207). The helper and the setup trace as recommended; the canary
found two more channels, and the session choice changed:

- **`pages/secret-field.ts`** — `enterSecret` (editable check, the prototype's `value` setter, `input`
  and `change`) and `holdsSecret` (compared in the page; a boolean comes back). `login.ts` types the
  password with them; the username keeps `fill()`. `StorageSidebar.fillSecret` for storage keys (no
  scenario uses one yet). Under `tsx` too: the healthcheck logs in through it.
- **The setup project** traces with `snapshots: { dom: false }` (`project.ts`, `SETUP_TRACE`).
- **New channel — the failure snapshot** (V202): on a failed test Playwright 1.63 writes
  `error-context.md` with the page's accessibility tree, which prints every textbox's value, a password
  field's included; every report copies it. Taken when a context is still open at the test's end — a
  setup that **times out** mid-login. Turned off by `PLAYWRIGHT_NO_COPY_PROMPT`, read per worker each
  time; undocumented, so the canary proves it still works. *(Set at the top of the setup file as first
  implemented, it reached the scenarios too — fixed in the audit, §6.5: `keepSecretsOutOfFailureSnapshots`
  turns it off per setup test, back on only after one that passed.)*
- **New channel — `storageState()`'s result** (V203): a traced call, whatever the snapshot setting,
  so a failed setup's trace holds the cookies of every session it saved before failing. The setup
  (`auth/authenticate.ts`, `authenticatePool`) therefore **ends those sessions before it reports the
  failure** — nothing can use them, the scenarios do not run.
- **Session cookies — option (c), moved to the next run's start** (V204, V205): a `teardown` project
  at the run's end would kill the saved login the documented `--no-deps` loop reuses, and does not run
  on SIGINT (measured). So the auth setup ends the session **the cell's previous run saved** before it
  logs in (`auth/session.ts`: the token from the saved `wordpress_logged_in_…` cookie,
  `WP_Session_Tokens::destroy`, WordPress loaded `--skip-plugins`, re-read to prove it gone; no other
  session of the user touched). At most one session per site is live — the newest report's — and a
  killed run's is ended by the next run. Best-effort: a failure warns; the session still expires in
  two days (the login is not remembered).
- **The canary** — `auth/secrets.run.spec.ts` runs the real runner and reporters on a synthetic
  product whose setup project calls the setup's own `authenticatePool` against a local mock
  WordPress, with a `fill()` control found in every channel searched; each of the four fixes, undone,
  fails it (V206).
- Docs corrected: CLAUDE.md's note, `authoring-tests.md` ("Typing a secret"), `execution-model.md`, the
  modernization plan's acceptance line and risk row, the orchestrator plan's dashboard note.

**Still in a report** (accepted, documented): a scenario's retained trace — its DOM snapshots and
network — holds the session cookies until the cell's next run, and anything a scenario rendered or
typed (BackWPup's restore wizard renders the database password). The healthcheck's logins hold no
report and are not ended; they expire.

**Rejected.** A boxed `test.step` around `fill()` (hides nothing, V194); `pressSequentially` or
`keyboard.insertText` (titled with the value too); redacting reports after the fact (Allure writes per
attempt, the HTML report embeds zips, and a missed format leaks); traces off everywhere (no
diagnostics for the failures that need them).

**Verify when implemented.** Unit: the helper on a `setContent` form — value set, `input`/`change`
fired, the in-page check true and false. A canary run through the real runner, like
`config/drain.run.spec.ts`: no occurrence in the reporter's steps, the Allure results, the HTML report
(its embedded data and `data/` zips) or a forced failure's trace. Live on both cells: the login still
settles, and a scan of a real run's report folder and of a failed setup's trace finds no password;
for (c), a session destroyed at the run's end no longer opens wp-admin.

### 6.5 Audit of 0D.3 and 0D.4 (2026-10-09, V209–V224)

Every claim re-measured — labs on Playwright 1.63, the cells' WordPress 7.1.3 source and WP-CLI, local
PHP 8.1 — each fix proven by a test that fails with it undone (V222), then live again on both cells.

- **The failure-snapshot switch reached the scenarios** (V209, V210). A setup worker hands every
  variable it changed to its dependent projects' workers when it stops (Playwright's produced
  environment, `common/index.js:1913–1934`), so the switch set at the top of the setup file — and the
  runner imports that file too — turned off every **scenario's** failure snapshot. Removing it in
  `afterAll` is too early: a failed test's `afterEach`/`afterAll` run before its snapshot is taken
  (the password printed again). **Fixed:** `keepSecretsOutOfFailureSnapshots(setup)` turns it off in
  `beforeEach` and back on in `afterEach` only when the test ended as expected; a failed setup keeps it,
  and its scenarios never run. Measured for a pass, a throw and a timeout; the canary now runs a real
  timeout and a dependent scenario.
- **A hung best-effort step could fail the setup** (V211). Ending a session has no time limit (no
  WP-CLI call has one), and reading the versions gave the page load and the button wait 30 s each,
  inside a per-site budget of 60 s the login already uses. **Fixed:** `withinBudget` (new
  `src/common/deadline.ts`) bounds ending sessions (20 s); `readSiteInfo` shares one 20 s deadline;
  the setup's timeout adds `BEST_EFFORT_ALLOWANCE_PER_SITE_MS` (60 s) per site.
- **Site Health answering an error waited out the whole budget** (V212): 20.1 s for a 404. WordPress
  answers a user who may not view it with 403 (`site-health.php:48`). **Fixed:** `SiteHealthPage.goto`
  fails at once on an HTTP error, naming the status (125 ms).
- **A saved login was trusted for any site** (V213). If the pool's order changes, `site-N.json` holds
  another host's session, and its token was sent to this site's WP-CLI. **Fixed:** only cookies whose
  domain covers the site's host count (a parent `COOKIE_DOMAIN` included).
- **A renamed auth cookie was silently skipped** (V214): the name `wordpress_logged_in_` is a default
  (`LOGGED_IN_COOKIE`). **Fixed:** the cookie is recognised by its value's shape — `login|digits|token|
  HMAC`, the token alphanumeric, the HMAC 64 (or 40) hex, as on the cells.
- **A space in a login** (V215): PHP's `setcookie` encodes with `rawurlencode` (8.1: `%20`), which was
  read correctly; a bare `+` is now read as a space too — neither encoder leaves a literal `+` bare.
- **`--skip-plugins` still loads must-use plugins** (V216) — `session.ts` said otherwise; corrected.
  Neither cell swaps the session store (`session_token_manager`), with plugins loaded or not.
- **`enterSecret` accepted a hidden field** (V217), where `fill()` waits for a visible one; it now
  requires visible and editable. Its comment on the prototype setter was muddled; corrected and proven
  with a React-style value tracker (a plain assignment is no change to it; `enterSecret` is).
- **Untested pieces** — `authenticatePool` (now 7 specs against a mock WordPress), the scanner the
  canary rests on (6 specs: base64 at each alignment, nested zips, the embedded report zip, symlinks),
  `withinBudget` (4). The mock is shared with the canary (`__fixtures__/mock-wordpress.ts`).
- **Confirmed, no change:** `evaluate`'s argument is never in a trace (V218); without DOM snapshots
  the trace's network log is empty (V219); `WP_Session_Tokens::get` is `null` for an expired or unknown
  token and `destroy` removes that one (V220); the failed setup's screenshot of Site Health shows
  collapsed sections only — the database user, host and name sit in its hidden DOM, which the setup's
  trace does not record (V221).
- **Out of scope, reported:** a failed **scenario's** `error-context.md` prints every field's value in
  its page snapshot, as its trace's DOM snapshots do — the restore wizard's database password included.
  It predates 0D.4; turning snapshots off for scenarios would cost every failure its page context, a
  choice for the user.

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
  Only for a scenario that did not pass or skip: a drained one reads `skipped` with no error, yet its
  "Before Hooks" step carries the skip as an error (V190); a `stopped` annotation says it was drained.
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
partial last line, a bad line, an unknown type). A drained scenario — `skipped`, a `stopped`
annotation, its "Before Hooks" step carrying `Test is skipped: …` as an error (V190) — ends as
`skipped`, drained, with **no** first error. No site: the prototype's features, with a SIGINT, a
SIGTERM, a failing setup and a drain (`config/drain.run.spec.ts` runs one). Live: a real cell, where a
`DebugLogFatalError` is attributed to `AfterEach Hooks`.

### 7.1 Implemented (2026-10-12, V225–V231)

As recommended above, with these specifics:

- **Modules.** `reporting/results.ts` holds what both reporters decide — the final attempt, the status,
  the first error, a scenario's place, the tally — so the stream and the summary cannot disagree.
  `results-schema.ts` (the v1 types), `results-stream.ts` (the reporter and `JsonLinesFile`),
  `results-reader.ts` (`parseResults`: complete lines only, unknown lines counted and skipped),
  `run-summary.ts`, `setup-facts.ts` (the setups' attachments read back — for 0D.1 too) and
  `run-description.ts` (the facts the config factory hands every own reporter: product, cell, edition,
  `RUN_ID`, report folder). `config/project-names.ts` names a cell's projects and tells a setup from a
  scenario; `setup/attachments.ts` holds the two attachment names, so a reporter never loads a page
  object (which imports `@playwright/test`).
- **Schema v1 fields.** Durations are `durationMs` (every attempt summed on `scenario.end`); a retry
  carries the attempt's own `attemptStatus`; `setup.end` names its `setup` (`auth`, `artifacts`); a
  drained scenario carries `drained: true`, one whose due retry never ran `retryNotRun: true` (§7.2);
  an error is `{ message, where, step? }` with `where` one of
  `step`, `hook`, `last-step`, `test`; `run.begin` has `mode` (`test`/`list`).
- **Order.** The stream sits second, after the `[cell]` notice — which has no `onEnd`, so `run.end`
  still lands before every report's.
- **Summary.** As drafted, without the `Pruned` line (0F adds it). The plugin's name comes from a new
  `pluginName` in the artifacts setup's attachment (the expected `Plugin Name:`, which a passing role's
  zip was proven to carry). A run of every cell prefixes each fact with its cell. Each failed setup's
  first line sits under one `Setup` label; the full report is printed above it by `list`.
- **Live** (V230): both cells at once; every failure attributed to its step or hook, the summaries
  as drafted. `free@nginx`'s two deletion scenarios failed on BackWPup Free's own leftover options —
  the same without 0E (an A/B run of the last commit), so a product or site matter, reported apart.
- **Measured while building it** (V225–V227): the step trees below the attribution rules — a named
  hook is titled by its name, a hook that times out leaves its error on `BeforeEach Hooks` and none on
  the hook, a failing fixture sits under `Before Hooks › Fixture "<name>"`; Playwright hands every
  reporter `_mode` (`list` for `--list`), undocumented, which a run spec now guards; its `outcome()`
  sets interrupted and skipped attempts aside.

### 7.2 Audit (2026-10-12, V232–V238)

Every claim re-measured on Playwright 1.63 — labs driving the real reporters, the dispatcher's source —
each fix proven by a test that fails with it undone (V236), then live again on both cells.

- **A retry was predicted by the guess Playwright's own reporters make, not by what its dispatcher
  does** (V232, V233). Three cases measured: a screenshot with no baseline is never retried
  (`shouldNotRetryTest`), so the stream wrote `scenario.retry` and never `scenario.end`, and counted a
  failure as "did not run"; after a failed `beforeAll` (or a worker crash between tests) Playwright
  reports the remaining tests `skipped` — `expectedStatus` still `passed`, `parallelIndex` −1 — then
  retries them, so a scenario ended twice; and a retry still queued when a run stops never runs.
  **Fixed:** `willRetry` applies the dispatcher's rule (`JobDispatcher._onDone`,
  `runner/index.js:5900–5965`: a failure, or a skip the test did not choose, while retries remain;
  never an interrupted attempt); `RunTally` keeps each test's last final status; `settle()` ends, as
  the run ends, every test whose due retry never ran — its `scenario.end` (or `setup.end`) then carries
  `retryNotRun`. Playwright 1.63 retries at once by default (`retryStrategy: "immediate"`,
  `common/index.js:496`), so `--max-failures` stops a run with no retry queued; the no-baseline case is
  the deterministic one, and the run spec now runs it.
- **Playwright's call log quotes attribute values** (V234): a locator error's message carries
  `locator resolved to <input value="…"/>` — on the restore wizard, the database password. **Fixed:** the
  stream drops the call log (the reports keep it). An assertion's own `Received:` stays: the stream is
  documented as sensitive as the reports.
- **The summary printed what sites report as is** (V235): an escape sequence or a newline in Site
  Health's text, or a setup's error, reached the terminal. **Fixed:** `plain()` on every such value.
  Also: an interrupted setup was called failed (no longer); report paths assumed the repository root
  as the working directory and were unquoted (now relative to it, quoted when a shell would split them).
- **Hardening.** A failed append could glue the next line to a fragment (the next line now starts on a
  fresh one); an attachment path that is a FIFO would block the runner — undoing that check hung a spec
  for 10 minutes — so only regular files are read; a cut could split a surrogate pair; a folder named
  `..x` read as outside its project; the run description's optional fields were unchecked.
- **Tests.** `run-description.ts` had none (added). The run spec asserts on every run that each test ends
  once, before `run.end`, whose counts are the ends written — and it linked the whole `src` into its
  temporary folder, so a missing screenshot baseline would have been written into the repository: it
  now links `src/common` alone.
- **Confirmed, no change:** a soft assertion's error reaches its step (`infectParentStepsWithError`); a
  skip the test chose sets `expectedStatus: "skipped"` (runtime skip, drain); a missing baseline puts
  its error on no step, so `last-step` names the step that ran.

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

1. 0B.3, one product list — everything the orchestrator spawns starts from it. **Done 2026-10-05.**
2. 0A.2, the output folders and the cell-name rule — a hazard today. **Done 2026-10-06.**
3. 0A.1, the cell pin. **Done 2026-10-06.**
4. 0B.1, a run's environment. **Done 2026-10-08.**
5. 0D.2 with 0B.2 — the full commit, the digest, and the built commit (the artifacts code). **Done
   2026-10-08.**
6. 0C's suite parts: the Before path stopping running work (worth having now), then the drain.
   **Done 2026-10-08.**
7. 0D.3 and 0D.4 — the site's versions, and no credential in a report: both change the auth setup's
   login. **Done 2026-10-09.**
8. 0D.1 and 0E, run facts and the results stream (the reporting code). **0E done 2026-10-12**; **0D.1
   done 2026-10-12** — it reuses 0E's attachment parsers (`setup-facts.ts`), tally and run description.
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
| V50 | The `@plugin` Before path never stops the product's running work — **fixed 2026-10-08** (V184) | ✅ source · ✅ live through V184 (L3 could not reach the race: the job ended within 15 s of the kill) | `plugin-lifecycle.ts:208–215` against the teardown's `:338–339` |
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
| V80 | V17 on apvm-napi 3.0.0 and the current suite: `commit:<sha>` and `release:<tag>` pins are cache hits (0.6–0.9 s, same SHA-256) that open no network connection; a cached `develop` warm opens `github.com` | ⚠️ partly wrong — V175, V176 | A logging CONNECT proxy, which APVM's API client bypasses |
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
| V128 | 0B.3: before it, `PRODUCT=backwpu` and `PRODUCT=" backwpup"` listed WP Rocket's 10 tests. After it, the typo stops the config load with `PRODUCT="backwpu" names no product…`. `" backwpup"` lists BackWPup's 117 (52 Free + 61 Pro scenarios + 4 setups); blank and `"  "` list WP Rocket's 10 | ✅ 2026-10-05 | `npx playwright test --list` on the bare config, before and after; `bddgen` first, since `.features-gen/backwpup` was stale |
| V129 | The guard's 13 tests pass. Each of 14 mutations fails exactly the tests aimed at it, and the unmutated control passes: unlisted folder, a duplicate entry, features or steps in another product's folder, an entry config building another product, a missing or stray entry config, a script with the wrong config or an unlisted product, the list importing `load-env` or `run-context`, `PRODUCT` untrimmed, a typo falling back to WP Rocket | ✅ 2026-10-05 | A throwaway copy of the worktree per mutation (`node_modules` linked, no `sites.json`), `products.spec.ts` alone |
| V130 | Importing `products.ts` in a fresh Node (tsx, only `PATH` and `HOME`) from a folder whose `.env` sets a sentinel changes no environment variable. `run-context.ts`, `resolve.ts` and `consume.ts` each load the sentinel and stamp `RUN_ID`. Each probe takes under 1 s | ✅ 2026-10-05 | The spec's child probe, and the same probe by hand on the three modules |
| V131 | The `src/common/**` rule flags a value import, an `import type`, an `export … from` and a nested folder's import of `src/projects/`, but not `./guards`; the existing tree passes it | ✅ 2026-10-05 | Two temporary probe files under `src/common/`, linted then deleted; `npm run lint` |
| V132 | The consumers after the change: the warm exits 1 on an unknown `--product` or `--cell`, naming the known ones, and 0 with nothing to warm for WP Rocket. The healthcheck walks both products and passes 7/7 on `bwu2` and `bwu3`, exit 0. The bare config's `@noauth` smoke passes (6 passed, 4 skipped). The gates: typecheck, lint and format clean; unit 1254 passed, 8 skipped (1241 before) | ✅ 2026-10-05 | `npx tsx warm-artifacts.ts …`; `healthcheck.ts` live (read-only); `bddgen && playwright test --grep @noauth` |
| V133 | Started from another working directory with absolute config paths, `bddgen` and the `@noauth` run both work. The generated specs, `test-results/` and the Playwright and Cucumber reports land beside the config. `allure-results/` lands under the working directory, and `.env` is read from there | ✅ 2026-10-05 | A copy of the worktree, run from an empty folder with a sentinel `.env`; `reporting.ts:33` (relative `resultsDir`) |
| V134 | Under `spawnSync`, a child that never exits held its test 61 s, past the 30 s test timeout. Under async `execFile` with a 15 s limit it fails at 16 s, `killed after 15000 ms`, and leaves no process. A crashing child reports `exit 1` and its stderr | ✅ 2026-10-05 | A probe test added to a copy of the spec: a child kept alive by a timer; a child importing a missing module; `pgrep` afterwards |
| V135 | ESLint's `no-restricted-imports`, and typescript-eslint's, flag no dynamic `import()` (exit 0); a `no-restricted-syntax` `ImportExpression` selector does. `ts.preProcessFile` (TypeScript 6.0.3) reports static, `import type`, side-effect, `export … from`, `export *`, dynamic, template-literal and `typeof import()` forms, and nothing from a comment or a string | ✅ 2026-10-05 | A probe file under `src/common/`, linted then deleted; a scanner probe over each form |
| V136 | `import-boundary.spec.ts` scans the 90 files of `src/common/`. A dynamic import, a static import and a `typeof import()` of product code each fail it. Only the static one also fails ESLint. Scanning by substring, or dropping the outside-the-folder check, fails its own scanner test. The control passes | ✅ 2026-10-05 | A throwaway copy per mutation, `import-boundary.spec.ts` alone plus `eslint src/common` |
| V137 | `PRODUCT=backwpu npx bddgen` exits 1 with the same message as the runner. V8's `JSON.parse` errors name a position, not source text, so a malformed sites file's `[cause]` quotes no value. The gates after the audit: typecheck, lint and format clean; unit 1256 passed, 8 skipped. The products spec's 14 mutations are all still caught | ✅ 2026-10-05 | `bddgen` exit status; `node -e` over two malformed objects; the gates; the mutation script re-run |
| V138 | 0A.2's marker measurement, before and after. Before: a unit run emptied only `test-results/unit` (develop's `fe7cd1e`), `--project=apache` only its folder, and each of `--project=setup:apache`, `--project=artifacts:apache`, no `--project` and `--project='*'` emptied every folder, both products' and the root. After: the unit run empties only `_unit`, the cell only its folder, the four others only `wp-rocket/_all/…`, and the root survives every run | ✅ 2026-10-06 | A marker in eight folders before each of six invocations, in a copy of the worktree with placeholder cells |
| V139 | Playwright 1.63.0 writes `.last-run.json` in the first selected project's output folder; empties the output folder of every selected project before a run; matches `--project` case-insensitively, with `*` wildcards. After 0A.2 the file lands in `_unit/`, `wp-rocket/apache/` or `wp-rocket/_all/apache/`, per selection | ✅ source + measured | `runner/index.js:6606–6614`, `:6398–6418`, `:2140–2170`; the V138 runs |
| V140 | The mid-run experiment. A failing `apache` probe attaches a file, waits 25 s, then fails, while a unit run, a run with no `--project`, `--project=setup:apache` and `--project=artifacts:apache` start. After 0A.2 it matches its control: the trace, video, screenshot, attached file and error context in the Playwright and Allure reports, and a ~1.08 MB Cucumber report. On the previous commit the same run kept 1 screenshot in the Playwright report, 2 of 5 attachments in Allure and a 2.5 KB Cucumber report, with ENOENT errors | ✅ 2026-10-06 | `midrun.sh`, in copies of the worktree and of `HEAD` |
| V141 | Started from another working directory, a run now writes all three reports into one `reports/<product>/_all/<RUN_ID>/` in the checkout, and nothing in the working directory. Playwright's docs: a relative `storageState` path resolves against the working directory, so `.auth/` followed it before. `.env` is still read from the working directory | ✅ 2026-10-06 | V133's probe re-run; Playwright 1.63.0 docs (`browserContext.storageState`, `path`) via Context7 |
| V142 | Live on `bwu2`, read-only. `--project=setup:free@nginx`, started from another folder, saved its login to the checkout's `.auth/backwpup/free@nginx/site-0.json` and left that folder empty. A probe on `free@nginx` opened wp-admin and failed by the 30 s timeout (03:21:10.8–03:21:41.2). `npm run test:unit` (1271 passed) emptied `_unit` at 03:21:17.3, inside that window. The probe's trace, video, screenshot, attached file and error context reached all three reports, with no ENOENT | ✅ 2026-10-06 | `live.sh`, its probe files removed after; Allure result times; `_unit`'s birth time |
| V143 | Every cell name in use matches `^[a-z0-9][a-z0-9@._-]*$`: `apache`, `nginx`, `free@nginx`, `pro@nginx`, `free@apache`, `pro@apache` | ✅ 2026-10-06 | The keys of every sites file in both checkouts, the products' examples and `docker/` |
| V144 | Nine mutations each fail the tests aimed at them, and the control passes 59 tests: setup projects with no `outputDir`; every run owning the cell's folder; a relative report folder (every config build stops); `reporters()` accepting one; a relative `storageState`; cell names with uppercase, with a leading `_`, or unchecked; unit runs back in the root. The gates: typecheck, lint and format clean; unit 1272 passed, 8 skipped (1256 before) | ✅ 2026-10-06 | `mutate-0a2.sh`, a copy of the worktree per mutation, five specs |
| V145 | Playwright 1.63.0's `--project` filter lowercases both sides, turns each `*` into `.*` and escapes every other metacharacter (the same `escapeRegExp` as ours); an exact name that matches nothing throws "Project(s) … not found", a wildcard throws only when the whole selection matches nothing. `matchesProjectFilter` selects exactly what `projectUtils.filterProjects` selects for 15 filters over 5 project names | ✅ 2026-10-06 | `runner/index.js:2137–2177`, `coreBundle.js:560`; `cell-pin.spec.ts` loads the installed filter (`playwright/lib/runner`, an exported path) |
| V146 | `bddgen` for BackWPup, inode check: unpinned rewrote all 10 `free@nginx` and all 12 `pro@nginx` specs; pinned to `pro@nginx` it rewrote its 12 and kept all 10 of `free@nginx`; pinned to `free@nginx`, the mirror image | ✅ 2026-10-06 | `inodes.sh` (`stat -f %i` before and after) |
| V147 | Two wp-rocket cells (`apache`, `nginx`, placeholder sites) started together through `npm run test:wp-rocket -- --grep @noauth`, 40 iterations each way, same machine, back to back: **pinned 0 of 80 failed**; the `--project` form 4 of 80, each `ENOENT … lstat '.features-gen/wp-rocket/nginx/…/smoke.feature.spec.js'` (one an `apache` run crashing on `nginx`'s spec) | ✅ 2026-10-06 | `batch.sh pinned 40`, `batch.sh unpinned 40`; reports and output kept out of the checkout |
| V148 | The refusals, measured: an unknown pin stops `npm run test:backwpup` in `bddgen` (exit 1, Playwright never starts) naming the cells; a pin in the working directory's `.env` with `--project=free@nginx` exits 1 naming `E2E_CELL` and `.env`; `--project=artifacts:pro@nginx` under that pin lists 1 test. In a child Node without Playwright's loader, playwright-bdd keys its configs by the BDD `outputDir` resolved against the working directory | ✅ 2026-10-06 | `envpin.sh` from a temporary folder; `unknown-pin*.log`; `project.spec.ts` failure before the fix |
| V149 | Unpinned behaviour unchanged: `--list` for no `--project`, `apache`, `nginx`, `setup:apache` and `*` is identical before and after but for the new `[cell]` line; CI's two smoke commands on placeholder sites, HEAD against the working tree: wp-rocket 6 passed / 4 skipped and backwpup 4 / 4, exit 0, both times | ✅ 2026-10-06 | `lists.sh base` (before any change) and `lists.sh after`, diffed; `ci-smoke.sh` (`git archive HEAD` vs a copy, sites files removed) |
| V150 | Fifteen mutations each fail the tests aimed at them, and the control passes 65 tests: the pin ignored by `selectedCells`; every cell built when pinned; an unknown pin or a stray `--project` accepted; the filter case-sensitive or unescaped; a pinned run with no `--project` not owning its folder, or a setup project alone owning it; `outputDir` from the selection instead of ownership; a blank pin pinning; the pin trimmed; the notice after `list`, never "pinned", claiming the terminal or ignoring `--workers`. The gates: typecheck, lint and format clean; unit 1306 passed, 8 skipped (1272 before) | ✅ 2026-10-06 | `mutate.mjs`, a copy of the worktree per mutation, five specs |
| V151 | Live, `E2E_RETRIES=0`: `free@nginx` (`bwu2`) and `pro@nginx` (`bwu3`) pinned and started together on `cli-backups.feature` — 6 passed each (both setups, 4 scenarios), exit 0, 5.4 min side by side; each printed its `[cell]` line, pinned. Afterwards both sites had no BackWPup plugin, option, table or staging left; `bwu3` held 4 `uploads/backwpup-restore-<id>/` folders, one per scenario (V153) | ✅ 2026-10-06 | `live-pair.sh`; `site-state.sh` before and after |
| V152 | Live full passes, pinned, `E2E_RETRIES=0`, one after the other: `free@nginx` **54 passed** (56 min); `pro@nginx` 51 passed, **12 failed** (1.2 h) — 5 of `backups.feature`, 6 of `onboarding.feature`, 1 of `cli-running-job.feature`, every one on the restore-folder fatal of V153 and no other. The control, the same `backups.feature` run **unpinned** with `--project=pro@nginx`, fails the same 5 scenarios on the same fatal (and its `[cell]` line names the `--project` form and the pin): the failures are the product's, not the pin's. Afterwards, on both sites: no BackWPup plugin, option, table or staging left | ✅ 2026-10-06 | `live-full.sh`, `control-unpinned-pro.log`; `site-state.sh` |
| V153 | **BackWPup `develop` moved to `ab4a2e2`, which tokenizes the restore working folder** — not caused by 0A.1. It is now `uploads/backwpup-restore-<20 hex>` (`commons.php:48–106`, `:164`; the token is the per-site option `backwpup_restore_dir_token`, the fixed `backwpup-restore` kept only as a legacy sweep target), holding `.htaccess`, `Web.config`, `index.php`, `uploads/` and `restore.dat`. This branch, before merging develop, opened and cleared only the fixed folder (`BACKWPUP_SITE_RESIDUE`, `prepareSiteDataDirs`), so whichever user creates the new one first locks the other out: created by the web server (`www-data`, 755), Pro's `wp backwpup backup` dies "Restore working directory … is not writable"; created by WP-CLI (`ubuntu`, 775), the web server's requests die the same way and the history never loads. All 12 Pro failures in V152 carry that fatal and no other. The folders also pile up: 28 `uploads/backwpup*` entries on `bwu3`, 7 on `bwu2` (Free, all `www-data`, no failure) after V152; one was on `bwu3` before this session. Already fixed on the suite's `develop` (`cd9b146`); merged here, V154 | ✅ 2026-10-06 | `.artifacts/…/backwpup-pro-en-9.99.99-ab4a2e28.zip`; `find -printf`, `ls -ld` on both sites; the 12 `error-context.md` |
| V154 | After merging `origin/develop` (`43f801a`, in `de2633b`; no conflicts, no edits inside the merge): the gates clean, unit 1488 passed, 8 skipped. Live, pinned, `E2E_RETRIES=0`, the three features that failed in V152 on `pro@nginx` — the filter `backups.feature` also took `cli-backups.feature`, so four ran, 24 tests: 23 passed, 1 failed — the first scenario, whose teardown passed 120 s while sweeping the 28 folders V152 had left; alone, right after, it passed in 2.2 min. Every other scenario that failed in V152 passed. One Free scenario then swept `bwu2`'s 7. Afterwards both sites: no plugin, option, table, staging or `uploads/backwpup*` entry left. Observation: a teardown that inherits many such folders can outrun its budget — once | ✅ 2026-10-07 | `fix-pro.log`, `fix-pro-rerun.log`, `fix-free.log`; `site-state.sh` |
| V155 | Before the audit fix, an inherited seed `["free@apache"]` with `E2E_CELL=pro@nginx` and no `--project` failed "--project … selects nothing"; unpinned, it sized the run and filed its report as `free@apache` while Playwright ran every project. Playwright forks its workers and its out-of-process loader from the runner (`runner/index.js:1915`, `:2092`, `:5451`) and never re-executes itself. After: an old-style or another run's seed changes nothing (pinned: the cell's 5 tests; unpinned: serial, all 10), and in a real `--project=apache` run every worker-written trace lands in `test-results/…/apache/`, not `_all` — workers still read their runner's seed | ✅ 2026-10-07 | the logic review's repro; `audit-probes.sh` 1a–1c, 5 |
| V156 | `program.js:51–53`: arguments after `--` are test filters. Before: `E2E_CELL=pro@nginx … -- --project=free@apache` failed with the pin's refusal; after: the pinned 5 tests are listed | ✅ 2026-10-07 | the logic review's repro; `audit-probes.sh` 2 |
| V157 | `bddgen` generates every config in an inherited `PLAYWRIGHT_BDD_CONFIGS` (`cli/commands/test.js`, `config/env.js:72–83`): pinned to `free@nginx` with an unpinned run's value, it rewrote all 11 + 14 specs of both cells. After: exit 1 naming the variable and `backwpup/pro@nginx`, and 0 of 25 rewritten. A pinned run's own value, handed to its workers, passes (spec: runner → worker build) | ✅ 2026-10-07 | `inherit-bdd.sh` before and after; `project.spec.ts` |
| V158 | Playwright's "Running … using N workers" counts `metadata.actualWorkers` = min(workers, test groups) (`runner/index.js:1182`, `:6547`); with workers 4 and one test the notice said "4 workers" beside "using 1 worker". After, `--workers=4` on wp-rocket's pinned smoke: "2 workers" in both lines | ✅ 2026-10-07 | the tests-and-docs review's probe; `audit-probes.sh` 4 |
| V159 | The sweep's cost, before: 1 + 4(N+2) + 2S commands for N family members and S survivors (the merge review's harness: 173 for N=28) at ~0.78 s each on `bwu3` (`exec`, `execElevated`, `readlink -f`, n=10 each). The 28-leftover teardown hit 120 s; the next needed 59 s; normal ≈ 23–24 s. After: the same commands for 1 leftover as for 30 (spec, PATH shims), one privileged `rm` for 5 stuck members. Facts the design rests on, measured on GNU (`bwu3`: coreutils 9.4, findutils 4.9.0) and BSD (macOS 26.7): `find -H … -type d` never lists a linked member and follows a linked parent; `readlink -f` with several operands drops the ones it cannot resolve (so it is not batched) | ✅ 2026-10-07 | allure step timings of the overrun; `latency.mts`; `find-h-probe.sh`, `find-h-gnu.sh`, `bsd-probe.sh`; `residue.spec.ts` |
| V160 | Live on `pro@nginx` with 35 leftover family folders planted (30 `www-data` 755, 5 `ubuntu`, each with a `restore.dat`): the scenario passed, its teardown took **20.3 s**, and `bwu3` was left with no `uploads/backwpup*` entry, plugin, option, table or staging | ✅ 2026-10-07 | `plant-leftovers.sh`; `sweep-live.log`; allure; `site-state.sh` |
| V161 | Fourteen mutations each fail the tests aimed at them, and the control passes 134 tests: the seed believed from any process; a runner keeping an inherited seed; `--project` parsed after `--`; short flags eaten; inherited BDD configs unchecked; the own config counted as foreign; keys compared whole; `actualWorkers` ignored; the multi-cell fail-fast off; the selection unfiltered; one `rm` per target; a failed re-list read as gone; declared paths or family parents not resolved. The gates: typecheck, lint and format clean; unit 1506 passed, 8 skipped (1488 before) | ✅ 2026-10-07 | `mutate-audit.mjs`, a copy of the worktree per mutation |
| V162 | After the audit fixes, full passes, pinned, `E2E_RETRIES=0`: `free@nginx` **55 passed** (1.4 h), `pro@nginx` **72 passed** (2.0 h), restore features included, exit 0 both. Afterwards both sites: no BackWPup plugin, option, table, staging or `uploads/backwpup*` entry; 25 GB free | ✅ 2026-10-07 | `live-full.sh`; `site-state.sh` |
| V163 | `util.parseEnv` reads a file as `process.loadEnvFile()` does — a duplicate's last value, `export`, quotes, multi-line values, comments, a blank real variable still winning — but not in the file's order. On a directory `loadEnvFile` throws `ERR_INVALID_ARG_TYPE`, `readFileSync` `EISDIR` | ✅ measured, Node 24.21.0 | A scratch `.env` through both |
| V164 | The real `load-env.ts` through a Playwright runner and 2 workers (4 tests): by default every process holds `.env`'s key; `false` and `0`, none — the environment's own value kept; a typo fails the run naming it (exit 1); a valid switch in the file, one warning and the file loaded; an invalid one, a warning per process (runner, 2 workers), the file loaded, no throw; `.env` a directory, the run fails naming it; no `.env`, nothing | ✅ 2026-10-08 | A scratch config importing the real module, `env -i` |
| V165 | `bddgen` (`playwright.backwpup.config.ts`, pinned to `free@nginx`): `E2E_LOAD_DOTENV=nah` stops it naming the value (exit 1); `false` generates (exit 0) | ✅ 2026-10-08 | The worktree |
| V166 | Seven mutations each fail the tests aimed at them: the switch ignored; the file overriding the environment; an invalid switch set; a missing file thrown; read errors swallowed; no warning; the switch unreported. Gates: typecheck, lint and format clean; unit 1527 passed, 8 skipped (1506 before) | ✅ 2026-10-08 | Mutations applied in place, restored from a copy |
| V167 | On a file `toString=t / constructor=c / A=1`, `loadEnvFile` set all three, the first implementation only `A` (`"toString" in process.env` is true, `Object.hasOwn` false — and true for a blank real variable). A dangling `.env` link: `readFileSync` → `ENOENT`, `lstat` finds it. Both fixed and specified | ✅ 2026-10-08 | Probes beside both loaders; `dotenv.spec.ts` |
| V168 | Thirteen mutations each fail the tests aimed at them: `load-env.ts` or `loadDotenv`'s default swallowing read errors; the error's `cause` dropped; the inherited-member presence test; a dangling link read as absent; `intEnv`'s lower bound; the old `requireEnv` message and warning advice; and V166's seven again | ✅ 2026-10-08 | `mut.py`, the sources restored after each |
| V169 | From a folder whose `.env` holds `REPORT_ROOT=myreports`, both report scripts look under `myreports/`, and under `reports/` with `E2E_LOAD_DOTENV=false`; under plain `node` they now fail (`ERR_MODULE_NOT_FOUND`), so the npm scripts run them with `tsx`; `npm run report:allure -- backwpup free@nginx` still generates (exit 0) | ✅ 2026-10-08 | Scratch folder; the worktree |
| V170 | A `.env` holding only `E2E_LOAD_DOTENV=false`: `E2E_CELL=free@nginx npm run test:backwpup -- --list` prints the warning twice (`bddgen`, the runner). The real-runner probe after the fixes: as V164; `=true` in the file warns once; a dangling link fails the run naming it | ✅ 2026-10-08 | The worktree (the `.env` removed after); the scratch config |
| V171 | Gates after the audit: typecheck, lint and format clean; unit 1531 passed, 8 skipped | ✅ 2026-10-08 | The worktree |
| V172 | 0D.2 + 0B.2 unit layer: `pin.spec`, `digest.spec` (FIPS 180-2 vector, empty file, 1 MiB + 1 B against an in-memory hash), `consume.spec`, `resolve.spec` (`builtArtifact`, a provided zip's digest), `verify.spec`, `warm.spec` (`toWarmedBuild`). Four mutations each fail the tests aimed at them: `commitShort` recorded (2 fail), no hash (3), a malformed digest accepted (7), release selectors pinned (4). Gates: typecheck, lint and format clean; unit 1578 passed, 8 skipped | ✅ 2026-10-08 | The worktree; mutations applied in place and restored from copies |
| V173 | A warm of `develop` for `pro@nginx` (73.6 s, "warmed") returns `commit:1dceea896639a7665a04edb7f90cf7dbc60b4ba6`, version 9.99.99 — equal to `git ls-remote`'s `refs/heads/develop`. A warm of `release:latest-stable` for `free@nginx` pins `release:5.7.7` | ✅ 2026-10-08 | `npm run artifacts:warm -- --product=backwpup --cell=…` |
| V174 | `artifacts:pro@nginx` pinned to that commit: `origin=cache`, `commit` the full SHA, `sha256` equal to `shasum -a 256` of the zip, in `resolution.json` and the Allure attachment. `artifacts:free@nginx` on `release:latest-stable`: `origin=downloaded`, no `commit`, `sha256` equal to `shasum`; pinned to `release:5.7.7`: `origin=cache`, the same `sha256`. Both cells ran at once; the setup alone never touches a site. (Its later proxy check — no connection for either pin — was blind to APVM's API client: V175) | ✅ 2026-10-08 | `E2E_CELL=<cell> E2E_PLUGIN_REF=<pin> npm run test:backwpup -- --project=artifacts:<cell>` |
| V175 | APVM's GitHub API client bypasses `HTTPS_PROXY`: through a logging CONNECT proxy, pinned `commit:` and `release:` runs logged nothing, while the same `release:5.7.7` run fails under `sandbox-exec` with `GitHub API error: Service Error: client error (Connect)`. The proxy sees git (`develop`, `tag:latest-stable` → `github.com`) and a cold release download (`api.github.com`, `release-assets.githubusercontent.com`) | ✅ 2026-10-08 | `proxy.mjs`; `sandbox-exec` with `(deny network-outbound (remote ip "*:*"))`, which refuses `curl` |
| V176 | With all outbound network denied: BackWPup `commit:` pins of `develop` and of tag 5.7.7 with version 9.99.99 and their variant → cache hits (7–9 ms); WP Rocket `commit:3a96b66…` without a version → "Detecting version", then a clone that fails; with `3.23.5.1` (its built version) → cache hit; `release:5.7.7` → fails on the API. The whole pinned suite run (`bddgen`, the runner, the artifacts setup) passes sandboxed; the release pin's fails, naming the API error. APVM `cli/v3.0.0`: `resolve_commit` tolerates an API error with the SHA kept; `try_cache_fast_path` needs the version or `detect_version_pre_clone` | ✅ 2026-10-08 | `pinned.mts` (`apvm.build`); `E2E_CELL=… E2E_PLUGIN_REF=… E2E_PLUGIN_VERSION=… npm run test:backwpup -- --project=artifacts:<cell>` under `sandbox-exec`; `crates/core/src/commands/build.rs`, `git/resolver.rs` |
| V177 | Warms with the final code: `develop` → `pin: ref commit:1dceea89…, version 9.99.99`; `release:latest-stable` → `pin: ref release:5.7.7 (no version…)`; a `tag:latest-stable` warm pins `commit:850263d6…`, `git ls-remote`'s commit for tag `5.7.7`; WP Rocket `develop` (through `createApvmWarmer`) → `commit:3a96b66…`, and building that pin is a cache hit with the same bytes. A `release:latest-stable` run records `pinRef: release:5.7.7` (`pin=` in the summary) | ✅ 2026-10-08 | `npm run artifacts:warm`; `probe.mts`; `resolution.json` |
| V178 | Mutations, each failing the tests aimed at it: 4 the review found surviving (hash the source; `fromCache`, `gitRef`, `sourceValue` mapping; writer dropping `commit`; `pinRef` order) and 15 on the fixes — commit before release (7 fail), case-sensitive selectors (2), no pin version (2), `assertCached` ignoring missing or empty (1, 1), the writer, parser or `builtArtifact` dropping `pinRef` (1, 3, 3), the info line always or never naming `pin` (1, 1), the warmer skipping `assertCached`, its redaction, its variants or its token check (1 each). Hashing the source survives by design (removed claim) | ✅ 2026-10-08 | Mutations applied in place, restored from copies |
| V179 | APVM `cli/v3.0.0` (the source the reviews read) has the installed darwin-arm64 binary's SHA-256; the local APVM checkout is at `cli/v3.2.0-6`, so the source was read at the tag | ✅ 2026-10-08 | `git show cli/v3.0.0:…`; the review's binary digest |
| V180 | Gates after the audit: typecheck, lint and format clean; unit 1596 passed, 8 skipped | ✅ 2026-10-08 | The worktree |
| V181 | Playwright 1.63 / playwright-bdd 9.2.1: a skip thrown by an automatic test fixture runs no `beforeEach` (so no Before hook) but still runs `afterEach` (the After hooks) with the fixtures it asks for; a retry is unaffected; the skip's annotations reach the JSON and Allure reports | ✅ lab + measured | A scratch spec (`retries: 1`, a stop file written by the first test); a placeholder `wp-rocket/apache` run with a stop file: 3 scenarios skipped as `stopped`, exit 0; a relative path fails at config load naming the variable |
| V182 | Unit: the drain policy (12 cases: unset/blank/relative/padded paths, retry 0/1/2, the filesystem untouched when the answer is decided) and the Before path's stop (order after the log clear and before the removal, an absent plugin, the report, a stop that fails touching nothing). Mutations: the stop moved after the install fails 3; the retry gate dropped fails 1. Gates: typecheck, lint, format clean; unit 1612 passed, 8 skipped | ✅ 2026-10-08 | `config/drain.spec.ts`; `hooks/plugin-lifecycle.spec.ts` |
| V183 | **L2 live**: the drain lets the scenario in flight finish, skips the rest as `stopped`, exits 0 with every report written, and leaves the site as found | ✅ live 2026-10-08 | §5.1, `bwu2` |
| V184 | **V50 closed**: after a SIGKILL of the group, the Before path finds the job still running and stops it before the removal (6.5 s); the install then took 73.4 s beside another run on the server — which, with the stop's ~70 s worst case, overran the 120 s hook (V185) | ✅ live 2026-10-08 | §5.1, `bwu3` |
| V185 | The Before hook's worst case — BackWPup's stop (30 s + 30 s + probes ≈ 70 s) beside a 44–73 s install — exceeded its 120 s; playwright-bdd's hook timeout is a `Promise.race` that leaves the hook running. Fixed with a 90 s allowance (Before 210 s), held to by a spec on BackWPup's budgets | ✅ source + measured | `playwright-bdd/dist/utils/index.js` `callWithTimeout`; `job-runs.ts` `STOP_BUDGETS`; §5.1 |
| V186 | Playwright sets up its context options (our `storageState` override) before our automatic fixtures; a throwing override then fails a drained scenario, the late gate cancels its After hooks, and the retry is reported skipped unrun ("flaky"). Fixed by `storageState` depending on `drainGate` | ✅ lab + probe | Scratch spec with a throwing `storageState`; a placeholder `@plugin` probe before and after |
| V187 | A worker fixture failing during a drain read "flaky" (failed, retry skipped unrun); with the gate skipping only an attempt still `passed`: failed, failed | ✅ lab | Scratch spec with a throwing worker fixture |
| V188 | `"/tmp/stop "`, `"/tmp/stop\n"` and a missing folder were accepted; now refused, and an unsearchable folder too — `existsSync` reads a file in it as absent (asserted in the spec) | ✅ measured | `drain.spec.ts`, `project.spec.ts` |
| V189 | Mutations: the After hook's early return, the `storageState` ordering, gating retries, a gate that never skips — each fails `drain.run.spec.ts` (2 s, network-free); the stop-file checks, the factory's call, the allowance, the late-gate rule and BackWPup's budget fit each fail their unit spec | ✅ 2026-10-08 | 12 mutations, each restored |
| V190 | A drained scenario: result `skipped`, `errors: []`; its "Before Hooks" step carries `Test is skipped: …` as an error (reporter API and Allure) | ✅ lab + live | Step reporter; L2's Allure results |
| V191 | Live on the final code: L2 drains as before; L3'' stops a killed run's job through the real Before hook (63.1 s); both sites as found. Gates: typecheck, lint, format clean; unit 1624 passed, 8 skipped | ✅ live 2026-10-08 | §5.2, `bwu2`, `bwu3` |
| V192 | Every real run's reports hold the login password: the auth setup's `Fill "<password>"` step in its Allure result and in the HTML report's embedded data — 2 locations per run (two reports scanned); none in the Cucumber report or a passing run's `test-results/` | ✅ measured | A scan by count, never printing the value: `bwu3`'s L3'' report, `bwu2`'s of 2026-10-06 |
| V193 | A failed scenario's retained trace, copied into the HTML report's `data/`, holds the WordPress session cookies: `wordpress_logged_in_…` ×95, `wordpress_sec_…` ×24 | ✅ measured | `reports/backwpup/free@nginx/2026-10-06T03-20-53-829Z-10230` |
| V194 | Playwright 1.63 titles `Fill`/`Type`/`Insert` with the value (`renderParams`) and passes it in the step's params; `box: true` hides nothing; no masking API — the docs say to treat traces and reports as sensitive | ✅ source + lab + docs | `playwright-core` `coreBundle.js` metainfo; Context7 `/microsoft/playwright/v1.63.0` |
| V195 | Entering by `evaluate` leaves no reporter title or param and no Allure entry; the trace keeps the value in the next action's DOM snapshot and in `inputValue()`'s result; `evaluate` + an in-page check + `snapshots: { dom: false }` leaves reporter steps, Allure and trace clean | ✅ lab | Scratch specs with a canary value, scanned per channel |
| V196 | Phase 0.5 ships no report off the server: Datator gets counts, names, statuses and first errors; Slack an `scp` path | ✅ source | Phase 0.5 plan §2 |
| V197 | Site Health's copy text on `bwu2`: one button, 6,524 bytes, 13 sections, the format of `WP_Debug_Data::format()` (backtick lines, `### section (N) ###`, tab-indented list lines) | ✅ live 2026-10-09 | A scratch login and read, printing structure and whitelisted lines only |
| V198 | The parser, terminal line and best-effort read: 18 specs (sections, list lines, CRLF, `undefined`, no text; the page object's role/name, both permalink forms aborted, two buttons, an empty attribute) | ✅ unit | `site-info.spec.ts`, `site-health.page.spec.ts` |
| V199 | Live, both cells: `[site] … WordPress 7.1.3 · PHP 8.5.11 64bit (fpm-fcgi) · nginx/1.24.0 · database 8.0.46-0ubuntu0.24.04.4 (mysqli)`, and the same six values in `site-info.json` in Allure's results | ✅ live 2026-10-09 | `free@nginx` and `pro@nginx` runs of 03:01Z |
| V200 | `enterSecret`/`holdsSecret`: value set, `input` then `change` bubbling, a value replaced, a read-only field and a `<div>` refused naming the element, never the value; the login suite unchanged (6/6, the focus race included); `fillSecret` on the captured S3 secret field | ✅ unit | `secret-field.spec.ts`, `login.spec.ts`, `locator-contract.spec.ts` |
| V201 | The setup project's trace is `{ mode: "retain-on-failure", snapshots: { dom: false } }`; the artifacts and scenario projects keep the run's | ✅ unit | `project.spec.ts` |
| V202 | Playwright 1.63 writes the page's accessibility tree into `error-context.md` on a failure, with every textbox's value — a password field's included — when a context is open at the test's end; `PLAYWRIGHT_NO_COPY_PROMPT` (read in `_takePageSnapshot`) turns it off | ✅ source + canary | `playwright/lib/index.js:657–674`; the canary before the fix: the password in `error-context.md` and its report copies |
| V203 | `storageState()`'s result is a traced call: the cookie value is in `1-trace.trace` with DOM snapshots off; with them on it is in the network entries too | ✅ canary | The canary's trace entries; the "DOM snapshots on" mutation |
| V204 | A `teardown` project runs after its setup's dependents, also when one fails or a sibling setup fails, and with `--project=setup:<cell>` alone; not with `--no-deps`, and **not after a SIGINT** | ✅ lab | A scratch config, six selections and one SIGINT |
| V205 | Live, both cells: today's saved logins were live (wp-admin 200) before the run and dead after its setup (302 to `wp-login.php`); the new ones live. Each run's report folder and `test-results/` hold the password 0 times and each token 0 times; the healthcheck logs in 2/2 through `enterSecret` under `tsx`. A report of 2026-10-07 still holds the password in V192's two places (the scan works on real reports) | ✅ live 2026-10-09 | A scratch probe counting matches, never printing values |
| V206 | The canary passes; each fix undone fails it: the password by `fill()`, DOM snapshots on, the failure snapshot on, a failed setup keeping its sessions | ✅ mutation | `secrets.run.spec.ts`, four mutations |
| V207 | Live failed setup (a temporary overlay cell: `bwu2`, then `bwu2` with a wrong password): the first session saved, the second login rejected, "ended this run's session, as the setup failed"; that session dead; its report and trace hold the password 0 times, the token only in the trace's call log, and `error-context.md` no page snapshot. Overlay, auth file, report and output removed after | ✅ live 2026-10-09 | `probe@nginx` run of 03:05Z |
| V208 | Gates on the final code: typecheck, lint and format clean; unit 1676 passed, 8 skipped | ✅ 2026-10-09 | The four gates |
| V209 | A setup worker's changed variables reach its dependent projects' workers (`__env_produced__` diffs the environment at `__stop__`, before worker fixtures tear down); set at a setup file's top or in its test, `PLAYWRIGHT_NO_COPY_PROMPT` reached the scenario worker, whose failure snapshot was then missing | ✅ source + lab | `common/index.js:1913–1934`, `runner/index.js:6556–6576`; a two-project lab |
| V210 | Turned off in `beforeEach`, back on in `afterEach` only for a test that ended as expected: a passing setup leaves the scenario its snapshot (variable unset); a throwing and a timed-out setup write no page snapshot. Restored in `afterAll` instead, the failed setup's snapshot printed the value | ✅ lab + canary | Three-mode lab; `secrets.run.spec.ts` |
| V211 | No WP-CLI call has a time limit; the setup's per-site budget (60 s) could be spent by the versions read (2 × 30 s) — now 20 s shared, session ends 20 s each, and 60 s more per site in the setup's timeout | ✅ source + unit | `exec.ts`; `authenticate.spec.ts` (a hung `wp` cut off at 0.2 s), `site-info.spec.ts` (shared deadline) |
| V212 | WordPress answers 403 to a user who may not view Site Health; a 404 or 403 now fails the read in 125 ms instead of 20.1 s | ✅ source + unit | `wp-admin/site-health.php:48` on `bwu2`; `site-health.page.spec.ts`, `authenticate.spec.ts` |
| V213 | A saved login for another host is ignored; a parent-domain cookie counts | ✅ unit | `session.spec.ts`, `authenticate.spec.ts` |
| V214 | The cells' auth cookies: host-only, value `login|expiration|token|hmac`, token 43 alphanumerics, HMAC 64 hex — the shape now matched, whatever the cookie's name | ✅ live | `bwu2`'s saved login (lengths and classes only) |
| V215 | PHP 8.1's `setcookie` sends a space as `%20`, a `+` as `%2B`, `|` as `%7C` | ✅ measured | PHP's built-in server and `curl -D -` |
| V216 | `wp --skip-plugins` still includes the mu-plugins (`get_included_files()` on `bwu2`); `session_token_manager` is `WP_User_Meta_Session_Tokens` on both cells, plugins loaded or skipped | ✅ live | WP-CLI on `bwu2`, `bwu3` |
| V217 | `enterSecret` refuses a hidden field; a React-style tracker sees its change and ignores a plain assignment | ✅ unit | `secret-field.spec.ts` |
| V218 | `evaluate`'s argument is in no trace entry; with DOM snapshots on, the value appears once, from the snapshot | ✅ lab | A two-project lab scanning trace entries |
| V219 | With `snapshots: { dom: false }` every `.network` entry is empty and no resource is kept — in a lab and in the live failed setup's trace | ✅ lab + live | Trace entry sizes |
| V220 | `WP_Session_Tokens::get` returns `null` for an unknown or expired session (`is_still_valid`), `destroy` unsets that verifier alone | ✅ source | `class-wp-session-tokens.php:82–85, 172–175, 202–204`, `class-wp-user-meta-session-tokens.php:61–64, 74–80` on `bwu2` |
| V221 | Site Health's Info tab at the setup's viewport shows collapsed sections; the "Database username" row is in the DOM, not visible | ✅ live | A screenshot of `bwu2`, viewed |
| V222 | Each audit fix undone fails a test: the switch restored after any outcome (2 failed), set for the whole process (1), the value set through the element's setter (1), any cookie domain (3), no budget on ending a session (1), the button wait's own budget (1), HTTP errors unchecked (2), `+` not a space (1), base64 at one alignment (1), a hidden field accepted (1) | ✅ mutation | Ten mutations |
| V223 | Live after the fixes, both cells: previous sessions dead, new ones live, the password and tokens 0 times in each report and `test-results/`; the failed-setup probe again: its session dead, password 0 times, the token only in the trace's call log, no page snapshot, empty network entries; overlay and its files removed | ✅ live 2026-10-09 | Runs of 03:40Z and the `probe@nginx` run after them |
| V224 | Gates after the audit: typecheck, lint and format clean; unit 1705 passed, 8 skipped | ✅ 2026-10-09 | The four gates |
| V225 | Step trees (Playwright 1.63, playwright-bdd 9.2): a Gherkin step is a `test.step` titled with its keyword; a Background's steps sit under `Before Hooks › Background`; a hook's error on `Before/After Hooks › BeforeEach/AfterEach Hooks › <hook>` (named hooks titled by name); a fixture's on `Before Hooks › Fixture "<name>"`; a hook timeout on `BeforeEach Hooks`, none on the hook; a step timeout and a crash leave no step error; a skip puts `Test is skipped: …` on its step | ✅ lab | Two probe runs, 15 scenarios, a step-tree reporter |
| V226 | Every reporter's options carry `_mode` — `list` under `--list`, else `test` — and `configDir`; nothing else tells `--list` from a run interrupted before its first test | ✅ source + run spec | `runner/index.js:5195–5260`; `results-stream.run.spec.ts` |
| V227 | `willRetry` is `outcome() === "unexpected" && results.length <= retries`; `outcome()` sets interrupted and skipped attempts aside | ✅ source | `runner/index.js:1295`, `:605–631` |
| V228 | Through the real runner, offline: every outcome attributed (step, After hook by name, flaky's retry, drained with no error), counts and `didNotRun`; SIGINT → the attempt `interrupted`, `run.end interrupted`, `■ INTERRUPTED` last; SIGTERM → complete lines only, no `run.end`, no summary; both setups failing → two `setup.end failed`, 6 did not run, `✘ COULD NOT TEST`; `--list` → `mode: "list"`, no summary | ✅ run spec | `results-stream.run.spec.ts`, 5 cases, ~15 s |
| V229 | Each rule undone fails a test: the interrupted-attempt guard, an error for a skipped scenario, the summary's `--list` silence, the stream left out of `reporters()`, the Gherkin step's precedence, the cut at a non-reportable step, the `drained` flag, the interrupted verdict (8 mutations); a limit shorter than the cut marker was a real bug, fixed | ✅ mutation | Eight mutations |
| V230 | Live, both cells at once (`--grep "Deleting (a deactivated|an active) plugin"`): every attempt streamed and attributed — a failed assertion to its Gherkin step, `SiteDbResidueRemovalFailedError` to `Before Hooks › BeforeEach Hooks › install the plugin under test`; `run.end` counts match; the summaries name `BackWPup Pro 9.99.99 · develop @ 1dceea8966` and `https://bwu3… · WordPress 7.1.3 · PHP 8.5.11 64bit` (`pro@nginx`: ✔ PASSED, 3.3 min), and BackWPup 9.99.99 on `bwu2` (`free@nginx`: ✘ FAILED, 6.5 min). That failure is not 0E's: a copy of the last commit without 0E (`git archive HEAD`) fails the same scenario the same way — BackWPup Free (develop @ 1dceea8966) leaves ~25 options after its deletion on `bwu2`, where it passed on 2026-10-06 and -07. Reported, not investigated here | ✅ live 2026-10-12 | `live-0e-*` reports; the A/B run |
| V231 | Gates: typecheck, lint, format clean; unit 1803 passed, 8 skipped (the run spec included) | ✅ 2026-10-12 | The four gates |
| V232 | Lab on Playwright 1.63: a screenshot with no baseline fails and is never retried (1 attempt of 2 allowed); after a failed `beforeAll`, the next test is reported `skipped`, `expectedStatus` `passed`, `parallelIndex` −1, then retried; a runtime skip ends with `expectedStatus` `skipped`; a soft assertion's error is on its step. Before the fix: no `scenario.end` for the first, two for the second | ✅ lab | Dump reporter beside the stream; `results-stream.run.spec.ts` |
| V233 | The dispatcher retries a test in `_failedTests` (a failure, or a skip it imposed) not marked non-retriable, while `results.length < retries + 1`; `retryStrategy` defaults to `immediate` | ✅ source | `runner/index.js:5755–5775`, `:5861–5965`; `common/index.js:496` |
| V234 | A locator error's message quotes the element's markup, attribute values included (`value="s3cr3tAttr"`, 2 lines per attempt); after the fix the stream holds it only in an assertion's `Received:` | ✅ lab | The same lab, re-run |
| V235 | Site-reported text with an OSC 8 link, CR/LF, a tab, DEL and C1 printed raw by the summary; now one plain line | ✅ unit | `run-summary.spec.ts` |
| V236 | Each fix undone fails a test: the imposed-skip retry, the retries bound, settling (stream and summary), the call-log strip, the line resync, `plain()` (twice), the interrupted setup, the regular-file check (hung 10 min), the surrogate cut, the `..` folder, the `pinned` check, the quoted path (15 mutations) | ✅ mutation | Fifteen mutations, each restored |
| V237 | Through the real runner, offline, 6 cases: each run's stream ends every test once, before `run.end`, whose counts are the ends written; the no-baseline scenario ends `failed`, 1 attempt, `retryNotRun`, its error on the last step begun; nothing written into the repository | ✅ run spec | `results-stream.run.spec.ts`, ~19 s |
| V238 | Live after the fixes, both cells at once: `free@nginx` — 3 attempts, 2 `scenario.retry`, one `scenario.end failed` (BackWPup Free's leftover options, V230); `pro@nginx` — passed; both streams consistent, no call log, no ANSI; the summaries as before. Gates: typecheck, lint, format clean; unit 1827 passed, 8 skipped | ✅ live 2026-10-12 | `audit-0e-*` reports; the four gates |
| V239 | Live, both cells at once (`--grep "The version command names\|@smoke"`, `E2E_RUN_NAME`, `E2E_REQUESTED_REF=develop`): ✔ PASSED; every report leads with `backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · develop @ 1dceea8966 · WordPress 7.1.3 · PHP 8.5.11 64bit · <run name>` (Free: `BackWPup 9.99.99`) — the HTML document title, the Cucumber banner (the body's first element, above `#content`), Allure's name; Allure shows 8 of 15 Metadata | ✅ live 2026-10-12 | `live-0d1-normal-*`, `live-0d1-final-*` reports, rendered in Chromium |
| V240 | Each report's SHA-256 equals `shasum -a 256` of the zip in `.artifacts/` (Free `3f6fd5dd…6259`, Pro `bb348eaa…cb97`): in the HTML report's embedded data, the Cucumber banner, `environment.properties`, `run-facts.json` and the generated Allure report — 8 places per run; no site password anywhere in any report folder (scanner of `__fixtures__/secret-scan.ts`, zips and base64 included), no username in the three new outputs | ✅ live 2026-10-12 | Scans of the normal, SIGINT, SIGKILL and final runs |
| V241 | Live, ONE SIGINT to the runner 3 s into the scenario's Before hook, both cells: exit 130, group empty; `status: interrupted`, the title, banner and Allure name end `· INTERRUPTED`, the status entry `interrupted — stopped before it finished`; the teardown ran, the sites as found | ✅ live 2026-10-12 | `live-0d1-sigint-*` |
| V242 | Live, SIGKILL to the runner's group, both cells: `run-facts.json` and `environment.properties` stand, `status: running`, no `endedAt`, both setups `passed`, the plugin with its SHA-256; no HTML report, a 0-byte Cucumber file (V68); Allure generated from it is named `… · RUNNING` with the killed-run status; the next run ended the session it left | ✅ live 2026-10-12 | `live-0d1-sigkill-*`, then `live-0d1-final-*` |
| V243 | The sites as found after all eight runs: the same plugin list as the baseline (no `backwpup`/`backwpup-pro`), no BackWPup option, 19 tables (none `e2e_`/`bwpup`), no `.e2e_temp`, no `.e2e_content_copy`, no restore folder; disk 73 % before and after | ✅ live 2026-10-12 | WP-CLI and `ls` over SSH, before and after |
| V244 | Allure 3.18's own `parseProperties` (`@allurereport/reader`) reads back exactly what `toProperties` wrote, for keys and values with `=`, `:`, `\`, `#`, `!`, leading spaces, LF, CRLF, tab, U+00B7, an emoji, ESC, NUL and DEL | ✅ unit | `run-facts.spec.ts` |
| V245 | The Cucumber report (html-formatter 23.1) ends `</script>\n</body>\n</html>`; its messages escape `<` as `\x3C` and its bundle holds no `</body>`, so the file's last `</body>` is the document's; playwright-bdd puts its own assets before it | ✅ source | `CucumberHtmlStream.js`, `index.mustache`; playwright-bdd `reporter/cucumber/html/index.js` |
| V246 | allure-playwright 3.12.2 never empties its results folder and writes `environment.properties` only with `environmentInfo`; its writer replaces files by temporary file + rename. The HTML report reads `PLAYWRIGHT_HTML_TITLE` and `config.metadata` in its `onEnd`; its metadata panel lists other keys only with `#?show-metadata-other` — rendered, all 15 facts, `actualWorkers` hidden | ✅ source + rendered | allure-js-commons `ReporterRuntime.js:409–413`, `FileSystemWriter.js`; `runner/index.js:3479–3484`; `htmlReport/report.js` |
| V247 | Through the real runner, offline, 6 cases rendered in Chromium: a normal run (title, banner on top, Allure name and Metadata via `scripts/allure.mjs`), the rich mode's banner, failed setups (`COULD NOT TEST`, `resolution failed — …`, `site unknown: auth setup failed`, a banner with no scenario), one SIGINT (`INTERRUPTED`), a SIGKILL (`running`), `--list` (nothing written) | ✅ run spec | `run-facts.run.spec.ts`, ~26 s |
| V248 | Each rule undone fails a test (27 mutations): key escaping, non-ASCII escaping, the last `</body>`, the banner's escaping, the credential mask, an empty attachment erasing a record, pending → did not run, `INTERRUPTED`, the requested ref, the HTML title, an operator's title kept, publishing per setup, `--list`, the catch-all, stale metadata keys, settling, the banner splice, the 64 KB tail, the temporary file's removal, the grow-only splice, the placement before `html`, the digest parse and its check, the display-only variables, plain site and plugin facts, `escapeHtml`'s `&` | ✅ mutation | Each restored |
| V249 | Gates: typecheck, lint, format clean; unit 1895 passed, 8 skipped | ✅ 2026-10-12 | The four gates |
| V250 | A site's versions reached the title raw (only the entries were made plain); now every attached string is a fact's text as it is folded in — an OSC 8 link and a newline in a version are gone from the facts | ✅ unit | `run-facts.spec.ts` |
| V251 | "pending: … running" said a queued setup was running; now "pending: … not finished" | ✅ unit | `run-facts.spec.ts` |
| V252 | The Cucumber report has a dark theme of its own (`prefers-color-scheme: dark`, panel `#282a36`/`#f8f8f2`); the banner now uses those colours | ✅ source | html-formatter `main.css` |
| V253 | `spliceIntoTail`'s regular-file check survived its mutation: a FIFO reports size 0, so nothing is read and nothing blocks; removed, the FIFO spec kept | ✅ mutation | `report-files.spec.ts` |
| V254 | `scripts/allure.mjs` counted a run whose `allure-results/` held only the facts' properties (a `--list` run) as the newest; it now needs a `-result.json` — measured on a synthetic report root: the `--list`-like folder skipped, a later real one chosen | ✅ measured | Scratch report roots |
| V255 | Reporter placement: after `list`, before `html` — the HTML title and metadata set in this `onEnd` reach the report (rendered); the `[cell]` notice still prints first | ✅ rendered | V239, V247 |
| V256 | The final facts are written in `onEnd` (not `onExit`, as first planned): a kill between the two keeps them; `onExit` only splices the banner, after every report's `onEnd` | ✅ source + run spec | `run-facts.reporter.ts`; V247 |
| V257 | APVM 3.0.0's errors and events carry no token: 9 failure modes — fake `ghp_`/`github_pat_`/bare tokens online (missing branch, commit), offline under `sandbox-exec` (branch, commit, `release:`, `tag:`), the real token (missing branch, commit, release, PR); its clone URL has no user. git 2.43 (`ubuntu:24.04`) and 2.56 drop a URL's user and password from their own errors but print `?access_token=…` verbatim. Playwright 1.63's `page.goto` error quotes `http://u:<pw>@host/…` whole in its first line | ✅ measured | Scratch probe of `apvm-napi` with a throwaway cache; `git ls-remote`/`clone`; a `goto` probe |
| V258 | The summary printed a setup's error, a failed resolution's error and a site's `baseURL` unmasked; `results.jsonl`'s errors and the site-info attachment and `[site]` line likewise. Now masked by one `redactSecrets` (`text.ts`), before any cut | ✅ unit | `run-summary.spec.ts`, `results.spec.ts`, `site-info.spec.ts` (a real `goto` to a basic-auth URL), `text.spec.ts` |
| V259 | The facts' own pattern stopped at the first `@` (`https://u:p@ss@h` left `ss@h`) and had no token rule; the shared one masks to the authority's last `@`, a GitHub token and a credential URL parameter, idempotent, stateless across calls | ✅ unit | `text.spec.ts` |
| V260 | The URL pattern was quadratic (scheme tried from every `\b`): 40,000 characters of `a.` took 392 ms, 20,000 106 ms; with a lookbehind, 0.2 ms, 1 MB of base64 3.4 ms | ✅ measured + unit | Scratch timing; the linear-time spec takes 36 s with `\b`. Made after V265's runs; every masking case's output unchanged |
| V261 | Sinks: the `[cell]` notice holds product, cell, workers and report folder only; every stream error (`setup.end`, `scenario.retry`/`end`, `run.error`) passes `cleanMessage`; every fact `factText`; Allure's `--name` is the facts' title | ✅ source | `cell-notice.ts`, `results-stream.ts`, `results.ts`, `run-facts.ts`, `scripts/allure.mjs` |
| V262 | Surviving mutations before the audit: label escaping, the requested ref given to a `previous` role, a banner when `onEnd` never ran, factText's cut before the mask (its test's password lay past the cut) | ✅ mutation | Each with a test now |
| V263 | Each rule undone fails a test: 14 masking mutations (no-op, the stream, `displayText`, both cut orders, site-info's URL and error, first `@`, no parameter, no token, parameter word bound, `/` and space bounds, quadratic scheme) and 27 others (banner, escaping, settling, properties, labels, the reporter, `report-files.ts`); a retry's status given to a setup is equivalent — a due retry carries none | ✅ mutation | Each restored |
| V264 | Through the real runner, facts files that cannot be written (folders in their place) leave a passing run at exit 0 with its HTML title; with the catch rethrowing, the run fails | ✅ run spec + mutation | `run-facts.run.spec.ts` |
| V265 | Live, `free@nginx` and `pro@nginx` at once: normal runs (`audit0d1-*-normal`) passed, title, banner, properties and rendered HTML title right, `Plugin SHA-256` equal to `shasum` of `.artifacts/` (`3f6fd5dd…`, `bb348eaa…`); one SIGINT (`audit0d1-free-sigint`, exit 130) `INTERRUPTED` everywhere; SIGKILL (`audit0d1-pro-sigkill`) left `running` facts, a 0-byte Cucumber file, no HTML report; cleanup runs (`audit0d1-*-after`) passed; both sites as found (only `backwpup-helper`, no option, table, `.e2e_*`, restore folder or `debug.log`); disk 27 GB free | ✅ live | Run logs; `wp` over SSH before and after |
| V266 | Secrets in all six live runs' report folders and `test-results/` (zips, embedded data, traces, `error-context.md`, Allure results, Cucumber, `results.jsonl`, `run-facts.json`): 0 hits for both sites' passwords and the GitHub token, raw and base64. The site username (a common 4-letter word) appears as the auth setup's `Fill "<user>"` step in the HTML report's data and Allure's results — the login's deliberate `fill()`, at 5973f05 already — never in `run-facts.json`, the properties or the banner | ✅ live | `secret-scan.ts`'s `findSecret`; a whole-word scan for the username |
| V267 | The HTML report's metadata panel shows the facts only with `#?show-metadata-other`; `actualWorkers` stays hidden | ✅ rendered | Live `audit0d1-pro-normal` |
| V268 | Gates: typecheck, lint, format clean; unit 1908 passed, 8 skipped (1895 before the audit) | ✅ 2026-10-12 | The four gates |
| V269 | Outside 0D.1, noticed: `free@nginx`'s first attempt of "The version command…" failed on a PHP fatal — "Restore working directory …/uploads/backwpup-restore-<hex> is not writable" — and passed on retry; unchanged here | ℹ️ live | `audit0d1-free-normal` |
