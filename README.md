# wp-media-projects-e2e

End-to-end tests for WP Media products (WP Rocket, BackWPup), built on
[Playwright](https://playwright.dev) + [playwright-bdd](https://vitalets.github.io/playwright-bdd/)
(Cucumber/Gherkin). ESM, Node 24, TypeScript 6 (strict).

The authoritative design is in [`docs/plans/e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md).

## Quick start

```bash
npm install          # also downloads Chromium (see "Browsers" below)
npm run test:wp-rocket -- --project=apache
```

A fresh checkout has no `sites.json` or `sites.*.json`, so the example placeholder data is
used: the auth setup is skipped and the `@noauth` smoke scenarios pass, proving the harness
is wired up.

## Concepts

- **Product** — `wp-rocket` / `backwpup`. Each declares its own features, steps, sites,
  and (BackWPup only) service credentials. Configs live in `src/projects/<product>/config/`.
- **Cell** — a named environment (`apache`, `nginx`, future `nginx@php8.2`). Cells are
  data-driven: they are the merged top-level keys of a product's sites files (`sites.json`
  and any `sites.*.json` overlays).
- **Pool** — the list of interchangeable WordPress sites under one cell. Each worker binds
  to one site by `parallelIndex`, so scenarios are distributed across the pool.
- **Run unit** — one `(product × cell)`. Run exactly one cell per invocation with
  `--project=<cell>`; selecting two cells at once fails fast (the global `parallelIndex`
  would overflow a smaller pool — see plan §3.2).

## Running

```bash
npm run test:wp-rocket -- --project=<cell>     # one product, one cell
npm run test:backwpup  -- --project=<cell>
npm run test:wp-rocket -- --project=apache --grep @smoke
```

Reports accumulate per run at `reports/<product>/<cell>/<RUN_ID>/`. Set `REPORT_MODE=rich`
for an external report with the embedded trace viewer.

## Health check

```bash
npm run healthcheck
```

Verifies every configured site — across **all** products, cells, and pools, not just
one selected cell — is reachable and usable: transport connectivity, WP-CLI, a real
installed WordPress, and a working UI login (`healthcheck.ts`). Each site is checked
independently and reported the moment it finishes, with color-coded ✔/✖/⚠ status and,
for failures, the specific failing check plus an actionable hint. A cell with no real
sites yet (placeholder data) is reported as skipped, not failed. Exits `0` only when
every real site passed, `1` if any failed — safe to wire into CI or a cron monitor.

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
optional runtime flags). Real environment variables always win over `.env`.

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
npm run test:wp-rocket -- --project=apache    # or --project=nginx
```

The cells use `transport: { mode: "docker", container: "wpme-wpcli-apache" | "wpme-wpcli-nginx" }`,
matching the compose `container_name`s. Sites are installed as `admin` / `admin_password`.

## Reporting

Every run writes a layered set of reports into `reports/<product>/<cell>/<RUN_ID>/`:

- **`playwright/`** — Playwright's HTML report with the interactive **trace viewer**, video, and
  screenshots. Open with `npx playwright show-report reports/<product>/<cell>/<RUN_ID>/playwright`.
- **`cucumber/`** — the Gherkin (BDD) report. By default it is one portable, self-contained HTML
  with screenshots/video embedded on failure; set `REPORT_MODE=rich` for an external report that
  embeds the interactive trace viewer (serve it over http, not `file://`).
- **`allure-results/`** — raw results for **Allure**, the analytics layer (history/trends, flaky
  detection, dashboard).

Generate the Allure report from the most recent run:

```bash
npm run report:allure                              # newest run of any cell
npm run report:allure -- wp-rocket apache          # a specific product/cell
npm run report:allure -- wp-rocket apache --open   # generate and serve in the browser
```

The report lands in `reports/<product>/<cell>/<RUN_ID>/allure/`. **Trends accumulate across runs**
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

Tag such scenarios `@visual` so they can be run as a group, and run them in the Playwright container
(as CI does) for pixel-deterministic rendering:

```bash
npm run test:wp-rocket -- --project=apache --grep @visual
```

## Quality gates

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run format:check # prettier --check .
```
