# Phase 6 — Feature porting: BackWPup first

> **Status:** planned. **Date:** 2026-07-28.
> **Parent:** [e2e-modernization-plan.md](e2e-modernization-plan.md) §9, Phase 6 — this doc supersedes
> that phase's summary. Phases 0–5 are done; Phase 6 is **feature content on finished rails**.
> **Baseline (reference only):** `wp-rocket-e2e/src/backwpup/` — 12 feature files, 28 scenarios, ~1.6k LoC.

## TL;DR

Phase 6 splits into **nine sub-phases**. **6A** lands the shared rails every product needs (plugin
install/cleanup hooks, the debug-log gate, `@mobile`, an anti-pattern lint gate). **6B–6I** port
BackWPup — **page objects first (6B)**, then onboarding → backup & history → plugin deletion →
WP-CLI → restore → external storages → Free-edition coverage + the parity gate. WP Rocket reuses 6A
and gets its own breakdown afterwards (§6).

Every artifact follows **Understand → Improve → Adapt → Port** (§1): read the baseline for *intent*,
verify the plugin's real contract in source, pick the strongest signal Playwright/WP-CLI offers, then
write it on the target's rails. **Nothing is copied.**

Verifying against **BackWPup 5.7.4 Free + Pro** (APVM release cache) already changed the plan four
ways: Free and Pro ship **byte-identical UI templates**; **five of six** baseline storage suites are
**not Pro-only**, so they run on both editions (coverage roughly doubles for free); the baseline's
WP-CLI step calls **`wp backwpup jobs`**, which 5.7.4 does not register (the command is `job`); and
the **restore journey genuinely diverges** — Pro restores in place from the archive already in
`wp-content/uploads/backwpup/…`, Free forces a manual re-upload of that same file (V13). That last
one is the single place the port needs per-edition scenarios and an edition-aware page object.

---

## 1. Method — Understand → Improve → Adapt → Port

Applied per scenario and per page object, in this order:

1. **Understand** — what does the baseline scenario *assert*? Extract the intent, discard the
   mechanics. Then read the plugin source for the real contract (markup, REST route, CLI command,
   option). The baseline is a **statement of intent, never a specification**.
2. **Improve** — pick the strongest available signal: a role/label locator over a CSS chain, a REST
   response barrier over `networkidle`, WP-CLI structured output over DOM scraping, a seeded option
   over re-driving a wizard. Delete every fixed sleep.
3. **Adapt** — fit the target's rails: fixtures (`site`, `edition`, `pluginArtifact`), POM-as-fixture,
   the transport layer, per-cell editions, tags.
4. **Port** — write the feature + thin steps, add the POM locator spec, run green on a real cell.

**Rule:** a step that cannot state its assertion in one sentence of product language is not ported
yet — it is transliterated. Selectors never appear in Gherkin.

### 1.1 Anti-pattern → replacement

Each row is a defect present in the baseline BackWPup suite and how the port removes it.

