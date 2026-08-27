# Phase 6 — Feature porting: BackWPup first

> **Status:** in progress — **6A, 6B and 6C are done** (verified on `pro@nginx`); 6D–6I planned;
> **6H.2 deferred** (needs storage credentials — see §4.6H.2).
> **Date:** 2026-07-28; revised 2026-07-30 (§2.3 re-verification at the ref; storage split),
> 2026-07-31 (§2.5 — post-implementation audit of 6B; four corrections, all verified live),
> 2026-08-05 (§2.6 — 6C shipped; seven further verified facts, three of them found by failing runs)
> and 2026-08-26 (§2.8 — **V28 refuted and its cause fixed**; Playwright upgraded to 1.62.1, the 6A
> `chromium.ts` workaround deleted, **6D unblocked**).
> **Parent:** [e2e-modernization-plan.md](e2e-modernization-plan.md) §9, Phase 6 — this doc supersedes
> that phase's summary. Phases 0–5 are done; Phase 6 is **feature content on finished rails**.
> **Baseline (reference only):** `wp-rocket-e2e/src/backwpup/` — 12 feature files, 28 scenarios, ~1.6k LoC.

## TL;DR

Phase 6 splits into **ten sub-phases**. **6A** lands the shared rails every product needs (plugin
install/cleanup hooks, the debug-log gate, `@mobile`, an anti-pattern lint gate). **6B–6I** port
BackWPup — **page objects first (6B)**, then onboarding → backup & history → plugin deletion →
WP-CLI → restore → the storage credential surface → Free-edition coverage + the parity gate. The
storage *round-trips* are carved out as **6H.2** and **deferred** until credentials exist, so no
other sub-phase waits on them. WP Rocket reuses 6A and gets its own breakdown afterwards (§6).

**Execution order:** 6A ✅ → 6B ✅ → 6C ✅ → **6D** → 6E → 6F → 6G → 6H → 6I → *(later)* 6H.2.

Every artifact follows **Understand → Improve → Adapt → Port** (§1): read the baseline for *intent*,
verify the plugin's real contract in source, pick the strongest signal Playwright/WP-CLI offers, then
write it on the target's rails. **Nothing is copied.**

Verifying against the plugin's own source — first **5.7.4 Free + Pro**, then re-verified against the
**exact ref under test** in both editions (§2.3) — changed the plan three ways: Free and Pro ship
**byte-identical UI templates**, so one POM set serves both; **five of six** baseline storage suites
are **not Pro-only**, so they run on both editions (coverage roughly doubles for free); and the
**restore journey genuinely diverges** — Pro restores in place from the archive already in
`wp-content/uploads/backwpup/…`, Free forces a manual re-upload of that same file (V13). That last
one is the single place the port needs per-edition scenarios and an edition-aware page object.

Three further claims were **corrected by re-verification** rather than confirmed, each recorded
inline in §2.2: `wp backwpup jobs` **does** exist (as an `@alias`, proven live — so the baseline was
not broken there, V3); onboarding is its **own page** reached by redirect, not a branch of
`page=backwpup` (V10); and the REST surface is **24 routes, not 21** (V8).

---

## 1. Method — Understand → Improve → Adapt → Port

Applied per scenario and per page object, in this order:

1. **Understand** — what does the baseline scenario *assert*? Extract the intent, discard the
   mechanics. Then read the plugin source for the real contract (markup, REST route, CLI command,
   option). The baseline is a **statement of intent, never a specification**.
2. **Improve** — pick the strongest available signal: a role/label locator over a CSS chain, a REST
   response barrier over `networkidle`, WP-CLI structured output over DOM scraping, a seeded option
   over re-driving onboarding. Delete every fixed sleep.
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
| `isChecked()` → `if` → `click()` | `onboarding.ts` | An **idempotent** helper that clicks only when the state differs and then asserts it: `pages/toggles.ts`. Not `setChecked()` — V16 found the plugin's checkboxes are `sr-only`, so Playwright cannot act on them directly and the click must land on their visible proxy. The retrying state assertion is what makes that safe. |
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
| `storages/{ftp,s3,glacier,msazure,rsc,sugarsync}.feature` | 11 | Configure storage in onboarding and from the dashboard; back up to it | **6H.2 (deferred)** |

Not covered by the baseline at all: Free edition (every scenario installs `backwpup-pro`), backup
deletion, bulk actions, job logs, settings, encryption, job import/export. Two of its gaps around
onboarding were closed in 6C: that a data type must be chosen before the schedule step, and that a
destination must be chosen before onboarding can be completed.

### 2.2 Verified plugin facts that change the port

