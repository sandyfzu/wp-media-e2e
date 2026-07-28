# Plugin Artifact Management Plan — resolve, build & verify the zips under test

> **Status:** Phases 1–3 implemented ✅ and **audited 2026-07-27** (findings fixed — see §6). Phase 4 (documentation) & Phase 5 (site staging & transfer) planned. Await explicit green light per phase.
> **Verified against:** APVM `develop` (npm `3.0.0`), pinned tag `cli/v3.0.0` (confirmed cut 2026-07-14 — see §1.1), `wp-media/backwpup-pro` `gulpfile.ts`, `wp-media/wp-rocket` `wp-rocket.php`, this repo's working tree, Playwright's worker-process contract (probed 2026-07-27 — see §6), and the transports' file-access behavior (verified 2026-07-16 — see §1.4).
> **Relation to the [modernization plan](e2e-modernization-plan.md):** this designs the artifact source that §4.5's "edition→package install map" and Phase 6's plugin-install hooks consume, and the pre-warm contract Phase 9's orchestrator calls. **Phase 5 here (site staging & transfer) is the mechanism those install hooks use to place a resolved zip onto ssh/docker targets, so it must land before modernization Phase 6.**

## TL;DR

Every run unit `(product × cell)` needs one or two plugin zips: the **plugin under test** and (for some tests) its **previous version to test against** (e.g. testing an update path). A new per-cell dependency project resolves both **per execution** — from `E2E_*` env overrides (a git ref **or** a local zip path, never both) or per-product defaults (`develop` / `tag:latest-stable`) — building refs with **`apvm-napi` 3.0.0** (git dependency; prebuilt binaries, no Rust) into a wiped `.artifacts/<product>/<cell>/<role>/` dir, APVM owning its cache (`~/.apvm/cache`, never overridden). BackWPup builds are version-required; the two roles get **distinct defaults** (`9.99.99` tested / `9.99.98` previous) so an update-path test always sees the previous artifact as *older*, without anyone having to pass a version by hand. A **static identity preflight** then unzips headers and asserts each zip is the exact expected plugin **and edition** (`wp-rocket/` ≠ `backwpup/` ≠ `backwpup-pro/`), checking every artifact before failing with one aggregated, actionable report. Steps consume paths via a registry/fixture; an orchestrator can pre-build everything with `apvm.warmCache()` using the **same request builder** (cache-key parity). Serial (cell-less) runs always use defaults, warning (never failing) if `E2E_*` overrides are set. The fixture yields a **local** path, but `wp` installs only from the *target's* filesystem, so a later phase adds a per-site **`.e2e_temp` staging area** and transport-agnostic **transfer helpers** (`common/wp`) that copy a resolved zip — or any test artifact — onto ssh/docker targets. Phases: ① request model + deps, ② resolution + preflight + wiring, ③ consumption + pre-warm, ④ documentation, ⑤ site staging + transfer.

---

## 1. Verified foundations

### 1.1 APVM — `apvm-napi` 3.0.0 (all claims from `develop`)

| Fact | Detail | Source |
| --- | --- | --- |
| Package | `apvm-napi` at the **repo root** of `wp-media/automation-plugin-version-manager`; `files: [index.js, index.d.ts, *.node]` | root `package.json` |
| Install | Plain git dep. Prebuilt `.node` **committed**: darwin-arm64/x64, linux-x64/arm64-gnu, win32-x64-msvc — **no musl**, no Rust, no postinstall. `engines: node >=22.22.1` (repo: ≥24.16 ✓). Caveat: git-dep install runs its `prepare: husky` (expected harmless; `HUSKY=0` if it trips — smoke-test in Phase 1) | `package.json`, repo root |
| Entry | `await Apvm.createWithTokenResolution()` — token from config → `GITHUB_TOKEN` → `GH_TOKEN` → `gh` CLI → gh config. Token **required** for `backwpup` (private source repo), recommended for rate limits otherwise. `hasToken()` / `tokenSource()` for diagnostics | napi README, `index.d.ts` |
| Build | `build({ project, gitRef, version?, variants?, outputDir, noCache? }, onProgress?) → JsBuildOutput` — `outputDir` must be absolute, created if missing | `index.d.ts` `BuildOptions` |
| Warm | `warmCache({ project, gitRef, version?, variants? }, onProgress?)` — **same pipeline as `build()`**, no `outputDir`/`noCache`: caches only, delivers nothing. A later identical `build()` is a cache-hit copy (`fromCache: true`) | `index.d.ts`, napi README |
| Refs | Bare (`develop`, `abc1234`, `123`→PR) or explicit `pr:`/`branch:`/`tag:`/`commit:`/`release:`. Keywords: `tag:latest-stable`, `tag:previous-stable`, `tag:latest`, `tag:previous-latest` and the same four for `release:` (GitHub Releases download — handled by plain `build()` when passed as `gitRef`) | `index.d.ts` `gitRef` docs |
| `version` | **backwpup: required** on build-type refs. **wp-rocket/imagify: optional** — auto-detected when omitted; when provided, **rewritten into the source** (reported via `versionOverride`). `release:*` refs derive the version from the release tag (no param) | `index.d.ts`, release methods |
| Output | `JsBuildOutput { result: { artifacts[{ variantId?, path, filename, size, origin: "cache"\|"built"\|"downloaded" }], version, variantsBuilt }, resolvedRef, commit, commitShort, description, fromCache, versionOverride? }` | `index.d.ts` |
| Cache | Default `~/.apvm/cache`; `APVM_CACHE_DIR` env overrides every instance — **we never set it**. Keyed by resolved commit+version: keyword refs re-resolve, then hit the cached build | napi README; verified at v2.1.0 |
| Errors | Promise rejections (typed: `ProjectNotFound`, `PrivateRepoNoToken`, `ReleaseNotFound`, `NoMatchingReleaseAssets`, …) — never process crashes | napi README |
| Progress | `onProgress(err, event)` discriminated union: `reference_resolved`, `phase_started/completed`, `step_*`, `command_output`, `warning`, `build_succeeded`, `build_failed(reason)` | `index.d.ts` |

Pin: `"apvm-napi": "github:wp-media/automation-plugin-version-manager#cli/v3.0.0"` — tag confirmed present via `gh api repos/wp-media/automation-plugin-version-manager/tags` on 2026-07-14 (follows the established `cli/vX.Y.Z` pattern, e.g. `cli/v2.1.0`).

### 1.2 Plugin identity matrix (verified from the build definitions — the preflight's expectations)

| Product / edition | APVM `project` + `variants` | Zip filename | Top-level dir (= slug) | Main file | `Plugin Name:` header |
| --- | --- | --- | --- | --- | --- |
| WP Rocket | `wp-rocket` (no variants) | `wp-rocket-{version}.zip` | `wp-rocket/` | `wp-rocket.php` | `WP Rocket` |
| BackWPup Free | `backwpup` + `["free"]` | `backwpup-{version}-{commit8}.zip` | `backwpup/` | `backwpup.php` | `BackWPup` (rewritten from `BackWPup Pro` by the `free` gulp task) |
| BackWPup Pro | `backwpup` + `["pro-en"]` | `backwpup-pro-en-{version}-{commit8}.zip` | `backwpup-pro/` | `backwpup.php` | `BackWPup Pro` |
| Imagify (future) | `imagify` (no variants) | single zip | *verify when wired* | *verify* | *verify* |