| Baseline pattern | Where | Target replacement |
| --- | --- | --- |
| `waitForLoadState("networkidle")` after nearly every action | `steps/general.ts`, `utils/helpers.ts` | Web-first `expect()` auto-retry; `page.waitForResponse(…/backwpup/v1/<route>…)` where a REST call **is** the completion signal (§2.2). |
| `waitForTimeout(500 / 2000 / 180000)` | `onboarding.ts`, `utils/storage.ts`, `general.ts` | Deleted. The 3-minute schedule sleep → `wp cron event run backwpup_cron` (§2.2). |
| `page.waitForSelector(sel, { state })` | throughout | `await expect(locator).toBeVisible() / toBeHidden()`. |
| `isChecked()` → `if` → `click()` | `onboarding.ts` | `locator.setChecked(v)` + `expect(locator).toBeChecked()`. |
| `td:nth-child(n)` + counting `<td>`s to sniff the plugin version's table layout | `general.ts` `captureBackupTableData` | `tr[data-backup-id]` rows (stable id, §2.2); `expect(rows).toHaveCount(n)`; failure via the failed-row branch; ground truth from `wp backwpup backup --format=json`. |
| `for (i < count) { expect(nth(i)) }` | `onboarding.ts` `validateCheckboxSelection` | `expect(boxes).toHaveCount(n)` + a filtered "none unchecked" assertion — one retrying assertion, not N. |
| Raw CSS passed through Gherkin (`I click '.js-backwpup-onboarding-step-2' button`) | `onboarding.feature` and every storage feature | Intent-level steps (`When I continue to the schedule step`). |
| `page.type()` (deprecated) | `storage.ts` `setupMSAzure` | `locator.fill()`. |
| Per-scenario UI login (`Given I am logged in` in every Background) | all features | `storageState` — already in place; the step disappears. |
| `catch { console.log(...) }` swallowing real failures | `helpers.ts` `waitForBackupJobCompletion`, `hooks.ts` | Typed errors from `wp/errors.ts`. Best-effort is permitted **only** in teardown, and is logged. |
| Mutable `this.initialBackups` on the Cucumber World | `general.ts` | Scenario-scoped fixture; prefer absolute assertions from a known-clean state. |
| `Date.now()` in a storage folder name | `storage.ts` `setupFTP` | Derive from `testInfo` — unique per test, reproducible, and traceable back to the scenario. |
| Cleanup by SSH `rm` glob into the site's uploads dir | `support/hooks.ts` | WP-CLI + the transport layer; `cleanSiteStaging` for our own staging. |
| `@bwpup @bwpupsetup @bwpupsmoke @bwpupbackup` on every feature | all features | The product **is** the config, not a tag. Only behavioural tags survive (§3.3). |

---

## 2. What the baseline is, and what the plugin actually does

### 2.1 Baseline inventory (28 scenarios)

| Baseline feature | Sc. | Intent | Ported in |
| --- | --- | --- | --- |
| `onboarding.feature` | 6 | Data selection, frequency (simple + advanced), storage step, per-type job cards | 6C |
| `backup.feature` | 2 | Manual "Backup now"; scheduled job produces a backup | 6C, 6D |
| `download-restore.feature` | 1 | Download the first backup from history | 6D |
| `delete-plugin.feature` | 3 | Delete the plugin after install / after activate / after first backup | 6E |
| `wp-cli/list-jobs.feature` | 2 | Job count via WP-CLI | 6F |
| `wp-cli/restore.feature` | 3 | **Untracked WIP — does not restore**; the three scenarios only re-run onboarding | 6G (written properly) |
| `storages/{ftp,s3,glacier,msazure,rsc,sugarsync}.feature` | 11 | Configure storage in onboarding and from the dashboard; back up to it | 6H |

Not covered by the baseline at all: Free edition (every scenario installs `backwpup-pro`), backup
deletion, bulk actions, job logs, settings, encryption, job import/export.

### 2.2 Verified plugin facts that change the port