Verified by reading **BackWPup 5.7.4 Free and Pro** (`~/.apvm/cache/backwpup/releases/5.7.4/`).

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V1 | Free and Pro ship **byte-identical** `components/`, `pages/` and `parts/` — re-confirmed at the ref under test (§2.3) | `diff -rq` — no differences | **One POM set for both editions.** Templates are shared; what differs is the **runtime data** poured into them (V2, V13). The §4.5 strategy factory is needed in exactly one place — the restore entry path (V13). |
| V2 | Pro-only storages are exactly **GDRIVE, GLACIER, HIDRIVE, ONEDRIVE**; Free renders them as locked upsells (`li.js-backwpup-locked-storage`) | `components/storage-list.php` (`$locked_pro_slugs`, gated on `BackWPup::is_pro()`) | Of the baseline's six storage suites only **Glacier** is `@pro`. FTP, S3, MS Azure, Rackspace, SugarSync are **untagged** → run on Free *and* Pro. |
| V3 | WP-CLI exists in **Free too**; the canonical job command is **`wp backwpup job`** (singular) — but **every command also registers an `@alias`, and the aliases work**, including `jobs` and `backups`. **17 commands** in Pro, **12 in Free** | `src/Cli/Commands/` — 18 files, of which `Command.php` is the shared base; each `get_name()` returns the literal; `Subscriber.php:49` registers `backwpup <name>`; the `@alias` docblock tags (16 of them, e.g. `Job.php:89` → `jobs`, `Backup.php:101` → `backups`, `Kill.php:45` → `abort`). **Confirmed live:** `wp backwpup jobs --format=count` and `wp backwpup backups --format=count` both exit 0 | WP-CLI scenarios are **untagged**, not `@pro`. Free's 12: `backup`, `backup-delete`, `backup-download`, `job`, `job-activate`, **`kill`**, `log`, `log-delete`, `log-show`, `run`, `status`, `version`. **Correction:** an earlier revision claimed the baseline's `wp backwpup jobs` "does not exist" — it does, as an alias, so the baseline was *not* broken on that point. 6F still targets the **canonical** names (an alias is a secondary contract), but it must not assert that an alias is unregistered. |
| V4 | Pro-only CLI is exactly `restore`, `backup-encrypt`, `backup-decrypt`, `job-export`, `job-import` | `comm -13` on the two editions' `src/Cli/Commands/` at the ref under test | These five are the genuine `@pro` CLI scenarios; everything else in V3 is untagged. |
| V5 | `wp backwpup backup --format=json` and `wp backwpup job --format=json` return structured records. **Exact fields** — `backup`: `name`, `time`, `size`, `storage`, `type` by default, plus optional `folder`, `file`, `job_id`, `size_bytes`, `time_unix`; `job`: `job_id`, `name`, `active_type`, `type`, `storages`, `cron`, `last_run`, `last_runtime` by default, plus optional `backup_type`, `archive_format`, `legacy`, `archive_encryption`, `email_address_for_logs`, `email_on_errors_only` | `Backup.php:63-75` and `Job.php:89-104` docblocks (`AVAILABLE FIELDS`) | **Structured ground truth** replaces DOM table scraping for counts, storage and type. `support/backups.ts` (6B) types exactly these fields; prefer `size_bytes`/`time_unix` over the humanised `size`/`time` for assertions. |
| V6 | History rows carry `<tr data-backup-id="…">`; failed/aborted rows render a **distinct branch** (`.backwpup-failure-icon`, `"%s backup failed – %s"`) | `components/table-row-backups.php` | Kills the baseline's positional `nth-child` + `<td>`-counting layout sniffing outright. |
| V7 | Buttons come from one component: `trigger` → class `js-backwpup-<trigger>`; `label` → `<span>` text = **accessible name**. `icon_position: "alone"` renders **no** label | `components/form/button.php` | Role/label locators work for labelled buttons; **icon-only buttons have no accessible name** and must use the `js-backwpup-*` / `data-content` hook (§3.2). |
| V8 | **24** REST routes under the single namespace `backwpup/v1`: `addjob`, `authenticate_cloud`, `backups`, `cloud_is_authenticated`, `cloudsaveandtest`, `delete_auth_cloud`, `delete_job`, `getblock`, `getjobslist`, `job-abort-status`, `license_update`, `messages`, `pagination`, `process_bulk_actions`, `save_excluded_tables`, `save_files_exclusions`, `save_job_format`, `save_job_settings`, `save_site_option`, `startbackup`, `storagelistcompact`, `storages`, `update-job-title`, `updatejob` | `register_rest_route` across 10 `src/**/API/Rest.php` files; the **same 24 in 5.7.4 and at the ref under test** (§2.3). *(An earlier revision of this table said 21 — that was an undercount, not a version delta.)* | Precise `waitForResponse` barriers replace `networkidle`. `support/rest.ts` (6B) names all 24 so no route string is inlined in a POM. |
| V9 | Scheduling uses the WP-Cron hook **`backwpup_cron`** with `['arg' => <job_id>]` | `inc/class-cron.php`, `inc/class-page-onboarding.php:146` | `wp cron event run backwpup_cron` ("runs the next scheduled cron event for the given hook", WP-CLI handbook) fires it deterministically → the 3-minute sleep goes away and the assertion gets *stronger* (schedule registered **and** it produces a backup). |
| V10 | The site option **`backwpup_onboarding`** gates onboarding — but by **redirect**, not by branching one page. While it is truthy, *every* `page=backwpup*` request except `backwpupabout`, `backwpuponboarding`, `backwpupfirstbackup` and `backwpupsupport` is `wp_safe_redirect`ed to **`admin.php?page=backwpuponboarding`**, its own dedicated page. Onboarding completion deletes the option | `inc/class-admin.php:272-282` (the redirect + its allow-list), `:676` (the page is registered only while the option is set), `class-page-onboarding.php:174` (deletion), `:249` (includes `pages/onboarding.php`), `components/storage-list.php:24` | Scenarios needing a post-onboarding dashboard **seed the state** via WP-CLI instead of re-driving onboarding (single-site: `wp option`; multisite would need `wp site option`). `OnboardingPage` navigates to **`page=backwpuponboarding`**; asserting on `page=backwpup` would silently assert against a redirect. **Correction:** an earlier revision described this as `page=backwpup` rendering either onboarding or the dashboard. |
| V11 | Restore **UI** exists in both editions (`admin.php?page=backwpuprestore`, `pages/restore.php`); Pro additionally ships `backwpup-restore.zip` and the `restore` CLI | `inc/class-admin.php:766` in both; Pro-only files | The restore *page* is shared, but the journey that reaches it is not (V13). **CLI restore is `@pro`**. |
| V13 | **The restore entry path diverges by edition, and the gate is doubled.** The history row's Restore action uses `dataset-restore['data-url']`, a deep link (`…&action=restore-destination_<service>&restore_file=<uploads>/…`) **only if the backup record carries `restoreurl`** — otherwise it falls through to a bare `admin.php?page=backwpuprestore`. Nothing in shared code ever stamps `restoreurl`: the shared base `BackWPup_Destinations::file_get_list()` checks `BackWPup::is_pro() && get_service_name() !== 'OneDrive'` and, if so, **delegates** to `BackWPup_Pro_Destinations::file_get_list()` — which is the code that stamps it, and lives in a **Pro-only file**. Pro further overrides the local **Website Server (`FOLDER`)** destination to point `restore_file` at the archive already on disk. | `inc/class-destinations.php:205` — the `is_pro()` delegation, in a file **byte-identical in both editions**; the stamp itself at `inc/Pro/class-destinations.php:49-73`, under a directory **Free does not ship at all** (`inc/Pro/` absent); `inc/Pro/class-destination-folder.php:184`; `inc/Utils/BackWPupHelpers.php:196-214` (the deep-link vs bare-page branch). All re-verified at the ref under test (§2.3). | **Pro restores in place** from `wp-content/uploads/backwpup/…`; **Free forces a manual re-upload of that same file** even though it is already on the server. Two genuinely different user journeys ⇒ separate `@pro`/`@free` scenarios sharing a Background, and the one edition-aware POM branch (§4.6G). Because the divergence is a **missing file** in Free and not a toggle, it cannot be faked from the test side — the `@free` scenario must really drive the upload. **Two exceptions to keep out of the scenarios:** SugarSync stamps `restoreurl` in its own override (`inc/class-destination-sugarsync.php:151`, shipped in **both** editions, so Free *can* deep-link there), and OneDrive is excluded even in Pro. Scenarios use the Website Server destination, where the divergence is clean. |
| V12 | Admin pages: `backwpup`, `backwpupbackups`, `backwpupjobs`, `backwpupeditjob`, `backwpuplogs`, `backwpupsettings`, `backwpuprestore`, `backwpupabout`, `backwpupfirstbackup`, `backwpupdocs`, **`backwpuponboarding`** (V10), plus Free-only `backwpupbuypro`; Pro adds `backwpupsupport` | `inc/class-admin.php`, `inc/Pro/class-pro.php`. The four pages the 6B POMs own — `backwpup`, `backwpuponboarding`, `backwpupbackups`, `backwpuprestore` — are each verified individually | The URL surface each POM owns. **Correction:** `backwpuponboarding` was missing from an earlier revision of this list. Note the registration code assigns it to the `page_hooks['backwpupbackups']` key (`class-admin.php:679`), so the hook key is not a reliable index of slugs. |

### 2.3 Re-verification at the ref under test — **zero drift**

§2.2 was verified at **5.7.4**, but cells build `develop`. Before writing a single locator, both
editions of the **exact ref under test** were unpacked and compared against 5.7.4 (2026-07-30):

| Check | 5.7.4 → ref under test | Free → Pro *(at the ref)* |
| --- | --- | --- |
| `components/`, `pages/`, `parts/` (`diff -rq`) | **identical** | **byte-identical** (V1 holds at the ref, not just at 5.7.4) |
| REST routes under `backwpup/v1` | **same 24** (V8) | same |
| `src/Cli/Commands/` file set | **identical** | Pro adds exactly the 5 of V4 |
| `$locked_pro_slugs` (V2) | unchanged | shared file, runtime-gated |
| `restoreurl` call sites (V13) | identical, 12 sites | Free ships **no `inc/Pro/`** |

Refs: `backwpup-pro-en-9.99.99-c0dd22c2.zip` and `backwpup-9.99.99-c0dd22c2.zip` (same commit) from
the APVM commit cache; 5.7.4 from the release cache.

**Consequence:** every V-fact holds for the build the tests will actually run against, so 6B's
locators rest on verified markup rather than on a 5.7.4 assumption. The §7 markup-drift risk is
**currently nil** — and 6B's **locator-contract spec** (§4.6B) is what keeps it detectable, turning
any future drift into one clear unit-test failure instead of a scattered scenario collapse.

### 2.4 Facts established while building 6B (live, on `pro@nginx`)

Reading the source got the locators close; **driving onboarding for real corrected four things the markup
alone implied wrongly.** Each is now encoded in a page object and pinned by a test.

| # | Fact | How it was found | Consequence |
| --- | --- | --- | --- |
| V14 | **A storage tile is not a checkbox.** Clicking `js-backwpup-toggle-storage` opens that provider's *settings form*; the hidden `#destination-<SLUG>` checkbox is ticked afterwards by `refresh_storage_destinations()`, only once the settings save. | Live: clicking the tile opened a "Folder Settings" panel and left the checkbox unchecked, so onboarding's submit stayed disabled. Confirmed in `assets/js/backwpup-admin.js:380` (`load_and_open_storage`) and `:166-168` (the checkbox write). | Choosing a destination is **two steps** — configure, then save. `OnboardingPage` exposes `openStorageSettings` / `saveStorageSettings` (and `selectStorage` for the credential-free local one); the save's completion signal is the checkbox flipping, which is provider-agnostic. |
| V15 | **The same trigger class is bound to two different handlers.** On the dashboard the tile *fetches* its form via `getblock`; during onboarding every provider panel is pre-rendered, so the click only reveals it and **no request is made**. | Live: a `getblock` barrier around onboarding's tile click timed out even though the panel opened. | No REST barrier in onboarding's storage step — visibility is the honest signal there. Barriers stay where a request really happens. |
| V16 | **Every switch in the plugin is an `sr-only`, `aria-hidden` checkbox behind a visible proxy** (`components/form/toggle.php`), and its `<label>` carries no text. | `getByRole("checkbox")` and `getByLabel` resolve to nothing; asserted as such in the contract spec. | The §3.2 policy gains a **second documented exception** beside icon-only buttons: click the proxy, assert the hidden input. One helper, `pages/toggles.ts`, does this everywhere. Also V7 is stricter than recorded — an **empty** label suppresses the name too, not just `icon_position: "alone"`. |
| V17 | **The running-job UI is an in-page region, not a modal.** It is `div#runningjob`, pre-rendered with `display:none`; the only modal is the *confirmation* dialog `#sidebar-backup-now`, whose "Start" launches the job. All 38 `#sidebar-*` panels are likewise pre-rendered (27, plus one settings panel per storage provider). | Captured markup + live. | The POM is `JobRunPanel`, not `JobRunModal`. And because these elements always exist, **presence proves nothing** — every assertion on them is visibility or content, never `toBeAttached`. |

