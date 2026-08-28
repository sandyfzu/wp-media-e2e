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
│   ├── fixtures.ts               # the base test instance + Given/When/Then exports
│   ├── steps/                    # generic steps (e.g. world.steps.ts)
│   ├── hooks/                    # shared scenario hooks (*.hooks.ts) + their policy modules
│   ├── pages/                    # cross-product page objects (e.g. plugins.page.ts)
│   ├── visual/                   # visual helpers (ab.ts, screenshot.ts, …)
│   ├── config/devices.ts         # desktop & @mobile device profiles
│   ├── artifacts/                # the plugin zips under test (see ../architecture/plugin-artifacts.md)
│   └── wp/                       # WordPress automation (see ../architecture/wordpress-automation.md)
└── projects/<product>/
    ├── config/<product>.config.ts   # ProductConfig + sites.json/sites.*.json/sites.example.json
    ├── fixtures.ts                  # this product's test instance: common's + its page objects
    ├── features/**/*.feature        # this product's scenarios
    ├── pages/**/*.ts                # this product's page objects (+ their locator specs)
    ├── steps/**/*.ts                # this product's steps
    └── support/                     # debug-log presets, REST barriers, WP-CLI readers
```

A product's `steps` array (in its config) is the exact set of files loaded at runtime:
`common/fixtures.ts` + that product's `fixtures.ts` + `common/hooks/**/*.hooks.ts` +
`common/steps/**` + that product's own `steps/**`. So a product-specific step is only
available to that product — and a **hook file missing from that array never registers**,
leaving its lifecycle silently absent rather than failing. Add new shared hooks as
`src/common/hooks/<name>.hooks.ts` so the existing glob picks them up.

## Fixtures ([`src/common/fixtures.ts`](../../src/common/fixtures.ts))

Import `Given`, `When`, `Then`, `Before`, `After`, etc. from a `fixtures.ts`
(**not** from `playwright-bdd` directly) — this binds them to the extended test
instance. Import from **your product's** `fixtures.ts` if it has one (BackWPup does), so
your steps can also destructure its page objects; import from `common/fixtures.ts` only
for genuinely product-agnostic steps and hooks.

The shared instance provides:

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

BackWPup's [`src/projects/backwpup/fixtures.ts`](../../src/projects/backwpup/fixtures.ts) adds its
page objects on top: `onboarding`, `firstBackup` (the screen onboarding hands over to, where its
first backup runs), `dashboard`, `dataSelection`, `frequency`, `storages`, `jobRun`,
`backupHistory`, `restore` (edition-aware — Pro's in-place restore vs Free's forced upload) and the
shared `plugins`. They are constructed lazily, so a scenario pays only for what it destructures.

Use `site.transport` to drive the WordPress automation layer, and `page` (the
standard Playwright fixture) for browser interaction. To install the zip under test,
pass `pluginArtifact("plugin").zipPath` to
[`stageAndInstallPlugin`](../architecture/wordpress-automation.md#site-staging--file-transfer-wpstagingts)
(via `site.transport`); the artifacts setup has already built and verified it.

```ts
const artifact = pluginArtifact("plugin");
await stageAndInstallPlugin(site.transport, artifact.zipPath, {
  activate: true,
  // Always pass the slug: it is what lets the install hand the plugin's files back to
  // the ownership the site uses, so the web server can write them.
  slug: artifact.slug,
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
| `@plugin`   | The plugin under test is freshly installed + activated before the scenario, `debug.log` is scoped to it and **a PHP fatal fails it**, and afterwards the plugin *and the files it left on the site* are removed. Needs a real site. |
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

UI interactions belong in page objects, not inline in steps: cross-product ones under
`src/common/pages/`, a product's own under `src/projects/<product>/pages/`.
[`PluginsPage`](../../src/common/pages/plugins.page.ts) is the shared reference: it owns the
wp-admin Plugins screen and exposes `goto`, `isInstalled`, `isActive`, `activate`,
`deactivate`, `delete` (the asserted UI flow), and `ensureAbsent` (idempotent cleanup).
Methods throw the typed errors from [`wp/errors.ts`](../../src/common/wp/errors.ts) on failure.

### Registering a product's page objects as fixtures

A product extends the shared test instance in its own `fixtures.ts`, so steps receive page
objects by destructuring — and `common/` never imports product code:

```ts
// src/projects/<product>/fixtures.ts
import { createBdd } from "playwright-bdd";
import { test as base } from "../../common/fixtures";
import { DashboardPage } from "./pages/dashboard.page";

export const test = base.extend<{ dashboard: DashboardPage }>({
  dashboard: async ({ page }, use) => { await use(new DashboardPage(page)); },
});
export const { Given, When, Then, Before, After } = createBdd(test);
```

Then list that file in the product's `steps` array and import `Given`/`When`/`Then` from it:

```ts
When("I start a backup", async ({ dashboard }) => { await dashboard.openBackupNow(); });
```

playwright-bdd picks, per scenario, the **most-extended** test instance among those its steps
were registered against — so product steps and common steps mix freely. If the product's
`fixtures.ts` is missing from `steps`, generation fails with "Can't guess test instance"
rather than silently dropping the page objects.

### Locator policy

1. `getByRole` / `getByLabel` with the visible name — the default.
2. The application's own **JS contract hooks** (for BackWPup: `js-backwpup-<trigger>`,
   `data-content`, `data-backup-id`, `data-job-id`, `data-storage`) when there is genuinely no
   accessible name — e.g. an icon-only button, or a visually-hidden `aria-hidden` checkbox. These
   are stable by construction: the application's own JavaScript binds to them.
3. **Never** structural CSS (`td:nth-child`, `header:has(h1) button.…`) or text matching on a
   whole subtree. The lint gate below and code review enforce this.

Rule 1 assumes an English admin, which the auth pre-flight asserts once per site
(`determine_locale()`), so a translated site fails with one clear message instead of many
locator timeouts.

Every non-trivial page object gets a **locator-contract spec**: capture the real rendered markup,
replay it, and assert each locator resolves. See
[`locator-contract.spec.ts`](../../src/projects/backwpup/pages/locator-contract.spec.ts). Capture
the fixture — never hand-write it — or the fixture drifts along with the page object and the two
agree with each other while the real page fails.

**Render captured markup through
[`renderFixture`](../../src/projects/backwpup/pages/__fixtures__/render.ts), not `page.setContent()`
directly.** A capture is verbatim, so it still references whatever the real page did — WordPress's
`s.w.org` emoji images, third-party provider links — and `setContent` waits for `load`, meaning _all
of them_. That makes the spec depend on the public internet and time out when it is slow, which is
exactly what happened. `renderFixture` aborts every request and waits for `domcontentloaded`, which
is the honest barrier for a spec asserting on parsed DOM. Hand-written markup with no external
references can still use `page.setContent()` directly.

## Naming scenarios

A `Scenario:` name is read in isolation far more often than in file order: it is what you
pass to `--grep` to run one scenario, what a report lists, and the headline of a failure in
CI. So it must describe its own behaviour and outcome completely, assuming no knowledge of
the scenarios around it.

- **No back-references.** No `…just the same`, `…too`, `…but with X`, `…same for Y`, and no
  pronoun (`them`, `it`, `that`) whose antecedent lives in a neighbouring title. If the name
  only makes sense after reading the scenario above it, rewrite it — a pronoun resolved
  _inside_ the same sentence is fine.
- **Name what varies.** When several scenarios cover one rule through different routes, each
  name states its own route _and_ the outcome, so the set reads as a list rather than a
  thread.
- **State the outcome, not the clicks.** The name is the rule being proven
  (`… splits them into two jobs`), not a summary of the steps.
- **Shared context goes elsewhere.** Why scenarios resemble each other, and any setup they
  share, belongs in the `Feature` description or the `Background` — never smuggled into a
  title as an implied "as above".

```gherkin
# ✗ meaningless on its own: "them" and "just the same" only resolve against the previous scenario
Scenario: The advanced schedule settings split them just the same

# ✓ names its own route and its own outcome
Scenario: Scheduling files and the database differently in the advanced settings splits them into two jobs
```

Length is not a reason to shorten past self-sufficiency — a long name that stands alone beats
a short one that needs a neighbour.

## Adding a scenario — checklist

1. Write the `.feature` file under `src/projects/<product>/features/`. Tag it `@plugin` if
   it needs the plugin under test installed (almost all do), `@noauth` only if it needs no
   WordPress at all — that is the subset CI can run.
2. Name each scenario so it reads standalone — see [Naming scenarios](#naming-scenarios).
3. Implement any new steps in `src/projects/<product>/steps/` (or `common/steps/`
   if truly generic), importing `Given`/`When`/`Then` from `fixtures.ts`. A `@plugin`
   scenario's `Background` already runs with the plugin installed and active — hooks run
   before it.
4. Put UI logic in a page object under `common/pages/`; use `wp/` modules for
   WP-CLI work via `site.transport`.
5. Document every new function/method with TSDoc; type everything explicitly.
6. Run the quality gates (typecheck, lint, format, unit tests) — see
   [CLAUDE.md](../../CLAUDE.md#required-workflow-after-every-edit).
7. Verify against a real cell: `npm run test:<product> -- --project=<cell>`.

## Banned waits (enforced by lint)

`waitForTimeout`, `waitForLoadState("networkidle")`, `waitForSelector` and `.type()` are
lint errors in features' supporting code (`src/projects/**`, `src/common/{pages,steps,hooks}/**`).
Each message names the replacement — a web-first `expect()`, a specific
`page.waitForResponse(…)`, or `fill()`. Only the *called* member matches, so a property that
happens to share a name (`describe(job.type)`) is fine. See
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