Verified by reading **BackWPup 5.7.4 Free and Pro** (`~/.apvm/cache/backwpup/releases/5.7.4/`).

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V1 | Free and Pro ship **byte-identical** `components/`, `pages/` and `parts/` | `diff -rq` — no differences | **One POM set for both editions.** Templates are shared; what differs is the **runtime data** poured into them (V2, V13). The §4.5 strategy factory is needed in exactly one place — the restore entry path (V13). |
| V2 | Pro-only storages are exactly **GDRIVE, GLACIER, HIDRIVE, ONEDRIVE**; Free renders them as locked upsells (`li.js-backwpup-locked-storage`) | `components/storage-list.php` (`$locked_pro_slugs`, gated on `BackWPup::is_pro()`) | Of the baseline's six storage suites only **Glacier** is `@pro`. FTP, S3, MS Azure, Rackspace, SugarSync are **untagged** → run on Free *and* Pro. |
| V3 | WP-CLI exists in **Free too**; the job command is **`wp backwpup job`** (singular) | `src/Cli/Commands/Job.php::get_name()` → `'job'`; `Subscriber.php` registers `backwpup <name>` | The baseline's `wp backwpup jobs` does not exist in 5.7.4. WP-CLI scenarios are **untagged**, not `@pro`. |
| V4 | Pro-only CLI: `restore`, `backup-encrypt`, `backup-decrypt`, `job-export`, `job-import` | `src/Cli/Commands/` present in Pro only | These are the genuine `@pro` CLI scenarios. |
| V5 | `wp backwpup backup --format=json` and `wp backwpup job --format=json` return structured records | command docblocks (`AVAILABLE FIELDS`) | **Structured ground truth** replaces DOM table scraping for counts, storage and type. |
| V6 | History rows carry `<tr data-backup-id="…">`; failed/aborted rows render a **distinct branch** (`.backwpup-failure-icon`, `"%s backup failed – %s"`) | `components/table-row-backups.php` | Kills the baseline's positional `nth-child` + `<td>`-counting layout sniffing outright. |
| V7 | Buttons come from one component: `trigger` → class `js-backwpup-<trigger>`; `label` → `<span>` text = **accessible name**. `icon_position: "alone"` renders **no** label | `components/form/button.php` | Role/label locators work for labelled buttons; **icon-only buttons have no accessible name** and must use the `js-backwpup-*` / `data-content` hook (§3.2). |
| V8 | 21 REST routes under `backwpup/v1` — incl. `startbackup`, `job-abort-status`, `save_job_settings`, `save_excluded_tables`, `save_files_exclusions`, `cloudsaveandtest`, `getblock`, `getjobslist`, `backups`, `process_bulk_actions` | `register_rest_route` calls across `src/**/API/Rest.php` | Precise `waitForResponse` barriers replace `networkidle`. |
| V9 | Scheduling uses the WP-Cron hook **`backwpup_cron`** with `['arg' => <job_id>]` | `inc/class-cron.php`, `inc/class-page-onboarding.php:146` | `wp cron event run backwpup_cron` ("runs the next scheduled cron event for the given hook", WP-CLI handbook) fires it deterministically → the 3-minute sleep goes away and the assertion gets *stronger* (schedule registered **and** it produces a backup). |
| V10 | The site option **`backwpup_onboarding`** decides whether `page=backwpup` renders the wizard or the dashboard; onboarding completion deletes it | `inc/class-admin.php:272`, `class-page-onboarding.php:174`, `components/storage-list.php:24` | Scenarios needing a post-onboarding dashboard **seed the state** via WP-CLI instead of re-driving the wizard (single-site: `wp option`; multisite would need `wp site option`). |
| V11 | Restore **UI** exists in both editions (`admin.php?page=backwpuprestore`, `pages/restore.php`); Pro additionally ships `backwpup-restore.zip` and the `restore` CLI | `inc/class-admin.php:766` in both; Pro-only files | The restore *page* is shared, but the journey that reaches it is not (V13). **CLI restore is `@pro`**. |
| V13 | **The restore entry path diverges by edition, via one runtime flag in shared code.** The history row's Restore action uses `dataset-restore['data-url']`, which is a deep link (`…&action=restore-destination_<service>&restore_file=<uploads>/…`) **only if the backup record carries `restoreurl`** — otherwise it falls through to a bare `admin.php?page=backwpuprestore`. The base `BackWPup_Destinations::file_get_list()` stamps `restoreurl` **only when `BackWPup::is_pro()`** (and the service is not OneDrive); Pro further overrides the local **Website Server (`FOLDER`)** destination to point `restore_file` at the archive already on disk. | `inc/class-destinations.php:205-209` — the `is_pro()` gate, in a file **byte-identical in both editions**; `inc/Pro/class-destinations.php:49-73`; `inc/Pro/class-destination-folder.php:184`; `inc/Utils/BackWPupHelpers.php:196-214` (the deep-link vs bare-page branch) | **Pro restores in place** from `wp-content/uploads/backwpup/…`; **Free forces a manual re-upload of that same file** even though it is already on the server. Two genuinely different user journeys ⇒ separate `@pro`/`@free` scenarios sharing a Background, and the one edition-aware POM branch (§4.6G). **Two exceptions to keep out of the scenarios:** SugarSync sets `restoreurl` in its own override (identical in both editions, so Free *can* deep-link there), and OneDrive is excluded even in Pro. Scenarios use the Website Server destination, where the divergence is clean. |
| V12 | Admin pages: `backwpup`, `backwpupbackups`, `backwpupjobs`, `backwpupeditjob`, `backwpuplogs`, `backwpupsettings`, `backwpuprestore`, `backwpupabout`, `backwpupfirstbackup`, `backwpupdocs`; Pro adds `backwpupsupport` | `inc/class-admin.php`, `inc/Pro/class-pro.php` | The URL surface each POM owns. |

