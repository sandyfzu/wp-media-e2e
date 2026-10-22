# E2E Modernization Plan — `wp-rocket-e2e` → `wp-media-e2e`

- Status: Phases 0–5 done. **Next: Phase 7 — terminal output** (decided 2026-10-22), then **Phase 11
  — shared SSH server profiles** (open; scheduled after 7). The rest of Phase 6 (6H–6K) follows in
  the [phase-6 plan](phase-6-feature-porting-plan.md). Phase 10 open. Phase 8 dropped. Phase 9 moved
  to the [orchestrator plan](orchestrator-plan.md). WP Rocket's port starts after Phase 10.
- Merged in, both done: plugin artifacts (§7) and site file ownership (§8), formerly plans of their
  own.
- Baseline (reference only): `wp-rocket-e2e`, the legacy suite being superseded. Target: this repo.
- Scope: decisions, their reasons, verified external facts, limits and open work. The as-built
  description is in `docs/architecture/` (execution-model, plugin-artifacts, wordpress-automation),
  `docs/guides/` (configuration, authoring-tests), README and CLAUDE.md.

## TL;DR

- The suite runs Gherkin through the Playwright runner (`playwright-bdd`, not the Cucumber CLI) on
  ESM, Node 24 and strict TypeScript. Goal: match or beat the baseline in capabilities, reporting,
  maintainability and security, and add multi-product, multi-environment parallel runs.
- Porting means modernise, never copy 1:1: every capability is re-implemented with current
  Playwright idioms (web-first assertions, auto-waiting locators, fixtures, `storageState`), strict
  types and explicit errors. Coverage never regresses.
- Run model: a (product × cell) matrix. One Playwright invocation per run unit with `workers` = the
  cell's pool size, because `parallelIndex` is global per invocation (§2.1). One report per run
  unit, never merged. Products are separate; cells are data; credentials never enter report-bound
  metadata.
- The plugin zips under test are resolved, built through APVM and identity-verified per run (§7);
  files the suite installs on a site are handed back to the site's own owner (§8).
- Next: Phase 7 — terminal output for the suite and the orchestrator (below), then Phase 11 — shared
  SSH server profiles: a site may omit `host`, `username`, `privateKeyPath` and `port`, while
  `rootDir` stays per site. Phase 6 resumes at 6H after both; Phase 10 (dependency check, cleanup)
  and WP Rocket's port (parity matrix, §4) follow.

## 1. Core decisions

- D1 — Execution is a (product × cell) matrix with a site pool per cell: one Playwright invocation
  per run unit, `workers` = pool size. Reason: §2.1. Parallelism shipped in v1, not deferred.
- D2 — Products are fully separated: own BDD config, directories, sites file and reports; only
  `src/common/` is shared. No config bleed: BackWPup's storage config is invisible to WP Rocket.
