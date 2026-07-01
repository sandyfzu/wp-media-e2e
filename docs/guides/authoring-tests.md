# Authoring tests

How scenarios are written and wired. Tests are **BDD**: Gherkin `.feature` files
describe behaviour, step definitions implement it, and `playwright-bdd` generates
Playwright specs from the pair.

## The BDD pipeline

```
.feature  +  step definitions   ──bddgen──▶  generated specs  ──playwright──▶  run
(Gherkin)    (TypeScript)                     (.features-gen/, git-ignored)
```

`bddgen` runs automatically inside the `test:*` scripts. The generated
`.features-gen/` directory is ephemeral and git-ignored — never edit or commit it.

## Where things live

```
src/
├── common/                       # product-agnostic, shared by every product
│   ├── fixtures.ts               # the test instance + Given/When/Then exports
│   ├── steps/                    # generic steps (e.g. world.steps.ts)
│   ├── pages/                    # page objects (e.g. plugins.page.ts)
│   ├── visual/                   # visual helpers (ab.ts, screenshot.ts, …)
│   └── wp/                       # WordPress automation (see ../architecture/wordpress-automation.md)
└── projects/<product>/
    ├── config/<product>.config.ts   # ProductConfig + sites.json/sites.*.json/sites.example.json
    ├── features/**/*.feature        # this product's scenarios
    ├── steps/**/*.ts                # this product's steps
    └── support/debug-log.ts         # debug-log presets
```

A product's `steps` array (in its config) is the exact set of step files loaded:
`fixtures.ts` + `common/steps/**` + that product's own `steps/**`. So a
product-specific step is only available to that product.

## Fixtures ([`src/common/fixtures.ts`](../../src/common/fixtures.ts))

Import `Given`, `When`, `Then`, `Before`, `After`, etc. from `fixtures.ts`
(**not** from `playwright-bdd` directly) — this binds them to the extended test
instance with these fixtures:

| Fixture     | Scope    | What it gives you                                                                                              |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `site`      | test     | The [`SiteConfig`](../../src/common/config/types.ts) bound to this worker. Throws if no pool.                  |
| `edition`   | test     | The cell's `Edition` (`free`/`pro`). **Throws** if read in an editionless cell.                                |
| `boundSite` | worker   | The site pinned to this worker (by `parallelIndex`), or `undefined` when there is no pool. Underpins `site`.   |
| `baseURL`   | (override) | Points at the bound site, so relative navigations target it.                                                  |
| `storageState` | (override) | The bound site's saved login, **or** an empty session for `@noauth` scenarios.                            |

Use `site.transport` to drive the WordPress automation layer, and `page` (the
standard Playwright fixture) for browser interaction.

## Tags

| Tag         | Effect                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `@noauth`   | Scenario starts unauthenticated with an empty session (login/logout flows).                     |
| `@smoke`    | Scaffolding/smoke scenarios; run with `--grep @smoke`.                                           |
| `@free` / `@pro` | Edition scoping. An edition-ful cell auto-filters: a `pro` cell skips `@free` and vice-versa. |
| `@visual`   | Visual-regression scenarios; group with `--grep @visual` and run in the Playwright container.    |

## Page Object Model

UI interactions belong in page objects under `src/common/pages/`, not inline in
steps. [`PluginsPage`](../../src/common/pages/plugins.page.ts) is the reference:
it owns the wp-admin Plugins screen and exposes `goto`, `isInstalled`, `isActive`,
`activate`, `deactivate`, `delete` (the asserted UI flow), and `ensureAbsent`
(idempotent cleanup). Methods throw the typed errors from
[`wp/errors.ts`](../../src/common/wp/errors.ts) on failure.

## Adding a scenario — checklist

1. Write the `.feature` file under `src/projects/<product>/features/`.
2. Implement any new steps in `src/projects/<product>/steps/` (or `common/steps/`
   if truly generic), importing `Given`/`When`/`Then` from `fixtures.ts`.
3. Put UI logic in a page object under `common/pages/`; use `wp/` modules for
   WP-CLI work via `site.transport`.
4. Document every new function/method with TSDoc; type everything explicitly.
5. Run the quality gates (typecheck, lint, format, unit tests) — see
   [AGENTS.md](../../AGENTS.md#required-workflow-after-every-edit).
6. Verify against a real cell: `npm run test:<product> -- --project=<cell>`.

## Unit / integration tests

Files matching `*.spec.ts` under `src/common/` are unit tests run by
`npm run test:unit` (config: [`playwright.unit.config.ts`](../../playwright.unit.config.ts)).
They run with **no external environment**: the WP-CLI layer is exercised through a
stub `wp` on `PATH`, and page objects against `page.setContent()` fixtures. They
are kept separate from the BDD product configs and never match generated feature
specs. Add a `*.spec.ts` next to any non-trivial module you add to `common/`.