> **Version caveat.** These facts are verified at **5.7.4**; cells build `develop` by default. 6B
> therefore ships a **locator-contract spec** (§4.6B) so a markup change fails as one clear unit-test
> failure instead of a scattered scenario collapse. No locator is written without re-checking it
> against the ref under test.

---

## 3. Coverage & tagging decisions

### 3.1 Editions

Baseline coverage is **Pro-only**. Target default: **untagged** (both editions). Tag only where the
product genuinely differs:

| Tag | Scenarios |
| --- | --- |
| *(none)* | Onboarding, backup, history, download, delete, plugin lifecycle, WP-CLI job/backup/run/status, FTP/S3/MS Azure/Rackspace/SugarSync storages |
| `@pro` | Glacier storage; **restore from the backup history** (in-place, V13); CLI `restore`, `backup-encrypt`/`-decrypt`, `job-export`/`-import` |
| `@free` | Locked Pro-storage upsell rendering (`js-backwpup-locked-storage`) (V2); **restore by manual upload** (V13) |

Filtering is already automatic per cell (`editionFilter`); 6I only adds the `free@…` cell.

### 3.2 Locator policy (in precedence order)

1. `getByRole` / `getByLabel` with the visible name (V7) — the default.
2. The plugin's own **JS contract hooks** — `js-backwpup-<trigger>`, `data-content`,
   `data-backup-id`, `data-job-id`, `data-storage`. These are stable *by construction*: the plugin's
   own JavaScript binds to them.
3. **Never** structural CSS (`td:nth-child`, `header:has(h1:has-text(…)) button.…`) or text matching
   on a whole subtree.

Rule 1 assumes an English admin. The auth setup's pre-flight gains one assertion that the site locale
is English, so a locale mismatch fails once with a clear message rather than as N locator timeouts.

### 3.3 Tags kept

`@smoke`, `@free`/`@pro`, `@noauth`, `@visual`, `@mobile`, plus `@storage` and `@slow` (jobs that
really do take minutes — lets CI split fast from slow). The `@bwpup*` family is dropped: the product
is the config file, not a tag.

---

## 4. Sub-phases

Each is independently shippable and ends with the standard gates (typecheck / lint / format /
`test:unit`) plus a green real-cell run. 6A is a prerequisite for everything; 6C–6H are otherwise
independent of each other and can be reordered by need.

### 6A — Shared rails *(product-agnostic; unblocks BackWPup **and** WP Rocket)*

**Deliverables**

- `src/common/hooks/plugin.hooks.ts` — tag-scoped lifecycle:
  - `Before`: `clearDebugLog` → `ensurePluginAbsent(slug)` →
    `stageAndInstallPlugin(site.transport, pluginArtifact("plugin").zipPath, { activate: true })`.
  - `After`: `scanDebugLog` with the product preset — attach on failure, **fail the scenario on a
    fatal** — then `ensurePluginAbsent(slug)`.
  - Both products' `steps` globs must be extended to load `src/common/hooks/**/*.ts`; a hook file
    outside the glob registers **silently** (the known playwright-bdd pitfall).
- **`slug` on `ResolvedArtifact`.** The hook must not hard-code `backwpup-pro`. The identity preflight
  already knows the slug per edition, so add it to `ResolvedArtifact` → `resolution.json` → available
  as `pluginArtifact("plugin").slug`. Small additive change: `artifacts/types.ts`, `resolve.ts`,
  `verify.ts`, `consume.ts` (+ specs).
- **Worker teardown** — `cleanSiteStaging` beside `disposeConnections`, best-effort, never fails a
  passing scenario.
- **`@mobile` device profile** (parent §7.7) — a `$tags`-driven `use` override applying a
  `devices[...]` preset (viewport + `isMobile` + `hasTouch` + UA + `deviceScaleFactor`). Needed by WP
  Rocket; BackWPup has no mobile scenarios yet.
- **Improvement gate** — an ESLint `no-restricted-syntax` rule over `src/projects/**` and
  `src/common/pages/**` banning `waitForTimeout`, `waitForLoadState("networkidle")`,
  `waitForSelector`, and `page.type`. The §1.1 table stops being a promise and becomes CI.