- D3 — Cells are data (the top-level keys of a product's sites files), not an enum. `ssh`/`local`
  take any number; `docker` ships Apache + Nginx with a fixed PHP. Code iterates the keys.
- D4 — Each run unit produces its own report; no merging (`blob` + `merge-reports` deliberately
  unused). Different cells, editions included, land in different folders with no extra machinery.
- D5 — Server modes: `ssh` (default, the baseline's `external`), `docker` (Apache and Nginx),
  `local` (whatever the user runs). Why a custom compose: §2.9.
- D6 — Full reporting stack: Playwright HTML, the Cucumber HTML report (dual-mode, `REPORT_MODE`),
  Allure 3 (§2.8).
- D7 — The plugin lifecycle covers WP-CLI and the admin UI. Cleanup is idempotent (absent ⇒ no-op);
  deletion as the action under test asserts presence first (§2.10).
- D8 — Orchestrator-ready from day one: all isolation lives in the suite, so the orchestrator only
  automates running cells and adds nothing to the run model. The two gaps found later (`bddgen`
  rewriting every cell's specs, the shared root `test-results/`) were the orchestrator plan's 0A.1
  and 0A.2, done.
- D9 — BackWPup Free and Pro are one product; edition is a per-cell property. Same plugin and
  domain, ~90 % shared: a second product would duplicate the shared part or fake-share it (§2.6).
- D10 — Site credentials never enter Playwright `metadata`, which Playwright serialises verbatim
  into its reports; pools reach workers through an in-process registry (§2.2).

## 2. Design rationale

What only this plan holds; each section names where the as-built mechanics are described.

### 2.1 One invocation per run unit

Verified against Playwright's docs (test-projects, test-parallel, class-testinfo, class-workerinfo,
class-testproject):

- Projects multiply: several projects matching the same tests run every test once per project (the
  cross-browser model). That gives "Apache and Nginx".
- Workers distribute: the pool runs each test once, handing the next pending file to a free worker.
  That spreads a cell's scenarios over its sites.
- `testInfo.parallelIndex` (a stable, restart-safe slot in `0…workers-1`) is bounded by the global
  `workers` and not reset per project; maintainers corroborate it (microsoft/playwright#38953 shows
  indices beyond per-project worker counts). So `pool[parallelIndex]` is safe only when one project
  runs in the invocation with `workers` = pool size; two cells in one invocation overflow the
  smaller pool.
- Per-project `workers` (since 1.52) caps how many workers a project uses, not which `parallelIndex`
  values it sees, so it does not make a multi-cell invocation safe.

Hence one cell per invocation; selecting more fails fast; a cell-less run is serial (`workers = 1`)
and reports to an `_all` bucket. The matrix across cells comes from running cells side by side.

Example: 50 scenarios and two cells ⇒ 50 run on Apache and 50 on Nginx, each spread over that cell's
pool; two products × two cells are four run units, four reports.

As built: [execution-model.md](../architecture/execution-model.md), "Worker → site binding", with
the `E2E_CELL` pin that later made two cells of one product safe side by side.

### 2.2 Worker → site binding and credentials

- A worker-scoped fixture binds the worker to `pool[parallelIndex]` for its lifetime; `baseURL` and
  `storageState` derive from it. Steps never hard-code a URL or credential, so adding sites or cells
  never touches step code.
- The config factory registers each cell's pool in an in-process registry as a side effect of
  building the config. Playwright re-runs the config in every worker, so each worker resolves its
  own pool locally; `metadata` carries only `{ product, cell, edition? }`.
- The pool never reached a report. The login's `fill()` put the site password into every real run's
  reports until the orchestrator plan's 0D.4 (secrets now typed through `enterSecret`); a scenario's
  retained trace still holds session cookies (CLAUDE.md).

As built: execution-model.md, "Credential handling".

### 2.3 Artifact lifecycles

- Two lifecycles, decided by whether a history has value. History accumulates: reports, pruned as
  each run ends and by `report:prune` (the orchestrator plan's 0F); Allure's per-cell
  `allure-history.jsonl`, not pruned (its retention is open: the orchestrator plan, §4). Build
  output and transient state (generated specs, `storageState`, `test-results`) is overwritten in
  place, so it never piles up.
- Every path is keyed by `<product>/<cell>`, so different cells never share one. `*_ROOT` overrides
  replace only the root; the namespace is always appended, so an override cannot merge two cells.
- A cell runs with zero env vars: ephemeral paths follow from product and cell; `RUN_ID` only names
  the report folder (a sortable timestamp unless CI or an orchestrator passes a meaningful one).
- Reports are self-contained (each copies in its attachments), so emptying `test-results` never
  harms an older report. Cross-run trends come from Allure.
- The same cell never runs twice at once: its pool is shared WordPress state, and two runs would
  corrupt each other's database.

As built: execution-model.md, "Artifact directories & lifecycle" and "Report retention".

### 2.4 Scope and scaling

Everything shipped in v1: product separation, cells as data, pools, binding, per-cell reports,
isolation. A pool may be size 1 (serial within the cell, same machinery). Scaling a cell is data
only: add sites to a pool, or a cell key. A product is a folder plus its entry in `products.ts`, a
root `playwright.<name>.config.ts` and a `test:<name>` script (authoring-tests.md, "Adding a
product").

### 2.5 Products, sites files and service secrets

- Per-product Playwright entries sit at the repo root so every glob resolves repo-root-relative;
  each is a thin `createProductConfig(<product>)` call (authoring-tests.md, "Adding a product").
- Per-product structured sites files, not one flat `.env`: `process.env` is global to a process, so
  a different `.env` per product is impossible.
- Global service credentials (one external service per product, not per site) come from the
  environment; the committed config holds only their shape.
- A site may override a service credential in its own `overrides` block, validated at load with a
  path-named error — mostly to dodge per-host rate limits (FTP connection caps) when a cell runs
  many sites, or to point at another bucket or server.
- The override is to be deep-merged over the product's `services`
  (`merge(product.services, site.overrides)`, a site inheriting every value it does not declare).
  Not built: nothing reads `services` or `overrides` yet (only `sites.ts` validates them). Build the
  merge, or correct this text, `types.ts` and configuration.md, before the storage scenarios
  (phase-6 plan's 6H.2; the orchestrator plan's 0B.1).
- On the site, not in `SITE_<n>_<KEY>` env keys: it fits the data shape (an env key would have to
  encode product, cell and index, `WPROCKET_NGINX_SITE_2_FTP_HOST`), and index-based keys bind to an
  array position, so reordering a pool silently remaps them. Secret exposure does not separate the
  two: the sites file is already git-ignored and holds each site's secrets.
- Likely override candidates: FTP (high rate-limit risk), Dropbox and Rackspace (medium); S3 and
  Azure rarely (built for concurrency).

As built: configuration.md (but the merge above).

### 2.6 Editions (Free / Pro)

- Free and Pro are separate packages sharing most behaviour: Pro has Free's features (minus a few
  Free-only items such as beta subscriptions) plus more storages, quality-of-life flows and enhanced
  variants of shared flows.
- Edition belongs to the cell because it decides three cell-wide things: the package installed, the
  scenarios generated, the page-object branch. None is per site, so it is declared once per cell
  (`pro@nginx`, `free@apache`). It rides cells-as-data, so per-edition pools, reports and
  orchestration come free, with no new matrix axis; being non-secret, it travels in routing
  metadata. One value per cell, so no per-site field and no pool-uniformity check.
- Tags: none = both editions; `@pro` / `@free` = that edition's cells. Each cell's `defineBddConfig`
  gets a `tags` expression (`not @free` on Pro, `not @pro` on Free, none when editionless), which
  filters at generation (playwright-bdd `tags?: string`) and composes with `--grep`.
- A scenario tagged both would run nowhere. The design rejects it, but nothing enforces that today
  (no check in `project.ts` or `types.ts`) — open; no phase owns it yet.
- Different user journeys become separate `@free`/`@pro` scenarios sharing a Background (restore:
  Pro restores from the backup list, Free uploads a downloaded backup). Same steps with incidental
  UI differences: one untagged scenario and an edition-aware page object (an interface, one class
  per edition, a small factory selected by the `edition` fixture). Pro-only storages need no config
  split; their scenarios are `@pro`.
- Absent edition: an editionless product declares none (no filter, one package). An edition-ful
  product must declare it on every cell — all-or-none, failing at load — rather than install an
  undefined package or run both editions' scenarios.
- Package selection is the artifacts capability (§7). The first sketch, a static
  `plugin: { free, pro }` zip map in the product config, was dropped: a committed path cannot say
  which build it holds, and nothing verified that a `pro` cell got the Pro package.

As built: configuration.md, "Editions"; authoring-tests.md, "Tags".

### 2.7 Authentication

Authenticate once per site and reuse its `storageState`, instead of the baseline's per-scenario UI
login. Each cell's BDD project depends on a setup project that logs in every real site (placeholders
skipped, so a fresh checkout stays green); `@noauth` scenarios start unauthenticated.

Not built: multi-user, which the baseline supports (`admin` vs `admin2`) — a second per-site state
file plus a step `Given I am logged in as {string}` → `context.setStorageState(path)`.

As built: CLAUDE.md, "Auth fixture / setup".

### 2.8 Reporting

- Three tiers run together because playwright-bdd emits standard Playwright tests: Playwright HTML
  (the interactive trace viewer, the baseline's real gap), the Cucumber HTML report (the baseline
  report's successor), Allure 3 (history, trends, flaky categories, dashboards, `singleFile`).
  Capture: trace, video and screenshot all `retain-on-failure`.
- The Cucumber report trades a portable single file against an in-report trace viewer, so both exist
  (`REPORT_MODE`). Default (A): one self-contained file, screenshots and video embedded, only the
  trace zip skipped, opens from `file://` — for whoever downloads one file (planned for AutoE2E and
  CI). `rich` (B), for targeted debugging: HTML plus `data/` with the trace viewer, which must be
  served over `http(s)://`.
- The reporter embeds whatever exists and has no "embed only on failure" switch, so never add
  `video/webm` to `skipAttachments` in mode A.
- Versus the baseline: exceeds it (trace viewer, trends and flaky detection, per-(product × cell)
  reports); matches it by choice (video and screenshots embedded in the Gherkin report).

As built: README, "Reporting"; `src/common/config/reporting.ts`.

### 2.9 Server modes

| Mode | WP-CLI transport | Provisioning | Web server(s) |
| --- | --- | --- | --- |
| `ssh` (default) | node-ssh, remote host | existing remote sites | as the host configures |
| `docker` | `docker exec <container> wp …` | custom compose, `docker/` | Apache and Nginx |
| `local` | execa, on the host | the user's own install | whatever the user runs |

- The mode decides how WP-CLI is dispatched; it is orthogonal to which sites run.
- Planned sharing: an `ssh` site may declare only `mode` and `rootDir`; `host`, `username`,
  `privateKeyPath` and `port` resolve from a named profile in the product's `ssh.servers.json`, its
  `default` profile, or `E2E_SSH_*` (Phase 11). A field the site declares still wins.
- `@wordpress/env` is Apache-only (verified in its installed source: `FROM wordpress${phpVersion}`,
  `APACHE_RUN_*`, no Nginx path), so a custom compose provides both over one MariaDB: Apache from
  `wordpress:php8.x-apache`; Nginx = `wordpress:php8.x-fpm` with no published host port (Docker
  Hub's FastCGI security note) plus `nginx` with a WordPress vhost — the vhost is required, php-fpm
  alone serves nothing; a `wordpress:cli` container per install.
- `@wordpress/env` stays an optional, Apache-only convenience.

As built: README, "Local WordPress (Docker)"; `docker/`.

### 2.10 Exec layer and plugin lifecycle

- Commands are array args through execa or node-ssh (never a shell string), with an `exitCode` on
  every mode — the baseline omitted it on its docker/local branch, which made guards impossible.
- Two intents are never conflated. Cleanup (every scenario's Before/After) makes the plugin absent
  and treats already-absent as success: a Before runs before the first install, an After may follow
  a scenario that removed the plugin itself. Deletion as the action under test treats
  absent-when-expected and a failed deletion as failures.
- `wp plugin delete` exits non-zero both for "not found" and for a real failure, so state is probed
  with `wp plugin is-installed` (0 = installed) and removal re-verified; distinct error types tell
  the cases apart.
- The UI path exists because some product flows exist only there. WP Rocket's post-delete "delete
  data" confirmation is not exercised yet — to verify when porting WP Rocket.
- Other baseline capabilities: DB ops → `wp db query` through exec (`dbQuery`); settings
  export/import diff → Playwright `expect` deep-equality, `microdiff` only if a structured diff
  object is needed (WP Rocket, pending); `debug.log` scan → tag-scoped hooks, with a direct file
  read when a fatal stops WordPress booting; health check and report opener → `styleText`,
  `npm run report`.

As built: wordpress-automation.md (removal is `wp plugin uninstall`, never `delete` nor
`uninstall --deactivate`); the UI delete flow in `src/common/pages/plugins.page.ts`.

### 2.11 Page objects and step wiring

- Plain page objects only — no playwright-bdd decorators or `@Fixture` style, no hybrid. Interaction
  logic lives once in the POM, Gherkin wiring entirely in thin step functions, so neither leaks into
  the other. Product POMs register as fixtures in the product's own `fixtures.ts`.
- Edition-divergent pages: §2.6.
- Trap: a step file outside the product's `steps` glob, or not exported, registers zero steps
  silently ("undefined step").
- Port the baseline's `sections.ts` / `selectors.ts` to role- and label-based locators and web-first
  assertions: no brittle CSS chains, no manual `isVisible()` polling.

As built: authoring-tests.md, "Page Object Model".

### 2.12 Visual regression

The baseline's BackstopJS was fully disabled (`return; // Skip VR tests` in every step, zero
committed references) and used only an A/B model: the page with optimisations bypassed
(`?nowprocket`) against the optimised page, same run, no stored baseline. So the active model is
that A/B check, diffed with pixelmatch + pngjs (the engine Playwright uses internally, browser-free
and unit-testable). A committed-baseline helper (`screenshot.ts`, `toHaveScreenshot`) exists as
wiring only; if it is ever activated, generate baselines in the CI image or container, commit them
per project and mask dynamic regions.

As built: README, "Visual regression"; CLAUDE.md, "Visual testing". The `@visual` scenarios land
with WP Rocket's port.

### 2.13 Device profiles

Device is a per-scenario client concern, orthogonal to cells and editions (it never multiplies the
matrix or touches the binding), so it is tag-driven and desktop by default. Sizes come from the
baseline: desktop 1600×700, mobile 389×829. `@mobile` applies a full `devices[…]` preset (viewport,
`isMobile`, `hasTouch`, mobile user agent, `deviceScaleFactor`) as a `use` override at context
creation — declarative, where standalone Cucumber forced imperative `setViewportSize` calls.

As built: `src/common/config/devices.ts`; CLAUDE.md, "Device profiles".

Open, for WP Rocket's port:

- Server-side mobile: WP Rocket serves different cached and beacon output by `wp_is_mobile()`.
  Whether the mobile user agent alone makes it serve mobile content is to verify. If it does not
  (caching edge cases), force it server-side with a `@mobile` Before/After hook (a
  `force-wp-mobile`-style helper); prefer the user-agent path if it holds.
- Form-factor data: steps comparing device-specific data (LCP/ATF expectations, the `is_mobile` DB
  column) read `$tags` to pick the desktop or mobile dataset.
- A rare mid-scenario resize stays available as an imperative `setViewportSize` step.

## 3. Phases

| Phase | Status | As built, or where it is planned |
| --- | --- | --- |
| 0 Guardrails | done | §1; `.env.example`, `sites.example.json`, README |
| 1 Config foundation | done | typed env, transport union, `.env` loader — configuration.md |
| 2 Execution model & isolation | done | execution-model.md |
| 3 WordPress automation layer | done | wordpress-automation.md; `docker/` |
| 4 Reporting | done | README, "Reporting"; `allurerc.mjs`, `scripts/allure.mjs` |
| 5 Visual regression | done | §2.12 |
| 6 Feature porting | in progress | phase-6 plan (supersedes this phase; BackWPup only) |
| 7 Terminal output | next | below |
| 8 CI on real cells | dropped | below |
| 9 Orchestrator | moved | orchestrator plan |
| 10 Cleanup & validation | open | below |
| 11 Shared SSH server profiles | open — after Phase 7 | below |
| WP Rocket port | after Phase 10 | phase-6 plan, "After Phase 10 — WP Rocket" |

Phase 10 states no dependencies, effort or parallelism; Phases 7 and 11 state theirs below.

Phase 6: the three install-hook obligations this plan set (consume `pluginArtifact`, stage the zip
for `ssh`/`docker`, clean the staging area in worker teardown) are done (6A; `releaseBoundSite`).
Its open note on retries — "maybe 0 retries for local is not the best, must assess this" — has been
acted on: 2 retries everywhere, local runs included, `E2E_RETRIES` overriding
(`src/common/config/project.ts`); whether that is the final answer stays the phase-6 plan's to
judge. Acceptance this plan set, beyond 6A's and still open: a review checklist confirms no 1:1
carry-over from the baseline (WP Rocket's port included).

Phase 7 — Terminal output (next; decided 2026-10-22). The suite and the orchestrator.

- Goal: on a terminal, a run and the orchestrator are easy to scan: a short header, live progress
  (done/remaining, passed/failed/flaky), one aligned line per scenario, a failure block naming the
  scenario, the failed step and where to look, and a summary with the report paths. Piped, redirected,
  `CI`, `NO_COLOR`, `TERM=dumb` and narrow or non-UTF-8 terminals get the same information as plain,
  stable lines. No styling ever reaches a log, a report or `results.jsonl`.
- Today: the suite's `list` reporter interleaves Playwright's lines; `run-summary.ts` prints one
  aligned block at the end and already uses Node's `styleText`; the orchestrator prints one
  timestamped line per event (`orchestrator/log.ts`), with no color and no live state. Nothing shows
  a failed step while it happens.
- Decisions:
  - One renderer, two front ends: a side-effect-free `src/common/terminal/` (capabilities, palette,
    layout, live region) used by the suite's reporter and by the orchestrator's logger. Add its
    modules to `orchestrator/suite-imports.json`; `import-boundary.spec.ts` must stay green.
  - Style is a sink, never data: build strings once, then style; every external string (test titles,
    error messages, paths, URLs, logs) goes through `plain`/masking and is cut by visible width, so
    it can inject neither ANSI nor a secret. The file sinks (`orchestrator.log`, `run.log`,
    `results.jsonl`, reports) stay byte-plain; tests assert no `\x1b` in them.
  - Color: Node's `node:util` `styleText` (no dependency; honors `NO_COLOR`, `NODE_DISABLE_COLORS`,
    `FORCE_COLOR` and the terminal's capability). Named ANSI colors and bold/dim only — no
    256/truecolor, no background fills — so the terminal's own light/dark theme keeps contrast.
    Semantic tokens: `ok` green, `fail` red, `warn`/`stop` yellow, `id` cyan, `dim` metadata and
    paths, `command` bold. Every status also has a symbol and a word, never color alone.
  - Symbols: `✔ ✘ ⚠ ■ · │ ├ └ ─`; ASCII fallback (`OK`, `x`, `!`, `#`, `.`, `|`, `+`, `-`) when
    `TERM=dumb`, the locale is not UTF-8, or output is forced plain.
  - `E2E_OUTPUT=auto|plain|fancy` (default `auto`): `auto` = fancy on a TTY, plain otherwise;
    `plain` = no color, no cursor movement, ASCII; `fancy` = color/live when the stream can take it,
    but still no cursor movement without a TTY.
  - Live region: only on a TTY, throttled to ≤ 2 redraws/s, capped at the terminal height, cleared
    before every permanent line and on exit/stop (cursor restored). Implemented in ~80 lines over
    `\x1b[2K`/`\x1b[1A`; `log-update@8` rejected because it writes ANSI even when the stream is not
    a TTY (read in its `index.js`, 2026-10-22) and its diff engine is more than needed.
  - Width: `process.stdout.columns`/`COLUMNS`, floor 40, cap 120; `resize` redraw. Layout is
    ANSI-aware with `string-width@8.3.0`, `slice-ansi@9.0.1` and `wrap-ansi@10.0.2` (all ESM,
    Node ≥ 20/22; latest verified on npm 2026-10-22). No `chalk`, `ora`, `listr2`, `boxen` or
    `cli-table3`: one palette, no spinners in CI, no box-drawing dependency.
  - `CI` turns the live region off (log lines only); color still follows `FORCE_COLOR` and the
    stream. `--reporter` keeps Playwright's meaning: it replaces our reporter, so the suite's output
    is the chosen reporter's.
- Suite (7.2):
  - Replace `list` in `reporters()` with `src/common/reporting/terminal.reporter.ts`; the results
    stream, run facts, HTML, Cucumber, Allure and `run-summary.ts` entries stay in the same order.
  - Header: product · cell, run id/name, plugin ref/version, site and versions, workers, report path.
  - Live block: `23/52 · ███████░░░ 44% · 12 passed · 1 failed · 3 running · 4m 12s`, plus at most
    one current line per worker (`▸ feature › scenario`), refreshed in place.
  - One line per scenario: status mark, duration (right-aligned), `feature › scenario`, a
    `retry n/m` tag, and a dim project/cell tag when more than one is selected.
  - Failure block, printed as it happens (not only at the end): scenario and feature, failed step
    (`result.steps`, the deepest step with an `error`; else the test error's location), first error
    line, screenshot/trace/attachment paths, and a copy-paste rerun command built from the run's
    product, cell and title. `TestResult.steps` and `test.titlePath()` exist in the installed
    Playwright 1.63.0 types; a real failing `@noauth` run proves the step.
  - End: restyle `run-summary.ts` (same facts, counts, report paths, prune line) as a block with a
    rule, aligned labels and one blank line before it; keep its last line plain for the shell prompt.
  - Plain mode: one line per scenario event and failures as indented blocks, no cursor codes, stable
    enough for CI logs and `grep`; no `list`-style overwriting. `--list` keeps its one-line-per-test
    output and `--ui` keeps its own terminal; the live block is for `test` runs only.
- Orchestrator (7.3):
  - `orchestrator/log.ts` splits rendering: the file keeps today's `ISO <scope>  <text>`; the
    terminal gets the shared palette, a fixed time column, a scope column colored per task, a mark
    and the message; continuation lines align under the message.
  - Permanent events become small blocks where a block helps (start, run end, stop sequence, error)
    and stay one line otherwise (`slack ✓ · datator ✓ 201`, `next run 11:14:41`); no blank line
    between every line.
  - Live table on a TTY (only while tasks run): one row per task — id, run id, cell, progress counts
    and bar, elapsed, state (`building`, `running`, `stopping`); at most 5 rows plus `and N more`;
    redrawn ≤ 1/s. Counts and the current scenario come from a tail of the run's `results.jsonl`
    (incremental reader over `results-reader.ts`, offset + partial line), never from stdout; it has
    no effect on events, `run.finished` or the log.
  - The table is cleared before every permanent line and on every stop path (drain, interrupt, kill,
    `--once`), and the cursor is restored; a paused terminal stays bounded by the logger's existing
    1 MiB backlog. `--dry-run`, `--help` and refusals use the same renderer; plain when piped (the
    current specs compare those lines, so they stay stable).
  - Run logs stay plain: the run's environment gets `NO_COLOR=1`/`FORCE_COLOR=0` (verify both), and
    captured output is stripped of VT codes before it is appended; `run.log` is for `grep` and for
    Slack's tail, not for a terminal.
- Shape (TTY, abbreviated):

  ```text
  ━━ BackWPup · pro@nginx ━━ bpng-42 · develop @ af1ab5c ━━━━━━━━━━━━━━━━━━━━━
    Site     bwu3.example · WordPress 7.1.2 · PHP 8.5.10
    Workers  4 · report reports/backwpup/pro@nginx/bpng-42
    ███████░░░ 23/52 · 44% · 12 passed · 1 failed · 3 running · 4m 12s
    ✔ 18.4s  Backups › Create a backup from the dashboard
    ✘  8.1s  Backups › Restore an archive                    retry 1/2
      at restore.feature:42 · expected 200, got 500
      Screenshot …/test-failed-1.png · Trace …/trace.zip
  ```

  ```text
  TASK  RUN      CELL       PROGRESS                     ELAPSED  STATE
  bpng  bpng-12  pro@nginx  ███████░░░ 38/52 · 1 failed   18m 04s  running
  bfap  bfap-07  pro@nginx  ██░░░░░░░░  9/52 · 0 failed    4m 31s  running

  10:15:30  orchestrator  started · 2 tasks (bpng, bfap) · .orchestrator/ · pid 4242
  10:15:31  bpng   run bpng-12 started · backwpup pro@nginx · develop
  10:15:31  bpng   build  BackWPup Pro 9.99.99 @ af1ab5c · APVM cache hit
  11:09:41  bpng   run bpng-12 ✔ passed · 52 scenarios: 51 passed, 1 flaky · 54m 10s
  11:09:42  bpng   slack ✓ · datator ✓ 201 · next run 11:14:41
  ```

- Compatibility contract:

  | Sink                                     | Color                                                | Live/cursor    | Symbols                  |
  | ---------------------------------------- | ---------------------------------------------------- | -------------- | ------------------------ |
  | TTY, `TERM` not `dumb`, UTF-8            | yes, unless `NO_COLOR`/`NODE_DISABLE_COLORS`         | yes, unless CI | Unicode                  |
  | TTY, `NO_COLOR` set                      | no                                                   | yes, unless CI | Unicode                  |
  | Pipe/file/CI                             | no, unless `FORCE_COLOR`                             | no             | Unicode if UTF-8, else ASCII |
  | `TERM=dumb`, non-UTF-8 locale, or plain  | no                                                   | no             | ASCII                    |

  `NO_COLOR` follows no-color.org (present and not empty, whatever its value); `FORCE_COLOR=0`
  disables and `1`/`2`/`3` enable. Measure `styleText`'s precedence for `NO_COLOR` + `FORCE_COLOR` in
  7.1 and encode it once in `detectCapabilities`, not in scattered checks. `FORCE_COLOR` in CI colors
  lines but never turns on the live region.
- Sub-phases:

  | #   | Delivers                                                                                                                       | Depends  | Parallel | Effort | Done when                                                                                                                                                                                                                       |
  | --- | ------------------------------------------------------------------------------------------------------------------------------ | -------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 7.1 | `src/common/terminal/`: capability detection (env, stream, width, locale), palette, ANSI-aware layout, `LiveRegion`; allowlist + boundary; unit specs. No output changes. | —        | —        | S, 1 d | Every capability branch tested against fake streams; `styleText` precedence measured; `import-boundary` green; no visible change.                                                                                                |
  | 7.2 | Suite reporter: header, live block, per-scenario line, failure block, summary restyle; plain mode.                              | 7.1      | 7.3      | M, 2–3 d | A real `@noauth` run shows the expected screen on a TTY; `\| cat`, `NO_COLOR=1`, `CI=1`, `TERM=dumb` and `COLUMNS=40` are plain and complete; `results.jsonl` schema unchanged; a failing scenario names its step when it fails. |
  | 7.3 | Orchestrator renderer: styled permanent lines, task blocks, live table from the results tail; plain logs.                      | 7.1      | 7.2      | M, 2–3 d | `--dry-run`, `--once` and a loop on the fake suite render correctly on a TTY and as a pipe; `orchestrator.log` and `run.log` contain no `\x1b`; the table is cleared on SIGINT/stop; no event or exit-code change.                |
  | 7.4 | Compatibility pass, docs, screenshots, regression tests.                                                                       | 7.2, 7.3 | —        | S/M, 1–2 d | The matrix above is covered by tests; README/CLAUDE/the orchestrator guide document `E2E_OUTPUT` and the plain guarantees; lint, typecheck, format and unit tests green.                                                          |
- Tests: pure unit specs for capabilities (TTY/non-TTY, `NO_COLOR`, `FORCE_COLOR`, `NODE_DISABLE_COLORS`,
  `TERM=dumb`, `CI`, `COLUMNS`, `LANG`), layout (wide/emoji/combining/ANSI input, truncation, wrapping,
  no split escapes) and the reporters with fake Playwright events; byte-level assertions that file
  sinks stay plain; pty smoke via `script -q`/`script -qec` (macOS/Linux) for a real terminal; the
  orchestrator's fake suite for stop/exit. No new test dependency for the pty.
- Out: the dashboard's UI, a web progress view, log coloring, CI annotations, interactive prompts,
  animations/spinners in CI, and changing `results.jsonl` or events.
- Effort: 6–9 engineer-days, medium difficulty; no dependency on Phase 6, so it can run before 6H.

Phase 8 — CI on real cells (dropped). It planned a CI matrix of real cells (one job per product ×
cell). Real-cell runs, PRs included, belong to the orchestrator; CI keeps its quality, unit and
`@noauth` smoke jobs (`.github/workflows/ci.yml`).

Phase 9 — Orchestrator (moved): a long-running service with phases of its own. Report pruning (done
there as 0F), the pre-warm call and the Free/Pro single build moved with it.

Phase 10 — Cleanup & validation (open).

- A `deps:check` script (e.g. `depcheck`) catching unused dependencies.
- No dependency on §5's drop list reappears.
- `lint`, `typecheck` and `format:check` green; the reports generate.
- Remove every mention of plan phases from code comments (CLAUDE.md forbids citing plans in code).

Phase 11 — Shared SSH server profiles (open; scheduled after Phase 7). Configuration and transport;
depends on nothing (independent of Phase 6 and Phase 10; may run beside 7.2–7.4 or 6H). Stack:
existing TypeScript on Node 24, `node-ssh` as already used, the repo's Playwright unit runner, and
`node:fs`/`node:path`; no new dependency.

- Goal: stop repeating what belongs to the server. A site's `transport` still says `"mode": "ssh"`,
  and `rootDir` stays required on every site, but `host`, `username`, `privateKeyPath` and `port`
  may come from a named profile, the `default` profile, or environment variables. A field the site
  declares wins. Existing sites files that declare everything keep loading unchanged.
- Today: every SSH site repeats `host`, `username` and `privateKeyPath` in its sites file, and
  [`sites.ts`](../../src/common/config/sites.ts) requires all three; `port` is not configurable
  (node-ssh's 22), and `rootDir` is the only transport path a site must give. `loadSites` is shared
  by manual runs, the healthcheck and the orchestrator, so a file-based default reaches all three;
  the orchestrator sets `E2E_LOAD_DOTENV=false`, so `.env` alone cannot reach its runs.
- Shared file: `src/projects/<product>/config/ssh.servers.json`, a sibling of the sites files,
  git-ignored; `ssh.servers.example.json` is committed. It is optional. One file per product keeps
  D2's isolation and needs no new path resolution; `findSitesFiles` never reads it (it is not a
  `sites.*.json` name). A repo-wide file can later layer over it without changing the site schema.
- Shape:

  ```jsonc
  // src/projects/<product>/config/ssh.servers.json
  {
    "default": {
      "host": "203.0.113.10",
      "username": "ubuntu",
      "privateKeyPath": "/home/runner/.ssh/id_ed25519"
    },
    "apache": { "host": "203.0.113.20" }
  }
  ```

  ```jsonc
  // a site in sites.json — profile omitted means "default"
  { "mode": "ssh", "profile": "apache", "rootDir": "/var/www/html/site" }
  ```

  `default` is reserved and optional. Every profile resolves field by field over `default`, so
  `apache` above supplies only its host; a profile may also be complete. Unknown keys, wrong types,
  empty strings, ports outside 1–65535, arrays/null and bad profile names are load errors naming
  the file and path, never quoting a value. A profile cannot carry `rootDir`, `stagingDir`,
  `elevate` or `fileOwner`.
- Site selector: `transport.profile` is an optional safe single token
  (`[a-z][a-z0-9_-]{0,31}`, 1–32 characters); omitted selects `default` when present. A named
  profile that is not defined is a hard error, never a silent fallback to `default`. Site fields
  win over the profile, so a one-off host or key stays possible.
- Precedence, field by field: site value → selected profile, merged over `default` → `default` →
  env → error (`port` falls back to 22). Blank env is unset; a malformed env value is an error only
  when that field is needed. A blank site field is refused, never treated as absent.
- Env fallback: `E2E_SSH_HOST`, `E2E_SSH_USERNAME`, `E2E_SSH_PRIVATE_KEY_PATH`, `E2E_SSH_PORT`.
  Add all four to the orchestrator's `INHERITED_VARIABLES`, so a run gets them when the operator
  uses env instead of the file; nothing else about the run contract changes.
- Required per site: `mode` (`"ssh"`; never inferred) and `rootDir`; `baseURL` and the WordPress
  login stay per site too. `stagingDir`, `elevate` and `fileOwner` stay per-site (staging keeps its
  existing `E2E_SITE_STAGING_DIR` fallback): they are policy/ownership, not connection details.
- Port: `SshTransport.port` is a resolved number (1–65535, default 22). [`exec.ts`](../../src/common/wp/exec.ts)
  passes it to node-ssh and includes it in `connectionKey`/`targetKey`; [`preflight.ts`](../../src/common/setup/preflight.ts)
  names it in the connection hint and adds `-p` to the sample `ssh` command. Out: passphrases and
  encrypted keys, `ssh-agent`, `ProxyJump`/`ProxyCommand`, `~/.ssh/config` discovery, key contents,
  and any non-SSH transport change.
- Security: the file holds endpoint metadata and a key *path*, never key material; it is
  git-ignored and documented `chmod 600`. No error, warning or log quotes a sites value, a profile
  value or an env value — messages name the file, the site path, the field and the env var. The
  existing secret masking is untouched.
- Orchestrator: no config schema change. It already loads cells through `loadSites`, so resolved
  hosts feed the crowded-server warning and the site locks unchanged; every process of a run
  resolves the same file. Only the environment allowlist changes.
- Implementation:
  - `src/common/config/ssh-servers.ts`: types, `loadSshServers` (missing = empty, malformed = hard
    error), `resolveSshEndpoint` (pure: site transport, profiles, env → resolved fields), and
    validation.
  - `sites.ts`: reads `join(configDir, "ssh.servers.json")` once per load and passes it plus the env
    source into the ssh branch; keep the `[sites]` error style and the no-values rule. Move the
    shared `describeValue`/string/number helpers to a small module if needed to avoid a
    `sites.ts` ↔ `ssh-servers.ts` cycle; re-export `describeValue` from `sites.ts` for its specs.
  - `types.ts`: `SshTransport` gains `port: number`; `profile` is config-only and dropped after
    resolution.
  - `exec.ts`, `preflight.ts`: port end-to-end.
  - `orchestrator/runs/environment.ts`: the four env names in `INHERITED_VARIABLES`.
- Tests:
  - `ssh-servers.spec.ts`: missing/empty/malformed file; default; inheritance; complete profile;
    unknown profile; unknown key; wrong types; blank strings; port bounds; profile-name bounds; no
    quoted values; precedence for every field; env fallback, blank and malformed env; site
    override; `rootDir`/`stagingDir`/`elevate`/`fileOwner` refused in a profile.
  - `sites.spec.ts`: `{ mode, rootDir }` resolves; full transports unchanged (plus the default port
    once 11.2 lands); `profile` dropped; a missing field names the site and env var; a sibling
    `ssh.servers.json` in the temp config dir is read; overlays and the example fallback unaffected.
  - `exec.spec.ts`/`exec.ssh.spec.ts`: port reaches node-ssh; two ports do not share a pooled
    connection; preflight hints use the port. Update every fixture that constructs an `SshTransport`
    (the orchestrator's included) with `port: 22` once the field is required.
  - `orchestrator/runs/environment.spec.ts`: the four vars pass when set; other vars still do not.
  - Live: a cell configured with only `mode` + `rootDir` (profile `default`) passes
    `npm run healthcheck` and one `@noauth`/`@smoke` run; the orchestrator's once path passes the
    same resolved transport.
- Docs: [configuration.md](../guides/configuration.md) (new "SSH server profiles" section,
  precedence table, env fallback, `rootDir` stays per site),
  [wordpress-automation.md](../architecture/wordpress-automation.md) (transport fields, port,
  cache), `.env.example`, `ssh.servers.example.json`, README's sites-files paragraph, CLAUDE.md's
  configuration mechanism, the [orchestrator guide](../guides/orchestrator.md) (profiles on the
  runner; `.env` still not reaching runs). Keep `sites.example.json` self-contained (full
  transports) so a fresh checkout loads without a global file; document profile-only sites in
  configuration.md. Code never cites a plan phase.
- Definition of done: a site with only `mode` + `rootDir` passes the healthcheck and a real run; an
  existing full transport behaves identically (same endpoint, port 22); a missing field fails at
  load naming the fix; an orchestrator run gets env-only profiles; all gates and docs are green.
- Sub-phases:

  | #    | Delivers                                                                                                         | Depends     | Parallel | Effort     | Done when                                                                                                                                                                  |
  | ---- | ---------------------------------------------------------------------------------------------------------------- | ----------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 11.1 | `ssh-servers.ts`, sibling file, optional `host`/`username`/`privateKeyPath`, `profile` selector; no port yet.   | —           | —        | S/M, 1–2 d | A `{ mode, rootDir }` site resolves from `default`; every precedence and error case is a unit test; existing full transports load identically.                              |
  | 11.2 | `port` end-to-end: site/profile, `SshTransport`, exec, cache key, preflight.                                    | 11.1        | —        | S, 0.5 d   | Profile `port: 2222` reaches node-ssh; two ports do not share a connection; hints show `-p`.                                                                                |
  | 11.3 | Env fallback (`E2E_SSH_*`) and orchestrator allowlist.                                                          | 11.1, 11.2  | —        | S, 0.5 d   | Without a file, env-only resolves; a run started by the orchestrator receives the four vars when set; blank/malformed cases covered.                                        |
  | 11.4 | Docs, examples, live check, full gates.                                                                         | 11.1–11.3   | —        | S, 0.5–1 d | The live cell passes; docs and examples describe the shipped behaviour; typecheck, lint, format and unit tests green.                                                       |

- Out: a repo-wide profile file, profiles for `local`/`docker`, global
  `rootDir`/`stagingDir`/`elevate`/`fileOwner`, passphrases/agents/jump hosts, auto-importing
  `~/.ssh/config`, and changing the orchestrator config schema.
- Effort: 2–4 engineer-days, low/medium difficulty; no dependency on Phase 6 or Phase 10, so it can
  start beside 7.2–7.4 and finish before 6H.

## 4. Feature-parity matrix

Baseline capability → target design → status. WP Rocket's port starts from the pending rows.

1. WP-CLI exec (local/Docker/SSH) → `wp/exec.ts`: execa (local, `docker exec`), node-ssh (remote),
   `exitCode` on every mode. Built.
2. Server/env config → typed env accessors; the transport union (default `ssh`); per-product config
   and sites files (§2.5). Built, except the `services` ← `overrides` merge (open, §2.5).
3. Plugin/theme lifecycle → WP-CLI wrappers and UI page objects; idempotent cleanup, asserted
   removal under test, distinct errors (§2.10). Plugins built; themes not.
4. DB ops → `wp db query` through exec. `dbQuery` built; the baseline's `seedData`/`checkData` come
   with WP Rocket.
5. Visual regression → the A/B check (§2.12). Built; scenarios come with WP Rocket.
6. Settings export/import diff → `expect` deep-equality; `microdiff` if a diff object is needed.
   Pending (WP Rocket).
7. Auth (login/logout) → per-site `storageState`, per-cell setup project, `@noauth` (§2.7). Built;
   multi-user pending.
8. POM (sections/selectors) → plain POM fixtures, thin steps, edition-divergent pages through a
   factory (§2.11). Built.
9. Lifecycle hooks → playwright-bdd `Before`/`After`/`BeforeAll`/`AfterAll` with `{ tags }`. Built.
10. Health check / open report / archiving → `styleText`; `npm run report`; a CI artifact upload or
    a small `fs` script. Health check and opener built; archiving not assessed.
11. `debug.log` scan → tag-scoped hooks, the log attached on failure. Built (`@plugin`).
12. Local WP env → `docker` = Apache + Nginx; `local` = any server; `@wordpress/env` optional
    (§2.9). Built.
13. Execution / parallelism (new) → (product × cell) run units, site pools, per-cell reports (§2.1).
    Built; the orchestrator is in progress.
14. Plugin editions (new) → one product, per-cell edition selecting package, scenarios and POM
    branch (§2.6). Built.
15. Credential safety (new) → pools through an in-process registry, never report-serialised metadata
    (§2.2). Built.
16. Plugin zip selection (new; the baseline's `new_release` / `previous_stable` zips in
    `utils/plugin-builder.ts`) → per-run `plugin`/`previous` roles built from any git ref through
    APVM or provided, identity-verified per product and edition, staged onto `ssh`/`docker` sites
    (§7). Built.

## 5. Dependency disposition

The baseline declares `axios`, `boxen`, `node-zip`, direct `ssh2` and
`multiple-cucumber-html-reporter` but never imports them. Its "beautiful report" is the stock
Cucumber HTML formatter: media-rich on failure (base64 screenshot and video) but static — no trace
viewer, no trends. Most other libraries have modern, often built-in replacements.

- Drop, never carry over (Phase 10 checks it): `axios`, `@types/axios` (deprecated stub), `boxen`,
  `node-zip`, direct `ssh2` and `@types/ssh2` (ssh2 stays a transitive dependency of node-ssh),
  `multiple-cucumber-html-reporter`, `@types/cucumber` (deprecated stub), `eslint-plugin-es5`, and
  the duplicate `playwright` (redundant with `@playwright/test`). Proven unused by repo-wide
  inspection.
- Replace:
  - `backstopjs` (+ types, `backstop.json`) → the A/B check over pixelmatch + pngjs (§2.12).
  - `shelljs` (+ types) → execa: promise-based, array args (no injection), structured errors, ESM.
  - `chalk` → `node:util` `styleText`: no dependency; emits no escapes off a TTY and honours
    `NO_COLOR` (verified on Node 24).
  - `ts-node` → `tsx` for the root scripts, the runner's own transpile for tests (the Cucumber CLI
    is gone).
  - `json-diff` (+ types) → `expect` deep-equality; `microdiff` if a diff object is needed.
  - `dotenv` → `node:util` `parseEnv`, the parser of `process.loadEnvFile()` (`config/dotenv.ts`).
- Not needed: the standalone Cucumber runner (playwright-bdd bundles the reporter);
  `@playwright/browser-chromium` (below); a pattern-matching library (transport dispatch is a native
  discriminated `switch` with a fail-fast `default`); a validation library for the suite's own
  config (hand-rolled; zod serves only the orchestrator).
- Optional, not added: `ts-pattern`, `microdiff`, `http-server` (serving a mode-B report),
  `@wordpress/env`.
- `adm-zip` 0.6.0 bundles its own types (no `@types/adm-zip`) and patches CVE-2026-39244; its
  breaking changes (`extractEntryTo`, Node 12) do not touch the read-only use. `apvm-napi`: §7.1.
- Browsers: `postinstall` runs `playwright install chromium`, so a fresh `npm install` is runnable;
  the committed `.npmrc` sets `ignore-scripts=false` so the hook runs where scripts are disabled
  globally (`npm run setup` reruns it). `@playwright/browser-chromium` is not used: the postinstall
  always matches the installed Playwright, one version fewer to keep in step. The runner uses the
  bundled Chromium (`devices["Desktop Chrome"]`, no `channel`).

## 6. Live risks

- Shared WordPress state under parallelism: each worker owns one site (§2.1) and a cell takes one
  run at a time (the orchestrator's site locks; manual runs are not covered — CLAUDE.md). The
  remaining gate is provisioning isolated sites, not code.
- Lost SSH/Docker/UI nuance in WP Rocket's port: characterise each mode with a smoke test first,
  then re-implement idiomatically.
- Pixel differences across platforms: the A/B check needs no stored baseline; run `@visual` in the
  Playwright container; tune `maxDiffPixelRatio`; mask dynamic content.
- WP Rocket's "delete data" confirmation page: handle when porting (§2.10).
- Credentials in shared artifacts: reports carry none (§2.2). Retained traces, `error-context.md`
  and `test-results/` still hold session cookies and typed values — treat them as sensitive
  (CLAUDE.md).

## 7. Plugin artifacts (done)

Phases 1–5 done (2026-07-14 to 2026-07-28) and audited. As built:
[plugin-artifacts.md](../architecture/plugin-artifacts.md) (roles, manifest, request model,
resolution, identity preflight, consumption, pre-warm, pinning),
[configuration.md](../guides/configuration.md#plugin-artifacts-build--verify) (the six `E2E_*`
variables and their rules) and [wordpress-automation.md](../architecture/wordpress-automation.md)
("Site staging & file transfer"). Kept here: the facts the design rests on, decisions and rejected
alternatives, limits, open obligations.

### 7.1 Verified foundations

APVM, measured at `develop` (npm `3.0.0`); pinned as
`github:wp-media/automation-plugin-version-manager#cli/v3.0.0`, the `cli/vX.Y.Z` tag pattern:

- Install: a plain git dependency with prebuilt `.node` binaries committed for darwin-arm64/x64,
  linux-x64/arm64-gnu and win32-x64-msvc — no musl, no Rust, no postinstall; engines
  `node >=22.22.1`. Its `prepare: husky` is blocked by the repo's `allowScripts` gate; `.npmrc`'s
  `allow-git=root` admits the declared git dependency on npm ≥ 12.
- Token: `Apvm.createWithTokenResolution()` tries its config → `GITHUB_TOKEN` → `GH_TOKEN` → the
  `gh` CLI → gh's config. Required for `backwpup`, whose source is the private
  `wp-media/backwpup-pro` (APVM `registry.rs`); otherwise optional (rate limits).
- `build({ project, gitRef, version?, variants?, outputDir, noCache? }, onProgress?)`: `outputDir`
  absolute, created if missing. `warmCache()` runs the same pipeline without delivering; a later
  identical `build()` is a cache copy (`fromCache: true`).
- Refs: bare (`develop`, a sha, `123` = a PR) or prefixed `pr:`, `branch:`, `tag:`, `commit:`,
  `release:`; keywords `latest-stable`, `previous-stable`, `latest`, `previous-latest` for `tag:`
  and `release:`. A `release:` ref is a GitHub Releases download through plain `build()`.
- `version`: required by `backwpup` on build refs; optional for `wp-rocket` and `imagify`
  (auto-detected; when given, rewritten into the source and reported as `versionOverride`); a
  `release:*` ref takes it from the tag.
- Output: `result` (`artifacts[{ variantId?, path, filename, size, origin }]`, `version`,
  `variantsBuilt`), `resolvedRef`, `commit`, `commitShort`, `description`, `fromCache`,
  `versionOverride?`; `origin` is `cache`, `built` or `downloaded`.
- Cache: `~/.apvm/cache` by default; `APVM_CACHE_DIR` overrides it for every instance — never set
  here. Keyed by resolved commit and version, so keyword refs re-resolve, then hit the cache. Its
  concurrency and per-variant layout: the orchestrator plan (0A.5, the Free/Pro single build).
- Errors are typed promise rejections (`ProjectNotFound`, `PrivateRepoNoToken`, `ReleaseNotFound`,
  `NoMatchingReleaseAssets`, …), never crashes. Progress events are a discriminated union
  (`reference_resolved`, `phase_*`, `step_*`, `command_output`, `warning`, `build_succeeded`,
  `build_failed`).
- `wp-rocket` has no downloadable GitHub Releases, so `release:*` fails for it; its `previous`
  default `tag:latest-stable` builds instead. BackWPup has release assets (`release:latest-stable`
  was v5.7.4 on 2026-07-16, with `free`, `pro-en` and `pro-de`); a release download delivers every
  variant and the variant filter selects ours.
- A cold build runs composer and npm for minutes, so the artifacts setup allows ~20 min (measured
  build times: the orchestrator plan).
- Sources: the napi README and `index.d.ts` (the API's source of truth); the builders
  `crates/core/src/build/plugins/{wpr,bwu}.rs`.

Identity — the slug, main file and `Plugin Name:` expectations are in plugin-artifacts.md; what
produces them:

| Product / edition | APVM `project` + `variants` | Zip filename |
| --- | --- | --- |
| WP Rocket | `wp-rocket` | `wp-rocket-{version}.zip` |
| BackWPup Free | `backwpup` + `["free"]` | `backwpup-{version}-{commit8}.zip` |
| BackWPup Pro | `backwpup` + `["pro-en"]` | `backwpup-pro-en-{version}-{commit8}.zip` |
| Imagify | `imagify` | to verify when wired, with its slug, main file and header |

Our cells are English, so Pro builds `pro-en` (`pro-de` exists, untested).

Transports' file access (2026-07-16):

- Every command runs with the WordPress root as its working directory: `rootDir` (local, ssh), the
  container `WORKDIR` (docker: `/var/www/html` in `wordpress:cli-php8.3` and `wordpress:php8.3-*`;
  `dockerArgv` passes no `-w`).
- Copy primitives: an `fs` copy (local); `docker cp`, a top-level docker sub-command, not
  `docker exec` (docker); node-ssh `putFile`, which does not create parent directories (ssh). All
  ignore the exec working directory and need an absolute target; docker's root is read with `pwd`.
- Write access at the WordPress root is a host property: on the ssh cell the docroot was
  `drwxrwxrwx www-data` and `ubuntu` could create `.e2e_temp`; staged files landed `0664`, readable
  by a differently-owned `wp`. Hence an overridable staging root.
- node-ssh interpolates `exec` arguments into a shell string, escaped by `shell-escape`. Fuzzed with
  4000 random arguments (quotes, `$()`, backticks, newlines, `;`, `|`, `&`) through `/bin/sh`: no
  argv mismatch, except that an empty-string argument disappears — unreachable today, since every
  value is a literal or refused when empty. Only the arguments are escaped, never the command, so no
  dynamic value may sit in the program position.

### 7.2 Decisions and rejected alternatives

- Variable names `E2E_PLUGIN_*` / `E2E_PREVIOUS_*` (`_REF`, `_ZIP`, `_VERSION`): `E2E_` scopes them
  without colliding with generic or CI-reserved names; the role words match how the artifacts are
  discussed. Rejected: `E2E_CANDIDATE_*` / `E2E_BASELINE_*` ("baseline" already names the legacy
  repo, and longer without being clearer); `E2E_TARGET_*` / `E2E_REFERENCE_*` ("target" is
  overloaded, `E2E_REFERENCE_REF` stutters); the baseline's `new_release` / `previous_stable` (the
  tested artifact is usually `develop`, and the comparison ref need be neither previous nor stable).
- Overrides on a serial (cell-less) run warn and fall back to defaults: an earlier draft failed
  fast, softened so a stray or shared variable cannot abort a broad run. `E2E_PREVIOUS_*` on a
  product without the role warns too: cells of several products may share one shell or CI env.
- BackWPup's version defaults differ per role — `plugin` `9.99.99`, `previous` one patch lower,
  `9.99.98` — so an update or rollback test sees `previous` as older with nobody picking versions;
  one patch is the smallest guaranteed-older delta under semver. Pass `E2E_PREVIOUS_VERSION` to test
  a real upgrade. Only `plugin`'s default exists until the role lands (§7.4).
- Edition and APVM variant stay two words: edition is the language-blind behavioural tier that
  `@free`/`@pro` need; a variant is an exact buildable package; APVM has no edition concept.
- Static identity preflight (`adm-zip`; `yauzl` the fallback) rather than an install-based probe: no
  WordPress needed, milliseconds, cannot mutate a site, identical for built and provided zips. The
  suite's first install proves installability minutes later anyway, and an uninstall–install–list
  loop per artifact is slow, serial and adds failure modes. Dropped from the first draft: "exactly
  one `.zip` in the role dir" — one artifact per role is enforced at resolution (`pickArtifact`),
  and a `release:*` ref legitimately delivers every variant's zip into the dir.
- APVM's cache is the only reuse layer: every execution wipes and re-resolves (a cache hit is a ~15
  MB copy), and provided zips are copied in (uniform layout, immune to the source moving). Roles
  resolve sequentially (readable logs, no assumptions about APVM's workspaces). Workers never
  resolve: APVM per worker would race on the wipe and duplicate copies.
- The transfer primitive lives in `exec.ts`, which already owns the cached SSH connection and the
  per-mode dispatch; a standalone `transfer.ts` importing an exported connection was rejected as
  leakier.
- The site's `stagingDir` beats `E2E_SITE_STAGING_DIR`: the site's declaration is the specific
  statement ("this host's docroot is not writable"), so a global default must not override it. Paths
  are absolute throughout, since the copy primitives ignore the exec working directory — why the
  pure path builder takes the root instead of hard-coding `.e2e_temp`.
- The staging-root guard sits at the point of use, not in `sites.ts`: docker's root is unknown at
  load, and one authoritative check cannot drift from a second. A relative `rootDir` is refused only
  by the staging layer: `exec` has always accepted one as a working directory, and failing it at
  load would break sites that work.
- `cleanSiteStaging` throws on a real failure (a dirty site should be visible); the teardown caller
  makes it best-effort. `mkdir` and `rm` are shelled out even on `local`: uniform behaviour across
  transports beats a special case.
- A bare numeric ref (`5.6.8`) is treated as a build ref although APVM may resolve it to a release;
  the version default is then sent needlessly and ignored in favour of the tag. Narrowing it would
  reimplement APVM's ref detection.
- `--project` is matched exactly against cell names, while Playwright's own filter ignores case and
  expands `*` (its `filterProjects`). Mirroring it would duplicate a third-party internal or let
  `--project='*'` apply one operator's override to every cell; exact matching degrades visibly
  (overrides warn and drop), never silently.
- Trap (execution-model.md, "Reading the selection from a worker"): a worker has no CLI argv. An
  argv-derived selection once silently dropped every `E2E_*` override while the warmer, with its
  argv intact, honoured them.

### 7.3 Limits

- Sites sharing one absolute staging root — several sites on one host given the same absolute
  `stagingDir` or `E2E_SITE_STAGING_DIR` — can collide when run concurrently. Within one invocation
  it cannot happen (one worker per site). Namespacing staging by `RUN_ID` was rejected: a killed
  run's folder would then be cleaned by nobody, leaving zips in a web-reachable docroot. The
  scheduler must know which roots are shared: the orchestrator plan's 0A.3.
- Two processes that both miss APVM's cache both build in full (its writes stay safe); pre-warming
  exists to avoid that (the orchestrator plan's 0A.5).
- A relative `E2E_*_ZIP` resolves against the repo root, never the process working directory;
  absolute is recommended.
- A keyword ref (`tag:latest-stable`) re-resolves at warm and at run time, so a release cut in
  between makes the run build fresh — correct, only slower. Pinning (plugin-artifacts.md) closes it
  for the orchestrator.

### 7.4 Open obligations

- BackWPup `previous` role (MUST, when its comparison tests arrive): add
  `previous: "release:latest-stable"` and a `previous` default version (e.g. `9.99.98`, needed if
  `E2E_PREVIOUS_REF` is ever pointed at a build ref) to `backwpup.config.ts`. Declaring the role
  enables resolution and the identity preflight for the second artifact, which must not be skipped;
  the only exemption is a test that builds inside its own scenario and owns its verification. Until
  then the fixture hard-errors. Mirrored on the manifest and in CLAUDE.md.
- Imagify: a manifest, and its identity row verified from its build definition, when it is wired.
  Planned defaults: `plugin` `develop`, `previous` `tag:latest-stable`, version embedded.
- Version-aware tests: `resolution.json` exposes each role's verified version and commit; BackWPup's
  CLI feature already asserts `wp backwpup version` against it.
- Deeper zip validation (a CRC pass, a trial install) only if a real failure class appears, behind
  the same aggregated report.
- Free/Pro single build (one APVM call for both variants of one ref and version): the orchestrator
  plan.
- `.e2e_temp` is served by the web server on these cells (wordpress-automation.md); the guard is the
  phase-6 plan's 6J.

Done since: `cleanSiteStaging` runs in worker teardown (`wp/teardown.ts`, the `releaseBoundSite`
fixture).

## 8. Site file ownership (done)

Phases 0–6.5 done (2026-08-26) after five audit rounds; the full BackWPup suite passed on both cells
with it (2026-08-28). As built: wordpress-automation.md ("File ownership", "Path guards", "Left-over
plugin data"), configuration.md (`fileOwner`, `elevate`), CLAUDE.md (the MUST and the pre-flight
reports), `src/common/wp/ownership.ts` (BusyBox and `id` parsing in its TSDoc). Kept here: cell
facts, decisions and rejected alternatives, limits, open obligations.

The problem: on an `ssh` cell WP-CLI runs as the transport's user (`ubuntu`, umask `0002`) and PHP
as the web server (`www-data`), so what the suite installs lands `ubuntu:ubuntu 775/664` and the web
server's next write into it fails — a raw `EACCES` inside `WP_Filesystem_Direct`, not an FTP prompt.
`normalizeOwnership` hands it to the owner detected from the install.

### 8.1 The cells (measured 2026-08-26 unless dated)

`pro@nginx` is `simple.e2e.rocketlabsqa.ovh` on `qa-lnmp`; `pro@apache` is
`auto-e2e-backwpup-apache.rocketlabsqa.ovh` on `qa-auto-e2e-apache`.

| | `pro@nginx` | `pro@apache` |
| --- | --- | --- |
| Transport user | `ubuntu` (1000:1000) | `ubuntu` (1000:1000) |
| Web/PHP user | `www-data` (nginx + php-fpm) | `www-data` (apache2 + php-fpm) |
| Docroot owner | `www-data:www-data` | `sftp_backwpup:www-data` (uid 1001) |
| Docroot mode | `777` throughout | `777` throughout |
| sudo | `(ALL) NOPASSWD: ALL` | `(ALL) NOPASSWD: ALL` |
| Userland | GNU coreutils 9.4, kernel 6.8 (Ubuntu), WP 7.1 | GNU coreutils 9.4, WP 7.1 |

- `pro@apache`'s WordPress root is `<vhost dir>/public/`; the vhost directory itself holds no
  WordPress (its `rootDir` was fixed in the git-ignored sites file). The same host serves WP
  Rocket's site to the same `ubuntu@host`, owned `sftp_wprocket:www-data` (uid 1002) — why ownership
  caches are per install, not per host.
- Group membership is host state: `ubuntu` was added to `www-data` on both hosts (`usermod -aG`,
  2026-08-26; `qa-auto-e2e-apache`: `www-data:x:33:sftp_backwpup,sftp_wprocket,ubuntu`; `qa-lnmp`:
  `www-data:x:33:ubuntu`). A check earlier that day found `qa-lnmp`'s group with no members and the
  change had to be reapplied, so membership is measured on every run, never configured. A fresh SSH
  session sees a new membership at once (node-ssh opens new sessions).
- sudo probes, measured with a sudoer and a non-sudoer (`www-data`): `sudo -n true` works (exit 0,
  else exit 1 with `sudo: a password is required`); `sudo -n -l` works but adds nothing;
  `sudo -n -v` is a false negative — exit 1 even for a passwordless sudoer, since `-v` validates the
  credential cache and tests no command. Never use it. "Not a sudoer" and "sudoer needing a
  password" print the same message by design, so pre-flight reports one state and names both causes.
- Known probe limit: a `NOPASSWD` grant for a command list excluding `true` fails `sudo -n true`
  while permitting `chown`. The fleet grants `ALL` (`/etc/sudoers.d/`).
- MariaDB 10.11.14 on `pro@apache` (2026-08-28): an `.ibd` file with no data-dictionary entry
  (`wp_bwpup_backups.ibd`, dated 2026-05-04) made every `CREATE TABLE` of that name fail with errno
  184 "Tablespace already exists", and `DROP TABLE IF EXISTS` does not remove it. `mariadbd`'s own
  message prescribes removing the file; it was moved aside (reversible), after which create and drop
  behaved again. An orphan is absent from `SHOW TABLES` and from
  `information_schema.INNODB_SYS_TABLES` (queried as root); moving it is safe while the server runs
  (no open handle) — re-check the dictionary just before acting. A sweep of every schema on the host
  found only that orphan.

### 8.2 Decisions and rejected alternatives

- The owner is detected with `stat` on `wp-content` (else the WordPress root), never from the
  web-server process: `ps` says `www-data` on both cells, wrong on `pro@apache`, where
  `chown www-data:www-data` would strip `sftp_backwpup`, the host's SFTP deployment account, off the
  tree.
- Rejected: running WP-CLI as the docroot owner. `sudo -n -u <owner> wp …` works, even for the
  `nologin` `sftp_backwpup`, but there is no single correct user (on `pro@apache` that owner's
  primary gid is 123 and its umask `0022`, so it would create `sftp_backwpup:sftp_backwpup 755`
  files the web server cannot write); `sudo -u` sets the target's `HOME` — `/var/www` on nginx,
  `/public` (absent) on apache — where WP-CLI puts its cache; and it changes every WP-CLI call to
  fix file creation.
- Rejected: a `www-data:www-data` fallback when detection fails. It is wrong on `pro@apache`, and a
  wrong owner applied as root is worse than none; detection cannot fail alone (pre-flight already
  asserts root access and a booting WordPress); and the real failure, missing elevation, leaves
  nothing able to apply any value. So an undetectable owner is warned about and skipped.
- The grant's scope is measured from the transport user's groups (`ug+rwX`; `o+rwX` added only when
  it is neither the owner nor in the group): a membership that can silently vanish does not belong
  in the sites file. The `o+rwX` branch matches these cells' existing `777` and the reasoning behind
  `DATA_DIR_MODE = "0777"`; it is avoidable, so it announces the fix. Both branches were exercised
  on both cells by temporarily removing the membership.
- The detected owner is memoised per worker process, not persisted: pre-flight runs in the setup
  process and scenarios in workers, and a file (as `resolution.json`) would buy a lifecycle and a
  staleness window to save one `stat` per worker per site over a pooled connection. Pre-flight
  reports the decision (`planOwnership`) without being its source of truth.
- Data-directory preparation sets the mode first, then hands the directory over — the reverse of the
  plugin's grant-then-chown — because the mode is changed while the directory is still the transport
  user's; normalising first would need privileges for a `chmod` that needs none. The hand-over is
  recursive, so it also reaches what the plugin's own activation created as WP-CLI — closed by
  construction, not by BackWPup's `activate()` creating no directories (`class-install.php`,
  2026-08).
- `fileOwner` is absent from the `sites.example.json` files: JSON has no comments, and neither other
  optional knob (`elevate`, `stagingDir`) appears there, so showing only the rarest would read as
  something a checkout needs. It is documented beside `elevate` in configuration.md.
- Pre-flight reports elevation up front: a host without it degrades quietly (residue left behind,
  `debug.log` perhaps not cleared, ownership not corrected), better learnt at a run's start than
  from a full disk weeks later. The banner has one pure renderer (results in, text out) called by
  pre-flight and the healthcheck, so the two cannot drift.

### 8.3 Known limits

- The fast path (the transport user's uid and gid equal the target's) skips the grant. A host where
  the transport user owns the docroot while the web server is another account relying on group bits
  could be judged `unnecessary` under umask `022` and stay unwritable by the web server. No cell has
  that shape (on `docker` the web user is the owner), and detecting a third user is what owner
  detection rejects as unreliable.
- `docker` is not literally untouched: each worker runs `stat` and `id` (and `pwd` without a
  declared `rootDir`) before the fast path — reads only, nothing privileged, nothing changed.

### 8.4 Open obligations

- Non-Linux targets: revisit only if a BSD/macOS `local` cell appears; `stat -c` and `id` are read
  in one function each.
- Dropping `prepareSiteDataDirs`'s `0777` floor: safe only where ownership correction is guaranteed,
  and it is best-effort by contract. Where the transport user is in the docroot's group, the grant
  alone (`ug+rwX` ⇒ `0775`) would suffice. Revisit if a cell is ever required to have working
  elevation.
- Batching the per-path commands. Measured on `pro@nginx`: preparation costs ~15 s for BackWPup's
  two original paths (about seven round-trips each) and the plugin's handover 1.8 s. With a third
  declared path and the directory the installed plugin names at runtime, the `@plugin` Before hook
  now takes 44–50 s (73 s beside another run on the same server) of its 120 s budget, plus
  `LEFT_WORK_ALLOWANCE_MS` for stopping a killed run's work (`HOOK_TIMEOUT_MS`'s comment,
  `src/common/hooks/plugin-lifecycle.ts`). It is latency, not work: `mkdir`, `chmod`, `chmod -R` and
  `chown -R` take several operands, so one command per step instead of per path would cut it about
  threefold. Deferred: it changes `normalizeOwnership`'s one-path contract and needs its own tests.
  Revisit when a product declares more than a handful of data paths, or the Before hook nears its
  budget. (Residue removal is already batched — wordpress-automation.md.)
- Running WP-CLI as the docroot owner (§8.2): rejected on evidence, not forgotten. If installing
  call sites keep leaking ownership, revisit as a per-site opt-in (`transport.runWpAs`), never a
  default.

## 9. References

- Playwright: <https://playwright.dev/docs/test-projects> ·
  <https://playwright.dev/docs/test-parallel> · <https://playwright.dev/docs/test-reporters> ·
  <https://playwright.dev/docs/api/class-testinfo> ·
  <https://playwright.dev/docs/api/class-testproject> · <https://playwright.dev/docs/test-snapshots>
  · <https://playwright.dev/docs/auth>; microsoft/playwright#38953 (`parallelIndex` is global).
- playwright-bdd (Cucumber reporter `externalAttachments` / `skipAttachments`, `defineBddConfig`
  with `tags` and a per-cell `outputDir`, POM as fixture, hooks):
  <https://vitalets.github.io/playwright-bdd/>
- Allure 3 (`allurerc.mjs`: `singleFile`, categories, dashboard):
  <https://allurereport.org/docs/playwright/> · <https://github.com/allure-framework/allure3>
- WP-CLI plugin commands and their exit codes:
  <https://developer.wordpress.org/cli/commands/plugin/>
- Docker's `wordpress` image (Apache vs `fpm`, the FastCGI note):
  <https://hub.docker.com/_/wordpress>
- execa (array args, errors): <https://github.com/sindresorhus/execa> · node-ssh:
  <https://github.com/steelbrain/node-ssh>
- Node: <https://nodejs.org/api/typescript.html> · <https://nodejs.org/api/util.html> ·
  <https://nodejs.org/api/process.html#processloadenvfilepath>
- APVM: <https://github.com/wp-media/automation-plugin-version-manager> — its napi README and
  `index.d.ts` (the API's source of truth); builders in `crates/core/src/build/plugins/`.
- Identity ground truth: `wp-media/backwpup-pro` `gulpfile.ts` (`compressPackage`, the `free`/`pro`
  tasks); `wp-media/wp-rocket` `wp-rocket.php`.
