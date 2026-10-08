# Phase 6 — Feature porting: BackWPup first

> **Status:** in progress — **6A, 6B, 6C, 6D, 6E, 6F, 6G.0, 6G and 6G.1 are done** (6G shipped with 6G.1 folded in, §2.28, §4.6G; audited, §2.29; 6G.1 closed, §2.30); **6H.0 next — critical, added 2026-10-06** (§2.31, §4.6H.0: a plugin folder WordPress cannot see blocks every later install); 6H–6K deferred behind it (6K — restore from `.zip` and `.tar.gz` — added 2026-10-05, last in the sequence and required to close the phase);
> **6H.2 deferred** (needs storage credentials — see §4.6H.2).
> **Date:** 2026-07-28; revised 2026-07-30 (§2.3 re-verification at the ref; storage split),
> 2026-07-31 (§2.5 — post-implementation audit of 6B; four corrections, all verified live),
> 2026-08-05 (§2.6 — 6C shipped; seven further verified facts, three of them found by failing runs),
> 2026-08-26 (§2.8 — **V28 refuted and its cause fixed**; Playwright upgraded to 1.62.1, the 6A
> `chromium.ts` workaround deleted, **6D unblocked**) and 2026-08-28 (§2.9 — 6D shipped; the seeded
> setup proved equivalent to a real onboarding, and **three defects found and fixed**: two page-object
> claims that were false against the plugin's own markup and JS, and one plan assumption about
> WP-CLI's cron command), 2026-08-31 (§2.9 — a second adversarial round; **V48/V49** added and four
> more defects fixed, all of them wrong claims about WordPress core or the plugin's own API),
> 2026-09-01 (§4.6D.1 — what a backup *contains*, across files, database and both; **V50–V53**
> added, the download check strengthened to a full SHA-256, and a third adversarial round that fixed
> eight further defects — two of which would have let a broken backup pass — and a fourth round
> that fixed nine more, including two of round three's own fixes that did not actually work) and
> 2026-09-18 (§2.10 — 6E shipped; **V54–V63** added. The leftover-footprint sweep is in, verified
> against a deliberately reproduced dirty cell on both cells; **one shared-code defect found and
> fixed** — a forced Delete click that landed on nothing and reported the timeout as the plugin's
> fault — and **one of this plan's own claims corrected**: a dirty landing costs one scenario, not a
> whole run) and 2026-09-18 (§2.11 — a **`free@nginx` cell** was stood up and 6E's one open acceptance
> claim closed against it; **V64–V72** added. The Free edition is verified, not assumed, to leave the
> same footprint as Pro) and 2026-09-18 (§2.12 — **V70 closed**: the history assertions now read
> server-backed DOM, and a **second defect was found while fixing the first** — the reload barrier
> they depend on could settle on the previous page's request. **V73–V75** added) and 2026-09-18
> (§2.13 — **full audit of the 6E change set**: seven defects found and fixed, all in code the
> gates cannot see; **V76–V79** added) and 2026-09-22 (§2.15 — **full audit of 6F.0–6F.1**: fifteen
> findings fixed, one of them an assertion comparing a command with itself; **V97–V103** added) and
> 2026-09-22 (§2.17–§2.18 — **6F.2 shipped and the whole of 6F audited**; **V108–V119** added. A
> foreground `run` turned out to print no verdict at all, `status` to call an aborted run finished,
> and the shared SSH transport to hang on a silent link and crash the worker on a reset — now fixed)
> and 2026-09-23 (§2.18, continued — the audit's live re-verification; **V120–V122** added. Both of
> its "network" episodes were the runner asleep; a pooled SSH connection could be dead while reported
> connected, costing a scenario each time; and V96's activation race was reproduced on demand, shown
> never to have been closed by `finishActivation`, and fixed) and 2026-09-23 (§2.19 — **6F.3 shipped**;
> **V123–V133** added. §2.16's guess about logs was refuted — the web server's logs are writable by
> WP-CLI on these cells, its archives are not; four plugin bugs found and left unpinned — a refused
> delete poisons the next one, a download to an unwritable path fatals, `log-delete` removes the log
> folder's own guards, and a documented `--dry-run` would delete for real; and the `local` transport
> would have hung at any `[y/n]` prompt, now fixed) and 2026-09-24 (§2.20 — **the whole of 6F audited
> again**; **V134–V141** added. A refusal could pass for an empty list, a misspelt placeholder reached
> the plugin as job `0`, a reinstall mid-scenario wiped the log the fatal gate reads, and the "already
> running" scenario had been winning the race against its own backup by 0.06 s — all fixed) and
> 2026-09-24 (§2.21, §4.6J — **6J planned**: the staging area stays where and as it is, and the web
> server is told not to serve it — a `.htaccess` written with it, an nginx include for operators, and
> a pre-flight probe that measures the result; **V142–V145** added, both guards measured on the
> docker env's own Apache and nginx images) and 2026-09-24 (§2.22 — **6F.4 measured before it is
> built**; **V146–V167** added. `backup-encrypt` without a key, on a site that never saved one, destroys
> the archive and reports success — and so does every scheduled backup whose settings name RSA without a
> key; a wrong-length key crashes it; encrypting twice cannot be undone; decrypt cuts bytes it takes for
> padding, though never from the plugin's own archives; `--passwords` exports the site's database
> password, and importing it stores the password in clear; an import overwrite is a merge, and an import
> that fails part-way keeps what it wrote; with archive encryption on, foreground runs die of a memory
> limit the job set itself. Two source-read predictions refuted; **§4.6F.4 revised** against it all)
> and 2026-09-27 (§2.23, §4.6F.4 — **6F.4 shipped and audited**; **V168–V175** added. `develop`
> moved to `af1ab5c`, vendored libraries only, and every fact 6F.4 rests on was measured again
> there; the audit found the export scenario passing an export that carried nothing but its job's
> id — now held both ways — and a key-length rule that was the suite's choice, not the plugin's;
> the full `pro@nginx` run met V122's race in a new form, a PHP fatal in the host's own cron
> request) and 2026-09-28 (§2.24, §4.6G.0 — **6G.0 planned**, to ship before 6G; **V176–V179** added.
> On `local` and `docker` a command that cannot start, is killed or overflows its output cap throws
> an error quoting its whole argv, keys included; `ssh` never does) and 2026-09-29 (§2.25, §4.6G.0 —
> **6G.0 shipped**; **V180–V184** added. Exec errors name the program and the reason, never the
> arguments, on every transport; a NUL byte is refused before any transport; `parseJsonList` hides a key too) and 2026-09-30 (§2.26 — **V184 fixed**;
> **V185–V187** added. A paced database backup pauses once per table, so `cli-running-job.feature`'s
> window was each site's table count — 3.5 s on `pro@apache`; its database is now padded to 100 tables)
> and 2026-10-05 (§2.26 — **V188**: a killed run's padding is swept by the next BackWPup run) and
> 2026-10-05 (§2.27, §4.6G, §4.6K — **6G widened, 6K added**; **V189–V192** added. 6G now also restores
> backups *made* files-only or database-only, and asserts the half a partial restore skips is untouched;
> `.zip` and `.tar.gz` restores — each unpacked by different code, in the UI and the CLI alike — are 6K)
> and 2026-10-05 (§4.6G.1 — **6G.1 added**: the latest stable BackWPup restores in
> `uploads/backwpup-restore-<hash>`, which the teardown's literal residue paths never clear; to be
> measured when the sub-phase starts) and 2026-10-05 (§2.28, §4.6G — **6G shipped, 6G.1 folded in**;
> **V193–V208** added. `develop` had moved to `a612005`, whose hashed restore directory, created by a
> WP-CLI listing, broke the backup history page and every restore on Pro — so 6G.1 could not wait; the
> command-line restore turned out to delete what its archive does not hold, reset the database's
> collation and leave a world-readable snapshot in `/tmp`, so it now runs behind a copy of `wp-content`
> that is put back; and a restore was shown to overwrite the `debug.log` the fatal gate reads) and
> 2026-10-06 (§2.29, §4.6G — **6G audited**, adversarially; **V209–V225** added: residue families,
> the command-line restore's guard and the wizard's waits hardened, each finding reproduced first; the
> re-run found Ubuntu's tar refusing the put-back, which the guard contained and the copy's new layout
> fixes) and 2026-10-06 (§2.30 — **6G.1 closed**; **V226–V227** added: its open questions answered from
> the source, and a killed run's restore directory swept live; files backups capture the restore
> directory, credentials included when a restore was abandoned — a plugin bug) and 2026-10-06 (§2.31,
> §4.6H.0 — **6H.0 added as the next sub-phase**; **V228–V234** added. AutoE2E's BackWPup runs had been
> failing every scenario until someone deleted a half-removed `backwpup-pro/`: a removal cut short
> leaves a plugin folder WordPress does not list, and every install after it aborts on "Destination
> folder already exists". Reproduced locally; the QA servers kill PHP several times a week; this
> suite's own removal checks would pass such a folder as removed).
> **Parent:** [e2e-modernization-plan.md](e2e-modernization-plan.md) §9, Phase 6 — this doc supersedes
> that phase's summary. Phases 0–5 are done; Phase 6 is **feature content on finished rails**.
> **Baseline (reference only):** `wp-rocket-e2e/src/backwpup/` — 12 feature files, 28 scenarios, ~1.6k LoC.

## TL;DR

Phase 6 splits into **fifteen sub-phases**, of which 6F is broken down further (6F.0–6F.4). **6A** lands the shared rails every product needs (plugin
install/cleanup hooks, the debug-log gate, `@mobile`, an anti-pattern lint gate). **6B–6I** port
BackWPup — **page objects first (6B)**, then onboarding → backup & history → plugin deletion →
WP-CLI → restore → the storage credential surface → Free-edition coverage + the parity gate. The
storage *round-trips* are carved out as **6H.2** and **deferred** until credentials exist, so no
other sub-phase waits on them. **6J** is shared rails again, product-agnostic like 6A: it keeps the
staging area off the web. **6H.0** is shared rails too, and comes first: a plugin folder a cut-short
removal left behind must cost one scenario, never every scenario after it. **6G.1**, shipped with 6G, handles the restore directories the latest stable release names with a random suffix. **6K** closes the restore work: `.zip` and `.tar.gz` archives, after 6G's `.tar`. WP Rocket reuses 6A and gets its own breakdown, **deferred until after Phase 10** (§6).

**Execution order:** 6A ✅ → 6B ✅ → 6C ✅ → 6D ✅ → 6E ✅ → 6F ✅ (6F.0 ✅ → 6F.1 ✅ → 6F.2 ✅ → 6F.3 ✅ → 6F.4 ✅) → 6G.0 ✅ → 6G ✅ (with 6G.1 ✅) → **6H.0** → 6H → 6I → 6J → 6K → *(later)* 6H.2. 6H.0 goes before everything else still open (decided 2026-10-06: it is what keeps a continuously running cell from failing for good). 6J depends on nothing and can be pulled forward, but not ahead of 6H.0; 6K needs only 6G.

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
`page=backwpup` (V10); and the REST surface is larger than the baseline assumed (**24, not 21** — V8; re-measured to **26 registrations across two namespaces** in V49).

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
| `waitForTimeout(500 / 2000 / 180000)` | `onboarding.ts`, `utils/storage.ts`, `general.ts` | Deleted. The 3-minute schedule sleep → trigger the one due event (V40: **not** `wp cron event run <hook>`, which runs them all) (§2.2). |
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
| `wp-cli/list-jobs.feature` | 2 | Job count via WP-CLI | 6F.1 ✅ |
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
| V9 | **Partly superseded by V40 — read that row first.** Scheduling uses the WP-Cron hook **`backwpup_cron`** with `['arg' => <job_id>]` | `inc/class-cron.php`, `inc/class-page-onboarding.php:146` | `wp cron event run backwpup_cron` ("runs the next scheduled cron event for the given hook", WP-CLI handbook) fires it deterministically → the 3-minute sleep goes away and the assertion gets *stronger* (schedule registered **and** it produces a backup). |
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
  directory is world-writable — the refusal is the plugin's own check, not the filesystem's. **Refined by V84 (§2.14): the refusal is conditional** — it happens only when the web server
  wrote the archive, and the same command succeeds on one WP-CLI wrote itself. 6F.3 covers both;
  6D's cleanup still cannot rely on that command.

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

### 2.9 Facts established while building 6D (live, on `pro@nginx`, at `develop@90f9391`)

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V38 | **Zero drift at the ref under test — re-measured against latest stable.** `components/`, `pages/`, `parts/`, `pro/parts/` and `assets/js/` are **byte-identical** between BackWPup Pro **5.7.5** (the latest stable release, and what 6B's fixtures were captured from) and the `develop` build the cells install (`9.99.99-90f93911`). So is the whole of `src/` — every REST route, all 17 CLI commands, the onboarding classes. | `diff -rq` on both unpacked artifacts. What differs is `inc/`'s three archive-engine files (the Tar duplicate-entry sidecar work), the version header, the readme, the translation template and `vendor/` — 17 entries in all, none of them a surface any page object or barrier touches. `gh api …/commits/develop` confirms `90f93911` **is** `develop` HEAD. | The 6B locator contract describes the ref under test exactly, and the 24-route and CLI-command lists are re-confirmed. Recorded in the spec header and in `support/rest.ts` so the next reader does not re-derive it. |
| V39 | **A seeded onboarding is the real thing, not an approximation.** Onboarding sends **three** mutating requests, of which only two leave a mark: `cloudsaveandtest` → `BackWPup::get_destination('FOLDER')->edit_form_post_save([FIRST_JOB_ID])`; `updatejob` with an empty `storage_destinations[]`, whose only effect is overwritten by the submit moments later; and the form POST that `BackWPup_Page_Onboarding::save_post_form()` handles — which reads exactly **three** of the many keys the form sends. | The browser's own requests, recorded through a real onboarding (`job_id=&cloud_name=folder&backupdir=…&maxbackups=15`, then `admin-post.php` with `action=backwpup&onboarding=1&…`), plus reading `save_post_form()`. Then: both routes driven from the *same* fresh install and the resulting state diffed — **repeated for all three job-contents variants** (files, database, both). `wp backwpup job` output **byte-identical** every time, down to the job id; of the scheduled job's 133 stored keys only `backupdir` and `dbdumpdbpassword` differ, and both embed the per-install random `backwpup_cfg_hash`. The hidden placeholder job matches on 129/134, the five being that hash plus the three fields a completed run writes (`lastrun`, `logfile`, `backup_ids`). **Two differences are real and neither is onboarding's:** the real side also holds four options the admin UI writes on any visit (rating state, licence state, message queue — traced to `src/Admin/Rating/*`, `src/License/LicenseManager`, `src/Admin/Messages/API/Rest`), which a scenario re-creates as soon as it opens a screen; and the placeholder job's own cron event appears on either side depending on timing, since the plugin re-schedules every active job on activation. | `completeOnboarding()` (in `support/onboarding.ts`) is the setup for 6D–6G. It calls the product's own two entry points rather than writing job records, so the plugin keeps owning the schema, the cron registration and the placeholder cleanup — and it **verifies** the outcome instead of trusting the exit code. The job ids it assigns are the onboarding page's own rule (`$first + 1`, `$first + 2`), reproduced because they are decided while *rendering* a page the seeder never renders. The comparison was repeated for each job-contents variant, so none rests on another's evidence. |
| V40 | **`wp cron event run <hook>` runs *every* event on the hook, not "the next" one** — contradicting WP-CLI 2.12's own help text. Adding `--due-now` **does** restrict it to genuinely due events, and to that hook only. | Three events scheduled on one throwaway hook (−300s, −100s, +8600s): `wp cron event run <hook>` executed **all three**. Repeated with `--due-now`: executed **one**, left the future one alone, and did not touch a second hook that was also due. | Refutes the reading of V9 that 6D was going to build on. BackWPup schedules one `backwpup_cron` event **per job**, including a hidden placeholder job — so triggering by hook name would have run the wrong job and the scenario would have passed for the wrong reason. |
| V41 | **A BackWPup job must not be run inside WP-CLI.** `BackWPup_Job::need_free_memory()` compares its requirement against `convert_hr_to_bytes(ini_get('memory_limit'))`, which is **`-1`** when the limit is unlimited — so *every* requirement looks larger and the plugin **lowers** an unlimited limit to a finite one computed from current usage. | `inc/class-job.php:1523-1531`. Live: `pro@nginx` has CLI `memory_limit = -1`, and a cron run triggered through WP-CLI died with *"Allowed memory size of 77594624 bytes exhausted"* in `class-mysqldump.php`, then restarted and finished "with errors" after 360s. The identical job through the web server (PHP-FPM, 128–256M) finishes clean in 7s. | Both of 6D's ways of producing a backup go through the **web** context: the schedule is fired with WordPress's own `spawn_cron()` (`common/wp/cron.ts`), and arranged backups use `wp backwpup run <id> --background`, which asks the site over HTTP rather than running the job in the CLI process. |
| V42 | **`expectNoFailures` was blind to aborted backups.** The history row template gives `status = 'failed'` the class `backwpup-failure-icon` but gives `status = 'aborted'` `text-alert` instead — while **both** get the `delete-failed-backup` delete control, and neither gets Download or Restore. | `components/table-row-backups.php:198-221` (the icon branch) and `:109-123` (the shared action branch). | `BackupHistoryTable.failedRows` now filters on `[data-content="delete-failed-backup"]` — the plugin's own JS contract hook, covering both statuses. Pinned by two spec cases built from the template's real markup, one of which asserts the aborted row genuinely has no failure icon. |
| V43 | **"Apply" does not bulk-delete anything.** Its handler stores the selection, opens `#sidebar-bulk-delete-backups` and **returns without issuing a request**; the `process_bulk_actions` call happens only when that dialog's "Delete Backups" is pressed. | `assets/js/backwpup-admin.js:2178-2187` — the `action === 'delete'` branch stores the selection, opens the modal and returns; the request is at `:2204`, in the confirm handler. Found by a live run that hung waiting for a REST call that is never made. | `applyBulkAction` now stops at the confirmation and a new `confirmBulkDelete` owns the request — the same arm-then-confirm split the per-row delete already used. The modal and its button are pinned in the locator contract. |
| V44 | **The two cells arrange cron differently, so nothing may depend on the host's.** `pro@nginx` sets `DISABLE_WP_CRON` and runs a **per-minute** system cron that curls `wp-cron.php`; `pro@apache` does neither and lets WordPress spawn cron from page loads. | Both cells' crontabs and `wp-config.php`. | `spawn_cron()` is gated by neither, which is why the trigger uses it. The trigger therefore also has to cope with `spawn_cron()` declining while another run holds WordPress's `doing_cron` lock — it **outlasts** that lock rather than touching it (see V48). **Sampled, not assumed:** the lock was absent on all 12 probes over 65s on `pro@nginx`, so contention is rare. |
| V45 | **The dashboard and the Backups screen are the same template.** `page=backwpup`'s menu callback *is* `BackWPup_Page_Backups::page()`, so both render `pages/backups.php` — history table, bulk controls and all. | `inc/class-admin.php:473-483` (`add_menu_page`) and `:700-711`. | Confirms 6B's decision to let one `BackupHistoryTable` serve both screens, and means 6D's bulk coverage runs on the dashboard without a second navigation. The bulk controls are `max-md:hidden`, so a future `@mobile` scenario cannot use them. |

| V46 | **The 6C Background flake is a race in the plugin's own activation**~~**, and it is fixed.**~~ **Corrected by V122: the mechanism holds, the fix did not — the lifecycle's own active-state check is the first request after activation, so `finishActivation` never ran the routine and the window stayed open.** `wp plugin install --activate` **does not fire `init`**, and BackWPup defers `BackWPup_Install::activate()` to it — so straight after activation `backwpup_version`, `backwpup_onboarding` and `backwpup_jobs` are all still unset, and the routine actually runs in whichever *request* reaches `init` first. While the version is unset the plugin considers itself due a migration; a second request arriving before the first has written it re-runs the routine, sees the job the first just created, and takes the upgrade path — whose first statement is `delete_site_option( 'backwpup_onboarding' )` (`BackWPup_Migrate::convert_jobs()`). The site is then "onboarded" without ever having been. | Measured on `pro@nginx`: after `wp plugin install --activate`, `wp option get … --skip-plugins` reports all three options **absent**, and one ordinary WP-CLI call afterwards sets `backwpup_version=9.99.99` and `backwpup_onboarding=1` — **3 of 3** attempts. Two failing runs' own page snapshots show the dashboard with the onboarding flag gone (once with "Files"/"Database" cards, once with the placeholder job), which is what that path leaves. `pro@nginx` curls `wp-cron.php` **every minute** (V44) and so supplies the second request for free; `pro@apache` does not, and never failed this way. Ruled out first, by measurement: install→uninstall in isolation is clean **5/5**, the site has **no persistent object cache**, and `class_exists( \BackWPup::class )` is **false** after deactivation, so `uninstall.php`'s guard is not what skipped. | `finishActivation()` runs the routine in **one** WP-CLI request before the browser is let near the site, and asserts the site came out of it owing its onboarding. Once the version is written the migration path can never be taken again for that install, so the window is closed rather than narrowed. Called by `Given a freshly installed BackWPup` and by `completeOnboarding`, which makes the ordering a contract instead of a coincidence — and turns a leaked footprint from an earlier scenario into a clear failure at the point it is detected. |

| V47 | **The plugin's own table can outlive its uninstall, and then blocks the next install.** A run failed with `WordPress database error Table 'wp_bwpup_backups' already exists` and, in consequence, a site that never got its onboarding flag. Uninstalling drops that table **reliably in isolation** — 3 of 3 cycles, table present after activation, gone after uninstall, zero options left — so the leftover is a concurrency artefact: on a cell where something reaches the site every minute, a request that loaded the plugin before it was deactivated can finish *after* the uninstall and re-create the table through its own activation routine, leaving an orphan with no plugin behind it. | The failing scenario's own debug-log attachment (the `CREATE TABLE` error) plus the assertion `finishActivation` raised alongside it; the 3-cycle isolation loop on `pro@nginx`; and the site being completely clean (no plugin, no options, **no table**) when inspected afterwards. Same family as the orphaned InnoDB tablespace already recorded for `pro@apache` in the file-ownership plan. | **Not a defect in this phase, and no longer a confusing one:** `finishActivation` now names it at the point of detection — "a freshly installed BackWPup should owe its onboarding … an earlier scenario's footprint surviving its uninstall looks exactly like this" — with the debug-log gate attaching the PHP cause. Closing it properly means a **database** counterpart to `ProductConfig.siteResidue`, which belongs with **6E** — specifically **6E.0**, scheduled ahead of that phase's own scenarios and required to be verified empirically. |

| V48 | **Deleting WordPress's `doing_cron` lock is never a fix, and can truncate a running backup.** `spawn_cron()` declines only while the lock is *younger* than `WP_CRON_LOCK_TIMEOUT` — `if ( $lock + WP_CRON_LOCK_TIMEOUT > $gmt_time ) { return false; }` — so it **already ignores an abandoned one**, and clearing a stale lock cannot change its answer. Worse, the lock is set once at spawn and never refreshed, while `wp-cron.php` re-reads it between events and returns as soon as it differs: any cron run lasting longer than the timeout therefore holds a lock that merely *looks* abandoned, and deleting it aborts that run mid-way. | WordPress 7.1 core read on `pro@nginx`: `spawn_cron()`'s full body in `wp-includes/cron.php`, plus `wp-cron.php:194` (`if ( _get_cron_lock() !== $doing_wp_cron ) { return; }`) and `:201-202` (the run deletes its own lock when it finishes, so the normal case needs no help). `WP_CRON_LOCK_TIMEOUT` is `MINUTE_IN_SECONDS`, defined only `if ( ! defined( … ) )` (`wp-includes/default-constants.php:398`) — so a site may raise it, and this cell's `wp-config.php` already customises cron (`DISABLE_WP_CRON`, V44). Also confirmed there: core's duplicate guard in `wp_schedule_single_event` counts *all* past identical events as duplicates when the new timestamp is within ten minutes, which is why the event must be unscheduled **before** it is re-scheduled as due. | `triggerScheduledEvent` no longer deletes the transient at all — it outlasts it, with the budget read from the site (`min( 300, max( 70, WP_CRON_LOCK_TIMEOUT + 10 ) )`, the cap so an extreme value fails with an explanation instead of hanging) and the constant named in the failure message. A re-schedule that fails now **puts the original run back**, since the event is already unscheduled by that point. Three unit tests pin it: no `delete_transient` is emitted at all, the budget is derived from the constant, and both restore branches exist. |
| V49 | **BackWPup serves two REST namespaces, not one.** 26 `register_rest_route()` registrations at the ref under test: **22 under `backwpup/v1` and 4 under `backwpup/v2`** — `/messages`, `/storages`, `/save_job_format` and the parameterised `/backups/(?P<id>\d+)/type`. The namespaces come from `Rest::ROUTE_NAMESPACE` and `Rest::ROUTE_V2_NAMESPACE` (`src/API/Rest.php:7,9`). The v1 route `/chatbot-context` was missing from the table as well. | Every `register_rest_route()` call site in `src/**` read and grouped by the constant it passes. Cross-checked the other direction: all sixteen `waitForRest()` calls in the current page objects name genuine **v1** routes, so no live barrier was broken. | `BACKWPUP_ROUTES` is now a **route → namespace map** rather than a flat list, `matchesRoute`/`waitForRest` take the namespace from it per route, and a new `routeNamespace()` keeps messages reading it from the one verified table. The parameterised v2 route is documented as deliberately absent — it cannot be addressed by a fixed name. This was latent, not live, but the module's entire promise is that naming a route cannot silently produce a barrier that never matches; three tests now pin the v2 classification, including one asserting a v2 route is **not** matched under v1 — the assumption the old spec had encoded as a passing test. |
| V50 | **The two cells are not the same size, and one of them cannot afford a downloaded files backup.** `pro@nginx`'s docroot is **2.6 GB** — `wp-content/bigFiles` alone is 1.9 GB — on a disk that was **93% full (6.9 GB free)** when measured — since freed to 26 GB, but the archive size is the durable point; `pro@apache`'s is **209 MB** with 25 GB free. A default files job covers root + content + plugins + themes + uploads, excluding only `logs`/`usage`/`restore`/`restore_temp` at the root and a list of cache directories under `wp-content`, so `bigFiles` is **in**. | `du -sh` per area on both cells and `df -h`; the area defaults read from `inc/class-jobtype-file.php::option_defaults()`. | Archives are inspected **where they lie**, through `tar` over the transport (`common/wp/archive.ts`), never downloaded — a scenario that moved 2.3 GB per assertion would cost more than the rest of the suite together. Download fidelity is proved separately, against the smallest archive a site can make (the database job), where a full SHA-256 comparison is cheap. It also means no scenario may arrange **two** files backups on `pro@nginx`; the per-scenario residue sweep is what keeps the peak at one. |
| V51 | **A structural "did it dump the database?" check is wrong on one of the cells.** `pro@nginx`'s `DB_NAME` is `e2eSimple`, BackWPup names its dump `<DB_NAME>.sql`, **and that site's docroot already contains a 1.5 MB `e2eSimple.sql`**. So a files-only backup — which dumps nothing — contains a member named exactly like a dump, and an archive can legitimately hold two members of that name. | `wp eval 'echo DB_NAME;'` on both cells (`e2eSimple`, `backwpup`), the docroot listing showing `e2eSimple.sql`, and `generate_db_dump_filename()` → `generate_filename()` in `inc/class-job.php`. | The content assertions match on the **marker's value**, never on the presence or name of a member. A value planted for the scenario cannot appear in a file that was already there, so the same assertion gives the right answer on both cells. Recorded because the structural check is the obvious one to reach for, and it would have passed on apache and lied on nginx. |
| V52 | **GNU tar's read behaviour, measured rather than assumed.** It **auto-detects compression** on `-t`/`-x`, so one call serves `.tar` and `.tar.gz`. Member patterns **cross `/`** by default, so `*marker.txt` finds `wp-content/marker.txt`. And it reports "you asked for something absent" and "this archive is damaged" with the **same exit status, 2**, differing only in what it prints. | Archives built and queried in a throwaway `/tmp` directory on `pro@nginx` (GNU tar 1.35, present on both cells), then removed. | `archive.ts` declares no compression flag and uses `--wildcards` for member selection. **Superseded in part by the fourth round:** separating absent from unreadable *on tar's own words* was wrong and is gone — a truncated archive prints only `Not found in archive`, with no corruption line, so the wording cannot carry that distinction. Readability is now settled by behaviour: list with no pattern, believe the exit status. |
| V53 | **An interrupted run leaves the site dirty, and V47's message fires for it too.** Killing the suite mid-scenario skips the `@plugin` After hook entirely, so the plugin stays installed with its options and `wp_bwpup_backups` in place. The next run then fails in `finishActivation` with *"an earlier scenario's footprint surviving its uninstall looks exactly like this"* — the V47 wording — despite having nothing to do with V47's concurrency artefact. | Observed directly: a `pro@apache` run stopped mid-scenario left `backwpup-pro` active, **31** `backwpup*` options and the table behind. Recovering it by hand (deactivate as its own call, then `wp plugin uninstall` — never `uninstall --deactivate`) removed **all** of it: 0 options, table dropped, no cron events, leaving only the two empty `uploads/backwpup*` directories `prepareSiteDataDirs` creates. | **Two causes, one symptom.** Anyone meeting that message should rule out an interrupted run *first* — it is far commoner and trivially fixed — before chasing V47's concurrency window. It also confirms the plugin's own uninstall is complete when it actually runs, which narrows V47 further: the leftover table there is not a plain uninstall bug. **The suite recovers from this only when the plugin's *files* survive.** `ensurePluginAbsent` is gated on `isPluginInstalled`, which is `wp plugin is-installed` — a **file** test — so a kill landing mid-teardown (files already deleted, DB footprint not yet cleaned) leaves options and `wp_bwpup_backups` behind and the next run skips the uninstall entirely, having nothing to uninstall. Observed exactly so on `pro@apache`: no plugin directory, `active_plugins` still naming it, 30 options and the table present. This is the same remedy V47 needs and it sharpens the requirement: **6E**'s database counterpart to `ProductConfig.siteResidue` must key off the *footprint*, not off the plugin being installed. |

**One acceptance criterion is deliberately deferred**, in writing: §4.6D asked for "a deliberately
failed backup … detected via the failed-row branch". Provoking a *genuine* failure on a live cell is
not deterministic — the only product-supported way to force one is to abort a run, and a
database-only backup on `pro@nginx` finishes in about 7 seconds, so the abort would race the job it
means to stop. The branch itself is not untested: V42's fix is what makes the assertion correct in
the first place, and both of its statuses are pinned against the row template's real markup. The live
half belongs with **6F.2**, which introduces `wp backwpup kill` and can issue the abort from the same
process that starts the run. **Since proved feasible — V83 (§2.14) aborted a real run in ~1.4 s and
read back the `status = 'aborted'` history row — so 6F.2 carries this criterion rather than deferring
it again.** **Closed by 6F.2 (V117):** the abort scenario aborts a real run and asserts its history
row and the dashboard's aborted row — V42's branch — in the browser.

---

### 2.10 Facts established while building 6E (live, on both cells, at `develop@f1ebfd0`)

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V54 | **The state that poisons a run is reproducible on demand, and `wp plugin uninstall --deactivate` is how it happens.** That flag deletes the files while the plugin's own `uninstall.php` guard (`! class_exists( \BackWPup::class )`) skips the cleanup — the exact call this suite forbids, now shown to produce the exact leftover V53 observed. | On `pro@apache`: install, activate, `completeOnboarding()`, then that one call. Result: plugin files **gone**, **26 options** and `wp_bwpup_backups` present, `backwpup_onboarding` absent, `backwpup_version` still `9.99.99`. The suite then failed with, verbatim: *"a freshly installed BackWPup should owe its onboarding (`backwpup_onboarding` = undefined); an earlier scenario's footprint surviving its uninstall looks exactly like this"* (`support/onboarding.ts:110`). | 6E.0's requirement 1 met with the real message recorded. It is also the reproduction recipe: no kill is needed, and the state is reachable in three commands. |
| V55 | **The footprint alone does not break a run — the *missing onboarding flag* does.** A first attempt stripped the plugin immediately after install, never onboarding it; `backwpup_onboarding` was left behind at `1`, and the next run **passed**. | That run, which passed on a site carrying 27 leftover options. The mechanism, read from source: `BackWPup_Install::activate()` → `BackWPup_Migrate::migrate()`, whose `should_migrate( $old, $new )` needs `version_compare( $old, '5.0.0', '<' )` with `$old = get_site_option( 'backwpup_version', '0.0.0' )`. A leftover `9.99.99` makes it false, so `redirect_to_onboarding()` never runs and the flag is never set. A completed onboarding is what deletes that row (`class-page-onboarding.php:174`). | Recorded because the obvious short reproduction **does not reproduce it**, and a fix validated against it would have been validated against nothing. The seed has to include a completed onboarding. |
| V56 | **A dirty landing costs exactly one scenario, and the cell then heals itself.** The plan's framing — "a cell that starts dirty makes every later result suspect" — is stronger than what happens. | After the failing scenario of V54, a full-state snapshot of `pro@apache` was **identical to its clean baseline**: the Before hook had installed the files, so the After hook's `ensurePluginAbsent` found something to uninstall and ran the plugin's complete cleanup. | Sharpens what the sweep buys: not a suite-wide rescue, but the removal of one unexplained failure per dirty landing — and one that blames the product's onboarding for an environment fault. Worth doing, and worth not overstating. |
| V57 | **The plugin's own uninstall is complete, so the sweep only has to cover the case where it cannot run.** | `pro@apache`, full-state snapshot (every option name, every table, every distinct user-meta key, every role, the administrator's capabilities, every cron hook) before install versus after a proper deactivate-then-uninstall: **identical**, bar two incidental WordPress core transients. That includes `bwpup_backups_version`, which the plugin's own `uninstall.php` pattern (`LIKE '%backwpup_%'`) does **not** match — BerlinDB's `Table::uninstall()` drops it. | The sweep is a recovery path, not a second implementation of the uninstall. It is only ever reached when the files are gone. |
| V58 | **Two prefixes and a transient — a prefix match would have missed two of the three.** | The complete footprint, sampled every 6 s throughout a real UI scenario on `pro@apache` and unioned: 25 `backwpup*` options, `bwpup_backups_version`, the `wp_bwpup_backups` table, **and** `_site_transient_backwpup_gdrive_jobid_1` with its `_site_transient_timeout_…` row — on a cell with no cloud credentials configured. Three roles and eleven administrator capabilities. **No user meta at all.** | `optionsContaining` matches **anywhere** in a name, not as a prefix, and the declaration carries both `backwpup` and `bwpup`. Roles, capabilities and user meta are deliberately left out: none blocks an install, activation re-establishes them idempotently, and the next scenario's own uninstall removes them. |
| V59 | **Sweeping while the plugin is installed is undone by the very next request**, which is why ordering — not a flag — is the guarantee. | `pro@apache`, plugin active: deleting all 27 matching options and dropping the table left the site clean, and one ordinary `wp` call afterwards restored **all 27 and the table**. The plugin re-creates its own footprint on `init`. | Both callers sweep immediately after `ensurePluginAbsent`, which throws rather than return with the plugin still installed. `--skip-plugins` is defence in depth for the sweep's own request, not a substitute for the ordering. |
| V60 | **The sweep is a true no-op on a clean site, on both cells.** | Full-state snapshot before and after `removeSiteDbResidue` on `pro@nginx` and `pro@apache`: **byte-identical** each time, one read and no write, and no privileged command — it is WP-CLI and SQL, never the filesystem. | 6E.0's requirement 3 met. The over-match guards are not theatre either: `backwpup-helper`, a real plugin installed on both cells, stores `bwh_debug_monitor` — it does not collide, but it is exactly the kind of neighbour a careless fragment would sweep. |
| V61 | **A hard kill produces the *other* dirty state, which the suite already recovered from.** | Killing the whole process tree mid-scenario on `pro@nginx` left the plugin **installed** with its 26 options and its table — the shape `ensurePluginAbsent` has always handled. The files-gone shape is not reachable by a kill at all: `wp plugin uninstall` removes the rows and the files in one call, so it arises only when `uninstall.php`'s own guard skips the cleanup (V54). Also measured, and the reason interrupted runs so often look self-healing: killing only the Playwright **parent** leaves the worker process alive, and it finishes the teardown. | 6E.0's requirement 4, answered honestly: the interrupted case was reproduced, and what it produces is the recoverable one. The sweep's case is V54's, which was reproduced separately and recovered (requirement 2). |
| V62 | **Deleting through wp-admin runs the plugin's uninstall; `wp plugin delete` does not.** | WP 7.1.1 on the cells, `wp-admin/includes/plugin.php`: `delete_plugins()` calls `is_uninstallable_plugin()` and then `uninstall_plugin()` before removing any files. | It is the only flow in which the complete removal a *user* performs can be observed, which is what makes 6E.1's footprint assertions worth making — and why they belong on the admin screen rather than on a WP-CLI call. |
| V63 | **`force: true` on the Delete click was silently breaking deletion**, and had been hiding behind a timeout message that blamed the plugin. | `pro@apache`, probed in the page at the moment of the click: `#delete-backwpup-pro` reported `visibility: visible` with a sane box (288, 477, 39×16; viewport 1600×700, `scrollY` 0) — yet `document.elementFromPoint` at its own centre returned the **document root**. A forced click skips the "receives pointer events" check, so it landed on nothing and produced **no request whatsoever**: not the AJAX, not even the plain navigation the link falls back to. The identical page, clicked **without** `force`, raised the confirm, fired `delete-plugin` and removed the row first time. The trace of the failing run agrees: after the post-deactivate document loaded `updates.min.js`, nothing left the browser for ten seconds until an unrelated poll. | `PluginsPage.delete` no longer forces the click, and waits for the post-deactivate page's `load` first so WordPress has wired the action. Pinned by a unit test that fails with `force: true` restored, and — after §2.13 — by a second one that fails if the `load` wait goes. The old comment claimed the ordinary wait "can stall"; measured, it does not — and when it does, Playwright's actionability log says what the element was doing, which "no response arrived" never could. |

### 2.11 Facts established validating the `free@nginx` cell (live, at `develop@f1ebfd0`)

The cell is `bwu.e2e.rocketlabsqa.ovh` — its own site and its own database, on the same host as
`pro@nginx`. Everything below was measured against it; where a claim compares the editions, both
were built by APVM from the **same commit**, so the comparison is of packages and not of releases.

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V64 | **The untagged suite runs on Free with zero new scenario code.** | `bddgen` + `--list` for `free@nginx` generates all 22 scenarios (24 tests with the two setup projects), and the artifact preflight verified the Free identity — `backwpup-9.99.99-f1ebfd05.zip`, slug `backwpup/`, header `BackWPup` — from APVM's `free` variant with no manifest change. Full suite: **24/24, every scenario first attempt**, 26.1 min. | **V1 confirmed live** and 6I's first bullet done. Nothing in the ported scenarios names an edition. |
| V65 | **The two editions ship a byte-identical `uninstall.php`, and Free is a strict subset of Pro.** | Both variants built from `f1ebfd05`. `uninstall.php` SHA-256 `edc75fe00dd0c895…` on both. `src/Backup/Database/Tables/Backup.php` identical too, declaring `$name = 'bwpup_backups'` and `$db_version_key = 'bwpup_backups_version'`. File sets: **266 files in Pro only, 0 in Free only**. | The 6E footprint declaration is edition-independent **by construction**. This is the claim §4.6E previously had to leave as "expected". |
| V66 | **Free's leftover footprint is the same shape as Pro's, and the declaration misses none of it.** | V54's recipe on `free@nginx` left **26 options and `wp_bwpup_backups`** (plus 3 roles and 11 administrator capabilities, which are deliberately not declared). `findSiteDbResidue` matched **all 26 options and the table, with none unmatched**. Cross-checked against the source: every literal `add_option` / `update_option` / `set_transient` / `update_user_meta` name in the Free package outside `vendor/` contains `backwpup`. | The sweep then recovered the cell — the hook printed *"before installing, cleared a leftover plugin footprint from the site: 26 option(s), 1 table(s)"* and the scenario passed. 6E.0 is verified on Free as well as Pro. |
| V67 | **The option match relies on a case-insensitive collation, and that is not free.** | The Free source stores a site transient under a capital-B prefix (`set_site_transient( 'BackWPup_' …)`). On the cell `wp_options.option_name` is `utf8mb4_unicode_520_ci`, and `SELECT 'BackWPup_probe' LIKE '%backwpup%'` returns `1`. | The fragments do catch it. Recorded because a site created with a `_bin` or `_cs` collation would **not**, and silent under-matching is the one failure mode this declaration cannot detect by itself. |
| V68 | **Free is a third cron arrangement, and the most concurrent of the three.** V44 recorded two; this cell does **both**. | `bwu`'s `wp-config.php` does **not** define `DISABLE_WP_CRON`, *and* the host curls its `wp-cron.php` every minute — `pro@nginx` defines the constant, `pro@apache` has no system cron. Read on the cell: `add_action( 'init', 'wp_cron' )` is guarded only by `DOING_CRON` (`default-filters.php:412-414`), and `_wp_cron()` returns early only when `DISABLE_WP_CRON` is true. So here every request with due work spawns `wp-cron.php` **as well as** the per-minute poke. | It supplies V46's second concurrent request more readily than any other cell. Defining `DISABLE_WP_CRON` on this site would align it with `pro@nginx` and lose nothing, since the system cron already runs the schedule. **Since applied — the site now defines it (V119, 2026-09-22).** |
| V69 | **The activation path is sound on Free; what fails is the known race.** | **10 of 10** install → bootstrap → read cycles on `free@nginx` came out owing their onboarding (`backwpup_onboarding = "1"`, `backwpup_version = 9.99.99`). Under a full suite with **retries disabled**, 2 of 22 scenarios hit V46's missing-flag failure; the same 22 with the suite's own retry policy passed **24/24, none retried**. | Not an edition or configuration defect — V46/V47's window, made likelier by V68. The suite's retry policy already absorbs it, which is what retries are for. |
| V70 | **One genuine robustness gap, exposed by this cell and not caused by it.** `the backup history shows {int} backup(s)` asserted a **polled** table with Playwright's **default 5 s**, immediately after `waitForBackup` had returned on server-side truth. | Measured on `free@nginx`: archive on disk at **+3.3 s**, job finished at **+8.5 s**, row in the DOM at **+9.5 s** — a **1.0 s** margin when healthy, with a much longer tail. | **Closed 2026-09-18 — see §2.12.** The step now re-reads the history from the server before asserting, which removes the race rather than widening it. |
| V71 | **Two `headers already sent` warnings are this site's, not the edition's.** | The deletion scenarios log two PHP warnings from core's `wp_redirect()` (`pluggable.php:1539` and `:1542`) on `bwu`. The identical scenario on `pro@nginx` logs **none**, and an unauthenticated `/wp-admin/` redirect logs none on either site. The cause was not isolated further. | Reported, never fatal: the debug-log gate fails on fatals and logs warnings. Worth knowing only so nobody attributes it to the plugin. |
| V72 | **The Free cell is not a mirror of `pro@nginx`, and the differences matter operationally.** | Own database (`wp_bwu_e2e_rocketlabsqa_ovh` vs `e2eSimple`) and own docroot, but the **same host and the same disk**. Docroot **3.6 GB** (3.3 GB of it `wp-content/bigFiles`) against pro's 2.6 GB, on a volume **81 % full with 20 GB free**. `query-monitor` (with its `db.php` dropin) and `imagify` are active here and not there; `wp-crontrol` there and not here; the themes differ. | V50's rule — never arrange two files backups at once — binds harder here, and the two nginx cells **must not run files-backup scenarios concurrently**, because one disk serves both. The differing plugin set is coverage rather than a problem, and it is where V71 comes from. |

---

### 2.12 Facts established closing V70 (live, at `develop@f1ebfd0`)

V70 was left open on the grounds that the choice between "raise the budget" and "re-read
server-backed DOM" was a judgement call. It was not: reading the plugin's own JavaScript settles
it, and the same reading shows that neither option as originally framed was quite right.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V73 | **The history refreshes from a client-side poll that a test cannot wait on.** `backwpup-generate.js` asks `admin-ajax.php?action=backwpup_working` every **750 ms** and only fires its `backup-complete` event once that reports `job_done`; `backwpup-admin.js` listens for that event and re-fetches the listing. Whether any of it runs depends on a race inside the plugin: pressing *Backup Now* reloads the page (`startBackupProcess`, immediately on status 200 and after 750 ms on 201), and a job that finished before the reload lands leaves **no poll running at all**. | Read at the ref under test: `assets/js/backwpup-generate.js:56`, `assets/js/backwpup-admin.js:2376` and `:2341-2365`; `inc/class-page-jobs.php::ajax_working` (which reports `job_done` once the working data is gone), `inc/class-admin.php:1257` (`backupslistings` → `rest_url('backwpup/v1/backups')`). | **No barrier can fix the assertion in place.** Both outcomes issue the same `backups` call, so nothing distinguishes the stale fetch from the fresh one, and the refresh may never happen. Re-reading from the server is the only non-timing-dependent form of the assertion — so raising the budget was never the cheaper half of a trade-off, it was the option that keeps the race. |
| V74 | **The reload the fix leans on had a defect of its own, found by the test written for the fix.** `BackupHistoryTable.reload()` armed a `waitForRest(page, "backups")` barrier around the navigation. That barrier settles on the **previous** page's listing request, which is still in flight at that moment — so it reported on a page that no longer existed, and the non-ok check it performed was not against the response the read depends on. | Observed directly: a spec case serving the listing as **500** passed 3 of 4 runs against that implementation, because the response matched was the earlier page's 200. | The barrier is gone. Correctness now rests on the navigation plus the loading placeholder, which is exact: the server renders `tr#backwpup-backup-history-loading` unconditionally (`components/table-backups.php:29`) and only `refreshBackupTable` replacing the whole `tbody` removes it — and that runs only for a listing that reports success. A failed listing therefore fails the read instead of reading as a history that emptied itself. |
| V75 | **The fix holds on every cell, with retries disabled.** | `backups.feature` with `E2E_RETRIES=0`: **5/5** on `free@nginx`, **5/5** on `pro@nginx`, **5/5** on `pro@apache`, plus **6/6** repeats of the two scenarios that exercise the race on `free@nginx`. **21 scenario executions, no failures, nothing retried.** Unit suite **737 passed / 8 skipped** (six new cases); typecheck, lint and format clean. | The two history assertions (`the backup history shows {int} backup(s)`, `no backup in the history has failed`) each re-read the history first, so each stands alone — the second mattered most, because "no row failed" is trivially true of the zero rows a stale table shows. |

**One of this plan's own claims corrected.** V70 cited "the failing run's own snapshot shows the
dashboard still reading *Backup Scheduled!*" as evidence of a long tail. That string is from
`views/notice/notice_upgrade_to_pro.php` — an upsell notice, not the job-progress UI — so it says
nothing about how far behind the table was. The measured timings in V70 stand; that sentence does
not, and has been removed.

### 2.13 Facts established auditing the 6E change set (2026-09-18)

A full re-read of everything 6E touched — 18 changed files and 8 new ones — against the plugin
source at the ref under test. Every defect below was **invisible to typecheck, lint, format and the
739-test unit suite**, which is the point: they are in the layer those gates do not reach.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V76 | **Four code comments named plan phases**, which this repo's conventions forbid outright — plans move, rename and get deleted, and code must stand alone. | `support/db-residue.ts` ("an edge case of 6H"), `support/footprint.ts` ("the bug 6E.0 spends its time recovering from") and two cases in `hooks/plugin-lifecycle.spec.ts`. | All four rewritten to say the thing instead of citing where it was decided. A `grep` over `src/**/*.ts` for plan phases, `docs/plans` and `§` now comes back empty, which is the check worth keeping. |
| V77 | **Two TSDoc blocks were orphaned by insertion**, leaving two functions undocumented and two carrying someone else's doc. | `hooks/plugin.hooks.ts`: `declaredResidue` was inserted between `scenarioReport`'s doc and `scenarioReport`. Identical slip in `plugin-lifecycle.spec.ts` between `files()` and `wpCalls()`. A third: `installPluginUnderTest`'s database-sweep rationale sat **inside** its `@param artifact` description. | Restored. The class of mistake — inserting a documented helper directly above an existing one — is worth knowing about, because nothing in the toolchain notices it. |
| V78 | **Six `{@link}` targets could not resolve**, against a baseline of one in nine untouched modules. | Checked mechanically across the change set: `{@link ./residue.ts}` (a file path is not a declaration reference, and it is the only one in the repo), plus `PROTECTED_SITE_PATHS`, `ensurePluginAbsent`, `BACKWPUP_SITE_DB_RESIDUE` and `PluginsPage.delete` — all named from files that do not import them. | Rewritten as plain code references. A link that does not resolve is worse than no link: it reads as a promise the IDE does not keep. |
| V79 | **Three real code defects**, each small and each with a failure mode worth naming. | (a) `PluginsPage.delete`'s new `waitForLoadState("load")` took no timeout, so it silently used the navigation default instead of the caller's budget — every other wait in that method takes it. (b) The `load` wait itself, added for V63, had **no test at all**, while the `force` half it shipped beside did. (c) `readBackwpupFootprint` builds `WHERE` from the shared fragment list with no guard: emptied, the query fails, `get_col` returns `[]`, and the site reads as holding **nothing of the plugin** — which is exactly the answer the deletion scenarios look for, in a module whose own doc calls that trap out. | (a) fixed; (b) pinned by a stand-in wp-admin whose Delete handler arrives on a blocking script, **verified to fail without the guard** (`PluginDeletionFailedError`, the live symptom) and to pass with it; (c) the snippet now refuses instead of answering. |

**Also recorded, not fixed.** `BackupHistoryTable.expectRowCount` counts one **page** of the history:
the listing is paged ten rows at a time, client and server agreeing on that default
(`inc/class-admin.php:1279`, `src/Backups/History/Frontend/API/Rest.php:159`). Every scenario counts
in single digits, so nothing reaches it; the method now says so rather than leaving the next author
to find out.

**A new intermittent, seen once and not reproduced.** On `pro@apache`, *"Deleting the plugin after it
has made a backup"* failed in setup with `completing onboarding should leave exactly one scheduled
backup job` — the site held a `files and database` job **beside** the requested `database` one. The
same scenario passed on `pro@nginx` and `free@nginx` in that run and **3/3 on immediate re-run** with
retries disabled, so the cell healed itself as V56 describes. It is **distinct from V46/V47/V69**,
which are the missing-*flag* race, and it is upstream of everything 6E changed. Not diagnosed
further and deliberately not "fixed": the mechanism was not reproduced, and `completeOnboarding`'s own
freshness assertion did the right thing — it refused a site that was not in the expected state and
said what it saw, rather than failing later as a puzzling claim about the wrong job.

**Verification after the audit.** Unit **739 passed / 8 skipped** (737 before); typecheck, lint and
format clean. Live, with `E2E_RETRIES=0`: `plugin-deletion.feature` **3/3 on `pro@nginx`**, **3/3 on
`free@nginx`**, **2/3 then 3/3 on `pro@apache`** — 12 scenario executions, the one failure above.

---

### 2.14 Facts established planning and building 6F (live, on both nginx cells, at `develop@f1ebfd0`)

Both editions were rebuilt with APVM at the ref the cells install, unpacked and read, and **every**
claim below was then exercised against a real site: BackWPup Pro installed on
`simple.e2e.rocketlabsqa.ovh`, onboarding seeded, jobs run, aborted, exported and encrypted, then the
plugin removed and the site verified clean. Nothing here is inferred from source alone.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V80 | **The registered set is exactly 17 commands in Pro and 12 in Free**, and `wp backwpup --help` prints it as a parseable `SUBCOMMANDS` block. An unknown name fails with `'<name>' is not a registered subcommand of 'backwpup'` (exit 1). | Live `wp backwpup --help` listed all 17 canonical names; `src/Cli/Commands/` holds 18 files (17 commands + the `Command` interface). Pro-only = `Restore`, `BackupEncrypt`, `BackupDecrypt`, `JobExport`, `JobImport` — V4 re-confirmed at this ref. | The registration probe in 6F.0 parses that output, so a renamed or unregistered command fails as *"not a registered subcommand"* rather than as an empty list — which is §4.6F's acceptance criterion, met by mechanism rather than by care. |
| V81 | **`wp backwpup status` is a blocking follower, not a snapshot.** Idle it prints `Success: No job running.` and exits 0. While a job runs it loops until the plugin's running-file disappears, *then* reads the log header and exits **1** on errors, 0 on warnings or a clean run. | `src/Cli/Commands/Status.php` — the `while (true)` on `running_file`, and the verdict **after** the loop, not inside it. Idle answer confirmed live. | `status` cannot be polled and needs a budget of its own; it is the natural completion barrier for `run --background`, and the reason `support/backups.ts` reads its verdict from the log instead. **Refined by V115:** for a run aborted under it, it answers `Job finished.` |
| V82 | **Foreground `wp backwpup run <id>` works on this cell.** It runs the job *inside* the WP-CLI process, streams the job log to stdout and exits 0 — a 39.6 MB database job in **1 second** (6.4 s wall, including SSH). | Live, job 3. The archive it wrote was owned `ubuntu:ubuntu`; the `--background` run's was `www-data:www-data`. | `run` has **two** genuinely different execution contexts to cover, and the history records which: `wp_bwpup_backups.backup_trigger` is `wp-cli` for the foreground run and `backup_now_job` for `--background`. The caution in `support/backups.ts` is about the memory limit a *large* job computes for itself, not a blanket prohibition. **Refined by V108:** it exits 0 whatever the job logged, with no verdict line. |
| V83 | **`wp backwpup kill` aborts deterministically and leaves the aborted history row.** Idle it is idempotent (`Success: Nothing to abort.`, exit 0). Against a running files-and-database job: running detected **1.4 s** after dispatch, `kill` exited 0, the job stopped **1.4 s** later, and `wp_bwpup_backups` gained a row with `status = 'aborted'`. The run logged **2 warnings, 0 errors** and produced **no archive**. | Live, full sequence: seed → set job type → `run --background` → poll → `kill` → poll → read `wp_bwpup_backups` and `wp backwpup log`. | **This closes §2.9's written deferral.** V42's aborted branch (`text-alert`, `[data-content="delete-failed-backup"]`) can be asserted against a real abort. Note the verdict is **warnings**, not errors — a scenario expecting "errors" would fail, and the archive count does not move. |
| V84 | **`backup-delete`'s permission refusal is conditional on who wrote the archive** — §2.6 recorded it as unconditional. Deleting an archive the **transport's user** wrote (foreground `run`) **succeeds**; the same command on one the **web server** wrote (`--background`) exits 1 with `Could not delete backup archive "…", check permissions!` and **the archive survives**. | Live, both directions on the same site and the same job minutes apart: `ubuntu:ubuntu 664` deleted, `www-data:www-data 644` refused, with the containing directory `0777` throughout. | Both are real user situations, so 6F.3 covers both rather than choosing one. It is the plugin's own writability check, not the filesystem's — the directory permitted the unlink in both cases. §2.6's absolute wording is superseded by this row. |
| V85 | **`backup-encrypt` / `backup-decrypt` need no settings and no credentials** — `--key=<hex>` is read before the settings lookup. Encryption is **in place, under the same filename**; the round-trip restores the exact original size (41 528 320 → 41 528 346 → 41 528 320 bytes). | `src/Cli/Commands/BackupEncrypt.php` — the `--key` branch precedes `get_site_option( 'backwpup_cfg_encryption' )`. Live round-trip, plus refusals: a non-hex key, a missing archive, and decrypting an already-plain archive (`Archive not needs decryption.`). | The one `@pro` pair that costs nothing to arrange beyond having an archive — no `backwpup_cfg_encryptionkey`, no storage credentials — so it ships long before 6H. Because encryption is in place, the round-trip is provable only by checksum, not by a filename. |
| V86 | **`job-import` appends or overwrites, by argument.** Without `--job_id` it creates a **new** job with a fresh id; with `--job_id=<n>` it overwrites that job. `job-export <id> --file=<path>` exits 0; with no jobs at all it prints `[]` and exits **0**, not the `Nothing to export!` its source suggests. | Live round-trip: export job 3 → import → id **4** created → import `--job_id=3` → job 3 overwritten. Refusals: a missing path, and `wp-config.php` → `File is not a valid JSON file!`. | Two distinct behaviours out of one command, both worth a scenario. The empty-export answer is an empty list, so an assertion there must not expect an error. |
| V87 | **Empty states answer; they do not fail.** On a fresh install `job` and `backup` report `0` / `[]` at exit 0, and `log` prints `No logs found.` — plain text, **exit 0**, not JSON. The hidden "First backup" (`backwpup_first_backup_job_id`, flagged `tempjob`) and "Backup Now" jobs are excluded from `job`, so even a freshly onboarded site counts **0** until a real job exists. | Live on a fresh install, before and after seeding onboarding; the exclusion at `src/Cli/Commands/Job.php` (the `tempjob` / backup-now guard) and `inc/class-install.php` (where the temp job is created). | The baseline's "1 job / 3 jobs" counts survive the port unchanged rather than needing an offset, and `support/backups.ts`'s existing `NO_LOGS` special case becomes a pinned contract instead of a defensive guess. |
| V88 | **`job` and `backup` share one read surface** — `--format=table\|json\|csv\|yaml\|count\|ids`, `--field=`, `--fields=`, and `--<field>=<value>` filtering by case-insensitive **substring**. An unknown `--field` exits 1 with `Invalid field: <name>`. | Live: `--format=count` / `ids`, `--field=job_id`, `--fields=job_id,legacy,archive_format`, and `--type=dbdump` → 1 against `--type=file` → 0 on a database-only job. | One shared step vocabulary covers both commands, which is what lets 6F.1 be mostly feature text rather than new step code. **Correction:** an earlier revision of this row said `log` shared the same surface. It does not — see V91, which supersedes that half. |
| V89 | **Every alias is live**, including the two the baseline used (`jobs`, `backups`). 16 of the 17 commands declare one; `version` does not. | Live `wp backwpup jobs --format=count` and `wp backwpup backups --format=count` both exit 0; the `@alias` docblock tags across `src/Cli/Commands/`. | 6F targets the **canonical** names and must not assert that an alias is unregistered (V3). One scenario proves the two the baseline depended on still resolve, and nothing else spends coverage on them. |
| V90 | **`--field=<unknown>` only fails when the list is not empty.** With at least one job, `wp backwpup job --field=nope` exits 1 with `Invalid field: nope`; with **no** jobs it exits **0** and prints nothing at all. | `src/Cli/Commands/Job.php` — the `if ( ! $items ) { return; }` guard sits *before* the field is validated. Measured both ways on the same site minutes apart: 0 jobs → exit 0 and silence, then 1 job → exit 1. | 6F.1's "an unknown field is refused" scenario **must arrange a job first**, or it passes against a command that never looked at the field. Found by running 6F.0's shipped module against a live site rather than by reading the source — which is why that step is part of the work and not a formality. |
| V91 | **`log` is a different read surface, not a third copy of the same one.** It takes `--fields=`, `--format=table\|csv\|json\|yaml\|count` and its *own* named filters (`--search`, `--job_id`, `--type`, `--after`, `--before`, `--orderby`, `--order`, `--limit`) — but **no `--field=`, no `--format=ids` and no `--<field>=<value>`**. Because its docblock declares no such options, WP-CLI rejects them from the synopsis *before* the command runs: `--field=nope` exits 1 with `Error: Parameter errors: unknown --field parameter`, and `--format=ids` with `Invalid value specified for 'format'`. | `src/Cli/Commands/Log.php` — the `## OPTIONS` block and the hand-written filters, against `Job.php`/`Backup.php`'s `[--<field>=<value>]` and `[--field=<field>]`. Both refusals measured live on a site holding one log. | 6F.1 covers the two surfaces separately: `job` and `backup` share the generic contract, `log` is asserted on what it does document — the `--fields`/`--format=json` shape `readLastRunOutcome` depends on, and `--job_id` filtering. Asserting a uniform surface would have failed on a command that never claimed one. |
| V92 | **A fresh install already stores a job, and `job` lists none of it.** Immediately after install + activation the `backwpup_jobs` option holds exactly **one** record — id 1, flagged `tempjob` — while `wp backwpup job --format=count` reports **0**. After onboarding the option holds **two** (the placeholder and the real job) and the command reports **1**. | Live on a clean site, read through `readStoredJobs` before and after seeding onboarding. | This is what makes 6F.1's empty-state and count scenarios non-vacuous: every one of them asserts that the site *is* holding a hidden job before asserting that none was listed. Without that half, "no hidden jobs were listed" would be trivially true of a site that had none. |
| V93 | **The dashboard's "add new backup" card is `POST backwpup/v1/addjob`**, taking `type=files\|database\|mixed`, and it can be dispatched in-process: `wp_set_current_user( <administrator> )` then `rest_do_request()` creates the job, its id, its defaults and its WP-Cron event. The route and the `backwpup_jobs_edit` capability it checks exist in **both** editions. | `assets/js/backwpup-job.js` → `backwpupApi.addjob`; `src/Jobs/API/Rest.php` (`add_job`, `has_permission`). Live on Pro (jobs 4 and 5 created, `job --format=count` 1 → 3) and on Free (job 2 created with its `backwpup_cron` event). | Gives 6F.1 the baseline's three-job state without opening the dashboard, and without this suite writing a job record itself — the plugin owns that schema. Shipped as `addBackupJob`. |
| V94 | **`wp backwpup <name> --help` is a safe registration probe.** It dispatches without running the command: on Pro every Pro-only command answers exit 0 with its help page (no pager, over `ssh`), on Free all five exit 1 with the same `'<name>' is not a registered subcommand of 'backwpup'.` an unknown name earns. | Live, both editions on the same site minutes apart: `restore`, `backup-encrypt`, `backup-decrypt`, `job-export`, `job-import`. | 6F.1 proves the edition split by **behaviour** rather than by re-reading the help list — and `--help` is the only probe that may be pointed at `restore`, whose `<file>` argument is optional, so running it bare on Pro would not be refused by the synopsis. |
| V95 | **`backup` attributes an archive to whichever job enumerated it last.** With three jobs sharing one backup directory, the single archive job 3 wrote is reported with `job_id` 5. The command walks every non-`tempjob` job, lists that job's destination folder, and keys `$items` by the archive's **timestamp** — so the last job to see a file overwrites the earlier attribution, and two archives written in the same second would collapse into one row. | `src/Cli/Commands/Backup.php` — `file_get_list()` per job, `$items[ $backup['time'] ] = …`. Live: one archive, `--format=count` 1, `--field=job_id` 5. | No scenario may assert `backup`'s `job_id` on a site with more than one job. The existing history assertions are unaffected (they run with a single scheduled job), and 6F.1's count scenario deliberately asserts on `job`, never on `backup`'s attribution. |
| V96 | **V46's activation race is still live on `pro@nginx`**~~**, and it is the environment, not this phase.**~~ **Fixed by V122 — the window was the suite's own, and the mechanism is now reproduced on demand.** Across **33 scenario executions with `E2E_RETRIES=0`** (`pro@nginx` 12/13 then 13/13, `free@nginx` 13/13) exactly **one** failed, in shared `finishActivation`: `backwpup_onboarding` was absent immediately after a fresh install. | The failing scenario's own `debug.log` carried only `headers already sent` warnings — **no `CREATE TABLE … already exists`**, so not V47's leftover table. The site was completely clean afterwards (plugin absent, 0 `backwpup*` options, no `%bwpup%` table). **6 of 6** isolated install → activate → read → teardown cycles on the same cell, driven through the lifecycle's own `installPluginUnderTest`, kept the flag. The rate matches the cell's per-minute wp-cron supplying the second `init` request V46 describes. | **Not a defect in 6F.1** — the assertion is in a `Given` three other features already use, and the retry policy (2, the default; `E2E_RETRIES=0` is what made it visible) absorbs it while Playwright still reports the scenario **flaky** rather than green. Adding scenarios raises the exposure proportionally, which is true of any phase. A candidate fix — let `finishActivation` **restore** the flag when the site is otherwise pristine (version written, one stored job, that job flagged `tempjob`, no real jobs), since that state is the plugin's upgrade path having run on a never-onboarded site — is **not taken here**: it changes shared code on one unreproduced observation, and the rule is to reproduce the mechanism first. |

### 2.15 Facts established auditing 6F.0–6F.1 (2026-09-22)

A full re-read of both sub-phases against the plugin source at `develop@f1ebfd0` (unchanged since
§2.14), with every open claim measured live on `pro@nginx`. Nothing below was visible to typecheck,
lint, format or the unit suite. One hypothesis was **refuted** by measuring it (V98), which is why it
was measured.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V97 | **WP-CLI honours its global parameters anywhere on the line**, after the subcommand too: `wp backwpup version --path=/nonexistent-…` looked for another WordPress, and `--skip-plugins` unloaded BackWPup. `version` documents `--debug` as its own option. | Live, both measured. Globals listed from the site's own `GLOBAL PARAMETERS` block; no BackWPup option shares a name with one except `version`'s `--debug`. | The generic step could have moved a command off the bound site — on a host shared with another cell's site (V72), onto that site. `parseCommandText` now refuses the globals that decide where, as whom or with what code the command runs, or where its arguments come from (`--path`, `--url`, `--ssh`, `--http`, `--user`, `--skip-*`, `--require`, `--exec`, `--context`, `--prompt`), and keeps the presentation ones (`--debug`, `--quiet`, `--[no-]color`). A backslash is refused along with the quotes. |
| V98 | **WP-CLI's formatter validates `--fields` itself.** `job --fields=job_id,nope --format=json` exits 1 with `Invalid field: nope.` — the audit expected `pick_fields` to fill the unknown field with `null`, which would have let the exact-keys step pass on a field that does not exist. It does not. | Live. | The exact-keys step is sound as written, and its TSDoc now says why. The two refusals differ by a period (`--field`'s is the plugin's, `--fields`' is WP-CLI's); the substring match absorbs it. |
| V99 | **The backup history table is an independent record of each run** — one row per destination, written by the run itself (`backwpup_create_job` → `add_backup_row`, `created` → `completed`), with `filename`, `job_id`, `status` and `backup_trigger`. `$wpdb` hands every column over as a string; a missing table reads as an empty result, with the error only in `last_error`. | `src/Backup/Database.php`, `src/Backup/Subscriber.php`. Live after one `run --background`: one row `FOLDER / <archive> / "3" / completed / backup_now_job`, its filename equal to `backup --field=name`. Live with the plugin absent: `Table '…wp_bwpup_backups' doesn't exist`. | **6F.1's archive assertion compared `backup --field=name` with `listBackups` — the same command in JSON**, against the feature's own promise of a source the command has no hand in. It now reads the history (`support/history.ts`), which refuses a failed query rather than answering "no backups". 6F.2's trigger and abort assertions build on the same reader. |
| V100 | **`log` reads every header value it cannot find as 0** — `errors`, `warnings` and `job_id` are all `(int) ( $hdr[…] ?? 0 )`, so an unparseable header reports a clean run. The header's `job_id` (3, live) is the witness that it was read: 0 is no job's. | `src/Cli/Helpers/CommandsLogHelpersTrait.php::read_log_header`; live `log --fields=name,job_id,errors,warnings --format=json`. | The log scenario now asserts the header's `job_id` against the stored scheduled job. A header-parse regression — which would turn every verdict `readLastRunOutcome` returns into a success — fails there instead of passing everywhere. |
| V101 | **A provided zip had no version at all.** `resolveZipRequest` records none and `E2E_PLUGIN_VERSION` is ignored beside a zip, so under `E2E_PLUGIN_ZIP` the `version` scenario could not establish what to expect. The preflight already read the zip's `Version:` header, but only printed it. | `src/common/artifacts/resolve.ts`, `request.ts`, `verify.ts`. | The verified artifact now carries its header's version, with the build's report only as fallback — the value WordPress installs and `wp backwpup version` prints. Unit-tested; proven live below. |
| V102 | ~~**Six of 6F.1's eleven scenarios ran with BackWPup's own activation still pending**, so the command under test was the request that performed it — racing the cell's cron (V46) unchecked.~~ **Corrected by V122: not pending — the `@plugin` hook's active-state check had already run it (3 of 3, measured); what those scenarios lacked was the check that the race had not been lost.** Every other `@plugin` feature runs `finishActivation` first. | `cli-reads.feature` against `onboarding`, `backups`, `backup-contents` and `plugin-deletion.feature`. | `Background: Given a freshly installed BackWPup`. A lost race now fails at the lifecycle and says so (V96), rather than as a wrong answer from a command. |
| V103 | **WP-CLI's own refusals span lines, and the notice parser kept only the first.** A parameter the synopsis does not declare fails as `Error: Parameter errors:` and then one line per parameter (` unknown --nope parameter`), sometimes followed by an unindented `Did you mean '--format'?` — so `it reports the error "unknown --field parameter"` could never have matched, while `cli.ts` claimed WP-CLI does not wrap. (V91 quotes that refusal on one line; it is two.) BackWPup's own notices are all single-line. | WP-CLI 2.12.0 on the cells, verbatim: `wp option get blogname --nope=1` and `--formt=json`, `wp option list --format=nope`. WP-CLI's `Dispatcher/Subcommand.php` builds the message with `"\n {$error}"`. No `WP_CLI::error\|warning\|success` in `src/Cli/Commands/` carries a newline. | On stderr — where WP-CLI writes each notice whole and little else — a line that is not a status line now continues the notice above it; a blank or `Debug` line ends it. Stdout stays line by line, because the command's own output shares it. |

**Smaller corrections.** The ids step compared **ordered** lists, but the two sources do not share an
order by construction: PHP iterates the option in insertion order, while JSON hands a sparse one to
JavaScript as an object whose integer keys `Object.values` returns sorted (measured: `{"2":…,"0":…}`
reads back as ids 1 then 5). They agree today only because `BackWPup_Option::update` allocates keys as
`max + 1`; the migration's `update_job_id` does not. Compared as sets now, and the TSDoc that called
the order "exactly what the reader does" is gone. `log --job_id` was claimed by V91 and asserted
nowhere; it now is, both ways. The Pro half of the `--help` probe also requires the page to name the
command, since an exit code alone would be satisfied by some other page. The alias field's TSDoc
implied protection nothing provides (**corrected only in §2.20** — it still said so). Plus one duplicate import, one unresolvable `{@link}` (6C) and a
TSDoc orphaned above the wrong declaration (6D, `waitForBackup` — V77's class), whose neighbour's doc
was also off by one against its code.

**Also recorded, not fixed — outside 6F.** The orphaned-TSDoc scan that caught `waitForBackup` found
five more of the same class elsewhere: `src/common/wp/residue.ts:264` (a `@param target`/`root` block
stranded above `describeRemoval`), and one test doc each in `preflight.spec.ts:430`,
`ownership.spec.ts:576` and `:802`, and `residue.spec.ts:363`.

**Verification after the audit.** Unit **821 passed / 8 skipped** (793 before); typecheck, lint and
format clean; both new PHP snippets pass `php -l`. Each new guard was **proved to catch its defect**:
with the fix removed its tests fail — two for the artifact version, eight for the step-text
refusals, two for multi-line notices — and pass again once the file is restored byte for byte. The
`version` scenario passed live under `E2E_PLUGIN_ZIP` (`source=env-zip origin=copied
version=9.99.99`), the configuration it could not pass before. Live, with `E2E_RETRIES=0` and both
cells in parallel: after the main fixes **`pro@nginx` 13/13** and **`free@nginx` 13/13**, and again
after the parser change, **13/13 on each** — 45 scenario executions, no failure. Both sites were
left exactly as found: no plugin, no `backwpup`/`bwpup` option or table, no `uploads/backwpup`.

### 2.16 Where exit 0 does not mean success (source review, 2026-09-22)

Prompted by a review question on `Then the command succeeds`: does WP-CLI exit 0 even when a command
fails? **In general, no.** Its own refusals exit 1 (V80, V103), `WP_CLI::error()` exits 1, and a PHP
fatal exits 255 — and all 62 `WP_CLI::error()` calls under `src/Cli/Commands/` exit, since none
passes `$exit = false`. What exits 0 after a failure is plugin code that reports it some other way.
Beyond the two already recorded — `wp eval` (V31) and `--field` on an empty list (V90, with the same
guard in `Backup.php:188-190`) — there are four.

**Read from `develop@f1ebfd0`'s source, not yet measured live** — only PHP's own exit statuses were
measured, locally. Whichever sub-phase drives a command below measures its row on a cell before a
scenario relies on it, as V90 was.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V104 | ~~**A foreground `run` exits 0 on a run that logged errors, if it also logged a warning.**~~ **Superseded by V108 — the verdict below is never reached at all.** The verdict tests `$warnings` first and returns after warning, so `There are N errors…` is reached only by a run with no warnings at all. What prints instead is `Warning: There are %d wearings due to job execution please chack the logs.` (sic). | `src/Cli/Commands/Run.php:182-192`. | A plugin bug, worth reporting upstream. 6F.2 takes `run`'s outcome from the log header or the history row, never from its exit code or the absence of `Error:` — `readLastRunOutcome` in `support/backups.ts` already does. Pinning the bug in a scenario needs a run that logs both, which nothing arranges today. |
| V105 | **A `restore` that fails once it has started exits 0.** Everything after the archive is resolved sits in a `catch ( \Throwable )` that prints `Warning: Restore failed: …`. With a pre-backup snapshot it then offers a rollback and, if that works, ends on `Success: Rollback completed.` — a failed restore whose last line is a success. Only a bad archive argument (`:132-135`) or a failed rollback exits 1. | `src/Cli/Commands/Restore.php:210-223`. | 6G's CLI restore: the restored marker is the verdict, as its acceptance already requires, and `the command succeeds` adds nothing. A failure scenario asserts the warning **and** that the marker is still drifted — not a non-zero exit. |
| V106 | **`log-delete` reports success when it deleted nothing.** A file it cannot remove — missing, not writable, or `wp_delete_file` failing — is a `Warning:` from `delete_one`, after which the command still prints `Success: No logfile deleted.` (one file) or `Success: 0 logfile(s) deleted.` (bulk) and exits 0. On these cells the likely trigger is ownership: `wp_is_writable` is asked as the transport's user, and a `--background` run writes as the web server (V82 measured it for the archive). | `src/Cli/Commands/LogDelete.php:127` and `:177`; `delete_one` at `:216-241`. | 6F.3 confirms every deletion by re-reading `log --format=count`, as its acceptance already says, and asserts a refusal as a warning plus a surviving file — the same shape as `backup-delete`'s ownership split (V84). **Measured in 6F.3 (V123, V130):** the warning and the success line are as written, but the ownership guess is refuted — the web server's logs are `0777` on these cells — and a missing name is an error at exit 1, not a warning. Deletions are confirmed against the log folder itself rather than `log --format=count`, which walks it through the same helper. |
| V107 | **`BackWPup_Job::start_cli()` stops with PHP's `exit( 'message' )`, which prints the message and exits 0 with no `Error:` prefix.** It does so for an unknown job id, a log or temp folder that fails `check_folder`, and a job already running. `run` rules out the first and checks the running file itself, so what stays reachable is the folder checks — and a job the site's own cron starts between `run`'s check and `start_cli`'s. `run` then never reaches its own verdict. | `inc/class-job.php:3070-3098`. Measured locally on PHP 8.1: `php -r 'exit("…");'` prints the string and exits **0**; an uncaught fatal exits **255**. | Invisible to the notice parser, so no exit-code or status-line check can catch it — only a second source can: a new history row, a log for the job. |

**What this means for the generic step.** `Then the command succeeds` asserts the exit code alone.
That is sound for 6F.1: each use is followed by a check of the output or of a second source, and
none of the commands it runs (`version`, `job`, `backup`, `log`, idle `status` and `kill`) has one of
the paths above. `Then the command fails` is safe by direction — a false 0 fails it loudly. The risk
is reuse from 6F.2 on, where `run`, `restore` and `log-delete` would pass it after failing.
**Proposed, not implemented:** `the command succeeds` also requires no `Error:` and no `Warning:`
notice, which catches V104–V106, with a separate step for a success that is meant to warn
(`log-delete`'s `Ignoring --all…`, `status` after a run that warned). That check would also trip on
PHP's own warnings, which share WP-CLI's prefix, if a cell displays them on stdout — arguably right,
but to be measured first. V107 stays beyond any such check; a second source is the only defence.
**Since measured (V108): the proposal cannot catch a foreground `run` either** — it prints no status
line at all, whatever it logged — so it stays unimplemented, and 6F.2 pairs every success with a
second source instead.

### 2.17 Facts established building 6F.2 (live, on both nginx cells, at `develop@f1ebfd0`)

Every row was measured on `pro@nginx` and `free@nginx` through the repo's own modules: a scratch
driver installed the plugin with the lifecycle's own `installPluginUnderTest`, seeded onboarding,
then ran, watched and aborted jobs while a sampler **inside the site** recorded the running marker,
the working data's pid and step, the newest history row and the log's tail every 20 ms. Each site
was left as found. A row read from source rather than provoked says so.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V108 | **A foreground `run` never reaches its own verdict.** The job ends in `end()`, whose last statement is `exit()`, so the code after `start_cli` in `Run.php` — the header read, the warnings/errors verdict, `Job runs successfully.` — never runs for a job that reaches its end. The command exits 0 with the job's own log on stdout and **no status line at all**. | Measured on both cells: exit 0, no notices, last line `Job done in 0 seconds.`. `inc/class-job.php` `end()`; `do_restart()` even says so ("Unreachable: end() always exit()s"). | **Supersedes V104**: its ordering bug is real but unreachable. The consequence stands, stronger — a foreground run's exit code and output say nothing about how it ended, so it is judged by its history row and its log. Worth reporting upstream. |
| V109 | **The history records which context ran a job**: `backup_trigger` `wp-cli` for a foreground run, `backup_now_job` for `--background`. A foreground database run finishes inside WP-CLI in ~2 s on `pro@nginx` and ~1.5 s on `free@nginx`, although both CLIs have `memory_limit = -1`. | Measured, both cells; `get_backup_trigger()` maps `runcli` → `wp-cli`, `runnow` → `backup_now_job`. | V82 holds on both nginx cells; V41's memory death belongs to `wp cron event run`, not to `run`. The two triggers are what the foreground and background scenarios assert. |
| V110 | **`run`'s refusals, all exit 1**: no argument → `No job ID(s) or pram specified!`; `--background` with several ids → `Background job run not works with more than one job_id!`, decided on the count before any id is looked up; an unknown id in the foreground → `Job ID does not exist!` — also the answer for the hidden first-backup placeholder; and while a job runs, **both** forms → `A job is already running.`, checked before the arguments are read. | Measured, both cells (the wording, slips included, is the plugin's). `src/Cli/Commands/Run.php`. | Pinned by two scenarios. V107's `Wrong BackWPup JobID` is unreachable from `run`, which refuses an unknown id first. |
| V111 | **`run <unknown id> --background` reports success**: `Success: Job "" runs now in background.`, exit 0 — the name is `BackWPup_Option::get( <id>, 'name' )`, `null` for a job that does not exist — and the site's `start_http()` then drops the request with an admin message. No log, no history row, nothing runs. | Measured on `pro@nginx`: log and history counts unchanged, nothing running 8 s later. | A plugin bug worth reporting upstream. Not pinned — a scenario asserting it would fail the day it is fixed. `startJobInBackground`'s TSDoc and the generic success step name it. |
| V112 | **A database backup takes about a second — less than one WP-CLI round trip (~1.3 s over SSH).** Dispatch → marker → `completed`: 0.9 s on `pro@nginx`, 1.1 s on `free@nginx`. With "Reduce server load" at maximum (a 90 ms pause on every progress update) the same job takes ~10 s and ~6.5 s. **Refined by V185**: the pause is paid once per table, so these are each site's table count. A files-and-database job is still archiving 6 s in on both cells. | Sampler timelines, both cells. The setting's values are the Settings screen's (`parts/sidebar/settings-jobs.php`): 0, 10 000, 30 000, 90 000 µs. | No command sent after a start can find an unpaced database job still running, so `status`, `kill` and the "already running" refusal need a job arranged to last — `cli-running-job.feature` paces it with the plugin's own setting. |
| V113 | **The plugin hands a long run to a fresh request midway** — after any step once the request has run over 3 s (measured), and, by its source, about 27 s into a long step (the default maximum execution time is 30 s). During the handover the marker holds pid 0 for ~0.3–0.4 s. A `kill` landing there finds no process: it either loses the abort (its own `update_working_data()` returns early when the last update is under a second old, so no `end()` ever runs and the row stays `created`), or runs the job's `end()` inside the `kill` process, which then exits without its success line. A **maximum script execution time of 0** — "0 means no maximum" on the Settings screen — keeps a run in one request. | Pid-0 windows measured: `pro@nginx` 9.40→9.83 s and 6.63→7.00 s, `free@nginx` 5.87→6.20 s; one pid from start to end with the setting at 0, both cells. The kill-in-a-handover outcomes are **read from source** (`user_abort()`, `update_working_data()`, `start_http( 'restart' )` in `inc/class-job.php`), not provoked. | `cli-running-job.feature` sets it to 0, so no command it sends can land in a handover. An abort that can be lost is worth reporting upstream. |
| V114 | **`kill` against a running job**: the marker goes at once, the run notices within ~1 s, logs `Backup aborted!` and ends — history row `aborted`, log 0 errors and 2 warnings (the abort, and the "finished with warnings" summary it causes), no archive. The row still reads `created` for ~0.4–1 s after the kill. | 7 aborts, paced database and files-and-database jobs, both cells. | "Nothing is running" is not "the run has ended". The abort scenario and the teardown's stop both wait for the row to leave `created` — the signal the dashboard's own abort handler polls (`job-abort-status`). |
| V115 | **`status` reports `Job finished.` for a run that was aborted under it.** Its loop ends the moment the marker disappears, which `kill` causes, and it reads the log header about a second before the job logs the abort. Watched to its natural end it is right: it blocked ~6.8 s (`free@nginx`) and ~9.9 s (`pro@nginx`) and returned after the row was `completed`. | Measured on `pro@nginx`: blocked 8.2 s, then `Success: Job finished.` at exit 0 for a row `aborted` with 2 warnings in its log. `src/Cli/Commands/Status.php` — the verdict is read after the `while` loop. | A plugin bug worth reporting upstream; not pinned. The `status` scenario watches a natural end, and its feature says why. |
| V116 | **`job-activate`**: `--type=disable` → `Job with ID N deactivated`, `active_type` `none`, the WP-Cron event removed; `--type=link` → `link`, no event; no `--type` → `wpcron` and an event at the job's next cron time, because WP-CLI applies the synopsis default — the command's own fallback (`'wp-cron'`, misspelt) is dead; an unknown id **and** the hidden placeholder → exit 1 `No jobs found!`; a bad type → WP-CLI's `Invalid value specified for 'type'`; no `--job_id` → every visible job. | Measured on `pro@nginx`. `src/Cli/Commands/JobActivate.php`. | The scenario re-activates with no `--type`, which also proves the default still arrives. |
| V117 | **The aborted row, live**: the dashboard's `backups` listing renders it with `delete-failed-backup` and `Aborted by user`, and no failure icon. | The listing route read on both cells; asserted in the browser by the abort scenario. | **Closes §2.9's deferral** — V42's branch, against a real row. |
| V118 | **A broken SSH link hung a command indefinitely, or killed the worker.** Unprobed, a link that goes silent is never noticed: through a proxy that stopped forwarding, a command was still waiting after 70–80 s with node-ssh reporting the connection alive. A reset under a running command was an uncaught `read ECONNRESET` that ended the process — node-ssh listens for connection errors only while connecting and while opening a channel. | Both reproduced through the repo's own `exec()`, redirected via a local proxy. ~~Live: the first 6F.2 run's refusal scenario sat 500 s in its Before hook, and its teardown then failed `Not connected`.~~ **Corrected by V120/V121**: that was the runner asleep, then a dead pooled connection — neither is evidence of a silent link, which stands on the proxy measurement alone. | **Fixed in the shared transport** — see §2.18. After: a silent link fails the command in 40.6 s, a reset in 2.0 s, each naming the lost connection, and the next command reconnects. |
| V119 | **The environment moved.** `free@nginx` now defines `DISABLE_WP_CRON`, superseding V68's description; its database is 4.8 MB against `pro@nginx`'s 47.7 MB. Both sites (one host) stalled together for ~210 s once — unexplained, and the shape V118 describes. V96's activation race recurred once in the first 6F.2 run (`pro@nginx`, retries disabled). | `wp eval` on each cell; one scratch run; that run's failing Background. | V68's recommendation has been applied. ~~V96 stays attributed to the environment.~~ **Corrected by V120/V122**: the joint stall fits the runner sleeping — it slept seven times that afternoon — though its time was not recorded; V96 was the suite's own window, now fixed. |

### 2.18 Facts established auditing the whole of 6F (2026-09-22; re-verified live 2026-09-23)

A re-read of 6F.0–6F.2 end to end against the plugin source at `develop@f1ebfd0`, with open claims
measured live, the mechanical checks re-run over all of `src/`, and properties mutation-checked — the
fix removed, its test must fail, the file restored byte for byte: **27 of 27** for 6F.2 and this
audit's fixes, **13 of 13** for 6F.0–6F.1's core (the notice parser, the JSON refusals, the command
drift both ways, the help parse, the command-text refusals, the history's integer check),
**3 of 3** for the tests added below, and **17 of 17** for the two fixes the live re-verification
added (V121, V122). Fixed:

- **The SSH transport (V118).** Each connection is now probed every 10 s × 3 (`SSH_KEEPALIVE`) and
  carries a standing error listener, so a broken link fails the command on it — naming the lost
  connection — and the next command reconnects. Pinned by `exec.ssh.spec.ts`, against ssh2's own
  in-process server behind a proxy the test cuts: reset mid-command, reconnect, probing configured.
  Verified live through `exec()` both before (hang ≥ 80 s; crash) and after (40.6 s; 2.0 s). Found
  while verifying 6F.2, and outside 6F proper.
- **A connection that died between commands cost a scenario (V121).** ssh2's `Not connected`, raised
  before anything is sent, is now retried once on a new connection, for commands and uploads alike
  (`withConnection`); a connection that cannot be opened names its endpoint. Pinned in
  `exec.ssh.spec.ts` by a proxy that holds both FINs back while the server disconnects — the
  refusal reproduced exactly — plus a refused port. Five mutations, all caught; the one that
  retries everything re-sends a command that was already running.
- **V46's race was never closed (V122).** `finishActivation` now checks for what a fresh install
  actually is — onboarding owed and one job, the first-backup placeholder (`isPristineActivation`)
  — and redoes either lost outcome from a clean install, up to three installs, each reported,
  adding the hook's budget per reinstall (`reinstallPlugin`). Its TSDoc, the Given's and
  `cli-reads.feature`'s comment stop claiming a window they never closed. Proved live on both
  outcomes, each lost on purpose and recovered to a fresh site in 46–51 s, and once in the suite
  itself (below). Twelve mutations, all caught.
- **Docs**: `SSH_KEEPALIVE` and `wordpress-automation.md` no longer cite a live loss the keepalive
  did not see (V120), and `CLAUDE.md` says to keep the runner awake through a live run.
- **`CliSession` kept the previous result when a command failed or ran out of budget**, so `last`
  could judge an earlier command in place of the one that never answered — contrary to its own
  "only the latest" rule. A run now clears it first.
- **Three docs described `run` as the source had suggested, not as it behaves**: the generic success
  step, `startJobInBackground` ("the only failure it genuinely detects is … a second job") and
  `authoring-tests.md`. Each now states V108, V110 and V111.
- **`addBackupJob`'s verification had no test.** Its snippet was pinned, but not the check that the
  site gained exactly one job backing up what was asked — the part that turns a refused endpoint or
  a schema change into a clear failure. Four cases now cover it, against a stub endpoint. So does
  `theScheduledJob` (6D's, but what 6F.2's `{job}` resolves through): one scheduled job, none, two.
- **Two unresolved `{@link}`s** (V78's class) in files this work edits — `backups.steps.ts` and
  `wp/exec.ts` — rewritten as plain code references.
- **Precision**: "Reduce server load" pauses on every progress update, not on every save; the
  handover sentence now says what the source shows (V113); `waitForJobRunning` names the likely
  cause of a run never seen and its remedy; `HOOK_TIMEOUT_MS` accounts for the new duty.

**Re-verified sound, unchanged:** the declared command set and all 16 aliases against both editions'
`src/Cli/Commands/`; no plan reference anywhere in `src/`; every `{@link}` in 6F's files resolves and
none of their doc blocks is stranded; and the teardown's stop on a site whose Background failed before
`finishActivation` — the Before hook's own WP-CLI calls had already run BackWPup's activation (table
present, version written), so the stop's history read cannot fail there (measured, `free@nginx`).

**Also recorded, not fixed — outside 6F:**

- `locator-contract.spec.ts:801` failed once under full-suite load and passed 5/5 alone and in every
  later full run.
- `metadata.spec.ts` has no case for 6E's `siteDbResidue` registry.
- `backup-contents.feature` — two full files backups per cell — is the one feature that fits
  `@slow`'s definition, and is untagged.
- The same scan found unresolved `{@link}`s outside 6F — `onboarding.page.ts`, `dashboard.page.ts`,
  `artifacts/apvm.ts`, `wp/ownership.ts`, `ownership.spec.ts` — beside §2.15's five stranded doc
  blocks, which are still there.
- Three `pro@nginx` scenarios of the first 6F.2 run logged two PHP warnings each; the gate attaches a
  log only on a failure or a fatal, so their text is gone, and none recurred.
- `pro@apache` was not exercised: it is borrowed only on request.

**Established re-verifying live (2026-09-23)** — the runs re-done on a runner kept awake, and the
audit's two unexplained failures chased to their causes:

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V120 | **Both of the audit's "network" episodes were the runner asleep.** The first 6F.2 run's 500 s Before hook; the full `pro@nginx` run failing from its 24th scenario on — scenarios of 1 000–2 700 s, hooks far past their 120 s budget, `read ECONNRESET` and `Not connected` after each wake; and the queued `free@nginx` run's preflight `read ECONNRESET`. | `pmset -g log` (local time): idle sleep 18:24:42→18:32:31 (469 s) inside the 500 s hook that began 18:24:12; idle sleep at 19:28:46, eighty seconds into scenario 24, then only dark wakes of 2–23 s every ~15 min until morning; the `free@nginx` preflight began 03:50:05 in a 17 s dark wake, the machine slept at 03:50:08 for 158 s, and the check failed after 158.8 s. Timers stop while a machine sleeps, which is how a 120 s hook outlived half an hour of wall clock. | V118's live evidence and V119's joint stall are re-attributed (see each). `CLAUDE.md` now says to keep the runner awake through a live run (`caffeinate -i`), and this audit's live runs were. |
| V121 | **A pooled SSH connection could be dead while node-ssh called it connected, and every command on it failed at once.** After a protocol error or a server's disconnect ssh2 half-closes its socket and refuses each request with `Not connected`, checked before a byte is sent (`isWritable` in `exec()` and `sftp()`); node-ssh marks the client disconnected only on the socket's `end`/`close`, which on a failing link comes minutes later. | Seen live twice, each right after a wake (V120): the first run's refusal scenario, and the full run's background scenario at the 20:37:34 dark wake — `Error: Not connected` from `Client.exec`, under `isPluginActive`. Reproduced on demand through a proxy that holds both FINs back while the server disconnects. | **Fixed in the shared transport** (above): the refusal is retried once on a new connection, and nothing that was sent is ever re-sent. A connection that cannot be opened now fails naming its endpoint, where it had surfaced as a bare `read ECONNRESET`. |
| V122 | **V46's race is the suite's own, and `finishActivation` never closed it.** The `@plugin` hook's active-state check — `wp plugin is-active`, plugins loaded — has been the first request after activation since 6A, so it runs BackWPup's routine: `backwpup_version` is written by the time `installPluginUnderTest` returns (3 of 3), and `finishActivation`'s bootstrap has been a no-op since it was added. A second request 150–450 ms behind the first loses the race: the flag is deleted (`convert_jobs()`), an extra job is left that is no longer a placeholder, and `activate()`'s own cleanup then removes the files/database job-id options the upgrade path wrote. Two requests at once instead each create a placeholder and keep the flag — but every job write rewrites the whole jobs option from the request's own copy (`BackWPup_Option::update()`), so the later drops the earlier's placeholder flag and leaves a real, scheduled job nobody configured. | Provoked on `pro@nginx` by booting WordPress twice right after `install --activate`: 300 ms apart lost the flag **4 of 4**, 150 ms 1 of 4, 450 ms 2 of 4, 600 ms 0 of 4; 0 ms kept it 18 of 18 but left two jobs 7 of 18 — in the 5 whose flags were read, job 1 no longer a placeholder and job 2 the placeholder the plugin records as its first backup. A clean install leaves exactly one placeholder, measured on both editions (2 installs each). In real runs, 2 lost races in about 60 retries-off `pro@nginx` scenarios (~3 %). `isPluginActive` right after the install since 6A (`2bcf033`); `finishActivation` added 2026-09-18 (`c2c051e`). | **Fixed** (above): either outcome is redone from a clean install — the stray job would otherwise have failed `completeOnboarding`'s one-job check, `theScheduledJob` and the empty-site CLI scenario, and the old flag-only check let it through. Nothing on this side can hold the cell's cron off, so the fix is recovery, not prevention: three lost races in a row, which the measured rate makes a few in a hundred thousand, still fail — clearly. In the verification runs the suite met the race once (`free@nginx`), redid the install and passed. The mechanism is a plugin bug worth reporting upstream: activation should not be re-entrant, and the jobs option is written without a lock. |


### 2.19 Facts established building 6F.3 (live, on both nginx cells, at `develop@f1ebfd0`)

Measured on `pro@nginx` and `free@nginx` through the repo's own modules: a scratch driver installed
the plugin with the lifecycle's own `installPluginUnderTest`, seeded onboarding, made backups both
inside WP-CLI and through the web server, then drove all four commands through their success paths,
their refusals and their edges. Both sites were left as found. A row read from source rather than
provoked says so.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V123 | **Logs are not archives: on these cells WP-CLI may write a log the web server made, but not an archive.** BackWPup writes its logs through WordPress's filesystem API, which gives each file `FS_CHMOD_FILE` — derived on both cells as `0777` from a `0777` `index.php`, with no `wp-config.php` define — while the archive is written with `fopen` under PHP-FPM's umask. | Both cells: logs `-rwxrwxrwx`, one `ubuntu`, one `www-data`; archives `ubuntu 664` (inside WP-CLI) and `www-data 644` (web server); `is_writable()` as WP-CLI's user — logs 1 and 1, archives 1 and 0. `inc/class-job.php` (`$filesystem->put_contents( $this->logfile, … )`). | V84's split holds for archives on both cells. **§2.16's guess for logs (V106) is refuted here**: a `--background` run does not leave a log WP-CLI may not write, so `log-delete` removes web-written logs on these cells. Its refusal needs a log WP-CLI may not write — which a host whose `FS_CHMOD_FILE` is `0644` makes of every web-written log — so the refusal scenario makes one read-only. |
| V124 | **A refused `backup-delete` leaves its error queued, and the next `backup-delete` repeats it — after deleting its own archive.** The folder destination reports the refusal through `BackWPup_Admin::message(…, true)`; the command reads the queue back and calls `WP_CLI::error()`, which exits before the line that would clear it. Each refusal adds another copy. | Live on both cells: refused the web server's archive, then deleted the WP-CLI one — file **gone**, exit **1**, `Error: Could not delete backup archive "<the other file>", check permissions!`; `backwpup_messages` held one copy, then two. `src/Cli/Commands/BackupDelete.php`. | A plugin bug worth reporting upstream; the queued error also surfaces on the next admin screen. Not pinned. The refusal scenario runs exactly one delete, and `Then the command fails` now says a non-zero exit is not proof nothing happened. |
| V125 | **`backup-delete` leaves the run's history row; the dashboard's delete removes it.** The command calls only the destination's `file_delete()`; the REST route behind the dashboard also fires `backwpup_after_delete_backups`, which drops the row. The orphan stays `completed`, and invisible — the history lists a completed run only while a destination still holds its file. | Live: after the CLI delete the history still held both runs as `completed`. `src/Backups/API/Rest.php` (`delete_backup`), `src/Backup/Database.php` (`backups_list`). | Not pinned: it is a divergence the plugin may well fix. It is why "the oldest backup" is fixed when the backup is made (`ArchiveSnapshot`) rather than re-read from the history after a delete — that fix would otherwise move the name between the delete and the assertion about it. |
| V126 | **Without `--yes`, every destructive command only asks — and ends at exit 0 having done nothing.** `backup-delete` prints `Delete Backup file <name> on Folder ? [y/n]`, `backup-download` onto an existing file `File <path> already exists. Overwrite it? [y/n]`, `log-delete` `Delete logfile <name> ? [y/n]`. WP-CLI's `confirm()` reads the answer from stdin, meets end-of-input — node-ssh ends the channel's — and exits 0. **On `local` the same prompt would hang**: execa leaves a child's stdin open by default. | Live: prompt last on stdout, exit 0, archive, log and placed file all unchanged. Locally, through execa: `sh -c 'read x'` was still waiting when killed at 5 s with the default, and answered in 9 ms with `stdin: "ignore"`; PHP's `fgets( STDIN )` read `false`. | **Fixed in the shared transport**: the execa-backed modes ignore stdin, so a prompt is declined the same way on every transport — `docker` measured too (V140) (`exec.spec.ts`, mutation-checked). The scenarios assert the prompt, the exit 0 and the untouched file — the trap a script without `--yes` walks into. |
| V127 | **`backup-download` resolves a relative destination against WP-CLI's working directory** — the WordPress root here, since WP-CLI does not change directory. A missing destination folder is created, an existing folder receives the archive under its own name, and the copy is written by WP-CLI's user. An archive the web server made downloads fine: WP-CLI may read what it may not delete. Refusals — `Backup file not found.` and `Backup file not found in storage <s>.` — come before anything is created. | Live, both cells: `getcwd()` is the root; the copy's SHA-256 equals the archive's; neither refusal created its destination folder. `src/Cli/Commands/BackupDownload.php`. | The download scenario hands the command a folder relative to the root and reads it back by absolute path, so the copy being there is what proves where a relative path leads; the refusals assert that nothing was downloaded. |
| V128 | **`backup-download` to a path it cannot write fatals** rather than refusing. The folder downloader opens the target with a silenced `fopen`, keeps the `false`, and writes to it — `Uncaught TypeError: fwrite(): Argument #1 ($stream) must be of type resource, false given` (`inc/class-destination-folder-downloader.php:74`), then a second from `__destruct`'s `fclose( false )`; exit 255, and the fatal lands in `debug.log`. The `catch ( \RuntimeException … )` meant for it cannot fire. | Live on `pro@nginx`: `backup-download <archive> /proc/<name>.tar`. | A plugin bug worth reporting upstream. Never a scenario: the debug-log gate would fail it, rightly, and it would pin a crash. |
| V129 | **`log-show`, measured.** Plain text is `wp_strip_all_tags` plus `html_entity_decode`, each line trimmed, blank ones dropped. Every log names itself (`[INFO] Logfile is: …`) and its run's archive (`[INFO] Backup file is located at: …/<archive>`), and the history records each run's log (`wp_bwpup_backups.logfile`, an absolute path). The extension is optional and `--file=` equals the positional; `--job_id` picks the newest by modification time; `--lines=N` keeps the last `max( 1, (int) N )` lines, so `0` and `abc` both print one. Refusals: `Logfile <name> not found or unreadable.`, `No logs found for the given job_id.`, `Please provide <file>, --file=<file>, or --job_id=<id>.` | Live on `pro@nginx`, the whole matrix. `src/Cli/Commands/LogShow.php`, `src/Cli/Helpers/CommandsLogHelpersTrait.php`. | The log scenarios name a log through the history and check what was printed against the run's own record: its archive, and no other run's. |
| V130 | **`log-delete`, measured.** `--older-than` reads a file's **modification time** — `log` shows the header's time instead, so the two can disagree; `strtotime( 'now - 7days' )` works, so the value needs no space; `--older-than=0` reads as absent; nothing matching prints `No logs match the criteria.` at exit 0. A log WP-CLI may not write draws `Warning: Logfile <name> is not writable. Check permissions!` and then `Success: No logfile deleted.` at exit 0 — V106's shape, confirmed; but a **missing** name is an error at exit 1, `Log file not found or unreadable: <name>`, not the warning V106 listed it under. Other refusals: `Provide <file>/--file, or --older-than, or --all.`, `Invalid --older-than value.` | Live on `pro@nginx`: a log backdated ten days went with `--older-than=7days` and the fresh one stayed; a `0444` log survived both a single delete and `--all`. `src/Cli/Commands/LogDelete.php`. | The age scenario backdates a WP-CLI-owned log by the site's own clock (`wp/files.ts: backdateFile`); the read-only one asserts the warning and the surviving file, and nothing about the exit code or the success line. |
| V131 | **`log-delete` deletes any file in the log folder.** Its single-file mode checks that the name is readable there, not that it is a log, so `log-delete .htaccess --yes` and `log-delete index.php --yes` remove the folder's own guards with `Success: 1 logfile deleted.` `log-show .htaccess` prints the rules. | Live on `pro@nginx`. `LogDelete::resolve_filename()` and `delete_one()`. | A plugin bug worth reporting upstream: on Apache that `.htaccess` (`Require all denied`) is what keeps the logs from being served. Not pinned. |
| V132 | **`--dry-run` is documented and would delete for real.** The class docblock offers "an optional --dry-run preview", and the code passes the flag to `delete_one( $name, $dry )` — a method taking one argument, which ignores it. The synopsis does not declare it, so today WP-CLI refuses it before the command runs: `Parameter errors: unknown --dry-run parameter`. | Live; `LogDelete.php`. | Pinned by the refusals scenario, which asserts the logs survive the attempt: if the synopsis ever gains the option without the code honouring it, the "dry run" deletes, and the scenario fails. |
| V133 | **The basename hardening holds.** A path from the log folder to a file outside it reaches nothing: `log-show` answers `Logfile <basename> not found or unreadable.`, `log-delete` `Log file not found or unreadable: <basename>`, and the file survives untouched. | Live on `pro@nginx`, with a file planted under `wp-content`. | Pinned. It is the only thing between a user's argument and `log-delete ../../wp-config.php --yes`. The path is proved on the site before it is used — it resolves to the marker, the marker is writable by WP-CLI's user, the log folder holds no file of its name — so the refusal cannot pass for the wrong reason. |


### 2.20 Facts established auditing the whole of 6F again (2026-09-24)

Three independent reviews — one each for 6F.0–6F.1, 6F.2 and 6F.3 — and a re-read of my own, every
finding checked against the plugin source at `develop@f1ebfd0` or measured before it was fixed, and
every fix mutation-checked: **26 of 26** caught, each file restored byte for byte. Fixed:

- **A refusal could pass for an empty list (6F.1).** `Then the ids it printed are the site's own
  jobs…` never read the exit code, and on a site with no jobs of its own a refused `--format=ids`
  prints exactly the nothing it expected. It now requires exit 0.
- **A misspelt placeholder reached the plugin (6F.1).** Only `{words and spaces}` counted, so
  `{job_id}` — the plugin's own spelling of the flag — `{job2}` or `{ job }` went out as text, which
  the plugin reads as job `0` and refuses exactly as a "refused" scenario expects. Anything in braces
  is now a name, refused unless a step fills it, and a brace left after filling is refused too.
- **Command text could name a path off the site.** `backup-download … /var/www/other/wp-config.php
  --yes` would have been sent. The text as written may no longer hold an absolute path or a `..`
  segment; judged before filling, so the proven path out of the log folder still works.
- **A reinstall mid-scenario wiped the log the fatal gate reads (6F.2).** `finishActivation`'s
  reinstall ran the `@plugin` hook's whole install, whose first act is `clearDebugLog`, so whatever
  PHP logged before it — a fatal in the raced activation included — never reached the verdict. It now
  runs `replacePluginUnderTest`, the install without the reset, with the residue the hook reads
  (`declaredResidue`) instead of constants that only happened to match.
- **The teardown's stop failed a passing scenario over one lost round trip (6F.2).** Every other wait
  absorbs a probe failure; `stopRunningJobs` threw on the first. It now absorbs
  `PROBE_FAILURE_TOLERANCE` in a row, sends again a stop that never reached the site, and stops again
  a job whose marker comes back while its run is recording its end, instead of returning under it.
- **The "already running" scenario raced its own backup (6F.2).** Split in two — V136.
- **A symlink could send a download out of the private folder (6F.3).** `{download folder}` is now
  worked out on the site — V135. The folder is created `0700` by `mkdir` rather than `chmod`ed after,
  so the one mode set by hand in a docroot is `makeLogReadOnly`'s arranged precondition, which the
  ownership rule now names beside the staging area.
- **One listing, three copies (6F.3).** `listFiles` had no production caller and the two folder
  readers re-implemented it; all go through `listFiles` / `listLocatedFiles` now, with
  `missingAsEmpty` for the one directory a scenario may never have made.
- **A jobs option holding a scalar read as "no jobs"** — now refused.
- **Claims that were not true**, corrected where they stood: "every count is read back against a
  source" (they were typed numbers — each count above zero is now checked beside the ids it counted,
  `--type=DUMP` proves substring *and* case where `DBDUMP` proved only case, and `log --format=json`
  pins the sentence `readLastRunLog` relies on); `log --job_id`'s rationale (V138); the Backup Now
  job, one reused record with three writers (V139); "5 times in 10" (V122 recorded two jobs 7 times
  in 18); the setting's label (V137); the alias TSDoc §2.15 recorded as fixed and was not; "both
  stop at a question" (a download asks only onto an existing file); `log-delete` "reports success
  when it deleted nothing" (when it could not delete a log it found — a missing one is an error);
  "refused by name" (the download refusals name no file); guard files that "keep the logs from being
  served" (on Apache); and stdin "the same way everywhere", unmeasured on `docker` until V140.
- **A test that could not fail**: "a silent link is given up on" checked arithmetic on constants. It
  now silences a link under a running command and waits for ssh2's own probes to give up — 0.3 s with
  the probing shortened in the test alone; the production values stay pinned beside it.

**Also recorded, not fixed.** The staged plugin zip is downloadable while a run has it staged:
`.e2e_temp/plugins/<zip>` sits in the docroot under the build's own name, guessable by anyone who
knows the ref (`backwpup-pro-en-9.99.99-f1ebfd05.zip`), and nginx serves it (V134) — BackWPup Pro
is a commercial plugin. That is 6A's shared staging, documented as occasionally useful over HTTP, so
the change belongs to that design rather than to this audit; staging the plugin category the way the
download folder is staged would close it. **Planned as 6J instead** (§4.6J): the area stays as it
is, and the web server is told not to serve it. Outside 6F: `plugin.spec.ts`'s
cache-flush ordering check passes with the uninstall absent; `{@link}`s that resolve to nothing
(`ownership.ts:772`, `dashboard.page.ts:19/37/74`, `onboarding.page.ts:263`) and doc comments cut off
from their code (`run-context.ts:24`, `residue.ts:255`, `preflight.spec.ts:426`, `exec.spec.ts:146`,
`ownership.spec.ts:566/798`, `residue.spec.ts:357`).

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V134 | **nginx serves the staging area to anyone who can name a file in it.** A file in `.e2e_temp/…` answers HTTP 200; one inside a folder only the transport's user may enter answers 404; a directory is not listed (403). | Live, both nginx cells, with probe files planted and removed. | `downloads` creates its folder `0700`, verified, under a name with a random part — the copy is a whole database. Reported for the plugin zip above. |
| V135 | **A relative path that climbs out of a symlinked root leaves from the link's target.** PHP's `getcwd()` answers the physical directory, whatever the shell's `PWD` says, so `../e2e/downloads/<key>` from a root reached through a symlink resolves somewhere else — where `backup-download` would create a folder of its own, neither private nor cleaned up. | A scratch tree with PHP 8.1: the lexical path resolved to `false`, the one worked out from `getcwd()` to `realpath()` to the folder; then `DownloadFolder` end to end over a `wp eval` shim running real PHP, symlinked and plain layouts — folder `700`, the copy inside it, released. | `{download folder}` is `posix.relative(getcwd(), realpath(folder))`, both answered by the site in the request that creates it. |
| V136 | **The paced backup outlasts one round trip, not two.** Seen running 2.7–2.8 s after its start on `free@nginx`, it drops its marker at 7.6–8.1 s — about 5 s, where two refusals, each a placeholder fill and a command, cost about 5.3 s. The refusal's check lands 0.7–1.3 s into its command. The abort's margin is the same kind: an unaborted run finishes its archive 6.6–7.4 s after start, a kill sent at "seen running" lands at about 3.5–4 s. | A scratch probe mirroring the scenario, with an on-site PHP watcher timing the marker: two refusals in a row — the second **lost the race 1 time in 3** (`run {job} --background` started a second run) and won the other two by 0.06 s; one refusal per job — **4 of 4** refused, 3.5–3.9 s before the marker went. `pro@nginx`: 7.5 s before it, archive at 10.3–10.6 s. | The refusal scenario is two, one command each; every scenario of the feature now sends its running backup a single command. It had passed every run so far by that 0.06 s. |
| V137 | **The screen users see calls the setting "Maximum number script execution time (in seconds)".** That is the dashboard's Advanced Settings → Jobs panel (`parts/sidebar/settings-jobs.php`); "Maximum script execution time" is the legacy settings page's label, registered under a null parent and so reachable only by URL. Both save through `BackWPup_Page_Settings::save_post_form`. | `inc/class-admin.php:753` (`add_submenu_page( 'backwpup_null', … )`), `inc/class-page-settings.php:788`, `settings-jobs.php:71`. | The feature and `support/settings.ts` use the visible label, as the step promises. |
| V138 | **`log --job_id` never looks at the jobs.** It keeps the log headers whose `(int) job_id` equals the one asked for. | `src/Cli/Commands/Log.php:226-229`. | Asking about the hidden placeholder job is still the better question — "none" is right whatever the command makes of an unknown id — but not for the reason the step gave. |
| V139 | **Backup Now is one reused job record, written by three code paths**, each of which flags it `backup_now` in the same function that records its id. | `src/Backups/API/Rest.php:340-349`, `src/Abilities/Jobs/RunJob.php:407-418`, `src/Cli/Commands/Run.php:211-243`. | `scheduledJobs` keeps relying on the flag; its TSDoc names all three. |
| V140 | **On `docker` too, a command meets end-of-input at once.** The docker CLI attaches no stdin without `-i` (`AttachStdin` stays false), and the transport ignores its own. Through the repo's `exec()` a shell `read` answered status 1 in 58 ms, and WP-CLI's `confirm()` printed `Proceed? [y/n] ` and exited 0 in 116 ms, going no further. Measured once the user had started Docker Desktop, which on this runner needs an administrator's approval. | A throwaway container started as `docker/docker-compose.yml` starts its WP-CLI ones — `wordpress:cli-php8.3`, user `33:33`, WP-CLI 2.12.0 — then removed with its image. Controls: with `-i` and stdin left open the same `read` was still waiting at 5 s; given `y`, `confirm()` went on. `docker/cli`'s `container/exec.go`. | V126 holds on every transport; the docs say so. |
| V141 | **ssh2 cannot be made to close a socket it has stopped writing to.** `end()` and `destroy()` both return early once the socket is not writable, and node-ssh's `dispose()` calls `end()`, so the half-closed socket `withConnection` walks away from lingers until the server's own close arrives. | `node_modules/ssh2/lib/client.js:1179-1189`; node-ssh `dispose()`. | Documented at the call; reaching into ssh2's private socket would break on its next release. Bounded: one socket per recovered connection. |

**Verified 2026-09-24**, with `E2E_RETRIES=0` on a runner kept awake and the two cells run one after
the other (V72 — a parallel start was stopped in the Free run's first scenario, a database-only
backup, and its site confirmed clean): the full BackWPup suite passed **54/54 on `pro@nginx`**
(1.2 h) and **54/54 on `free@nginx`** (1.2 h), every scenario on its first attempt. Each cell met
V122's race once, and the reinstall — now leaving the log whole — recovered it. Both sites were left
as found: plugin absent, no footprint, no data folders, no staging area, no marker. Unit suite
**1027 → 1069** passed (8 skipped, unchanged); **26 of 26** mutations caught, and the five new stop
tests fail against the committed `stopRunningJobs`.

### 2.21 Facts established planning 6J (2026-09-24)

Measured in throwaway containers of the docker env's own images — `wordpress:php8.3-apache`, and
`nginx:1.27-alpine` running `docker/nginx/default.conf` — with probe files planted in the staging
root, `plugins/`, `plugins/public/` and `public/`, both images removed afterwards; and against the two
nginx cells with anonymous, read-only requests, nothing planted. The guards tested are §4.6J's
drafts, exactly as written there.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V142 | **The two guards deny the same thing.** Without them every staged file answers 200 — and on Apache a staged `.php` **runs**. With them, everything under the staging root answers 403 — any file, any extension, nested folders, `plugins/public/`, the directory itself — while the top-level `public/` keeps the server's normal handling: files 200, PHP run by Apache and handed to FastCGI by nginx. | Apache 2.4.68 with the image's own `AllowOverride All` (`conf-enabled/docker-php.conf`) and mod_rewrite; nginx 1.27.5. Nine paths on Apache, twelve on nginx, before and after. | 6J ships them as drafted — one rule in two languages. What they close is wider than the zip: anything staged, code included. |
| V143 | **The `.htaccess` fails open in one configuration only: `AllowOverride None`**, where Apache ignores it (200). Every other broken setup fails **closed**: `FileInfo` alone works; `AuthConfig` alone answers 500 inside the staging area, while a file outside it still answered 200; mod_rewrite disabled leaves the fallback's 403, `public/` included; a guard the web server cannot read (`0600`, another owner) answers 403. | The same Apache container, reconfigured and reloaded per case. | The probe is needed on Apache too, not only on servers that never read `.htaccess`. A guard a server cannot parse costs its own folder, never the site. |
| V144 | **nginx applies the include wherever it sits in `server {}`.** It picks the longest matching prefix before any regex, and `^~` on that prefix skips the regexes. Placed *after* the vhost's `\.php$` and static-asset regexes, it still denied `.php` and `.css` under the root and the normalised forms `/%2ee2e_temp/…` and `/x/../.e2e_temp/…`; the `.htaccess` — served as a plain file without the include — was denied too. | nginx's `ngx_http_core_module` docs (`location`); measured as above. | Operators can include it anywhere in the site's server block, and the file says so. |
| V145 | **The nginx cells name themselves, and sometimes go unanswered.** Both send `server: nginx/1.24.0 (Ubuntu)`. A missing file under `.e2e_temp/` answers WordPress's own 404 page (404, `text/html`, 52–59 KB, ~1 s). Several requests in a row then got no answer for 15–60 s, and both cells answered again minutes later. | `curl` from the runner. | The `Server` header is there to show, never to branch on; the probe's verdict is its own content, never a status; and its wait is bounded, with no answer reported as *could not check*. |

### 2.22 Facts established measuring 6F.4 before building it (live, on `pro@nginx`, at `develop@f1ebfd0`)

`develop` was still `f1ebfd05` (GitHub: identical, 0 commits ahead), and the zip the cell installs is
APVM's cached build byte for byte. A scratch driver installed BackWPup Pro with the lifecycle's own
`installPluginUnderTest` and `finishActivation`, onboarded one database job (`.tar`, monthly) with
`completeOnboarding`, made each archive with `runJobInForeground` — once with `startJobInBackground` —
and drove the four Pro-only commands through their round trips, refusals and edges, every archive's
SHA-256 read before anything touched it and its folder read afterwards for temporary files. Secrets were
compared on the site and never printed; the throwaway RSA pair sat in a `0700` folder. Two claims were
also reproduced locally, with the plugin's own classes on PHP 8.1 (V146's coercion, V149's exception
class). The site was left as found: plugin absent, no `backwpup`/`bwpup` option or table, no BackWPup
uploads, no staging area. Its `debug.log` (242 bytes, not read) was cleared by the first install, as
every `@plugin` scenario clears it. Follow-up runs the same day (V163–V167) — an import of a
`--passwords` export, an overwrite from an edited export, the Encryption panel's settings and the jobs'
own archive encryption — each started from a fresh install and ended with the site verified clean, on
WordPress 7.1.2 and PHP 8.3.33 (CLI). **Two of the predictions this pass was built to check were wrong**
(V149's exit code, V153's reach), and a crash first taken for the jobs' encryption failing was a memory
limit (V167) — which is why each was measured.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V146 | **`backup-encrypt` without `--key`, on a site whose encryption settings were never saved, destroys the archive and reports success.** The command reads `backwpup_cfg_encryption` with no default, gets `false`, and takes the RSA branch with `backwpup_cfg_publickey` — also `false`, which its non-strict file hands to `EncryptionStream` as `''` — so the stream falls back to AES under the `Random::string( 32 )` key the command generated and never keeps. It prints `Asymmetric encryption will be used for the archive.`, then `Success: Archive has been successfully encrypted.` | Live, twice: all three settings absent; exit 0; the header written is `BACKWPUP`, version 2, type **1** (symmetric), +26 bytes; no option added, changed or removed (snapshot between the backup and the command); `backup-decrypt` then answers `No Key provided or stored in settings for decryption!` without a key and `Archive could not be decrypted. Maybe wrong key!` with one, the file unchanged. `src/Cli/Commands/BackupEncrypt.php`; the coercion reproduced locally. This call is the command's own first help example. | The most serious plugin bug the port has found, and the one to report upstream first: §2.16's exit-0 failure at its worst, a success that loses the backup. No scenario sends it — it would pin data loss. The settings path is covered with the settings saved (V148). |
| V147 | **The symmetric round trip, measured.** A key of 32, 48 or 64 hex characters (AES-128/192/256) encrypts in place: `Symmetric encryption will be used for the archive.`, exit 0, the header `BACKWPUP`, version 2, type 1 and a 16-byte IV (+26 bytes, and up to 15 bytes of padding when the size is not a multiple of 16), and GNU tar no longer reads it (`This does not look like a tar archive`); `backup` still lists it under its name with the new size. `backup-decrypt` with the same key restores it byte for byte and leaves no temporary file. The archive is named by a **path**: relative to WP-CLI's working directory (the WordPress root) or absolute; its bare name is `Archive file that should be encrypted can't be found!` / `…decrypted can't be found!`. | Live: 42 284 544 → 42 284 570 → 42 284 544 bytes, SHA-256 equal; the same pair through `wp-content/uploads/backwpup/<hash>/backups/<archive>`; 32- and 48-hex round trips; encrypting an encrypted file added 26 + 6 bytes. | The round trip is asserted by digest, with the header and "no longer a tar" as the witness that encryption happened. 6F.4 needs a placeholder for the archive's path from WP-CLI's working directory, worked out on the site as `{download folder}` is (V135) — `{newest backup}` is a name, which the command refuses. |
| V148 | **The settings path and RSA key files are self-contained round trips too.** With `backwpup_cfg_encryption = symmetric` and a saved `backwpup_cfg_encryptionkey`, both commands work without `--key`. `--key=<file>` switches both to RSA: a public key file (PEM, SPKI) → `Asymmetric…`, type 2, +284 bytes for RSA-2048; the private key file (PKCS#8) restores it byte for byte. Given the public key instead, decrypt answers `Cannot decrypt: The key that was loaded was not a private key`; given a hex key, `Cannot decrypt: Unable to read key`. | Live, each byte for byte or unchanged as stated, no temporary file left; the settings removed again afterwards. | Candidate scenarios beyond `--key=<hex>`; none needs storage credentials. The settings path writes `backwpup_cfg_*` options, which the footprint sweep already covers (`backwpup`). |
| V149 | **A hex key of the wrong length crashes `backup-encrypt`** — at exit **1**, not the 255 predicted from source. `EncryptionStream`'s own check (`!$key && strlen( $key ) !== 32`) fires only on an empty key, so phpseclib's `AES::setKey()` throws `LengthException`, which the command's `catch ( \InvalidArgumentException )` does not catch; WordPress's fatal-error handler then answers `Error: There has been a critical error on this website.` The fatal lands in `debug.log`, the archive is untouched, and an **empty `<archive>.encrypted`** is left beside it — opened before the key is used. The next successful encrypt appends to that empty file and leaves nothing behind. | Live: 4 and 40 hex characters, the fatal and its trace on stderr, `debug.log` holding both; the class reproduced locally. | A plugin bug worth reporting. Never a scenario: the debug-log gate fails a fatal, rightly, and the scenario would pin a crash (as V128). Keys are 32, 48 or 64 hex characters. |
| V150 | **A wrong-length key on decrypt is caught, but leaves an empty `<archive>.decrypted`.** `Cannot decrypt: Key of size 2 not supported by this algorithm. Only keys of sizes 16, 24 or 32 supported`, exit 1, the archive unchanged; the exception path skips the cleanup the wrong-key path does. The next decrypt removes it. | Live, `--key=abcd`. | A refusal that writes; not a scenario. V151 is the refusal to cover. |
| V151 | **A wrong key of the right length is refused, and the encrypted archive survives byte for byte.** The decrypter cannot recognise a wrong key: it decrypts into `<archive>.decrypted` and replaces the archive only if the result lists as a valid archive, deleting it otherwise. `Archive could not be decrypted. Maybe wrong key!`, exit 1, no temporary file, nothing in `debug.log`; the right key afterwards restores the original byte for byte. | Live. `vendor/inpsyde/backwpup-restore-shared/src/Api/Module/Decryption/Decrypter.php` (`test()`, then `unlink` and `rename`). | The refusal §4.6F.4 lacks, and the one that guards the only copy of a backup. |
| V152 | **Encrypting twice is not refused, and the plugin cannot undo it.** Both runs exit 0 with `Success:`; decrypting with the right key then answers `Archive could not be decrypted. Maybe wrong key!` every time and leaves the file unchanged, because the first layer's plaintext is itself encrypted and fails the archive check. | Live: 42 285 568 → 42 285 594 → 42 285 626 bytes; two decrypts, both refused. | A plugin bug worth reporting — encrypt could ask `isEncrypted()`, as decrypt does. Not pinned; no scenario encrypts twice. |
| V153 | **Decrypt strips padding that encrypt never added — but never from the plugin's own archives.** Encrypt pads only a size that is not a multiple of 16; decrypt always drops the last *N* bytes when the final byte *N* is 1–16. A valid single-member `.tar.gz` of the kind `gzip` makes, 17 440 bytes, ending in `0x01` (the top byte of its size field), came back from the round trip one byte short under `Success: Archive has been successfully decrypted.` — `gzip -t`: `unexpected end of file`. The plugin's own formats all end in `0x00`: a `.tar` in its 1 024-byte end-of-archive; a `.tar.gz` too, since the plugin gzips every write as its own member and the end-of-archive is the last (size field 1 024); a `.zip` in an end-of-central-directory record with an empty comment. | Crafted file staged and run through both commands; a real `.tar.gz` backup whose size was a multiple of 16 (4 744 688 bytes) and a real `.zip`, each byte for byte. `inc/class-create-archive.php` (`fwrite()` → `gzencode()`, `close()` → `pack( 'a1024', '' )`). | A plugin bug for files it did not make — `backup-encrypt` takes any path. No 6F.4 scenario is exposed; the digest assertion would catch it if a format changed. The source-read guess that a large `.tar.gz` was at risk is refuted. |
| V154 | **An archive the web server wrote encrypts and decrypts all the same, and comes back WP-CLI's.** It was `www-data 644` and not writable by WP-CLI; the folder is `0777`, so the command's unlink-and-rename went through, and the result is `ubuntu 664` — still after decrypting, byte for byte. | Live, `startJobInBackground`, `is_writable()` 0 before and 1 after. | No ownership split to cover, unlike `backup-delete` (V84). An encrypt hands the archive to the transport's user, so a `backup-delete` refused before would then succeed; nothing depends on that, and nothing pins it. |
| V155 | **Encrypt and decrypt refusals, measured.** `--key=xyz`, `--key=` and the help's own example key (`ABCDEFGHIJKLMNOPQRSTUVWXYZ123456`) → `Key must be a string of hexadecimal characters!`; a missing file → `Archive file that should be encrypted can't be found!` / `…decrypted can't be found!`; a plain archive → `Archive not needs decryption.`; decrypt with no key on an unconfigured site → `No Key provided or stored in settings for decryption!`; no argument → WP-CLI's `usage:` line and no status line. | Live: all exit 1, the archive byte for byte, no temporary file. | V85's list, confirmed and extended. The help's example key being refused is a docs bug. |
| V156 | **`job-export`'s shape and what it leaves out.** All jobs export as a JSON **object keyed by the jobs option's own index** (`"2"`, `"3"` for jobs 3 and 4), not by job id; one job exports the same way, under one key. `--file` resolves against WP-CLI's working directory, written as WP-CLI's user (`664`); a missing folder is a PHP warning (also in `debug.log`), then `Error: Could not write to file.`, exit 1. Of the 136 stored keys it left out 43 — the nine the source lists, every empty string (33) and every encrypted value (`dbdumpdbpassword`) — and every value it carried equals the stored one. An unknown id and the hidden placeholder print `[]` at exit 0; with `--file`, `[]` is written under `Success: Job exported successfully.` | Live, compared key by key with the stored record. `src/Cli/Commands/JobExport.php`. | An export is judged against the stored record, on the keys it carries. "Nothing to export" is a success with an empty list, not an error. |
| V157 | **`--passwords` writes the site's database password in clear.** Every job the plugin makes stores `dbdumpdbpassword` — the site's own `DB_PASSWORD`, encrypted — including the hidden placeholder, even with "use WordPress's database settings" on; so does `defaults_job()`. Without the flag the key is left out; with it, the file and stdout both carry the plaintext. An export always carries the database host, name and user. | Live: all six jobs on the site and the default decrypt to `DB_PASSWORD`; the exported value equals it — `hash_equals` on the site for the file, digests compared for stdout; never printed. `inc/Pro/class-jobtype-dbdump.php` L29 is the default. | An export is a credentials-bearing file: 6F.4 writes exports only into the scenario's private folder and removes them. Importing a `--passwords` file stores the password back **unencrypted** (V163). §4.6F.4 does not cover `--passwords`. |
| V158 | **`job-import` without `--job_id` appends a faithful, unscheduled copy.** The new job takes `max( ids ) + 1` (`Success: Job "Database" with ID 5 imported successfully.`) and equals the original on every key but the id, `activ` (`false`) and `activetype` (`''`) — so no `backwpup_cron` event — the run history (`lastrun`, `lastruntime`, `backup_ids` absent; `logfile`, `lastbackupdownloadurl` empty), and `dbdumpdbpassword`, taken from `defaults_job()` and so the site's own again (V157). Every key dropped as empty came back `''`. The original and its schedule are untouched. A `--job_id` the file holds but the site does not appends too, under a new id, never the one asked for (77 → 6). | Live, key by key against the stored records. `src/Cli/Commands/JobImport.php`. | The append scenario asserts the copy against the original's stored record, the new id, the missing schedule and the untouched original — never the success line. |
| V159 | **`job-import --job_id=<n>` merges; it does not replace.** Only the keys the file carries are written over job *n*. After renaming job 3, switching its format to `.zip` and filling `fileexclude` (empty at export, so absent from the file), the import restored the name and the format and **kept** `fileexclude`; `activetype`, its cron event, `lastrun` and `logfile` were untouched, and no job was added. | Live. V86's check had re-imported unchanged data, so the overwrite had never been observed. | The overwrite scenario must change an exported field between the export and the import; a field the export dropped stays as it was, and that is correct. |
| V160 | **`job-import`'s refusals — and a refusal that keeps what it wrote.** `No file provided or file can't be found!` for no argument and a missing path (positional or `--file`); `File is not a valid JSON file!` for non-JSON **and for `[]`**, the empty export (V156); `File is not a valid BackWPup job export file!` for `{"a":1}` and a job whose `type` is not a list; `{}` and `42` add PHP warnings (in `debug.log`) before `No job with ID 0 found!`; `--job_id=4` against a file without job 4 → `No job with ID 4 found!`, although the site holds it. All exit 1 and leave the jobs option byte for byte. But each job is validated inside the loop that writes it: `[<valid job>, {"jobid":"x"}]` imports the first (`Success: … with ID 7 imported successfully.`), then refuses, exit 1 — **and job 7 stays**. | Live, the jobs option's digest before and after each. | Refusal scenarios use one-job or non-job files and assert the jobs unchanged. The partial import is a plugin bug worth reporting; not pinned. |
| V161 | **The edition filter works by generation, not by skipping.** A temporary feature holding a `@pro`, a `@free` and an untagged scenario, generated with the product's own `bddgen`: `free@nginx`'s spec holds the free and untagged ones and no trace of the `@pro` one; `pro@nginx`'s the reverse. A `@pro` on the `Feature:` line works the same: `free@nginx` generates no spec file for it at all. `--list` agrees. No feature in the suite is tagged `@pro` or `@free` yet. | Local, both placements; the features removed and the specs regenerated, the tree clean. | §4.6F.4's "skipped by tag on `free@nginx`" describes a mechanism the suite does not use: a `@pro` scenario never exists on a Free cell. The check is that `free@nginx`'s `--list` holds none of them — and 6F.4 is the first feature to rely on it. |
| V162 | **Four sites now share the nginx host.** `pro@nginx` (`simple.e2e`), `free@nginx` (`bwu.e2e`), and the orchestrator worktree's two cells (`bwu2.e2e`, `bwu3.e2e`) all resolve to one SSH host and one disk — 97 GB, 17 GB free (84 % used) before and after this pass. | The two checkouts' sites files, hosts only. | V72's one-cell-at-a-time rule now reaches across checkouts: a live run in either must check the other is idle. This pass made database backups only — about 42 MB each, at most about fifteen on disk at once. |
| V163 | **`job-import` stores a `--passwords` export's secrets in clear.** The copy's `dbdumpdbpassword` is not `$BackWPup$…` but `DB_PASSWORD` itself, and the raw `backwpup_jobs` row holds it verbatim. Nothing breaks, because `BackWPup_Encryption::decrypt()` hands an unprefixed value back unchanged — which is what hides it. | Live: the row held no `DB_PASSWORD` before the import, did after, and did not once the copy was deleted; compared on the site. `JobImport.php` L94 and L116 write values as they are; `JobExport.php` L103–L105 decrypted them. | A `--passwords` round trip would put the site's database password into its options table in clear — a second reason §4.6F.4 leaves the flag out. A plugin bug worth reporting (security). |
| V164 | **An edited export drives the overwrite, and the job keeps its schedule.** Export job 3, rename it inside the file (decoded and re-encoded on the site; the object keyed by the option's index stays an object), then `job-import <file> --job_id=3` → `Success: Job "Renamed by the import" with ID 3 imported successfully.` Job 3 takes the name, no job is added, and its `activetype`, `activ` and `backwpup_cron` event are as they were; every key the file carries equals the file; `wp backwpup job` lists the new name. | Live. | The overwrite scenario edits the file — what a user migrating jobs does — so no job-editing path is needed, and the kept schedule is what makes V159's merge observable on a key the file does not carry. |
| V165 | **Saving the Encryption panel stores three options, one of them the jobs' own encryption switch.** `EncryptionSettingUpdater::update()` saves the type (`symmetric`/`asymmetric`) and `backwpup_archiveencryption` (the panel's "encryption activated"), then the symmetric key — hex, cut to 64 characters — and the public key, each only when given. `backwpup_archiveencryption` makes every job encrypt its archive (`inc/class-job.php` L515). Stored with it off, a job's backup is plain and both commands round-trip without `--key`, byte for byte. | `inc/Pro/Settings/EncryptionSettingUpdater.php`; live round trip. | The settings scenario stores archive encryption off — otherwise the Background's own backup would arrive encrypted and the scenario's encrypt would be V152's second layer — and it never turns it on (V166, V167). |
| V166 | **The jobs' own archive encryption shares V146's fallback.** With archive encryption on and the type saved as `asymmetric` but no public key — a state the handler saves, since it requires no key — a run completes at exit 0 and logs `Encrypted 40.38 MB of data.` / `Archive has been successfully encrypted.`; the archive is `BACKWPUP`, version 2, type **1**, +26 bytes; `backup-decrypt` refuses it with and without a key; no option holds a key. With no type saved at all, the run logs `No encryption key was provided. Aborting encryption.` and keeps a plain archive. | Live, two fresh installs (header and decrypt checked on the second). `inc/class-job.php` L2625–L2632 and L2675–L2683, no `strict_types`. The panel template marks no field required; its JavaScript was not traced. | Every scheduled backup made in that state is unrecoverable and reported as encrypted — the same root cause as V146, reported with it. No scenario turns archive encryption on. |
| V167 | **With archive encryption on, a foreground run can die against a memory limit the job set itself.** The CLI's `memory_limit` is `-1`, so `WP_MAX_MEMORY_LIMIT` is too; the job sets that, and then `need_free_memory( '10M' )`, called on every progress update, reads `-1` as a number and lowers the limit to usage + ~11 MB. With archive encryption on, 4 of 8 foreground runs failed — 3 with `Allowed memory size of 79691776 bytes exhausted (tried to allocate 3858872 bytes)` in `inc/class-mysqldump.php` L760, 1 at exit 255 with its output not kept — a valid symmetric key included; with it off, 0 of 19. Each crash left its history row `created` and the running marker behind until `kill`. | Live, three fresh installs. `inc/class-job.php` L1471, L1523–L1531, L1541–L1553, L2214–L2222. Why encryption raises the odds was **not** isolated: the fatal is in the dump, before any encryption step. | Refines V109: V41's memory death is not only `wp cron event run`'s. The suite's foreground Givens are safe — nothing turns archive encryption on — and 6F.4 keeps it that way. A plugin bug worth reporting. |

### 2.23 Facts established building and auditing 6F.4 (live, on `pro@nginx`, at `develop@af1ab5c`)

`develop` moved while 6F.4 was being built (V168), so the build was verified at the ref the cells now
install, and the facts it rests on were measured again there (V169). V172–V175 are the audit's. Each
run used the repo's own modules or the suite itself, and the site was verified clean after each.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V168 | **`develop` moved to `af1ab5c` (2026-09-25) — its vendored libraries only.** The commits change `composer.json` and `composer.lock`: phpseclib 3.0.52 → 3.0.57, pear/archive_tar 1.6.0 → 1.6.1, backwpup-archiver 0.6 → 0.6.1 (zip-extraction path-traversal fixes), backwpup-restore-shared 0.20.10 → 0.20.11 (no PHP change), monolog 2.11.0 → 2.11.1, inpsyde/assert to 1.0.0. Every BackWPup file 6F.4 rests on is byte-identical: the four commands, `EncryptionStream`, the `Decrypter`, `class-job.php`, `class-create-archive.php`, `EncryptionSettingUpdater`, the database job's defaults. | GitHub compares of the plugin (`f1ebfd05...develop`) and of both BackWPup packages by tag; the two builds unpacked and diffed — 54 files differ, all vendored but the translation template and the autoloader. The versions read back on the site through `Composer\InstalledVersions`. | The code under test is unchanged, but the libraries it calls are not — so every fact that depends on them was measured again (V169) rather than carried over. |
| V169 | **At `af1ab5c` every §2.22 fact the scenarios do not cover holds as measured.** V146: no `--key` on an unconfigured site — `Asymmetric…` and `Success`, a symmetric header, nothing decrypts it. V149/V150: a 4-hex key — the `LengthException` fatal at exit 1 with an empty `.encrypted` left; decrypt's refusal with an empty `.decrypted`. V152: a second encrypt succeeds, and decryption is then refused. V153: the crafted 17 440-byte file came back 17 439 bytes under `Success`. V163: an imported `--passwords` export is stored in clear. V166: the jobs' own encryption with `asymmetric` and no public key logs success over a symmetric header nothing decrypts. V167: with archive encryption on, 3 of 6 foreground runs died of the same fatal, with the same two numbers. | Two scratch drivers, one fresh install each, both torn down clean. | What §2.22 found worth reporting upstream still holds at `af1ab5c`. |
| V170 | **A unit run beside a live run wiped the live run's results.** Playwright empties its output folder as a run starts, and the unit config left it at the default, `test-results/` — which holds every cell's `test-results/<product>/<cell>/`. The first live attempt failed writing its own attachment (`ENOENT … test-results/.playwright-artifacts-1/…zip`) while a unit spec ran. | After the fix, a marker in a cell's folder survived a unit run. CI uploads all of `test-results/`, the unit folder included. | `playwright.unit.config.ts` writes to `test-results/unit`. |
| V171 | **The revision's three unmeasured predictions held live.** A `--job_id` in neither the file nor the site is refused as `No job with ID 999 found!`; a key file named relative to WP-CLI's working directory works for both commands (V148 had used absolute paths); and every setting an export carries compares equal to the stored job's on the site — no empty object turned into a list on the way. | The two features, 9 of 9 on `pro@nginx` at `af1ab5c`. | Nothing to change. |
| V172 | **A hex key of 31, 47 or 63 characters is not a wrong length.** Both commands turn the key into bytes with `pack( 'H*' )`, which completes an odd count of digits with a `0`, so these come out as 16, 24 or 32 bytes: the round trip works, and the key with a `0` appended decrypts it too — the two name the same bytes. A count that packs to any other size — 33 characters, 17 bytes — crashes `backup-encrypt` as V149's 4 and 40 did. | Live on `pro@nginx`: 63, 31 and 47 characters each round-tripped byte for byte twice — the second time decrypted with the key plus `0` — leaving nothing beside the archive; 33 died of `LengthException: Key of size 17 …` at exit 1, the archive unchanged, an `<archive>.encrypted` beside it and the fatal in `debug.log`. The plugin's own classes, run locally, gave the same. | V149's "keys are 32, 48 or 64 hex characters" is the suite's choice, not the plugin's rule. `support/encryption-keys.ts` said otherwise and is corrected, as is what goes upstream about key lengths. |
| V173 | **The export scenario passed an export carrying nothing but its job's id.** Each of its four checks held what the file carries to the job, or what it leaves out; none held the job to the file, so a regression that dropped settings from the export would have passed. `job-export` leaves a setting out only when it is one of the nine stripped keys, an empty string, or an encrypted value (`JobExport.php` L88–L109) — so everything else the job holds must be in the file. | The audit. Live on `pro@nginx`: nothing missing from a real export, and nothing differing; with one setting (`dbcheckrepair`) removed from the file, the new check named it. | `settingsMissingFromExport` and its step (`every setting the scheduled job holds is in the export file {string}, except its schedule, run history, secrets and empty ones`); the scenario now holds the file and the job equal both ways. |
| V174 | **V122's race can also end in a PHP fatal, failing a scenario before its first step.** In the full `pro@nginx` run, the host's per-minute `wp-cron.php` request re-entered BackWPup's activation while the `@plugin` hook's own install was under way, found a job holding `cron` but no `type`, and died in `BackWPup_Migrate::organize_jobs_by_type()` — `sort( null )`, `inc/class-migrate.php` L174. The debug-log gate failed the scenario; the install hook, 107 s in by then, also ran out of its 120 s (the whole install and activation took 40 s in the audit's lab, 75 minutes later). | The scenario's `debug.log`: `Undefined array key "type"` (L173), then the fatal at 05:48:01 UTC, a minute boundary, stack `wp-cron.php` → `BackWPup_Install::activate()` → `BackWPup_Migrate::migrate()`. The plugin writes a job one key per write of the whole jobs option, with no lock, and two of its paths leave a job with `cron` but no `type` for a while: V122's lost update, and `convert_jobs()` itself, which writes a job's `cron` (`handle_single_job()`, L301) before its `type` (L241, L255). Which of the two it was is not established; `create_default_jobs()` is not it, since it writes `type` first. The link was slow around it: five minutes later a `wp eval` took 1.9 s against the 1.3 s measured before, and the scenario before it had taken 4.9 min against 1.8 min in the 6F.4 run; the runner never slept. The same run met the race three more times, each recovered by a reinstall as designed — four in 61 scenarios, against V122's ~3 % — and the `free@nginx` run none in 52. In the next run of its feature, after the audit, the scenario passed. | Not 6F.4's: its steps never ran. The retry policy absorbs it as flaky; with retries off it fails, as it should — the fatal is real. The plugin bug V122 records (re-entrant activation, the jobs option written without a lock) now has a fatal among its outcomes. A slow link widens the window: the activation routine runs in the first request after the install (V122), and the suite's own next command is then longer coming. |
| V175 | **The nginx host is the team's QA host, not four sites'.** `/var/www/html` holds 28 docroots — `bwu4`–`bwu9` created 2026-09-25/26 — several changed the same day; the disk is 97 GB, 16 GB free. | Read on the host, 2026-09-27. | "The host's other sites idle" (V162) can only mean this suite's own runs: they stay one at a time; other people's load shows as slower scenarios (V174). |

### 2.24 Facts established scoping 6G.0 (2026-09-28)

Measured through the repo's own `exec` and `CliSession` (execa 10.0.1), each failing case carrying a
fake secret in its argv; the `ssh` cases on `pro@nginx`.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V176 | **On `local` and `docker`, a command that cannot start, is killed by a signal, or overflows its output cap throws an error quoting its whole argv.** `fromExeca` passes on execa's `shortMessage`, which holds the command line: `Command failed with ENOENT: no-such-binary-e2e eval '--key=SECRET-enoent-1'`; `Command was killed with SIGTERM (Termination): sh -c 'kill -TERM $$' sh '--key=SECRET-signal-2'`; `Command's stdout was larger than 100000000 characters: sh -c … '--key=SECRET-buffer-3'`; and, with no `docker` on `PATH`, `Command failed with ENOENT: docker exec no-such-container wp eval '--key=SECRET-docker-4'`. | The four cases through `exec`: the secret in the message 4 of 4, and no `cause` attached. execa's result says why without the argv — `code` (`ENOENT`), `signal` and `signalDescription` (`SIGTERM`, `Termination`), `isMaxBuffer` — while the argv is in `message`, `shortMessage`, `command` and `escapedCommand`. | Every `--key=` and every value a snippet embeds travels in the argv, and `phpLiteral`'s base64 hides nothing, so a report of such a failure carries them: "credentials never enter reports" (CLAUDE.md) and 6F.4's acceptance do not hold on these two transports. |
| V177 | **`ssh` quotes no argument.** A command killed by a signal reads `"sh" on <host> was terminated by signal SIGTERM before exiting.`; a missing program is an exit-127 result whose output names only the program. | Both on `pro@nginx`, a secret planted in each argv: in neither. | The cells are not exposed; 6G.0 brings `local` and `docker` to what `ssh` already does. |
| V178 | **`CliSession`'s time-limit message quotes its command unmasked, on every transport.** `withinBudget` names `` `wp backwpup ${args.join(" ")}` `` — the argv with its placeholders filled — so a `--key=` that `describeCli` hides reaches it: `` `wp backwpup backup-encrypt a.tar --key=SECRET-budget-7` had not answered after 0.3 s. `` | A stub `wp` sleeping past a 300 ms budget. Only `I watch the running backup with the BackWPup command {string}` passes a budget (`cli-running-job.feature`, ten minutes), and no command there carries a key today. | The same class as V176, one layer up. |
| V179 | **6G puts nothing secret in an argv.** `wp backwpup restore` takes a file, `--yes` and `--pre-backup` (`src/Cli/Commands/Restore.php`); 6F.4's keys are drawn per scenario and thrown away; 6H.2 plans its credentials through the UI (§4.6H.2), where traces already carry what `fill()` types (CLAUDE.md). | Source at `af1ab5c`; this plan. | Nothing in 6G forces the fix. What does is that the suite claims a property it does not have on two transports, and that the fix is two functions. |

### 2.25 Facts established building 6G.0 (2026-09-29)

Measured through the repo's own `exec` (execa 10.0.1) with a secret planted in each argv; the `ssh`
cases on `pro@nginx`. Each is pinned in `exec.spec.ts` or `exec.ssh.spec.ts`.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V180 | **`ENOENT` means a missing program or a missing working directory**, and `code` cannot tell them apart. Only execa's own message does (`The "cwd" option is invalid: …`), and that message quotes the argv. | `exec(local, "sh", […], { cwd: "/nonexistent" })` and a missing binary: `code` `ENOENT` both times. | The message names both readings, with the directory the run was given: `could not be started (ENOENT): no such program on this machine, or no directory "<cwd>" to run it in`. |
| V181 | **Output that never stops ends killed, with no exit code.** `yes` over the cap reports `signal` `SIGPIPE`, `isMaxBuffer` true, `exitCode` undefined (1.5 s). Output that stops over the cap keeps its exit code (`exit 3`, and `0`). | Both through execa, with the default cap. | `fromExeca` checks the overflow **before** the missing exit code: in the other order the message would blame `SIGPIPE` and hide the cause. |
| V182 | **execa throws when an argument holds a NUL byte, even with `reject: false`, and the error quotes that argument:** `Arguments cannot contain null bytes ("\0"): --key=SECRET x`. Its other argument checks interpolate the argv too (`lib/methods/parameters.js`). Over `ssh` the same argv is refused as a bare `Unable to exec`, with nothing quoted. | Local through execa; `ssh` on `pro@nginx`, `printf` and `sh` each handed `a\0b`. | `exec` refuses a NUL byte before any transport sees it, naming the argument by position, so all three say the same thing. Any other execa throw is replaced by `"<program>" could not be started: execa refused the call (<ErrorName>)`, with no `cause`. |
| V183 | **One argv-quoting message could carry a key: `readJsonList`'s parse error.** It names `cli.last`, which is a scenario's own command, and it quoted both the argv and the output unmasked. The rest name fixed commands, job ids, option names and paths: `backups.ts`, `options.ts`, `residue.ts`, and `cron.ts` through `evalPhp`, which quotes its `what` and the site's output, never the snippet. | The audit, reading each site. | `parseJsonList` takes the argv and names it through `commandLine`, the mask `describeCli` and the time-limit message use, and hides a key in the output it quotes. |
| V184 | **`cli-running-job.feature` loses its race on `pro@apache`**, with or without 6G.0. The step `the scheduled job is running in the background` sees the job running, but the paced backup has ended before the next command lands. `run {job}` and `run {job} --background` then run or dispatch a fresh backup and exit 0, where the scenario expects `A job is already running.`, and `kill` sometimes finds nothing to abort. The margin in the feature's comment ("more than 2 s to spare") was measured on the nginx cells, and every 6F verification ran on `pro@nginx` and `free@nginx` only — apache was AutoE2E's. | `E2E_RETRIES=0`, the `af1ab5c` zip: with 6G.0, 1/4 (the `status` scenario passed); with 6G.0 stashed, 2/4, the two `run` scenarios failing identically. The same feature passed 4/4 on `pro@nginx` in the same hour. | Not 6G.0's: its change is to failure messages, and these are exit-code assertions that fail at the baseline too. ~~Open.~~ **Fixed 2026-09-30** — the cause and the fix are V185–V187. |

### 2.26 Facts established fixing V184 (2026-09-30)

Measured live on `pro@apache` and `pro@nginx` with the `af1ab5c` Pro zip, from inside each site: a
`wp eval` sampling BackWPup's running marker and newest history row every 20 ms, and the scenario's
own steps timed against the server's clock.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V185 | **A paced database backup pauses once per table, so its length is the site's table count.** "Reduce server load" is a `usleep` in `update_working_data()` (honoured up to 500 000 µs; the screen offers 90 000 at most), and the dump calls that once per table, over every table in the database (`SHOW FULL TABLES`), less the job's exclusions — none for the onboarding job. `pro@apache` holds 18 tables and ran it in **3.5 s**; `pro@nginx` holds 85 and ran it in **10.2 s**. | `inc/class-job.php` `update_working_data()`; `inc/Pro/class-jobtype-dbdump.php` `db_dump()`; `inc/class-mysqldump.php`. Three sampled runs per cell, 0.1 s apart at most. | V112's "~10 s" was one cell's table count. The window cannot be widened by the setting, which is already at the screen's maximum. |
| V186 | **The command under test lands 2.3–3.2 s after the marker appears** — the job is seen 0.9–1.6 s in, and one WP-CLI command takes about 1.5 s more. On `pro@apache` that left 0.3–0.7 s; the suite's runs lost it. | The same runs: `waitForJobRunning` then `wp backwpup run <job>`, timed against the server's clock (offset from a `date` round trip). | Any site with fewer than about 30 tables loses the race some of the time. |
| V187 | **Padded to 100 tables, the window is the same on both cells**: 11.1 s on `pro@apache` (82 empty tables added) and 11.6 s on `pro@nginx` (15 added), with the command back by 2.9 s. Creating 82 tables took 1.8 s. A test fixture is torn down after every `afterEach` — where playwright-bdd runs `After` hooks — including when the test failed. | The same sampler; a scratch Playwright test for the order. | `Given the site's database holds at least 100 tables` and the `tablePadding` fixture (`support/table-padding.ts`): empty `<prefix>e2e_pace_NNN` tables, earlier padding dropped first, the result read back, removed after the `@plugin` teardown has stopped the job and removed the plugin. |
| V188 | **A killed run's padding outlived it, and only `cli-running-job.feature` would ever remove it.** SIGKILLed once its padding existed, a run on `pro@nginx` left 15 tables; a later run of another feature removed the plugin, its footprint, the staging area and the data folders, and kept all 15. They never piled up — the names are fixed and every padding drops the last one first — but nothing else would ever drop them. | Live on `pro@nginx`, the run's process group killed the moment the site held padding. | Every BackWPup worker now drops leftover padding before its first scenario (`leftoverPaddingSweep`, `sweepPaddingLeftovers`) and says how many. Re-verified: the other feature's run then removed the 15; two runs killed back to back each saw the last one's 15 gone 23 s in, padded their own (new creation times) and left 15 — one set; the next full run swept them and passed 4/4. The snippets now also run against a fake `$wpdb` in `table-padding.php.spec.ts`, killed runs replayed included. |

### 2.27 Facts established widening 6G's coverage (2026-10-05, source at `af1ab5c`)

Source only, both editions' zips at `af1ab5c` — to be confirmed live by 6G's measurement pass, per
the usual rule. Every file cited below is byte-identical in Free and Pro.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V189 | **The restore screen offers only the strategies the archive can serve.** It reads the job types from the backup's `manifest.json`: *Database Only* needs `DBDUMP`, *Files Only* needs any other type, *Full Restore* needs both. Onboarding's files job is `FILE` + `WPPLUGIN` and its database job is `DBDUMP`, so a files-only backup offers **only** *Files Only*, a database-only backup **only** *Database Only*, and a mixed backup all three. | `views/restore/steps/step2_action.php:12-56`; `vendor/inpsyde/backwpup-restore-shared/src/Api/Module/Manifest/ManifestFile.php:183-198`; `inc/class-page-onboarding.php:12,19`. | Restoring a files-only or database-only **backup** is a different journey from choosing a strategy on a mixed one: other buttons, and an archive missing half the site. 6G covers both (§4.6G), and each asserts the strategies it is offered. |
| V190 | **Three archive formats exist: `.tar` (the default), `.tar.gz` and `.zip`.** `.tar.bz2` is no longer offered: a stored one is read back as `.tar.gz`, and the restore refuses a bzip2 archive outright. | `inc/class-install.php:15-22` (default `.tar`); `inc/class-admin.php:902-907` (anything else falls back to `.tar`); `inc/class-option.php:392`; `Decompressor.php:387-396`; `src/Cli/Commands/Restore.php:17`. | Every 6D–6F backup is `.tar`, and onboarding can make nothing else, so a `.zip` or `.tar.gz` backup needs the job's format switched after onboarding. 6G restores `.tar` only; `.zip` and `.tar.gz` are 6K. `.tar.bz2` is out of scope: it cannot be made any more. |
| V191 | **Each format is extracted by different code, and the UI and the CLI do not share it.** UI: `.tar` → `PharData`, `.tar.gz` → PEAR `Archive_Tar`, `.zip` → its own file-by-file extractor with progress events. CLI: `.zip` → `ZipArchive`, `.tar.gz` → `PharData::decompress` then extract, `.tar` → `PharData`. | `Decompressor.php:244-311,379-402`; `src/Cli/Helpers/CommandsRestoreHelpersTrait.php:50-100`. | A `.tar` restore proves nothing about the other two, in either entry path, so the format axis is real (6K). The content axis is not: the extractor is chosen by extension and never by contents, so 6K restores mixed backups only and does not multiply by contents. |
| V192 | **CLI `--type=full\|db\|file` is the strategy choice of the UI screen**, defaulting to `full`. | `src/Cli/Commands/Restore.php:90-94`. | 6G's CLI scenarios use it the way the UI ones use the strategy buttons. |


### 2.28 Facts established measuring 6G (2026-10-05, live on `pro@nginx`, `develop@a612005`)

Measured on `simple.e2e` with the repo's own modules driving a fresh install, the plugin's own
onboarding seeding, a real backup (~412 MB `.tar`) and the restore — in the browser (Playwright,
headless) and over WP-CLI — after every backup the two markers changed, and the site's state read
before and after. Free was measured on the same site with the Free build of the same commit. The site
was left as found; what the CLI measurements broke was repaired with the user's approval (V205).

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V193 | **`develop` moved past `af1ab5c` on 2026-10-02 (`a612005`).** `214ad9d` names the restore working directory per install and sweeps abandoned ones after 6 h; `8c912a9` runs a scheduled job inside the WP-Cron request (and only there: `wp_doing_cron()`); `59b6fd9` releases the archive before a restart. The CLI restore and the wizard's views and scripts are unchanged. | `gh api …/compare/af1ab5c1...a6120057`; both builds unpacked and diffed. | 6G is measured and built at `a612005`; V189–V192 re-checked there (V199, V204). |
| V194 | **The restore working directory is `uploads/backwpup-restore-<20 hex>`, and on Pro a WP-CLI backup listing creates it unwritable by the web server.** `wp backwpup backup` reaches `restore_registry()` through Pro's folder destination, which creates the directory as the transport's user (`ubuntu:ubuntu 0775`, `restore.dat 0664`); the next admin page that lists backups dies on an uncaught `FileSystemException` ("Restore working directory … is not writable, protection files cannot be created") — HTTP 500. Free's listing never reaches it. The name lives in `backwpup_restore_dir_token`, drawn on first need. | `commons.php` `restore_dir_name()`, `ensure_uploads_folder_protected()`; `WorkingDirectoryProtector::protect()`; reproduced on the history page at 19:00:53. | A plugin regression (an uncaught exception where `af1ab5c` only failed softly) to report upstream. The suite prepares the directory after every install from the plugin's own `restore_dir_name()` (`ProductConfig.resolveSiteDataDirs`, V196). |
| V195 | **Prepared, the directory still fails the wizard once WP-CLI has written `restore.dat` in it.** *(Corrected by V220: the answer was a stream that ended, not an HTML page.)* A listing recreates `restore.dat` (`ubuntu 0664`) whenever the last restore's cleanup removed it; every wizard request then dies on "Could not write Registry file", answering its event stream with an HTML error page — and the browser's `EventSource` reconnects every ~3.5 s for ever, the page stuck on step 1. | Run 2: the `download` stream fataled every ~3.5 s from 19:16:52 until the run was stopped, `restore.dat` owned by `ubuntu`. After `normalizeOwnership` on the directory the same backup restored. | `handRestoreWorkingDirToSite` before a UI restore; the page object fails at once on a stream answered with anything but `text/event-stream` (the type `EventSource.php` sends). |
| V196 | **The suite's residue declaration could not reach the new directories**: each install draws a new name, and `uploads/backwpup-restore` matched none of them. A backup also captures the staging area (`.e2e_temp/plugins/<zip>`) and the restore directory's protection files. | Listing after setup; the archive's members. | Residue declarations take a name prefix ending in `*` (`wp-content/uploads/backwpup-restore-*`), expanded on the site to directories only; preparation of a resolved directory requires a declaration covering it. *(Superseded by V209: a family is a parent and a pattern bounding the whole name — `^backwpup-restore-[0-9a-f]{20}$` — not a `*` prefix.)* |
| V197 | **Pro's deep link names the archive twice and has the server fetch it.** `file` is the archive in `uploads/backwpup/<hash>/backups/`, `restore_file` the slot in the restore directory's `uploads/` it is copied to, `service=folder`; the click adds `step=1&trigger_download=1&_wpnonce`, the server copies (`download`) and unpacks it, and the dropzone is hidden. 412 MB: step 1 → 2 in 5 s. | Run 3's URLs; `controller.js` `triggerDownloadByUrlQuery`. | **Corrects V13**, which had `restore_file` pointing at the archive in place. `ProRestorePage.expectEntryPath(archive)` holds both to the archive restored, `trigger_download=1`, and the dropzone hidden. |
| V198 | **The wizard is six page loads.** 2 strategies → 3 database connection → 4 URL migration (Pro only: `migrate_allowed = is_pro()`) → 5 Start → 6 report; *Files Only* goes 2 → 5, Free 3 → 5. Step 3 renders `DB_PASSWORD` into `#db_pw`'s `value`. Step 6 shows "Success", or "Restore Report" when the restore log holds errors (its `count( $message )` on a string would `TypeError` then — source only). Files took 21 s, the database 7–9 s. | Runs 3–7, 9; `views/restore/steps/*`, `TemplateLoader::createBindFromStep()`. | `restoreWith` follows the URL step by step (two hops at most), asserts "Success", and fails at once on the wizard's error line, a broken stream or the login screen. Traces carry the database password (CLAUDE.md). |
| V199 | **V189 holds live.** Mixed offers all three; database-only (`["DBDUMP"]`) only *Database Only*; files-only (`["FILE","WPPLUGIN"]`) only *Files Only*. Each partial restore restores its half and leaves the other changed. | Runs 4–7. | 6G's contents and strategy scenarios. |
| V200 | **A database restore keeps the admin session only if it predates the backup.** The restored `session_tokens` know the login the run's auth setup made; a login made after the backup lands on `wp-login.php?reauth=1` at step 6 (`login_user_again()` skips the cookie once headers are sent). | Run 3 (login after the backup) vs runs 4–7 (before). | No re-authentication needed: the suite's login is made before every scenario's backup. The page object names the cause if the session is lost. |
| V201 | **A restore puts back the `debug.log` its archive holds.** The fatals logged between run 2's backup and its restore were gone after run 3's full restore (many → the one logged before the backup). | `grep -c Fatal` before and after. | The restore steps judge the log so far by the `@plugin` gate's rule (`checkDebugLog`) before restoring. |
| V202 | **After a database restore the backup's own run is "in progress" again** — the dump was taken mid-run — and the history lists no backup. | Run 1's history ("No backup was found"); the `@plugin` teardown's stop-running-work report. | Reported by the teardown, not failed; nothing to stop. |
| V203 | **Free re-uploads through the browser.** The row's action is the bare `page=backwpuprestore`; the history download took 27.6 s for 411 MB, the upload (plupload, 2 MB chunks) 168 s; then the same wizard, 3 → 5. | Run 9. | One `@free` scenario, budgeted for the upload. |
| V204 | **`wp backwpup restore … --yes --type=db\|file\|full`: exit 0, `Success: Restore completed successfully.`**, 9.9 / 7.1 / 12.7 s; each type restored its half only. Its workspace `/tmp/backwpup-restore-<uniqid>` is removed. | The CLI rounds, 21:15–21:19. | V192 holds; the CLI scenarios assert by the markers. |
| V205 | **A files restore replaces `wp-content` wholesale and deletes what its archive does not hold.** It empties `wp-content` but for `plugins/backwpup*`, then copies the archive's tree back as the transport's user: 16 273 entries `ubuntu`, files `0664`; deleted for good were empty directories, a `.donotbackup` folder and files the job's default exclusions skip (`.git*`, `.tmp`) — 20 entries of the site and two other plugins. | Trees before and after; repaired from the plugins' wordpress.org zips with the user's approval. | `cliRestore` copies `wp-content` with root `tar` before such a command (refused without sudo, the command then not run) and puts it back after the scenario. A plugin bug to report: a restore deletes data it never backed up. |
| V206 | **`wp db reset` recreates the database with the server's default collation** — `utf8mb4_0900_ai_ci` against the siblings' `utf8mb4_general_ci`; the tables keep theirs from the dump. | `information_schema.SCHEMATA` after the CLI rounds. | Read before, set back after (`ALTER DATABASE`). |
| V207 | **`--pre-backup` leaves its snapshot in the temp directory, never removed**: `db.sql` (`0664`, readable by every local account) and a copy of `wp-content` — 752 MB with the archives — under a `1777` directory. It prints `Success: Pre-backup created.` first. | `/tmp/backwpup-snapshot-6ac4143fe8c876.55994123`. | The scenario asserts the snapshot holds the site as it was (the changed markers) and removes it — only one holding its own marker, since other runs share the server's temp directory. A plugin bug to report. |
| V208 | **The 5.7.7 release names the restore directory the same way.** Tag `5.7.7` (`850263d6`, published 2026-10-05) defines `restore_dir_name()` and `RESTORE_DIR_TOKEN_PATTERN = 'backwpup-restore-[0-9a-f]{20}'`, and its `src/Cli/Commands/Restore.php` is byte-identical to `a612005`'s (same blob). `f1ebfd0` does not have it. | `gh api …/contents/…?ref=850263d6`; the cached `5.7.7` builds. | §4.6G.1's premise holds for the latest stable as for `develop`; the family pattern is the plugin's own. |

### 2.29 Facts established auditing 6G (2026-10-06)

An adversarial audit — three independent reviews (the shared rails, the command-line restore's
guard, the wizard's page object) and this phase's own — each finding reproduced before it was fixed:
locally against real directories over the `local` transport, GNU tar in a Debian container, the
plugin's own source, or read-only on `simple`. No restore had passed for the wrong reason; what was
found were destructive edges in the guards, failures that surfaced slowly or not at all, and claims
the code did not keep.

| # | Fact | Evidence | Consequence |
| - | ---- | -------- | ----------- |
| V209 | **A family's lexical anchor check let a loose pattern delete what it should not.** `^…$` passed with an alternation (`/^backwpup-restore$\|-[0-9a-f]{20}$/` removed `uploads/other-plugin-<hex>`; `/^20\d\d\|^…$/` removed a media year folder), an escaped `\$`, or `/m`; `/^[^.].*$/` matched every directory in `uploads`, where no WordPress-owned name could refuse it. | Local experiments through `removeSiteResidue` / `isDeclaredResidue`. | A family pattern must make `^`…`$` bound the whole name (unescaped `$`, no `\|`, no `m`, `g` or `y`) and open with a literal prefix of three characters at least; paths inside `wp-admin`/`wp-includes` are refused outright. |
| V210 | **`chmod` follows a data directory that is a link — even one inside the site.** `assertResolvedInsideRoot` accepts a target resolving to the root itself; a resolved directory linked at the root opened the root `0755 → 0777`. | Local experiment through `prepareResolvedDataDirs`. | Preparation refuses a final-component link wherever it leads (removal was already safe: `rm -rf` removes the link). |
| V211 | **A family member edged with whitespace was mis-addressed.** The shared path rules trim, so removal of `plugin-tmp ` deleted the non-member `plugin-tmp` and left the member, reporting success. | Local experiment. | Such a name is never a member; a parent with a whitespace-edged segment is refused at declaration. |
| V212 | **`find` without `-H` lists nothing through a parent that is a link**, so a family under a relocated `uploads` was prepared and never removed; a parent the transport's user cannot list aborted the whole removal, the fixed paths included (a regression on the code before 6G). | Local experiments (BSD `find`; GNU documents the same `-P` default). | `find -H`, every match still held to the root; the listing escalates as removal does; one unlisted family no longer stops the rest, and fails the teardown after them. An absent parent is told without privileges. |
| V213 | **`@slow` triples a scenario's timeout** — playwright-bdd calls `testInfo.slow()` — where the docs said "no runtime effect". | `node_modules/playwright-bdd/dist/runtime/bddTestFixtures.js:25`. | Docs corrected. |
| V214 | **After a timeout Playwright still tears down — `afterEach` hooks, then test fixtures — in one slot of the larger of the project and test timeouts, while the abandoned test function keeps running.** A restore command still running when its step timed out would have raced the put-back. | `node_modules/playwright/lib/worker/workerProcessEntry.js:1661-1678`. | `CliRestore.release` waits for a run in flight (bounded, 10 min) and puts nothing back under a command still running. |
| V215 | **The full suite's one `pro@nginx` failure was the runner, not the product.** The renderer stopped answering for 8.5 s (polls and screencast frames stopped) while the plugin had already replaced the history's placeholder row and the server answered every call in ~0.6 s. | The trace; the scenario then passed 3/3. | No change; recorded so the next failure of that shape is read the same way. |
| V216 | **A plain `tar -xpf` cannot put a rewritten tree back: it exits 2 on a type conflict half-done**, leaving a root-owned directory where a file was. **`--recursive-unlink` mirrors the copy exactly** — what the command added removed, owners, modes and hard links restored, a link where a directory was replaced and never followed. | GNU tar 1.34 in `debian:bookworm-slim`; the cells run 1.35. | The put-back uses it, so nothing that parsed `tar`/`find` listings to hand "gained" entries over remains — which also removes a filename-steered root `chmod`/`chown` path. *Corrected by V223: the copy must not be of `.`.* |
| V217 | **The worker's teardown removes the whole staging area**, so a copy kept in the scenario's private folder could survive neither a failed put-back nor a run killed after the restore. | `wp/teardown.ts` `releaseSite` → `cleanSiteStaging(transport)`. | The copy lives in a root-only `<root>/.e2e_content_copy/`, removed only once back; a failed put-back keeps it and spells out the way back, and every BackWPup worker refuses a site still holding one. |
| V218 | **Exit 1 is ambiguous for a privileged `tar`.** GNU tar exits 1 when a file changed — or shrank, padding the copy with zeros — and `sudo -n` exits 1 when it refuses; `sudo -n true` succeeding does not prove another command is allowed. A refused `sudo du` answered nothing, which read as `0` KB. | Reproduced in a container with a limited sudoers. | Exit 1 is accepted only when every complaint is a file that changed or went while read; the copy must list back whole; the room check needs whole numbers. |
| V219 | **`wp db reset` drops the whole database, and BackWPup dumps only the site's prefixed tables**, so anything else there — another prefix's tables, views, routines, events, triggers — would be lost for good; the copy guarded `<root>/wp-content` while the command replaces `WP_CONTENT_DIR`. `simple` holds nothing outside `wp_`, its `WP_CONTENT_DIR` is `<root>/wp-content` (no link), and no ACLs. | `inc/class-jobtype-dbdump.php:54-57`; `Restore.php:163, 192`; read-only probe; `getfacl -R -s`. | The command is refused on a site breaking either premise. ACLs and xattrs are not kept (none on the cells). |
| V220 | **V195 corrected: the wizard's failing streams were stream-typed.** Every streamed action sends `text/event-stream` and flushes before any work, so a fatal after that is a stream that *ends* — and the browser reconnects it, re-running the action, every few seconds for ever; an HTML or non-200 answer instead closes the `EventSource` for good (one request). The broken-stream check would therefore not have caught V195's failure (a 15-min timeout instead), and one answered before a wait began went unseen. | `AjaxHandler.php:387`, `EventSource.php:28-40`; Chromium measured by the reviewer (20 requests in 6 s; one). | `WizardWatch`, armed with the page object: a second request for a stream on one page, a non-200 or non-stream answer, a failed `controller=job` call, an uncaught error in the plugin's own scripts — remembered, so a wait begun later still fails at once. |
| V221 | **The wizard's steps 2–5 `POST` `controller=job` calls answered through `wp_send_json_*`;** on an HTML answer its failure handler throws (`responseJSON` is undefined) and prints nothing, and step 3's connection failure only printed the error line while the page object's in-between wait watched for nothing. | `AjaxHandler.php:521, 591`; `strategy.js`, `database.js`. | Those calls are watched; every wait goes through `untilStep` with all its signals, the decryption prompt included. |
| V222 | **A files restore writes the archive's `debug.log` back**, so what the wizard's requests logged from the dashboard to "Start" was overwritten unread. | `RestoreFiles` excludes no `debug.log`; V201. | The log is judged again just before "Start"; what the restore's own files request logs before it writes the log back is the one stretch no reading reaches. |
| V223 | **V216 corrected: Ubuntu's GNU tar 1.35 refuses to unlink `.` under `--recursive-unlink`** (`.: Cannot unlink: Invalid argument`, exit 2) — Debian's 1.34 and Alpine's 1.35, where V216 was measured, do not. Live, the first command-line restore's put-back failed so; the guard kept the copy, and the worker gate refused the 30 scenarios after it, so nothing else ran on the site. `wp-content` then read identical to the copy — no `tar --diff` difference, 16 282 entries both ways — the unlink of `.` itself the only step that failed. | The audit run's log; reproduced in `ubuntu:24.04`; read-only comparison on `simple`. | The copy is taken from the WordPress root with `wp-content` as its member, and put back into the root — exact on all three builds and on `simple` (a copy put straight back reads identical: paths, modes, owners, sizes, modification times). The kept copy was removed once proven redundant. |
| V224 | **tar's default format rounds modification times down to the second; `--format=posix` keeps them to the nanosecond.** `simple`'s `wp-content` lost its sub-second parts to the failed put-back — harmless (PHP's opcache and WordPress compare seconds, and `tar --diff`, at that resolution, found nothing), but not "as found". | `ubuntu:24.04`, GNU tar 1.35. | The copy uses the POSIX format. |
| V225 | **"As found" for `debug.log` is "as the last scenario left it".** The `@plugin` Before hook deletes it every scenario (`clearDebugLog`), so a site's log after a run is whatever the run's last scenario wrote — none, after this one, on both sites. | The as-found probes; `wp/log.ts`. | Not a leftover; the probes say so rather than counting it. |

### 2.30 Facts closing 6G.1 (2026-10-06)

§4.6G.1 asked questions 6G answered only in part, and asked for one live check 6G's runs never made.
Answered from the source of the build under test, and that check made on `simple`.

| # | Fact | Evidence | Consequence |
|---|------|----------|-------------|
| V226 | **6G.1's open questions, answered at `ab4a2e2`** (both editions' `commons.php` identical). The fixed `backwpup-restore` is no longer written — the name survives as the token's prefix and as a sweep target — while `af1ab5c` still writes only it. The token is per install: uninstall deletes every `%backwpup_%` option, `backwpup_restore_dir_token` among them. The command-line restore never uses the directory: it works in `get_temp_dir()/backwpup-restore-<uniqid>` and reads only the container's `decrypter`, which needs no registry. A successful restore empties the directory but keeps it with its protection files (§2.28's run 3); the plugin removes one untouched for 6 h (`maybe_cleanup_abandoned_restore`, links skipped); uninstall leaves it. `StaleRestoreFilesDetector` checks every name. **No files backup excludes it**: the uploads exclusions default to the log folder alone, and the content exclusion `backwpup-restore` names `wp-content/backwpup-restore`, which no build uses — so an archive takes whatever the directory holds, an abandoned restore's `restore.dat` / `restore.dat.bkp` included, which carry `dbuser` and `dbpassword` in plain text once the wizard's database step has saved them (V196 saw the protection files in an archive). | `src/Infrastructure/Restore/commons.php`, `uninstall.php`, `src/Cli/Helpers/CommandsRestoreHelpersTrait.php`, `inc/class-jobtype-file.php` (defaults; exclusions joined to their own folder), the vendored `Registry.php` and `JobController.php`. | The family and the per-install preparation rest on these; nothing changes. The fixed name stays declared for `af1ab5c` and older, so these builds get it prepared, empty and unused. The missing exclusion is a plugin bug to report; the suite's backups each precede any restore in their install, so none of them holds credentials. |
| V227 | **A killed run's restore directory is swept by the next scenario's teardown.** Planted on `simple` as the web server leaves one mid-restore — a 20-hex name no install drew, `www-data` `0755`/`0644`, `restore.dat`, `restore.dat.bkp`, a 1 MB upload and an extraction tree the transport's user cannot empty — it was gone after one `@plugin` scenario, removed with elevation; the scenario passed, and `simple` was then as found but for `debug.log` (core's automatic updates, V225). | 2026-10-06 23:06–23:08 UTC, `develop@ab4a2e2`, `cli-reads`' version scenario; the as-found probe before and after. | §4.6G.1's last verification item; its acceptance holds. |

### 2.31 Facts established scoping 6H.0 (2026-10-06/07)

**The incident.** In AutoE2E (`wp-rocket-e2e`), BackWPup Pro runs occasionally start failing every
scenario, every cycle, until someone deletes `wp-content/plugins/backwpup-pro/` by hand. That folder
held only part of the plugin (`vendor` among it) and no main file. Read-only on both QA servers, from
the source, and reproduced on a throwaway local stack (WordPress 7.1.3, PHP 8.5-FPM, nginx, WP-CLI
2.12.0 as a uid-1000 user in group `www-data`, ext4 volume). A live reproduction on `simple` was
refused by the auto-mode classifier as a shared-resource change; it is part of 6H.0's verification.

| # | Fact | Evidence | Consequence |
|---|------|----------|-------------|
| V228 | **WordPress removes a plugin's folder entry by entry, and nothing makes it atomic.** `delete_plugins()` runs `uninstall_plugin()`, then `WP_Filesystem_Direct::delete( $dir, true )`, which walks `dirlist()` (PHP `dir()`, i.e. readdir order), keeps going past an entry it cannot delete and returns `false` at the end. WP-CLI's `delete_plugin()` shells out to `rm -rf`. A process stopped part-way leaves whatever it had not reached. | WP 7.1.3 on `simple`: `wp-admin/includes/plugin.php`, `class-wp-filesystem-direct.php`; WP-CLI 2.12.0 `extension-command/src/Plugin_Command.php` (`rm -rf`). | Any removal that can be killed can leave a part of a plugin behind. |
| V229 | **Killing PHP-FPM during a wp-admin deletion leaves a folder WordPress does not see.** SIGTERM to the FPM master (`NOTICE: Terminating ...`, what `systemctl restart` and a shutdown send) mid-`delete-plugin` left `backwpup-pro/` with `changelog.txt languages readme.md src vendor` — 3 202 of 5 859 entries — **no `backwpup.php`**; `wp plugin is-installed` exits 1 and `wp plugin list` omits it. Uninterrupted, the same deletion took 0.37–0.56 s locally. | Local stack, 2026-10-07; readdir order there put `backwpup.php` 4th and `vendor` 14th of 18 top-level entries. | The reported folder, reproduced. Which entries survive depends on the filesystem's readdir order (ext4 orders by a per-filesystem hash), so on another site the **main file can survive while `vendor` is half gone** — a plugin WordPress lists but whose `uninstall.php` (`require_once` of `vendor/berlindb/…`) cannot run. Not reproduced; 6H.0 measures it. |
| V230 | **Such a folder blocks every install, and every tool calls it something else.** `wp plugin install <zip>`: `Warning: Destination folder already exists.` / `Error: No plugins installed.`, exit 1. `wp plugin uninstall`: "could not be found", exit 1. `wp plugin delete`: "could not be found" **and `Success: Plugin already deleted.`, exit 0, folder untouched**. wp-admin upload: "Destination folder already exists." with **no "Replace current with uploaded"** — the installer skin offers it only when `get_plugins()` finds a plugin in that folder. | Local stack; `WP_Upgrader::install_package()` (`abort_if_destination_exists` → `folder_exists`), `Plugin_Installer_Skin::do_overwrite()`. | The old suite then waits for an activation link that never comes. This suite's `@plugin` Before hook fails the same way: `ensurePluginAbsent` is gated on `is-installed` and skips, then `installPlugin` throws on exit 1 — every scenario, until the folder goes (from the code; 6H.0 records the message live). |
| V231 | **The QA servers kill PHP several times a week, by design.** Apache server (`pro@apache`, AutoE2E's BackWPup/WP Rocket apache sites): root crontab `0 4 * * *` and `0 16 * * *` `systemctl --no-wall reboot`; `last -x` shows both reboots every day since at least 2026-09-22. nginx server (`qa-lnmp`): every PHP-FPM version restarted together 2–3×/week at ~06:00–06:55 — matching unattended-upgrades runs (`libcurl`, `libexpat`, …) with `needrestart` installed — plus reboots every 1–3 weeks. A restart kills requests in flight: **2026-09-30 17:04:08** nginx logged `recv() failed (104: Connection reset by peer)` on a `bwu6` `admin-ajax.php` call in the second `php8.5-fpm` logged `Terminating ...`. On the apache AutoE2E site, an `upload-plugin` request got **500** at 15:59:59 on 2026-09-23; on 2026-09-24 the old suite's delete request started at **16:00:00** and completed just before the shutdown. | `crontab -l`, `last -x`, `/var/log/php*-fpm.log*`, `/var/log/unattended-upgrades/`, nginx `error.log*`, the apache site's access log — all read-only. | The cause is a collision: a removal in flight when the server kills PHP. No AutoE2E incident time was available to tie one specific occurrence to one kill, so this is the demonstrated mechanism and frequency, not a matched incident. |
| V232 | **Why BackWPup and never WP Rocket.** The old suite removes BackWPup Pro **through wp-admin after every BackWPup scenario** (`After` → `removeBackWpViaUi`), a PHP-FPM request that a restart or reboot kills. It removes WP Rocket **over WP-CLI** (`cleanUp` → `wp plugin uninstall --deactivate`), a CLI process an FPM restart does not touch and that deletes with `rm -rf`; wp-admin deletion of WP Rocket happens only in its two delete-plugin scenarios or with `npm_config_env=local`. Size widens the gap: the Pro zip holds 5 822 entries (4 923 in `vendor`), WP Rocket's 1 710. | `wp-rocket-e2e` `src/backwpup/support/hooks.ts`, `utils/page-utils.ts` (`cleanUp`, `removePluginViaUi`), `utils/commands.ts`; `zipinfo` of both zips. | A smaller, rarer window, not immunity: WP Rocket would get the same folder if a reboot landed inside its removal. Hence a **general** guard, keyed on the slug, in the shared rails. |
| V233 | **This suite would pass such a folder as removed, in three places.** `ensurePluginAbsent` and `uninstallPlugin` verify with `is-installed`; `PluginsPage.delete` ignores the AJAX body (a `{"success":false,…"Could not fully remove the plugin…"}` or a killed request's 502 page reads as delivered) and checks only that the row's action links are gone; the step "BackWPup is no longer installed on the site" says "the plugin's files should be gone" yet asks `is-installed`. | `wp/plugin.ts`, `pages/plugins.page.ts`, `steps/plugin-deletion.steps.ts:64`; V229 (`is-installed` exits 1 with 3 202 entries left). | A removal under test that half-failed is a pass today. 6H.0 makes removal mean "nothing at the plugin's path". |
| V234 | **V61 refined: a kill of the runner never cuts a removal short; a kill of the site's own process does.** V61 killed the Playwright process tree; the remote `wp` ran on to the end. A PHP-FPM restart or reboot stops the process doing the deleting, which produces a third shape V61 did not see: files partly gone, no rows to sweep (`uninstall.php` already ran). `pro@apache` sits on the twice-daily rebooting server, and the orchestrator will run cells continuously as AutoE2E does. | V229, V231. | 6E.0's database sweep cannot see this shape; 6H.0 is its file-side counterpart. |

---

## 3. Coverage & tagging decisions

### 3.1 Editions

Baseline coverage is **Pro-only**. Target default: **untagged** (both editions). Tag only where the
product genuinely differs:

| Tag | Scenarios |
| --- | --- |
| *(none)* | Onboarding, backup, history, download, delete, plugin lifecycle, WP-CLI job/backup/run/status and the backup and log files (`backup-delete`/`-download`, `log-show`/`-delete`), FTP/S3/MS Azure/Rackspace/SugarSync storages |
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
really do take minutes — lets CI split fast from slow, and playwright-bdd triples such a scenario's
timeout; 6F.2 does not use it, since every job it runs takes seconds, V112). The `@bwpup*` family is dropped: the product
is the config file, not a tag.

6A added one more: **`@plugin`**, which opts a scenario into the shared plugin lifecycle (fresh
install + activate, a scoped `debug.log` that fails the scenario on a fatal, removal afterwards).
Nearly every ported scenario carries it; the exceptions are scenarios that assert on a site
*without* the plugin, and `@noauth` ones that need no site at all.

---

## 4. Sub-phases

Each is independently shippable and ends with the standard gates (typecheck / lint / format /
`test:unit`) plus a green real-cell run. 6A is a prerequisite for everything and 6B for every feature
phase; 6C–6H are otherwise independent of each other and can be reordered by need. **6G.0 must
ship before 6G**, and **6G before 6K** (6G.1 shipped with 6G). **6H.2 is deferred out of the sequence** — nothing downstream waits on it.

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
| `JobRunPanel` | Running-job progress, abort, close (`startbackup`, `job-abort-status`). Named a modal when this table was written; V17 established it is an in-page region. |
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
needs `data-backup-id` rows, `JobRunPanel` needs a live `startbackup`, `RestorePage.startFromHistory`
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

### 6D — Backup lifecycle & history — **DONE**

**Shipped 2026-08-28.** The full BackWPup suite is **18/18 on both cells**. One earlier `pro@nginx`
run had a single failure — a 6C Background, from the pre-existing flake of V46 — which did not
reproduce on the repeat, and which `pro@apache` passed in the same round. Ports `backup.feature` (2) +
`download-restore.feature` (1) and adds the deletion and bulk coverage the baseline only ever
performed as *cleanup*. Five scenarios in `features/backups.feature`, sharing one Background.
Decisions worth carrying forward:

- **Setup is seeded, and the seed was proved equal to the real thing** (V39). `completeOnboarding()`
  calls the two entry points the browser calls — the destination save and
  `BackWPup_Page_Onboarding::save_post_form()` — rather than writing job records, so the plugin keeps
  owning its own schema, id allocation, cron registration and placeholder cleanup. It then **reads the
  result back**: onboarding no longer owed, exactly one scheduled job with the expected contents and
  destination, driven by `wpcron`, with a cron event of its own. The alternative was not cheap:
  submitting onboarding starts a full backup of the site that every scenario would then have to wait
  out, twice over for the ones that need two archives.
- **The jobs back up the database only.** The smallest real backup a site can make — 43 MB and a few
  seconds on `pro@nginx`, against 450 MB for files-and-database — while still being a genuine run of a
  genuine job. Nothing in this feature depends on what is inside the archive.
- **A step that starts a backup also waits for it.** "I backed up" is not true until the run is over,
  and splitting the wait into its own step would mean carrying the pre-run archive count between
  steps. Waiting where the run starts keeps every step self-contained and every later assertion
  absolute — which is what §1.1's "no mutable World state" row actually asks for.
- **Counts are asserted from both sides in one step** — the rows the table renders *and*
  `wp backwpup backup --format=count` — with the number coming from the scenario, so neither source
  can quietly define the answer.
- **The schedule is fired, not waited out** (V40, V41, V44). `common/wp/cron.ts` brings **that one
  job's** event forward and hands it to WordPress's own `spawn_cron()`, so the backup starts the way a
  scheduled one really starts: inside a web request, through the plugin's cron callback. The plan's
  original `wp cron event run backwpup_cron` would have fired *every* event on that hook — including
  the hidden placeholder job's — and would have run the job inside WP-CLI, where the plugin's own
  memory handling dies. That the *right* job ran is asserted from `job_id` on the newest archive.
- **The two steps 6C cut are restored**, into 6C's own scenario where they belong: its data-selection
  scenario now re-reads both exclusions from the job card's panels on the dashboard, closing the only
  single-sourced assertion 6C had.
- **Two page-object defects were found by running it** and are fixed and pinned: `failedRows` could not
  see an aborted backup (V42), and `applyBulkAction` waited for a request that pressing "Apply" never
  makes (V43).

**Deliverables** — `features/backups.feature` (5 scenarios), `steps/backups.steps.ts`,
`completeOnboarding` + `completeOnboardingPhp` + `finishActivation` + `CRON_HOOK` in
`support/onboarding.ts`, and
`startJobInBackground` / `waitForBackup` / `isJobRunning` / `readLastRunOutcome` /
`BACKUP_TIMEOUT_MS` in `support/backups.ts`, with `theScheduledJob` moved into
`support/job-options.ts` so both step files share it. Shared addition: **`common/wp/cron.ts`**
(`nextScheduled`, `triggerScheduledEvent`) — product-agnostic and documented in
[wordpress-automation.md](../architecture/wordpress-automation.md). `BackupHistoryTable` gained
`bulkDeleteModal` and `confirmBulkDelete`, and `failedRows` changed selector.

**An adversarial audit of the whole change set followed, and four of its findings were defects that
the gates, the unit suite and two green cell runs had all missed.** Worth keeping because each is a
class of mistake, not a typo:

- **A failed backup could be reported as a success.** `waitForBackup` took its verdict from
  `wp backwpup status`, which reads a log **only while the job is still running**; asked afterwards
  it prints "No job running." and returns without one. A short backup that finished between two
  probes therefore produced `idle`, and every caller asserted only `not.toBe("errors")`. The verdict
  now comes from the job's own log entry (`readLastRunOutcome`, judged on the integer `errors` /
  `warnings` counts, never on the translated status column), and the blocking status command — which
  could also hang unbounded on a hot spin — is replaced by a cheap `isJobRunning` probe under the
  same budget as the archive wait.
- **`triggerScheduledEvent` silently downgraded a recurring event to a single one**, because
  `wp_unschedule_event` + `wp_schedule_single_event` drops the schedule. Invisible here (BackWPup
  schedules single events) and a trap for the next product. It now reads the event back and
  re-applies its recurrence.
- **`nextScheduled` reported an empty reply as "not scheduled"** — `Number("")` is `0` — which is the
  one confusion its own contract promised never to make.
- **Two scenarios could not fail for the reason their names gave.** "Downloading … saves that exact
  archive" and "Deleting … removes it" ran against a single archive, where "the newest" cannot select
  the wrong row. Both now arrange two, and the delete step asserts the *other* archive survived.
- **A fifth, found by running the fixed suite on the smaller cell: `startFromModal` failed when the
  backup was too fast.** `startbackup` waits one second and then answers `200 "Job started."` *or*
  `201 "Job executed."` — the latter meaning the run already finished, which is the normal answer on
  a 3 MB database. The page's own script then shows `#runningjob` and hides it again on its first
  poll, so asserting that region punished a *fast* backup. It no longer does; instead the call's
  **body** is checked, because the route reports a genuinely unusable temp folder, log folder or
  destination as `status: 500` inside an HTTP **200** — which would otherwise have surfaced ten
  minutes later as "no backup appeared".

Chasing the last of the audit's questions — whether the intermittent 6C failure was really outside
this phase's reach — turned up its actual cause and closed it (V46). It was never about uninstall
leaking state: **WP-CLI's activation does not fire `init`**, so the plugin's own activation routine
was left to whichever request reached it first, and two of them racing takes a never-onboarded site
down the plugin's upgrade path. `finishActivation()` now runs that routine once, deterministically,
before the browser is let near the site. **Corrected by V122:** it closed nothing — the lifecycle's own
active-state check was already the first request after activation, so the race stayed live until a
lost one was made to redo the install.

The audit also corrected several prose claims that were broader than the measurement behind them —
recorded inline above — and found that the seeder's job-id derivation used `next_job_id()` where the
onboarding page uses `$first + 1` / `$first + 2`; the two agree only on a fresh install, so the
page's own rule is now reproduced.

**Acceptance met** — every history assertion agrees between the DOM and
`wp backwpup backup --format=count`; the downloaded archive is compared by **name and exact byte
size** against what WP-CLI reports, saved under the test's own `outputDir`. The one criterion
deliberately deferred, with its reason, is the deliberately-failed backup — see the end of §2.9.

**Verification after the audit** — the full BackWPup suite ran **18/18 on `pro@apache`** and
**18/18 on three of four `pro@nginx` runs**, the cell where the pre-existing 6C flake had been
failing one run in two before `finishActivation` (which, per V122, changed nothing about the race: at
the ~3 % per scenario measured since, an 18-scenario run comes out clean only ~58 % of the time). The
one failure was V47's leftover table — a
different cause, and now reported at the point of detection with the PHP error attached, instead of
as a puzzling redirect.

**A second adversarial round then audited the finished phase against WordPress core and the plugin
source directly, and found four more defects** — none of which any gate, unit test or green cell run
could have surfaced, because each was a *correct-looking* claim about someone else's code:

- **The `doing_cron` staleness guard was both useless and dangerous** (V48). It could not change
  `spawn_cron()`'s answer — core already ignores an abandoned lock — while the lock it *would* delete
  in practice belongs to a cron run that is merely slow, which `wp-cron.php` then aborts mid-event.
  The guard is gone; the trigger outlasts the lock instead, on a budget read from the site rather
  than assuming the constant is still 60s.
- **A log entry with no counts read as a successful backup.** `readLastRunOutcome` defaulted an
  absent `errors`/`warnings` to `0`, and `Number(null)` / `Number("")` are both `0` — so a reply that
  did not answer the question was reported as `finished`. The one wrong answer this reader exists to
  avoid. It now refuses an absent count, and `optionalNumber` treats `null` and `""` as absent
  instead of as zero, which is what its own doc had always claimed.
- **Three REST routes were classified under the wrong namespace** (V49) — latent, but it defeats the
  module's whole reason for existing.
- **A re-schedule that failed left the site with no scheduled event**, because the event is
  unscheduled first. It is now put back, and the message says which happened.

The round also corrected documentation that was confidently wrong rather than merely vague: the
`startbackup` response is **HTTP 200 in every case** — the 500/200/201 distinction lives in the
body's own `status`, so `response.ok()` cannot tell a refusal from a start — and its messages
interpolate the job name (`Job "<name>" started.`), which the quoted strings had dropped. Plugin
source citations that pointed at `Cli/…` now name the real `src/Cli/…` paths, and two that cited line
numbers no longer do, since those drift on the next commit.

**Independently re-verified as sound** in the same round, each against real source rather than
inference: `spawn_cron()` is gated by neither `DISABLE_WP_CRON` nor a system crontab (load-bearing —
`pro@nginx` sets it); making the event due first is *required*, since `spawn_cron()` returns early
when nothing is ready; `wp backwpup log --limit=1` really is the **newest** entry (default
`--orderby=time --order=desc`, sorted before it slices); `read_log_header` always emits both counts as
integers, which is why the count hole was latent; "No logs found." exits **zero** on stdout; and
BackWPup's activation routine is hooked at `add_action( 'init', …, 0 )`
(`src/Plugin/Plugin.php:122`) — the fact `finishActivation` depends on, since `wp eval` fires `init`
and `wp plugin install --activate` does not.

**Re-verified live after the second round: 18/18 on `pro@nginx` and 18/18 on `pro@apache`**, both
cells left pristine afterwards (no plugin, no options, no `bwpup` table, no BackWPup cron event, no
`doing_cron` transient, no archives, no staging directory). The `pro@apache` run had to wait for that
cell's database to come back — it was refusing connections throughout the audit, which is a host
fault and not this phase's.

The fixture provenance behind 6B's locator contract was re-checked from scratch rather than taken
from V38: 5.7.5 rebuilt from cache and diffed against `develop@90f9391` — `components/`, `pages/`,
`parts/`, `pro/parts/`, `assets/js/` **and** `src/` are all byte-identical, so the ~1,300 pinned
assertions describe the ref the cells install. The same diff extends V49: 5.7.5 carries the same two
namespace constants and the same four `v2` registrations, so that split is not version-specific.
(Note for whoever picks this up: the artifact cache now holds **5.7.6** builds, so "latest stable"
has moved past the 5.7.5 the fixtures were captured from — worth re-diffing before the next capture.)

Unit tests **611 → 650**.

**Verification of §4.6D.1** — `pro@apache` **21/21**; `pro@nginx` **21/21**, one of them on a retry.
That retry was an infrastructure fault, not a defect: its attachment shows
`mysqli_real_connect(): (HY000/2002): No such file or directory`, the database socket going away
mid-scenario, and it hit an existing onboarding scenario rather than a new one. The same run also
reported `wp-content/uploads/backwpup-restore` surviving an **elevated** `rm -rf` — so permissions
were not the obstacle, and the directory was gone by the end of the run. The likeliest explanation is
this cell's per-minute `wp-cron.php` (V44) re-creating it between the removal and the check, but that
is **unproven** and recorded as an observation rather than a cause. Both sites were verified pristine
afterwards — plugin, options, table, cron events, uploads **and both markers** — which is what
confirms the `markers` fixture's teardown runs, since `wp-content` is not covered by the residue
sweep. Unit tests **650 → 674**.

**A third adversarial round audited the finished phase end to end and found eight more defects**, two
of them serious. All are fixed; each was invisible to the gates because each was a claim about
someone else's tool rather than a mistake in ours:

- **A corrupt archive read as "the file is not in it"** (`common/wp/archive.ts`). The absent-vs-
  unreadable decision matched GNU tar's *wording*, and tar prints `<pattern>: Not found in archive`
  for a corrupt archive too. Measured on a cell: 20 KB of random bytes and an empty file both print
  it alongside a corruption line — **and a truncated archive prints it with no corruption line at
  all**, so the fix the finding proposed (blacklisting corruption phrases) would still have missed
  one. Readability is now decided by *behaviour*: when a pattern matches nothing, the archive is
  listed without a pattern and only its exit status is believed. Every `holds no … marker` assertion
  depended on this, and each would have passed against a broken backup.
- **The unit test that was supposed to guard it used an invented stub.** Its `damaged` mode emitted
  only `Unexpected EOF`, which no real tar prints for this case, so the test passed. Every failure
  mode in that stub is now transcribed from measured output — which is what makes the test able to
  fail.
- **`When("a backup runs")` never extended the scenario timeout**, alone among the five steps that
  start a backup. `waitForBackup` was entitled to 10 minutes inside a 270 s scenario, so a slow files
  backup would have died as a bare Playwright timeout naming nothing.
- **The cron trigger could fail after the work had already succeeded.** `spawn_cron()` returns false
  both when the lock is held *and* when nothing is ready; the loop retried both. On a host with a
  per-minute system cron — which is `pro@nginx` — another runner takes the event, nothing is ready
  ever again, and the step failed at the deadline complaining about spawning. It now treats the
  target event being gone (or moved forward) as the work having been accepted.
- **`phpLiteral` had two holes**: a BigInt or circular value escaped as a raw `TypeError` naming
  neither caller nor value, and a lone UTF-16 surrogate silently decoded to PHP `null` — a snippet
  running with an empty value and reporting nothing. Both now refuse in the module's own terms. The
  surrogate check runs on the *value*, not on its JSON, because that is the only place a surrogate is
  still a surrogate.
- **execa's 100 MB output cap surfaced as `exited 1: (no output)`** — a truncated answer wearing an
  ordinary exit code. `exec()` now raises it as "could not ask at all", which is what it is.
- **An absence assertion could pass with nothing searched.** Each now requires the archive to list at
  least one member first; combined with the readability fix, the only remaining way to go vacuous —
  a mistyped pattern — is caught because both patterns are asserted *positively* by a sibling
  scenario.
- **A stub that failed the wrong call.** `WP_STUB_SEED_FAILS` matched any `eval`, and
  `completeOnboarding` runs `finishActivation`'s bootstrap eval first, so the test named for a
  seeding failure was exercising activation. Gated on the seeding snippet, with the activation path
  given its own test.

Documentation corrected in the same pass: the absolute "never hand-build a `wp eval` string" is
restated as the rule it actually is (`phpLiteral` for every interpolated value — that part *is*
absolute; `evalPhp` unless you must branch on the exit code, which two callers legitimately do);
`{@link REST_NAMESPACE}` pointed at a symbol this phase deleted; "eleven API files" was ten;
`FILE_MARKER_PATH`'s directory half was inert, so it is now `FILE_MARKER_NAME`; `expectRunning()` was
unused and documented as not-to-be-used, so it is gone; and the `markers` fixture is now described in
[authoring-tests.md](../guides/authoring-tests.md) as what it is — a fixture whose resolution
*mutates the site*, which the guide's "pays only for what it destructures" line did not cover.

Unit tests **674 → 686**.

**A fourth round audited the finished phase again, aimed at the third round's own fixes** — the only
code with no adversarial review — **and at the backlog earlier rounds could not reach.** It found
nine more, two of them serious, and both serious ones were *fixes from round three that did not
work*:

- **The cron staleness check could never fire** (`common/wp/cron.ts`). Round three added "if the
  event is gone, the work was taken" — but WordPress autoloads the cron array into the in-process
  options cache at bootstrap and never re-reads it, so `wp_next_scheduled` inside a long-lived
  `wp eval` returns the value the snippet itself wrote. Measured on a live cell: **zero queries**,
  and `wp_load_alloptions( true )` does not force one either. The branch was dead on exactly the host
  it was written for. A `wp_cache_delete( 'alloptions', 'options' )` before the read makes it real —
  measured at one query — and the unit test now pins that *ordering* rather than the branch's source.
- **node-ssh trims both ends of every reply** unless `noTrim` is passed, and it was not. So on the
  **only transport the cells use**, `stripFinalNewline` never ran and three separate comments were
  false, including `archive.ts`'s claim that a member name's leading space is preserved. The spec
  covering that ran on `local` and could not have caught it. `runSsh` now passes `noTrim: true`, which
  is what makes the "all transports agree" claim true.
- **`expect.poll` does not retry a probe that throws** — it calls the function outside its own
  try/catch. One dropped SSH connection during a ten-minute wait, to a site busy writing a
  multi-gigabyte archive, ended the wait as a WP-CLI error. Probes are now absorbed up to three
  *consecutive* failures, resetting on any success: a flaky link is tolerated indefinitely, a dead one
  still fails in seconds with the real cause.
- **`toJSON()` bypassed the surrogate guard entirely**, and a deeply nested value threw a bare
  `RangeError` from outside the module's own framing. Both fixed by checking the *decoded JSON* —
  which is what PHP actually receives — inside the guard.
- **`confirmDelete` awaited nothing.** The per-row confirm is rendered with the plugin's `open-url`
  trigger — a bare `window.location = data-href` — so there is no REST call to wait for, and the
  loading marker the method looked for is emitted only by the initial server render. It now waits on
  the main frame's navigation response. The scenario passed only because the assertions after it
  retry.

The rest were documentation the code had outgrown, each verified against the tool rather than
argued: `readArchiveEntry` does **not** make a large archive cheap to read (measured — tar scans to
the end and decompresses all of it, ~1.4 s per 200 MB whichever way you ask, 0.16 s with
`--occurrence=1`, which is deliberately not used because a name may legitimately match two members);
the `isMaxBuffer` guard's stated reason was backwards (execa keeps the **child's** exit code, so a
capped *success* is the dangerous shape, and the ssh transport has no cap at all); the claimed
`evalPhp` exception did not exist, since all three direct `wp eval` callers threw exactly as
`evalPhp` does — so they now use it and the exception is gone from the rule; and V52, V9 and the
anti-pattern table still prescribed things later rows had refuted.

Unit tests **686 → 690**.

#### 6D.1 — What a backup actually holds (files, database and both)

6D proved a backup *happens*, is counted correctly, downloads and deletes. It did not prove a backup
**contains anything**, and the download check compared only name and size — which a body corrupted in
place, or a truncation landing on the same length, would survive.

Closing that needed to cover all three job shapes, not just the database one the rest of 6D uses. Two
premises turned out to be wrong in our favour: `runScheduledBackup` (then `makeOneBackup`) was never
database-specific — it runs whichever job is scheduled — and the setup step was already parameterised
over `files` / `database` / `files and database`. The whole matrix was reachable by changing one word.

**Seeding three jobs at once was considered and rejected.** It costs little to create, but it breaks
`theScheduledJob`'s "exactly one scheduled job" invariant, which is what catches onboarding producing
something unexpected; onboarding itself can only ever make one job (or two, when files and database
are split by schedule), so a third would have to be built outside the product's own path, giving up
the field-by-field equivalence with a real onboarding that V39 established; and the expense is in
*running* a job, not in declaring one. One job per scenario keeps all three properties.

**The design.** [`backup-contents.feature`](../../src/projects/backwpup/features/backup-contents.feature)
plants two random 32-character markers — one in a file at the root of `wp-content`, one in an option
— then runs a real backup and reads the archive back **in place**. Both markers are planted for every
scenario, so each asserts what its job covered *and* what it left alone: a database job must hold the
database marker and **not** the file one, a files job the reverse, a mixed job both. That is what
separates "a backup ran" from "the backup covered what it was configured to cover"; a presence-only
check would pass for a database job that swept the filesystem in. The markers are random per scenario,
so a stale archive cannot satisfy them, and the two halves act as each other's positive control — the
absence assertions only mean something because the presence ones fire on the same machinery.

Shared additions, all unit-tested: **`common/wp/php.ts`** (`phpLiteral`, `evalPhp` — extracted from
`cron.ts`, which had them privately, and now used by three callers), **`common/wp/files.ts`**
(`fileChecksum`) and **`common/wp/archive.ts`** (`findArchiveEntries`, `readArchiveEntry`).
`BackupRecord` gained `path`, the archive's absolute location, which the plugin only reports for
archives it can read — so a path that comes back is one WP-CLI can open, and no elevation is needed.
The download scenario now compares a **full SHA-256** as well as name and size, the site's half
computed on the site so proving it costs one small reply rather than a second transfer.

### 6E — Plugin lifecycle (UI) — **DONE**

**Shipped 2026-09-18.** The full BackWPup suite is **24/24 on both cells** with retries disabled, and
both cells are left pristine afterwards — no plugin, no options, no `bwpup` table, no BackWPup role,
capability, user-meta key or cron event, no archives, no staging directory. Two halves: a shared
recovery mechanism (6E.0) and the three ported scenarios it unblocks (6E.1). The facts behind both
are **§2.10, V54–V63**. Unit tests **690 → 731**.

#### 6E.0 — Recover a site from a leftover footprint

**The gap.** `ensurePluginAbsent` is gated on `wp plugin is-installed`, a **file** test, so a site
whose plugin directory has gone while its rows remain looks already-clean and the uninstall is
skipped. The next install then lands on the previous run's state, the plugin reads its leftover
`backwpup_version`, concludes it is an upgrade rather than a first install, never sets the onboarding
flag — and the scenario fails blaming the product (V54, V55).

**What shipped.** `ProductConfig.siteDbResidue`, a database counterpart to `siteResidue`, declared
per product as `optionsContaining` fragments plus unprefixed `tables`, reaching the shared hooks
through the same per-process registry as the other product policy. `common/wp/db-residue.ts` sweeps
it, keyed off **the footprint** and never off whether the plugin is installed. Both lifecycle hooks
call it immediately after `ensurePluginAbsent` — the Before hook so the install is genuinely fresh,
the After hook so a footprint that outlived the uninstall does not become the next run's problem.

Decisions worth carrying forward:

- **Fragments match anywhere in a name, not as a prefix** (V58). The plugin's destination caches are
  site transients — `_site_transient_backwpup_<jobid>_gdrive` — and a prefix would walk past them and
  past `bwpup_backups_version`, which shares no substring with `backwpup`. They are matched
  *literally*: `esc_like` escapes `%` and `_` before the query.
- **Ordering is the guarantee, not a flag** (V59). An installed plugin re-creates its own footprint on
  `init`, so a sweep that ran before the removal would achieve nothing. `--skip-plugins` is defence in
  depth for the sweep's own request — and insurance against the cells' unrelated plugins, which hook
  option and transient writes — not a substitute for the ordering.
- **Rows go through `delete_option`, not a `DELETE`**, so WordPress invalidates its own caches; that
  is why no flush follows. Removal is then verified by re-reading in a second process, straight from
  the database.
- **Two guards, aimed at a wrong declaration rather than a hostile one.** `PROTECTED_TABLES` refuses a
  declaration naming a core table at declaration time; `PROTECTED_OPTIONS` is checked against what the
  query actually *matched* and refuses the **whole** sweep before deleting anything. Multisite is
  refused outright rather than half-handled.
- **Scope is options and tables only**, because those are the two that block a fresh install. Roles,
  capabilities and user meta are re-established idempotently by activation and removed by the next
  real uninstall (V57), so they cannot accumulate; declaring them would mean reproducing the plugin's
  role handling here.

**The five empirical requirements, each answered:**

1. **Reproduced deliberately**, and the message recorded verbatim — V54.
2. **The sweep recovers it**: from that same reproduction the previously-failing scenario passed, with
   the hook reporting *"before installing, cleared a leftover plugin footprint from the site: 26
   option(s), 1 table(s)"*. Repeated on `pro@nginx`, where the **full 21-scenario suite ran 21/21 from
   the dirty state**.
3. **A no-op on a clean site**, on both cells: full-state snapshot byte-identical, one read, no write,
   nothing elevated — V60.
4. **The interrupted case**, reproduced by killing the whole process tree mid-scenario — and it
   produces the *files-present* shape, which `ensurePluginAbsent` already recovered. The files-gone
   shape is not reachable by a kill; it comes from a skipped `uninstall.php`, which is what 2 covers.
   Recorded rather than glossed — V61.
5. **Both cells**, throughout.

One correction to this plan's own framing, from measurement: a dirty landing does **not** make every
later result suspect. It costs exactly one scenario, and the cell then heals itself, because the
Before hook installs the files the After hook needs in order to uninstall properly (V56). The sweep
removes that one unexplained failure; it is not a suite-wide rescue, and saying so would be
overselling it.

#### 6E.1 — The UI scenarios

Ports `delete-plugin.feature` (3) onto the shared `PluginsPage.delete`; the baseline's hand-rolled
duplicate is dropped. Its three states — after install, after activate, after a first backup — are
kept, renamed to say what actually differs, since the `@plugin` lifecycle always hands a scenario an
installed, activated plugin:

- *Deleting a deactivated plugin removes it and everything it put in the database.*
- *Deleting an active plugin deactivates it first and still removes it completely* — WordPress only
  offers Delete once a plugin is inactive, so the flow has to deactivate, and that extra step is
  exactly where the deletion used to be lost (V63).
- *Deleting the plugin after it has made a backup clears its settings but keeps the archive.*

**What the baseline never proved.** It asserted that WordPress rendered `#backwpup-pro-deleted` and
stopped. These assert both halves of what deletion means, which is only observable through wp-admin
at all because core's `delete_plugins()` runs `uninstall_plugin()` while `wp plugin delete` does not
(V62): the plugin is gone *from the site* (asked of WP-CLI, an independent witness from the screen
that just claimed it), and so is everything it had in the database — options, table, roles, the
capabilities it granted and its user meta, read back with plugins unloaded
(`support/footprint.ts`). That reader is deliberately **broader** than the 6E.0 declaration: a
scenario asserting the product cleaned up should check what the product's own `uninstall.php`
promises, not what our sweep happens to declare.

The third scenario adds the other half of the bargain — a backup plugin's uninstall may take its
settings and must not take the user's archives — counted off the filesystem, since the WP-CLI command
that would normally answer has just been deleted.

**One shared-code defect found and fixed.** `PluginsPage.delete` forced its Delete click, which made
it land on nothing on a live cell and produce no request at all; the failure surfaced as a timeout
blaming the plugin. Diagnosed in the page (V63), fixed by dropping `force` and waiting for the
post-deactivate page's `load` so WordPress has wired the action, and pinned by a unit test that fails
if `force: true` returns.

**Acceptance met in full.** 6E.0's sweep is in place and verified to all five points; the three
scenarios pass on every cell; and each cell is left clean, checked by reading the site rather than by
trusting the teardown.

**Including "both editions", which is now verified rather than expected (§2.11).** A `free@nginx`
cell was stood up afterwards, and the claim this section previously left open held on inspection as
well as in the run: the two editions ship a **byte-identical `uninstall.php`** and an identical table
declaration, with Free a strict subset of Pro (V65); the Free edition leaves **the same 26 options and
the same table**, all of them matched by the existing declaration and none missed (V66); the sweep
recovers a deliberately dirtied Free cell with the same message it prints on Pro; and the whole
untagged suite runs there with **no new scenario code** (V64). One assumption the declaration turned
out to rest on is now written down instead of implied: the option match needs a case-insensitive
collation, because the plugin stores one transient under a capital-B name (V67).


### 6F — WP-CLI surface — **DONE**

Ports `wp-cli/list-jobs.feature` (2) and widens it to the commands that actually exist (V3/V4,
re-verified live as V80–V89). The baseline drove the browser through onboarding twice to establish a
number WP-CLI could answer directly, then asserted it behind an `ssh` preamble step and a bare
`JSON.parse`; its *intent* is one scenario of 6F.1.

**Why five sub-phases and not one.** The surface is **17 commands in Pro, 12 in Free** (V80), and it
does not divide usefully by edition — once `restore` leaves for 6G, only four are Pro-only. What it
*does* divide by is **the state a command needs before it can say anything**: nothing at all, a
configured job, a completed backup with its log, or a job running right now. That is also the order
in which a site acquires that state, so each sub-phase arranges what the next may assume, the
one genuinely edition-gated group falls out on its own, and a command is never split away from the
commands that create the conditions it is judged under. Splitting per command would multiply setup
across a dozen near-identical Backgrounds; splitting per edition would put `backup-delete`'s two
outcomes (V84) in different phases.

**Order:** 6F.0 ✅ → 6F.1 ✅ → 6F.2 ✅ → 6F.3 ✅ → 6F.4 ✅ — each arranges its own state, and
none depends on another's scenarios.

#### 6F.0 — CLI rails *(no feature files)* — **DONE**

**Shipped 2026-09-22.** Two modules, their specs, and one deduplication. Unit tests **739 → 778**;
typecheck, lint and format clean. Validated live on `simple.e2e.rocketlabsqa.ovh` against **both**
editions of `develop@f1ebfd0` — the facts are §2.14, V80–V90.

**The boundary that earns this a phase.** `support/backups.ts` already runs `job`, `backup`, `log`
and `run --background` — as **instrumentation**: it throws on a non-zero exit, because there a
failing command means the scenario's *arrangement* broke. 6F needs the opposite stance: the command
**is** the system under test, so a non-zero exit is an observation to assert — half this surface's
contract is how it refuses. Folding both into one module would make every existing caller carry a
"do I throw?" flag, so the asserting half ships beside the instrumenting one and each says which it
is.

What shipped:

- **`support/cli.ts`** — `backwpupCli`, which supplies the `backwpup` namespace (so an unrelated
  WP-CLI command cannot be run down the path reserved for the plugin under test) and **never throws
  for an outcome**; a pure parser for WP-CLI's own `Success:` / `Warning:` / `Error:` status lines,
  so assertions match structurally instead of hunting substrings in prose; and `readJsonList`, which
  refuses a failed command **before** parsing — WP-CLI leaves stdout empty when it errors, which
  would otherwise read as an empty list and pass.
- **`support/cli-commands.ts`** — the registered set as data (Free's 12, Pro's 5 additions, every
  alias), a parser for `wp backwpup --help`, and `compareCommands`, which reports drift **both
  ways**: declared-but-missing, and registered-but-undeclared. The second direction is deliberate —
  new CLI surface arriving uncovered, or a Pro command turning up on Free, are both worth failing on.
- **One implementation of JSON-list parsing, at the right layer.** `backups.ts` had a private copy;
  it now calls `cli.ts`'s, which is the lower-level module. Its own spec (`did not return JSON`,
  `expected a JSON array`) covered the move and stayed green.

**Why the registration probe scrapes a help page.** `wp cli cmd-dump` renders the whole command tree
as JSON and would have been the obvious choice — but it runs before plugins register theirs, so
BackWPup is simply absent from its output. Checked on a live site, not assumed. The parse is
therefore written to **fail loudly**: no `SUBCOMMANDS` heading, or a heading with nothing under it,
throws rather than returning an empty list — because "the plugin registers nothing" is the one wrong
answer that would make every absence assertion pass.

**The declared set is cross-checked against reality in the unit suite.** Both editions' real
`wp backwpup --help` pages are captured verbatim as fixtures, and the manifest is asserted equal to
what each one lists. That is what keeps the expectation honest without a live site: the three ways
the parse could go wrong — a wrapped description, another section's identically-indented content,
the page's own headings — are each pinned against those real pages.

**Deliberate revision: the shared Gherkin vocabulary moved to 6F.1.** It was planned here, but step
text is determined by the scenarios that use it, and a step definition no feature matches is dead
code no gate catches — writing it first would have been guesswork. It lands with its first consumer,
where every step is proved by a real scenario.

**Acceptance met** — `npm run test:unit` covers both parsers, the *"not a registered subcommand"*
wording (V80) and `log`'s plain-text `No logs found.` reply that is not JSON (V87). Live, on the same
site minutes apart: Pro reported exactly its 17 with **no drift**, Free exactly its 12 with **no
drift**, and each edition compared against the other named exactly the five Pro-only commands, in the
right direction each time.

#### 6F.1 — Registration and the read surface *(untagged)* — **DONE**

**Shipped 2026-09-22.** `features/cli-reads.feature` — **11 scenarios**, all untagged, plus the
shared Gherkin vocabulary 6F.2–6F.4 reuse. Unit tests **778 → 793**; typecheck, lint and format
clean. Run live with `E2E_RETRIES=0` on **`free@nginx` (13/13, every scenario first attempt)** and on
**`pro@nginx`** (12/13, then **13/13** on an immediate re-run — the one failure was the activation
race V96 records, in shared onboarding code rather than in this feature). **33 scenario executions,
one failure, not reproducible.** The facts it rests on are §2.14, V80–V96.

What shipped:

- **`steps/cli.steps.ts` and the `cli` fixture** (`support/cli-session.ts`) — the vocabulary:
  `When I run the BackWPup command "<subcommand …>"`, then `the command succeeds` / `fails`,
  `it prints "<exact stdout>"`, and `it reports the success|error "<text>"`. The last two match
  WP-CLI's own status lines by **level** and the text as a substring, because some messages carry a
  tail their command does not own (WP-CLI appends `See 'wp help …'`; the plugin embeds paths). The
  session keeps only the **latest** result, so no assertion can reach back past the command it
  judges. The `wp backwpup` prefix is supplied, and repeating it is refused rather than run.
- **`addBackupJob`** (`support/job-options.ts`) — the site's second and third jobs, created through
  `POST backwpup/v1/addjob`, the endpoint the dashboard's own "add new backup" card calls (V93).
  Dispatched in-process, as an administrator, so the plugin allocates the id, the defaults and the
  cron event; this suite writes no job record of its own. Verified by diffing the stored jobs.
- **`readHistory`** (`support/history.ts`, added by the audit — V99) — the plugin's own history
  table, which the run writes and the `backup` command never reads, so the command can be checked
  against it.

A **Background** finishes the install before any command runs (V102). The eleven scenarios, and what
each rests on:

- **Registration is the gate for all of 6F** — zero drift **both ways** against the declared set for
  this cell's edition. Free registering a Pro command shows up as drift, which is that edition's
  half of the split; the other half is a scenario of its own, which probes each Pro-only command
  with `--help` (V94) — the one probe that dispatches without *running* `restore`.
- **An unknown name is refused by name**, which is the wording every later mistyped command fails as.
- **`version` names the edition and the build** — asserted against the artifact manifest's own
  identity for this edition and the version the zip's own header declares (V101), so it also proves
  the cell installed what the run intended.
- **The empty state** (V87): `job` and `backup` answer `[]`, `log` answers in prose at exit 0.
- **Idle `status` and `kill`** (V81, V83) — `No job running.` and `Nothing to abort.`
- **The read contract, once, on `job`** (V88): count, `--field`, `--fields` (asserted as an *exact*
  key set, so a `--fields` that was ignored is caught), and the substring filter in **both**
  directions — `--type=DBDUMP` → 1 against `--type=file` → 0, because a filter that matched
  everything would pass the first half alone.
- **`--field=<bogus>` is refused** — in a scenario that arranges a job first, since with an empty
  list the command returns before it ever looks at the field (V90).
- **The baseline's intent, one job then three** — and every ids assertion **proves the exclusion is
  not vacuous**: it first asserts the site *is* holding a hidden job (V92) and only then that none
  was listed.
- **The two aliases the baseline used** still resolve (V89); nothing else spends coverage on aliases.
- **After a run**, `backup` and `log` each report it: the archive names against the history table
  (V99), `log --job_id` in both directions (V91), and the `errors`/`warnings` counts
  `readLastRunOutcome` depends on — beside the header's `job_id`, which proves they were read and not
  defaulted (V100).

**One plan claim corrected by building it.** V88 said `log` shared `job`'s and `backup`'s read
surface. It does not (**V91**): no `--field`, no `--format=ids`, no `--<field>=<value>`, and WP-CLI
rejects all three from its synopsis before the command runs. So the feature asserts two surfaces
rather than one — `log` on what it actually documents.

**Acceptance met** — a renamed command fails as "not registered" rather than as an empty list, by
mechanism; every count is taken against what the site stores, so a hidden job leaking into the
listing fails the scenario that reads it.

**Audited 2026-09-22** (§2.15): fifteen findings fixed — among them an archive assertion that compared
the `backup` command with itself, a generic step whose text could move a command onto another site,
six scenarios running unguarded against BackWPup's activation race, and a `version` scenario that
could not pass with a provided zip. Unit tests **793 → 821**.

#### 6F.2 — Running, watching and aborting *(untagged)* — **DONE** — **closed §2.9's deferral**

**Shipped 2026-09-22.** Two features, all untagged — `cli-runs.feature` (4 scenarios: the two
execution contexts, the refusals, deactivate/reactivate) and `cli-running-job.feature` (3: the
"already running" refusal, `status`, `kill`; **4 since §2.20**, whose measurement split the refusal
in two, V136) — plus a fifth duty in the shared `@plugin` teardown.
The facts are §2.17 (V108–V119); the audit that followed is §2.18.

What shipped:

- **`support/job-runs.ts`** — `readRunState` (the running marker, the job it names, and the whole
  history, in one request), `runProgress` / `waitForRunToEnd` ("ended" means nothing is running and
  the job's run no longer reads `created`, V114), `waitForJobRunning`, and `stopRunningJobs`.
- **A fifth teardown duty, shared.** `ProductConfig.stopRunningWork` reaches the hooks through the
  per-process registry, and `teardownPluginUnderTest` calls it after the log is judged and before the
  plugin is removed. Having to stop something is reported, not failed; work that will not stop is a
  cleanup failure. BackWPup's is `stopRunningJobs`: `kill`, again if the marker comes back, then wait
  for the run to record its end — one request on an idle site, 30 s budgets otherwise. It lives in the
  shared teardown because nothing else can guarantee its order: `After` hooks run in reverse
  registration order (playwright-bdd 9.2), and step files are imported in tinyglobby's filesystem order.
- **`support/settings.ts`** and `Given BackWPup's "…" setting is "…"` — Settings → Jobs values by the
  labels the screen gives them, refused unless the screen offers them, written as its handler stores
  them and read back from a second request.
- **`support/polling.ts`** (the probe wrapper and intervals, moved out of `backups.ts` to be shared);
  `readLastRunLog` beside `readLastRunOutcome`; `allowForBackup` in place of five hand-written copies;
  `HISTORY_ROWS_PHP` / `historyRecords`, so the run state reads the history in the same request.
- **Vocabulary**: `… on the scheduled job` with a `{job}` placeholder (one left unfilled is refused,
  since the plugin reads it as job `0`); `I watch the running backup with the BackWPup command "…"`,
  which gives a blocking command a backup's length as a budget of its own; `the scheduled job is
  running in the background`; `the scheduled job's run has ended`; `the backup history holds N
  <status> run(s) of the scheduled job, started by "…"` — the whole history, exactly — and `… holds no
  runs`; the newest-log verdicts; `it streamed the log of the run it made`; `it watched the scheduled
  job's run through to its end`; `the backup job is not scheduled to run`; and `the backup history
  shows the run as aborted by the user` (`BackupHistoryTable.abortedRows`).

**Deliberate revisions** against this section as planned, each for a measured reason:

- **No `@slow`.** §3.3 defines it as jobs that really take minutes; every job 6F.2 runs takes seconds
  (V112), so the tag would mislead a CI split.
- **Two features instead of one**: the three scenarios that need a job still running share a
  Background that arranges one, and the four that do not are spared it.
- **The running job is a paced database job**, not a files-and-database one: its worst case is
  seconds rather than a multi-gigabyte backup when an abort is lost, and with restarts off no command
  can land in a handover (V113). The files-and-database abort was measured (V114) and is no scenario.
- **`status`'s verdict is asserted only for a natural end** — for an aborted run it is wrong (V115).
- **"`run`'s exit code is not its verdict" became "there is no verdict"** (V108). V104 is superseded;
  V107's reachable paths need a broken folder or a cron start in a sub-second window, and no
  scenario relies on either.

**Acceptance met** — the abort scenario fails unless the history holds exactly one run of the job,
`aborted`, and the dashboard shows it aborted by the user; no scenario leaves a job running: each one
that starts a job waits for its end and asserts it, and the teardown's stop is the backstop for a
scenario that fails midway.

**Verified 2026-09-23**, after the audit's fixes (§2.18), with `E2E_RETRIES=0` on a runner kept
awake (V120): the full BackWPup suite passed **42/42 on `pro@nginx`** (51.9 min) and **42/42 on
`free@nginx`** (49.2 min) — the Free run meeting V122's race once, redoing the install and passing.
After `finishActivation`'s final check (V122's stray job), `cli-reads` and `cli-runs` — 15 scenarios
per cell, reaching it through both Givens — passed again, **17/17 on each cell** with the setups.
No SSH connection loss occurred. Both sites were left as found: plugin absent, no footprint, no data
directories, no staging area. Unit suite 821 → 910 across 6F.2 and its audit; **60 mutations**, all
caught, the file restored byte for byte each time.

**Revised 2026-09-30 (V184–V187).** `cli-running-job.feature` lost its race on `pro@apache`, whose 18
tables gave the paced backup 3.5 s — and it had only ever run on the nginx cells. The Background now
pads the database to 100 tables (`tablePadding`, `support/table-padding.ts`), which makes the window
about 11 s on every cell. Verified with `E2E_RETRIES=0` and the `af1ab5c` zips: **12/12 on
`pro@apache`** over three runs (5 of 8 had failed before), **4/4 on `pro@nginx`** and **4/4 on `free@nginx`**;
every site left as found, no padding table included. Unit suite 1191 → 1222; **13 mutations**, 12
caught and one equivalent (an unescaped `LIKE`, which the exact-name filter after it makes
harmless); both snippets through `php -l` and a behavioural harness against a fake `$wpdb`. **Revised
2026-10-05 (V188)**: a killed run's padding is swept when the next BackWPup worker starts; unit suite
1222 → 1241, with the PHP spec; **11 more mutations**, all caught.

#### 6F.3 — Backups and logs on disk *(untagged)* — **DONE**

**Shipped 2026-09-23.** Two features, all untagged — `cli-backups.feature` (4 scenarios: both sides
of the ownership split, a download and what it may overwrite, the refusals) and `cli-logs.feature`
(7: showing a log by name, by job and by its tail; deleting by name, by age and all at once; a log
WP-CLI may not write; the refusals; a path out of the log folder) — plus one fix in the shared
transport. The facts are §2.19 (V123–V133).

What shipped:

- **`support/plugin-folders.ts`** — BackWPup's backup and log folders read off the filesystem with
  PHP's own `scandir`, taking only their *locations* from the plugin; its log naming; a log made
  read-only; and the path from the log folder to the marker file, proved on the site before use.
- **`support/archive-snapshot.ts`** and the **`archives`** fixture — each archive a scenario's
  backups left, with its digest, recorded as it was made: what "byte for byte" and "the oldest
  backup" are measured against, so neither can move under a later delete (V125).
- **`support/download-folder.ts`** and the **`downloads`** fixture — the scenario's own folder in the
  site's staging area, created private to the transport's user under a name with a random part
  (V134), handed to `backup-download` relative to the directory WP-CLI runs in as the site itself
  resolves it (V135, both from §2.20), and removed afterwards only if a step used it; a copy of a
  database backup is not left in a docroot. Only that
  folder goes, never its category: a staging root declared as an absolute path is shared by the
  sites on a host, so `cleanSiteStaging` now takes a path inside the area rather than a category
  alone.
- **One placeholder rule for every command** (`support/placeholders.ts`, `fillPlaceholders` in
  `support/cli-session.ts`): `{job}`, `{oldest backup}`, `{newest backup}`, `{oldest log}`,
  `{newest log}`, `{download folder}`, `{path from the log folder to the marker file}` — each read
  only when a command uses it, and required to fit one argument. It replaces 6F.2's `… on the
  scheduled job` step, whose six uses became the plain step.
- **`runJobInForeground`** (`support/backups.ts`), judged by the history row and the log it left, not
  by the command; and each run's **`logfile`** in `support/history.ts`, which ties a run to its log.
- **`common/wp/files.ts`**: `listFiles` / `FILE_LIST_PHP` — a directory's files, digests on request,
  refusing a directory that is not there — and `backdateFile`, by the site's own clock; since §2.20
  also `listLocatedFiles` and `missingAsEmpty`, through which every listing in the suite now goes.
- **`common/wp/exec.ts`**: the execa-backed transports start a command with its stdin at an end, as
  ssh already did, so a `[y/n]` prompt is declined instead of hanging on `local` (V126; measured on
  every transport, V140).
- **Vocabulary**: `Given the scheduled job has made {int} backup(s) inside WP-CLI` / `… through the
  web server`; `Given WP-CLI's user may not write the {word} backup`, which **skips** the scenario,
  with its reason, on a site where it may; `Then it asks "…"`; `Then it reports the warning "…"`;
  and the backup, download, log-folder and log-output assertions in `steps/cli-backups.steps.ts` and
  `steps/cli-logs.steps.ts`.

**Deliberate revisions** against this section as planned, each for a measured reason:

- **`log-delete`'s refusal is arranged by making a log read-only**, not by having the web server
  write it: the web server's logs are `0777` on these cells (V123).
- **Deletions are confirmed against the folders themselves**, not against `log --format=count`: the
  listing command walks the log folder through the same helper `log-delete` does, so it could not
  see a defect the two shared.
- **Four measured edges added**, each a safety property nothing else covers: the `[y/n]` prompts
  (V126), the documented `--dry-run` (V132), a path out of the log folder (V133), and a refused
  download writing nothing (V127).
- **Plugin bugs left unpinned**, as §2.17 left V111 and V115: the poisoned second delete (V124), the
  orphaned history row (V125), the fatal on an unwritable download (V128), `log-delete` removing the
  folder's guards (V131), and `log-delete`'s success line when nothing was deleted (V106/V130). The
  scenarios steer clear of each, and say so where they come close.

**Acceptance met** — the refused delete leaves the archive byte for byte and the history exactly as it
was; every deletion is confirmed by reading the folder, never by the command's own line.

**Verified 2026-09-23**, with `E2E_RETRIES=0` on a runner kept awake: the two new features passed
**13/13 on `pro@nginx`** (19.9 min) and **13/13 on `free@nginx`** (18.2 min), every scenario on its
first attempt — each cell met V122's activation race once, and the reinstall recovered it, as
designed. The full BackWPup suite then passed **53/53 on `pro@nginx`** (1.1 h) and **53/53 on
`free@nginx`** (1.1 h, meeting the race three times and recovering each), run one cell after the
other, since the onboarding and contents features make files backups on a disk the two sites share
(V72). Both sites were left as found: plugin absent, no footprint, no data
folders, no staging area, no marker. Narrowing the download folder's cleanup to its own folder came
after those runs, so `cli-backups` was run again on both cells: **6/6 on each**, both sites clean. Unit suite
**910 → 1021** passed (8 skipped, unchanged); **45 mutations**, all caught — two only once their
tests were strengthened, each a real weakness: the missing-directory guard was pinned by its
condition alone, and an ordering check compared against `indexOf`'s `-1`.

#### 6F.4 — Pro-only round-trips *(`@pro`)* — **DONE**

**Shipped 2026-09-27**, as revised on 2026-09-24 against §2.22. Two features, both `@pro @plugin` —
`cli-job-transfer.feature` (4 scenarios: an export and what it leaves out; an import over its own job;
an import as a copy; the refusals) and `cli-backup-encryption.feature` (5: a hex key; RSA key files;
the key saved in the settings; the wrong key; the refusals) — on rails grown out of 6F.3's download
folder. The facts are §2.22 (V146–V167) and §2.23 (V168–V175). The two decisions stand: no
`--passwords` scenario, and one round trip each for the settings key and the RSA key files.

What shipped:

- **`support/private-folder.ts`** and the **`privateFolder`** fixture — 6F.3's `DownloadFolder`,
  generalised as planned: `place( name, content )`, `{private folder}`, the category `private`; the
  folder still `0700`, randomly named and removed only if used. `cli-backups.feature` and its four
  step texts were renamed with it.
- **`common/wp/files.ts`**: `pathFromWorkingDir` / `locateFromWorkingDir` — the path a command run in
  WP-CLI's working directory reaches a site path by, from the site's own `realpath()` and `getcwd()`.
  The private folder and `{path to the oldest backup}` / `{path to the newest backup}`
  (`backupPathFromWorkingDir`, `support/plugin-folders.ts`) share it.
- **`common/wp/paths.ts`**: `isPathSegment`, the one-segment rule, used by `pluginSitePath`, the
  staging area's segments and an archive's name in a backup folder.
- **`support/encryption-keys.ts`** and the **`keys`** fixture — `{encryption key}` and
  `{another encryption key}`, 64 random hex characters each and never equal; `{public key file}` /
  `{private key file}`, an RSA-2048 pair (SPKI / PKCS#8 PEM) made with `node:crypto` and placed in the
  private folder the first time either is named.
- **`support/encryption.ts`** — an archive's header read on the site (`BACKWPUP`, the version, the key
  type — or not encrypted), and the commands' temporary files beside an archive.
- **`support/settings.ts`**: `saveEncryptionKey` — the Encryption panel's three options as its handler
  stores them, archive encryption **off**, read back by a second request with the key compared on the
  site.
- **`support/job-transfer.ts`** and the **`jobExports`** fixture — an export file held to the stored job
  on the site and answered in key names: the file's jobs and keys, the settings that differ, the
  settings missing, the encrypted values, the stripped keys; a digest of the jobs option's row; the
  job renamed in the file; the arranging export. `StoredJob` gains `name`.
- **`describeCli`** hides every `--key=` value.
- **Vocabulary** as planned, but for the step texts below.

**Deliberate revisions** against this section as revised, each for a reason:

- **The steps name the export file** — `the export file {string} …`, `… the job exported to {string}
  …`, `… as they were when {string} was exported` — and the copy steps say "the copy of the job
  exported to …" and "the job itself" rather than "the copy" and "the original": a step text stands
  alone, and a scenario may hold more than one export.
- **The export is held to the job both ways** (V173, found by the audit). As planned, every check held
  what the file carries to the job, or what it leaves out — and an export carrying nothing but the
  job's id passed them all. `every setting the scheduled job holds is in the export file {string},
  except its schedule, run history, secrets and empty ones` closes it.
- **"No longer what its run wrote" is the header**: a plain archive never starts with `BACKWPUP`, so
  the header check implies it; and the wrong-key scenario is what catches a pair of commands that only
  add and strip a header.
- **The refusals are checked after each** — byte for byte after every refusal, and nothing beside the
  backup at the end, which covers them all: no command there removes a temporary file.
- **`describeCli` also hides a key wherever the output repeats it**, before the excerpt is cut, so no
  stretch of a key survives at the cut either.
- **One segment rule**: `pluginSitePath` and the staging area each had their own copy, and an
  archive's name needed it too, so it moved to `paths.ts` for all three. `pluginSitePath` now also
  refuses a backslash, as the staging area already did.
- **`playwright.unit.config.ts` writes to `test-results/unit`** (V170): a unit run beside a live one
  had wiped the live run's results.

**Acceptance met** — every scenario runs on `pro@nginx` and none is generated for `free@nginx`; each
round trip is judged by digest (encryption) or by the stored jobs and the jobs option's digest
(transfer), never by a success line; no scenario sends a command this section steers clear of, and
none turns archive encryption on; no assertion message, log line or report attachment carries a
secret, a key or an export's values; the sites were left as found.

**Verified 2026-09-27** at `develop@af1ab5c` (V168), with `E2E_RETRIES=0` on a runner kept awake:
the two features **9/9 on `pro@nginx`** before the audit and **9/9** after it (14.3 min with the
setups); the full BackWPup suite **62/63 on `pro@nginx`** (1.5 h) — its one failure V122's race in a
new form, a fatal in the host's cron request during an install (V174), the scenario passing in the
re-run — then **54/54 on `free@nginx`** (1.1 h), one cell after the other; `free@nginx`'s `--list`
holds 54 tests, none of 6F.4's. Both sites were left as found: plugin absent, no footprint, no data
folders, no staging area, no cron event. Unit suite **1069 → 1173** passed (8 skipped, unchanged);
**38 mutations**, all caught; each of the 13 new PHP snippets through `php -l` and a behavioural
harness. The audit's live measurements are V172 and V173.

### 6G.0 — Errors that never quote a command's arguments *(product-agnostic; before 6G)* — **DONE**

**Shipped 2026-09-29**, as planned below, on the facts in §2.24 (V176–V179) and §2.25 (V180–V184).

What shipped:

- **`common/wp/exec.ts`** — `fromExeca` reads only `ExecaOutcome`, execa's fields that say how a run
  ended without the command line, so quoting `shortMessage` is a type error. It checks the overflow
  first (V181), then `whyItDidNotExit` names the signal, or the start failure by its `code` (an
  identifier only), with both readings of `ENOENT` (V180). Every execa call goes through `runExeca`,
  which replaces execa's own throw (V182). No execa error is attached as a `cause`.
- **`support/cli.ts`** — `commandLine`, the one `--key=` mask. `describeCli`, `parseJsonList` and the
  time-limit message name a command through it. `backwpupArgv` is the namespace `backwpupCli`
  supplies.
- **`support/cli-session.ts`** — `withinBudget` names the command through `commandLine`.

**Deliberate revisions**, each for a reason:

- **A NUL byte in the argv is refused before any transport** (`refuseNulBytes`, by position): execa's
  refusal quoted the argument, and ssh2's was a bare `Unable to exec` (V182).
- **`parseJsonList` takes the argv, not a joined string** (V183): `readJsonList` hands it a scenario's
  own command, so it names it through `commandLine` and hides a key in the output it quotes. The
  audit found no secret in the other messages that quote an argv (`backups.ts`, `options.ts`,
  `residue.ts`, `cron.ts`), and they are unchanged.
- **The elevated local label is `sudo <program>`**, not `sudo`, matching `docker exec <container>
  <program>`: both name the program run and what it was run under.
- **The `ssh` side is pinned too** — a signal-killed command and a NUL byte, each with a secret in the
  argv, against ssh2's in-process server. Its messages are unchanged.

**Acceptance met** — a secret planted in the argv of each failing case appears in no message on any
transport, and none of them attaches a `cause`; each message names the program and the reason; the
`ssh` messages are unchanged.

**Verified 2026-09-29.** The four gates pass; unit suite **1173 → 1191** passed (8 skipped,
unchanged). **11 mutations**, all caught: quoting `shortMessage`, overflow checked after the exit
code, passing on or attaching execa's refusal, no NUL check, an unchecked `code`, `ENOENT` without the
directory, `ssh` naming its arguments, a raw budget message, no `commandLine` mask, and unmasked parse
output. The V176–V178 probes were re-run: the secret is in none of the five messages. Live, with
`E2E_RETRIES=0` and the cached `af1ab5c` Pro zip (`E2E_PLUGIN_ZIP`), since github.com timed out from
the runner twice, and `develop` (now `59b6fd9`) could not be built: `cli-running-job.feature`
**4/4 on `pro@nginx`** (6.5 min with the setups). On `pro@apache` it failed 3/4, and 2/4 with 6G.0
stashed — V184, a race the feature lost on that cell, fixed since (§2.26). Both sites were left as found.

**Must ship before 6G.** On `local` and `docker`, a command that cannot start, is killed or overflows
its output cap throws an error quoting its whole argv (V176), and the CLI session's time-limit message
does the same on every transport (V178). The argv is where this suite puts what it must not print — a
`--key=` value, and every value a snippet embeds, since `phpLiteral`'s base64 is an encoding, not a
cipher. The guarantee CLAUDE.md states and 6F.4's acceptance therefore hold only on `ssh` (V177).
6G itself adds no secret to an argv (V179).

**The rule:** an error names the program and why it failed — never its arguments. `ssh` already does.

- **`common/wp/exec.ts` — `fromExeca`** composes both of its messages from execa's own fields, which
  say why without the argv (V176): `code` for a program that could not start, `signal` and
  `signalDescription` for one that was killed, `isMaxBuffer` for one whose output was cut — plus its
  label, which names the program only (`wp`, `sudo`, `docker exec <container> wp`; `docker cp`'s
  label adds the suite's own paths). Never `shortMessage`, `message`, `command` or `escapedCommand`.
- **`support/cli-session.ts` — `withinBudget`** names the command as `describeCli` does, `--key=`
  hidden, through one helper in `support/cli.ts` rather than a second copy of the mask.
- **The other messages that quote an argv** — in `backups.ts`, `options.ts`, `residue.ts`, `cron.ts`
  and `cli.ts`'s `parseJsonList` call — carry job ids, option names and paths, never a secret. They
  stay; the audit confirms each.

**Unit specs** — `exec.spec.ts`: the four V176 cases through stub programs (one missing, a shell that
kills itself, output over the cap, and `docker` absent from `PATH`), each asserting that the message
names the program and the reason and holds no argument; `cli-session.spec.ts`: the budget message
with a `--key=` in the argv. Mutation checks on both.

**Docs** — `wordpress-automation.md` (what an exec error says, and why) and one clause in CLAUDE.md's
automation section.

**Acceptance** — a secret planted in the argv of each failing case appears in no message, on any
transport; each message still names the program and the reason; the `ssh` messages are unchanged.

**Verification** — the four gates and the mutations; the V176–V178 probes again, the secret in none
of their messages; then `cli-running-job.feature` on `pro@nginx`, the one feature that passes a
budget — the cells run `ssh`, which the change leaves as it is.

**Not covered, stated:** while a command runs, its argv is visible in the host's process list —
inherent to arguments, and to the plugin's own `--key=`.

### 6G — Restore — **DONE** *(6G.1 folded in)*

**Shipped 2026-10-05** at `develop@a612005`, measured first (§2.28, V193–V208). Two features, both
`@plugin @slow`:
[`restore.feature`](../../src/projects/backwpup/features/restore.feature) — five `@pro` scenarios
from the backup history (full, database-only and files-only restores of a full backup; a
database-only and a files-only backup) and the `@free` upload — and
[`cli-restore.feature`](../../src/projects/backwpup/features/cli-restore.feature) (`@pro`, four:
`--type=full|db|file` and `--pre-backup`). The coverage table below is what shipped.

What shipped:

- **The wizard's page object** (`pages/restore.page.ts`): `strategiesOffered` / `offered` /
  `restoreWith`, following the wizard by its URL's `step` (V198) to the "Success" panel, and failing
  at once — naming why — on the wizard's error line, the decryption prompt, the login screen (V200)
  and whatever `WizardWatch` (`pages/wizard-watch.ts`, armed with the page object) saw in its
  traffic: a stream reconnecting or answered with something else, a failed `controller=job` call, an
  uncaught error in the plugin's scripts (V220, V221). `ProRestorePage.expectEntryPath(archive)` holds the deep link to the
  archive restored (`file`, `restore_file`), `trigger_download=1` and no upload offered (V197).
  `restore.wizard.spec.ts` drives it through the wizard's captured steps 2–6 (`npm run
  fixtures:capture` gained the restore phase), following the buttons' own `data-next-step`.
- **Steps** (`steps/restore.steps.ts`): `Given the site's marker data has changed since that
  backup` (`changedMarkers`), the two history journeys, `When I run the BackWPup restore command
  "…"`, the strategy and snapshot assertions, and the four marker verdicts. Each restore step judges
  `debug.log` first (`checkDebugLog`, V201) and hands the restore directory to the web server
  (`handRestoreWorkingDirToSite`, V195).
- **`cliRestore`** (`support/cli-restore.ts`, over `content-copy.ts`, `database-defaults.ts` and
  `restore-snapshots.ts`): refused on a database holding what `wp db reset` would destroy for good,
  or a relocated `wp-content` (V219); `wp-content` copied with root `tar` into a root-only
  `<root>/.e2e_content_copy/` before a files restore and put back exactly after the scenario
  (`wp-content` from the root, POSIX format, `--recursive-unlink`; V205, V216, V223, V224) — kept, with the way back spelled out, when it cannot be, and a
  site still holding one refused by every BackWPup worker (V217); the database's default collation
  set back (V206); the scenario's own snapshots removed, told from another run's by either changed
  marker, on every run (V207). The generic command step refuses `restore`.
- **6G.1, folded in** — the hashed restore directories. Residue declarations take a family
  (`SiteResidueFamily`: parent + anchored name pattern; BackWPup's is the plugin's own
  `^backwpup-restore-[0-9a-f]{20}$`), and a product may resolve, after each install, the data
  directories only the installed plugin can name (`ProductConfig.resolveSiteDataDirs`), which the
  `@plugin` hook prepares like the declared ones.

**Deliberate revisions** against this section as planned, each for a measured reason:

- **6G.1 shipped with 6G, not after it.** On `develop` (and 5.7.7, V208) the hashed directory is not
  only residue: on Pro a WP-CLI listing creates it unwritable by the web server, after which the
  backup history page answers 500 (V194) and every wizard request fails (V195) — 6G could not run, nor
  could any Pro scenario that lists backups and then opens the history. §4.6G.1's measurement
  questions are answered by V193–V196 and V208.
- **The directory is prepared under its real name**, where §4.6G.1 had "the fix is its parent's mode,
  not a guessed name": the name is not guessed — it is the installed plugin's own `restore_dir_name()`
  — and the parent's mode cannot fix it, `uploads` being `0777` already on the cell while the
  directory and its `restore.dat` arrive `0775`/`0664` from WP-CLI's umask. Preparing it and handing
  it back before the wizard holds whatever the umask.
- **The `@pro` entry asserts what V197 measured**: the deep link names the archive in the backup
  folder and a copy slot in the restore directory, fetched by the server — not the archive "in place".
- **No re-authentication** (V200): the suite's login predates every scenario's backup.
- **The CLI guard** (`cliRestore`) was not planned: V205–V207 made the CLI scenarios unsafe on a
  shared cell without it. The approach is the user's ("create a backup before touching anything").

**Verified 2026-10-05** at `develop@a612005` (V193), with `E2E_RETRIES=0` on a runner kept awake: the
full BackWPup suite **71/72 on `pro@nginx`** (2.2 h), all nine restore scenarios among the passes —
its one failure, *Bulk-deleting the selected backups removes every one of them*, the browser's
renderer answering nothing for 8.5 s while the history loaded (the trace: the plugin had replaced the
placeholder row 4.4 s before the deadline, the server answered every call in ~0.6 s, the screencast
froze), the scenario then passing **3/3** — and **55/55 on `free@nginx`** (1.4 h), the upload
restore among them (5.0 min). Live mutation: switched to
*Full Restore*, each partial restore of a full backup failed at the half it was not to touch ("…
still hold(s) the changes made after the backup"). Both sites were left as found — modes and owners
as before the run, the database's collation unchanged, no plugin, footprint, restore directory,
snapshot or staging area. Unit suite **1241 → 1344** passed (8 skipped, unchanged); **22 mutations**,
all caught; the restore-directory, collation and snapshot snippets run under a real `php` by their
specs.

**Audited 2026-10-06** (§2.29, V209–V225), adversarially: the shared rails, the command-line
restore's guard and the wizard's page object each reviewed independently, every finding reproduced
before it was fixed and pinned by a test that fails without the fix. No restore had passed for the
wrong reason. Fixed: family patterns that deleted what they should not (V209–V212); a data directory
linked at the root opened `0777` (V210); a put-back that could race a still-running command (V214),
stop half-done (V216), delete the only copy after failing (V217), or fail on Ubuntu's tar and round
modification times down (V223, V224 — found live, the guard containing it); exit codes and sizes read
wrongly (V218); a database or `wp-content` the guard could not protect (V219); wizard failures that
surfaced only as 15-minute timeouts, or the log of its requests overwritten unread (V220–V222); the
capture tool's restore-only mode, token redaction and edition guard; docs (`@slow`, V213). Unit suite
**1344 → 1423** passed (8 skipped, unchanged); **77 mutations**, all caught — each guard broken once, its spec run.
Live, with `E2E_RETRIES=0` on a runner kept awake, at `develop@ab4a2e2` — `develop` moved by six
merges whose tree is `a612005`'s byte for byte (same tree SHA): **55/55 on `free@nginx`** (1.6 h);
on `pro@nginx` **41 passed** before the first command-line restore's put-back failed on Ubuntu's tar
(V223) — the guard kept its copy, the worker gate refused the 30 scenarios after it, and
`wp-content` proved identical to the copy before it was removed. With the copy rooted at the
WordPress root and in the POSIX format (V223, V224) a copy put straight back on `simple` reads
identical, and the 31 scenarios re-ran **33/33** with the setups (1.0 h). Both sites left as found —
modes, owners, file counts, collation; no plugin, footprint, restore directory, snapshot, staging
area or copy — bar `debug.log`, which the `@plugin` hook clears by design (V225). The `@plugin`
hooks re-timed on `pro@nginx`: Before 44–50 s, After ≈ 23 s, about 2.4× inside `HOOK_TIMEOUT_MS`.

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
- **Restore strategy** (*Full Restore* / *Database Only* / *Files Only*, chosen on the restore screen
  from a **mixed** backup) is orthogonal to entry path — cover it once, on the cheaper `@pro` in-place
  path, rather than multiplying both journeys by three.
- **Backup contents** — restoring a backup that was *made* files-only or database-only is a separate
  journey from choosing a strategy on a mixed one (V189): the screen offers only the one strategy the
  archive can serve, and half the site is simply not in it. One `@pro` in-place scenario each, and
  each asserts the strategies it is offered — exactly one — so a screen that offered *Full Restore*
  on half a backup fails.
- **The marker drifts on both sides, every time.** The Background changes the file marker *and* the
  option marker, and every scenario asserts both: the side the restore covers is back, the side it
  does not is **still drifted**. Without the second half, a restore that silently does everything,
  or the wrong half, passes every partial scenario.
- **CLI restore** (`@pro`, V4): `wp backwpup restore <file> --yes --type=full|db|file` (V192), with
  `--pre-backup` on one scenario. A restore that fails midway exits 0 with a warning — and, after a
  successful rollback, ends on `Success:` (V105) — so the marker is the verdict, never the exit code.
- **Archive format: `.tar` only**, the default every backup so far has used. `.zip` and `.tar.gz` are
  extracted by different code in both entry paths (V191) and are **6K**, deliberately split out, not
  dropped.
- Tag `@slow`; a restore rewrites the site, so it must run on a worker-bound site and re-authenticate
  afterwards if the restore rolls the session back.

**Coverage** (`.tar` throughout):

| Scenario | Backup | Restored with | Entry | Edition |
| --- | --- | --- | --- | --- |
| Full restore in place | mixed | *Full Restore* | history deep link | `@pro` |
| Database-only restore of a mixed backup | mixed | *Database Only* | history deep link | `@pro` |
| Files-only restore of a mixed backup | mixed | *Files Only* | history deep link | `@pro` |
| Restore a database-only backup | database only | *Database Only* (the only one offered) | history deep link | `@pro` |
| Restore a files-only backup | files only | *Files Only* (the only one offered) | history deep link | `@pro` |
| Restore by uploading the backup file | mixed | *Full Restore* | download, then upload | `@free` |
| CLI restore, each `--type` | mixed | `--type=full\|db\|file` | `wp backwpup restore` | `@pro` |
| CLI restore with a safety snapshot | mixed | `--pre-backup` | `wp backwpup restore` | `@pro` |

**Before building:** a measurement pass on `pro@nginx` (§2's rule) — drive one in-place and one
upload restore by hand, then record whether a restore ends the admin session, how long each takes,
and that V189–V192 hold live.

**Acceptance** — a restore scenario **fails** if the marker is not restored (the property the
baseline never had), and a partial one also fails if the half it does not cover was restored; each
contents scenario fails if offered any strategy beyond its own; each edition's scenario fails if it
is served the *other* edition's entry path.

### 6G.1 — Hashed restore directories — **DONE, with 6G**

**Shipped as part of 6G** (§4.6G "Deliberate revisions"): measured in §2.28 (V193–V196, V208), fixed
with residue families and plugin-resolved data directories, verified with 6G's live runs; the
questions 6G left open answered and a killed run's directory swept live in §2.30 (V226, V227). The
plan as written follows, for the record.

**The gap.** BackWPup's latest stable release keeps its restore working files in a directory with a
random suffix — `wp-content/uploads/backwpup-restore-<hash>`, e.g. `backwpup-restore-7b20d60dc8d75d16f8b4`
— where earlier builds used the fixed `wp-content/uploads/backwpup-restore`. `BACKWPUP_SITE_RESIDUE`
(`support/residue.ts`) names only the fixed path, and `siteResidue` takes **literal** paths, so the
`@plugin` teardown never sees the new directories: each restore leaves one behind, they accumulate
across runs, and the reason the old one was cleared applies to them unchanged — an uploaded archive,
an extraction tree, and possibly a `restore.dat.bkp` holding the site's database credentials in clear.
6G's restores are the first scenarios to create them; until 6G.1 ships, clear them by hand after 6G's
live runs.

**1. Measure first** — at the start of the sub-phase, not before, on `pro@nginx` at the ref under
test (§2's rule), then recorded as V-rows in a new §2 section. Nothing below the measurement is
settled until it is:

- **Which builds write it.** The ref the cells install, latest stable, both editions; whether the fixed
  `backwpup-restore` is still written alongside it (and by what), or gone.
- **Which journeys create it.** UI in-place (`@pro`), UI upload (`@free`), CLI restore — and whether
  any other step does (opening the restore page, a download, the stale-files notice).
- **The name.** Length and alphabet of the suffix; random per restore, per install, or derived from
  something the suite can read (`backwpup_cfg_hash`, an option) — that decides whether the sweep
  matches a family or can name the one directory.
- **Ownership and mode** as the web server creates it, and whether the transport's user can remove it
  unprivileged — the fixed directory could not be (§4.6A, "cleanup escalates").
- **Its lifecycle in the plugin.** Whether a successful, a failed or an aborted restore removes it,
  and whether uninstall does.
- **Its contents**, `restore.dat.bkp` in particular, and whether `StaleRestoreFilesDetector` and the
  backup's own uploads exclusion (`backupuploadsexcludedirs`) know the new name — a files backup that
  captured it would carry those credentials into an archive.
- **The CLI's temp path.** `support/residue.ts` says the CLI restore works in
  `get_temp_dir()/backwpup-restore-<uniqid>`, outside the root; confirm whether that is this same
  directory resolved into `uploads`, or a separate one, and correct the comment either way.

**2. The fix** — shape to be confirmed by the measurement:

- **A residue entry that names a family**, if the suffix is not knowable in advance: a parent the
  product declares (`wp-content/uploads`) plus a one-segment pattern for the name, matched **on the
  site**. Each match is a literal path from then on and goes through every guard a declared path
  does — `normaliseResiduePath`, `isPathSegment`, `assertSafeElevatedRemoval`,
  `assertResolvedInsideRoot`, the symlink refusal — then unprivileged removal, escalation of what
  survived, and verification by re-reading. The pattern must never match its parent, a fixed sibling
  such as `backwpup-restore`, or anything outside the one directory, and is as tight as the measured
  name allows (prefix *and* suffix shape, not `backwpup-restore*`).
- **The fixed `backwpup-restore` stays declared** while any build the cells can install still writes
  it, and for runs made before the change.
- **`prepareSiteDataDirs` prepares literal paths only.** A family is never pre-created; if the
  measurement shows the two-user lockout applies to the new directory, the fix is its parent's mode,
  not a guessed name.
- **Product-agnostic where the mechanism is**: the pattern type lives with `siteResidue` in
  `common/`, the BackWPup name with `support/residue.ts`.
- **Docs:** `ProductConfig.siteResidue`'s TSDoc, `support/residue.ts`, `wordpress-automation.md`
  (residue), CLAUDE.md's `@plugin` section.

**3. Verify** — unit tests for the matcher and its guards (a match at the parent, a sibling, `..`, a
`/`, a symlinked match pointing out of the root), each mutation-checked; then live on `pro@nginx`: a
6G UI restore and a CLI restore each leave no restore directory behind, and a planted stale one — what
a killed run leaves — is swept by the next scenario's teardown. Then `free@nginx` for the upload path.

**Acceptance** — after any restore scenario, on either edition and either entry path, no
`backwpup-restore*` directory remains under `wp-content/uploads`; one left by an earlier, killed run
is removed by the next teardown; a declared family can never match outside its parent nor a path
WordPress owns; the facts the fix rests on are V-rows measured at the ref under test, not this
section's description of them.

### 6H.0 — Plugin folders WordPress cannot see *(product-agnostic; before 6H — critical)*

**The gap** (§2.31). A removal cut short — the QA servers restart PHP-FPM or reboot several times a
week (V231) — leaves `wp-content/plugins/<slug>/` holding part of the plugin. Without its main file
WordPress lists nothing there, so every "is it installed?" check says no, and every install aborts on
"Destination folder already exists" (V229, V230): one interruption fails **every** later scenario,
on every cycle, until someone removes the folder by hand. With its main file but not the rest, the
plugin is listed and its `uninstall.php` cannot load what it needs (V229, unmeasured) — the same
dead end, through a failing uninstall. And this suite's own removal checks would call either folder
removed (V233).

**The rules.**

- **"Absent" means nothing at the plugin's path**, not "WordPress lists no plugin there".
- **A half-removed plugin costs at most the scenario that left it**, never the scenarios after.
- **Cleanup heals, removal under test judges.** The lifecycle hooks remove what is left and say so;
  a scenario that *tests* removal fails on what is left and never sweeps it itself.
- **Keyed on the slug under test, nothing else.** The shared QA sites hold other teams' folders
  WordPress does not list either (a read-only scan found `revslidertest*` and `td-composer` on
  several of them); nothing outside the artifact's own slug is ever inspected for removal.

**What ships.**

- **`common/wp/plugin-dir.ts`** — the plugin's folder as the site has it.
  - `inspectPluginDir(transport, slug)` → `absent` | `recognised` | `orphaned`, the last with an entry
    count, a bounded sample of top-level names, owner and modification time — the evidence a report
    needs. One `evalPhp` with plugins and themes skipped: the folder is `WP_PLUGIN_DIR/<slug>` as the
    site defines it (never an assumed `wp-content/plugins`), held inside the root with
    `assertResolvedInsideRoot`, and "recognised" is `get_plugins( '/<slug>' )` being non-empty — the
    test `wp plugin is-installed` itself rests on. A link at the slug is reported as a link.
  - `removeOrphanedPluginDir(transport, slug)` — acts only on a folder inspected as `orphaned`
    immediately before; the slug through `isPathSegment`/`pluginSitePath`, the target through
    `assertSafeElevatedTarget`; a link is removed as a link, never followed. Unprivileged first, then
    `execElevated` for what survived, through the removal `wp/residue.ts` already uses (shared, not
    copied). Verified by inspecting again: anything but `absent` throws a new
    **`PluginDirRemovalFailedError`** naming what is left — thrown, unlike data residue, because the
    next install cannot succeed with it there.
- **`ensurePluginAbsent` (cleanup) becomes path-aware** and returns what it had to clear, for the
  hooks to report. After the WordPress removal it inspects the folder; `orphaned` is removed. A
  `recognised` plugin whose uninstall fails is the other shape: the cleanup then removes the folder
  without the uninstall (the plugin is already deactivated) and lets the database sweep that follows
  take the footprint — only once V229's main-file-survives shape has been measured, and with the
  uninstall's own failure kept in the report. `uninstallPlugin` is unchanged in that respect.
- **Removal under test is path-aware and never sweeps.**
  - `uninstallPlugin` — after the uninstall, anything at the path fails `PluginUninstallFailedError`,
    naming what survived.
  - `PluginsPage.delete` — reads the `delete-plugin` answer: `success: false` fails
    `PluginDeletionFailedError` with WordPress's own `errorMessage` ("Could not fully remove the
    plugin …"); a non-JSON or non-200 answer (a killed request's gateway page) fails naming its status.
  - The step "BackWPup is no longer installed on the site" asserts `inspectPluginDir` is `absent`,
    which is what its message already claims.
- **The `@plugin` hooks report it.** Before the install and after the scenario, a cleared folder is a
  `console.warn` plus a `leftover-plugin-files` attachment — count, sample, owner, age, and the likely
  cause in one sentence (a removal stopped part-way, e.g. by a PHP-FPM restart or a reboot) — in the
  shape `sweepDbResidue` already prints. Order: `ensurePluginAbsent` (folder included) → database
  sweep → install, so a folder left by a cut-short *install* (no rows, maybe no main file) is covered
  by the same step.
- **An install that still hits a folder says what it is.** `installPlugin` turns WP-CLI's
  "Destination folder already exists" into **`PluginDestinationExistsError`**, naming the path and
  whether WordPress sees a plugin there — for the case where something re-creates the folder between
  the sweep and the install.
- **Pre-flight and the healthcheck report, never gate.** For each real site, an `orphaned` folder at
  the slugs the product's manifest maps its editions to (`wp-rocket`, `backwpup`, `backwpup-pro`) is
  one line in the run-level warning banner, and a check in the healthcheck's per-site list, saying the
  next `@plugin` scenario will remove it. That is how a fleet monitor would have shown this incident
  before a cycle failed.

**Unit specs.** `plugin-dir.spec.ts` against real directories over the `local` transport: the three
states, a link at the slug (inspected, removed as a link, its target untouched), a folder only
elevation can empty, verification after removal, the slug and root guards. `plugin.spec.ts`:
`ensurePluginAbsent` removes the folder only after WordPress's removal and never a `recognised` one
before the uninstall was tried; `uninstallPlugin` fails on a remnant and does not remove it.
`plugins.page.spec.ts`: a `success: false` body, a 502 HTML body. `plugin-lifecycle.spec.ts`: the
report, and the order. Each new assertion proven by a mutation that removes it.

**Verification** (all of it part of this sub-phase):

- **Reproduce first, on a cell.** On `pro@nginx`, with the user's go-ahead for a destructive
  measurement, interrupt WordPress core's own `delete_plugins()` (`timeout -s TERM` around a `wp eval`)
  until the folder is left without its main file; record the cell's readdir order and the Before
  hook's failure verbatim, before the change.
- **Measure what the plan leaves open:** the wp-admin deletion time of the Pro build on both servers
  (the window V231's kills land in), and what `wp plugin uninstall` does when the main file survives
  and `vendor` does not (V229).
- **Recovery:** after the change, the same dirty cell runs the full BackWPup suite with
  `E2E_RETRIES=0`, the first scenario reporting the cleared folder; then the main-file-survives shape
  the same way.
- **The deletion feature catches it:** a `plugin-deletion` scenario whose deletion is cut short fails
  on the step that asks the site, not on a timeout.
- **A no-op on a clean site:** one read, no write, nothing elevated, on both nginx cells.
- The four gates; docs: `wordpress-automation.md` (plugin lifecycle: what "absent" means, the new
  module and errors), `CLAUDE.md` (the `@plugin` hook's Before/After bullets, the `wp/` module list),
  `authoring-tests.md` if the deletion step's contract is described there.

**Acceptance** — a folder at the slug that WordPress does not list, or lists but cannot uninstall,
costs at most one scenario and is reported every time it is cleared; a removal under test that leaves
anything at the path fails, naming what is left; a clean site pays one read; nothing outside the
artifact's slug is ever touched.

**Not covered, stated:**

- **The cause on the servers.** The twice-daily reboot and `needrestart`'s PHP-FPM restarts are
  operator settings (V231); this sub-phase makes the suite survive them, and the orchestrator plan is
  where a cell learns to pause across a known maintenance window.
- **The old suite.** `wp-rocket-e2e` (AutoE2E) needs the same check in its own BackWPup hooks; that is
  a separate change to that repository.
- **Other half-finished writes a kill can leave** (an interrupted restore, a half-copied upload): each
  has its own guard or none, and this sub-phase does not widen to them.

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

- ~~Add a **`free@nginx`** cell~~ — **done (2026-09-18)**, and validated in §2.11: the cell is
  `bwu.e2e.rocketlabsqa.ovh`, its own site and its own database. Everything untagged runs on Free with
  **zero** new scenario code and the Free artifact needed no manifest change, exactly as V1 predicted
  (V64). Two things to carry forward rather than rediscover: the cell shares a **host and a disk** with
  `pro@nginx` and holds a larger docroot, so the two must not run files-backup scenarios concurrently
  (V72); and it is the only cell that leaves WordPress's own cron enabled *and* pokes `wp-cron.php`
  from a system crontab, which makes V46's activation race likelier there than anywhere else
  (V68) — defining `DISABLE_WP_CRON` on the site would align it with `pro@nginx` at no cost.
- Add the `@free` locked-storage upsell scenario (V2).
- **Parity review** against §2.1: every baseline intent is covered or has a written, deliberate
  reason not to be. A checklist in the PR — not a claim.

**Acceptance** — both cells green; the parity checklist is complete; no scenario is a
transliteration of its baseline ancestor.

### 6J — Staging area web guard *(product-agnostic; depends on nothing)*

**The gap.** The staging area is in the docroot, and a web server serves whatever it can read there
(V134). From the first scenario's install to the worker's teardown — hours — the plugin zip under test
can be downloaded, BackWPup Pro's included, and on Apache a staged `.php` would even run (V142). The
area itself stays exactly as it is: location, modes, cleanup, the download folder's `0700`. 6J tells
the web server not to serve it, and has every run measure whether it listened.

**1. The `.htaccess` guard** — Apache, and any server that honours `.htaccess`.
`src/common/wp/staging-guard/staging.htaccess`, copied to the staging root as `.htaccess`:

```apache
<IfModule mod_rewrite.c>
	RewriteEngine On
	RewriteRule !^public(?:/|$) - [F]
</IfModule>
<IfModule !mod_rewrite.c>
	Require all denied
</IfModule>
```

- **Everything answers 403 except the top-level `public/`**, which keeps the server's normal handling
  (V142). The pattern is matched relative to the root, so `plugins/public/` stays denied. Nothing
  creates `public/`: it is reserved for an artifact a plugin must fetch over HTTP — the one use the
  staging docs call useful today — and exported as `PUBLIC_CATEGORY`. Code staged there would run, so
  it never holds any.
- **Fails closed in every setup but `AllowOverride None`** (V143), which is what the probe exists to
  see.
- **One writer.** `stageArtifact` is already the one way files are staged; BackWPup's download folder is
  the only other code that creates the root (PHP's `wp_mkdir_p`). A new
  `prepareStagingArea(transport, ...path)` creates the directory, writes the guard and returns the
  path. Both call it, so nothing is ever staged into an area without its guard.
- **Rewritten on every call, atomically**: uploaded under a temporary name, then renamed over the old
  one. `mkdir -p` cannot say whether it created anything, a per-process memo goes stale the moment
  something else removes the area, and a rewrite that truncated in place would leave an empty guard in
  front of files already staged. It goes through `copyIntoTarget` from the committed file, so there is
  no shell string and nothing to escape. Its cost, two small round trips per staging call, is measured
  in the verification.
- **The one staged file the web server reads.** It keeps the transport user's ownership like everything
  else staged. The default umask makes it `0644`, and a guard the web server cannot read fails closed
  (V143). The ownership rule's "only the transport user ever reads it" is amended to name it as the
  exception.

**2. The pre-flight probe** — a report, never a gate. Per site, once the transport checks pass, beside
"File ownership" and "Elevation":

- **Stages through `stageArtifact`** — the production path, so it measures the protection a run
  actually gets, guard included. The probe is a `.zip` (the extension actually staged) holding a random
  token, in a category with a random name of its own, so two sites sharing an absolute root, or a
  healthcheck beside a run, never meet.
- **Fetches it** at `baseURL` plus the root's path relative to the WordPress root — the suite's
  standing assumption that the WordPress root is served at `baseURL`. A root outside the WordPress root
  is **not probed**, and the check says so.
- **Judges by content.** *Served*: the token came back, redirects followed so an http→https hop still
  counts. *Not served*: any other answer — 403, 404 (WordPress's own page on these cells, V145), 500, a
  login page. *Could not check*: no answer within a bounded wait (timeout, TLS, DNS), never reported as
  safe (V145).
- **Cleans up after itself.** The probe's category is removed whatever happened. The root and its guard
  stay: a run's teardown removes them, and after a healthcheck they wait for the next run's, because
  removing a root the probe did not create would pull it from under a concurrent run. This is the
  first pre-flight check that writes to a site, and the docs say so. A root that cannot be written is
  reported as *could not check* with the staging error; the first install still fails on it, as today.
- **Reports** as an always-passing `CheckResult` — `Staging exposure: not served (403) — <url>`,
  `served over HTTP`, `could not check: …`, `not probed: …` — plus a typed field the banner reads, as
  `elevation` is.
- **Warns** when any site is served, with a run-level banner printed from the same two places as the
  elevation banner (the auth setup to stderr, the healthcheck to stdout) by one function, so the two
  cannot drift. Per site: the URL that returned the probe's content; what that exposes (anything
  staged, the plugin under test included, and on Apache staged code would run); and the `Server`
  header of the answer. Then the remedies:
  - **nginx** — include `staging.nginx.conf` (its absolute path on this runner) in the site's
    `server {}` block, then `nginx -t` and reload;
  - **Apache, or another server that reads `.htaccess`** — the guard is in place but ignored; on
    Apache, allow `FileInfo` overrides for the docroot;
  - **any server** — move the staging area out of the docroot with the site's own
    `transport.stagingDir` (absolute, one per site). It needs no server change and gives up only
    `public/`.

**Server detection** is that `Server` header and nothing more. It is free, since it comes with the
probe's own answer, and it is shown rather than acted on: a CDN or proxy answers with its own name,
and the verdict never needs it, because the probe measures the effect.

**3. The nginx include.** `src/common/wp/staging-guard/staging.nginx.conf`:

```nginx
location ^~ /.e2e_temp/ {
    deny all;
}
location /.e2e_temp/public/ {
}
```

- The same rule as the guard (V142). `^~` makes it independent of its position inside `server {}`
  (V144); `public/` is a plain prefix, so the vhost's own regex locations still apply there, as
  Apache's normal handling does.
- Written for the default layout. Its header says to adjust both paths for a WordPress served from a
  subdirectory or a moved staging area, and that a duplicate `location` fails `nginx -t`.
- **Baked into the docker env's nginx** through a `COPY --from` of a Compose `additional_contexts`
  entry — proven on this runner's Compose v5.5.1 — so the image still needs no host bind. The local
  nginx cell then runs with the include, and every pre-flight there re-proves the committed file on a
  real nginx. Without that, the include would be proven once, here, and could rot unnoticed.

**Keeping the two in sync** — one rule in two languages:

- **A CLAUDE.md MUST**, beside the ownership one: change one guard, change the other in the same
  change, keep the drift spec green, and re-probe the docker Apache and nginx cells.
- **Each file's header names the other** and that rule. The `.htaccess` header is also what an
  operator finds on a site, so it says what wrote it and that the suite removes it.
- **A drift spec** reads both files: each denies `DEFAULT_STAGING_DIR` and exempts exactly
  `PUBLIC_CATEGORY`, at the top level only. It catches a renamed default or exemption; what the rules
  *do* is what the live checks and the docker include prove.

**Docs**, by whoever implements: `wordpress-automation.md` (the Exposure bullet becomes the guard, the
probe and `public/`; the ownership rule's exception), `configuration.md` (the include, and
`transport.stagingDir` as the remedy that needs no server change), `CLAUDE.md` (pre-flight's reports,
the healthcheck's checks, the staging bullet, the MUST), `README.md` (an operator note beside the
Docker env), `.env.example` (the staging comment).

**Unit coverage** — the policy is pure and the I/O thin:

- Nothing is staged before its guard: call order on a recording transport, for `stageArtifact` and the
  download folder, with the rename after the upload.
- URL mapping: a root inside and outside the WordPress root, relative and absolute overrides, a
  `baseURL` with a path, with and without its trailing slash (`new URL` drops a base's last segment
  without one), segments encoded.
- Verdicts: the token → served; a 200 with anything else → not served; 403/404/500 → not served; a
  throw or timeout → could not check; the probe's category removed on every path, a throwing fetch
  included.
- The banner: silent when nothing is served; per site the URL, the `Server` value, every remedy and
  the include's path; identical text from both entry points.
- Mutation-checked, as every sub-phase since 6E.

**Verification** — with Docker up (the user starts it):

1. **Docker Apache cell** (`:8100`): not served (403). With the guard deleted by hand: served, and the
   banner.
2. **Docker nginx cell** (`:8101`): with the include baked in, not served. Built without it: served,
   and the banner with `Server: nginx/…` and the include's path.
3. **`public/` on both**: a file there answers 200, one beside it 403, `plugins/public/` 403.
4. **`pro@nginx` and `free@nginx`**: served, and the banner, until the include is in their vhost. That
   is an operator change on the QA host, the user's to make; after it, not served. The probe's cost per
   site is recorded.
5. **The full BackWPup suite on one nginx cell**: installs are undisturbed, and after the teardown there
   is no staging area, guard included.
6. **`pro@apache`**, the one real Apache, only with the user's go-ahead, since AutoE2E runs there.

**Acceptance** — nothing is ever staged into an area without its guard; *served* means the probe's
own random content came back, and no answer is never reported as safe; the banner is silent on both
docker cells and present on an unprotected one, with the URL, the server's own name and every remedy;
the two guard files cannot drift apart silently.

### 6K — Restore from every archive format *(`@pro`; after 6G; last in the sequence)*

**Required to close Phase 6, not deferred** — it is last only because it reuses 6G's steps whole.
6G restores `.tar`, the default; BackWPup also writes `.zip` and `.tar.gz` (V190), and each is
unpacked by different code — three extractors in the UI, three more in the CLI (V191). A `.tar`
restore says nothing about the other two.

- **One axis, not a matrix.** The extractor is chosen by extension, never by what the archive holds
  (V191), so every scenario restores a **mixed** backup — the only one that sends files *and* a
  database dump through the extractor — with a full restore. Contents and strategy stay 6G's.
- **The `.zip` / `.tar.gz` backup is made after onboarding.** Onboarding can only produce `.tar`: it
  offers no format, and its save reads three keys, none of them the format (V39), so the job is
  created as `.tar` (V190). The setup therefore onboards as 6G does, **switches the onboarded job's
  archive format**, and only then runs the backup that the scenario restores. Measure first which
  route switches it the way the plugin does — the job's settings screen, or 6F.4's `job-import`, which
  merged a format change (V159) — and assert the backup that results really carries the extension
  asked for: a fallback to `.tar` (`inc/class-admin.php:902-907`) would otherwise pass every scenario
  as a `.tar` restore.
- **Both entry paths, both formats** — the UI and the CLI do not share an extractor:

| Scenario | Format | Entry |
| --- | --- | --- |
| Restore a `.zip` backup in place | `.zip` | history deep link |
| Restore a `.tar.gz` backup in place | `.tar.gz` | history deep link |
| Restore a `.zip` backup over WP-CLI | `.zip` | `wp backwpup restore` |
| Restore a `.tar.gz` backup over WP-CLI | `.tar.gz` | `wp backwpup restore` |

- **No `@free` format scenarios.** Free's upload journey ends in the same extractor (byte-identical,
  V191), so the format adds nothing to it that the `@pro` scenarios do not already prove. Revisit only
  if the measurement shows the upload step itself treats a format differently.
- **Out of scope, stated:** `.tar.bz2` — no longer offered, and the restore refuses it (V190).
  Archive inspection (`wp/archive.ts`) stays tar-only: these scenarios read the restored markers, never
  the archive, so `.zip` needs nothing there.

**Acceptance** — each of the four restores the marker on both sides; each fails if the backup it
restored was not made in its format; the restore steps are 6G's, reused unchanged — only the setup
differs, by the format switch.

---

## 5. Definition of done (phase-level)

- Every §2.1 intent is ported, superseded, explicitly declined, or **explicitly deferred** in writing.
  Exactly one deferral is open: the 11 storage round-trips of **6H.2**, blocked on credentials. Phase 6
  may close with it outstanding *only* because 6H ships the config, the skip gate and the isolation
  helper, so 6H.2 adds scenarios and nothing structural. **6K is not a deferral**: Phase 6 does not
  close until a backup in every archive format the plugin writes (V190) has been restored.
- Both `pro@nginx` and `free@nginx` cells green; `@pro`/`@free` scenarios run only on their edition's
  cells.
- The 6A lint gate is green — no `waitForTimeout` / `networkidle` / `waitForSelector` / `page.type`
  anywhere under `src/projects/**` or `src/common/pages/**`.
- Every POM has a locator-contract spec; `npm run test:unit` green.
- Docs updated by whoever changed the code: `authoring-tests.md` (new fixtures/POMs/tags),
  `configuration.md` (new storage service config), `CLAUDE.md` (fixtures table), `.env.example`.
- Parent plan §9 Phase 6 replaced by a pointer to this doc.

---

## 6. After Phase 10 — WP Rocket

**Deferred (decided 2026-10-06):** WP Rocket's port starts only once Phase 10 (cleanup & validation)
is done — not straight after BackWPup. Phase 6 closes on BackWPup alone (§5).

WP Rocket reuses **6A unchanged** and follows the same recipe: **page objects first**, then features.
Its baseline is much larger (`src/features/`, `src/specs/`, `src/support/steps/`, plus the 921-line
`page-utils.ts` and 486-line `sections.ts`) and brings concerns BackWPup does not: `@mobile` (6A),
settings export/import diffing, the `@visual` A/B scenarios (`expectOptimizedToMatchUnoptimized`,
already shipped), third-party plugin interactions, and the `previous` artifact role for update paths.
It gets its own sub-phase breakdown, written from the same verified-source discipline, when that
work starts — deliberately **not** guessed here.

---

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Markup drift between 5.7.4 (verified) and `develop` (tested) | **Measured, not assumed: zero drift at the ref under test (§2.3)** — identical templates, REST routes and CLI commands. The 6B locator-contract spec, built from markup *captured* at that ref, turns any future drift into one clear unit-test failure. |
| Icon-only buttons have no accessible name (V7) | Documented as a legitimate `js-backwpup-*` / `data-content` case in the §3.2 policy — not a silent exception. 6B found a **second** such case (V16: every switch is an `sr-only`, `aria-hidden` checkbox with a textless label); both are handled in one place (`pages/toggles.ts`) and each is pinned by a test asserting the control really is unreachable by role, so a future accessibility fix is noticed rather than assumed. |
| Non-English admin breaks role/label locators | **Shipped in 6B**: the pre-flight asserts `determine_locale()` for the configured admin user and fails once, clearly, with the fix in the hint. Runs only after the transport checks pass, so a dead site reports one cause, not two. |
| Storage credentials missing / rate-limited | **Realised, and handled by deferral:** no credentials exist yet, so the round-trips are 6H.2 and out of the critical path. 6H still ships the surface — scenarios **skip** (never fail) without credentials, per-site `overrides` exist for rate-limited hosts, `testInfo`-derived paths keep workers isolated. |
| Restore rewrites the site under test | **Realised and handled in 6G (§2.28):** the markers judge each half of the site; the wizard's restores rewrite in place and left the cells as found; the command-line restore, which deletes what its archive lacks and resets the database's collation, runs behind `cliRestore` (a copy of `wp-content` put back, the collation set back, its snapshot removed). No re-authentication (V200), and no ordering — every scenario reinstalls and ends as found. |
| Backup jobs are genuinely slow | `@slow` for CI splitting; real barriers (`startbackup`, `job-abort-status`) instead of long fixed timeouts, so the wait is as short as the job allows. |
| **Archives accumulate on the site under test** | **Realised, then fixed in the shared rails (2026-08-05).** BackWPup's uninstall keeps every archive it made, and a full backup of the `pro@nginx` site is ~340 MB, so each scenario left one behind — the cell reached **6.8 GB across 28 per-install directories**. The `@plugin` teardown now clears what a product declares it leaves (`ProductConfig.siteResidue` → `wp/residue.ts`), independently of whether the uninstall succeeded. Verified live: one scenario reclaimed **7 GB**, and a scenario that runs a real backup now leaves no archive behind. **One caveat, reported not failed:** the plugin creates `uploads/backwpup-restore` as `755 www-data`, which the ssh transport's user cannot unlink inside — it is ~24 KB and does not accumulate, so the sweep warns (with the fix in the message) rather than failing the run. Making it removable on a cell is an ownership change there, not a code change here. |
| **A fresh install that is not fresh** | **Two causes, both handled; one can still end in a fatal (V174).** (V46, V122) WP-CLI's activation does not fire `init`, so BackWPup's activation routine runs in whichever request reaches it first — in this suite the `@plugin` hook's own active-state check — and a second request racing it sends a never-onboarded site down the plugin's upgrade path, which deletes the onboarding flag. Nothing here can hold the second request off, so `finishActivation()` detects a lost race and redoes the install, up to three installs, each reported. (V174) The race can also crash the request that loses it, in the plugin's migration; the debug-log gate then fails the scenario, rightly, whatever the recovery does, and the retry policy absorbs it. (V47) The plugin's `wp_bwpup_backups` table can also outlive an uninstall under concurrency and then block the next install; 6E's database sweep (`ProductConfig.siteDbResidue`) removes it before every install. Both are worth reporting upstream: a plugin's activation should not be re-entrant, and its uninstall should be the last word on its own table. |
| **A removal cut short blocks every later install** | **Realised in AutoE2E; 6H.0.** The QA servers restart PHP-FPM or reboot several times a week (V231), and a plugin removal in flight then leaves a folder WordPress does not list but every install refuses (V229, V230). 6H.0 removes it in the `@plugin` cleanup, reports it each time, and makes removal under test fail on it. The kills themselves are the operator's to schedule. |
| **Staged files served by the web server** | **6J.** A guard written with the staging area covers every server that honours `.htaccess`, and fails closed wherever it cannot be applied (V143). nginx needs the include in the site's vhost — an operator change the suite can report on every run but never make — so until then the nginx cells keep serving the area, and pre-flight says so each time. |
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