### 2.5 Corrections from the 6B audit (all verified live)

A post-implementation audit re-checked every claim the page objects encode. Four assertions described
behaviour the plugin does **not** have, and each would have failed as an opaque timeout in whichever
scenario first relied on it. All are fixed and pinned by tests.

| # | Fact | How it was found | Consequence |
| --- | --- | --- | --- |
| V18 | **A storage panel's heading is not its picker label.** Ten providers title their panel `"<label> Settings"`, but `FOLDER` is offered as "Website Server" and titles its panel **"Folder Settings"**. | Extracted all eleven `<h1>`s from the captured markup; nine matched the derived string, `FOLDER` did not. | Panel titles live in a verified `STORAGE_PANEL_TITLES` map, never derived from the picker label. `FOLDER` is the destination every credential-free scenario uses, so the derived version was wrong exactly where it mattered most. |
| V19 | **The restore modal confirms with "Start Restoration"** — which does not contain the substring "Restore". | Read the modal out of the captured post-backup page. | A `/Restore/` pattern matched **zero** elements, so the whole 6G entry path would have timed out rather than failed clearly. A spec now asserts both the real label and that `/Restore/` matches nothing. |
| V20 | **Sidebars close by sliding the shell off-screen, not by hiding.** Closing adds `translate-x-[450px]` to `#backwpup-sidebar`; the panel inside keeps a layout box, so Playwright still reports it visible. And **a provider sub-panel's close control is inert** — clicking it changes nothing at all. | Logged the DOM before/after a close on the live site. | `close()` asserts the panel has left the **viewport**, never that it is hidden. `StorageSidebar` ships **no** `close()`: a method that cannot close is worse than none. |
| V21 | **Clear-search clears the filtering, not the search box.** The typed text stays; the full table list returns. Filtering **removes** rows from the DOM rather than hiding them. | Filled the filter, clicked clear, read the value and the row count. | `clearTableFilter()` asserts the list size changed, not that the field emptied — the latter could never pass. |

Two process findings, both fixed:

- **Captured fixtures must not be reformatted.** Prettier reflowed them on the first `npm run format`
  (one grew 10,418 → 12,196 bytes), which quietly falsified the "verbatim capture" guarantee the whole
  approach rests on and would have let a Prettier upgrade masquerade as plugin drift. The directory is
  now in `.prettierignore`.
- **Fixtures are sanitized, not raw.** The captures carried live WordPress nonces and the QA host's real
  hostname and docroot path — the latter appearing nowhere else in the tracked tree, since `sites.json`
  is git-ignored. Both are replaced with placeholders; neither affects a locator, and re-captures no
  longer produce diffs full of changed hashes.

A **strict-mode guard** was added alongside: for every click-target locator, one test asserts it
resolves to exactly one element in the captured markup. It exists because an ambiguous locator is a
runtime failure Playwright only raises at click time — and one had already shipped (the duplicated
`#js_backwpup_add_new_backup`).

### 2.6 Facts established while building 6C (live, on `pro@nginx`)

Reading `class-page-onboarding.php` end to end — then driving onboarding for real — settled seven
things the 6B work had no reason to look at. **Three of them the source alone did not give up**: the
lazily written onboarding flag (V26) surfaced as a one-in-three flake, the first backup's transient
guard (V27) as a ten-minute timeout on the one scenario whose backup was fast enough to take the
other branch, and the dashboard's actionability wall (V28) as two reproductions of a click that never
dispatched. The first two are encoded in a step, a page object or a support reader and pinned by a
test; the third **cut 6C's scope** rather than being worked around, and is handed to 6D with the
evidence.

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V22 | **Whether onboarding produces one job or two is decided by the *cron*, not by the toggles.** Both types active **and** identical cron expressions ⇒ the two are merged into a single `type_job_both` job written at the *files* placeholder id; anything else ⇒ two jobs, with whichever placeholder is inactive deleted afterwards. The inline dropdowns only feed the cron as a **fallback**: `get_onboarding_job_cron()` prefers a cron already stored on the job, which is why saving the *advanced* sidebar (an immediate `save_job_settings` write) also splits them. | `inc/class-page-onboarding.php:29-36` (the fallback), `:91-111` (the merge), `:180-186` (the deletes); `src/Jobs/API/Rest.php:597-658` (`save_job_settings` writes `cron` + `frequency` immediately) | The two "split into two jobs" scenarios are genuinely different paths to the same rule, not duplicates. It also means that after the *advanced* path a job's stored `frequency` can read `monthly` while its `cron` is daily — the form's value wins for one field, the sidebar's for the other — so that scenario asserts **schedules differ**, never an exact frequency. |
| V23 | **The "First backup" job is a `tempjob`, and every surface hides it.** `wp backwpup job`, the `getjobslist` REST route and `parts/backups/next-scheduled-backup.php` all skip `tempjob` records. | `src/Cli/Commands/Job.php:124`, `src/Jobs/Frontend/API/Rest.php:80`, `parts/backups/next-scheduled-backup.php:37` | "The site has N backup jobs" means the same thing in the UI and in WP-CLI, so the two can be asserted against each other. `support/job-options.ts` exposes `scheduledJobs()` for exactly this. |
| V24 | **Completing onboarding starts a real backup, on a page of its own.** Submit is a native form POST, `save_post_form()` ends in `wp_safe_redirect(page=backwpupfirstbackup)`, and that page's script posts `startbackup` and reloads into a progress view. `#first-congratulations` is revealed when the run ends — **whether it succeeded or failed**. | `assets/js/backwpup-admin.js:1882` (submit), `inc/class-page-onboarding.php:192`, `assets/js/backwpup-admin.js:2387-2398` (auto-start), `assets/js/backwpup-generate.js:44-56` (the reveal) | Every scenario that finishes onboarding **must** wait for that run: the dashboard re-renders its job cards while a job is in flight, and the `@plugin` teardown uninstalls the plugin the moment the scenario ends. Where that wait lives is settled by V27 — not on this page. |
| V25 | **The default table selection is prefix-scoped, not "everything".** A new job's `dbdumpexclude` defaults to every table whose name does not carry `$wpdb->prefix`. **Refined by V29** — the screen's rule is `contains`, the job option's is `starts with`. | `parts/sidebar/select-tables.php:30-45`, `inc/class-jobtype-dbdump.php:45-58` | The baseline's "all database tables should be selected" is only true on a database holding nothing else. The port asserts the real rule via `expectDefaultTableSelection(prefix)`, with the prefix read from `wp db prefix` — a hard-coded `wp_` would assert the wrong set on any site not using the default. |
| V26 | **`backwpup_onboarding` is written lazily, one request *after* the install.** The plugin schedules `BackWPup_Install::activate` on `init`, so a fresh install sets the flag on the first WordPress request that loads the activated plugin — not during `wp plugin install --activate`, where the plugin file is included after `init` has already fired. The redirect that enforces onboarding runs on `admin_init`, i.e. later in that same request. | `src/Plugin/Plugin.php:117-122`, `inc/class-install.php:48` + `inc/class-migrate.php:143`, `inc/class-admin.php:267-282` (+ `:1188`) | **Found as a flake**, not by reading: an early revision asserted the flag straight after the install and failed once in three runs. The Background now navigates first and asserts the flag *after* observing the redirect, which is both race-free and better coverage — it proves the fresh-install → onboarding contract from the browser and from the database at once. |
| V27 | **The first backup is guarded by a site transient, so a *fast* one never reports itself finished in the UI.** `startbackup` sets `backwpup_first_backup` on the first `first_backup=1` call and answers every later one with `{status: 301, url: page=backwpup}`. The first-backup page posts that call, then reloads half a second later; if the job is still running the reloaded page enqueues the progress script and eventually reveals `#first-congratulations`, but if the job has already finished the script is absent, the page posts `startbackup` **again**, and the browser is redirected to the dashboard having shown nothing. | `src/Backups/API/Rest.php:335-352` (the transient + the 301), `assets/js/backwpup-admin.js:2387-2398` (both branches), `assets/js/backwpup-generate.js:44-56` (the reveal). Reproduced live: the mixed backup showed the panel, the database-only backup was redirected. | **Found by a 10-minute timeout, not by reading.** `#first-congratulations` cannot be the completion signal — waiting on it is a race against how long the site takes to back itself up. The scenarios watch WP-CLI instead: poll until the archive is in the history (the outcome, true on both paths), then a blocking `wp backwpup status` so nothing is still running when the plugin is uninstalled. `FirstBackupPage` deliberately ships **no** wait method, and its `congratulations` locator documents why — the same "a method that cannot do its job is worse than none" rule §2.5 applied to `StorageSidebar.close()`. |
| V28 | ~~**Nothing on the post-onboarding dashboard can be *clicked* by Playwright's normal rules.**~~ **Superseded — see §2.8. The observations were right; the diagnosis was wrong on both counts.** It is not the dashboard (a dashboard reached by seeding is fully clickable) and it is not BackWPup (plain WordPress does it too). The tab had stopped producing animation frames, which disables exactly the three primitives V28 named. | Superseded by §2.8. | 6C's scope cut is **reversible** — see §2.8 and §4.6D. |

