# CLAUDE.md

Operating guide for AI agents (and humans) working in this repository. Read this
first, then follow the links into [`docs/`](docs/) for depth. Keep it accurate —
see [When to update these docs](#when-to-update-these-docs).

## Project Overview

This repository contains end-to-end (E2E) tests for WP Media plugins like WP Rocket
(a WordPress performance optimization plugin), BackWPup (a backup plugin) and
Imagify (an image optimization plugin). The test suite uses **Playwright** for
browser automation and **Cucumber** for behavior-driven development (BDD) testing.

> **Current state:** the scaffolded, runnable products are **WP Rocket** and
> **BackWPup**. Imagify is a planned product and not yet wired up — add it as a new
> product under `src/projects/` when work begins (see
> [authoring-tests.md](docs/guides/authoring-tests.md)).

## Key technologies

| Area               | Tech                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Runtime            | **Node ≥ 24.16** (see `.nvmrc`), **ESM** (`"type": "module"`)                                    |
| Language           | **TypeScript 6**, strict (`tsc` for type-checking only — Playwright transpiles via esbuild)      |
| Browser automation | **Playwright** (`@playwright/test`), Chromium only                                               |
| BDD                | **Cucumber/Gherkin** via **`playwright-bdd`** (`bddgen` generates specs)                         |
| WP-CLI transport   | **execa** (local/docker), **node-ssh** (ssh)                                                     |
| Visual diff        | **pixelmatch** + **pngjs**                                                                       |
| Reporting          | Playwright HTML, Cucumber HTML, **Allure** (`allure`, `allure-playwright`)                       |
| Quality            | **ESLint** (typescript-eslint, strict + type-checked), **Prettier**, **husky** + **lint-staged** |

## Repository structure

```
src/
├── common/                 # product-agnostic, shared by every product
│   ├── config/             # env, sites loading, run-context, metadata, the config factory
│   ├── auth/               # auth.setup.ts (login → storageState)
│   ├── fixtures.ts         # the extended test instance + Given/When/Then
│   ├── steps/              # generic step definitions
│   ├── pages/              # Page Object Model (e.g. plugins.page.ts)
│   ├── visual/             # visual-regression helpers (A/B, compare, stabilize)
│   └── wp/                 # WordPress automation over WP-CLI (exec, plugin, log, db, errors)
└── projects/<product>/
    ├── config/             # <product>.config.ts + sites.json / sites.*.json / sites.example.json
    ├── features/           # *.feature (Gherkin)
    ├── steps/              # product-specific steps
    └── support/            # e.g. debug-log.ts presets

docker/                     # local WordPress for the `docker` transport
docs/                       # architecture & guides (linked below)
playwright*.config.ts       # entry configs (default, per-product, unit)
```

### Core concepts: products, cells, pools, runs

- **Product** — a plugin under test (`wp-rocket`, `backwpup`); owns its features,
  steps, sites, and optional service credentials.
- **Cell** — a named environment (`apache`, `nginx`, `pro@nginx`). Cells are
  data-driven: the merged top-level keys of a product's sites files
  (`sites.json` + any `sites.*.json` overlays — see Configuration below).
- **Pool** — the interchangeable WordPress sites under a cell; each worker binds to
  one site by `parallelIndex`.
- **Run unit** — one `(product × cell)`. **Run exactly one cell per invocation**
  (`--project=<cell>`); selecting two at once fails fast.

Full detail — the `parallelIndex` invariant, the config factory, the credential
registry, and artifact lifecycle — is in
**[docs/architecture/execution-model.md](docs/architecture/execution-model.md)**.

## NPM commands

```bash
# Testing
npm run test                       # default product, bddgen + run
npm run test:wp-rocket -- --project=<cell>    # one product, one cell
npm run test:backwpup  -- --project=<cell>
npm run test:wp-rocket -- --project=apache --grep @smoke   # filter by tag
npm run test:ui                    # Playwright UI mode
npm run test:headed                # headed browser
npm run test:unit                  # unit/integration specs (src/common/**/*.spec.ts)
npm run test:unit:ui

# Fleet health check
npm run healthcheck                # preflight + login across every product/cell/site
npm run healthcheck:ui             # same, but headed — the browser is visible on screen

# Quality gates (see "Required workflow after every edit")
npm run typecheck                  # tsc
npm run lint                       # eslint .
npm run lint:fix                   # eslint . --fix
npm run format                     # prettier --write .
npm run format:check               # prettier --check .

# Reporting
npm run report                     # open the newest Playwright HTML report
npm run report -- wp-rocket apache # open a specific product/cell's newest report
npm run report:allure              # generate Allure report for the newest run
npm run report:allure -- wp-rocket apache --open

# Local WordPress (Docker transport)
npm run env:up                     # start + install Apache(:8100) & Nginx(:8101) sites
npm run env:down                   # stop & remove (incl. volumes)
npm run env:logs

# Browsers
npm run setup                      # playwright install chromium (also runs on postinstall)
```

## Configuration

Two surfaces — schema reference in
**[docs/guides/configuration.md](docs/guides/configuration.md)**:

- **Sites files** (per product, **git-ignored**, hold credentials) define the cells
  and their site pools. A product may use any combination of:
  - `sites.json` — the primary file.
  - `sites.<name>.json` overlays (e.g. `sites.docker.json`, `sites.local.json`,
    `sites.ssh.json`) — merged in alphabetically after `sites.json`. Each file owns a
    disjoint set of cells; a cell name appearing in two files is a hard error.
  - When **none** of the above exist, the committed `sites.example.json` (placeholder
    data, `.example.test` hostnames) is used so a fresh checkout still loads and the
    `@noauth` smoke tests pass.
    Credentials live only in these files and never enter reports.
- **`.env`** (copied from `.env.example`, loaded by
  [`load-env.ts`](src/common/config/load-env.ts)) holds runtime flags and BackWPup
  storage credentials. Real env vars always win over `.env`. Access env only through
  the typed accessors in [`env.ts`](src/common/config/env.ts).

## Fixtures

Import step builders and fixtures from [`src/common/fixtures.ts`](src/common/fixtures.ts),
**not** from `playwright-bdd` directly. Available fixtures:

| Fixture                   | Scope  | Purpose                                                                           |
| ------------------------- | ------ | --------------------------------------------------------------------------------- |
| `site`                    | test   | The `SiteConfig` bound to this worker; throws if no pool (tag `@noauth` instead). |
| `edition`                 | test   | The cell's `free`/`pro` edition; throws in editionless cells.                     |
| `boundSite`               | worker | The worker's pinned site (by `parallelIndex`); underpins `site`.                  |
| `baseURL` (override)      | —      | Points navigation at the bound site.                                              |
| `storageState` (override) | —      | The bound site's saved login, or an empty session for `@noauth`.                  |

**Auth fixture / setup:** [`src/common/auth/auth.setup.ts`](src/common/auth/auth.setup.ts)
is a dependency project that runs before any BDD scenarios. It does two things in order:

1. **Pre-flight transport verification** — for each real site, verifies that its
   transport is reachable and functional (SSH connectivity + WP-CLI + rootDir access;
   Docker container running + WP-CLI in container; local rootDir + WP-CLI in PATH) and
   that a real, installed WordPress answers (`wp core is-installed` — so core files load,
   the database connects, and the install is complete). A non-zero exit is classified so a
   WordPress that cannot boot (PHP too old, DB down, a fatal — errors it prints to stdout or
   stderr) is reported as such and never mislabeled as "not installed". A failure throws a
   formatted, actionable report and skips the whole BDD project.
2. **Authentication** — logs into each real site once through the WordPress UI and
   saves the session to that site's `storageState`, which the BDD project reuses.

The entire setup is skipped when only placeholder sites exist. Details:
[authoring-tests.md](docs/guides/authoring-tests.md#fixtures-srccommonfixturests).

**Fleet health check:** [`healthcheck.ts`](healthcheck.ts) (`npm run healthcheck`) runs
the same pre-flight + login checks as the auth setup above, but standalone (no
Playwright test run) and across **every** product × cell × site instead of one
selected cell. Output is grouped **per product** (wp-rocket / backwpup / future
imagify never blur together): products run one section at a time, sites within a
product run concurrently, and each site — pass or fail — lists every individual check
it ran (failures add actionable hints). Each site is checked independently — one
site's failure never aborts another's check — and its result prints as soon as it is
known; a final summary breaks the fleet down per product. A cell with only placeholder
sites is reported as skipped, not failed. Exits `0` only if every real site passed;
exits `1` if any failed. No `storageState` is written. Tune with `HEALTHCHECK_CONCURRENCY`
and `HEALTHCHECK_LOGIN_TIMEOUT_MS`. Useful as a fleet monitor (cron/CI) independent of
running the full suite. `npm run healthcheck:ui` runs the exact same checks with the browser
**headed** (visible on screen) so you can watch each login — the only difference is
visibility (via `--headed` / `HEALTHCHECK_HEADED=true`).

## WordPress automation layer

`src/common/wp/` drives a site over WP-CLI, **transport-agnostic** (local / docker /
ssh). Highlights — full reference in
**[docs/architecture/wordpress-automation.md](docs/architecture/wordpress-automation.md)**:

- Commands are file + args arrays (never shell strings) → no injection.
- `exec` / `wpCli` return a structured `ExecResult`; callers branch on `exitCode`.
- Plugin lifecycle separates idempotent **cleanup** (`ensurePluginAbsent`) from
  asserted **removal under test** (`uninstallPlugin`); both run
  `wp plugin uninstall --deactivate` (files + DB footprint); typed errors in `wp/errors.ts`.
- UI plugin actions live in the [`PluginsPage`](src/common/pages/plugins.page.ts) page object.

### Debug-log feature

[`wp/log.ts`](src/common/wp/log.ts) reads and categorises `wp-content/debug.log` to
catch PHP errors a UI assertion would miss. `scanDebugLog` returns
`{ raw, fatals, warnings, notices }`; it reads via `wp eval` and **falls back** to a
direct file read when WordPress can't boot (exactly when a fatal matters most).
Per-product presets are in `src/projects/<product>/support/debug-log.ts`
(`*_LOG_OPTIONS` scans everything; `*_OWN_LOG_OPTIONS` restricts to that plugin).
Pattern: `clearDebugLog` in a `Before` hook, `scanDebugLog` in an `After` hook.

## Visual testing (A/B only, for now)

The only visual model currently is the **A/B check**
([`src/common/visual/ab.ts`](src/common/visual/ab.ts)): assert a page renders the
**same with optimizations active as with them bypassed** (`?nowprocket`). Both
renders are captured live in one run and pixel-diffed — there is no committed
baseline to update. A size difference also fails (a layout change is a regression).

```ts
import { expectOptimizedToMatchUnoptimized } from "../../../common/visual/ab";
await expectOptimizedToMatchUnoptimized(page, "/pricing", {
  maxDiffPixelRatio: 0.02,
});
```

Tag such scenarios `@visual` and run them in the Playwright container for
pixel-deterministic rendering. Tolerances are in
[`src/common/config/visual.ts`](src/common/config/visual.ts). A committed-baseline
helper (`screenshot.ts`) exists as wiring but is not the active model. See the
README's "Visual regression" section for the operational walkthrough.

## Coding conventions

These are requirements, not suggestions:

- **Handle errors gracefully and explicitly.** Validate at boundaries (env,
  `sites.json`) and fail fast with actionable messages that name the offending
  input. Use the typed error classes in `wp/errors.ts` rather than bare `throw`s
  where a failure mode is meaningful. Distinguish "command outcome" (branch on
  `exitCode`) from "couldn't run at all" (throw). Best-effort side work (report
  attachments, page stabilisation) must never mask the real assertion.
- **Be strict and explicit with types.** No implicit `any`; type function
  parameters and return types. `tsconfig` is strict with
  `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, etc. Prefer
  `readonly`/discriminated unions (as the config types do) and narrow `unknown` at
  boundaries with the guards in [`guards.ts`](src/common/guards.ts).
- **Document with TSDoc — always, and only TSDoc.** Every function, method, and
  non-obvious property/constant gets a doc comment, no matter if it is private, public, isolated or not. Write for understanding: say
  _why_, not just _what_; don't restate the signature or repeat yourself. Use
  `@param name - description`, `@returns`, `@throws {@link ErrorType}`, `{@link …}`
  cross-references, and `@example` with fenced ` ```ts ` blocks. **Never** JSDoc
  type annotations (`@param {type}`, `@type {…}`) in `.ts` files — types come from
  TypeScript. (The sole exception is the `@type` in `prettier.config.js`, which is
  load-bearing for type-checking a plain `.js` config.). Do not overexplain, make sure to be understandable, but not too long if not really required.
- **Follow best practices.** Keep UI logic in page objects, WP-CLI logic in `wp/`,
  shared logic in `common/`, product specifics under `src/projects/<product>/`.
  Match the style of the surrounding code. Add a `*.spec.ts` unit test for
  non-trivial `common/` modules.
- **Separate the code correctly.** Do a very well code separation, do not overengineer anything, but separate correctly by concerns. Make sure the functions/methods are not to long.
- **Reuse code efficiently.** Create small utilities if they can be leveraged by other parts of the code instead of hardcoding everything in one isolated module (You can still isolate anything that doesn't make sense to have as "global" utility, you must assess and take the best decision case by case)
- **Write unit-testable code.** Design for testability (small, pure, dependency-injected functions) and add a `*.spec.ts` unit test for as much logic as possible. Some code (e.g. thin UI glue, Playwright wiring) may not be testable — that's fine, but it must be the exception, not the default.
- **Ship production-ready code.** Stable, robust, reliable — handle edge cases, no half-finished paths. Documentation and comments must be dense, not long: clear and understandable over verbose. Same for anything added to this file (CLAUDE.md) and plans — it must be clear and understandable, not verbose. Avoid overengineering, but do not underengineer either. Make sure to assess the best approach case by case.

## Required workflow after every edit

After finishing any code change, run **all** of these and make them pass before
considering the work done:

```bash
npm run typecheck     # tsc — no type errors
npm run lint          # eslint . — no lint errors
npm run format        # prettier --write . (or format:check in review)
npm run test:unit     # unit/integration specs pass
```

For behavioural changes, also verify against a real cell:
`npm run test:<product> -- --project=<cell>`.

`husky` + `lint-staged` run `eslint --fix` + `prettier --write` on commit, and CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) enforces typecheck, lint,
format, and the `@noauth` smoke run on both products. Don't rely on the hook — run
the gates yourself.

## Documentation map

| Read when…                                                                       | Document                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| You need the operational quick-start (install, run, report, Docker).             | [`README.md`](README.md)                                                                 |
| You're touching the run/config machinery or wondering about cells/pools/workers. | [`docs/architecture/execution-model.md`](docs/architecture/execution-model.md)           |
| You're working with WP-CLI, transports, plugin lifecycle, or debug-log.          | [`docs/architecture/wordpress-automation.md`](docs/architecture/wordpress-automation.md) |
| You're adding features, steps, fixtures, or page objects.                        | [`docs/guides/authoring-tests.md`](docs/guides/authoring-tests.md)                       |
| You're editing sites files, transports, editions, or env vars.                   | [`docs/guides/configuration.md`](docs/guides/configuration.md)                           |
| You want the full design rationale and decisions.                                | [`docs/plans/e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md)           |

## In-progress plans

Larger initiatives are tracked as living design docs in `docs/plans/`. Check
these before starting related work — they hold the current plan, not history:

- [`docs/plans/e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md) — full design rationale and decisions.
- [`docs/plans/plugin-artifact-management-plan.md`](docs/plans/plugin-artifact-management-plan.md) — plugin artifact management.

## When to update these docs

All files in `docs/`, `CLAUDE.md`, and `README.md` must stay in sync with the code.
The rule is: whoever makes the code change owns the doc update. Use the table below
to find the right file.

**Edit vs. create:** edit an existing `docs/architecture/*` or `docs/guides/*` file
whenever the topic fits one already listed below. Create a new file only for a
genuinely new subsystem/guide topic (add it to the tables here and in
[Documentation map](#documentation-map)). Start a new `docs/plans/*` doc only for
a new initiative/rewrite worth tracking as a living design doc — update the
existing plan doc for progress on one already in flight.

### This file (CLAUDE.md)

Update it when you:

- **Change the structure** — add/rename a product (e.g. wiring up Imagify), move
  directories, or change where features/steps/pages/configs live.
- **Change technologies** — add, remove, or swap a key dependency, or bump the Node
  / TypeScript baseline.
- **Add or rename an NPM script**, or change what an existing one does.
- **Add or change a fixture**, the auth flow, or the configuration mechanism
  (`.env` vars, `sites.json` schema, transports, editions).
- **Add a testing capability** — e.g. when the committed-baseline visual model or
  `@mobile` viewport support becomes active, or a new `wp/` module lands.
- **Change a convention** stated here (error handling, typing, TSDoc, workflow).

When a change is too detailed for CLAUDE.md, put it in the relevant `docs/` file
instead and link it from the [Documentation map](#documentation-map).

### docs/architecture/execution-model.md

Update it when you change anything about:

- How products, cells, pools, or run units are defined or selected.
- The `parallelIndex` invariant or the worker-to-site binding.
- The config factory (`createProductConfig`) or the project pairs it generates.
- The metadata/credential registry (`registerPool`, `routingMetadata`).
- Artifact directories, `RUN_ID` handling, or the `*_ROOT` env vars.

### docs/architecture/wordpress-automation.md

Update it when you change anything about:

- Transport modes (`local`, `docker`, `ssh`) or the `exec`/`wpCli` API.
- The plugin lifecycle functions or their error types.
- The debug-log API (`readDebugLog`, `clearDebugLog`, `scanDebugLog`, `ScanDebugLogOptions`).
- Any other `wp/` module (`db.ts`, `errors.ts`, `guards.ts`).

### docs/guides/authoring-tests.md

Update it when you change anything about:

- The BDD pipeline (bddgen, generated specs, how step files are wired).
- Fixtures (add/rename/change scope or semantics).
- Tags and their effects (`@noauth`, `@smoke`, `@visual`, `@free`/`@pro`, new tags).
- The Page Object Model conventions or page objects in `common/pages/`.
- The unit-test setup (`playwright.unit.config.ts`, `*.spec.ts` conventions).

### docs/guides/configuration.md

Update it when you change anything about:

- The `sites.json` schema (cell shape, site fields, transport fields, overrides).
- Editions (all-or-none rule, how the tag filter works).
- Environment variables (add/rename/change defaults in `.env.example`).
- The Docker local environment setup or its `sites.example.json`.

### README.md

Update it when you change anything about:

- The quick-start steps (install, first run, browser setup).
- Running commands users invoke directly (test scripts, `--project`, `--grep`).
- The reporting layer (report types, paths, Allure commands, `REPORT_MODE`).
- The Docker local environment (`env:up` / `env:down` / `env:logs`, port numbers, credentials).
- The visual regression walkthrough (the A/B model, how to run `@visual` scenarios).
- Quality-gate commands (`typecheck`, `lint`, `format:check`) or the CI behaviour.

### All docs and code files

In docs or in code comments, there might be `NOTE FROM DEV:`, they are mostly added for the IA next read to that file, so, you must read it carefuly, becuse there might be instructions for you to fix something in that doc file or the code of that file.
