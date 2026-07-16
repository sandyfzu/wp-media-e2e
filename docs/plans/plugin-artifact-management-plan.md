# Plugin Artifact Management Plan — resolve, build & verify the zips under test

> **Status:** Phases 1–2 implemented ✅; Phase 3 planned. Await explicit green light per phase.
> **Verified against:** APVM `develop` (npm `3.0.0`), pinned tag `cli/v3.0.0` (confirmed cut 2026-07-14 — see §1.1), `wp-media/backwpup-pro` `gulpfile.ts`, `wp-media/wp-rocket` `wp-rocket.php`, and this repo's working tree.
> **Relation to the [modernization plan](e2e-modernization-plan.md):** this designs the artifact source that §4.5's "edition→package install map" and Phase 6's plugin-install hooks consume, and the pre-warm contract Phase 9's orchestrator calls.

## TL;DR

Every run unit `(product × cell)` needs one or two plugin zips: the **plugin under test** and (for some tests) its **previous version to test against** (e.g. testing an update path). A new per-cell dependency project resolves both **per execution** — from `E2E_*` env overrides (a git ref **or** a local zip path, never both) or per-product defaults (`develop` / `tag:latest-stable`) — building refs with **`apvm-napi` 3.0.0** (git dependency; prebuilt binaries, no Rust) into a wiped `.artifacts/<product>/<cell>/<role>/` dir, APVM owning its cache (`~/.apvm/cache`, never overridden). BackWPup builds are version-required; the two roles get **distinct defaults** (`9.99.99` tested / `9.99.98` previous) so an update-path test always sees the previous artifact as *older*, without anyone having to pass a version by hand. A **static identity preflight** then unzips headers and asserts each zip is the exact expected plugin **and edition** (`wp-rocket/` ≠ `backwpup/` ≠ `backwpup-pro/`), checking every artifact before failing with one aggregated, actionable report. Steps consume paths via a registry/fixture; an orchestrator can pre-build everything with `apvm.warmCache()` using the **same request builder** (cache-key parity). Serial (cell-less) runs always use defaults, warning (never failing) if `E2E_*` overrides are set. Three phases: ① request model + deps, ② resolution + preflight + wiring, ③ consumption + pre-warm.

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
- **Run context** ([run-context.ts](../../src/common/config/run-context.ts)): `dirs(product, cell)` namespaces every artifact path; gains an `artifacts` entry (ephemeral family). `selectedCells()` already distinguishes cell runs from serial runs.
- **Unit tests**: `src/common/**/*.spec.ts` are auto-picked by `playwright.unit.config.ts`.

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
- **Wipe → resolve → verify** on every execution: refs re-build (cache makes it a copy — zips are ~15 MB, acceptable), provided zips are **copied in** (uniform layout; immune to the source file moving mid-run). No cross-execution reuse decisions on our side — **APVM's cache is the only reuse layer** (`fromCache` on the output says which).
- **The map.** Resolution runs **exactly once per (execution × cell)** — in the artifacts project (§2.6) — and memoizes in-process. Playwright workers are separate processes, so the resolver also writes `resolution.json` (role → `{ zipFilename, source, ref?, commit?, version?, origin, resolvedAt }`; no secrets). Workers read it lazily and memoize. It lives inside the wiped dir, so it can never describe a previous execution's zips; it also gives later "version-aware" tests their build metadata for free. Workers never resolve or write — re-running APVM per worker would race on the wipe and duplicate copies.

### 2.5 Identity preflight

**Decision: static zip inspection**, not install-based probing. Rationale: it needs no WordPress (runs even before transports are checked), takes milliseconds, can't mutate any site, works identically for built and provided zips, and asserts the exact facts we verified in §1.2. Install-based verification would prove installability — but the first real install step of the suite proves that anyway minutes later with better context; and an install loop (uninstall → install → list → uninstall) per artifact is slow, serialized, and adds failure modes of its own. If a corrupt-zip class of failure ever shows up in practice, a deeper check can be added behind the same report (§5).