Re-verified while doing the above: `components/`, `pages/`, `parts/`, `inc/Utils/` and
`inc/class-page-onboarding.php` are **identical** between the ref under test (`develop` @ `c0dd22c`,
which `artifacts:warm` re-resolved to on 2026-08-05) and **5.7.5**, the latest stable — so §2.3's
"zero drift" still holds, now against the newer stable.

**Two defects found outside the plugin**, both in the suite's own tooling:

- The 6A **lint gate's selectors matched *any* member expression under a call**, so
  `describeJobContents(job.type)` was reported as a deprecated `page.type()`. Each selector now
  matches the call's `.callee` field; all four patterns were re-verified to still reject a
  deliberately re-introduced violation.
- The **fixture capture installed over whatever was already on the site** (`force: true`, files
  only), so the options a previous run had left behind came through into the capture. A re-capture
  taken after a scenario that excludes the Plugins area and the `options` table duly recorded both
  as *unchecked* — which would have baked one run's state into the contract every later run is
  measured against. The script now removes the plugin's DB footprint before installing, so a capture
  always describes a fresh install. This is the same class of problem as §2.5's "captured fixtures
  must not be reformatted": everything rests on the fixtures describing the **plugin**, not the site.

Two smaller findings worth carrying into later phases:

- **The dashboard emits `id="js_backwpup_add_new_backup"` twice** — once visibly and once inside the
  hidden `#backwpup_dynamic_response_content` template. A bare id lookup matches both and fails
  Playwright's strict mode, so that locator is scoped to the job-card region.
- **`wp backwpup backup-delete` cannot delete an archive the web user wrote** when WP-CLI runs as a
  different user (`Could not delete backup archive …, check permissions!`), even though the containing
  directory is world-writable — the refusal is the plugin's own check, not the filesystem's. **6F must
  expect this**, and 6D's cleanup cannot rely on that command.

### 2.7 Corrections from the 6C audit (all verified)

A post-implementation audit re-checked every claim 6C encodes against the plugin source and the live
cell. Four suite claims were wrong — two are assertions that pass today and break on a
differently-shaped site, one was a gate that had silently stopped working, and one was an
intermittent that blamed the wrong scenario — and the runs that exposed the last of those also
surfaced a genuine **product** bug (V33). Only those two announced themselves at all.

| # | Fact | How it was found | Consequence |
| --- | --- | --- | --- |
| V29 | **V25 was half right: the screen and the job option use *different* rules.** `select-tables.php` ticks a table whose name **contains** `$wpdb->prefix` (`strstr`), while a new job's `dbdumpexclude` default excludes a table whose name does not **start** with it (`strncmp`). So `legacy_wp_posts` ships ticked on screen but excluded from the job. | Read both call sites while verifying V25's citation. | `expectDefaultTableSelection` asserted starts-with against the **screen**, so a site holding any table that contains but does not start with the prefix would have failed a scenario that is doing nothing wrong. Now matches on `contains`, with a test that renames a captured table to `legacy_wp_options` — the capture's database is all `wp_*`, so nothing else could have caught it. |
| V30 | **`wp backwpup job` hides more than `tempjob`** (V23): it also skips a record flagged `backup_now` and the one whose id is the site option `backwpup_backup_now_job_id`. | `src/Cli/Commands/Job.php:124`. | `scheduledJobs()` filtered only `tempjob`, so "the site has N backup jobs" would have disagreed with the command the moment a scenario ran a backup on demand — silently, as an off-by-one. It now filters `backup_now` too; the id option needs no second read, since the plugin writes both together (`src/Abilities/Jobs/RunJob.php:408-440`). |
| V31 | **`wp eval` exits 0 whatever the PHP inside it did.** A denied `file_put_contents` returns `false` with a warning and WP-CLI still reports success. | Reproduced on the cell against a decoy file owned by `www-data`: `bool(false)`, `Permission denied`, `wp-eval-exit=0`. | **`clearDebugLog` had never once cleared the log on this cell.** `debug.log` is `644 www-data` and the transport runs as `ubuntu`, so the truncate always failed and the fallback never fired — the live log held entries spanning three hours and many scenarios. One scenario's fatal would have failed every scenario after it. Fixed without privileges: the snippets now report their own outcome, and clearing **unlinks** (needs write on the directory, `0777`) instead of truncating (needs write on the file). Verified live: a log dating back to 22:15 now clears. |

| V32 | **A fresh install is not a site with no jobs, and cleanup between scenarios cannot make it one.** Activation creates a `tempjob` placeholder of its own, and rendering the onboarding page creates two more — so "no jobs" is only true in the window before the plugin has bootstrapped. And it is not guaranteed *between* scenarios either: `uninstall.php` wraps its **entire** database cleanup in `! class_exists( \BackWPup::class )`, so the footprint is removed only when nothing loaded the class during that request. | `inc/class-install.php:184-200` (the tempjob), `inc/class-page-onboarding.php:225-245` (the two placeholders), `uninstall.php:19`. **Found by an intermittent failure**: one full run failed at the first step of a scenario with two leftover placeholder jobs carrying default monthly crons; the next full run of the same code passed 11/11, and the scenario passed in isolation. | `Given a freshly installed BackWPup` asserted **zero** scheduled jobs — a property the plugin does not have and the teardown cannot promise, so it failed intermittently and blamed whichever scenario happened to run next. It now asserts what the hook genuinely guarantees (the edition under test is installed and active). The claim it was reaching for — that onboarding is still owed — is proved race-free by the two steps after it: ask for the dashboard, get sent to onboarding. A leaked *completed* onboarding still fails there, clearly and in the right place. |

| V33 | **A product bug: BackWPup fatals on activation when the site holds a job that has a `cron` but no `type`.** `Migrate::migrate()` filters `backwpup_jobs` to records with a `cron` key and hands them to `organize_jobs_by_type()`, which does `sort( $job['type'] )` — `sort(): Argument #1 must be of type array, null given` when that key is absent. The activation dies, and every later WP-CLI call that boots WordPress with the plugin active dies the same way. | `inc/class-migrate.php:24-25` (the filter + call), `:174` (the `sort`). Caught live by the `@plugin` hook: `PluginActivationFailedError` plus `DebugLogFatalError` quoting `Uncaught TypeError: sort() ... in inc/class-migrate.php:174`. | Onboarding reserves two placeholder job ids and writes their default settings — `cron` included — but assigns `type` only on submit. So **a scenario that opens onboarding and never finishes it leaves exactly that shape**, and three of this feature's scenarios do. It only bites when those rows survive the uninstall, which is conditional (V32) — hence intermittent, roughly one full run in two, and always blaming the *next* scenario. Worth reporting upstream: a user who abandons onboarding and then updates the plugin hits it with no test suite involved. The suite-side question — whether teardown should guarantee the database footprint is gone rather than trust the plugin's own conditional cleanup — is a design decision, not a bug fix, so it is **not** taken here. |

**Three suite-side defects**, none of which any test could have caught:

- **Assertions that cannot fail.** `expectAllFileAreasIncluded`, `expectDefaultTableSelection` and
  6B's `expectAllTablesSelected` each asserted `toHaveCount(0)` over a *filtered* set — "nothing is
  unticked" — which is also true of a pane that rendered nothing at all. A panel that failed to load
  would have reported every area and every table as included. Each now asserts its population first
  (an exact five for the file areas), pinned by a test that strips the checkboxes out of the capture.
- **Code cited the plan in 23 places** (`V2`, `6H.2`, `§3.2`, "the parent plan", …), against an
  explicit rule with no standing exceptions. One was 6C's; the rest predate it. All are replaced by
  the reasoning they were shorthand for, and the code is now clean of plan references.
