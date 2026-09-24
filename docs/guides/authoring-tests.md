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
    └── support/                     # debug-log presets, REST barriers, WP-CLI readers (arranging)
                                     #   and the CLI runner for when the command is under test
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

It also adds **`cli`**, which is not a page object either: it runs one `wp backwpup …` subcommand
and remembers the result, so the assertion in the next step has something to judge
([`support/cli-session.ts`](../../src/projects/backwpup/support/cli-session.ts)). It is for the
feature where the **command is the system under test** — there a non-zero exit is an observation,
not a broken arrangement, so nothing throws for an outcome and a scenario can assert how a command
refused. Use `support/backups.ts` instead when WP-CLI is only *arranging* or *checking* a site;
that one does throw, because there a failing command means the setup broke.

The CLI steps ([`steps/cli.steps.ts`](../../src/projects/backwpup/steps/cli.steps.ts)) are
deliberately generic, because for that feature the command line *is* the product language:

```gherkin
When I run the BackWPup command "job --format=count"
Then the command succeeds
And it prints "1"
```

`Then the command fails` and `Then it reports the error "…"` / `the warning "…"` / `the success "…"`
complete the set; the last three match WP-CLI's own `Success:` / `Warning:` / `Error:` status lines
by **level**, and
the given text as a substring of the message — a refusal WP-CLI spreads over several lines on
stderr (`Parameter errors:`, then the parameter it rejected) is one message. Three rules the step
text has to respect, each refused rather than run:

- the `wp backwpup` prefix is supplied for you, so it is not repeated;
- arguments are split on whitespace, so a value that needs quoting or escaping needs a step of its
  own;
- WP-CLI globals that decide *where* the command runs (`--path`, `--url`, `--ssh`, `--user`,
  `--skip-plugins`, `--exec`, …) are left out — WP-CLI honours them anywhere on the line, and the
  runner already runs the command on the scenario's own site. `--debug`, `--quiet` and
  `--[no-]color` only change the output, so they are allowed.

A command cannot spell out what the plugin allocates or names itself — a job's id, an archive's or a
log's file name — so it names it in braces, and the value is read when the command runs
([`support/placeholders.ts`](../../src/projects/backwpup/support/placeholders.ts)): `{job}` is the
scheduled job's id; `{oldest backup}` / `{newest backup}` the archive of the first / latest backup
the scenario made, fixed as they were made; `{oldest log}` / `{newest log}` the log of the first /
latest run the backup history records; `{download folder}` a folder of the scenario's own on the
site, relative to the directory WP-CLI runs in (the WordPress root); and `{path from the log folder
to the marker file}` a path out of BackWPup's log folder to the `markers` fixture's file, proved on
the site to lead there. So `When I run the BackWPup command "backup-delete {oldest backup} --yes"`
sends one real file name. Each value is asked for only when a command uses it, and must fit in one
argument. Whatever sits in braces is read as a placeholder's name, so one no step knows — `{job_id}`
for `{job}` — is refused, naming the ones it does, and so is a stray brace. And the text as written
may not name a path off the site, absolute or climbing out with `..`: a slip there would reach
another site's files, so a path that must reach further comes from a placeholder the suite proves.
A command that **blocks** on a running job, as `status`
does, runs through `When I watch the running backup with the BackWPup command "…"`, which gives it a
backup's length as a budget of its own and fails naming the command if it never answers.

A step that needs a second opinion reads it from a source the command has no hand in — the stored
jobs (`support/job-options.ts`), the plugin's backup history table (`support/history.ts`), or the
resolved zip — never from the same command in another format.

**`Then the command succeeds` only proves exit 0, and for a command that changes the site that is
not success.** WP-CLI itself is honest — its refusals and `WP_CLI::error()` exit 1 — but some of
BackWPup's commands exit 0 after failing: a foreground `run` never reaches its own verdict at all
(the job ends the WP-CLI process itself, whatever it logged), `run <id> --background` reports success
for a job id the site does not have, a `restore` that failed midway warns, a `log-delete` refused a
log it may not write still reports success, and plugin code that stops with PHP's `exit( 'message' )`
prints no status line at all. A destructive command run **without `--yes`** stops at a `[y/n]`
prompt nobody answers and ends at exit 0 having done nothing (`Then it asks "…"` asserts the
prompt). The other direction fails too: after one refused `backup-delete`, the next one deletes its
archive and still exits 1 with the earlier error. So always pair either step with a check against a
second source (the history row, the log, the marker, the file on disk), and assert a refusal the
way the command actually makes it — `Then it reports the warning "…"` where it only warns.
The cases, and which of them are measured live, are §2.16–§2.19 of the
[feature-porting plan](../plans/phase-6-feature-porting-plan.md).

