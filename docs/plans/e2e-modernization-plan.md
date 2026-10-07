# E2E Modernization Plan — `wp-rocket-e2e` → `wp-media-projects-e2e`

> **Status:** Phases 0–2 implemented (config foundation, execution model, artifact isolation). Phase 3 partially implemented (multi-file sites loading, pre-flight transport validation). Phases 3–9 planned; Phase 8 (CI on real cells) is dropped, and the orchestrator (Phase 9) has [its own plan](orchestrator-plan.md).
> **Date:** 2026-06-24
> **Baseline (reference):** `wp-rocket-e2e` — the legacy suite being superseded.
> **Target (this repo):** `wp-media-projects-e2e`.
> **Goal:** match or beat the baseline in every dimension (capabilities, reporting, maintainability,
> security), and add first-class **multi-product, multi-environment parallel execution**.
> **Porting principle:** "porting" means **modernise and improve**, never copy 1:1. The baseline was
> written years ago by a less-experienced team; every capability is re-implemented with current
> Playwright idioms (web-first assertions, auto-waiting locators, fixtures, `storageState`,
> `toHaveScreenshot`), strict types, and explicit error handling. **Coverage never regresses; the
> implementation always improves.**

---

## 1. Executive summary

`wp-media-projects-e2e` runs Gherkin through the **Playwright runner** via `playwright-bdd` (not the
standalone Cucumber CLI), on **ESM**, **Node 24**, **TypeScript 6** (`strict`), the **ESLint 10** flat
config, and **Prettier 3**. The **execution architecture** (§3) — the (product × cell) matrix with a
site pool per cell, worker→site binding, per-cell reports, and artifact isolation — is **in place**.
What remains is (a) the **WordPress automation plumbing** (WP-CLI/SSH/Docker command layer, plugin
lifecycle, visual regression, settings diffing), (b) **Allure analytics** on top of the live reporters,
and (c) **feature porting** per product.

The execution architecture (§3) is the centerpiece:

- A **product** (`wp-rocket`, `backwpup`, future plugins) is a fully self-contained unit — its own
  BDD config, features/steps, page objects, **its own sites file**, and **its own report folders**.
  Products share only `src/common/`.
- A **cell** is a named environment a product runs against (`apache`, `nginx`, and later arbitrary
  ones like `nginx@php8.2`). Cells are **provided by data**, not hard-coded — extensible without
  touching code.
- A **run unit** = one **(product × cell)** = one Playwright invocation = **one report** = a **pool of
  sites** across which that product's scenarios are distributed by Playwright workers.
- An **orchestrator** — a separate, long-running service on a server — runs cells in the background,
  each as its own isolated invocation with its **own** report (no merging). Designed in
  [its own plan](orchestrator-plan.md).