- **Dead API surface**: `isJobContents`/`JobContents` had no caller and no test. Removed.

Every fix is covered by a test that was **confirmed to fail against the old code** before being kept.

### 2.8 V28 re-investigated — it was never the dashboard, and never BackWPup

V28 blocked 6D and cut two of 6C's steps. Investigated live on `pro@nginx` (2026-08-26): **every
observation it recorded was accurate; the conclusion drawn from them was wrong on both counts.** The
cause is a Playwright/Chromium defect that the suite's own 6A notes had already met from the other
side and filed as cosmetic (§4.6A, "a headed browser goes permanently blank").

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V34 | **The tab stops producing animation frames, and that is the whole of it.** `requestAnimationFrame` runs at ~61 frames/0.5s through login and all three onboarding steps, then drops to **0** at the submit and never recovers — not over the next 70s, not after navigating away, not after a reload. Timers, `evaluate`, the DOM and the network all keep working. A **new tab in the same context is clean** (61 frames). | Frame timeline through the real chain, sampled at every navigation. `page.screenshot()` hangs (8s timeout) on the wedged tab and takes 34ms on a healthy one. | Explains all three of V28's symptoms at once, because Playwright's own primitives split exactly along "needs a frame": `click()`'s `stable` check is an unbounded `rAF` loop **with no internal timeout** (`injectedScript._checkElementIsStable`), and `toBeInViewport` is an `IntersectionObserver` plus an `rAF` nudge (`viewportRatio`) — while `toBeVisible` is a synchronous layout read. Hence "parks forever", "never returns an answer", and "answers instantly", from one cause. |
| V35 | **The dashboard is innocent.** Reached by seeding past onboarding (`wp option delete backwpup_onboarding`) in a fresh tab, it runs at 85 frames/0.7s, screenshots in 40ms, and a **real `click()` with full actionability succeeds in 45ms** — on the header control V28 said could not be clicked. | Direct probe on `pro@nginx`. | **6D is not blocked.** It seeds past onboarding anyway (§4.6C already says seeding is the right answer for 6D–6G), so it never enters a wedged tab — and with V37's fix in, nothing else does either. The two steps 6C cut are free to restore. |
| V36 | **It is not BackWPup.** With the plugin **uninstalled**, saving WordPress's own Settings → General wedges the tab identically, and the *next* save's click then times out — the cascade V28 saw. But `wp-login.php`'s own POST → redirect never wedges, and a synthetic POST → 302 → GET does not reproduce at all: not across added latency (100/300/1000ms), nor with composited, fixed-position, transformed, sticky or 4000-node source documents. | Probes with the plugin absent, plus a local 3-route server used to bisect. | The trigger needs something the real environment supplies that was **not isolated**. Recorded as a bound on the claim, not as an open task — the fix removes the cause regardless. |
| V37 | **Cause and fix: Playwright 1.61 disabled Chromium's `RenderDocument`; 1.62 does not.** It was added to `--disable-features` purely to unblock Playwright's own CI bots (microsoft/playwright#37715, whose own body says it "should fix `chrome-beta` failures … and unblock `chromium-tip-of-tree` rolls"; tracking issue #37714 is titled *"[internal] re-enable RenderDocument"* and is **closed**). Per the upstream fix linked on that issue, Chromium resolved the defect in **147+**; Playwright removed the line in **1.62**, and Puppeteer removed theirs in puppeteer#14745. | Read at both tags: present at `v1.61.1` `chromiumSwitches.ts:44`, absent at `v1.62.1`, rest of the list intact; absent from the installed `playwright-core` after upgrading. A/B on the real cell: 1.61 wedges at the submit, 1.62.1 holds ~61 frames throughout with **no launch flag**. | **Upgraded to Playwright 1.62.1** (Chromium 151.0.7922.34). The 6A workaround — `config/chromium.ts`, its spec, the `launchOptions` wiring and the `E2E_VISIBLE_BROWSER` exports in seven npm scripts — is **deleted**, along with the hand-copied disable list it had to keep in step with each Playwright bump. Doc floor recorded in [wordpress-automation.md](../architecture/wordpress-automation.md). |

**6A's classification was the costly part, not the miss.** 6A measured the wedge correctly and even
found the flag, but called it "a cosmetic problem — a bad deal for CI" and gated the fix behind
`E2E_VISIBLE_BROWSER`. It is not cosmetic: the wedge reproduces **identically headless**, and it
silently disables `click()`, `toBeInViewport()` and screenshots. 6C then met the same wedge through
`DashboardPage`, could not connect it to a note about headed rendering, and spent its budget cutting
scope. The lesson worth keeping: *"assertions still pass"* was never evidence the defect was cosmetic
— it only meant the surviving assertions were the frame-independent ones.

**One unrelated defect the upgrade exposed**, fixed with it: the locator-contract fixtures are
verbatim captures, so they carry the emoji `<img>`s WordPress injects from `s.w.org` and links to
`dropbox.com` and `console.developers.google.com`. `page.setContent()` waits for `load` — i.e. for
**all** of them — so those 22 specs had been quietly depending on the public internet and began
timing out under the new Chromium's timing. `__fixtures__/render.ts` now aborts every request and
waits for `domcontentloaded`, which is the honest barrier for a spec that asserts on parsed DOM —
none of the seven captures contains a `<script>`, so nothing about execution order changes with it.
Its abort is swallowed deliberately: Playwright **rethrows** a route callback's error, so an abort
still in flight when the page closes would fail whichever test is running by then. Covered by
`render.spec.ts` (6 tests, **482 total**), whose hermeticity case serves the asset from a local
server that counts hits and never answers — an unresolvable host would have made the test vacuous.
Both the naive `page.setContent()` and an abort-less variant were confirmed to fail it. Hermetic, and
the unit suite went from **1.6 min to 22.7s**.

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

Filtering is already automatic per cell (`editionFilter`); 6I only adds the `free@nginx` cell. The
storage rows are the **deferred** 6H.2 content — their tags are settled here so the deferral is a
scheduling decision, not an open question.

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

6A added one more: **`@plugin`**, which opts a scenario into the shared plugin lifecycle (fresh
install + activate, a scoped `debug.log` that fails the scenario on a fatal, removal afterwards).
Nearly every ported scenario carries it; the exceptions are scenarios that assert on a site
*without* the plugin, and `@noauth` ones that need no site at all.

---

## 4. Sub-phases

Each is independently shippable and ends with the standard gates (typecheck / lint / format /
`test:unit`) plus a green real-cell run. 6A is a prerequisite for everything and 6B for every feature
phase; 6C–6H are otherwise independent of each other and can be reordered by need. **6H.2 is
deferred out of the sequence** — nothing downstream waits on it.

### 6A — Shared rails *(product-agnostic; unblocks BackWPup **and** WP Rocket)* — **DONE**

**Shipped as planned**, with these decisions worth carrying forward:

- The lifecycle is scoped to a new **`@plugin`** tag; its policy lives in
  `hooks/plugin-lifecycle.ts` (unit-tested against a stateful stub `wp`) while
  `hooks/plugin.hooks.ts` is a thin binding. Hooks load via `src/common/hooks/**/*.hooks.ts`
  — narrower than `**/*.ts` so specs and policy modules are not imported as hooks.
- The After hook runs **both** duties and prefers the debug-log verdict over a cleanup
  failure, logging the latter rather than dropping it. A fatal raises the new typed
  `DebugLogFatalError`.
- The Before hook **re-asserts that the plugin is active** instead of trusting
  `wp plugin install --activate` to exit non-zero — the same "WP-CLI exit codes are not
  trusted, re-check the state" discipline `wp/plugin.ts` already applies to removal. It
  doubles as the check that the archive really installed under the promised slug.
- The scenario timeout is extended **additively** in the Before hook (`extendedTimeout`),
  because Playwright times a scenario and its hooks on one clock and remote WP-CLI + an
  SFTP upload do not fit a 30 s budget. `0` (no timeout) is left alone.
- Debug-log presets reach the shared hooks via `ProductConfig.debugLog` + a per-process
  registry in `config/metadata.ts` — RegExps cannot ride Playwright's project metadata,
  and shared hooks must not import product code.
- Device profiles moved to `config/devices.ts`: `@mobile` = **Pixel 5** (a Chromium
  preset — the only browser we run) with the viewport pinned to the baseline's `389×829`,
  exactly as `DESKTOP` pins `1600×700`.
- **CI's smoke job now greps `@noauth`** explicitly. It previously ran *every* scenario
  against placeholder sites, which happened to work only because every scenario was
  `@noauth` — the first real 6C scenario would have broken it.
- Not in 6A: the **English-locale pre-flight assertion** (§3.2). It belongs with the
  locator policy it protects, so it lands in 6B.
- **Added after 6C, because 6C proved it was needed: cleanup escalates.** Every scenario ended
  with a warning that `uploads/backwpup-restore` could not be removed, and the advice in it
  ("make it writable by that user") was not a fix anyone can apply — the plugin recreates the
  directory `0755 www-data` on every install, so the next run is in the same position. Verified
  on the cell: the parent is `0777`, the directory itself is not, so the transport's `ubuntu`
  cannot unlink its children; unprivileged `rm -rf` exits 1 and the path survives, `sudo -n rm
  -rf` removes it. The exec layer therefore gained `execElevated` + `elevationSupport`, and
  residue removal, `debug.log` clearing/reading and staging cleanup all try unprivileged first
  and escalate only what survived. **Never `wp`** — WP-CLI as root would leave the site's own
  files unwritable by the web server, so `wpCli` has no way to ask. The baseline's approach
  (`sudo` hard-coded into `rm`/`find`/`cat`) is deliberately *not* copied: it would break
  `docker`, where the image has no sudo binary and `-u 0:0` is the answer, and `local`, where a
  developer without passwordless sudo has no problem to solve in the first place. Refusable per
  site with `transport.elevate: false`, which is what the four tests that pin the unprivileged
  contract now use — with elevation allowed they would have depended on whether the machine
  running the suite happens to have passwordless sudo. 18 new unit tests, all mutation-checked
  against the pre-change code.
- **What fixing cleanup unmasked, and had to be fixed with it.** With the restore area finally
  being removed after every scenario, the next scenario's *first writer* started creating it —
  and when that writer was a WP-CLI call it arrived as `drwxrwxr-x ubuntu:ubuntu`, so the
  plugin's next admin request died on `Folder "…/backwpup-restore" is not writable`
  (`BackWPup_File::check_folder`, from `create_project_temp_dir`). 5 of 9 scenarios failed on
  it. Caught by watching the directory on the cell during a single scenario: created by the
  transport user at 15:38:49, fatal at 15:38:50. The defect was **pre-existing and merely
  masked** — for as long as removal failed, the copy the web server had made months earlier was
  always the one in use, so nothing ever created it during a run. Root cause is the two-user
  docroot: WP-CLI runs as `ubuntu`, PHP-FPM as `www-data`, and the plugin creates its
  directories under whichever umask it is under. The Before hook now runs
  `prepareSiteDataDirs` over the same declared paths, creating them `0777` — what the plugin
  asks for itself (`mkdir($dir, 0777, true)`) and what `wp_mkdir_p` would produce by inheriting
  `wp-content/uploads`, which is already `0777` on these cells for exactly this reason. The
  structural alternative — running `wp` as the web-server user, as the docker transport already
  does with `user: "33:33"` — is a larger change and is not taken here.
- **A headed browser goes permanently blank after onboarding submits, and the tests still
  pass.** ⚠️ **Superseded by §2.8 — the measurements below hold, the "cosmetic" verdict does not.**
  The wedge reproduces headless too and disables `click()`, `toBeInViewport()` and screenshots; it is
  what V28 later ran into. Fixed by upgrading to Playwright 1.62.1, and everything this bullet
  describes (`config/chromium.ts`, `E2E_VISIBLE_BROWSER`) has been **deleted** — so read the rest in
  the past tense; it is kept only for the measurement trail. Reported while watching a run. Measured
  rather than guessed: `requestAnimationFrame`
  drops from 84 frames/0.7s to **0** the moment the POST → redirect → first-backup → dashboard
  chain starts, and never recovers — not on the next navigation, not on a reload, not after
  `bringToFront`. The main thread stays responsive, a new page in the same context renders, and
  raw CDP `Page.captureScreenshot` hangs identically, so it is the tab's rendering pipeline and
  not Playwright. Bisecting Playwright's `--disable-features` list one feature at a time named
  **`RenderDocument`**: disabled (Playwright's default) it wedges, enabled it renders and
  screenshots take ~46 ms. No compositor flag avoids it, and
  `--disable-threaded-compositing` breaks clicks outright. Playwright disables the feature
  deliberately (it breaks isolated worlds, microsoft/playwright#37714), so it is re-enabled
  **only for watched runs** and never for CI — `config/chromium.ts`, signalled by
  `E2E_VISIBLE_BROWSER` because a *worker's* `process.argv` carries none of the CLI's flags, so
  sniffing `--headed` compiles, tests green, and silently does nothing (caught by checking the
  real launch command line). Videos have the same blind spot; traces do not, being DOM snapshots.
- **Fixed outside 6A's scope, because it blocked it:** the shared UI login failed ~35% of
  real-cell runs (4 of 11). Root cause, reproduced 8/8 locally: `fill()` inserts text into
  whatever element holds focus *at that instant*, and WordPress's login page re-focuses the
  username field — so a re-focus landing mid-fill diverted the password into the username
  box and the run failed later as "login never settled". `login.ts` now confirms both fields
  kept their values before submitting (compared in code, so a failure never prints the
  password), with two regression tests. Real-cell logins: **8/8**.

**Measured cost of the lifecycle** (ssh staging box, 9.2 MB / 5822-file plugin), so 6C–6I can
budget run time without re-measuring: **~25 s per `@plugin` scenario** — Before ≈ 13 s (clear 1.5,
remove-when-absent 1.5, upload 4.5, install+activate 3.5, re-assert 2.0) and After ≈ 12 s (scan 2.0,
remove-when-present 10.0). Plus a one-off ~4 s SSH connect per worker. The uninstall dominates, not
the upload — so staging the zip once per worker instead of per scenario would save only ~4.5 s of
25 s, which is why it was **not** done: `stageArtifact`'s unconditional overwrite is a safety
property (a crashed run's residue is replaced before it can be used).

**Verified on `backwpup/pro@nginx` (ssh) and on a throwaway `pro@docker` cell over the local
Docker environment:** the artifact installs and activates, the site is left with no plugin, no
`.e2e_temp` and **zero** `backwpup*` options, a seeded PHP fatal fails the scenario with
`debug.log` attached *and still removes the plugin*, warnings/notices are reported without
gating, and the lint gate rejects all four re-introduced patterns while `visual/stabilize.ts`
stays legal. `@mobile` is proven end-to-end by two `@noauth` smoke scenarios that assert the
emulated client from **inside the page**.

Exercising `docker` was not ceremony — it caught a **real bug that made the plugin
uninstallable on that transport**. A build lands mode `0600`, and `docker cp` preserves the host
mode *and* numeric owner, neither meaningful in a container, so WP-CLI there (uid 33) could not
open the archive: `PCLZIP_ERR_READ_OPEN_FAIL`. SSH had hidden it, because SFTP applies the
remote user's umask instead. The resolver now normalises every resolved zip to `0644` in one
place, which fixes `docker` and the analogous `local` case (a site whose `wp` runs as another
user), with a regression test on a deliberately owner-only source.

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

### 6B — BackWPup page objects *(the first content phase; no features yet)* — **DONE**

**Shipped 2026-07-30, verified live on `pro@nginx`.** Decisions worth carrying forward:

- **POMs are registered in a new product-level `src/projects/backwpup/fixtures.ts`**, not in
  `common/fixtures.ts` as the parent plan's §7.5 sketch said. Putting product POMs in the shared file
  would invert the layering (the same problem 6A's debug-log registry avoids) and would load BackWPup's
  objects into every WP Rocket run. This is a supported playwright-bdd pattern, not a workaround: its
  `ImportTestGuesser` collects the test instances a scenario's steps use and picks the
  **most-extended** one, failing only when two are unrelated — so an instance that *extends* the shared
  one composes cleanly with common steps. Verified: the generated spec's import switches to the product
  instance as soon as a step destructures a POM fixture.
  - The product's `steps` array must list that file. Omitting it fails generation loudly
    ("Can't guess test instance"), and a `@noauth` smoke scenario now pins the wiring in CI.
- **Locators were derived from markup captured off the ref under test, then proven by driving
  onboarding for real.** That second step was not ceremony — it corrected four wrong assumptions (§2.4), the largest
  being that a storage tile is not a checkbox.
- **The English-locale pre-flight landed here** as planned, using `determine_locale()` — the function
  WordPress itself uses to choose an admin request's language, and the only one that accounts for a
  per-user override, the site option, a `WPLANG` constant and filters together. Evaluated as the
  configured admin user, since a profile language beats the site default.
- Two POMs were **renamed against the plan** to match what the product actually is: `JobRunModal` →
  `JobRunPanel` (an in-page region, V17), and the restore page is an interface plus
  `ProRestorePage`/`FreeRestorePage` behind a `restorePage(page, edition)` factory (V13).

**Deliverables** — `pages/{onboarding.page,dashboard.page,data-selection.sidebar,frequency.sidebar,storage.sidebar,job-run.panel,backup-history.table,restore.page}.ts`,
the `toggles.ts` interaction primitive and the `storages.ts` slug/label registry, `support/rest.ts`,
`support/backups.ts`, `fixtures.ts`, and specs: `locator-contract.spec.ts`, `restore.page.spec.ts`,
`toggles.spec.ts`, `support/rest.spec.ts`, `support/backups.spec.ts`. Unit tests **187 → 319**.

**Verified live** — onboarding was driven end to end through the page objects on `pro@nginx`: every
step and assertion passed, a real database-only job and backup were created, `listBackups`/`listJobs`
returned the exact V5 fields, the history row rendered with `data-backup-id`, and the site was then
restored to its prior state (plugin uninstalled, zero `backwpup*` options, no `.e2e_temp`, only the
pre-existing 2026-07-13 archives left).

**Two real defects the specs caught in the POMs themselves**, both fixed: a duplicate-id locator that
would have failed strict mode on the first click, and an `expectAllTablesSelected` that used
`.locator(":not(:checked)")` — a *descendant* query on `<input>` elements, so it matched nothing and
could never fail.

**A post-implementation audit (§2.5) then found four more**, each an assertion about behaviour the
plugin does not have — a wrong storage-panel heading, a restore button located by a pattern matching
nothing, a `toBeHidden()` on a sidebar that closes by sliding away, and a filter-clear assertion the
product never satisfies. It also caught six methods that acted without any completion signal, contrary
to this phase's own acceptance criterion. All fixed, re-verified live, and pinned by tests; the audit
added a **strict-mode guard** over every click target and put the captured fixtures beyond Prettier's
reach.

Builds the whole UI surface once, so 6C–6H are thin. POMs are plain classes under
`src/projects/backwpup/pages/`, registered as fixtures (parent §7.5 — no decorators).

| Page object | Owns |
| --- | --- |
| `OnboardingPage` | The 3-step onboarding page at `page=backwpuponboarding` while `backwpup_onboarding` is set (V10): data selection, frequency, storage, submit. |
| `DashboardPage` | Post-onboarding `page=backwpup`: job cards (`mixed`/`files`/`database`), next scheduled backup, "Backup now". |
| `DataSelectionSidebar` | Select-files / select-tables exclusion sidebars (`save_files_exclusions`, `save_excluded_tables`). |
| `FrequencySidebar` | Simple + advanced frequency, start time (`save_job_settings`). |
| `StorageSidebar` | Storage picker, locked-Pro list (V2), per-provider forms + "test connection" (`getblock`, `cloudsaveandtest`). `testConnection()` is written here but first *exercised* in the deferred 6H.2 — it needs credentials, its locators do not. |
| `JobRunModal` | Running-job progress, abort, close (`startbackup`, `job-abort-status`). |
| `BackupHistoryTable` | Rows keyed by `data-backup-id` (V6), per-row action menu (View log / Download / Restore / Delete), bulk actions. |
| `RestorePage` | `page=backwpuprestore` (V11) — the shared restore screen, **plus the two entry paths** of V13: `startFromHistory()` (Pro deep link) and `startByUpload(file)` (Free manual upload). |
| *(reused)* `PluginsPage` | Install / activate / delete via wp-admin — already exists in `common/pages/`. |

**Also**

- `support/rest.ts` — all **24** routes of V8 as named barriers, so no route string is inlined in a
  POM and an unknown route is a compile error rather than a silent never-matching wait.
- `support/backups.ts` — `wp backwpup backup|job --format=json` readers typed against the documented
  fields (V5), giving every count/status assertion a ground truth independent of the DOM.
- **Locator-contract spec** — `pages/*.spec.ts` rendering markup **captured from the ref under test**
  through `page.setContent()` and asserting every locator resolves. This is the version-drift alarm
  (§2.3); the markup is captured, never hand-written, so the fixture cannot drift into agreeing with a
  wrong locator.
- **English-locale pre-flight** (§3.2, deferred here from 6A) — one assertion that the site's locale
  is English, so a locale mismatch fails once with a clear message instead of as N locator timeouts.
  It lands with the locator policy it protects.

**Markup capture** — three POMs can only be captured in a post-backup state (`BackupHistoryTable`
needs `data-backup-id` rows, `JobRunModal` needs a live `startbackup`, `RestorePage.startFromHistory`
needs a record carrying `restoreurl`, V13). Capture therefore runs a **real database-only** backup on
`pro@nginx` — approved 2026-07-30 — which is fast and reverted by the plugin's own uninstall (6A
verified it leaves zero `backwpup*` options).

**Acceptance** — `npm run test:unit` covers every POM's locators; no POM contains a structural CSS
chain, a fixed sleep, or a `networkidle` wait; each method's completion signal is an assertion or a
named REST barrier.

### 6C — Onboarding & job configuration — **DONE**

**Shipped 2026-08-05, verified live on `pro@nginx`.** All six baseline intents are ported, plus three
scenarios the baseline never had. Decisions worth carrying forward:

- **The starting state is asserted, not seeded.** §4.6C originally said each scenario would seed the
  onboarding state by WP-CLI. It does not: installing the plugin *is* what puts a site into
  onboarding (V26), so writing that flag from the test side would work **and** would hide the day the
  plugin stops setting it. The Background instead asks for the dashboard and asserts it is redirected
  to onboarding — which also removes a race (V26) and makes the V10 redirect rule coverage every
  scenario re-proves. Seeding remains the right answer for 6D–6G, which need a site that is *past*
  onboarding.
- **Every scenario that finishes onboarding runs a real backup, and waits for it** (V24). Not
  politeness: mid-run the dashboard re-renders its job cards, and the `@plugin` teardown uninstalls
  the plugin at scenario end. The wait is on **WP-CLI, not on the page** — the first-backup screen
  only congratulates the user when the run was still going as the page reloaded (V27), so a fast
  backup would wait forever. The scenarios poll until the archive is in the history, then block on
  `wp backwpup status` so no job outlives the scenario.
- **Assertions are made twice, from independent sources.** The UI comes from the page objects;
  ground truth comes from `wp backwpup job --format=json` (contents, storage) and from the
  `backwpup_jobs` option itself for the settings that command does not expose (file areas, excluded
  tables). The two must agree. The one exception is the exclusions scenario, which asserts against
  the stored job only — re-reading those choices from the job card's panels needs dashboard
  interaction, which V28 shows is blocked; the scenario keeps its meaning because the stored
  configuration is the stronger of the two sources.
- **Job contents are compared as a set, in product language** — `describeJobContents()` maps
  `FILE, DBDUMP, WPPLUGIN` to "files and database", so a scenario reads in English and a harmless
  reordering of the plugin's own array cannot fail a test.
- Three scenarios were **added** beyond the baseline, all cheap because they never submit onboarding:
  a data type must be chosen before the schedule step, a destination must be chosen before onboarding
  can be completed, and stepping back through onboarding keeps the choices already made. All three are
  real product rules that had no coverage.
- The baseline's standalone "the dashboard redirects to onboarding" idea is **folded into the
  Background** rather than duplicated as a scenario of its own.

**Deliverables** — `features/onboarding.feature` (9 scenarios), `steps/onboarding.steps.ts`,
`pages/first-backup.page.ts` (+ its fixture and locator contract), `support/onboarding.ts`
(the onboarding flag: raw read + pure predicate) and `support/job-options.ts` (the `backwpup_jobs`
reader, the file-area vocabulary, and the job-contents naming). Shared additions:
`common/wp/options.ts` (`getOption`, `getOptionJson`) and `tablePrefix` in `common/wp/db.ts`, both
product-agnostic and unit-tested. Page objects gained `expectAtOnboardingPage`,
`expectCanContinueToSchedule`, `expectCanSubmit`, `expectAllFileAreasIncluded`,
`expectDefaultTableSelection`, `setTableIncluded`/`expectTableIncluded`, and
`close`/`expectClosed` on the data-selection panes. Unit tests **319 → 402**.

**Acceptance met** — the six baseline scenarios (plus three new ones) pass on `pro@nginx`; no sleep,
no `networkidle`, no CSS in Gherkin; each asserts the resulting job configuration through the UI
**and** through WP-CLI, with the single V28 exception noted above.

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

**Two things 6C hands over:**

- ~~V28 — the dashboard cannot be clicked.~~ **Cleared before this phase starts (§2.8).** The
  dashboard was never the problem: it is fully clickable, and the wedge that looked like a dashboard
  defect is gone with the Playwright 1.62.1 upgrade. `DashboardPage` and `panels.ts` are exactly as
  6B shipped them and need no fix. Two consequences for this phase: it inherits **no** blocker, and
  the two steps 6C cut (re-reading the data selection from a job card's own panels) can be
  **restored** here — they are one `openJobSidebar` call each and would close 6C's only
  single-sourced assertion.
- **The archives no longer pile up** (§7) — the `@plugin` teardown sweeps them. This phase still adds
  the deletion coverage that exercises the product's *own* controls, which is a different claim: that
  a user can delete a backup, not merely that the suite can.

**Seed past onboarding, don't drive it.** Every scenario here needs a site that is already set up, and
seeding is both faster and the reason this phase never meets §2.8's wedge in the first place.

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

- Untagged (Free's 12, V3): `job`, `backup`, `run`, `status`, `version`, `job-activate`,
  `backup-delete`, `backup-download`, `log` / `log-show` / `log-delete`, and **`kill`** (aborts a
  running job — pairs naturally with the abort coverage in 6D).
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

### 6H — Storage credential surface *(no credentials needed to build it)*

The half of the storage work that needs **no credentials at all**, so it can ship in sequence while
6H.2 waits. It is what makes 6H.2 a pure content phase later.

- **Config** — extend `ServiceConfig.storage` beyond today's `ftp` + `s3` with typed `msazure`,
  `sugarsync`, `rsc`, `glacier` (incl. its `useS3Credentials` fallback), each with `.env.example`
  entries, load-time validation, and per-site `overrides` support (already supported generically).
- **The skip gate** — a scenario whose provider has no credentials **skips with a named reason**,
  never fails. Testable *because* credentials are absent: with an empty `.env` every storage scenario
  must report "skipped: BWP_FTP_HOST not set", not error.
- **Isolation helper** — the `testInfo`-derived path/container name (§1.1), so parallel workers and
  repeat runs can never collide once real credentials arrive.
- **Provider-form coverage** — each provider's form is markup, not network: `StorageSidebar`'s
  per-provider locators are contract-tested in 6B and need no credentials.

**Acceptance** — `test:unit` covers the config validation and the skip gate; with no `.env` present a
storage scenario **skips with its provider named**, and the run is green.

### 6H.2 — External storage round-trips — **DEFERRED** *(blocked: needs credentials)*

The 11 baseline storage scenarios, re-tagged per V2 (only **Glacier** is `@pro`; FTP, S3, MS Azure,
Rackspace, SugarSync are untagged and so run on both editions). **Deferred by decision on 2026-07-30:
no storage credentials exist in this environment yet (there is no `.env` file at all), and nothing
else in Phase 6 depends on this.**

- Per provider: "configure in onboarding" and "configure from dashboard", each ending in a real
  backup that lands on the remote, verified there and then cleaned up.
- Exercises `StorageSidebar.testConnection()` (`cloudsaveandtest`) — written in 6B, first *run* here.
- **Teardown** — remote cleanup is best-effort and logged; it never fails a passing scenario.
- **Out of scope, stated:** Dropbox, Google Drive, OneDrive, HiDrive — interactive OAuth, no baseline
  coverage, no non-interactive credential path.

**Unblocks when** these land in `.env` (see `.env.example` after 6H): FTP and S3 at minimum; MS Azure,
Rackspace, SugarSync and Glacier for the full set.

**Acceptance** — each provider with credentials passes both scenarios and leaves no remote residue;
each provider without them still skips with a clear reason.

### 6I — Free edition + parity gate

- Add a **`free@nginx`** cell to `src/projects/backwpup/config/sites.json`, mirroring the existing
  `pro@nginx` (same shape, `"edition": "free"`, its own site so the two cells never share state) —
  everything untagged then runs on Free with **zero** new scenario code (V1, re-confirmed at the ref
  in §2.3). The Free artifact needs no manifest change: `resolveVariant` already maps
  `free` → the `free` APVM variant, and that build is already in the commit cache.
- Add the `@free` locked-storage upsell scenario (V2).
- **Parity review** against §2.1: every baseline intent is covered or has a written, deliberate
  reason not to be. A checklist in the PR — not a claim.

**Acceptance** — both cells green; the parity checklist is complete; no scenario is a
transliteration of its baseline ancestor.

---

## 5. Definition of done (phase-level)

- Every §2.1 intent is ported, superseded, explicitly declined, or **explicitly deferred** in writing.
  Exactly one deferral is open: the 11 storage round-trips of **6H.2**, blocked on credentials. Phase 6
  may close with it outstanding *only* because 6H ships the config, the skip gate and the isolation
  helper, so 6H.2 adds scenarios and nothing structural.
- Both `pro@nginx` and `free@nginx` cells green; `@pro`/`@free` scenarios run only on their edition's
  cells.
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
| Markup drift between 5.7.4 (verified) and `develop` (tested) | **Measured, not assumed: zero drift at the ref under test (§2.3)** — identical templates, REST routes and CLI commands. The 6B locator-contract spec, built from markup *captured* at that ref, turns any future drift into one clear unit-test failure. |
| Icon-only buttons have no accessible name (V7) | Documented as a legitimate `js-backwpup-*` / `data-content` case in the §3.2 policy — not a silent exception. 6B found a **second** such case (V16: every switch is an `sr-only`, `aria-hidden` checkbox with a textless label); both are handled in one place (`pages/toggles.ts`) and each is pinned by a test asserting the control really is unreachable by role, so a future accessibility fix is noticed rather than assumed. |
| Non-English admin breaks role/label locators | **Shipped in 6B**: the pre-flight asserts `determine_locale()` for the configured admin user and fails once, clearly, with the fix in the hint. Runs only after the transport checks pass, so a dead site reports one cause, not two. |
| Storage credentials missing / rate-limited | **Realised, and handled by deferral:** no credentials exist yet, so the round-trips are 6H.2 and out of the critical path. 6H still ships the surface — scenarios **skip** (never fail) without credentials, per-site `overrides` exist for rate-limited hosts, `testInfo`-derived paths keep workers isolated. |
| Restore rewrites the site under test | `@slow`, worker-bound site, re-auth after restore, run last in its cell. |
| Backup jobs are genuinely slow | `@slow` for CI splitting; real barriers (`startbackup`, `job-abort-status`) instead of long fixed timeouts, so the wait is as short as the job allows. |
| **Archives accumulate on the site under test** | **Realised, then fixed in the shared rails (2026-08-05).** BackWPup's uninstall keeps every archive it made, and a full backup of the `pro@nginx` site is ~340 MB, so each scenario left one behind — the cell reached **6.8 GB across 28 per-install directories**. The `@plugin` teardown now clears what a product declares it leaves (`ProductConfig.siteResidue` → `wp/residue.ts`), independently of whether the uninstall succeeded. Verified live: one scenario reclaimed **7 GB**, and a scenario that runs a real backup now leaves no archive behind. **One caveat, reported not failed:** the plugin creates `uploads/backwpup-restore` as `755 www-data`, which the ssh transport's user cannot unlink inside — it is ~24 KB and does not accumulate, so the sweep warns (with the fix in the message) rather than failing the run. Making it removable on a cell is an ownership change there, not a code change here. |
| Scope creep from "improve" | The improvement budget is §1.1 plus the V-facts. Anything else is a follow-up issue, not this phase. |

---

## 8. Verification sources

- **Baseline:** `wp-rocket-e2e/src/backwpup/**` (12 features, 28 scenarios), `utils/page-utils.ts`,
  `utils/commands.ts`, `config/wp.config.sample.ts` — read at `develop`, 2026-07-28.
- **Plugin (§2.2 baseline):** BackWPup **5.7.4 Free and Pro**, unpacked from
  `~/.apvm/cache/backwpup/releases/5.7.4/` — `components/`, `pages/`, `parts/`, `inc/`, `src/Cli/`,
  `src/**/API/Rest.php`. All V-facts in §2.2 cite the file that proves them.
- **Plugin (§2.3 ref under test):** commit **`c0dd22c2`** (`9.99.99`), **both** editions, from
  `~/.apvm/cache/backwpup/commits/9.99.99/c0dd22c/` — `backwpup-pro-en-…zip` (the build the cells
  install) and `backwpup-…zip` (Free, for 6I). Read 2026-07-30.
- **Target:** working tree at `develop` — `src/common/{fixtures,wp,artifacts,pages,visual}`,
  `src/projects/backwpup/`, `playwright.unit.config.ts`, `eslint.config.js`, `package.json`.
- **WP-CLI:** `wp cron event run <hook>` semantics — WP-CLI handbook, `commands/cron/event/run.md`.