Checks per resolved artifact (via `adm-zip` — read-only: central directory + one entry; new devDependency, `yauzl` is the fallback candidate if it disappoints):

1. Role dir holds **exactly one** `.zip` (guaranteed by the wipe; violation = internal error).
2. Zip parses and has a **single top-level directory**.
3. That directory equals the expected **slug** — one check that pins both product and edition (`wp-rocket` / `backwpup` / `backwpup-pro`).
4. `<slug>/<mainFile>` exists; its header block contains `Plugin Name:` whose trimmed value **equals** the expectation exactly — equality, not prefix, so `BackWPup` can never pass for `BackWPup Pro`.
5. Informational (reported, not asserted): header `Version:`, zip filename, source (`default-ref` / `env-ref` / `env-zip`), resolved commit, `origin` (`built`/`cache`/`downloaded`/`copied`).

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
- **Consumption**: a `pluginArtifact(role)` helper + fixture in [fixtures.ts](../../src/common/fixtures.ts) returns `{ zipPath, source, commit?, version?, origin }` from the memo/`resolution.json`. Missing file → actionable error ("the artifacts setup didn't run for this cell in this execution — run via `--project=<cell>` without `--no-deps`"). Requesting `previous` on a product without the role → error pointing at §5 — so a future comparison test **cannot silently run unverified**. Phase 6 (modernization plan) install hooks consume this instead of §4.5's static zip map.

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
| 16 | `--no-deps` BDD invocation | Fixture reads whatever the last resolution wrote or errors; documented as unsupported for artifact-consuming scenarios |

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