- **Unit config reach** — `playwright.unit.config.ts` `testDir` `"src/common"` → `"src"`, so product
  POM specs actually run (generated BDD specs live in `.features-gen/`, so this stays safe).

**Acceptance** — a scenario tagged for the plugin lifecycle installs its cell's edition over **`ssh`
and `docker`** (not only `local`); a re-run leaves no `.e2e_temp` on the site; a seeded PHP fatal
fails the scenario with the log attached; the lint gate rejects a deliberately re-introduced
`waitForTimeout`.

### 6B — BackWPup page objects *(the first content phase; no features yet)*

Builds the whole UI surface once, so 6C–6H are thin. POMs are plain classes under
`src/projects/backwpup/pages/`, registered as fixtures (parent §7.5 — no decorators).

| Page object | Owns |
| --- | --- |
| `OnboardingPage` | The 3-step wizard at `page=backwpup` while `backwpup_onboarding` is set (V10): data selection, frequency, storage, submit. |
| `DashboardPage` | Post-onboarding `page=backwpup`: job cards (`mixed`/`files`/`database`), next scheduled backup, "Backup now". |
| `DataSelectionSidebar` | Select-files / select-tables exclusion sidebars (`save_files_exclusions`, `save_excluded_tables`). |
| `FrequencySidebar` | Simple + advanced frequency, start time (`save_job_settings`). |
| `StorageSidebar` | Storage picker, locked-Pro list (V2), per-provider forms + "test connection" (`getblock`, `cloudsaveandtest`). |
| `JobRunModal` | Running-job progress, abort, close (`startbackup`, `job-abort-status`). |
| `BackupHistoryTable` | Rows keyed by `data-backup-id` (V6), per-row action menu (View log / Download / Restore / Delete), bulk actions. |
| `RestorePage` | `page=backwpuprestore` (V11) — the shared restore screen, **plus the two entry paths** of V13: `startFromHistory()` (Pro deep link) and `startByUpload(file)` (Free manual upload). |
| *(reused)* `PluginsPage` | Install / activate / delete via wp-admin — already exists in `common/pages/`. |

**Also**

- `support/rest.ts` — named REST barriers (V8) so no route string is inlined in a POM.
- `support/backups.ts` — `wp backwpup backup|job --format=json` readers typed against the documented
  fields (V5), giving every count/status assertion a ground truth independent of the DOM.
- **Locator-contract spec** — `pages/*.spec.ts` rendering captured markup through `page.setContent()`
  and asserting every locator resolves. This is the version-drift alarm (§2.2 caveat).

**Acceptance** — `npm run test:unit` covers every POM's locators; no POM contains a structural CSS
chain, a fixed sleep, or a `networkidle` wait; each method's completion signal is an assertion or a
named REST barrier.

### 6C — Onboarding & job configuration

Ports `onboarding.feature` (6) + the shared onboarding spine of every other baseline feature.
Scenarios: mixed / files-only / database-only data selection; simple frequency per type; advanced
frequency; exclusions are respected after save. Improvements: intent-level steps; `setChecked`;
`save_*` REST barriers; one retrying assertion for "all tables selected" instead of an N-iteration
loop; each scenario starts from a deterministic onboarding state seeded by WP-CLI (V10).

**Acceptance** — the 6 baseline scenarios pass on `pro@nginx` with no sleep and no `networkidle`;
each asserts the resulting job configuration through both the UI **and** `wp backwpup job
--format=json`.

### 6D — Backup lifecycle & history

Ports `backup.feature` (2) + `download-restore.feature` (1), and adds the deletion/bulk coverage the
baseline only ever performed as *cleanup*.

- Manual "Backup now" → job completes → exactly one new history row, no failed rows (V6 + V5).
- **Scheduled backup** → assert the schedule is registered, then `wp cron event run backwpup_cron`
  (V9) and assert the backup landed. Replaces a 3-minute sleep with a stronger assertion.
- Download the newest backup → assert filename + non-empty payload, saved under the test's
  `outputDir` (not a repo-root `temp/`).
