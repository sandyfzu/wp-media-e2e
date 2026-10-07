# Execution model & architecture

How a run is structured, why exactly one cell runs per invocation, and how the
config factory turns a product definition into runnable Playwright projects.

## Vocabulary

| Term         | Meaning                                                                                                                              | Where it lives                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Product**  | A plugin under test (`wp-rocket`, `backwpup`). Declares its own features, steps, sites, and optional service credentials.            | `src/projects/<product>/config/<product>.config.ts`, listed in `src/projects/products.ts` |
| **Cell**     | A named environment (`apache`, `nginx`, `pro@nginx`). Cells are **data-driven**: keys of `sites.json` / `sites.*.json` overlays.     | `sites.json` / `sites.*.json`                           |
| **Pool**     | The list of interchangeable WordPress sites backing one cell. Scenarios are distributed across the pool by worker.                   | a cell's `sites` array                                  |
| **Run unit** | One `(product × cell)`. The unit of a single invocation and of one report directory.                                                | `E2E_CELL=<cell>` pins it (or `--project=<cell>`)       |
| **Edition**  | `free` / `pro`, for products shipped as two packages (BackWPup). Editionless products (WP Rocket) omit it.                           | a cell's optional `edition` field                       |

## Worker → site binding (the load-bearing invariant)

Each Playwright **worker** pins itself to exactly one site in the pool, indexed
by its global `parallelIndex` ([`src/common/fixtures.ts`](../../src/common/fixtures.ts)
`boundSite`). For `pool[parallelIndex]` to always be in range, the number of
workers must equal the selected cell's pool size — which only holds when a single
cell is selected.

`parallelIndex` is **global across all projects in a run**, not per-project. So if
two cells with different pool sizes ran in one invocation, the index would overflow
the smaller pool. The config factory therefore:

1. Sets the run's global `workers` to the **selected cell's** pool size
   ([`createProductConfig`](../../src/common/config/project.ts)).
2. **Fails fast** if more than one known cell is selected at once.

> **Rule for agents:** run exactly one cell per invocation, pinned
> (`E2E_CELL=<cell>`). Never "select all projects". A cell-less run is forced
> serial (`workers = 1`) and is safe but exercises no pool.

### The cell pin (`E2E_CELL`)

`bddgen` generates every BDD config the product's Playwright config registers — one per cell — and
deletes each cell's specs before writing them again. So with every cell in the config, a run's
`bddgen` removes the specs another run of the same product is collecting or loading: started
together, two runs of different cells failed 2 times in 80 (`ENOENT`, `Cannot find module`).
`bddgen` takes no `--project`, and npm hands `-- args` to a script's last command only, so the
environment is the one channel that reaches `bddgen`, the runner and every worker alike.

`E2E_CELL=<cell>` ([`cell-pin.ts`](../../src/common/config/cell-pin.ts)) is that channel. With it:

- the config holds that cell alone — its three projects, its pool, its BDD config — so `bddgen`
  regenerates only its specs, and needs no `--project` (the config's three projects are the cell);
- `selectedCells()` returns the pin, so the worker count, the report folder and
  `isCellTargeted` agree with it in every process;
- a pin naming no cell of the product fails at once, in `bddgen` already, naming the product's cells;
- a `--project` that selects none of the pinned cell's projects — matched by Playwright's own rule:
  case-insensitive, `*` wildcards — fails naming `E2E_CELL`. Playwright alone would say only
  "Project(s) … not found", a puzzle when the pin came from `.env`. A `--project` that does fit
  narrows the run within the cell (`--project=artifacts:<cell>`).

Unpinned, everything is as before: `--project=<cell>` runs one cell, but its `bddgen` regenerates
every cell's specs, so it is safe only when no other run of the product is going. A blank
`E2E_CELL` is no pin. `.env` is loaded into every process, so a pin there pins every run from the
checkout; the orchestrator builds each run's environment itself, from an allowlist that never
carries `PLAYWRIGHT_BDD_CONFIGS` — an inherited value of that playwright-bdd variable would make
`bddgen` generate the configs it names, pin or not.

**The `[cell]` notice.** Nothing else on the terminal names a run's cell, so the first reporter
([`reporting/cell-notice.ts`](../../src/common/reporting/cell-notice.ts)) prints one line before
`Running …`: the product and cell, whether `E2E_CELL` or `--project` chose it (and so whether
another cell may run beside it), the workers and the report folder. A reporter, because only the
runner process runs reporters; the config is evaluated in every process of a run.

### Reading the selection from a worker

`selectedCells()` ([`run-context.ts`](../../src/common/config/run-context.ts)) is
the single source of truth for "which cells did this invocation target". A pin wins; every
process inherits it. Otherwise it reads `projectSelection()`, which parses
the `--project` forms from `process.argv` — but **a Playwright worker never receives
the CLI argv**: it is forked with `[node, workerProcessEntry.js]`, and the project
`metadata` a worker reads is the copy *it* just rebuilt, not the runner's. So an
argv-derived decision cannot reach a worker through either channel.

It rides the **environment** instead, exactly as `RUN_ID` does: the config factory
calls `seedSelectedCells()` while the runner builds the config, and `projectSelection()`
falls back to that inherited value when argv is empty. Reading `process.argv` directly
from worker-side code is a bug.

Worker-side code that needs the "was this cell explicitly targeted?" answer should ask
`isCellTargeted(cell, projectName)` rather than re-deriving it — it also counts a pin and a
`--project=artifacts:<cell>` selection, and it is the gate on whether per-run `E2E_*`
overrides apply (a broad sweep must not inherit one cell's override).

## The product list

[`src/projects/products.ts`](../../src/projects/products.ts) is the one list of products. It is
read by every entry point that spans products: the bare `playwright.config.ts` (`productFromEnv`
over `PRODUCT`), the healthcheck, the artifact warm, and the orchestrator later
(`productByName`, `playwrightConfigFor`). A product's own `playwright.<product>.config.ts`
imports only that product, so its runs never load another product's sites files.

- **Import effects.** Importing the list loads every product's sites files and reads `BWP_*`,
  but never loads `.env` or stamps `RUN_ID`. A long-lived process can import it and keep its
  own environment. Importing `run-context.ts`, and so `resolve.ts` or `consume.ts`, does both.
- **Drift guard.** `products.spec.ts` fails when the list disagrees with `src/projects/`'s
  folders, or a product's features or own steps lie outside its folder. It also fails when a
  product lacks a root entry config that builds it (checked in a child Node) or a `test:<product>`
  script running that config, or when a stray `playwright.*.config.ts` or script names an
  unlisted product.
- **Boundary.** Nothing in `src/common/**` may import `src/projects/`, the list included.
  ESLint flags a static import as it is typed. `src/common/import-boundary.spec.ts` also catches
  a dynamic `import()` or a `typeof import()` type, which ESLint cannot see.

## The config factory

[`createProductConfig(product)`](../../src/common/config/project.ts) expands a
[`ProductConfig`](../../src/common/config/types.ts) into a Playwright config. For
**each** cell it holds — every cell of the product, or the pinned one alone — it emits three
projects, two sibling setup projects and the BDD project that depends on both:

- **`setup:<cell>`** — a plain Playwright project (not BDD) that runs
  [`auth.setup.ts`](../../src/common/auth/auth.setup.ts) to authenticate the
  cell's pool.
- **`artifacts:<cell>`** — a sibling setup project (no browser) that runs
  [`artifacts.setup.ts`](../../src/common/artifacts/artifacts.setup.ts): it
  resolves the cell's plugin zips under test (build a git ref via APVM, or copy a
  provided zip) into a wiped `.artifacts/<product>/<cell>/`, runs a static
  identity preflight over them, and writes `resolution.json`. See
  [plugin-artifacts.md](plugin-artifacts.md).
- **`<cell>`** — the BDD project (generated by `playwright-bdd`'s
  `defineBddConfig`) that `dependencies: ["setup:<cell>", "artifacts:<cell>"]`.
  The two setups are **independent siblings** (neither depends on the other):
  either one **failing** skips the BDD scenarios, while a placeholder-only cell
  **skips** both without blocking (there is nothing to authenticate or build, so
  the `@noauth` smoke still runs).

Per-project knobs the factory sets:

- `baseURL` defaults to the cell's first site (overridden per-worker by the
  `baseURL` fixture so each worker targets its own bound site).
- `retries: 2` under CI, `0` locally.
- Edition-ful cells generate only their edition's scenarios via a Cucumber tag
  filter (`pro` → `not @free`, `free` → `not @pro`).
- `workers` per project is a defensive cap only; correctness rests on the global
  single-cell `workers` described above.

## Credential handling: the in-memory pool registry

Playwright serializes a project's `metadata` **verbatim into its reports**, so it
must never carry secrets. The split ([`src/common/config/metadata.ts`](../../src/common/config/metadata.ts)):

- **`metadata`** carries only non-secret routing: `{ product, cell, edition? }`
  (`routingMetadata` / `readRouting`).
- The credential-bearing resolved pool is handed to workers through an
  **in-process registry** (`registerPool` / `getPool`), populated as a side
  effect of building the config. Playwright re-executes the config in every
  worker process, so each worker rebuilds its pool locally from the sites files —
  never from a report-bound channel.