Modified: src/common/config/types.ts    (+ ProductConfig.artifacts manifest)
          src/projects/*/config/*.config.ts (+ per-product manifests incl. §1.2 expectations)
          src/common/config/project.ts  (+ artifacts:<cell> project & dependencies)
          src/common/config/run-context.ts (+ artifacts dir / ARTIFACTS_ROOT)
          src/common/fixtures.ts        (+ pluginArtifact fixture)
          .gitignore  .env.example  package.json (deps + script)
          CLAUDE.md  docs/guides/configuration.md  docs/architecture/execution-model.md
```

## 4. Implementation phases

**Phase 1 — Dependencies & request model (pure logic, no behavior change). ✅**
Add `apvm-napi` (pinned per §1.1 — smoke-test the git-dep install, incl. the husky-prepare caveat) and `adm-zip` (+types). Land `artifacts/types.ts`, `request.ts` (+spec), `registry.ts`, the `ProductConfig.artifacts` type and both product manifests with the §1.2 identity expectations; document the six vars in `.env.example` + configuration.md. Leave the **§5 MUST comment** on backwpup's absent `previous` role.
*Acceptance:* `typecheck`/`lint`/`format`/`test:unit` green; the §2.2 rule matrix and §2.3 defaults are unit-proven — incl. edition→variants, the `release:*`-no-version rule, and BackWPup's independent per-role version defaults (`9.99.99` plugin / `9.99.98` previous, each overridable by its own env var); `node -e "import('apvm-napi')"` loads the prebuilt binary on darwin-arm64 and linux-x64.
*Implemented:* `apvm-napi` pinned to `cli/v3.0.0`, installed, and load-smoke-tested on darwin-arm64 (its `husky` prepare is already blocked by the repo's `allow-scripts` gate — no `HUSKY=0` needed). Modules under `src/common/artifacts/`: `types.ts`; `manifest.ts` (**added** beyond the §3 sketch — pure edition/role accessors, split from `request.ts` for separation + isolated tests); `request.ts` (`readArtifactEnv` + pure `buildArtifactPlan`, returning requests **plus warnings** so the planner stays pure); `registry.ts`. `ProductConfig.artifacts` is **required** (only two constructors, both updated) so no product can ship without a build source. **Two deviations:** `adm-zip` is **deferred to Phase 2** (its only consumer is `verify.ts`; adding it now would be an unused dependency); `manifest.ts` was added. 35 new unit tests across the three specs (79 total suite); the type-only `config↔artifacts` reference compiles clean (erased under `verbatimModuleSyntax`). Verified end-to-end 2026-07-14.

**Phase 2 — Resolution, identity preflight & wiring.**
Land `apvm.ts`, `resolve.ts`, `verify.ts` (+spec), `artifacts.setup.ts`; factory emits `artifacts:<cell>` (sibling of `setup:<cell>`, placeholder-skip); `run-context` gains the artifacts dir; gitignore `.artifacts/`.
*Acceptance:* against a real cell — default run builds/copies and preflight passes with the summary attached; `E2E_PLUGIN_ZIP` with a **wrong-edition** and a **wrong-product** zip each fail with the aggregated expected-vs-found report while the other role still resolves; a ref+zip conflict in a cell run fails fast, while a serial+override warns and falls back to defaults (both with the specified messages); identity matrix (§1.2) re-validated against freshly built `wp-rocket`, `backwpup` free and `pro-en` artifacts; fresh checkout `npm run test` (placeholders) is unaffected and token-free.
*Implemented:* `apvm.ts` (lazy `Apvm` singleton via `createWithTokenResolution`; token guard for the private `backwpup` source before any clone; progress→console reporter buffering command output for failure context), `resolve.ts` (wipe → per-role build/copy → `resolution.json`; per-role failures captured as values, never thrown, so one role's failure never stops another), `verify.ts` (+spec; `adm-zip` static identity checks reading the header from the **actual** top-level dir so the name check still runs on a slug mismatch; `CheckResult` aggregation + report/summary formatting mirroring `preflight.ts`), `artifacts.setup.ts` (thin orchestration: placeholder-skip, serial detection via `selectedCells()`, resolve → verify → attach JSON summary → persist). Factory emits `artifacts:<cell>` as a sibling of `setup:<cell>`; the BDD project depends on **both** (either skip/failure alone gates it — a skipped dependency does not block the BDD project). `run-context` gained `REPO_ROOT` (cwd-independent absolutization) + the `artifacts` dir (`ARTIFACTS_ROOT`); `.artifacts/` gitignored. **Additions beyond the §3 sketch:** `adm-zip`+`@types/adm-zip` (Phase 1's deferral); a per-product **manifest registry** (`registerManifest`/`getManifest` in `registry.ts`) so the setup reads the manifest by product name without a `common→projects` import (metadata.ts idiom); a shared `errorMessage` boundary util in `guards.ts`; the §2.8 **case-12** degenerate-comparison warning in the pure planner (`request.ts`, +tests). **Verified end-to-end 2026-07-14:** freshly BUILT `wp-rocket` (`develop`+`tag:latest-stable` → `wp-rocket/`, `WP Rocket`), `backwpup` free (`backwpup/`, `BackWPup`) and pro-en (`backwpup-pro/`, `BackWPup Pro`) each pass identity; APVM `build()` delivers the single zip directly into the role `outputDir`; wrong-product and wrong-edition `E2E_PLUGIN_ZIP` each fail with the aggregated expected-vs-found report while the other role still resolves; ref+zip conflict throws, serial+override warns→defaults; the real Playwright `artifacts:pro@nginx` project resolves+verifies+writes `resolution.json`+attaches the summary; placeholder cells skip (setup+artifacts) with the `@noauth` smoke still green and token-free. 102 unit tests green; typecheck/lint/format clean. **Note:** `wp-rocket` has **no downloadable GitHub Releases**, so `release:*` refs error for it — its `previous` default `tag:latest-stable` correctly *builds*. BackWPup, by contrast, **does** have release assets (confirmed 2026-07-16 via `warmCache`: `release:latest-stable` = v5.7.4 with `free`/`pro-en`/`pro-de`), so the §5 `previous: release:latest-stable` is viable — a release download returns *all* variants, so the editionful request's variant filter (`pro-en`) narrows it and `resolve.ts`'s `pickArtifact` selects the match.

**Phase 3 — Consumption & pre-warm.**
`pluginArtifact` fixture/helper; `warm.ts` (+spec) + `warm-artifacts.ts` + `artifacts:warm` script; finalize docs (CLAUDE.md section + §5 note, configuration.md env table, execution-model.md: artifacts dir row, third per-cell project, updated mental-model diagram).
*Acceptance:* `artifacts:warm` then a cell run → resolution logs show `fromCache`/copy (no rebuild); a smoke step installs via `pluginArtifact("plugin").zipPath`; requesting `previous` on backwpup throws the §5 error; docs cross-linked and current.

**Phase 4 — Documentation.**
Document the design, the identity matrix, the six env vars, link to it from the modernization plan §4.5 and Phase 9.

Also, update CLAUDE.md with anything that is relevant to the artifact management plan (e.g. the §5 note, the `apvm-napi` pin, the identity matrix, the six vars, and the `artifacts:warm` script). Please do not link to this plan from CLAUDE.md — it is a design doc, not a user-facing guide.

Document in the orchestrator part of the modernization plan that we should find a way to identify the refs used to build the artifacts (free and pro), so if they are the same ref AND version, we can pass variants ["free", "pro"] to APVM and build both zips in one shot. This is a future optimization, not a requirement for the initial implementation (unless dev says so).

## 5. Deferred work — explicit obligations

- **BackWPup `previous` role (MUST, when its comparison tests arrive):** add `previous: "release:latest-stable"` to the backwpup manifest (dev-confirmed choice). Releases carry free + pro assets, and the variant filter applies to release downloads too — **confirmed 2026-07-16**: `release:latest-stable` resolves to v5.7.4 with `free`/`pro-en`/`pro-de` assets, so `pro-en` is selectable. Add a `defaultVersion.previous` too (e.g. `9.99.98`): a release ref derives its version from the tag (so the default is unused for it), but it is needed if `E2E_PREVIOUS_REF` is ever overridden with a *build* ref. Because resolution *and* the identity preflight are **manifest-driven**, defining the role automatically enables both — the preflight for the second artifact **must not be skipped** at that point; the only exemption is a test that builds inside its own scenario, which then owns its verification. Until then the fixture hard-errors (§2.6) — a comparison test cannot silently consume an unverified zip. This note is mirrored as the code comment on the manifest (Phase 1) and a CLAUDE.md bullet (Phase 3).
- **Imagify:** add a manifest (+ §1.2 row verified from its build definition) when the product is wired; everything else is data-driven.
- **Version-aware tests:** `E2E_PLUGIN_VERSION` is plumbing-only today; `resolution.json` already exposes the effective version/commit for future assertions (migrations, version-gated notices).
- **Deeper zip validation** (full CRC pass / trial install) — only if a real failure class appears; slots behind the same aggregated report.

## 6. References

- APVM: [repo](https://github.com/wp-media/automation-plugin-version-manager) · [napi README](https://github.com/wp-media/automation-plugin-version-manager/blob/develop/crates/napi/README.md) · [`index.d.ts`](https://github.com/wp-media/automation-plugin-version-manager/blob/develop/index.d.ts) (types are the source of truth) · builders `crates/core/src/build/plugins/`
- Identity ground truth: `wp-media/backwpup-pro` `gulpfile.ts` (`compressPackage`, `free`/`pro` tasks); `wp-media/wp-rocket` `wp-rocket.php`
- This repo: [execution-model.md](../architecture/execution-model.md) · [configuration.md](../guides/configuration.md) · [modernization plan](e2e-modernization-plan.md) §3.4/§4.5/Phase 6/Phase 9