**A job that must still be running when the next command arrives needs arranging.** A database
backup of the cells finishes in about a second — less than one WP-CLI round trip — so
[`cli-running-job.feature`](../../src/projects/backwpup/features/cli-running-job.feature) sets two
of BackWPup's own settings first (`Given BackWPup's "…" setting is "…"`, which refuses a value the
Settings screen does not offer): **Reduce server load** at `maximum` stretches the run to several
seconds, and a **Maximum number script execution time (in seconds)** — the screen's own words — of
`0` keeps it in one request, since the plugin otherwise hands a long run to a fresh request midway
and a command landing in that handover is answered about a job that is briefly not there.

Two more fixtures serve the commands that act on files. **`archives`** records the digest of every
archive a scenario's backups left, the moment they were made, so "still on the site, byte for byte"
compares against the run's own output and "the oldest backup" means one file for the rest of the
scenario — the steps that make backups (`Given the scheduled job has made 2 backups inside WP-CLI`,
or `… through the web server`, which decides who owns the files) record into it. **`downloads`** is
a folder of the scenario's own inside the site's staging area, for `backup-download` to write into.
It is created private to the transport's user, because the web server serves anything it can read
there and the copy is a whole database, and handed to the command by a path worked out on the site
from where the folder and WP-CLI really are — so a symlink on the way cannot send the copy elsewhere.
It costs nothing until a step uses it, and is removed after the scenario only if one did
([`support/archive-snapshot.ts`](../../src/projects/backwpup/support/archive-snapshot.ts),
[`support/download-folder.ts`](../../src/projects/backwpup/support/download-folder.ts)).

The last fixture behaves like none of the others: **`markers`** plants a random value in a file
under the site's content directory and another in a `wp_options` row, so a scenario can ask an
archive whether a backup really captured the site — or, since the file sits outside every BackWPup
folder, ask a log command handed a path out of its own folder whether it reached that file
([`support/markers.ts`](../../src/projects/backwpup/support/markers.ts)). Two things follow from it
touching the site rather than the page:

- **Requesting it is the side effect.** The values are planted when the fixture is first resolved —
  which Playwright does before the test body, so they are in place before any step runs — and
  removed in its teardown, best-effort. "Pays only for what it destructures" therefore means
  something stronger here: destructuring it *changes the site*.
- **It must be resolved before the backup under inspection.** A marker planted after a run cannot be
  in that run's archive, and an assertion looking for it would fail for the wrong reason.

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
| `@plugin`   | The plugin under test is freshly installed + activated before the scenario, `debug.log` is scoped to it and **a PHP fatal fails it**, and afterwards — once anything it left running has been stopped (`ProductConfig.stopRunningWork`) — the plugin is removed along with *the files and the database rows it left behind*. "Freshly" is load-bearing: a site whose plugin directory went without its `uninstall.php` ever running still carries that plugin's options and tables, and those are swept before the install rather than installed on top of. Needs a real site. |
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

## Asserting rendered state after an action

A `toHaveCount`/`toBeVisible` assertion carries its own timeout, so pointing one at a screen
that has not caught up yet does not fail — it **waits**, and then passes or flakes depending on
the day. That is a banned wait wearing an assertion's clothes, and the lint gate cannot see it.

So: after an action changes something on the site, assert against DOM the **server** produced,
not the DOM the action left behind. Re-read it (a reload, or the page object's own `reload()`),
and wait on a signal that can only mean the new data arrived — a placeholder the server always
renders and only the fetched rows replace, say. Awaiting the fetch itself is usually weaker than
it looks: a barrier armed before a navigation can settle on the *previous* page's request, and
one armed after it can miss the response entirely.

The tell is an assertion whose correctness argument is a measured margin ("the row lands about a
second before the budget runs out"). That is a race, not a check.

## Unit / integration tests

Files matching `*.spec.ts` anywhere under `src/` are unit tests run by
`npm run test:unit` (config: [`playwright.unit.config.ts`](../../playwright.unit.config.ts))
— the shared `common/` layer **and** each product's own specs, so a product page object's
locator contract is covered by the same command. They run with **no external
environment**: the WP-CLI layer is exercised through a stub `wp` on `PATH`, and page
objects against `page.setContent()` fixtures. They are kept separate from the BDD product
configs, whose generated specs live in `.features-gen/` (outside `src/`). Add a
`*.spec.ts` next to any non-trivial module you add.