The same channel carries the rest of a product's policy to the **shared scenario hooks**, which must
not import product code: its debug-log preset (`registerDebugLogOptions` / `getDebugLogOptions` —
RegExps, which JSON cannot express anyway), the paths it leaves on disk (`registerSiteResidue` /
`getSiteResidue`), the footprint it leaves in the database (`registerSiteDbResidue` /
`getSiteDbResidue`) and the function that stops work it may still be running on a site
(`registerStopRunningWork` / `getStopRunningWork` — a function, so metadata could never carry it).
The residue declarations *would* fit in metadata and still do not go there: one channel for product
policy is easier to follow than two. The hooks read the pair through `declaredResidue(product)`
(`hooks/plugin-lifecycle.ts`), and so does a product step that reinstalls mid-scenario on their
behalf, so the two can never sweep different things. Unlike `getPool`, none of these throws — a product that declares
none is a legitimate state, and the corresponding step then costs no round-trip at all. The residue
getters answer an empty value, `getStopRunningWork` answers `undefined`, which the teardown reads as
"nothing to ask".

## Artifact directories & lifecycle

[`src/common/config/run-context.ts`](../../src/common/config/run-context.ts)
resolves all paths via `dirs(product, cell)`. Two lifecycles:

| Kind                       | Path shape                                          | Lifecycle                                                     |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| **report** (accumulates)   | `<REPORT_ROOT>/<product>/<cell>/<RUN_ID>/`          | One per run; pruned later by a `report:prune` utility.       |
| **output**                 | `<OUTPUT_ROOT>/<product>/<cell>/`, or `…/<product>/_all/<cell>/` | Ephemeral: Playwright empties it as a run that selects one of its projects starts (see below). |
| **auth / bdd**             | `<*_ROOT>/<product>/<cell>/`                         | Ephemeral, stable per `(product, cell)`; overwritten in place. |
| **artifacts** (ephemeral)  | `<ARTIFACTS_ROOT>/<product>/<cell>/`                | **Wiped whole** and re-resolved each run; holds the role zips under test + `resolution.json`. |

- `RUN_ID` is auto-stamped (filesystem-safe, lexically sortable) unless pinned by
  an orchestrator so a batch of cells shares one token.
- The `<product>/<cell>` namespace is **always** appended, so two cells never share a
  directory, whatever the `*_ROOT` overrides (`REPORT_ROOT`, `OUTPUT_ROOT`, `AUTH_ROOT`,
  `ARTIFACTS_ROOT`). Two runs of one cell share every folder of it but the report, so a
  cell takes one run at a time.
- **Output folders follow the selection** (`outputDirFor`). Playwright empties the output
  folder of every project a run selects before it starts. So a cell's three projects
  write in `<product>/<cell>` only in a run that targets that cell as a whole
  (`cellOwningOutput`): pinned with no `--project`, or `--project=<cell>`, pinned or not. Every
  other run's projects write in `<product>/_all/<cell>`: no pin and no `--project`, a setup
  project alone, a wildcard, another cell's project. None of
  them can empty a running cell's folder. Unit runs write in `<OUTPUT_ROOT>/_unit`.
  Cell names are checked at load, so none is `_`-prefixed or escapes its folder.
- **Reports and logins are absolute paths in the checkout.** Playwright resolves a
  config's own paths against the config's folder. But allure-playwright's `resultsDir` and
  a `storageState` path resolve against the working directory, so `reporters()` refuses
  a relative folder and each site's `storageState` is absolute. A run started anywhere
  writes in the checkout, though `.env` is still read from the working directory.
- The artifacts dir is the only one **wiped** (not merely overwritten) each run:
  refs re-resolve (a cache hit is a copy) and provided zips are copied in, so no
  stale zip from a prior execution can survive. `resolution.json` lives inside it,
  so it can never describe a previous run's zips — the cross-process channel the
  BDD workers read through the `pluginArtifact` fixture. Because the wipe is
  unconditional, an `E2E_*_ZIP` pointing **inside** this dir is rejected before
  anything is deleted, rather than having the operator's file removed under them.
- A cell-less run reports to an `_all` bucket so it is never mislabeled as a
  single cell.

## Mental model, end to end

```text
E2E_CELL=apache npm run test:wp-rocket
        │
        ├─ load-env.ts                 → .env into process.env (once)
        ├─ wp-rocket.config.ts         → ProductConfig { name, features, steps, sites, artifacts }
        └─ createProductConfig()       (in bddgen, the runner and every worker)
              ├─ E2E_CELL → holds apache alone (unknown pin / stray --project → fail)
              ├─ selectedCells() → ["apache"]  (fail fast if >1)
              ├─ global workers  = apache pool size
              ├─ project setup:apache     → preflight + auth.setup.ts (login → storageState)
              ├─ project artifacts:apache → resolve + verify plugin zips (→ .artifacts/…/resolution.json)
              └─ project apache → depends on BOTH setups → bddgen specs → run, each worker bound to one site
```

> **Pre-warming (optional).** `npm run artifacts:warm [-- --product=<p>] [--cell=<c>]`
> primes APVM's cache for the cells a run will need, so each `artifacts:<cell>`
> build becomes a cache copy instead of a fresh build. It plans through the same
> request builder the resolver uses (the parity invariant), so a warmed entry is
> always the one the run looks up. The planned orchestrator
> ([its plan](../plans/orchestrator-plan.md)) calls the same `warmArtifacts` before
> each run.