- **New:** delete a single backup; bulk-delete via `process_bulk_actions`. Cleanup stops being the
  only exercise of a user-facing destructive flow.

**Acceptance** — history assertions agree between the DOM and `wp backwpup backup --format=json`; a
deliberately failed backup is detected via the failed-row branch, not a substring scan.

### 6E — Plugin lifecycle (UI)

Ports `delete-plugin.feature` (3): delete after install, after activate, after a first backup. Uses
the existing `PluginsPage.delete` (asserted flow, dialog handling, reload-and-re-assert) — the
baseline's hand-rolled duplicate is dropped. Adds the missing check that deletion removes the
plugin's data footprint (`wp option list` / uploads dir), which the baseline's `#backwpup-pro-deleted`
element never proved.

**Acceptance** — all three pass on both editions (the slug comes from the resolved artifact, 6A, so
`backwpup` vs `backwpup-pro` needs no branching).

### 6F — WP-CLI surface

Ports `wp-cli/list-jobs.feature` (2) and widens it to the commands that actually exist (V3/V4).

- Untagged: `job`, `backup`, `run`, `status`, `version`, `job-activate`, `backup-delete`,
  `backup-download`, `log` / `log-show` / `log-delete`.
- `@pro`: `job-export` / `job-import`, `backup-encrypt` / `backup-decrypt`.
- All through the existing `wpCli` transport layer (array args, `exitCode` branching) — no `ssh`
  preamble step, no ad-hoc JSON parsing per step.

**Acceptance** — the exact command names are re-verified against the ref under test before the steps
are written; a wrong command name fails as an explicit "command not registered" error, not an empty
list.

### 6G — Restore

Replaces the untracked WIP `wp-cli/restore.feature`, which asserts nothing about restoring.

**The entry path is edition-specific (V13)** — this is the one place §4.5's "separate scenarios
sharing a Background" pattern genuinely applies, and the only edition-aware POM branch in the port.
A shared Background produces the backup and mutates a known marker (an option row **and** a file);
each edition then reaches the restore screen its own way and both assert the marker is back:

```gherkin
Background:                                     # shared — both editions
  Given a completed backup stored on the website server
  And the site has drifted since that backup

@pro
Scenario: Restore in place from the backup history
  When I restore that backup from the backup history   # deep link; archive already in uploads
  Then the site matches the backup

@free
Scenario: Restore by uploading the backup file
  Given I have downloaded that backup                  # forced re-upload of a file already on the server
  When I upload it and restore
  Then the site matches the backup
```

- The **`@pro`** path must additionally assert what makes it Pro: the flow never asks for a file, and
  the archive it unpacks is the existing `wp-content/uploads/backwpup/…` copy (V13).
- The **`@free`** path must assert the inverse — the history action lands on the bare restore page
  with no `restore_file`, so an upload is unavoidable. That negative assertion is what stops a future
  regression from silently downgrading Pro to the Free journey.
- **Restore scope** (full / database-only / files-only) is orthogonal to entry path — cover it once,
  on the cheaper `@pro` in-place path, rather than multiplying both journeys by three.
- **CLI restore** (`@pro`, V4): `wp backwpup restore <file> --yes --type=full|db|file`, with
  `--pre-backup` on one scenario.
- Tag `@slow`; a restore rewrites the site, so it must run on a worker-bound site and re-authenticate
  afterwards if the restore rolls the session back.

**Acceptance** — a restore scenario **fails** if the marker is not restored (the property the
baseline never had); each edition's scenario fails if it is served the *other* edition's entry path.

### 6H — External storages *(last: needs credentials)*

Ports the 11 storage scenarios, re-tagged per V2.

- **Config** — extend `ServiceConfig.storage` beyond today's `ftp` + `s3` with typed `msazure`,
  `sugarsync`, `rsc`, `glacier` (incl. its `useS3Credentials` fallback), each with `.env.example`
  entries, load-time validation, and per-site `overrides` support (already supported generically).
- **Isolation** — each scenario writes to a path/container derived from `testInfo`, so parallel
  workers and repeat runs never see each other's artifacts.
- **Out of scope, stated:** Dropbox, Google Drive, OneDrive, HiDrive — interactive OAuth, no baseline
  coverage, no non-interactive credential path.
