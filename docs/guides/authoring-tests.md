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
│   ├── hooks/                    # shared scenario hooks (*.hooks.ts) + their policy modules
│   ├── pages/                    # page objects (e.g. plugins.page.ts)
│   ├── visual/                   # visual helpers (ab.ts, screenshot.ts, …)
│   ├── config/devices.ts         # desktop & @mobile device profiles
│   ├── artifacts/                # the plugin zips under test (see ../architecture/plugin-artifacts.md)
│   └── wp/                       # WordPress automation (see ../architecture/wordpress-automation.md)
└── projects/<product>/
    ├── config/<product>.config.ts   # ProductConfig + sites.json/sites.*.json/sites.example.json
    ├── features/**/*.feature        # this product's scenarios
    ├── steps/**/*.ts                # this product's steps
    └── support/debug-log.ts         # debug-log presets
```

A product's `steps` array (in its config) is the exact set of files loaded at runtime:
`fixtures.ts` + `common/hooks/**/*.hooks.ts` + `common/steps/**` + that product's own
`steps/**`. So a product-specific step is only available to that product — and a **hook
file missing from that array never registers**, leaving its lifecycle silently absent
rather than failing. Add new shared hooks as `src/common/hooks/<name>.hooks.ts` so the
existing glob picks them up.

## Fixtures ([`src/common/fixtures.ts`](../../src/common/fixtures.ts))

Import `Given`, `When`, `Then`, `Before`, `After`, etc. from `fixtures.ts`
(**not** from `playwright-bdd` directly) — this binds them to the extended test
instance with these fixtures:

| Fixture     | Scope    | What it gives you                                                                                              |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `site`      | test     | The [`SiteConfig`](../../src/common/config/types.ts) bound to this worker. Throws if no pool.                  |
| `edition`   | test     | The cell's `Edition` (`free`/`pro`). **Throws** if read in an editionless cell.                                |
| `boundSite` | worker   | The site pinned to this worker (by `parallelIndex`), or `undefined` when there is no pool. Underpins `site`.   |
| `pluginArtifact` | test | `pluginArtifact(role)` → the resolved zip for this cell (`"plugin"` = under test, `"previous"` = compare-against). `.slug` is the plugin directory it installs as (no edition branching); `.zipPath` feeds `stageAndInstallPlugin`. **Throws** if the role is unsupported for the product or the artifacts setup did not run — see [plugin-artifacts.md](../architecture/plugin-artifacts.md). |
| `releaseBoundSite` | worker | Automatic, nothing to call: after the worker's last scenario it removes the site's staging area and closes SSH connections, best-effort ([teardown](../architecture/wordpress-automation.md#worker-teardown-wpteardownts)). |
| `baseURL`   | (override) | Points at the bound site, so relative navigations target it.                                                  |
| `storageState` | (override) | The bound site's saved login, **or** an empty session for `@noauth` scenarios.                            |
| device options | (override) | `viewport` / `userAgent` / `isMobile` / `hasTouch` / `deviceScaleFactor`: the `@mobile` profile, else the project's desktop default. |

Use `site.transport` to drive the WordPress automation layer, and `page` (the
standard Playwright fixture) for browser interaction. To install the zip under test,
pass `pluginArtifact("plugin").zipPath` to
[`stageAndInstallPlugin`](../architecture/wordpress-automation.md#site-staging--file-transfer-wpstagingts)
(via `site.transport`); the artifacts setup has already built and verified it.

```ts
await stageAndInstallPlugin(site.transport, pluginArtifact("plugin").zipPath, {
  activate: true,
});
```

> **`zipPath` is a path on the _runner_.** Passing it straight to `installPlugin`
> works only for a `local` transport, which shares the filesystem with the site. On
> `ssh`/`docker` the remote `wp` cannot see it, so the artifact must be copied onto
> the target first — which is exactly what `stageAndInstallPlugin` does (and
> `stageArtifact` for non-plugin files).

## Tags

| Tag         | Effect                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `@noauth`   | Scenario starts unauthenticated with an empty session (login/logout flows). The only tag that runs against placeholder sites, so it is what CI's smoke job greps. |
| `@plugin`   | The plugin under test is freshly installed + activated before the scenario, `debug.log` is scoped to it and **a PHP fatal fails it**, and the plugin is removed after. Needs a real site. |
| `@mobile`   | Runs under the mobile device profile (viewport + `isMobile` + `hasTouch` + mobile UA + DPR). Untagged scenarios stay desktop. |
| `@smoke`    | Scaffolding/smoke scenarios; run with `--grep @smoke`.                                           |
| `@free` / `@pro` | Edition scoping. An edition-ful cell auto-filters: a `pro` cell skips `@free` and vice-versa. |
| `@visual`   | Visual-regression scenarios; group with `--grep @visual` and run in the Playwright container.    |

`@plugin` and `@mobile` are both implemented in shared code, not per product — see
[CLAUDE.md → Shared scenario hooks](../../CLAUDE.md#shared-scenario-hooks) and
[Device profiles](../../CLAUDE.md#device-profiles-desktop--mobile).

```gherkin
@plugin
Scenario: A backup lands in the history
  # the plugin is already installed, active and logging into a clean debug.log here
```

## Page Object Model

UI interactions belong in page objects under `src/common/pages/`, not inline in
steps. [`PluginsPage`](../../src/common/pages/plugins.page.ts) is the reference:
it owns the wp-admin Plugins screen and exposes `goto`, `isInstalled`, `isActive`,
`activate`, `deactivate`, `delete` (the asserted UI flow), and `ensureAbsent`
(idempotent cleanup). Methods throw the typed errors from
[`wp/errors.ts`](../../src/common/wp/errors.ts) on failure.

## Adding a scenario — checklist

1. Write the `.feature` file under `src/projects/<product>/features/`. Tag it `@plugin` if
   it needs the plugin under test installed (almost all do), `@noauth` only if it needs no
   WordPress at all — that is the subset CI can run.
2. Implement any new steps in `src/projects/<product>/steps/` (or `common/steps/`
   if truly generic), importing `Given`/`When`/`Then` from `fixtures.ts`. A `@plugin`
   scenario's `Background` already runs with the plugin installed and active — hooks run
   before it.
3. Put UI logic in a page object under `common/pages/`; use `wp/` modules for
   WP-CLI work via `site.transport`.
4. Document every new function/method with TSDoc; type everything explicitly.
5. Run the quality gates (typecheck, lint, format, unit tests) — see
   [CLAUDE.md](../../CLAUDE.md#required-workflow-after-every-edit).
6. Verify against a real cell: `npm run test:<product> -- --project=<cell>`.

## Banned waits (enforced by lint)

`waitForTimeout`, `waitForLoadState("networkidle")`, `waitForSelector` and `.type()` are
lint errors in features' supporting code (`src/projects/**`, `src/common/{pages,steps,hooks}/**`).
Each message names the replacement — a web-first `expect()`, a specific
`page.waitForResponse(…)`, or `fill()`. See
[CLAUDE.md → Improvement gate](../../CLAUDE.md#improvement-gate-lint).

## Unit / integration tests

Files matching `*.spec.ts` anywhere under `src/` are unit tests run by
`npm run test:unit` (config: [`playwright.unit.config.ts`](../../playwright.unit.config.ts))
— the shared `common/` layer **and** each product's own specs, so a product page object's
locator contract is covered by the same command. They run with **no external
environment**: the WP-CLI layer is exercised through a stub `wp` on `PATH`, and page
objects against `page.setContent()` fixtures. They are kept separate from the BDD product
configs, whose generated specs live in `.features-gen/` (outside `src/`). Add a
`*.spec.ts` next to any non-trivial module you add.
