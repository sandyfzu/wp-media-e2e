# wp-media-projects-e2e

End-to-end tests for WP Media products (WP Rocket, BackWPup), built on
[Playwright](https://playwright.dev) + [playwright-bdd](https://vitalets.github.io/playwright-bdd/)
(Cucumber/Gherkin). ESM, Node 24, TypeScript 6 (strict).

The authoritative design is in [`docs/plans/e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md).

## Quick start

```bash
npm install          # also downloads Chromium (see "Browsers" below)
E2E_CELL=apache npm run test:wp-rocket
```

A fresh checkout has no `sites.json` or `sites.*.json`, so the example placeholder data is
used: the auth setup is skipped and the `@noauth` smoke scenarios pass, proving the harness
is wired up. Add `--grep @noauth` to run **only** those — anything else needs a real
WordPress (this is exactly what CI does).

## Concepts

- **Product** — `wp-rocket` / `backwpup`. Each declares its own features, steps, sites,
  and (BackWPup only) service credentials. Configs live in `src/projects/<product>/config/`.
- **Cell** — a named environment (`apache`, `nginx`, future `nginx@php8.2`). Cells are
  data-driven: they are the merged top-level keys of a product's sites files (`sites.json`
  and any `sites.*.json` overlays).
- **Pool** — the list of interchangeable WordPress sites under one cell. Each worker binds
  to one site by `parallelIndex`, so scenarios are distributed across the pool.
- **Run unit** — one `(product × cell)`. Run exactly one cell per invocation, pinned with
  `E2E_CELL=<cell>`; selecting two cells at once fails fast (the global `parallelIndex`
  would overflow a smaller pool — see plan §2.1).

## Running

```bash
E2E_CELL=<cell> npm run test:wp-rocket     # one product, one cell
E2E_CELL=<cell> npm run test:backwpup
E2E_CELL=apache npm run test:wp-rocket -- --grep @smoke
```

`E2E_CELL` pins the whole run — `bddgen`, the runner and its workers — to one cell: the config
holds that cell alone, so `bddgen` regenerates only its specs and runs of different cells of one
product can go side by side. `--project=<cell>` also runs one cell, but `bddgen` never sees it and
regenerates **every** cell's specs, deleting them first, so it breaks another run of the same
product started beside it. Each run prints one `[cell]` line before `Running …` naming its cell,
how it was chosen, its workers and its report folder. A pin naming no cell of the product, or a
`--project` selecting none of the pinned cell's projects, fails at once naming `E2E_CELL`. With a
pin, `--project` still narrows the run within the cell (`--project=artifacts:<cell>` resolves its
zips only).

Do not set `E2E_CELL` in `.env`: `.env` is read from the working directory, so it would pin every
run started there. A `--reporter` on the command line replaces the configured reporters, the
`[cell]` line with them.

Reports accumulate per run at `reports/<product>/<cell>/<RUN_ID>/`. Set `REPORT_MODE=rich`
for an external report with the embedded trace viewer.

## Health check

```bash
npm run healthcheck
```

Verifies every configured site — across **all** products, cells, and pools, not just
one selected cell — is reachable and usable: transport connectivity, WP-CLI, a real
installed WordPress, and a working UI login (`healthcheck.ts`). Output is grouped **per
product** so projects never blur together. Each site is checked independently and
reported the moment it finishes, with color-coded ✔/✖/⚠ status; every site lists the
individual checks it ran, and failures add the specific failing check plus an actionable
hint. A cell with no real sites yet (placeholder data) is reported as skipped, not
failed. Exits `0` only when every real site passed, `1` if any failed — safe to wire
into CI or a cron monitor. Tune concurrency and the login timeout with
`HEALTHCHECK_CONCURRENCY` / `HEALTHCHECK_LOGIN_TIMEOUT_MS`.

Run `npm run healthcheck:ui` for the same checks with the browser **visible on screen**
(headed) — handy for watching a login happen or debugging a flaky site. It behaves
identically otherwise.

## Orchestrator (cells in loops)

Runs cells on this machine in loops — a run, a cooldown, the next run — and reports each run to
Slack and Datator. Every option goes after `--`.

```bash
mkdir -p .orchestrator && chmod 700 .orchestrator
cp orchestrator/config.example.json .orchestrator/config.json && chmod 600 .orchestrator/config.json
# edit it: one task per cell, the secrets, Slack's webhook, Datator's key
npm run orchestrator -- start --dry-run              # check it; runs and writes nothing
npm run orchestrator -- start --task <id> --once     # one run, exit 0 (passed/flaky), 1, or 130 if stopped
tmux new -d -s orchestrator 'npm run orchestrator -- start'   # every task, until stopped
tmux send-keys -t orchestrator C-c                   # stop: runs finish their scenario
```

Install, every config field, stopping, the files it keeps and what to do when it refuses:
[docs/guides/orchestrator.md](docs/guides/orchestrator.md).

## Configuring sites

A product's sites are declared in one or more JSON files under
`src/projects/<product>/config/` (all git-ignored — they hold credentials):

- **`sites.json`** — the primary file.
- **`sites.<name>.json`** overlays (e.g. `sites.docker.json`, `sites.local.json`,
  `sites.ssh.json`) — merged in alphabetically after `sites.json`. Each file owns a
  disjoint set of cells; a cell name in two files is a hard error.

When none of the above exist, the committed `sites.example.json` is used (placeholder data,
`.example.test` hostnames) so the suite still loads and the `@noauth` smoke scenarios pass
on a fresh checkout.

```bash
cp src/projects/wp-rocket/config/sites.example.json src/projects/wp-rocket/config/sites.json
```

Credentials live only in sites files and never enter Playwright reports.

## Environment

Copy `.env.example` to `.env` and fill in what you need (BackWPup storage credentials,
optional runtime flags). Real environment variables always win over `.env`;
`E2E_LOAD_DOTENV=false` in the environment skips the file.

## Browsers

`npm install` downloads Chromium via a `postinstall` hook. This repo commits an
`.npmrc` with `ignore-scripts=false` so that hook runs even on machines that disable
install scripts globally. If browsers are ever missing, run:

```bash
npm run setup        # = playwright install chromium
```

## Local WordPress (Docker) — the `docker` transport

A self-contained WordPress environment for the `docker` transport lives in [`docker/`](docker/):
two **independent** installs over one MariaDB — **Apache** on `:8100` and **Nginx** (php-fpm)
on `:8101` — each with a kept-alive `wp-cli` container the suite drives via `docker exec`.

```bash
npm run env:up      # start containers + install both sites (idempotent) — needs the Docker daemon
npm run env:down    # stop and remove everything (incl. volumes)
npm run env:logs    # tail container logs
```

Point a product at it by copying the docker example into its sites file:

```bash
cp docker/sites.example.json src/projects/wp-rocket/config/sites.docker.json
E2E_CELL=apache npm run test:wp-rocket    # or E2E_CELL=nginx
```

The cells use `transport: { mode: "docker", container: "wpme-wpcli-apache" | "wpme-wpcli-nginx" }`,
matching the compose `container_name`s. Sites are installed as `admin` / `admin_password`.

## Reporting

Every run writes a layered set of reports into `reports/<product>/<cell>/<RUN_ID>/`:

- **`playwright/`** — Playwright's HTML report with the interactive **trace viewer**, video, and
  screenshots. Open the newest with `npm run report` (add `-- <product> <cell>` to target one), or a
  specific one with `npx playwright show-report reports/<product>/<cell>/<RUN_ID>/playwright`.
- **`cucumber/`** — the Gherkin (BDD) report. By default it is one portable, self-contained HTML
  with screenshots/video embedded on failure; set `REPORT_MODE=rich` for an external report that
  embeds the interactive trace viewer (serve it over http, not `file://`).
- **`allure-results/`** — raw results for **Allure**, the analytics layer (history/trends, flaky
  detection, dashboard).
- **`results.jsonl`** — every attempt and the run's totals, one JSON line each, written as the run
  goes: what a script watches, and what the orchestrator reads once a run has ended. Schema in
  [`results-schema.ts`](src/common/reporting/results-schema.ts).
- **`run-facts.json`** — what the run tested: the plugin (ref, full commit, zip, **SHA-256**), each
  site's WordPress, PHP, web server and database, the run's name and verdict. Rewritten as each setup
  ends, so a killed run's still says what it had (`"status": "running"`).

**Every report says up front what it tested**, in one line —
`backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · develop @ 1dceea8966 · WordPress 7.1.3 · PHP 8.5.11 64bit · <run>`
(plus `RUNNING`, `INTERRUPTED`, `STOPPED`, `COULD NOT TEST` or `NO TESTS`, which the reports cannot say themselves): the Playwright
report's title (its Metadata panel lists every fact with `#?show-metadata-other` in the URL), a banner
above the Cucumber report (expand it for every fact), and the Allure report's name and Metadata. A fact
that is not known says why (`site unknown: auth setup failed`). `E2E_RUN_NAME` names the run;
`E2E_REQUESTED_REF` shows the ref asked for (both display only); a `PLAYWRIGHT_HTML_TITLE` you set wins.

A run ends with a summary below everything else: the verdict (`✘ COULD NOT TEST` when a setup
failed, `■ STOPPED` when it was stopped), the counts, the plugin and sites it tested, how to open each report, and which old reports
it pruned.

**Old reports are pruned as each run ends**, for that run's cell only: at most `E2E_REPORTS_KEEP`
(20; `0` lifts the cap, not the age rules), none older than 30 days except the cell's newest
complete report, kept up to 182 days. A cell that no longer runs is pruned by hand:

```bash
npm run report:prune                                   # dry run: every report, its decision and why
npm run report:prune -- --apply                        # remove what the policy says goes
npm run report:prune -- --product backwpup --cell pro@nginx --keep 5 --older-than 2w --apply
```

Generate the Allure report from the most recent run:

```bash
npm run report:allure                              # newest run of any cell
npm run report:allure -- wp-rocket apache          # a specific product/cell
npm run report:allure -- wp-rocket apache --open   # generate and serve in the browser
```

The report lands in `reports/<product>/<cell>/<RUN_ID>/allure/`, named by the run's facts line. **Trends accumulate across runs**
via a per-cell history file (`reports/<product>/<cell>/allure-history.jsonl`), so the trend chart
fills in from the second run onward; flaky tests are flagged per run from retries. Report content
(categories, dashboard widgets, single-file output) is configured in [`allurerc.mjs`](allurerc.mjs).

## Visual regression

Visual checks assert that a page renders the **same with optimizations active as with them bypassed**
(`?nowprocket`) — i.e. lazy-load, CSS/JS handling, etc. don't visually break the page. Both renders
are captured live in the same run and pixel-diffed against each other, via [`src/common/visual/ab.ts`](src/common/visual/ab.ts):

```ts
import { expectOptimizedToMatchUnoptimized } from "../../../common/visual/ab";

await expectOptimizedToMatchUnoptimized(page, "/pricing");
await expectOptimizedToMatchUnoptimized(page, "/pricing", {
  mask: [page.locator(".ad-slot")], // ignore regions that legitimately differ
  maxDiffPixelRatio: 0.02, // loosen tolerance for this page
});
```

It navigates to the bypassed page (`?nowprocket`) and the optimized page, stabilises each (scrolls to
load lazy media, waits for fonts), and fails if they differ beyond the tolerance — attaching both
renders and a highlighted diff to the report. A size difference also fails (a layout change is a
regression). Tolerances live in [`src/common/config/visual.ts`](src/common/config/visual.ts).

Tag such scenarios `@visual` so they can be run as a group, and run them in the Playwright
container image for pixel-deterministic rendering:

```bash
E2E_CELL=apache npm run test:wp-rocket -- --grep @visual
```

## Quality gates

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run format:check # prettier --check .
```