Sources: APVM `crates/core/src/build/plugins/{wpr,bwu}.rs` (filenames, variants, staging dir named after the plugin); `backwpup-pro/gulpfile.ts` (`compressPackage` renames `dist/backwpup` → `dist/<packageName>` and zips with `base: dist` → the top-level dir **is** `backwpup` or `backwpup-pro`; the `free` task rewrites the header). BackWPup source repo is `wp-media/backwpup-pro` (APVM `registry.rs`) — hence the token requirement. `pro-de` exists but our cells are English → `pro-en` (constant in the manifest, changeable per product if ever needed). **Slug alone distinguishes product *and* edition in one check**; the header check is a cheap second witness. Phase 2 acceptance re-validates this table against real artifacts.

### 1.3 Integration points in this repo

- **Config factory** ([project.ts](../../src/common/config/project.ts)): per cell emits `setup:<cell>` → `<cell>` (BDD, `dependencies`). The artifacts project becomes a **sibling dependency**.
- **Registry idiom** ([metadata.ts](../../src/common/config/metadata.ts)): non-secret routing `{product, cell, edition}` in project metadata; heavier state via an in-process registry populated at config build (re-executed in every worker process). The artifacts manifest rides the same pattern.
- **Preflight idiom** ([preflight.ts](../../src/common/setup/preflight.ts)): per-check `CheckResult`s, check everything, then one formatted, actionable aggregate error. The identity preflight mirrors it.
- **Run context** ([run-context.ts](../../src/common/config/run-context.ts)): `dirs(product, cell)` namespaces every artifact path; gains an `artifacts` entry (ephemeral family). `selectedCells()` distinguishes cell runs from serial runs — but **only in the runner**: it parses `process.argv`, which a Playwright worker never receives. Worker-side code must ask `isCellTargeted()`, which reads the selection the runner published into the environment. Assuming otherwise is what §6.1 fixed.
- **Unit tests**: `src/common/**/*.spec.ts` are auto-picked by `playwright.unit.config.ts`.

### 1.4 Transport file-access facts (verified 2026-07-16 — the transfer layer's foundation, Phase 5)

| Fact | Detail | Source |
| --- | --- | --- |
| Exec cwd = WP root | The exec layer runs **every** command with cwd = the WP root on all transports: `transport.rootDir` for `local`/`ssh`; the container **WORKDIR** for `docker` (`wordpress:cli-php8.3` & `wordpress:php8.3-*` WORKDIR = `/var/www/html`; `dockerArgv` passes no `-w`). So a **relative** path (`.e2e_temp/plugins/x.zip`) resolves to the WP root uniformly — `mkdir -p`, `rm -rf`, and `wp plugin install <rel>` all work via `exec`/`wpCli` on every transport. | `exec.ts`; `log.ts` already relies on it; `docker image inspect` |
| No transfer today | `exec.ts` only *runs* commands; nothing places a **local** file on the target. So `wp plugin install <localPath>` fails on ssh/docker — the remote `wp` can't see a runner path (the Phase-3 finding). | Phase 3 verification |
| Per-transport copy primitive | `local`: same fs → `node:fs` `cp`. `docker`: `docker cp <localAbs> <container>:<absTarget>` (a `docker` sub-command, **not** `docker exec`). `ssh`: node-ssh `putFile(localAbs, remoteAbs)` (verified working; does **not** create parent dirs → `mkdir -p` first). node-ssh also exposes `putDirectory`/`mkdir`/`getFile`. | `node-ssh` `index.d.ts`; Phase 3 |
| Absolute WP root | Needed only for the copy *target* (docker cp / putFile ignore exec cwd): `transport.rootDir` for local/ssh; docker resolves at runtime via `exec(t,"pwd",[])` (= WORKDIR = `/var/www/html`) — no hardcode, matches `log.ts`'s assumption. | verified |
| Write access | Staging at the WP root needs the transport's user to have **write** permission there. Verified on the real ssh cell: docroot `drwxrwxrwx` owned by `www-data`, login user `ubuntu` created/removed `.e2e_temp` fine; files land world-readable (`0664`) so a differently-owned `wp` (docker `www-data` 33:33) can still read them. **Not universally guaranteed** on stricter hosts → the staging root must be overridable (§2.9). | ssh probe 2026-07-16 |
| Web exposure | The WP root **is** the web docroot here (nginx serves the volume; Apache mod_php). So `<WP root>/.e2e_temp/…` is potentially HTTP-reachable — a mild exposure on QA sites, occasionally a *feature* (an artifact a plugin must fetch over HTTP). Mitigate: wipe after the run + optional deny `.htaccess`/`index.html` (Apache); stage outside the docroot via the override when it matters. | docker-compose; verified |

---

## 2. Design

### 2.1 Roles

Each product's manifest declares up to two **roles** — the env vars, on-disk dirs, and fixtures all use these two words:

- **`plugin`** — the artifact under test. Every product has it.
- **`previous`** — the artifact some tests compare against (e.g. upgrade/rollback). WP Rocket has it from day one; **BackWPup deliberately omits it for now** (§5).

### 2.2 Environment variables

Recommended names (decision: **B1**):

| Var | Meaning | Applies to |
| --- | --- | --- |
| `E2E_PLUGIN_REF` | APVM ref to **build** the plugin under test (any §1.1 ref format, passed through verbatim) | ref path |
| `E2E_PLUGIN_ZIP` | Path to a **prebuilt** zip of the plugin under test (absolute, or repo-root-relative) | zip path |
| `E2E_PREVIOUS_REF` | APVM ref to build the previous-version plugin | ref path |
| `E2E_PREVIOUS_ZIP` | Path to a prebuilt previous-version zip | zip path |
| `E2E_PLUGIN_VERSION` | Version handed to APVM when **building** the plugin under test | ref path only |
| `E2E_PREVIOUS_VERSION` | Version handed to APVM when **building** the previous-version plugin | ref path only |

Naming rationale (decision **B2**): `E2E_` scopes them to this project without colliding with generic names (`PLUGIN_REF`) or CI-reserved ones; the role words match how we talk about the artifacts ("the plugin being tested", "what we compare against"). Alternatives considered and rejected:

- `E2E_CANDIDATE_*` / `E2E_BASELINE_*` — symmetric role vocabulary (canary analysis), but "baseline" already names the legacy `wp-rocket-e2e` repo in this migration's vocabulary, and it's longer without being clearer.
- `E2E_TARGET_*` / `E2E_REFERENCE_*` — "target" is overloaded (target site/env); `E2E_REFERENCE_REF` stutters.
- Baseline's `new_release` / `previous_stable` — inaccurate: the tested artifact is usually `develop` (not a release) and the comparison ref can be anything (not necessarily previous, nor stable).

Rules (all validated in one place, `request.ts`, with errors that name the offending vars):