Everything ships in **v1**; a pool may start at size 1 (serial within a cell), and growing it is a
**data-only** change. The suite is built so the orchestrator can be added **later without changing
its run model** — cells are runnable manually today (gaps found since in running cells side by side
are that plan's Phase 0).

Two findings simplify the migration:

1. **The baseline carries dead dependencies.** `axios`, `boxen`, `node-zip`, `ssh2` (direct), and —
   notably — **`multiple-cucumber-html-reporter`** are declared but **never imported**. The baseline's
   "beautiful report" is in reality the **stock Cucumber HTML formatter**, media-rich on failure
   (it base64-embeds a screenshot and the video) but **static** — no interactive trace viewer, no
   trends.
2. **Most remaining libraries have modern, often built-in replacements** (visual regression →
   Playwright `toHaveScreenshot`; `shelljs` → `execa`; `chalk` → `node:util` `styleText`; `ts-node`
   → native Node TS; `dotenv` → `process.loadEnvFile()`).

---

## 2. Core decisions

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | **Execution = a (product × cell) matrix with a site pool per cell.** One Playwright invocation per run unit; an orchestrator spawns them. | §3 is the architecture; parallelism is **in v1**, not deferred. |
| D2 | **Products are fully separated**: own BDD config, own directories, own sites file, own reports. Only `src/common/` is shared. | §4 layout; no shared `sites.json`; no cross-product config bleed (e.g. BackWPup storage config is invisible to WP Rocket). |
| D3 | **Cells are data-provided and extensible**, not a fixed enum. `docker` ships an initial Apache + Nginx (fixed PHP); `ssh`/`local` accept unlimited cells. | §3.1, §4.2; code iterates the cell keys in each product's sites file. |
| D4 | **Each run unit produces its own report — no merging.** | §6.3; `blob` + `merge-reports` is intentionally **not** used. |
| D5 | **Server modes: `ssh` (default), `docker`, `local`.** `docker` provides **both Apache and Nginx**; `local` targets whatever web server the user runs. | §7.1; a custom `docker compose` (not `@wordpress/env`, which is Apache-only). |
| D6 | **Full reporting stack now**: Playwright HTML + embedded Cucumber HTML (dual-mode via `REPORT_MODE`) + **Allure 3**. | §6. |
| D7 | **Plugin lifecycle covers WP-CLI *and* the WordPress admin UI.** Cleanup hooks remove plugins **idempotently** (already-absent ⇒ no-op); deletion *as the action under test* asserts presence first. | §7.3. |
| D8 | **The suite is orchestrator-ready from day one.** Cells run manually per (product × cell); the orchestrator is added later without changing the run model. | §3.5; Phase 2 establishes isolation. The orchestrator has [its own plan](orchestrator-plan.md), whose Phase 0 closes the isolation gaps found since. |
| D9 | **BackWPup Free & Pro are one product; edition is a per-cell property.** Each cell declares its `edition` (Free/Pro are separate plugin packages); it selects the package to install, the scenario filter (`@free`/`@pro`/untagged), and the POM branch. | §4.5; not separate products (they share ~90%). |
| D10 | **Site credentials never enter Playwright `metadata`** (which is serialized into reports). Pools reach workers through an in-process registry; `metadata` carries only non-secret routing (`product`, `cell`). | §3.3, §4.4. |

---

## 3. Execution model & architecture

This is the centerpiece. It is grounded in a verified Playwright behaviour (§3.2) that dictates the
shape of everything else.

### 3.1 Concepts

- **Product** — `wp-rocket`, `backwpup`, … Each is a `playwright-bdd` configuration with its own
  features, steps, page objects, sites file, and report output. Products differ in *what* they test
  and in product-specific config (e.g. BackWPup needs third-party storage credentials; WP Rocket does
  not).
- **Cell** — a named environment a product is exercised against: `apache`, `nginx`, and arbitrary
  descriptors such as `nginx@php8.2`, `apache@php8.5`, or an edition facet like `pro@nginx` /
  `free@apache` (§4.5). **Cells are data, not code.** For `docker`, the project ships compose for an
  initial set (Apache + Nginx, fixed PHP) and can grow it later; for `ssh`/`local`, the user lists **as
  many cells as they have**. The config reads the cell names from each product's sites file
  (`Object.keys`) and generates one Playwright project per cell.
- **Site pool** — within a cell, a list of N interchangeable WordPress instances (each its own DB +
  uploads). The pool is what makes a cell *fast*: Playwright distributes the product's scenarios across
  the pool.
- **Run unit** — **(product × cell)**. Exactly one Playwright invocation, one report, one pool. The
  product is fixed by the chosen config file, so the Playwright **project name is the cell** (e.g.
  `nginx`), selected with `--project=<cell>`.
- **Orchestrator** — a separate, long-running service (not Playwright) that runs each run unit as an
  isolated Playwright invocation ([its own plan](orchestrator-plan.md)).

The two axes behave differently on purpose:

```text
                 cell: apache              cell: nginx              (cells are extensible →)
              ┌────────────────────┐   ┌────────────────────┐
 wp-rocket    │ pool of N sites    │   │ pool of N sites    │   ← server-types MULTIPLY (matrix)
              │ scenarios spread   │   │ scenarios spread   │   ← sites within a cell DISTRIBUTE (pool)
              └────────────────────┘   └────────────────────┘
              ┌────────────────────┐   ┌────────────────────┐
 backwpup     │ its own pool       │   │ its own pool       │   ← own sites + own config + own report
              └────────────────────┘   └────────────────────┘
```

50 scenarios with two cells ⇒ 50 run on Apache **and** 50 on Nginx (matrix across cells), each 50
distributed across that cell's pool (parallel within a cell). Each of the four boxes is one run unit
with its own report.

### 3.2 Why one invocation per run unit (the load-bearing finding)

Playwright has two distinct parallelism mechanisms, verified against the official docs:

- **Projects multiply.** Multiple projects matching the same tests run every test **once per project**
  (the cross-browser matrix model). This is what gives us "Apache **and** Nginx."
- **Workers distribute.** The `workers` pool runs each test **once**, handing the next pending file to
  whichever worker is free (a dynamic pool). This is what spreads a cell's scenarios across its sites.

To pin a worker to a site we use **`testInfo.parallelIndex`** (the stable, restart-safe slot id in
`0…workers-1`). The critical constraint: **`parallelIndex` is *global* across an invocation — it is
bounded by the global `workers`, not reset per project.** (Confirmed by the docs' single global
`workers` cap and the shared-pool model; corroborated by Playwright maintainers — issue #38953 shows
indices exceeding per-project worker counts.) Therefore:

> Indexing a cell's K-site pool by `pool[parallelIndex]` is **only safe when a single project runs in
> that invocation with `workers = K`**. In a single invocation running many projects, a cell's tests
> could land on a `parallelIndex ≥ K` and overflow its pool.

This is exactly why a run unit is **one invocation per (product × cell)** with `--workers = pool.length`
— not one giant invocation running every cell. Per-project `workers` (Playwright ≥ 1.52) exists but
caps *how many* workers a project uses, not *which* `parallelIndex` values it sees, so it does **not**
make a single multi-cell invocation safe. The orchestrator (§3.4) gives us the matrix across cells
*instead*.

### 3.3 Worker → site binding & credential handling

Because each invocation is one project with `workers = pool.length`, `parallelIndex ∈ 0…N-1` exactly
indexes the pool. A worker-scoped fixture binds the worker to its site for the worker's lifetime, and
`baseURL`/`storageState` derive from it.

**Credentials never travel through `metadata`.** Playwright serializes a project's `metadata` verbatim
into its reports, so the credential-bearing pool must not live there (D10). Instead, the config factory
populates an **in-process pool registry** as a side effect of building the config — Playwright re-runs
the config in every worker process, so each worker resolves its own pool locally. `metadata` carries
only non-secret routing, `{ product, cell }`; the worker reads its pool from the registry:

```ts
// src/common/fixtures.ts
import { test as base, createBdd } from "playwright-bdd";
import { getPool, readRouting } from "./config/metadata";
import type { SiteConfig } from "./config/types";

export const test = base.extend<{ site: SiteConfig }, { boundSite: SiteConfig | undefined }>({
  // worker-scoped: resolved once per worker; SAFE because workers === pool.length (§3.2)
  boundSite: [async ({}, use, workerInfo) => {
    const { product, cell } = readRouting(workerInfo.project.metadata); // non-secret routing only
    const pool = getPool(product, cell);                                // credentials from the in-process registry
    await use(pool.length === 0 ? undefined : pool[workerInfo.parallelIndex]);
  }, { scope: "worker" }],

  site:    async ({ boundSite }, use) => use(boundSite ?? throwNoPool()), // clear error if a scenario needs a site
  baseURL: async ({ boundSite, baseURL }, use) => use(boundSite?.baseURL ?? baseURL),
  // login/logout scenarios opt out of auth with @noauth
  storageState: async ({ boundSite, storageState, $tags }, use) =>
    use($tags.includes("@noauth") ? { cookies: [], origins: [] } : (boundSite?.storageState ?? storageState)),
});

export const { Given, When, Then, Step, Before, After, BeforeAll, AfterAll } = createBdd(test);
```

`config/metadata.ts` owns this contract end-to-end: `routingMetadata(product, cell)` (the builder the
factory writes into `metadata`), `readRouting()` (the validated reader), and `registerPool`/`getPool`
(the per-process registry). Steps and fixtures read `baseURL`/credentials from the bound site — **never
hard-coded** — so adding sites or cells never touches step code.

### 3.4 The orchestrator

Moved to [its own plan](orchestrator-plan.md): a long-running service that runs cells in the
background and manages those runs.

### 3.5 Artifact isolation & lifecycle

Artifacts split into **two lifecycles by whether keeping a history has value** — and that, not a single
rule, is what governs each path. All paths are keyed by **`<product>/<cell>`**, so different cells never
share a path: the real concurrency (the orchestrator running *different* cells at once) is isolated by
construction (two exceptions found since, `bddgen` and the root `test-results/`, are the
[orchestrator plan](orchestrator-plan.md)'s Phase 0). The same `(product × cell)` must not run
concurrently regardless — a cell's site pool is shared WordPress state, so two simultaneous runs of one
cell would corrupt each other at the *database* level; it is intentionally a singleton.

| Artifact | Path | Lifecycle |
| --- | --- | --- |
| Report (Playwright HTML + Cucumber) | `reports/<product>/<cell>/<run>/` | **Accumulates** — one timestamped subdir per run, building a per-cell history. A later `report:prune` keeps the newest *N* per cell. |
| Allure results + history | Allure's own results/history dir | **Accumulates by design** — Allure consumes run history to compute trends (§6.1). |
| Generated BDD specs | `.features-gen/<product>/<cell>/` | **Ephemeral** — regenerated by `bddgen` every run; **overwritten in place**, so the unique-per-run generations never pile up. |
| `storageState` auth files | `.auth/<product>/<cell>/site-<i>.json` | **Ephemeral** — rewritten by the setup project each run. |
| Traces / video / screenshots | `test-results/<product>/<cell>/` | **Ephemeral** — Playwright clears `outputDir` at each run start; the report copies in the attachments it needs (below). |

The rule of thumb: **history has value → accumulate (prune later); build output / transient state →
overwrite in place.** A small `run-context` module encodes both — running a cell needs **no environment
variables**:

```ts
// src/common/config/run-context.ts
// RUN_ID: a non-blank inherited value, else a fresh sortable timestamp pinned into env so every worker
// shares one token. Used ONLY to namespace the report dir (a blank RUN_ID="" is treated as unset).
export const RUN_ID = resolveRunId();
// All requested cells, parsed from every --project form (incl. the variadic one) — the single
// signal Playwright itself uses to filter, so config sizing can't diverge from what runs. The
// factory selects exactly one and rejects more than one fail-fast (§3.2).
export const selectedCells = (): string[] => /* parsed --project values */ [];
export const dirs = (product: string, cell: string) => {
  const cellNs = `${product}/${cell}`;               // the namespace is ALWAYS appended, so cells never collide
  return {
    report: `${env("REPORT_ROOT", "reports")}/${cellNs}/${RUN_ID}`, // ACCUMULATES — one per run (prune to N later)
    output: `${env("OUTPUT_ROOT", "test-results")}/${cellNs}`,      // EPHEMERAL — overwritten each run
    auth:   `${env("AUTH_ROOT", ".auth")}/${cellNs}`,               // EPHEMERAL
    bdd:    `.features-gen/${cellNs}`,                              // EPHEMERAL
  };
};
```

So `playwright test --config <product> --project <cell>` Just Works with **zero env**: the ephemeral
paths are deterministic from the product and cell (no run token → every worker computes the same path and
overwrites in place), while the report lands in its own timestamped subdir so history accumulates.
`RUN_ID` only ever labels the **report** subdir — it defaults to a sortable timestamp, and CI or the
orchestrator may pass a meaningful one (e.g. a build number / launch label) to group a launch's reports.
`npm run report` opens the newest. The optional `REPORT_ROOT`/`OUTPUT_ROOT`/`AUTH_ROOT` overrides
replace only the root prefix; the `<product>/<cell>` namespace is always appended, so an override can
never collapse two cells onto one path.

Reports are **self-contained** (each copies in its own screenshots/video/trace), so overwriting the
ephemeral `test-results` never harms an older accumulated report. Report accumulation is **intended in
v1**; it is bounded later by a standalone `report:prune` (keep newest *N* per cell —
[orchestrator plan](orchestrator-plan.md)). Cross-run **trends** come from Allure (§6.1).

This isolation lives **inside** the E2E project, so the orchestrator later only automates running cells —
it adds **no** new requirement to the run model. That is the "orchestrator-ready from day one" guarantee (D8).

### 3.6 v1 scope & extensibility

- **All of it ships in v1**: the product separation, cells-as-data, per-cell pools, worker→site
  binding, per-cell reports, and conflict isolation. A pool may be **size 1** (so `workers = 1`, serial
  within that cell) — the machinery is identical; only the data is smaller.
- **Scaling is data-only**: add sites to a pool, add a cell key, or add a product folder. No code
  change, no refactor.
- **The orchestrator is the only deferred piece** ([its own plan](orchestrator-plan.md)); it slots in
  without changing the run model.

---

## 4. Project structure & configuration

### 4.1 Directory layout (full product separation)

```text
.                                  # repo root
  playwright.config.ts             # dispatch entry (PRODUCT=… selects); IDE / default discovery
  playwright.wp-rocket.config.ts   # WP Rocket entry → createProductConfig(wpRocket)
  playwright.backwpup.config.ts    # BackWPup entry  → createProductConfig(backwpup)
  .env.example  .npmrc  README.md  # onboarding; .npmrc enables the browser postinstall (§8.6)
  eslint.config.js  prettier.config.js  tsconfig.json
src/
  common/                          # ONLY non-product-specific, shared code
    fixtures.ts                    # worker→site binding (§3.3); @noauth; edition (§4.5)
    guards.ts                      # generic type guards (isObject, isNonEmptyString) — reusable anywhere
    auth/auth.setup.ts             # generic per-site login, reused by every product
    steps/                         # generic, product-agnostic steps
    wp/                            # exec layer, plugin guards, db helpers (Phase 3)
    config/
      env.ts                       # env() / requireEnv() / intEnv() / boolEnv()
      load-env.ts                  # one-time .env loader (process.loadEnvFile)
      run-context.ts               # RUN_ID + selectedCells + namespaced dirs (§3.5)
      metadata.ts                  # routing metadata + in-process pool registry (§3.3)
      reporting.ts                 # reporter factory + REPORT_MODE (§6.2)
      project.ts                   # createProductConfig: per-cell projects + binding (§4.4)
      sites.ts                     # sites.json loader + validation + isPlaceholderSite
      types.ts                     # SiteConfig, ProductConfig, ServiceConfig, Transport, Edition
  projects/
    wp-rocket/
      features/  steps/  pages/
      config/
        wp-rocket.config.ts        # ProductConfig (globs; no storage)
        sites.json                 # GITIGNORED — WP Rocket's OWN cells + pools
        sites.example.json         # committed template
    backwpup/
      features/  steps/  pages/
      config/
        backwpup.config.ts         # ProductConfig + storage services (S3/FTP/…)
        sites.json                 # GITIGNORED — BackWPup's OWN cells + pools (separate file)
        sites.example.json
orchestrator/                      # SEPARATE from the test projects (see orchestrator-plan.md)
```

The per-product Playwright **config entries live at the repo root** so every glob resolves
repo-root-relative; each is a thin file that calls `createProductConfig(<product>)` (§4.4). Adding a
product = add a `src/projects/<product>/` folder + its `ProductConfig` + a root entry; nothing shared
changes. Adding a cell = add a key to that product's `sites.json`; no code changes.

### 4.2 Per-product sites file (cells as dynamic keys)

A constraint forces structured files over a single flat `.env`: in any one process, `process.env` is
global — you cannot "load a different `.env` per product". So per-product/per-cell data lives in
**structured, per-product files**, loaded once. Cells are the top-level keys, so the set of cells is
purely data:

```jsonc
// src/projects/wp-rocket/config/sites.json   (gitignored; sites.example.json is committed)
{
  "apache": [
    { "baseURL": "https://wpr-ap-1…", "username": "admin", "password": "…",
      "transport": { "mode": "ssh", "host": "1.2.3.4", "key": "~/.ssh/id", "rootDir": "/var/www/s1" } },
    { "baseURL": "https://wpr-ap-2…", "username": "admin", "password": "…", "transport": { /* … */ } }
  ],
  "nginx":        [ /* … */ ],
  "nginx@php8.2": [ /* … */ ]    // ← arbitrary cell, picked up automatically (ssh/local)
}
```

A cell maps to its site pool, shown here as the bare array (editionless). An **edition-ful** product
wraps a cell's pool with its `edition` (`{ "edition": …, "sites": [ … ] }`) — see §4.5.

### 4.3 Product config & secrets

Each product config declares its globs and product-specific service config; **BackWPup's storage
config lives only in `backwpup.config.ts`** and is structurally invisible to WP Rocket.

```ts
// src/projects/backwpup/config/backwpup.config.ts
const configDir = dirname(fileURLToPath(import.meta.url));
export const backwpup: ProductConfig = {
  name: "backwpup",
  features: "src/projects/backwpup/features/**/*.feature",   // repo-root-relative (entry lives at root, §4.1)
  steps: ["src/common/fixtures.ts", "src/common/steps/**/*.ts", "src/projects/backwpup/steps/**/*.ts"],
  sites: loadSites(configDir),                               // its own sites.json → { cell: SiteConfig[] }
  services: {                                                // storage creds from env; global, per-site override
    storage: {
      ftp: { host: env("BWP_FTP_HOST"), username: env("BWP_FTP_USERNAME"), password: env("BWP_FTP_PASSWORD"),
             port: intEnv("BWP_FTP_PORT", 21), secure: boolEnv("BWP_FTP_SECURE", true) },   // validated coercions
      s3:  { accessKeyId: env("BWP_S3_ACCESS_KEY_ID"), secretAccessKey: env("BWP_S3_SECRET_ACCESS_KEY"),
             bucket: env("BWP_S3_BUCKET"), region: env("BWP_S3_REGION", "us-east-1") },
    },
  },
};
// wp-rocket.config.ts has NO `services` key at all.
```

**Secrets and overrides.** Global service credentials (one set per product — they target a single
external service, not a WordPress site) come from the **environment** (`requireEnv`), so the committed
config carries only their shape. A specific site may need to **override** one — most commonly to dodge
**per-host rate limits** (e.g. FTP connection/session caps) when its cell runs many sites in parallel, or
to point at a different bucket/server. That override lives **on the site itself**, in an `overrides`
block in the product's `sites.json`:

```jsonc
// one site entry in src/projects/backwpup/config/sites.json
{ "baseURL": "https://bwp-ng-3…", "username": "admin", "password": "…",
  "transport": { "mode": "ssh", "host": "…", "key": "…", "rootDir": "…" },
  "overrides": { "storage": { "ftp": { "host": "51.68.87.200", "username": "rocketftp2", "password": "…" } } } }
```

The effective config for a site is a deep-merge — `merge(product.services, site.overrides)` — so a site
inherits every global value and replaces only what it declares. The `overrides` block is **validated at
load time** against the (partial) service shape, so a malformed override fails fast with a path-named
error (`[sites] … overrides.storage.ftp.port must be a finite number`) rather than surfacing later.

**Why on the site, not `SITE_<n>_<KEY>` env keys.** Two reasons make co-location the right model here:
(1) **it fits the data shape** — sites already live in per-product, cell-keyed `sites.json`, so the
override belongs in that same structured object, not a flat env namespace that would have to encode
product + cell + index (`WPROCKET_NGINX_SITE_2_FTP_HOST`) just to stay unambiguous; (2) **index-based env
keys are positionally fragile** — `SITE_2_*` binds to an array position, so reordering the pool silently
remaps overrides, whereas an `overrides` block is bound to the site object itself. Secret exposure does
**not** separate the two: `sites.json` is *already* gitignored and *already* holds each site's secrets
(admin password, SSH key path), so an override secret sits exactly where the site's other secrets live.
Global/default service secrets still come from env; only explicit per-site exceptions live in the entry.
Likely override candidates: **FTP** (high rate-limit risk); **Dropbox**/**Rackspace** (medium);
**S3**/**Azure** rarely need it (built for concurrency).

### 4.4 The config factory (generates the per-cell projects)

A single shared factory, `createProductConfig(product)` in `common/config/project.ts`, turns a
`ProductConfig` into a Playwright config: **one project pair per cell** (a setup project + the BDD
project that depends on it), each with a product-namespaced BDD output dir (the key isolation point).
The per-product root entry is a one-liner:

```ts
// playwright.wp-rocket.config.ts   (repo root — globs resolve repo-root-relative)
import "./src/common/config/load-env";
import { createProductConfig } from "./src/common/config/project";
import { wpRocket } from "./src/projects/wp-rocket/config/wp-rocket.config";
export default createProductConfig(wpRocket);
```

```ts
// src/common/config/project.ts  (the factory, abridged)
export function createProductConfig(product: ProductConfig): PlaywrightTestConfig {
  const cells = Object.keys(product.sites);
  // Selecting >1 cell is unsafe (parallelIndex is global, §3.2) → reject fail-fast.
  const requested = selectedCells().filter((c) => cells.includes(c));
  if (requested.length > 1) throw new Error(`Multiple cells selected (${requested.join(", ")}); run one per invocation.`);
  const selected   = requested[0];
  const reportCell = selected ?? "_all";                          // cell-less run → an _all bucket, never mislabeled

  const projects = cells.flatMap((cell) => {
    const d      = dirs(product.name, cell);
    const pooled = withState(product.sites[cell] ?? [], d.auth);   // each site gets its storageState path
    registerPool(product.name, cell, pooled);                     // credentials → in-process registry, NOT metadata (§3.3)
    const setup = `setup:${cell}`;
    return [
      { name: setup, testDir: "src/common/auth", testMatch: /auth\.setup\.ts$/,
        metadata: routingMetadata(product.name, cell) },          // { product, cell } only
      {
        name: cell,                                               // run-unit project = the cell
        testDir: defineBddConfig({
          outputDir: d.bdd, features: product.features, steps: product.steps,
          tags: editionFilter(product, cell),                     // §4.5: from the cell's edition; undefined when editionless (Phase 6 hook)
        }),
        outputDir: d.output,
        dependencies: [setup],
        workers: pooled.length || 1,                              // defensive cap (correctness is the global workers below)
        retries: isCI ? 2 : 0,
        metadata: routingMetadata(product.name, cell),
      },
    ];
  });

  return defineConfig({
    fullyParallel: true,
    workers: selectedPoolSize(product, selected) || 1,            // global workers = selected cell's pool size (§3.2)
    reporter: reporters(dirs(product.name, reportCell).report),   // this run unit's OWN report dir (§6.3)
    use: { trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
    projects,
  });
}
```

`reporting.ts` holds the reporter factory + `REPORT_MODE`; `project.ts` holds `devices`/capture defaults
and the factory; `run-context.ts` resolves the namespaced dirs and `selectedCells` (§3.5); `metadata.ts`
owns the routing + pool registry (§3.3). A bare `playwright.config.ts` at the root dispatches to a
product by `PRODUCT` for IDE / default discovery.

### 4.5 Editions (Free / Pro)

BackWPup ships in two editions — **Free** and **Pro** — as **separate plugin packages** (different zips)
that share the great majority of behaviour: Pro has everything Free has (minus a few Free-only items such
as beta subscriptions) plus extra features (more storages, quality-of-life flows) and a few enhanced
variants of shared flows. They are the **same plugin and domain**, so they live in the **one `backwpup`
product** (D9), not separate products — a separate product would duplicate the shared ~90% or fake-share
it across an artificial boundary.

**Edition is a property of the cell.** A cell is one test environment, and its edition decides three
cell-wide things — which **plugin package** to install (Free and Pro are different zips), which
**scenarios** run (the `@free`/`@pro` filter, applied per cell at generation), and which **POM** branch.
None of these is per-site, so edition is declared **once per cell**:

- A cell carries an optional `edition: "free" | "pro"` alongside its pool; editionless products
  (WP Rocket) simply omit it. Edition rides on the existing cells-as-data mechanism (a cell like
  `pro@nginx` / `free@apache`), so per-edition reports, pools, and orchestration come for free — no new
  matrix axis.
- Because edition is **non-secret, cell-level** data, it travels in the routing `metadata`
  (`{ product, cell, edition }`, §3.3); the `edition` fixture and the plugin-install hook read it from
  there. There is a single value per cell — no per-site field and no pool-uniformity checks.

```jsonc
// src/projects/backwpup/config/sites.json — an edition-ful cell wraps its pool with `edition`
{ "pro@nginx":  { "edition": "pro",  "sites": [ { /* site */ }, { /* site */ } ] },
  "free@nginx": { "edition": "free", "sites": [ { /* site */ } ] } }
// An editionless cell is just its pool (WP Rocket):  "nginx": [ { /* site */ } ]
```

**Plugin package selection — superseded by the artifacts capability.** This section originally
sketched a static per-edition zip map in the product config
(`plugin: { free: "…/backwpup-free.zip", pro: "…/backwpup-pro.zip" }`). That map is **gone**: a
committed path to a hand-built zip cannot say *which build* it holds, and nothing verified that a
`pro` cell was actually handed the Pro package. Both are now solved by the **plugin-artifact
management** capability (implemented; design in
[plugin-artifacts.md](../architecture/plugin-artifacts.md), rationale in the
[artifact plan](plugin-artifact-management-plan.md)):

- Each product declares an `artifacts` manifest instead of a zip map. For an edition-ful product it
  maps **edition → the one APVM variant** to build (`pro` → `pro-en`, `free` → `free`) plus the
  **identity** a zip of that edition must have (slug + `Plugin Name:` header).
- A per-cell `artifacts:<cell>` setup project resolves that edition's zip for the execution (build a
  git ref through APVM, or copy an operator-provided zip) and a static preflight **asserts** the
  identity — so a `pro` cell physically cannot install the Free package.
- The plugin `Before` hook (§7.3) consumes the result through the `pluginArtifact("plugin")` fixture
  rather than a config constant, so "which edition" and "which build" stay one decision made per run.
- Edition (`free`/`pro`, ours) and APVM variant (`free`/`pro-en`/`pro-de`) are deliberately distinct
  namespaces — the manifest is the projection between them.

**Applicability via tags**, with a low-tax default (most scenarios need no tag):

| Category | Tag | Runs on |
| --- | --- | --- |
| Shared, identical | *(none)* | both editions |
| Pro-only feature / flow | `@pro` | Pro cells |
| Free-only feature / flow | `@free` | Free cells |

A scenario tagged **both** `@free` and `@pro` is a contradiction (it would run nowhere) and is rejected.
Genuinely different user journeys become **separate scenarios sharing a Background** — e.g. restore,
where Free uploads a downloaded backup and Pro restores straight from the backup list:

```gherkin
@backwpup
Feature: Restore a backup
  Background:                                  # shared — both editions
    Given a backup exists in the backup list

  @pro
  Scenario: Restore directly from the backup list
    When I restore the latest backup from the list
    Then the site is restored

  @free
  Scenario: Restore by uploading the backup file
    Given I have downloaded that backup
    When I upload the backup file and restore it
    Then the site is restored
```

**Filtering is automatic per cell.** From the cell's `edition` the factory passes a tag expression to
that cell's `defineBddConfig` (`tags?: string`, which filters scenarios at generation): a Pro cell gets
`"not @free"` (runs untagged + `@pro`); a Free cell gets `"not @pro"`; an editionless cell gets no
filter. So a Free cell never even generates the Pro specs, and the filter composes with a user's
`--grep`.

**Runtime branching.** An `edition` fixture (read from the routing metadata) lets the few divergent *shared*
flows pick the right page object. Plain POMs only (§7.5): a small **strategy factory** returns the
edition's page object for a divergent page, each edition's flow in its own class:

```ts
export interface RestorePage { restoreLatest(): Promise<void>; }
class ProRestorePage  implements RestorePage { /* from the backup list */ }
class FreeRestorePage implements RestorePage { /* download + upload */ }
export const restorePage = (page: Page, edition: Edition): RestorePage =>
  edition === "pro" ? new ProRestorePage(page) : new FreeRestorePage(page);
```

Shared pages stay single classes. **Authoring rule:** different user-visible steps → separate
`@free`/`@pro` scenarios; same steps with only incidental UI differences → one untagged scenario plus an
edition-aware page object. Pro-only **storages** need no config split — they live in the one `services`
config and their scenarios are simply `@pro`, so Free cells never run them.

**Absent edition.** Because the package, the filter, and the POM all read the cell's edition, a missing
edition resolves cleanly by product:

- **Editionless product (WP Rocket)** — no cell declares an edition: no filter, the product's single
  package, `edition` fixture unused. Correct, zero config.
- **Edition-ful product (BackWPup)** — edition is required on every cell, enforced **all-or-none across a
  product's cells**: if any cell declares an edition, all must, so a BackWPup cell that omits it **fails
  fast at load** (`[sites] cell "nginx" must declare an edition: "free" | "pro"`) rather than installing
  an undefined package or running both editions' scenarios.

**What it takes** (a thin addition, landing with Phase 6): an `Edition` type and the optional per-cell
`edition` carried in routing metadata (`types.ts` / `metadata.ts`); the one all-or-none check in
`sites.ts`; the `editionFilter` derivation in the factory (§4.4); the `edition` fixture; and the
per-edition plugin install in the Before hook (§7.3), which reads the cell's resolved-and-verified zip
from the `pluginArtifact` fixture. *(All of the above except the Before hook is now implemented — the
edition model shipped with the artifacts capability rather than waiting for Phase 6.)*

---

## 5. Authentication

Authenticate **once per site**, persist cookies/localStorage to a per-site file, and reuse it — instead
of the baseline's per-scenario UI login (slow, repetitive, no `storageState`).

Each cell's BDD project depends on a **setup project** that authenticates that cell's pool. A single
setup test resolves the cell's pool from the registry (routing → `getPool`, §3.3), **skips placeholder
sites** (so a fresh checkout with only `sites.example.json` stays green), and logs each real site in
inside its own isolated context, saving a per-site state file under the namespaced auth dir:

```ts
// src/common/auth/auth.setup.ts   (a normal Playwright test, NOT a .feature)
import { test as setup, expect } from "@playwright/test";
import { getPool, readRouting } from "../config/metadata";
import { isPlaceholderSite } from "../config/sites";

setup("authenticate site pool", async ({ browser }, testInfo) => {
  const { product, cell } = readRouting(testInfo.project.metadata);
  const real = getPool(product, cell).filter((s) => !isPlaceholderSite(s));
  setup.skip(real.length === 0, "Only placeholder/example sites — create sites.json for real runs.");

  for (const site of real) {
    const context = await browser.newContext({ baseURL: site.baseURL });
    try {
      const page = await context.newPage();
      await page.goto("/wp-login.php");
      await page.getByLabel("Username or Email Address").fill(site.username);
      await page.getByLabel("Password", { exact: true }).fill(site.password);
      await page.getByRole("button", { name: "Log In" }).click();
      // The Log In click waits for navigation, so the URL is settled: dismiss the WP
      // "admin email verification" interstitial only when it is the landed page.
      if (page.url().includes("action=confirm_admin_email"))
        await page.getByRole("link", { name: /remind me later/i }).click();
      await expect(page).toHaveURL(/\/wp-admin\/?/);
      await context.storageState({ path: site.storageState }); // per-site file → no collisions
    } finally {
      await context.close();
    }
  }
});
```

The cell's tests then reuse `pool[parallelIndex].storageState` via the worker fixture (§3.3).
`@noauth` scenarios (login/logout) start unauthenticated. **Multi-user** (`admin` vs `admin2`, which the
baseline supports) is a second per-site state file plus a dynamic step
(`Given I am logged in as {string}` → `context.setStorageState(path)`).

---

## 6. Reporting

### 6.1 The layered stack (D6)

| Tier | Reporter | Purpose |
| --- | --- | --- |
| Native | Playwright **HTML** | Interactive runner report — steps, screenshots, video, **trace viewer** (the baseline's true missing capability). Open with `npx playwright show-report`. |
| Gherkin | `playwright-bdd` **`cucumberReporter('html')`** | Faithful BDD report (features/scenarios/steps) — the successor to the baseline report. **Dual-mode** (§6.2). |
| Analytics | **Allure 3** (`allure-playwright`) | History/trends, flaky categorisation, dashboards; **`singleFile: true`** for a portable artefact. |

These run together because `playwright-bdd` emits standard Playwright tests. The live config enables
`list`, Playwright **HTML**, and the Cucumber **HTML** reporter today; **Allure** is added on top in
Phase 4. **Capture settings** make every failure carry media + a trace: `trace`, `video`, `screenshot`
all `"retain-on-failure"`.

### 6.2 Dual-mode Cucumber report (one `REPORT_MODE` flag)

The Cucumber HTML report has one trade-off (a portable single file vs. an in-report interactive trace
viewer). Rather than choose, the target supports **both**, switched by `REPORT_MODE`:

```ts
// inside reporting.ts → reporters(reportDir)
const isRich = process.env.REPORT_MODE === "rich";
cucumberReporter("html", {
  outputFile: `${reportDir}/cucumber/index.html`,
  externalAttachments: isRich,                       // A: false (inline) · B: true (separate data/ + trace viewer)
  skipAttachments: isRich ? false : ["application/zip"], // A: drop only the heavy trace zip; keep video
});
```

| Mode | `externalAttachments` | What you get | Cost | Consumer |
| --- | --- | --- | --- | --- |
| **A — portable** *(default)* | `false` | One self-contained HTML; screenshots **and video embedded** on failure; opens from `file://`. | No in-report trace *viewer* (traces live in the Playwright HTML report). | autoe2e / CI — "download one file". |
| **B — rich** (`REPORT_MODE=rich`) | `true` | Small HTML **+ a `data/` folder**; **embeds the interactive Playwright trace viewer**. | Not a single file; trace clicks need serving over `http(s)://` (`npx http-server …`), not `file://`. | targeted debug runs. |

**Video** is embedded on failure in MODE A because Playwright records it (`video: "retain-on-failure"`)
and the reporter embeds whatever exists — there is **no per-status "embed only on failure" switch**, so
never add `video/webm` to `skipAttachments` in MODE A. The interactive trace viewer is **always**
available via the Playwright HTML report regardless of mode; Allure's `singleFile` gives an independent
portable analytics artefact.

### 6.3 One report per run unit — no merging (D4)

Each run unit writes its report into its **own** per-cell folder (`reports/<product>/<cell>/<run>/`, one
timestamped subdir per run — §3.5). So `wp-rocket@apache`, `wp-rocket@nginx`, `backwpup@apache`, and
`backwpup@nginx` each have a self-contained report containing **all of that cell's workers' results** —
exactly the desired separation. Because edition is a cell facet (§4.5), `backwpup`'s `free@apache` and
`pro@apache` likewise land in distinct report folders with no extra machinery. Playwright's `blob`
reporter + `merge-reports` (the cross-machine sharding consolidation path) is **deliberately not used**:
reports are kept separate by design, not merged.

### 6.4 Versus the baseline

- **Exceeds:** an interactive **trace viewer** (baseline had none), **history/trends + flaky detection**
  via Allure (baseline had none), and per-(product × cell) reporting (baseline was single-product).
- **Matches by choice:** embedded video + screenshots on failure in the Gherkin report (MODE A) — the
  one baseline property kept intact.

---

## 7. WordPress automation layer

### 7.1 Server modes & WP-CLI transport

All three modes are first-class; **`ssh` is the default** (matches the baseline's `external`). The mode
decides **how WP-CLI is dispatched**; it is orthogonal to the cell/site list (which decides *which*
WordPress instances run).

| Mode | WP-CLI transport | Provisioning | Web server(s) |
| --- | --- | --- | --- |
| `ssh` *(default)* | `node-ssh` `execCommand` on the remote host | existing remote sites | as configured on the host |
| `docker` | `docker exec <container> wp …` (via `execa`; the cell's `transport.container`) | **custom `docker compose`** in [`docker/`](../../docker) | **Apache *and* Nginx** (D5) |
| `local` | `execa(cliPath, […])` on the host | user's local install | **whatever the user runs** (agnostic) |

**`docker` = Apache and Nginx.** `@wordpress/env` is **Apache-only** (`FROM wordpress${phpVersion}`,
`APACHE_RUN_*`, no Nginx path — verified in installed source), so a single custom `docker compose`
provides both over one MariaDB:

- **Apache** from `wordpress:php8.x-apache` (e.g. host port 8080).
- **Nginx** = `wordpress:php8.x-fpm` (PHP-FPM, **no published host port** per Docker Hub's FastCGI
  security note) **+** `nginx:alpine` with a WordPress vhost (`try_files`/`fastcgi_pass`) on e.g. 8081.
  **The vhost file is a required deliverable** — php-fpm alone serves nothing.
- A `wordpress:cli-php8.x` service for WP-CLI; pin image tags confirmed on Docker Hub at implementation
  time.

These two web servers are the initial **cells** for `docker`; `local`/`ssh` cells come entirely from the
product's sites file. `@wordpress/env` remains an **optional** convenience for a quick local Apache env.

### 7.2 Exec layer

`src/common/wp/exec.ts` dispatches by mode — local & Docker via **`execa`** (array args; never string
concatenation → no shell injection), remote via **`node-ssh`** — and returns a structured result with an
**`exitCode` on every mode** (the baseline omitted it on the docker/local branch, which made guards
impossible). Surface `error.shortMessage` for diagnostics.

### 7.3 Plugin lifecycle — WP-CLI and UI; idempotent cleanup vs. asserted deletion (D7)

The baseline manages plugins both ways and the target keeps both, because some product flows exist only
in the UI (e.g. WP Rocket's "delete data" confirmation). Two **different intents** must not be conflated:

- **Cleanup (the `Before`/`After` hooks of every scenario)** — make the plugin absent. If it is already
  absent, that is **success, not a failure** (a `Before` runs before the first install; an `After` may
  run after a scenario that itself deleted the plugin). Only a *genuine failure to delete* must surface.
- **Deletion as the action under test** — a scenario that verifies the delete flow. Here the plugin is
  expected to be present (the `Before` installed it), so *absent-when-expected* is a real failure, and so
  is a *failed* deletion.

`wp plugin delete <slug>` exits **non-zero for both** "not found" *and* a real failure, so the exit code
alone is ambiguous; the reliable probe is **`wp plugin is-installed`** (exit `0` = installed, `1` = not).
Two distinct error types let steps and reports tell the failing cases apart:

```ts
// src/common/wp/errors.ts
export class PluginNotInstalledError   extends Error {}
export class PluginDeletionFailedError extends Error {}
```

```ts
// src/common/wp/plugin.ts
export const isPluginInstalled = (slug: string) =>
  wpCli(["plugin", "is-installed", slug]).then((r) => r.exitCode === 0);

/** CLEANUP (idempotent) — for Before/After hooks. Absent ⇒ no-op success; a real delete failure throws. */
export async function ensurePluginAbsent(slug: string): Promise<void> {
  if (!(await isPluginInstalled(slug))) return;           // already gone ⇒ nothing to do (NOT an error)
  await wpCli(["plugin", "delete", slug]);                // delete's exit code is ambiguous — don't trust it
  if (await isPluginInstalled(slug)) {                    // re-assert removal
    throw new PluginDeletionFailedError(`Plugin "${slug}" still installed after delete; FAILED.`);
  }
}

/** ACTION UNDER TEST — only for scenarios that verify deletion. Absent-when-expected ⇒ failure. */
export async function deletePlugin(slug: string): Promise<void> {
  if (!(await isPluginInstalled(slug))) {
    throw new PluginNotInstalledError(`Plugin "${slug}" expected installed before deletion, but is absent.`);
  }
  await wpCli(["plugin", "delete", slug]);
  if (await isPluginInstalled(slug)) {
    throw new PluginDeletionFailedError(`Plugin "${slug}" still installed after delete; FAILED.`);
  }
}
```

So a `Before` hook runs `ensurePluginAbsent(slug)` then installs a fresh copy, and an `After` hook runs
`ensurePluginAbsent(slug)` — cleanup never fails merely because the plugin was already gone, yet a real
deletion failure still throws.

The **UI** path is for scenarios whose intent *is* the user-facing deletion flow; it is the asserted
variant. Detect install state with `locator.count() > 0` on `#activate-<slug>`/`#deactivate-<slug>` (not
`isVisible()`, which can't tell absent from offscreen). WordPress only offers Delete for inactive plugins,
so an active plugin is **deactivated first** (failure ⇒ `PluginDeactivationFailedError`). Deletion itself
is an **AJAX call** — `wp.updates` → `admin-ajax.php?action=delete-plugin`, guarded by a native
`confirm()`, *not* a navigation (verified against live wp-admin in Phase 3d). So: accept the `confirm()`
with a dialog handler removed in a `finally`; trigger Delete with a **forced click** (the normal
actionability wait can stall right after an in-session deactivate); await the **slug-specific
`delete-plugin` response** as a barrier (a missing one ⇒ failure); then **reload and re-assert** the
action links are gone — WordPress's in-place row removal is unreliable under automation, so the reloaded
DOM is the authoritative check. Throws the distinct errors above. Routine setup/teardown always uses the
faster CLI `ensurePluginAbsent`. *(WP Rocket's own post-delete "delete data" page is not yet exercised —
to be verified when porting WP Rocket, after Phase 10.)*

### 7.4 Other ported capabilities

- **DB ops** (`dbQuery`/`seedData`/`checkData`) → `wp db query` through the exec layer.
- **Settings export/import diff** → Playwright `expect` deep-equality (reported, retried);
  **`microdiff`** only if a structured diff object is needed.
- **`debug.log` error scan** → a tag-scoped After hook reading the log via the exec layer — WP-CLI
  `wp eval`, with a direct file read/removal fallback for when a fatal stops WordPress booting — and
  attaching it on failure.
- **Health check / report opener / archiving** → `node:util` `styleText` for colour;
  `npx playwright show-report` for opening; a tiny `fs` script or CI artifact upload for archiving.

### 7.5 Page Object Model & step wiring

Page-interaction logic lives **once** in a plain POM under `src/projects/<product>/pages/`
(cross-product POMs in `common/`); steps delegate to it. Recommended default:

```ts
// pages/dashboard.page.ts — plain POM (usable programmatically anywhere)
export class WpRocketDashboardPage {
  constructor(private readonly page: Page) {}
  async open() { await this.page.goto("/wp-admin/options-general.php?page=wprocket"); }
  async expectLoaded() { await expect(this.page.getByRole("heading", { name: /WP Rocket/ })).toBeVisible(); }
}
// fixtures.ts: wpRocket: ({ page }, use) => use(new WpRocketDashboardPage(page))
// steps:       Given("I am on the WP Rocket dashboard", ({ wpRocket }) => wpRocket.open());
```

**Only this pattern is used — no decorators, no hybrid.** All page-interaction logic lives in the POM;
the Gherkin wiring lives entirely in the product's `steps/` directory as thin step functions that call
POM methods (the POM is registered as a fixture in `common/fixtures.ts`). This keeps one source of truth
(the POM) cleanly separated from the step declarations and prevents interaction logic from leaking into
both places. playwright-bdd's decorator/`@Fixture` style is deliberately **not** adopted.

**Edition-divergent pages (BackWPup Free/Pro)** stay plain POMs too: where a flow genuinely differs by
edition, an interface + per-edition class + a small factory (`restorePage(page, edition)`) keeps each
edition's logic in its own class, selected via the `edition` fixture (§4.5). Shared pages remain single
classes used by both.

**Pitfall to note:** the `steps` glob must cover **every** step file **and** `fixtures.ts`; a step
file/class outside the glob (or not `export`ed) registers **zero steps silently** ("undefined step").
Modernise the baseline's `sections.ts`/`selectors.ts` to role-/label-based locators and web-first
assertions (no brittle CSS chains, no manual `isVisible()` polling).

### 7.6 Visual regression

Replace **BackstopJS** with Playwright **`toHaveScreenshot()`** (built-in: integrated into the runner,
trace, retries, masking, `threshold`/`maxDiffPixelRatio`, `stylePath`, `animations:"disabled"`).
Generate baselines **in the CI image/container** for cross-platform stability; commit per-project
snapshots; mask dynamic regions.

### 7.7 Device / viewport (desktop & mobile)

WP Rocket runs scenarios in both desktop and mobile views. Device is a **per-scenario client**
concern — orthogonal to cells and editions (it never multiplies the matrix or touches the worker→site
binding) — so it is tag-driven, **desktop by default**:

- **Sizes** (from the baseline): desktop **`1600×700`**, mobile **`389×829`**. The desktop viewport is
  the **default now** — every project runs Desktop Chrome at `1600×700` (set in the config factory). The
  mobile size applies via `@mobile` in Phase 6.
- **`@mobile`** scenarios get a mobile device profile via a `$tags`-driven `use` override — viewport
  **+ `isMobile` + `hasTouch` + mobile `userAgent` + `deviceScaleFactor`** from a `devices[...]` preset,
  applied at context creation (the same mechanism as `@noauth`, §3.3). Untagged scenarios stay desktop.
  This is declarative; the Playwright runner makes the `use` override possible where standalone Cucumber
  forced imperative, size-only `setViewportSize` calls.
- **Server-side mobile.** WP Rocket serves different cached/beacon output based on WordPress's
  `wp_is_mobile()`. Since the `@mobile` profile already sends a **mobile User-Agent**, that alone may make
  `wp_is_mobile()` true and WP Rocket serve mobile content — **to verify**. If it proves insufficient
  (caching edge cases), fall back to forcing it server-side via a `@mobile` `Before`/`After` hook (a
  `force-wp-mobile`-style helper). Prefer the UA-only path if testing confirms it.
- **Form-factor data.** Steps comparing device-specific data (e.g. LCP/ATF expected results, the
  `is_mobile` DB column) read `$tags` to pick the desktop vs mobile dataset.
- **Mid-scenario resize** (rare) stays available as an imperative `setViewportSize` step.

Lands with feature porting (Phase 6).

---

## 8. Dependency disposition

Legend: **DROP** = do not carry over · **REPLACE** = same capability, modern/built-in implementation ·
**KEEP** = carry forward · **ADD** = new capability.

### 8.1 DROP (dead weight or obsolete)

`axios`, `@types/axios` (deprecated stub), `boxen`, `node-zip`, `ssh2` (direct — transitive of
`node-ssh`), `@types/ssh2`, **`multiple-cucumber-html-reporter`** (declared, never invoked),
`@types/cucumber` (deprecated stub), `eslint-plugin-es5`, and the duplicate `playwright` (redundant with
`@playwright/test`). All proven unused by repo-wide source inspection.

### 8.2 REPLACE

| Baseline | Replace with | Why |
| --- | --- | --- |
| `backstopjs` (+ types, `backstop.json`) | Playwright **`toHaveScreenshot()`** | Built-in; integrated with runner/report; no separate engine. |
| `shelljs` (+ types) | **`execa` 9** (or `node:child_process`) | Promise-based, auto-escapes args (no injection), structured errors, ESM-native. |
| `chalk` 4 | **`node:util` `styleText`** (Node ≥ 24) | Zero-dependency native styling. |
| `ts-node` | **Native Node TS** (scripts) / runner transpile (tests) | Node 24 runs `.ts` directly; Cucumber CLI is gone. |
| `json-diff` (+ types) | Playwright `expect` deep-equality; `microdiff` if a diff object is needed | Assertions belong in `expect`; `microdiff` is tiny/typed. |

### 8.3 KEEP

- **`node-ssh`** (13.2.1) — remote WP-CLI for `ssh` mode (the default; Phase 3). Ships its own types.

`ServerMode`/transport validation uses a **native discriminated `switch`** with a fail-fast `default`
(in `sites.ts`), so no pattern-matching dependency is required. The Phase 3 exec-layer dispatch can use
the same native switch; **`ts-pattern`** is an **optional** ADD only if an exhaustive `match()` is wanted
there.

### 8.4 ADD

- **`allure-playwright`** (Allure 3, 3.10.0) — analytics/trends/flaky/dashboards (Phase 4).
- **`execa`** (9.6.1) — process execution (or built-in `node:child_process`) (Phase 3).
- *optional:* **`ts-pattern`** (exec-layer dispatch only), **`microdiff`** (settings diff object),
  **`http-server`** (serve MODE B report), **`@wordpress/env`** (quick local Apache only — does **not**
  satisfy the docker Apache+Nginx requirement).

### 8.5 `package.json` deltas (indicative; re-pin at implementation time)

- **Add (when their phase lands):** `execa`, `node-ssh`, `allure-playwright`; *optional:* `ts-pattern`,
  `microdiff`, `http-server`, `@wordpress/env`.
- **No new dependency needed for:** the execution model (plain Playwright config + factory), dual-mode
  reporting (`REPORT_MODE` + bundled `cucumberReporter`), the Gherkin/Cucumber HTML report (bundled in
  `playwright-bdd`; the standalone `@cucumber/cucumber` runner is **not** used), `.env` loading
  (`process.loadEnvFile()`), config validation (hand-rolled, no `zod`), and the plugin install-state
  checks (WP-CLI `is-installed`).
- **Do not add (built-ins / hooks cover them):** `backstopjs`, `shelljs`, `chalk`, `ts-node`, `dotenv`,
  `@playwright/browser-chromium` (§8.6).
- **Never carry over:** the §8.1 DROP list.

### 8.6 Browser provisioning

Chromium is downloaded by a `postinstall` script (`playwright install chromium`), so a fresh
`npm install` is immediately runnable with no extra step. A committed **`.npmrc` (`ignore-scripts=false`)**
ensures that hook runs even where install scripts are disabled globally; `npm run setup` re-runs it on
demand. The standalone `@playwright/browser-chromium` helper is **not** used — the `postinstall` always
matches the installed Playwright version, with one fewer version to keep in lockstep. The runner uses the
bundled Chromium (`devices["Desktop Chrome"]`, no `channel`).

---

## 9. Phased implementation plan

Each phase is independently shippable and verifiable. **Phases 0–2 are implemented; Phases 3–9 are
planned.**

**Phase 0 — Guardrails. ✅** Ratify §2 decisions as the project ADR; commit `.env.example`, per-product
`sites.example.json`, and a `README`.

**Phase 1 — Config foundation. ✅** Typed `env`/`requireEnv`/`intEnv`/`boolEnv` (`src/common/config/env.ts`);
the `Transport`/`ServerMode` discriminated union validated by a **native `switch`** with a fail-fast
`default`; `process.loadEnvFile()` (guarded, `load-env.ts`); per-product config modules + per-product
sites files (cells as keys) with the **validated** per-site `overrides` (§4.3); `reporting.ts` +
`project.ts`. *Acceptance:* `typecheck` + `lint` clean; invalid env/sites error clearly.

**Phase 2 — Execution model & isolation (orchestrator-ready). ✅** The `createProductConfig` factory +
root entries generating one project per cell (§4.4); the worker→site fixture (`parallelIndex`, §3.3) with
the **credential registry** (secrets off `metadata`, D10); the **multi-cell fail-fast guard** and `_all`
report bucket; per-cell setup/auth projects with placeholder-skip; and the `run-context` module resolving
the stable, overwrite-in-place `<product>/<cell>` paths (§3.5). *Acceptance:* a developer can run **any**
cell manually with **no env vars** and the `@noauth` smoke is green on a fresh checkout; running two
**different** cells at once never conflicts; ephemeral build/state dirs **overwrite in place** while
reports accumulate per cell; no credential appears in any report — no orchestrator yet.

**Phase 3 — WordPress automation layer.** `exec.ts` (execa/node-ssh, `exitCode` on every mode, plus the
per-transport **file transfer** `copyIntoTarget` and `wpRootDir` — WP-CLI reads files from the *site's*
filesystem, so a runner path is useless to a remote `wp`); `staging.ts` (the per-site `.e2e_temp`
staging area built on those primitives); WP-CLI
helpers + UI plugin page-objects with idempotent cleanup vs. asserted deletion and distinct errors; the custom
`docker compose` (Apache **and** Nginx + vhost). *Acceptance:* `wp core version` works in each mode and
against both Apache and Nginx; deletion-under-test passes for an installed plugin; a `Before`/`After`
`ensurePluginAbsent` is a **no-op** when the plugin is already gone; a genuine delete failure raises
`PluginDeletionFailedError`.

**Phase 4 — Reporting. ✅** Dual-mode `cucumberReporter` via `REPORT_MODE`; `retain-on-failure` capture;
Allure 3 (`allurerc.mjs`: categories incl. `flaky`, dashboard widgets, `singleFile: true`); per-cell
report folders (no merge). *Acceptance:* MODE A = one portable file with embedded video on failure;
MODE B = embedded trace viewer over http; Allure trends across ≥ 2 runs.
*Implemented:* `allure-playwright` reporter writes raw results to `<report>/allure-results` (added to
`reporters()`); `scripts/allure.mjs` (`npm run report:allure [product] [cell] [--open]`) finds the
newest run and invokes the `allure` CLI, generating into `<report>/allure` with `awesome` + `dashboard`
plugins (both `singleFile`). Trends/flaky accumulate via a **per-cell** `allure-history.jsonl` that
`allure generate` reads then updates — so a per-run report shows the trend across all prior runs.
Verified end-to-end across two runs (history grows 1 snapshot/run; flaky test categorised on retry).

**Phase 5 — Visual regression. ✅** Replaces the baseline's BackstopJS, which was confirmed **fully
disabled** (`return; // Skip VR tests` in every step, zero committed references) and used **only** an
A/B model: render with optimizations bypassed (`?nowprocket`) vs optimized, same run, no stored
baseline.
*Implemented* (`src/common/visual/`, layered for reuse):

- `compare.ts` — pure pngjs + pixelmatch diff (`comparePng` → `{diffPixels, totalPixels, ratio,
  diffImage}`, `ImageDimensionsMismatchError`); the same engine Playwright uses internally,
  browser-free and unit-tested.
- `stabilize.ts` — `stabilizeForSnapshot` (lazy-load scroll + `document.fonts.ready`), shared by both
  models; best-effort (logged, never throws).
- `ab.ts` — **`expectOptimizedToMatchUnoptimized(page, url, opts)`**, the WP Rocket model: captures
  `?nowprocket` then optimized, diffs them, attaches both renders + diff on failure; `captureFullPage`
  exposed for custom A/B. Masking + per-call tolerance; bypass flag configurable.
- `screenshot.ts` — committed-baseline `expectPageToMatch`/`expectElementToMatch` kept as a general
  capability (config factory sets `expect.toHaveScreenshot` + a per-product/cell `snapshotPathTemplate`
  under `src/projects/<product>/__snapshots__/`), but NOT what WP Rocket uses, so not in the README.

Tolerances centralised in `config/visual.ts`. *Verified end-to-end* (committed specs, 24 unit tests):
`comparePng` identical/different/dimension-mismatch; A/B passes on match, fails (right message) on a
pixel difference, and masking ignores a differing region. The `@visual` scenarios that call
`expectOptimizedToMatchUnoptimized` land with feature porting (Phase 6).

**Phase 6 — Feature porting (per product) — improve, don't copy.** Rewrite to modern idioms
(web-first assertions, role/label locators, fixtures, `storageState`); port auth, POM, tag-scoped hooks,
and the `debug.log` scan; migrate `backwpup` (`wp-rocket` is deferred until after Phase 10 — see below). The **editions** model (§4.5) is already
in place (`Edition` type, per-cell `edition` in routing metadata, the all-or-none check, `editionFilter`,
the `edition` fixture); what remains here is tagging scenarios `@free`/`@pro` (untagged = both) and the
**plugin-install hook**, which must:

- take the cell's zip from the `pluginArtifact("plugin")` fixture — already resolved *and* identity-verified
  for this execution by the `artifacts:<cell>` setup — instead of any config-declared path (§4.5);
- **stage it onto the site first** for `ssh`/`docker` targets (`stageAndInstallPlugin`, or
  `stageArtifact` + `installPlugin`): the fixture yields a path on the *runner*, which only a `local`
  transport's `wp` can read. See [wordpress-automation.md](../architecture/wordpress-automation.md);
- wire `cleanSiteStaging` into the **worker teardown**, beside `disposeConnections`, as best-effort
  cleanup so a run leaves no `.e2e_temp` behind on the site and never fails a passing scenario.

*Acceptance:* existing smoke features stay green; each cell installs its edition's package (over `ssh`
and `docker`, not only `local`) and `@pro`/`@free` scenarios run only on their edition's cells; a review
checklist confirms no 1:1 carry-over. (Check retries in this phase, maybe 0 retries for local is not the best, must assess this)

**Phase 7 - Tests output.** Display a very good progress in the terminal/console when tests are running, displaying how many tests were run, how many remaining, how many passed, how many failed, etc. And every time a test/scenario fails, display the name of the failed test/scenario + the failed step in the terminal (if not the default by Playwright).

**Phase 8 — CI. Dropped.** It planned the suite on real cells as a CI matrix (one job per product ×
cell). Real-cell runs, PRs included, belong to the [orchestrator](orchestrator-plan.md) instead; CI
keeps its quality, unit and `@noauth` smoke jobs (`.github/workflows/ci.yml`).

**Phase 9 — Orchestrator → [its own plan](orchestrator-plan.md).** Moved out: it is a long-running
service with phases of its own. `report:prune`, the pre-warm call and the Free/Pro single-build
optimization moved with it.

**Phase 10 — Cleanup & validation.** `deps:check` (e.g. `depcheck`) to catch unused deps; ensure no
dropped dependency reappears; `lint`/`typecheck`/`format:check` green; reports generate. Remove any mention of the Phases in codebase comments, etc.

**After Phase 10 — WP Rocket feature porting.** Deferred out of Phase 6 (decided 2026-10-06): Phase 6
closes on BackWPup alone, and WP Rocket's port starts once Phase 10 is done, on the same rails and
recipe. Scope and approach:
[phase-6-feature-porting-plan.md §6](phase-6-feature-porting-plan.md#6-after-phase-10--wp-rocket).

---

## 10. Feature-parity matrix (capability → target design)

| # | Baseline capability | Target design |
| --- | --- | --- |
| 1 | WP-CLI exec (local/Docker/SSH) | `common/wp/exec.ts`: `execa` (local + `docker exec <container>`), `node-ssh` (remote); `exitCode` on every mode. |
| 2 | Server/env config | Typed env (`env`/`intEnv`/`boolEnv`) + `Transport`/`ServerMode` union validated by a native `switch` (default `ssh`); per-product config + per-product sites files (cells). §4. |
| 3 | Plugin/theme lifecycle | WP-CLI wrappers **and** UI page-objects; idempotent `ensurePluginAbsent` for cleanup hooks, asserted `deletePlugin`/UI for deletion-under-test; distinct errors. §7.3. |
| 4 | DB ops | `wp db query` through the exec layer. |
| 5 | Visual regression | Playwright `toHaveScreenshot` (built-in). §7.6. |
| 6 | Settings export/import diff | `expect` deep-equality; `microdiff` if a diff object is needed. |
| 7 | Auth (login/logout) | `storageState`, per-cell setup project + per-site state file + `@noauth` fixture; worker→site via `parallelIndex`. §3.3, §5. |
| 8 | POM (sections/selectors) | Plain POM as a fixture; thin steps delegate to it (no decorators/hybrid); edition-divergent pages via an interface + per-edition class + factory. §7.5, §4.5. |
| 9 | Lifecycle hooks | `playwright-bdd` `Before/After/BeforeAll/AfterAll` with `{ tags }`. |
| 10 | Health check / open report / archiving | `node:util styleText`; `playwright show-report`; `fs` script / CI artifact. |
| 11 | `debug.log` scan | Tag-scoped After hook; attach on failure. |
| 12 | Local WP env | `docker` = Apache + Nginx (custom compose); `local` = any server; `@wordpress/env` optional. §7.1. |
| 13 | Execution / parallelism | **(product × cell)** run units, site pools, orchestrator; per-cell reports. §3 — *new capability*. |
| 14 | Plugin editions (Free/Pro) | BackWPup Free & Pro as **one product**; edition is a **per-cell** property selecting the plugin package + scenario filter (`@free`/`@pro`) + POM branch. §4.5 — *new capability*. |
| 15 | Credential safety | Site secrets resolved via an in-process registry, never via report-serialized `metadata`. §3.3 — *new capability*. |
| 16 | Plugin zip selection (`new_release` / `previous_stable` paths) | Per-execution resolution: `plugin`/`previous` **roles** built from any git ref through APVM (or an operator zip), identity-verified per product **and edition** before scenarios run, consumed via the `pluginArtifact` fixture and staged onto `ssh`/`docker` targets. [plugin-artifacts.md](../architecture/plugin-artifacts.md) — *new capability*. |

---

## 11. Risks & mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Parallelism vs shared WP state | High | Each worker is pinned to its **own** isolated site (`pool[parallelIndex]`, §3.3); run units are one-invocation-per-cell so `parallelIndex` stays in range (§3.2). Residual gate is **provisioning isolated sites**, not a refactor. |
| Artifact growth / concurrent clobbering | Low | Ephemeral build/state dirs (`.features-gen`, `.auth`, `test-results`) **overwrite in place** → never accumulate (§3.5). Reports accumulate per cell **by intent**, bounded later by `report:prune` (newest *N*). Different cells use different paths (concurrent different-cell runs don't clash, except the gaps in the [orchestrator plan](orchestrator-plan.md)'s Phase 0); the same cell must not run concurrently (shared WordPress state). |
| Shell injection in WP-CLI calls | Med | `execa` **array args** (auto-escaped); never interpolate into a shell string. |
| Lost SSH/Docker/UI nuance during the port | Med | Characterise with a per-mode smoke test first, then re-implement with modern idioms (coverage preserved). |
| `storageState` goes stale | Med | The per-cell setup is a **dependency** of the cell's BDD project → re-authenticated each run into its own file; `@noauth` isolates login/logout. |
| Plugin cleanup vs. deletion-under-test | Med | Cleanup hooks use the **idempotent** `ensurePluginAbsent` (already-absent ⇒ no-op), so teardown never fails on an already-deleted plugin; deletion-under-test asserts presence first. Arm `page.once("dialog")` before the click; handle WP Rocket's second confirmation page; detect state via `count()`; re-assert removal (`PluginDeletionFailedError`). |
| Visual-regression baselines differ across OS/CI | High | Generate snapshots in the CI image/container; commit per-platform; tune `maxDiffPixelRatio`; mask dynamic content. |
| `docker` mode setup (Apache + Nginx) | Med | The default `ssh` mode needs no Docker. `docker` requires a custom compose + Nginx vhost; pin image tags; never publish the php-fpm port. |
| Credentials leaking into shared reports | Med | Pools reach workers via an in-process registry; project `metadata` carries only `{ product, cell }` (D10, §3.3). Verified: no secret appears in the generated report (plaintext or base64-decoded). |
| Edition tests run against the wrong edition | Low | Each cell declares its `edition`, which selects both the installed package and the per-cell tag filter (`not @free`/`not @pro`); a cell can neither install the wrong package nor generate the other edition's specs (§4.5). |

---

## 12. References

> Versions verified via the **npm registry** (2026-06-11). Library behaviour verified against
> **official documentation** (Playwright, `playwright-bdd`, Allure 3, `execa`, WP-CLI, Docker Hub) and,
> for runtime parallelism, corroborated by Playwright maintainer statements. Node-native behaviours
> (TypeScript execution, `util.styleText`, `process.loadEnvFile`) were verified empirically on Node 24.

**Key verified facts behind the architecture:**

- `parallelIndex` is bounded by the **global** `workers` and is **not** reset per project; safe pool
  indexing therefore requires one project per invocation with `workers = pool size`
  (Playwright `class-testinfo`/`class-workerinfo`/`test-parallel`; corroborated by microsoft/playwright
  #38953).
- Projects **multiply** tests (matrix); workers **distribute** them (each test once) — Playwright
  `test-projects`, `test-parallel`.
- `testProject.workers` exists since **v1.52** but caps concurrency only, not which `parallelIndex`
  values a project sees — `class-testproject`.
- `defineBddConfig` returns the generated test dir and accepts a **`tags`** expression that filters
  scenarios at generation (`tags?: string`, "filter scenarios for generation"); a distinct `outputDir`
  per cell lets the same product features back multiple projects — playwright-bdd `config` types / `api`.
- Cucumber reporter `externalAttachments` (embed vs external + the `http(s)://` trace-viewer
  requirement) and `skipAttachments` content-types — playwright-bdd `reporters/cucumber`.
- Playwright serializes a project's **`metadata`** verbatim into its reports, so site credentials are
  kept out of `metadata` and resolved via an in-process registry instead — Playwright `class-testproject`.

**Documentation:**

- Playwright — Test projects, parallelism, sharding, reporters, TestInfo/WorkerInfo/TestConfig/TestProject:
  <https://playwright.dev/docs/test-projects> · <https://playwright.dev/docs/test-parallel> ·
  <https://playwright.dev/docs/test-reporters> · <https://playwright.dev/docs/api/class-testinfo> ·
  <https://playwright.dev/docs/api/class-testproject>
- Playwright — Visual comparisons (`toHaveScreenshot`), Auth (`storageState`):
  <https://playwright.dev/docs/test-snapshots> · <https://playwright.dev/docs/auth>
- playwright-bdd — Cucumber reporter, `defineBddConfig` (incl. `tags` filter), authentication,
  POM-as-fixture, hooks: <https://vitalets.github.io/playwright-bdd/>
- Allure 3 — `allurerc.mjs` (`defineConfig`, `singleFile`, categories, dashboard):
  <https://allurereport.org/docs/playwright/> · <https://github.com/allure-framework/allure3>
- WP-CLI — plugin `is-installed`/`is-active`/`delete`/`list` (exit-code semantics):
  <https://developer.wordpress.org/cli/commands/plugin/>
- Docker — official `wordpress` image (Apache vs `fpm`; FastCGI note): <https://hub.docker.com/_/wordpress>
- execa — escaping (array args) & errors: <https://github.com/sindresorhus/execa>
- node-ssh: <https://github.com/steelbrain/node-ssh> · ts-pattern: <https://github.com/gvergnaud/ts-pattern>
- Node — native TS, `util.styleText`, `--env-file`/`process.loadEnvFile()`:
  <https://nodejs.org/api/typescript.html> · <https://nodejs.org/api/util.html> ·
  <https://nodejs.org/api/process.html#processloadenvfilepath>

**Installed (this repo):** `@playwright/test` 1.61.0 · `playwright-bdd` 9.2.0 · `typescript` 6.0.3 ·
`eslint` 10.5.0 · `typescript-eslint` 8.61.1 · `prettier` 3.8.4 · `@types/node` 24.13.2 · Node ≥ 24.16.
**Planned ADDs (re-pin at their phase):** `allure-playwright` 3.10.0 · `node-ssh` 13.2.1 · `execa` 9.6.1 ·
`ts-pattern` 5.9.0 (optional) · `microdiff` 1.5.0 · `@wordpress/env` 11.8.0.
