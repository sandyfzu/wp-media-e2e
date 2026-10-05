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

| Area               | Tech                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime            | **Node ≥ 24.16** (see `.nvmrc`), **ESM** (`"type": "module"`)                                                                                                   |
| Language           | **TypeScript 6**, strict (`tsc` for type-checking only — Playwright transpiles via esbuild)                                                                     |
| Browser automation | **Playwright ≥ 1.62** (`@playwright/test`), Chromium only — the floor is load-bearing, see [wordpress-automation.md](docs/architecture/wordpress-automation.md) |
| BDD                | **Cucumber/Gherkin** via **`playwright-bdd`** (`bddgen` generates specs)                                                                                        |
| WP-CLI transport   | **execa** (local/docker), **node-ssh** (ssh)                                                                                                                    |
| Visual diff        | **pixelmatch** + **pngjs**                                                                                                                                      |
| Reporting          | Playwright HTML, Cucumber HTML, **Allure** (`allure`, `allure-playwright`)                                                                                      |
| Quality            | **ESLint** (typescript-eslint, strict + type-checked), **Prettier**, **husky** + **lint-staged**                                                                |

## Repository structure

```text
src/
├── common/                 # product-agnostic, shared by every product
│   ├── config/             # env, sites loading, run-context, metadata, devices, file-owner rule, the config factory
│   ├── auth/               # auth.setup.ts (login → storageState)
│   ├── fixtures.ts         # the extended test instance + Given/When/Then
│   ├── steps/              # generic step definitions
│   ├── hooks/              # shared scenario hooks (*.hooks.ts) + their policy modules
│   ├── pages/              # cross-product Page Object Model (e.g. plugins.page.ts)
│   ├── visual/             # visual-regression helpers (A/B, compare, stabilize)
│   ├── artifacts/          # the plugin zips under test (resolve, verify, consume, pre-warm)
│   └── wp/                 # WordPress automation over WP-CLI (exec, php, staging, plugin, log, options, cron, files, archive, residue, db-residue, ownership, paths, cache, db, teardown, errors)
└── projects/<product>/
    ├── config/             # <product>.config.ts + sites.json / sites.*.json / sites.example.json
    ├── fixtures.ts         # this product's test instance: common's + its page objects
    ├── features/           # *.feature (Gherkin)
    ├── pages/              # this product's page objects (+ locator-contract specs)
    ├── steps/              # product-specific steps
    └── support/            # debug-log presets, leftover declarations (files + database), REST barriers, WP-CLI readers, the CLI-under-test runner, running-job probes and stop, site setup

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
npm run test:unit                  # unit/integration specs (src/**/*.spec.ts)
npm run test:unit:ui

# Fleet health check
npm run healthcheck                # preflight + login across every product/cell/site
npm run healthcheck:ui             # same, but headed — the browser is visible on screen

# Plugin artifacts (pre-warm APVM's cache for the zips under test)
npm run artifacts:warm             # warm every real cell's requests (CI/local prep)
npm run artifacts:warm -- --product=backwpup --cell=pro@nginx  # narrow to one unit

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

Import step builders and fixtures from a `fixtures.ts`, **not** from `playwright-bdd`
directly. Product steps import from **their product's** `fixtures.ts` (which extends the
shared one with that product's page objects); product-agnostic steps and hooks import from
[`src/common/fixtures.ts`](src/common/fixtures.ts). playwright-bdd resolves each scenario to
the most-extended instance its steps use, so the two mix freely — but the product's
`fixtures.ts` must appear in its `steps` config, or generation fails outright. Available
shared fixtures:

| Fixture                   | Scope  | Purpose                                                                                                                       |
| ------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `site`                    | test   | The `SiteConfig` bound to this worker; throws if no pool (tag `@noauth` instead).                                             |
| `edition`                 | test   | The cell's `free`/`pro` edition; throws in editionless cells.                                                                 |
| `boundSite`               | worker | The worker's pinned site (by `parallelIndex`); underpins `site`.                                                              |
| `pluginArtifact`          | test   | `pluginArtifact(role)` → the resolved zip under test; `.slug` addresses the plugin, `.zipPath` feeds `stageAndInstallPlugin`. |
| `releaseBoundSite`        | worker | Automatic teardown: removes the site's staging area, closes SSH connections. Best-effort — never fails a passing run.         |
| `baseURL` (override)      | —      | Points navigation at the bound site.                                                                                          |
| `storageState` (override) | —      | The bound site's saved login, or an empty session for `@noauth`.                                                              |
| device options (override) | —      | `viewport` / `userAgent` / `isMobile` / `hasTouch` / `deviceScaleFactor`: the `@mobile` profile, else the desktop default.    |

BackWPup's [`fixtures.ts`](src/projects/backwpup/fixtures.ts) adds `onboarding`, `firstBackup`,
`dashboard`, `dataSelection`, `frequency`, `storages`, `jobRun`, `backupHistory`, `restore`
(edition-aware), `plugins`, `cli`, `markers`, `archives`, `privateFolder`, `keys`, `jobExports` and `tablePadding`. `cli` runs one `wp backwpup …`
subcommand and remembers the result for the step that asserts on it — for the feature where the
**command is the system under test**, so a refusal is returned rather than thrown (`support/cli.ts`);
use `support/backups.ts` when WP-CLI is only arranging or checking a site, since that one throws. A
command names what the plugin allocates in braces — `{job}`, `{oldest backup}`, `{newest log}`,
`{path to the newest backup}`, `{private folder}`, `{encryption key}`, `{public key file}` — filled as
it runs, from the site or from the scenario's own record of what it made there
(`support/placeholders.ts`); a misspelt one is refused by name, and the text as written may not name
a path off the site. A `--key=` value never appears in a message naming the command (`commandLine` hides it — `describeCli`, time limits, parse errors).
`markers` plants a random value in the site's files and another in its database, and removes both
afterwards, so a scenario can ask an archive what it actually captured. Requesting it _plants_ them,
so it must be requested before the backup under inspection runs. `archives` records each archive a
scenario's backups left, with its digest, as it was made — what "byte for byte" and "the oldest
backup" are measured against; `privateFolder` is the scenario's own folder in the site's staging
area for the files a command writes or reads — a download, an export, a key — private to the
transport's user, since the web server serves what it can read there, and removed afterwards only if
a step used it. `keys` draws the scenario's encryption keys (two hex keys, an RSA pair placed in that
folder) the first time a placeholder names one; `jobExports` records a digest of the site's jobs as
each export is arranged, what "as they were" is measured against; `tablePadding` pads the site's
database with empty tables of its own (`<prefix>e2e_pace_NNN`) so a paced backup, which pauses once
per table, lasts as long on every site — removed after the `@plugin` teardown, only if a step padded.
Padding can never pile up (fixed names, and every padding drops the last first), and what a killed run
left is dropped when the next BackWPup run's worker starts (`leftoverPaddingSweep`, automatic). See [authoring-tests.md](docs/guides/authoring-tests.md#page-object-model) for
the pattern, the locator policy, and the locator-contract spec every page object carries.

## Shared scenario hooks

[`src/common/hooks/`](src/common/hooks/) holds product-agnostic scenario hooks. Each
`*.hooks.ts` file is a thin binding to the BDD runtime; its policy lives in a sibling
module so it is unit-testable without the runtime.

**`@plugin`** ([`plugin.hooks.ts`](src/common/hooks/plugin.hooks.ts)) — tag a scenario
`@plugin` and it gets:

- **Before** — `debug.log` cleared, any existing copy of the plugin uninstalled (so the
  install is genuinely fresh, DB footprint included), then the cell's own resolved
  artifact staged and installed with `--activate`, its files handed back to the ownership the
  **site** uses (WP-CLI installs as the transport's user, which the web server is not — see
  `wp/ownership.ts`) — and the plugin's **active state re-asserted**, never inferred from the
  install's exit code — and, between the removal and the install, the plugin's leftover **database
  footprint** swept off what is actually on the site (`ProductConfig.siteDbResidue`). That sweep is
  keyed off the footprint, never off `is-installed`, which is a _file_ test: a site whose plugin
  directory went without its `uninstall.php` ever running looks clean and would otherwise be
  installed straight on top of the last run's rows. The edition is never named:
  the slug comes from `pluginArtifact("plugin").slug`. Finally the product's declared data
  directories (`ProductConfig.siteResidue`) are created, opened to **both** users sharing the
  docroot and handed to the site's ownership — WP-CLI and the web server are different users on a
  real cell, and whichever writes first would otherwise lock the other out (`prepareSiteDataDirs`).
  A step that must reinstall part-way uses `replacePluginUnderTest` — the same install without the
  log reset, so the teardown still judges the scenario's whole log — with `declaredResidue`.
- **After** — `debug.log` scanned with the product's preset: a **PHP fatal fails the
  scenario** (`DebugLogFatalError`) with the log attached; warnings/notices are logged.
  Then any **work the plugin is still running** is stopped (`ProductConfig.stopRunningWork` — for
  BackWPup, a backup job a scenario left running, which runs in a web request and would otherwise
  outlive the uninstall), then the plugin is removed, then any **database footprint** that
  outlived its uninstall is swept, and finally the **files it left behind** are cleared
  (`ProductConfig.siteResidue`) — a plugin's uninstall keeps the data it wrote, so a suite that
  reinstalls per scenario would fill the cell's disk. All five duties always run, independently: a
  sweep is not skipped because the uninstall failed. The log verdict wins when more than one
  fails, and the others are still logged. Having to stop running work is reported, not failed;
  work that _would not_ stop is a cleanup failure. Left-over data the transport's user is not
  _permitted_ to remove is reported, not failed — see
  [wordpress-automation.md](docs/architecture/wordpress-automation.md).
- The scenario timeout is extended **additively** to cover both hooks (remote WP-CLI plus
  an SFTP upload is slow), so a scenario keeps any budget it asked for.

**MUST — `src/common/hooks/**/*.hooks.ts` belongs in every product's `steps` globs.**
Hooks register only when their file is imported, and that glob is the only importer: omit
it and the lifecycle is _silently absent_ rather than failing.

A product declares its `debug.log` scan preset as `ProductConfig.debugLog` (from its
`support/debug-log.ts`) and how to stop its background work as `ProductConfig.stopRunningWork`;
the config factory registers both per process, so the shared hooks never import product code — and
neither RegExp patterns nor functions can ride project metadata anyway.

## Device profiles (desktop & `@mobile`)

Device is a **per-scenario client** concern, so it is tag-driven and never multiplies the
project matrix ([`config/devices.ts`](src/common/config/devices.ts)):

- **Default: desktop** — Desktop Chrome at `1600×700`, applied by the config factory.
- **`@mobile`** — Pixel 5 (a **Chromium** preset, matching the only browser we run) at
  `389×829`, applied via the `use` overrides above. Taking a real device preset rather
  than just a narrow viewport is what makes responsive CSS, touch handlers and any
  server-side `wp_is_mobile()` branch behave as they do for a real visitor. Both viewports
  are pinned, so a Playwright upgrade cannot shift viewport-sensitive expectations.

## Improvement gate (lint)

`eslint.config.js` bans four flaky-by-construction waits across `src/projects/**`,
`src/common/pages/**`, `src/common/steps/**` and `src/common/hooks/**`: `waitForTimeout`,
`waitForLoadState("networkidle")`, `waitForSelector`, and `.type()`. Each message names
the replacement. Each selector matches the member expression in the **call's `.callee`
field**, so passing a property that merely shares one of those names (`describe(job.type)`)
is not flagged — a gate that fires on innocent code is one people start disabling. The single deliberate exception is out of scope by design —
[`visual/stabilize.ts`](src/common/visual/stabilize.ts) uses one timeboxed, already-caught
`networkidle` attempt to settle lazy media before a screenshot.

**Auth fixture / setup:** [`src/common/auth/auth.setup.ts`](src/common/auth/auth.setup.ts)
is a dependency project that runs before any BDD scenarios. It does two things in order:

1. **Pre-flight transport verification** — for each real site, verifies that its
   transport is reachable and functional (SSH connectivity + WP-CLI + rootDir access;
   Docker container running + WP-CLI in container; local rootDir + WP-CLI in PATH) and
   that a real, installed WordPress answers (`wp core is-installed` — so core files load,
   the database connects, and the install is complete). A non-zero exit is classified so a
   WordPress that cannot boot (PHP too old, DB down, a fatal — errors it prints to stdout or
   stderr) is reported as such and never mislabeled as "not installed". Once those pass, it
   also asserts the **admin UI is English** (`determine_locale()` for the configured user —
   the same function WordPress uses to pick an admin request's language, so it accounts for a
   per-user override, the site option, a `WPLANG` constant and filters alike). Page objects
   locate controls by their visible English names, so a translated site would otherwise fail
   as many unrelated locator timeouts instead of once, here. Two further checks are **reports, not
   gates**: **File ownership** says what will happen to the files this run installs (the same
   `planOwnership` decision `normalizeOwnership` acts on, taken once and shared, so the report and
   the action can never disagree), and **Elevation** says whether passwordless `sudo` is available.
   Neither fails a site for a property of the _host_ — the single exception is a
   `transport.fileOwner` that cannot be parsed, which is our own configuration being unreadable and
   fails like any other config error. A failure of any gating check throws a formatted, actionable
   report and skips the whole BDD project; the reports instead fold into one run-level warning
   banner ([`setup/elevation-report.ts`](src/common/setup/elevation-report.ts)), printed once per
   run, silent when every site can elevate or has opted out, and naming the ownership cost only for
   the sites that actually needed a handover.
2. **Authentication** — logs into each real site once through the WordPress UI and
   saves the session to that site's `storageState`, which the BDD project reuses.

The shared login ([`auth/login.ts`](src/common/auth/login.ts)) confirms each credential
field actually kept its value before submitting. `fill()` writes into whatever element has
focus at that instant, and WordPress's login page re-focuses the username field, so a
re-focus landing mid-fill otherwise diverts the password into the username box and the run
fails much later as "login never settled".

> **Traces carry site credentials.** Playwright records every `fill()` argument, so a
> retained trace (`trace: "retain-on-failure"`) contains the site password. Treat
> `test-results/` and report artifacts as sensitive, exactly like the sites file. Login
> failures are asserted in code rather than with `toHaveValue` so at least the failure
> _message_ never quotes the password.

The entire setup is skipped when only placeholder sites exist. Details:
[authoring-tests.md](docs/guides/authoring-tests.md#fixtures-srccommonfixturests).

**Fleet health check:** [`healthcheck.ts`](healthcheck.ts) (`npm run healthcheck`) runs
the same pre-flight + login checks as the auth setup above, but standalone (no
Playwright test run) and across **every** product × cell × site instead of one
selected cell. Output is grouped **per product** (wp-rocket / backwpup / future
imagify never blur together): products run one section at a time, sites within a
product run concurrently, and each site — pass or fail — lists every individual check
it ran — including the ownership and elevation reports above, and the same shared warning banner
(the renderer is shared, so the two entry points cannot drift; the healthcheck prints it to
**stdout**, since its whole output is the report and `healthcheck > fleet.log` must not drop it).
Failures add actionable hints. Each site is checked independently — one
site's failure never aborts another's check — and its result prints as soon as it is
known; a final summary breaks the fleet down per product. A cell with only placeholder
sites is reported as skipped, not failed. Exits `0` only if every real site passed;
exits `1` if any failed. No `storageState` is written. Tune with `HEALTHCHECK_CONCURRENCY`
and `HEALTHCHECK_LOGIN_TIMEOUT_MS`. Useful as a fleet monitor (cron/CI) independent of
running the full suite. `npm run healthcheck:ui` runs the exact same checks with the browser
**headed** (visible on screen) so you can watch each login — the only difference is
visibility (via `--headed` / `HEALTHCHECK_HEADED=true`).

## Plugin artifacts (the zips under test)

Every run resolves **and verifies** the plugin zips it will test before any
scenario runs. Two **roles** per product: `plugin` (the artifact under test) and
`previous` (an older artifact some tests compare against, e.g. an update path). The
whole capability is product-agnostic under
[`src/common/artifacts/`](src/common/artifacts/); the full design — manifest,
request model, resolution lifecycle, preflight, pre-warm — is in
**[docs/architecture/plugin-artifacts.md](docs/architecture/plugin-artifacts.md)**.

- **Resolution + preflight** run in the `artifacts:<cell>` setup project (a sibling
  of the auth setup; the BDD project depends on both). Per role it either **builds**
  a git ref through APVM or **copies** an operator-provided zip into a wiped
  `.artifacts/<product>/<cell>/`, then a static identity preflight asserts each zip
  is the exact plugin **and edition** expected before writing `resolution.json`.
  Placeholder-only cells skip it — a fresh checkout builds nothing and needs no token.
- **APVM** ([`apvm-napi`](https://github.com/wp-media/automation-plugin-version-manager))
  is pinned in `package.json` to `…#cli/v3.0.0` — it commits prebuilt native
  binaries, so there is no Rust toolchain or build step. BackWPup builds from a
  **private** source repo, so it needs a GitHub token: set `GITHUB_TOKEN` or run
  `gh auth login`. WP Rocket / Imagify are public (a token there only raises rate
  limits).
  **MUST — APVM is used only through this Node library, never its `apvm` CLI**, anywhere in the
  repo (suite, scripts, the orchestrator). A capability only the CLI has waits for a library
  release that exposes it. AI Agents can still use the CLI in a shell if required, but it must never be used in the repo's codebase.
- **Consumption:** a scenario reads its zip through the `pluginArtifact` fixture —
  `stageAndInstallPlugin(site.transport, a.zipPath, { activate: true, slug: a.slug })` (where
  `a = pluginArtifact("plugin")`; the `slug` is what restores the plugin's file ownership).
  It reads `resolution.json` (or the in-process memo). Requesting a role the product
  does not support throws (see the MUST below). **`zipPath` is a path on the runner**,
  so `installPlugin` alone works only on a `local` transport — `ssh`/`docker` need the
  artifact staged onto the site first (see the WordPress automation layer below).
- **Overrides:** six `E2E_*` env vars select a git ref **or** a prebuilt zip per role
  (ref XOR zip) — full table and rules in
  [configuration.md](docs/guides/configuration.md).
- **Pre-warm:** `npm run artifacts:warm` primes APVM's cache for the cells a run will
  need, so each `artifacts:<cell>` build becomes a cache copy. It plans through the
  same request builder the resolver uses (the parity invariant), so a warmed entry is
  always the one a run looks up.

**Identity matrix** (what the preflight asserts — the slug alone pins product +
edition; the header is a second, exact-equality witness):

| Product / edition | Top-level dir (slug) | `Plugin Name:` header |
| ----------------- | -------------------- | --------------------- |
| WP Rocket         | `wp-rocket/`         | `WP Rocket`           |
| BackWPup Free     | `backwpup/`          | `BackWPup`            |
| BackWPup Pro      | `backwpup-pro/`      | `BackWPup Pro`        |

**MUST — BackWPup `previous` role (deferred).** BackWPup has **no `previous` role
yet** (no comparison tests): its manifest declares `plugin` only, so
`pluginArtifact("previous")` **throws** and any `E2E_PREVIOUS_*` var is
warned-and-ignored. When comparison tests arrive, add a `previous` default ref
(`release:latest-stable`) **and** a `previous` default version to
[`backwpup.config.ts`](src/projects/backwpup/config/backwpup.config.ts). Resolution
and the preflight are manifest-driven, so declaring the role automatically enables
the second artifact's verification — which **must not** be skipped (a comparison
test may never consume an unverified zip). The obligation is mirrored as a comment
on that manifest.

## WordPress automation layer

`src/common/wp/` drives a site over WP-CLI, **transport-agnostic** (local / docker /
ssh). Highlights — full reference in
**[docs/architecture/wordpress-automation.md](docs/architecture/wordpress-automation.md)**:

- Commands are file + args arrays (never shell strings) → no injection.
- **An exec error names the program and the reason, never the arguments** — on every transport,
  since the argv carries `--key=` values and every value a snippet embeds. Never pass on execa's
  `message`/`shortMessage`/`command`, nor attach its error as a `cause`; name a BackWPup command
  through `commandLine` (`support/cli.ts`), which hides a `--key=` value.
- `exec` / `wpCli` return a structured `ExecResult`; callers branch on `exitCode`.
  Every command runs with the WordPress root as its working directory (`rootDir` for
  `local`/`ssh`, the container `WORKDIR` for `docker`), and with no input — nothing is ever typed
  into one — so a `[y/n]` prompt declines at once, at exit 0 having done nothing, on every
  transport (measured).
- **Files must reach the site before `wp` can read them.** `exec.ts` also owns the
  transfer primitives (`wpRootDir`, `copyIntoTarget` → `fs` copy / `docker cp` /
  SFTP), and [`wp/staging.ts`](src/common/wp/staging.ts) builds the per-site
  `.e2e_temp/<category>/` staging area on top: `stageArtifact` (any artifact),
  `stageAndInstallPlugin` (stage + install a zip), `cleanSiteStaging` (teardown,
  best-effort). Overridable per site (`transport.stagingDir`) or globally
  (`E2E_SITE_STAGING_DIR`). [`wp/teardown.ts`](src/common/wp/teardown.ts)
  (`releaseSite`) composes that removal with closing pooled SSH connections, and runs
  once per worker via the `releaseBoundSite` fixture.
- Plugin lifecycle separates idempotent **cleanup** (`ensurePluginAbsent`) from
  asserted **removal under test** (`uninstallPlugin`); both **deactivate as their own
  WP-CLI call**, then run plain `wp plugin uninstall` (files + DB footprint) — never
  `uninstall --deactivate`, which makes a plugin's own cleanup skip itself; typed
  errors in `wp/errors.ts`.
- UI plugin actions live in the [`PluginsPage`](src/common/pages/plugins.page.ts) page object.
- [`wp/options.ts`](src/common/wp/options.ts) reads WordPress options (`getOption`,
  `getOptionJson`) so a scenario can assert what a plugin _persisted_, not just what a
  screen rendered. A missing option reads as `undefined`; a WordPress that cannot boot
  throws, so the two can never be confused. `wp/db.ts` adds `tablePrefix` for the same
  reason — never hard-code `wp_`.
- [`wp/cron.ts`](src/common/wp/cron.ts) covers WP-Cron: `nextScheduled` proves an event is
  registered (by hook **and** args — one hook commonly carries an event per job), and
  `triggerScheduledEvent` brings that one event forward and hands it to WordPress's own
  `spawn_cron()`, so the work runs in the web context a real schedule would use. **Never
  `wp cron event run <hook>`**: measured live, it runs _every_ event on the hook, and it runs
  the work inside the WP-CLI process, whose PHP is configured nothing like the web server's.
- [`wp/php.ts`](src/common/wp/php.ts) is the PHP bridge, and **every `wp eval` goes through it**:
  `phpLiteral` embeds a value as base64-encoded JSON, an alphabet with no PHP metacharacter in it, so
  a value can never end the literal it sits in; `evalPhp` runs a snippet and turns a non-zero exit
  into a throw carrying the site's own words. **Any value that came from outside this codebase — a
  site, a scenario, a fixture — goes through `phpLiteral`.** That is the injection boundary and it
  has no exceptions. (A compile-time constant of our own interpolated into snippet _source_, such as
  a budget or a destination slug, is not such a value; the two `${…}` sites that do it say so.)
- [`wp/files.ts`](src/common/wp/files.ts) reads properties of files on the site. `fileChecksum` is the
  honest proof that a file which travelled arrived intact; size is the tempting substitute and is
  strictly weaker. `listFiles` lists a directory's files — size, age, whether the transport's user
  may write each, digests on request — and **refuses a directory that is not there**, which would
  otherwise list as empty and pass "it was deleted" (`missingAsEmpty` only for one a scenario may
  never have made); `listLocatedFiles` does the same for a directory only the site can name. `backdateFile` sets a file's age back by the
  site's own clock. All computed on the site, so nothing large moves to answer the question.
  `locateFromWorkingDir` / `pathFromWorkingDir` give the path a command run in WP-CLI's working
  directory reaches a site path by, from the site's own `realpath()` and `getcwd()` — never from the
  configured paths, which a symlinked root would send somewhere else.
- [`wp/archive.ts`](src/common/wp/archive.ts) looks **inside** a tar on the site without moving it —
  `findArchiveEntries` (by name or glob) and `readArchiveEntry`. Naming the member keeps the _output_
  small, not the work: without `--occurrence` tar scans to the end regardless, and on a compressed
  archive it decompresses the whole thing (measured: ~1.4 s per 200 MB either way). Neither call
  declares compression, because GNU tar detects it when reading. "Absent" and "unreadable" share exit
  status 2 and **cannot be told apart from tar's wording** — a truncated archive prints only
  `Not found in archive` — so readability is settled by _behaviour_: list the archive with no pattern
  and believe the exit status. Reading a corrupt archive as "that file is not in it" would make every
  absence assertion pass. `.zip` is a valid BackWPup archive format and is **out of scope** here; tar
  refuses it, which is honest rather than wrong.
- [`wp/ownership.ts`](src/common/wp/ownership.ts) gives files back the ownership the **site** uses,
  after WP-CLI writes them as the transport's user. On a real cell `wp` runs for example as `ubuntu` and PHP for example as
  `www-data`, so an installed plugin is unwritable by the web server until this runs. The owner is
  **detected** from `wp-content` — not assumed to be the web-server user, which is wrong on a docroot
  deployed over SFTP — then applied as `chmod` **then** `chown` (that order: chowning first would lock
  the transport user out of its own uninstall). Verified by re-reading, never inferred from an exit
  code, and it **never throws**: a host that cannot do it is warned about, not failed. Overridable per
  site with `transport.fileOwner` (`"user:group"` — either half may be a bare numeric id — or `false`
  to opt out).
  **MUST — any code that writes into a site's docroot as the transport's user calls
  `normalizeOwnership` on what it wrote; never `chown`/`chmod` directly, and never elevate `wp`.**
  `stageAndInstallPlugin` does it for you when given the plugin's `slug` — pass it.
- [`wp/paths.ts`](src/common/wp/paths.ts) holds the guards that stand between a typo and a
  privileged command on a real system path — `normaliseSitePath`, `assertSafeElevatedTarget`,
  `pluginSitePath`, and `isPathSegment`, the one-segment rule every joined name passes — in one
  place, because a copied guard is a guard that drifts. Every operation
  that builds an elevated target out of a site's `rootDir` (residue removal, data-directory
  preparation, ownership normalisation) validates through them. Those guards are **lexical**, so
  where a path really leads is checked separately: `assertResolvedInsideRoot` resolves the target and
  the root (`readlink -f`, walking up to the deepest existing ancestor) and refuses anything that
  lands outside — a symlink in _any_ parent, not just the last component, otherwise redirects a root
  `chmod`/`mkdir`/`rm -rf` out of the docroot while every string comparison agrees. A path that
  cannot be resolved is refused too.
- [`wp/db-residue.ts`](src/common/wp/db-residue.ts) is the mirror image: the rows a plugin leaves
  when its **files** go without its `uninstall.php` ever running — which is the only time that
  cleanup cannot run. Declared per product as `ProductConfig.siteDbResidue` (`optionsContaining`
  fragments, matched **anywhere** in a name so a plugin's transients are caught, plus unprefixed
  `tables`) and swept off the footprint, never off `is-installed`. Measured on a cell: the forbidden
  `uninstall --deactivate` leaves 26 options and `wp_bwpup_backups`, and the next run then blames the
  product for not owing its onboarding. Ordered right after `ensurePluginAbsent` because an installed
  plugin re-creates its own footprint on `init` (measured). Rows go through `delete_option` so caches
  invalidate themselves, removal is verified by re-reading, WordPress is loaded `--skip-plugins`, and
  nothing is ever elevated. Two guards refuse a wrong declaration rather than a hostile one:
  `PROTECTED_TABLES` at declaration time, `PROTECTED_OPTIONS` against what the query actually matched
  — and that one refuses the **whole** sweep before deleting anything. Multisite is refused outright.
- [`wp/residue.ts`](src/common/wp/residue.ts) removes the files a plugin leaves behind after it
  is uninstalled, from the paths its product declares as `ProductConfig.siteResidue`. Validated
  before removal and **verified afterwards**, never inferred from `rm`'s exit code. Removal runs
  unprivileged first and **escalates only what survived** (`execElevated`), because a plugin writes
  as the web-server user and leaves directories nobody else can empty; `prepareSiteDataDirs` opens
  those same directories to both users up front — `0777` as a floor, then `normalizeOwnership` for
  the owner and for the subtree a non-recursive mode cannot reach. Refusable per site with `transport.elevate: false`.
  **`wp` is never elevated** — WP-CLI as root would leave the site's files unwritable by the web
  server.

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
- **Code is self-contained — never reference plans/design docs.** No `docs/plans/*`
  mentions in code — not file paths, not `§` section numbers, not plan phase names —
  anywhere: comments, TSDoc, or error/log messages. Plans move, rename, and get deleted,
  and an operator hitting an error must never be pointed at an internal design doc; explain
  the reasoning inline instead. Markdown docs and `.env.example` may cite plans. **UNLESS**
  the user explicitly authorizes an exception, which must then be listed right here —
  _current exceptions: none._
- **Name every scenario so it stands alone.** A `Scenario:` name is what you `--grep` to run
  one scenario, what a report row shows and what a CI failure is headlined with — it is read
  in isolation, never in file order. State the behaviour _and_ its outcome, with no
  back-reference to a neighbouring scenario (`…just the same`, `…too`, a dangling
  `them`/`it`). Setup and the reason scenarios resemble each other belong in the `Feature`
  description or `Background`, not implied by a title. Full rule and examples:
  [authoring-tests.md → Naming scenarios](docs/guides/authoring-tests.md#naming-scenarios).
- **Never write to a site's docroot without restoring its ownership.** WP-CLI runs as the
  transport's user and PHP as the web server, so anything the suite installs is unwritable by the
  web server until it is handed back. Call `normalizeOwnership` (or pass `slug` to
  `stageAndInstallPlugin`, which calls it) — never `chown`/`chmod` by hand, and never run `wp`
  elevated. See [wordpress-automation.md](docs/architecture/wordpress-automation.md#file-ownership-wpownershipts).
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
`npm run test:<product> -- --project=<cell>`. Keep the runner awake through it (`caffeinate -i`
on macOS): a runner that sleeps drops its SSH connections, and the run fails as if the network
had — hooks far past their timeouts, `ECONNRESET` after each wake.

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
| You're touching how the plugin zips under test are resolved, built, or verified. | [`docs/architecture/plugin-artifacts.md`](docs/architecture/plugin-artifacts.md)         |
| You're adding features, steps, fixtures, or page objects.                        | [`docs/guides/authoring-tests.md`](docs/guides/authoring-tests.md)                       |
| You're editing sites files, transports, editions, or env vars.                   | [`docs/guides/configuration.md`](docs/guides/configuration.md)                           |
| You want the full design rationale and decisions.                                | [`docs/plans/e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md)           |

## In-progress plans

Larger initiatives are tracked as living design docs in `docs/plans/`. Check
these before starting related work — they hold the current plan, not history:

- [`docs/plans/e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md) — full design rationale and decisions.
- [`docs/plans/plugin-artifact-management-plan.md`](docs/plans/plugin-artifact-management-plan.md) — plugin artifact management.
- [`docs/plans/phase-6-feature-porting-plan.md`](docs/plans/phase-6-feature-porting-plan.md) — feature porting (BackWPup first); supersedes the parent plan's Phase 6.
- [`docs/plans/site-file-ownership-plan.md`](docs/plans/site-file-ownership-plan.md) — keeping a site's docroot writable by both WP-CLI's user and the web server.
- [`docs/plans/orchestrator-plan.md`](docs/plans/orchestrator-plan.md) — the orchestrator: a long-running service that runs and manages cells on a server (supersedes the parent plan's Phase 9).

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
- **Add or change a fixture**, a shared scenario hook, or the configuration mechanism
  (`.env` vars, `sites.json` schema, transports, editions, `ProductConfig` fields).
- **Add a testing capability** — e.g. when the committed-baseline visual model becomes
  active, a new device profile or tag lands, or a new `wp/` module appears.
- **Change a convention** stated here (error handling, typing, TSDoc, workflow).

When a change is too detailed for CLAUDE.md, put it in the relevant `docs/` file
instead and link it from the [Documentation map](#documentation-map).

### docs/architecture/execution-model.md

Update it when you change anything about:

- How products, cells, pools, or run units are defined or selected.
- The `parallelIndex` invariant or the worker-to-site binding.
- The config factory (`createProductConfig`) or the project pairs it generates.
- The metadata/credential registry (`registerPool`, `routingMetadata`), or the per-process
  registries that carry a product's policy to the shared hooks (`registerDebugLogOptions`,
  `registerSiteResidue`, `registerSiteDbResidue`, `registerStopRunningWork`).
- Artifact directories, `RUN_ID` handling, or the `*_ROOT` env vars.

### docs/architecture/wordpress-automation.md

Update it when you change anything about:

- Transport modes (`local`, `docker`, `ssh`) or the `exec`/`wpCli` API.
- The file-transfer primitives (`wpRootDir`, `copyIntoTarget`) or the site staging
  area (`staging.ts`, `E2E_SITE_STAGING_DIR`, `transport.stagingDir`).
- The plugin lifecycle functions or their error types.
- The debug-log API (`readDebugLog`, `clearDebugLog`, `scanDebugLog`, `ScanDebugLogOptions`).
- File ownership (`ownership.ts`: `planOwnership`, `normalizeOwnership`, the grant rule,
  `transport.fileOwner`) or the shared path guards (`paths.ts`).
- The leftover-footprint sweep (`db-residue.ts`: `SiteDbResidue`, `findSiteDbResidue`,
  `removeSiteDbResidue`, `PROTECTED_OPTIONS`, `PROTECTED_TABLES`).
- The WP-Cron helpers (`cron.ts`: `nextScheduled`, `triggerScheduledEvent`).
- The PHP bridge (`php.ts`: `phpLiteral`, `evalPhp`, `EvalPhpOptions`), the file readers (`files.ts`:
  `fileChecksum`, `listFiles`, `listLocatedFiles`, `FILE_LIST_PHP`, `backdateFile`, `pathFromWorkingDir`,
  `locateFromWorkingDir`), or archive inspection (`archive.ts`:
  `findArchiveEntries`, `readArchiveEntry`).
- Any other `wp/` module (`cache.ts`, `db.ts`, `errors.ts`, `teardown.ts`).

### docs/architecture/plugin-artifacts.md

Update it when you change anything about:

- The `ProductArtifacts` manifest (default refs per role, version policy, edition →
  variant mapping, identity expectations) or a product's copy of it.
- The request/plan model, override precedence, or what throws vs. warns.
- Resolution (the artifacts dir lifecycle, `resolution.json`) or the identity preflight.
- The `pluginArtifact` consumption path, or pre-warming (`warmArtifacts`, `artifacts:warm`).
- The APVM pin, or which products/editions exist.

### docs/guides/authoring-tests.md

Update it when you change anything about:

- The BDD pipeline (bddgen, generated specs, how step files are wired).
- Gherkin authoring conventions (scenario naming, what belongs in `Feature`/`Background`).
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