1. **Ref XOR zip per role.** Both `E2E_PLUGIN_REF` and `E2E_PLUGIN_ZIP` set → fail fast: *"Both E2E_PLUGIN_REF and E2E_PLUGIN_ZIP are set. They are mutually exclusive and neither wins by default — unset one."* Same for the `PREVIOUS` pair. Cross-role mixes are fine (e.g. ref for `plugin`, zip for `previous`).
2. **Precedence.** Env override > manifest default. No env → defaults, always.
3. **Serial runs use defaults, always.** No `--project=<cell>` (or `*`/unknown) + any applicable `E2E_*` var set → **warn and use defaults**, never fatal. Overrides can't apply without a selected cell, so they're dropped and named in a warning: a stray or shared `E2E_*` var must not abort a broad serial run, but the operator still sees it had no effect and can re-run with `--project=<cell>` to apply it. (Earlier design failed fast here; softened to a warning so serial "run everything on defaults" is robust to leftover env.)
4. **Version — per role, BackWPup only.** WP Rocket/Imagify never have a default version (embedded in source); an env value, if set, is passed through and rewrites the source (reported via `versionOverride`). BackWPup **requires** a version on every build-type ref, so each role gets its own default: `plugin` → `E2E_PLUGIN_VERSION` else **`9.99.99`**; `previous` → `E2E_PREVIOUS_VERSION` else **`9.99.98`** — one patch below the tested default by design, so an update/rollback scenario always sees the `previous` artifact as the *older* version with zero manual version-pinning. `release:*` refs never send a version on either role (derived from the release tag) — the default is skipped entirely, not just omitted. Setting a role's version var together with that same role's `_ZIP` → **warn + ignore** (nothing is built, so the version has nowhere to go).
5. **BackWPup previous envs** (`E2E_PREVIOUS_REF`/`E2E_PREVIOUS_ZIP`/`E2E_PREVIOUS_VERSION` on a product whose manifest has no `previous` role) → **warn + ignore**, pointing at §5. (Rationale: cells of several products may share one shell/CI env; erroring would block legitimate WP Rocket usage of the same vars.)
6. **Zip validation.** Path must exist, be a file, end in `.zip` — checked at resolution start, actionable error otherwise.

All six land in `.env.example` (commented out) and the [configuration guide](../guides/configuration.md) table.

### 2.3 Requests & defaults

A pure `buildRequests(product, cell)` maps manifest + edition + envs to per-role **requests** — a discriminated union `{ kind: "build", apvm: BuildOptions-sans-outputDir } | { kind: "zip", path }`. It is the **single source of truth** used by the run-time resolver *and* the pre-warmer, which is what guarantees cache-key parity (§2.7). Manifest per product (new `artifacts` field on `ProductConfig`, typed in `config/types.ts`, values in `<product>.config.ts`):

| Product | `plugin` default | `previous` default | Version policy | Edition → variant |
| --- | --- | --- | --- | --- |
| wp-rocket | `develop` | `tag:latest-stable` | embedded; pass env when set | — |
| backwpup | `develop` | **none for now** → `release:latest-stable` when comparison tests land (§5) | required on builds — `plugin`: env else `9.99.99`; `previous`: env else `9.99.98`; none for `release:*` | `free` → `free`, `pro` → `pro-en` |
| imagify (future) | `develop` | `tag:latest-stable` | embedded; pass env when set | — |

Edition comes from the cell (already enforced all-or-none by the sites loader); an edition-ful product's request builder throws if it's absent (programming error, not user input). The manifest also carries the §1.2 identity expectations per edition (`slug`, `mainFile`, `pluginName`).

**Edition vs. variant (distinct namespaces).** Our **edition** (`free`/`pro`) is the binary, language-blind *behavioral* tier that drives scenarios and POM; APVM's **variant** (`free`/`pro-de`/`pro-en`) is the exact buildable package. The manifest maps each edition to the **one** variant it builds — a projection, not identity (`pro` → `pro-en`; `free` → `free` merely coincides; `pro-de` is untested). We keep both words on purpose: they name different things, APVM has no "edition" concept, and the binary free/pro axis is unavoidable for `@free`/`@pro` filtering. `EditionData.variant` is therefore a **single** id (each role resolves to exactly one zip, §2.5), wrapped into APVM's `variants` array at request time.

**Why `9.99.99`/`9.99.98`, not equal defaults:** BackWPup update/rollback scenarios need `previous` to be *older* than `plugin` without anyone hand-picking versions. One patch below is the smallest guaranteed-older delta under semver comparison, so the default pair alone makes an update-path test meaningful — pass `E2E_PREVIOUS_VERSION` explicitly to test a specific real upgrade instead.

### 2.4 Directories & lifecycle

```text
.artifacts/<product>/<cell>/            ← gitignored; EPHEMERAL (wiped at each resolution)
├── plugin/<one>.zip                    ← role subdirs: same-filename collisions impossible,
├── previous/<one>.zip                     role derivable from path alone
└── resolution.json                     ← this execution's map (see below)
```

- New `artifacts` entry in `dirs()` — root overridable as `ARTIFACTS_ROOT` for symmetry with the other `*_ROOT`s, `<product>/<cell>` always appended. Serial runs need no special bucket: every cell project still resolves into **its own** dir.
- **Wipe → resolve → verify** on every execution: refs re-build (cache makes it a copy — zips are ~15 MB, acceptable), provided zips are **copied in** (uniform layout; immune to the source file moving mid-run). No cross-execution reuse decisions on our side — **APVM's cache is the only reuse layer** (`fromCache` on the output says which). Because the wipe is unconditional and runs first, an `E2E_*_ZIP` pointing **inside** the cell dir is rejected **before** anything is deleted (§2.8 case 23) — otherwise the operator's own file would be destroyed and then reported missing.
- **The map.** Resolution runs **exactly once per (execution × cell)** — in the artifacts project (§2.6) — and memoizes in-process. Playwright workers are separate processes, so the resolver also writes `resolution.json` (`runId` + role → `{ zipFilename, source, ref?, commit?, version?, origin, resolvedAt }`; no secrets). Workers read it lazily and memoize. It lives inside the wiped dir, so it can never describe a previous execution's zips; it also gives later "version-aware" tests their build metadata for free. The `runId` stamp is what makes the one remaining way to read a *previous* execution's map — a `--no-deps` invocation (§2.8 case 16) — visible rather than silent: the consumer warns when it differs from the current run's. Workers never resolve or write — re-running APVM per worker would race on the wipe and duplicate copies.

### 2.5 Identity preflight

**Decision: static zip inspection**, not install-based probing. Rationale: it needs no WordPress (runs even before transports are checked), takes milliseconds, can't mutate any site, works identically for built and provided zips, and asserts the exact facts we verified in §1.2. Install-based verification would prove installability — but the first real install step of the suite proves that anyway minutes later with better context; and an install loop (uninstall → install → list → uninstall) per artifact is slow, serialized, and adds failure modes of its own. If a corrupt-zip class of failure ever shows up in practice, a deeper check can be added behind the same report (§5).

Checks per resolved artifact (via `adm-zip` — read-only: central directory + one entry; new devDependency, `yauzl` is the fallback candidate if it disappoints):

1. Zip parses and has a **single top-level directory**, ignoring a macOS `__MACOSX/` sidecar — WordPress's own unzipper skips it, so an archive Finder produced (a realistic `E2E_*_ZIP`) installs fine and must verify fine.
2. That directory equals the expected **slug** — one check that pins both product and edition (`wp-rocket` / `backwpup` / `backwpup-pro`).
3. `<slug>/<mainFile>` exists; its header block contains `Plugin Name:` whose value **equals** the expectation exactly — equality, not prefix, so `BackWPup` can never pass for `BackWPup Pro`. The value is cleaned exactly as core's `_cleanup_header_comment()` does (drop a trailing comment/PHP terminator), so equality can never fail on a value WordPress itself reads correctly.
4. Informational (reported, not asserted): header `Version:`, zip filename, source (`default-ref` / `env-ref` / `env-zip`), resolved commit, `origin` (`built`/`cache`/`downloaded`/`copied`).

*(An earlier draft also asserted "the role dir holds exactly one `.zip`". Dropped: the real invariant — **one artifact per role** — is enforced upstream in `resolve.ts`'s `pickArtifact`, and a `release:*` ref legitimately delivers every variant's zip into the dir while the variant filter selects ours, so the directory-level count would be wrong rather than protective.)*