- **Teardown** — remote cleanup is best-effort and logged; it never fails a passing scenario.

**Acceptance** — each provider passes "configure in onboarding" and "configure from dashboard";
skipped with a clear reason when its credentials are absent, never failed.

### 6I — Free edition + parity gate

- Add a `free@…` cell to `src/projects/backwpup/config/sites.json` — everything untagged then runs on
  Free with **zero** new scenario code (V1).
- Add the `@free` locked-storage upsell scenario (V2).
- **Parity review** against §2.1: every baseline intent is covered or has a written, deliberate
  reason not to be. A checklist in the PR — not a claim.

**Acceptance** — both cells green; the parity checklist is complete; no scenario is a
transliteration of its baseline ancestor.

---

## 5. Definition of done (phase-level)

- Every §2.1 intent is ported, superseded, or explicitly declined in writing.
- Both `pro@…` and `free@…` cells green; `@pro`/`@free` scenarios run only on their edition's cells.
- The 6A lint gate is green — no `waitForTimeout` / `networkidle` / `waitForSelector` / `page.type`
  anywhere under `src/projects/**` or `src/common/pages/**`.
- Every POM has a locator-contract spec; `npm run test:unit` green.
- Docs updated by whoever changed the code: `authoring-tests.md` (new fixtures/POMs/tags),
  `configuration.md` (new storage service config), `CLAUDE.md` (fixtures table), `.env.example`.
- Parent plan §9 Phase 6 replaced by a pointer to this doc.

---

## 6. After BackWPup — WP Rocket

WP Rocket reuses **6A unchanged** and follows the same recipe: **page objects first**, then features.
Its baseline is much larger (`src/features/`, `src/specs/`, `src/support/steps/`, plus the 921-line
`page-utils.ts` and 486-line `sections.ts`) and brings concerns BackWPup does not: `@mobile` (6A),
settings export/import diffing, the `@visual` A/B scenarios (`expectOptimizedToMatchUnoptimized`,
already shipped), third-party plugin interactions, and the `previous` artifact role for update paths.
It gets its own sub-phase breakdown, written from the same verified-source discipline, once BackWPup
is done — deliberately **not** guessed here.

---

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Markup drift between 5.7.4 (verified) and `develop` (tested) | The 6B locator-contract spec turns drift into one clear unit-test failure; locators re-checked against the ref under test before any step is written. |
| Icon-only buttons have no accessible name (V7) | Documented as the one legitimate `js-backwpup-*` / `data-content` case in the §3.2 policy — not a silent exception. |
| Non-English admin breaks role/label locators | Pre-flight asserts the site locale; fails once, clearly. |
| Storage credentials missing / rate-limited | Scenarios **skip** (never fail) without credentials; per-site `overrides` exist for rate-limited hosts; `testInfo`-derived paths keep workers isolated. |
| Restore rewrites the site under test | `@slow`, worker-bound site, re-auth after restore, run last in its cell. |
| Backup jobs are genuinely slow | `@slow` for CI splitting; real barriers (`startbackup`, `job-abort-status`) instead of long fixed timeouts, so the wait is as short as the job allows. |
| Scope creep from "improve" | The improvement budget is §1.1 plus the V-facts. Anything else is a follow-up issue, not this phase. |

---

## 8. Verification sources

- **Baseline:** `wp-rocket-e2e/src/backwpup/**` (12 features, 28 scenarios), `utils/page-utils.ts`,
  `utils/commands.ts`, `config/wp.config.sample.ts` — read at `develop`, 2026-07-28.
- **Plugin:** BackWPup **5.7.4 Free and Pro**, unpacked from
  `~/.apvm/cache/backwpup/releases/5.7.4/` — `components/`, `pages/`, `parts/`, `inc/`, `src/Cli/`,
  `src/**/API/Rest.php`. All V-facts in §2.2 cite the file that proves them.
- **Target:** working tree at `develop` — `src/common/{fixtures,wp,artifacts,pages,visual}`,
  `src/projects/backwpup/`, `playwright.unit.config.ts`, `eslint.config.js`, `package.json`.
- **WP-CLI:** `wp cron event run <hook>` semantics — WP-CLI handbook, `commands/cron/event/run.md`.