**Aggregation** (the user-visible contract): every role is resolved *and* verified even when an earlier one fails — resolution errors and identity failures are collected per role, then a single formatted report (same `CheckResult` + `styleText` style as [preflight.ts](../../src/common/setup/preflight.ts)) lists each artifact with ✓/✗ per check, expected-vs-found on mismatch, and a hint (e.g. wrong-edition zip on a `pro` cell → "this cell is `pro`; pass a `backwpup-pro` zip or drop the override"). One `Error` at the end fails the setup project → Playwright skips the dependent BDD project. On success the same summary is one concise line per role, and the JSON summary is attached to the test (`testInfo.attach`) so it lands in HTML/Allure reports.

### 2.6 Run wiring

The factory emits a third per-cell project, mirroring auth:

```text
artifacts:<cell> ─┐                     artifacts:<cell> — plain project, testMatch artifacts.setup.ts,
setup:<cell>     ─┴─→ <cell> (BDD)      routing metadata {product, cell, edition?}; SIBLING of setup:<cell>
                                        (independent: either failure alone skips the BDD project)
```

- `artifacts.setup.ts` (one test, generous timeout — cold builds run composer/npm, allow ~20 min): read routing → `buildRequests()` → wipe dir → resolve roles **sequentially** (readable logs; no concurrent-build assumptions on APVM workspaces) → verify all → write `resolution.json` → attach summary. APVM progress maps to concise console lines (`phase_started`, `warning`, `build_failed`); `command_output` stays quiet except on failure, where the reason + last lines join the error.
- One `Apvm` instance per process via `createWithTokenResolution()`; a missing token on a `backwpup` build is caught early with the fix in the message (`GITHUB_TOKEN` / `gh auth login`).
- **Placeholder-only cells skip** the artifacts project with the same message pattern as auth — a fresh checkout's `npm run test` smoke must not clone/build anything (and must not demand a token).
- **Serial (cell-less) runs**: every cell's `artifacts:<cell>` runs serially with defaults (§2.2 rule 3 warns about and ignores any overrides). After the first build per unique request, the rest are cache copies.
- **How "was this cell selected?" reaches the setup.** It runs in a Playwright **worker**, which is forked *without* the CLI argv and rebuilds its own copy of the config — so neither `process.argv` nor project `metadata` carries the runner's `--project`. The selection rides the environment instead (`seedSelectedCells()` at config build → `selectedCells()` anywhere), the same channel `RUN_ID` uses. Getting this wrong silently disables every override, which is exactly what the audit found (§6). The setup asks `isCellTargeted(cell, projectName)`, which wraps that lookup and also counts the operator naming **this project** (`--project=artifacts:<cell>`) — the natural way to resolve a cell's zips without running its scenarios.
- **Consumption**: a `pluginArtifact(role)` helper + fixture in [fixtures.ts](../../src/common/fixtures.ts) returns `{ zipPath, source, commit?, version?, origin }` from the memo/`resolution.json`. Missing file → actionable error ("the artifacts setup didn't run for this cell in this execution — run via `--project=<cell>` without `--no-deps`"). Requesting `previous` on a product without the role → error pointing at §5 — so a future comparison test **cannot silently run unverified**. Phase 6 (modernization plan) install hooks consume this instead of §4.5's static zip map. **The fixture yields a *local* path**, which only a `local` transport's `wp` can read directly; for **ssh/docker** targets the install hook first copies the zip onto the site via the Phase 5 transfer layer (§2.9, §1.4).

### 2.7 Orchestrator pre-warming

Purpose: N cells wanting the same uncached request must not build it N times, and build minutes shouldn't count against test wall-time. `warmCache()` warms without delivering; the later per-cell `build()` is a copy.

- `warmArtifacts(units)` in `src/common/artifacts/warm.ts`: for each `(product, cell)` run `buildRequests()` (same code path — **parity invariant**: warm and build must produce byte-identical `{project, gitRef, version, variants}`, or the warm is wasted), skip `zip`-kind requests, **dedupe** by that tuple, then `apvm.warmCache(request)` **serially**. Failures are collected per request and reported together; the orchestrator decides whether to skip dependent cells or let their own resolution retry/fail visibly.
- Exposed now as `npm run artifacts:warm [-- --product=<p>] [--cell=<c>]` (root `warm-artifacts.ts`, tsx, like `healthcheck.ts`) — useful standalone (CI pre-step, local prep) long before the orchestrator (modernization Phase 9) exists; the orchestrator later imports the same module before spawning cells.
- Keyword-ref nuance (accepted): `tag:latest-stable` re-resolves at both warm and run time; a release cut in between means the run builds fresh — correct behavior, just slower for that run.

### 2.8 Edge cases & failure modes

| # | Case | Behavior |
| --- | --- | --- |
| 1 | Ref + zip set for one role | Fail fast; error names both vars, states no default fallback (§2.2.1) |
| 2 | Zip path missing / not a file / not `.zip` | Fail fast with the path and which var supplied it |
| 3 | Serial run + any applicable `E2E_*` var | Warn + ignore; plan from defaults. Never fatal (§2.2 rule 3) |
| 4 | Previous envs (`E2E_PREVIOUS_REF`/`ZIP`/`E2E_PREVIOUS_VERSION`) for backwpup (no role) | Warn + ignore, pointer to §5 |
| 5 | `E2E_PLUGIN_VERSION` + `E2E_PLUGIN_ZIP`, or `E2E_PREVIOUS_VERSION` + `E2E_PREVIOUS_ZIP` | Warn + ignore (nothing is built) |
| 6 | `E2E_PLUGIN_VERSION`/`E2E_PREVIOUS_VERSION` + a wp-rocket or imagify ref | No default exists (embedded version), but the value is still passed through — APVM rewrites the source version (`versionOverride` reported in the summary) |
| 6b | `E2E_PREVIOUS_VERSION` set, but `previous`'s resolved ref is `release:*` | Version ignored (warn), not sent — release version always comes from the release tag |
| 7 | backwpup build without token | Early actionable error (before any clone attempt) |
| 8 | Wrong slug / name / edition; no single top-level dir; unparseable zip | Identity ✗ with expected-vs-found; aggregated (§2.5) |
| 9 | `plugin` resolution fails | `previous` still resolved + verified; one aggregate report (§2.5) |
| 10 | Placeholder-only cell | Artifacts project skips (§2.6) |
| 11 | APVM build failure | Error carries `build_failed` reason + last command output lines |
| 12 | `plugin` and `previous` resolve to the identical request | Allowed, but warned (comparison would be degenerate) |
| 13 | Two cells running concurrently (orchestrator) | Distinct `.artifacts/<product>/<cell>/` dirs; APVM cache is cross-process safe; duplicate concurrent builds of one request are the waste pre-warming exists to remove (§2.7) |
| 14 | Relative `E2E_*_ZIP` | Resolved against the repo root (documented; absolute recommended). Must resolve correctly, avoid using process cwd |
| 15 | Edition missing on an edition-ful product | Sites loader already fails all-or-none; request builder re-asserts (programming error) |
| 16 | `--no-deps` BDD invocation | Fixture reads whatever the last resolution wrote, **warning** that it came from a different `runId` (never silent); errors if there is none. Documented as unsupported for artifact-consuming scenarios, but kept non-fatal so the fast edit-run loop still works |
| 17 | ssh/docker install of a locally-resolved zip | Zip staged to `<WP root>/.e2e_temp/plugins/` first, then `wp plugin install <target>` (§2.9); a `local` transport can install the fixture path directly |
| 18 | Login user can't write the WP root | Actionable error naming the transport + path; set `E2E_SITE_STAGING_DIR` to a writable dir (or one outside the docroot). Verified writable on the current ssh cell (§1.4) |
| 19 | Docker WP root unknown (no `rootDir` in config) | Resolved at runtime via `exec(t,"pwd",[])` (= container WORKDIR = `/var/www/html`); an optional `stagingDir` override skips the round-trip |
| 20 | `.e2e_temp` under the web docroot | Documented exposure on QA sites (sometimes a feature — HTTP-fetchable artifacts); wiped in teardown + optional deny `.htaccess`; stage outside the docroot via the override (§1.4) |
| 21 | Stale `.e2e_temp` from a crashed run | Wipe-before-stage (overwrite) + teardown `cleanSiteStaging` make staging idempotent (§2.9) |
| 22 | One host shared by concurrently-running bound sites | Unsupported by the shared `.e2e_temp` (worker↔site is 1:1 within an invocation, so it can't happen there); namespace by `RUN_ID` if an orchestrator ever overlaps pools on a host (deferred, §2.9) |
| 23 | `E2E_*_ZIP` points inside the cell's `.artifacts/<product>/<cell>/` | **Fail fast before the wipe**, naming the var, the path and the fix. A configuration error like case 1, not an artifact failure — and the only ordering that keeps the operator's file intact (§2.4) |
| 24 | Whitespace-padded `E2E_*` value (`" develop "`, a trailing space in `.env`/CI YAML) | Trimmed at the reader, so it never reaches APVM as part of a ref or `fs` as part of a path |
| 25 | Consumed zip deleted after resolution | Fixture throws naming the path, instead of deferring an invisible cause to `wp plugin install` |
| 26 | Builder output/errors containing a token or an authenticated remote URL | Redacted at the APVM boundary before any of it is logged or embedded in the error a report keeps |

### 2.9 Site staging area & artifact transfer (Phase 5 — the ssh/docker install path)

**Problem.** The `pluginArtifact` fixture (§2.6) yields a **local** path under `.artifacts/…`. But `wp plugin install` — and every other WP-CLI/site step that reads a file (`wp import`, `wp db import`, `wp theme install`, uploading media, dropping an mu-plugin) — runs **on the site**, so for `ssh`/`docker` targets the artifact must first be **copied onto the site** (verified §1.4); only a `local` transport shares the filesystem. This is the Phase-3 finding, made first-class.

**Design: a per-site `.e2e_temp/` staging area.** One directory at the site's WP root holds every artifact a run needs on the target, organized by **category** — general by design (dev's ask), not plugin-specific:

```text
<WP root>/.e2e_temp/            ← per-site staging area — lives on the SITE, not the repo
├── plugins/<name>.zip          ← plugin zips  → wp plugin install
├── imports/<name>.xml          ← future: WXR  → wp import
├── db/<name>.sql               ← future: dump → wp db import
└── <category>/<name>           ← any artifact a test needs on the target
```

- **Location = the WP root** (§1.4: it's the exec cwd, so relative paths just work, and it's where web-reachable artifacts must live). **Dir name `.e2e_temp`** (dev's choice). **Overridable** via `E2E_SITE_STAGING_DIR` (env) or an optional per-transport `stagingDir` — for hosts where the login user can't write the docroot, or to place the area outside the docroot.
- **First category is `plugins/`**; the area is open-ended so any future artifact type reuses the same transfer + cleanup rather than growing a bespoke path each time.

**Helpers — `src/common/wp/staging.ts` (transport-agnostic, the "setup" helpers dev asked for):**

- `stageArtifact(transport, localPath, { category, as? }) → Promise<string>` — `mkdir -p .e2e_temp/<category>` (via `exec`, so it's uniform across transports), copy the local file in (via the transport copy primitive below), and return the **absolute target path** for the caller to hand to `wp`. Idempotent (overwrites). `as?` renames on the target (default: the source basename).
- `cleanSiteStaging(transport, category?) → Promise<void>` — `rm -rf` the whole area (or one category) via `exec`.
- `siteStagingDir(transport) → Promise<string>` (absolute; resolves the WP root per §1.4) and a pure `stagingRelPath(category, filename)` builder (the pure one is unit-tested without any transport).

**Transport copy primitive** lives at the transport boundary (`src/common/wp/exec.ts`, which already owns the cached SSH connection and the per-mode dispatch): `copyIntoTarget(transport, localAbs, targetAbs) → Promise<void>` → `node:fs` `cp` (local) / `docker cp` (docker) / node-ssh `putFile` reusing the cached connection (ssh). Placing it there avoids a second SSH connection and keeps `staging.ts` to pure-ish path/category/lifecycle logic. (Alternative: a standalone `transfer.ts` importing an exported `sshConnection` — rejected as leakier.)

**Plugin integration (thin):** `stageAndInstallPlugin(transport, localZip, opts)` = `stageArtifact(category:"plugins")` → `installPlugin(target, opts)`. The modernization plan's **Phase 6 install hooks** call this (or `stageArtifact` directly for non-plugin artifacts). On `local`, staging is a cheap same-fs copy for a uniform on-site layout (callers may instead install the fixture path directly).

**Lifecycle & safety:**

- **Idempotent** — wipe-before-stage per file (overwrite); `cleanSiteStaging` wipes the whole area in **worker teardown** (wired by modernization Phase 6, beside `disposeConnections`), so a run leaves the site clean. Wipe-before-use also neutralizes stale residue from a crashed prior run.
- **Concurrency** — worker↔site is 1:1 within an invocation (`boundSite = pool[parallelIndex]`, one cell per invocation), so no two workers write one site's `.e2e_temp` at once. A shared `.e2e_temp` is unsafe only if an orchestrator overlaps pools on one physical host; namespace by `RUN_ID` then (deferred).
- **Best-effort cleanup** never masks a test result (same rule as report attachments); **transfer failures throw** with the transport, path, and the override to set.

---

## 3. File & directory structure

```text
src/common/artifacts/                   ← NEW: the whole capability, product-agnostic
├── types.ts                            # ArtifactRole, ArtifactRequest, ResolvedArtifact, identity + manifest types
├── request.ts                          # env reading/validation + buildRequests() (pure — the parity keystone)
├── request.spec.ts                     # env matrix: precedence, XOR, serial defaults, version policy, variants, warns
├── apvm.ts                             # lazy Apvm singleton, token diagnostics, progress→console mapping
├── resolve.ts                          # wipe → build/copy per role → resolution.json + in-process memo
├── registry.ts                         # per-process manifest/resolution registries (metadata.ts idiom)
├── verify.ts                           # adm-zip identity checks + CheckResult aggregation + report formatting
├── verify.spec.ts                      # fixture zips built in-test: right/wrong slug, name, edition, malformed
├── warm.ts                             # dedupe + serial warmCache loop (CLI now, orchestrator later)
├── warm.spec.ts                        # dedupe/skip-zip/failure-collection logic
└── artifacts.setup.ts                  # the artifacts:<cell> spec (resolve + verify + attach summary)

warm-artifacts.ts                       ← NEW root tsx entry (npm run artifacts:warm), like healthcheck.ts
.artifacts/                             ← NEW gitignored output tree (§2.4)

src/common/wp/                          ← Phase 5: transport-agnostic site staging & transfer
├── staging.ts                          # .e2e_temp staging area: stageArtifact / cleanSiteStaging / siteStagingDir / pure path builder / stageAndInstallPlugin
└── staging.spec.ts                     # pure path/category logic + local-transport copy (docker/ssh integration-verified)
<WP root>/.e2e_temp/                     ← Phase 5: per-site staging area, on the TARGET (not the repo); wiped in teardown (§2.9)

Modified: src/common/config/types.ts    (+ ProductConfig.artifacts manifest; Phase 5: optional DockerTransport.rootDir / per-transport stagingDir)
          src/projects/*/config/*.config.ts (+ per-product manifests incl. §1.2 expectations)
          src/common/config/project.ts  (+ artifacts:<cell> project & dependencies)
          src/common/config/run-context.ts (+ artifacts dir / ARTIFACTS_ROOT)
          src/common/fixtures.ts        (+ pluginArtifact fixture)
          src/common/wp/exec.ts         (Phase 5: + copyIntoTarget transport copy primitive — fs.cp / docker cp / node-ssh putFile)
          .gitignore  .env.example  package.json (deps + script; Phase 5: E2E_SITE_STAGING_DIR in .env.example)
          CLAUDE.md  docs/guides/configuration.md  docs/architecture/{execution-model,wordpress-automation}.md
```

## 4. Implementation phases

**Phase 1 — Dependencies & request model (pure logic, no behavior change). ✅**
Add `apvm-napi` (pinned per §1.1 — smoke-test the git-dep install, incl. the husky-prepare caveat) and `adm-zip` (+types). Land `artifacts/types.ts`, `request.ts` (+spec), `registry.ts`, the `ProductConfig.artifacts` type and both product manifests with the §1.2 identity expectations; document the six vars in `.env.example` + configuration.md. Leave the **§5 MUST comment** on backwpup's absent `previous` role.
*Acceptance:* `typecheck`/`lint`/`format`/`test:unit` green; the §2.2 rule matrix and §2.3 defaults are unit-proven — incl. edition→variants, the `release:*`-no-version rule, and BackWPup's independent per-role version defaults (`9.99.99` plugin / `9.99.98` previous, each overridable by its own env var); `node -e "import('apvm-napi')"` loads the prebuilt binary on darwin-arm64 and linux-x64.
*Implemented:* `apvm-napi` pinned to `cli/v3.0.0`, installed, and load-smoke-tested on darwin-arm64 (its `husky` prepare is already blocked by the repo's `allow-scripts` gate — no `HUSKY=0` needed). Modules under `src/common/artifacts/`: `types.ts`; `manifest.ts` (**added** beyond the §3 sketch — pure edition/role accessors, split from `request.ts` for separation + isolated tests); `request.ts` (`readArtifactEnv` + pure `buildArtifactPlan`, returning requests **plus warnings** so the planner stays pure); `registry.ts`. `ProductConfig.artifacts` is **required** (only two constructors, both updated) so no product can ship without a build source. **Two deviations:** `adm-zip` is **deferred to Phase 2** (its only consumer is `verify.ts`; adding it now would be an unused dependency); `manifest.ts` was added. 35 new unit tests across the three specs (79 total suite); the type-only `config↔artifacts` reference compiles clean (erased under `verbatimModuleSyntax`). Verified end-to-end 2026-07-14.

**Phase 2 — Resolution, identity preflight & wiring.**
Land `apvm.ts`, `resolve.ts`, `verify.ts` (+spec), `artifacts.setup.ts`; factory emits `artifacts:<cell>` (sibling of `setup:<cell>`, placeholder-skip); `run-context` gains the artifacts dir; gitignore `.artifacts/`.
*Acceptance:* against a real cell — default run builds/copies and preflight passes with the summary attached; `E2E_PLUGIN_ZIP` with a **wrong-edition** and a **wrong-product** zip each fail with the aggregated expected-vs-found report while the other role still resolves; a ref+zip conflict in a cell run fails fast, while a serial+override warns and falls back to defaults (both with the specified messages); identity matrix (§1.2) re-validated against freshly built `wp-rocket`, `backwpup` free and `pro-en` artifacts; fresh checkout `npm run test` (placeholders) is unaffected and token-free.
*Implemented:* `apvm.ts` (lazy `Apvm` singleton via `createWithTokenResolution`; token guard for the private `backwpup` source before any clone; progress→console reporter buffering command output for failure context), `resolve.ts` (wipe → per-role build/copy → `resolution.json`; per-role failures captured as values, never thrown, so one role's failure never stops another), `verify.ts` (+spec; `adm-zip` static identity checks reading the header from the **actual** top-level dir so the name check still runs on a slug mismatch; `CheckResult` aggregation + report/summary formatting mirroring `preflight.ts`), `artifacts.setup.ts` (thin orchestration: placeholder-skip, serial detection, resolve → verify → attach JSON summary → persist — the serial check was `selectedCells()` here and is now `isCellTargeted()`, see §6.1). Factory emits `artifacts:<cell>` as a sibling of `setup:<cell>`; the BDD project depends on **both** (either skip/failure alone gates it — a skipped dependency does not block the BDD project). `run-context` gained `REPO_ROOT` (cwd-independent absolutization) + the `artifacts` dir (`ARTIFACTS_ROOT`); `.artifacts/` gitignored. **Additions beyond the §3 sketch:** `adm-zip` **0.6.0** (Phase 1's deferral; 0.6.0 bundles its own TS types so **no `@types/adm-zip`**, and patches CVE-2026-39244 — its `extractEntryTo`/Node-12 breaking changes don't affect our read-only usage); a per-product **manifest registry** (`registerManifest`/`getManifest` in `registry.ts`) so the setup reads the manifest by product name without a `common→projects` import (metadata.ts idiom); a shared `errorMessage` boundary util in `guards.ts`; the §2.8 **case-12** degenerate-comparison warning in the pure planner (`request.ts`, +tests). **Verified end-to-end 2026-07-14:** freshly BUILT `wp-rocket` (`develop`+`tag:latest-stable` → `wp-rocket/`, `WP Rocket`), `backwpup` free (`backwpup/`, `BackWPup`) and pro-en (`backwpup-pro/`, `BackWPup Pro`) each pass identity; APVM `build()` delivers the single zip directly into the role `outputDir`; wrong-product and wrong-edition `E2E_PLUGIN_ZIP` each fail with the aggregated expected-vs-found report while the other role still resolves; ref+zip conflict throws, serial+override warns→defaults; the real Playwright `artifacts:pro@nginx` project resolves+verifies+writes `resolution.json`+attaches the summary; placeholder cells skip (setup+artifacts) with the `@noauth` smoke still green and token-free. 102 unit tests green; typecheck/lint/format clean. **Note:** `wp-rocket` has **no downloadable GitHub Releases**, so `release:*` refs error for it — its `previous` default `tag:latest-stable` correctly *builds*. BackWPup, by contrast, **does** have release assets (confirmed 2026-07-16 via `warmCache`: `release:latest-stable` = v5.7.4 with `free`/`pro-en`/`pro-de`), so the §5 `previous: release:latest-stable` is viable — a release download returns *all* variants, so the editionful request's variant filter (`pro-en`) narrows it and `resolve.ts`'s `pickArtifact` selects the match.

**Phase 3 — Consumption & pre-warm.**
`pluginArtifact` fixture/helper; `warm.ts` (+spec) + `warm-artifacts.ts` + `artifacts:warm` script; finalize docs (CLAUDE.md section + §5 note, configuration.md env table, execution-model.md: artifacts dir row, third per-cell project, updated mental-model diagram).
*Acceptance:* `artifacts:warm` then a cell run → resolution logs show `fromCache`/copy (no rebuild); a smoke step installs via `pluginArtifact("plugin").zipPath`; requesting `previous` on backwpup throws the §5 error; docs cross-linked and current.
*Implemented:* `pluginArtifact` fixture (`fixtures.ts`) backed by **`consume.ts`** (+spec; **added beyond the §3 sketch** — the memo→`resolution.json` reader with a pure `parseResolution` parser, the §5 role guard, and the missing-file error, split out so the on-disk contract is unit-testable and `fixtures.ts` stays thin glue); **`peekArtifacts`** (non-throwing registry probe) reused as the single per-process memo (a disk read is memoized back through `registerArtifacts`). `warm.ts` (+spec): pure `warmArtifacts` — dedupe by `{project,gitRef,version,variants}`, skip provided zips, collect per-unit plan failures + per-request warm failures + deduped warnings; plans `serial:false` so it matches a real `--project=<cell>` run (the parity invariant) — plus `createApvmWarmer` (real `warmCache` glue). `warm-artifacts.ts` root CLI + `artifacts:warm` script (`--product`/`--cell` filters; placeholder-only cells skipped so a fresh checkout warms nothing token-free; unknown `--product` → exit 1). Docs: execution-model (trio of per-cell projects, artifacts-dir row, diagram + pre-warm note), configuration (`ARTIFACTS_ROOT`), authoring-tests (fixture row), CLAUDE.md (new *Plugin artifacts* section incl. the `apvm-napi` pin, identity matrix, six vars, `artifacts:warm`, §5 MUST — the section itself points at `configuration.md`, not at this design doc, per Phase 4; CLAUDE.md's pre-existing *In-progress plans* index does list this doc alongside the modernization plan, which is what that index is for — say so if it should be dropped), `.env.example` (`ARTIFACTS_ROOT`). **Verified end-to-end 2026-07-16:** 120 unit tests green (18 new), typecheck/lint/format clean; `artifacts:warm --product=backwpup` built `develop`→`78f6306` `[pro-en]`@`9.99.99` into cache, then the real `artifacts:pro@nginx` project resolved it **origin=cache** (no rebuild — parity confirmed) and wrote `resolution.json`; the consumer reader returned that verified zip and `previous` correctly threw the §5 error; `pluginArtifact('plugin').zipPath` installed **and activated** backwpup-pro on the real `pro@nginx` site, then cleanup restored it to absent. **Finding for Phase 6:** `installPlugin` over **ssh/docker** needs the artifact transferred to the target first — the remote `wp` cannot see a local path (a `local` transport shares the fs); the proof uploaded the zip manually to bridge this. The install-hooks phase (modernization Phase 6) must own that transfer. **Phase 4 still remains** (the design write-up, the modernization-plan §4.5/Phase 9 cross-links, and the free/pro shared-ref `variants:["free","pro"]` optimization note).

**Phase 4 — Documentation.**
Document the design, the identity matrix, the six env vars, link to it from the modernization plan §4.5 and Phase 9.

Also, update CLAUDE.md with anything that is relevant to the artifact management plan (e.g. the §5 note, the `apvm-napi` pin, the identity matrix, the six vars, and the `artifacts:warm` script). Please do not link to this plan from CLAUDE.md — it is a design doc, not a user-facing guide.

Document in the orchestrator part of the modernization plan that we should find a way (if not found yet. If already found, just explain it instead) to identify the refs used to build the artifacts (free and pro), so if they are the same ref AND version, we can pass variants ["free", "pro"] to APVM and build both zips in one shot. This is a future optimization, not a requirement for the initial implementation (unless dev says so).

**Phase 5 — Site staging area & artifact transfer (the ssh/docker install path).**
Land `src/common/wp/staging.ts` (+spec): the per-site **`.e2e_temp`** staging area and transport-agnostic `stageArtifact` / `cleanSiteStaging` / `siteStagingDir` / pure `stagingRelPath` (§2.9), plus the `copyIntoTarget` copy primitive on the transport boundary (`exec.ts`: `node:fs` `cp` / `docker cp` / node-ssh `putFile`), the WP-root resolution (rootDir for local/ssh; `pwd` for docker), and the staging-root override (`E2E_SITE_STAGING_DIR` / optional per-transport `stagingDir`). Provide the thin `stageAndInstallPlugin` wrapper. **General by design** — `plugins/` is the first category; any artifact type reuses the same path. Update `exec.ts`'s module doc (now "command execution **and file transfer**") and `docs/architecture/wordpress-automation.md`. **Depends on** Phases 1–3 (needs a resolved local `zipPath`); **blocks** the modernization plan's **Phase 6** (plugin-install hooks stage through this layer). Independent of Phase 4 — either order.
*Acceptance:* against a real cell of each reachable transport — `stageArtifact(site.transport, pluginArtifact("plugin").zipPath, { category: "plugins" })` copies the zip under `<WP root>/.e2e_temp/plugins/` and returns its absolute path; `installPlugin(transport, thatPath, { activate: true })` then installs **and activates** over **ssh** (the Phase-3 gap, now first-class) and, where the env is up, **docker** and **local**; a non-writable staging root yields the actionable `E2E_SITE_STAGING_DIR` error; `cleanSiteStaging` removes `.e2e_temp` and leaves the site clean; unit tests cover the pure path/category logic and the local-transport copy; `typecheck`/`lint`/`format`/`test:unit` green. (The ssh install path was already dry-run-verified end-to-end in Phase 3 by manually uploading the zip — Phase 5 makes that a first-class, tested helper.)

## 5. Deferred work — explicit obligations

- **BackWPup `previous` role (MUST, when its comparison tests arrive):** add `previous: "release:latest-stable"` to the backwpup manifest (dev-confirmed choice). Releases carry free + pro assets, and the variant filter applies to release downloads too — **confirmed 2026-07-16**: `release:latest-stable` resolves to v5.7.4 with `free`/`pro-en`/`pro-de` assets, so `pro-en` is selectable. Add a `defaultVersion.previous` too (e.g. `9.99.98`): a release ref derives its version from the tag (so the default is unused for it), but it is needed if `E2E_PREVIOUS_REF` is ever overridden with a *build* ref. Because resolution *and* the identity preflight are **manifest-driven**, defining the role automatically enables both — the preflight for the second artifact **must not be skipped** at that point; the only exemption is a test that builds inside its own scenario, which then owns its verification. Until then the fixture hard-errors (§2.6) — a comparison test cannot silently consume an unverified zip. This note is mirrored as the code comment on the manifest (Phase 1) and a CLAUDE.md bullet (Phase 3).
- **Imagify:** add a manifest (+ §1.2 row verified from its build definition) when the product is wired; everything else is data-driven.
- **Version-aware tests:** `E2E_PLUGIN_VERSION` is plumbing-only today; `resolution.json` already exposes the effective version/commit for future assertions (migrations, version-gated notices).
- **Deeper zip validation** (full CRC pass / trial install) — only if a real failure class appears; slots behind the same aggregated report.
- **Worker-teardown staging cleanup:** `cleanSiteStaging` (Phase 5) exists, but wiring it into a worker-scoped teardown (beside `disposeConnections`) is the modernization plan's **Phase 6**; until then a staged artifact may persist between runs — harmless (wipe-before-stage overwrites it before reuse).
- **`.e2e_temp` web-serving hardening:** if a QA site's exposure ever matters, drop a deny `.htaccess`/`index.html` on `mkdir` (Apache-only) or default the staging root outside the docroot (§1.4, §2.9). Deferred — QA sites, and the area is wiped in teardown.

## 6. Audit of Phases 1–3 (2026-07-27/28)

Full review of the shipped code against this design, its stated invariants, and the primary sources — then three further passes over the fixes themselves. Everything below is **fixed and verified**; `typecheck`/`lint`/`format` clean, unit suite 120 → **156**, and the real `backwpup/pro@nginx` cell re-verified on the default, `env-ref` and `env-zip` paths plus both failure paths (a bad ref and a wrong-product zip).

Two coverage gaps the audit also closed, both in load-bearing behaviour that only manual runs had ever exercised: the **cross-process channel** (a real `resolution.json` written to a temp artifacts tree and read back, including the stale-run warning and the memo) and the predicate that decides whether overrides apply at all — extracted as `isCellTargeted` (`run-context.ts`) so the rule that silently broke in §6.1 is now pinned by tests rather than living inline in a Playwright setup body.

### 6.1 Critical — every `E2E_*` override was silently discarded

`artifacts.setup.ts` derived its `serial` flag from `selectedCells()`, which parses `process.argv`. **A Playwright worker is forked without the CLI argv** — probed 2026-07-27: a worker's `process.argv` is exactly `[node, …/workerProcessEntry.js]`, and the project `metadata` it reads is the copy the *worker* rebuilt (the same probe shows `metadata` computed with an empty argv), while `process.env` **is** inherited from the runner. So `selectedCells()` returned `[]` in every worker, `serial` was unconditionally `true`, and §2.2 rule 3 dropped every override — in *every* run, including a correct `--project=<cell>` one.

Impact: the six-variable override surface was inert through Playwright; worse, `warm-artifacts.ts` (a normal process, argv intact) *did* honour overrides, so the warmer primed the override's build while the run built the default — the parity invariant inverted.

Reproduced end-to-end on the real `backwpup/pro@nginx` cell with `E2E_PLUGIN_ZIP` set: **before**, `source=default-ref` after a 4.1-minute cold build of `develop`; **after**, `source=env-zip origin=copied` in 83 ms.

Fix: the selection now rides the environment, the channel `RUN_ID` already used — `seedSelectedCells()` publishes it while the runner builds the config, `selectedCells()` falls back to it when argv is empty. The question the setup actually asks is `isCellTargeted(cell, projectName)`, which also counts `--project=artifacts:<cell>`; it lives in `run-context.ts` with the rest of the selection logic so it is unit-testable rather than inline in a Playwright test body (10 tests across both). Documented as a standing rule in [execution-model.md](../architecture/execution-model.md): worker-side code must never read `process.argv`.

### 6.2 Data loss — an `E2E_*_ZIP` inside the artifacts dir was deleted by the wipe

Resolution wiped `.artifacts/<product>/<cell>/` *before* validating anything, so pointing a role at a zip inside it (an obvious way to reuse the last run's build) destroyed the file and then reported it missing. Zip sources are now validated **before** the wipe, and a contained path fails fast naming the var, the path and the fix (§2.8 case 23). Verified against the real cell: the file survives.

### 6.3 Security — builder output could carry a token into a published report

A private-repo build authenticates with a GitHub token and git echoes the authenticated remote URL in several failure messages; the reporter buffers command output and the reason into the thrown error, which lands in the console **and** the HTML/Allure report CI publishes. All APVM-sourced text is now scrubbed by `redactSecrets` (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`, and URL userinfo with the scheme and host kept readable), placed where the text actually escapes: progress lines are scrubbed as they are printed, the buffered output tail and failure reason once on the way out of `failureContext()` (a build emits tens of thousands of lines and at most one failure context), and every per-role / per-warm-request failure at the single funnel that turns it into a reported outcome — so a rejection from anywhere inside, including an `Apvm` that never initialised, is covered.

### 6.4 Correctness & robustness

- **False rejection of Finder-made zips.** A `__MACOSX/` sidecar made the single-top-level-directory check fail on an archive WordPress installs happily (core's unzipper skips it) — the exact shape of an operator-provided `E2E_*_ZIP`. Now ignored; an archive that is *only* sidecar entries reports as empty.
- **Header parsing vs. core.** The regex matched core's `get_file_data()` but skipped `_cleanup_header_comment()`, so a value on a line that also closes the docblock kept the terminator and failed the exact-equality name check. Now cleaned the same way.
- **Untrimmed env values.** `" develop "` reached APVM as part of the ref and `" /path.zip "` as part of the path — a trailing space in `.env` or a CI YAML block is easy to produce and the resulting error hid the cause. Trimmed at the reader.
- **Stale resolution read silently.** A `--no-deps` run consumed a previous execution's map with no signal (§2.8 case 16). `resolution.json` now carries the writing `runId`; the consumer warns once per cell when it differs — deliberately a warning, so the fast edit-run loop survives. A resolved zip that has since been deleted now throws naming the path instead of failing invisibly inside `wp plugin install`.
- **Cached rejected APVM instance.** `getApvm()` memoized the promise including its rejection, so one transient `gh auth token` failure poisoned every later role in the process. The failed promise is now dropped.
- **`artifacts:warm` swallowed a typo'd `--cell`.** It exited `0` having warmed nothing, leaving CI to believe the cache was primed; unknown `--product`/`--cell` now both exit `1` listing the valid values. It also called `process.exit()`, which discards a pipe's pending async writes — CI's stdout is a pipe, not a TTY, so the summary a failed warm needs could be dropped. It now sets `process.exitCode` and returns. The trade is a hang instead of a truncation if anything ever leaves a live handle behind, so all three paths were measured: a cache hit and a failed ref resolve each exit ~2 s after the work, and a real cold build (13.7 min of composer/npm) exits cleanly with the full summary intact through a pipe.

### 6.5 Reviewed and left as-is

Request/plan precedence, version policy, edition→variant mapping, aggregation semantics, the registry idiom, `resolution.json`'s parser, the warm dedupe key, and the placeholder-skip path all match this design and are unit-covered. Three deliberate non-changes:

- The "exactly one zip in the role dir" check (see §2.5).
- A **bare** numeric ref (`5.6.8`) is treated as a build ref even though APVM may resolve it to a release — the version default is then sent needlessly, which APVM ignores in favour of the release tag, and narrowing it would mean re-implementing APVM's ref detection.
- `--project` is matched **exactly** against cell names, while Playwright's own filter is case-insensitive and expands `*` (confirmed in its `filterProjects`). So `--project='pro*'` runs the cell but reads here as a broad selection: overrides warn-and-drop. Mirroring the looser matcher would either duplicate a third-party internal or, worse, make `--project='*'` apply one operator's override to *every* cell — the exact thing §2.2 rule 3 exists to prevent. Exact matching is correct for every documented invocation and degrades visibly, never silently, for the rest.

## 7. References

- APVM: [repo](https://github.com/wp-media/automation-plugin-version-manager) · [napi README](https://github.com/wp-media/automation-plugin-version-manager/blob/develop/crates/napi/README.md) · [`index.d.ts`](https://github.com/wp-media/automation-plugin-version-manager/blob/develop/index.d.ts) (types are the source of truth) · builders `crates/core/src/build/plugins/`
- Identity ground truth: `wp-media/backwpup-pro` `gulpfile.ts` (`compressPackage`, `free`/`pro` tasks); `wp-media/wp-rocket` `wp-rocket.php`
- Transport transfer (Phase 5, §1.4): [exec.ts](../../src/common/wp/exec.ts) & [log.ts](../../src/common/wp/log.ts) (exec-cwd = WP root); `node-ssh` `putFile`/`mkdir` (`index.d.ts`); `docker cp` + `wordpress:cli` WORKDIR (`docker image inspect`)
- This repo: [execution-model.md](../architecture/execution-model.md) · [configuration.md](../guides/configuration.md) · [wordpress-automation.md](../architecture/wordpress-automation.md) · [modernization plan](e2e-modernization-plan.md) §3.4/§4.5/Phase 6/Phase 9
