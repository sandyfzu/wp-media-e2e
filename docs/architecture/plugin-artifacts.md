# Plugin artifacts — the zips under test

Every run resolves **and verifies** the plugin zips it will test before a single
scenario runs. This document is the design reference for that capability
(`src/common/artifacts/`); the operator-facing env-var table lives in
[configuration.md](../guides/configuration.md#plugin-artifacts-build--verify).

The problem it solves: a run unit `(product × cell)` needs one or two plugin zips,
and "which zip" must be decidable per execution — `develop` by default, an
arbitrary branch/PR/tag on demand, or a zip someone built by hand — without a
human copying files into place and without a run ever silently testing the wrong
plugin or the wrong edition.

## Roles

Each product declares up to two **roles**. The word is used verbatim by the env
vars, the on-disk directories, and the fixture:

| Role       | Meaning                                                     | Declared by                                    |
| ---------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `plugin`   | The artifact under test. Every product has it.              | `artifacts.defaultRef.plugin` (mandatory)      |
| `previous` | An older artifact some tests compare against (update path). | `artifacts.defaultRef.previous` (opt-in)       |

Declaring `defaultRef.previous` is the **single** signal that a product supports
the role: resolution, the identity preflight, and the fixture are all
manifest-driven, so adding it enables the second artifact everywhere at once.
WP Rocket has `previous` from day one; BackWPup deliberately does not yet (see
[Deferred obligations](#deferred-obligations)).

## Module map (`src/common/artifacts/`)

| Module               | Responsibility                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| `types.ts`           | The whole domain's types (roles, manifest, requests, resolution). Types only.      |
| `manifest.ts`        | Pure accessors over a product's manifest (roles, default ref, edition → variant).  |
| `request.ts`         | Reads the six `E2E_*` vars; **pure** `buildArtifactPlan` → one request per role.   |
| `apvm.ts`            | Lazy `Apvm` singleton, token diagnostics, progress → console, secret redaction.    |
| `resolve.ts`         | Wipe → build/copy per role → `resolution.json`.                                    |
| `verify.ts`          | Static identity preflight (`adm-zip`) + aggregated report formatting.               |
| `consume.ts`         | Reads a role back for a test (memo → `resolution.json`), with the role guards.     |
| `registry.ts`        | Per-process manifest + resolution registries (the `metadata.ts` idiom).            |
| `warm.ts`            | Pre-warm: dedupe requests, prime APVM's cache serially.                            |
| `artifacts.setup.ts` | The `artifacts:<cell>` setup project — thin orchestration of the above.             |

## The product manifest

`ProductConfig.artifacts` ([`ProductArtifacts`](../../src/common/artifacts/types.ts))
is **required**, so no product can ship without a declared build source. It is
authored in `src/projects/<product>/config/<product>.config.ts` and carries four
things: the APVM `project` id, the per-role default refs, the version policy, and
the edition policy (which also holds the identity expectations).

| Product      | `plugin` default | `previous` default   | Version policy                                     | Edition → APVM variant |
| ------------ | ---------------- | -------------------- | -------------------------------------------------- | ---------------------- |
| `wp-rocket`  | `develop`        | `tag:latest-stable`  | `embedded` — no default; an override rewrites it   | — (editionless)        |
| `backwpup`   | `develop`        | _none yet_           | `required` — `plugin` → `9.99.99`                  | `free` → `free`, `pro` → `pro-en` |
| `imagify`    | _(not wired)_    | _(not wired)_        | _(verify from its build definition)_               | — (expected)           |

- **`embedded`** — the version lives in source, so nothing is sent to APVM
  unless an operator pins one, in which case APVM rewrites the source version
  (reported as `versionOverride`).
- **`required`** — APVM cannot build without a version (BackWPup), so every
  supported role must declare a default. Defaults are deliberately **staggered**
  one patch apart (`plugin` newer than `previous`, e.g. `9.99.99` / `9.99.98`) so
  an update-path test sees `previous` as genuinely older with no manual pinning.
- A `release:*` ref never receives a version on either policy — the release tag
  supplies it.

### Edition vs. variant (two namespaces, on purpose)

Our **edition** (`free` / `pro`) is the binary, language-blind behavioural tier
that drives scenario filtering and page objects. APVM's **variant**
(`free` / `pro-de` / `pro-en`) names an exact buildable package. The manifest maps
each edition to the **one** variant it builds — a projection, not an identity:
`pro` → `pro-en` (`pro-de` differs only in licensing endpoints, so `pro-en`
coverage stands in for it), while `free` → `free` merely coincides. Exactly one
variant per edition, because each role resolves to exactly one zip; the request
builder wraps it into APVM's `variants` array.

## Requests: `(manifest, edition, env)` → what to fetch

[`buildArtifactPlan`](../../src/common/artifacts/request.ts) is **pure** — no
`process.env`, no filesystem — and returns one request per supported role plus a
list of warnings. A request is a discriminated union:

- `{ kind: "build", params: { project, gitRef, version?, variants? } }` — APVM builds it.
- `{ kind: "zip", rawPath }` — an operator-provided zip is copied in.

Purity is not decoration: this same function is the **only** planner, used by the
run-time resolver *and* by the pre-warmer. That is what makes their APVM params
identical — the [parity invariant](#pre-warming) — and it lets the whole
precedence matrix be unit-tested with plain inputs.

Precedence per role: `E2E_<ROLE>_ZIP` > `E2E_<ROLE>_REF` > the manifest default,
with ref and zip **mutually exclusive**. The failure model is deliberate:

| Situation                                                              | Behaviour                     |
| ---------------------------------------------------------------------- | ----------------------------- |
| A role's `_REF` and `_ZIP` both set, on a targeted cell run            | **Throws** (naming both vars) |
| Any override on a serial (cell-less) run                               | Warn + use defaults           |
| `_VERSION` alongside that role's `_ZIP`, or a `release:*` ref           | Warn + ignore                 |
| `E2E_PREVIOUS_*` on a product with no `previous` role                  | Warn + ignore                 |
| `plugin` and `previous` resolving to the identical request             | Warn (degenerate comparison)  |
| An edition-ful product whose cell declares no edition                  | Throws (a config/programming bug) |

Only a genuine misconfiguration that would otherwise do the wrong thing silently
throws. Everything else warns, because several products' cells can share one
shell or CI environment and a leftover variable must never abort a broad run.

### Why overrides need an explicitly named cell

An override describes *one* run unit. A serial sweep of every cell has no single
unit to apply it to, so overrides are dropped (with a warning naming them) and
defaults are used. The predicate is
[`isCellTargeted(cell, projectName)`](../../src/common/config/run-context.ts),
which is true for `--project=<cell>` and for `--project=artifacts:<cell>` (the
way to resolve a cell's zips without running its scenarios).

The setup runs in a Playwright **worker**, which is forked without the CLI argv —
so this answer must ride the environment, not `process.argv`. See
[execution-model.md](execution-model.md#reading-the-selection-from-a-worker); the
matching cell name is compared **exactly**, so `--project='pro*'` runs the cell
but reads here as a broad selection (it warns rather than applying one operator's
override to cells they never named).

## Resolution: wipe → resolve → verify → publish

```text
.artifacts/<product>/<cell>/         ← gitignored, EPHEMERAL: wiped whole at each resolution
├── plugin/<one>.zip                 ← role subdirs ⇒ filename collisions impossible,
├── previous/<one>.zip                  and a role is derivable from the path alone
└── resolution.json                  ← this execution's role → artifact map
```

- The root is overridable with `ARTIFACTS_ROOT`; `<product>/<cell>` is always
  appended, so concurrent cells never share a directory.
- **Every resolved zip is normalised to mode `0644`.** A build lands `0600`, and getting it
  onto a site copies it verbatim: `docker cp` preserves the host mode _and_ numeric owner
  (meaningless inside a container), so WP-CLI there cannot open the archive and
  `wp plugin install` fails with an opaque `PCLZIP_ERR_READ_OPEN_FAIL`. The same applies to a
  `local` site whose `wp` runs as another user. Normalising once at resolution fixes every
  transport at no per-scenario cost — an artifact only its creator can read is not yet usable.
- **Every execution wipes and re-resolves.** Refs are rebuilt (a cache hit is a
  ~15 MB copy — acceptable), provided zips are copied in (uniform layout, immune
  to the source file moving mid-run). We make no cross-execution reuse decision:
  **APVM's cache is the only reuse layer**, and each artifact reports which
  applied (`origin: built | cache | downloaded | copied`).
- Because the wipe is unconditional and runs first, an `E2E_*_ZIP` pointing
  **inside** the cell's own directory is rejected *before* anything is deleted —
  otherwise the operator's file would be destroyed and then reported missing.
- Roles resolve **sequentially** (readable logs, no concurrency assumptions about
  APVM workspaces), and a per-role failure is captured as a **value**, never
  thrown: `previous` is still resolved and verified when `plugin` fails, so one
  aggregated report names every problem at once.

APVM (`apvm-napi`, pinned to a `cli/vX.Y.Z` tag in `package.json`) ships prebuilt
native binaries — no Rust toolchain, no build step. It is driven **only** through
this Node library, never the `apvm` CLI: a capability only the CLI has waits for a
library release that exposes it. BackWPup builds from a
**private** source repo, so it needs a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN`,
or `gh auth login`); the token is asserted **before** any clone is attempted, and
every string APVM emits is scrubbed for tokens and URL userinfo before it can
reach a console or a published report.

## Identity preflight

The decision is **static zip inspection**, not an install-based probe: it needs no
WordPress (so it runs before transports are even checked), takes milliseconds,
cannot mutate a site, and behaves identically for built and provided zips. The
first real install step of the suite proves installability minutes later anyway,
with better context.

Per resolved artifact, via `adm-zip` (read-only — central directory plus one entry):

1. The zip parses and has a **single top-level directory**, ignoring a macOS
   `__MACOSX/` sidecar (WordPress's own unzipper skips it, so a Finder-made
   archive installs fine and must verify fine).
2. That directory equals the expected **slug** — one check that pins product
   *and* edition.
3. `<mainFile>` exists under that directory and its `Plugin Name:` header
   **equals** the expectation exactly (never a prefix, so `BackWPup` cannot pass
   for `BackWPup Pro`). The value is cleaned exactly as core's
   `_cleanup_header_comment()` does, so equality never fails on a value
   WordPress itself reads correctly. The lookup uses the archive's **actual**
   top-level directory, not the expected slug, so a wrong-edition zip still
   reports its header — two independent witnesses instead of one.
4. Informational, reported but not asserted: header `Version:`, zip filename,
   source, resolved commit, origin. The header's `Version:` also **becomes the
   artifact's `version`** — it is what WordPress installs and reports, and for a
   provided zip it is the only version there is (none is recorded when one is
   copied in, and a `_VERSION` override is ignored beside it). The build's own
   report is kept only as the fallback for a zip whose header declares none.

| Product / edition | Top-level dir (slug) | Main file       | `Plugin Name:`   |
| ----------------- | -------------------- | --------------- | ---------------- |
| WP Rocket         | `wp-rocket/`         | `wp-rocket.php` | `WP Rocket`      |
| BackWPup Free     | `backwpup/`          | `backwpup.php`  | `BackWPup`       |
| BackWPup Pro      | `backwpup-pro/`      | `backwpup.php`  | `BackWPup Pro`   |

Ground truth for that table: APVM's builders
(`crates/core/src/build/plugins/`) and `wp-media/backwpup-pro`'s `gulpfile.ts`,
whose `compressPackage` zips `dist/<packageName>` so the top-level directory *is*
the slug, and whose `free` task rewrites the header.

**Aggregation is the user-visible contract.** Every role is resolved and verified
even when an earlier one failed; resolution errors and identity mismatches are
collected, then one formatted report (the same `CheckResult` + `styleText` style
as [`preflight.ts`](../../src/common/setup/preflight.ts)) lists each artifact with
✓/✗ per check, expected-vs-found, and a hint (e.g. a wrong-edition zip on a `pro`
cell). A single `Error` at the end fails the setup project, which skips the
dependent BDD project. On success the same data prints as one line per role and is
attached to the test as JSON, so it lands in the HTML/Allure report.

## Run wiring

The config factory emits a third per-cell project, a sibling of the auth setup:

```text
artifacts:<cell> ─┐
setup:<cell>     ─┴─→ <cell>  (BDD; dependencies: [both])
```

The two setups are independent — either **failing** skips the BDD scenarios, while
a placeholder-only cell **skips** both without blocking (a fresh checkout's
`npm run test` clones nothing, builds nothing, and needs no token). The artifacts
setup carries a generous timeout: a cold build runs composer/npm.

## Consumption

A scenario never resolves anything; it reads the result:

```ts
await installPlugin(site.transport, pluginArtifact("plugin").zipPath, { activate: true });
```

The `pluginArtifact` fixture returns the role's
[`ResolvedArtifact`](../../src/common/artifacts/types.ts)
(`{ slug, zipPath, zipFilename, source, ref?, commit?, version?, origin, resolvedAt }`).

**`slug`** is the WordPress plugin directory the artifact installs as
(`backwpup` vs `backwpup-pro`), so a test or hook can address the plugin —
`ensurePluginAbsent(site.transport, pluginArtifact("plugin").slug)` — without branching
on edition. It is the cell's expected identity slug, stamped on at resolution; the
preflight then proves the archive's actual top-level directory matches it, and
`resolution.json` is written **only** after every role passed. A slug read back through
the fixture is therefore always a verified one, and `parseResolution` requires the field,
so a resolution predating it is rejected rather than yielding an undefined slug.

Because Playwright workers are separate processes that never resolve, the channel
is `resolution.json`, read lazily and memoized per process. Four guards keep the
failure modes visible:

- Requesting a role the product does not declare **throws before any file read** —
  a comparison test can never consume a role that was never resolved or verified.
- A missing `resolution.json` throws with the fix (the setup did not run for this
  cell — run via `--project=<cell>`, not `--no-deps`).
- A resolution written by a **different** `runId` warns once per cell. It stays
  non-fatal on purpose (it keeps the fast `--no-deps` edit-run loop working) but
  never silent, since the zips may be older than the refs you expect.
- A resolved zip that has since been deleted throws naming the path, instead of
  deferring an invisible cause to `wp plugin install`.

> **`zipPath` is a path on the runner.** Only a `local` transport's `wp` can read it
> directly, so for `ssh`/`docker` the artifact is copied onto the site first —
> `stageAndInstallPlugin(site.transport, a.zipPath, { activate: true, slug: a.slug })`
> (where `a = pluginArtifact("plugin")`) does both steps — and, given the `slug`, restores
> the installed plugin's ownership so the web server can write it. See
> [wordpress-automation.md](wordpress-automation.md#site-staging--file-transfer-wpstagingts).

## Pre-warming

N cells wanting the same uncached build must not build it N times, and build
minutes should not count against test wall-time. `warmCache()` runs the same
pipeline as `build()` but delivers nothing, so the later per-cell `build()` is a
cache copy.

```bash
npm run artifacts:warm                                          # every real cell
npm run artifacts:warm -- --product=backwpup --cell=pro@nginx   # one unit
```

[`warmArtifacts`](../../src/common/artifacts/warm.ts) plans every unit through
`buildArtifactPlan` with `serial: false` (the mode a real `--project=<cell>` run
plans in, so overrides apply identically), **skips** provided-zip roles (nothing
to build), **dedupes** by the `{project, gitRef, version, variants}` tuple, then
warms each distinct request serially. Failures are collected per request, never
thrown, so one bad ref does not abort the batch; unknown `--product`/`--cell`
values exit `1` rather than reporting a cache that was never primed.

**The parity invariant:** warm and run must compute the *same* APVM params, or the
warmed entry is never hit. That is why there is exactly one planner. A keyword ref
(`tag:latest-stable`) is re-resolved at both warm and run time, so a release cut
in between means the run builds fresh — correct, just slower for that run.

## Deferred obligations

- **BackWPup `previous` role (MUST, when its comparison tests arrive).** Add
  `previous: "release:latest-stable"` **and** a `previous` default version to
  [`backwpup.config.ts`](../../src/projects/backwpup/config/backwpup.config.ts)
  (the release ref derives its version from the tag, but the default is needed if
  `E2E_PREVIOUS_REF` is ever pointed at a build ref). BackWPup releases carry
  `free`/`pro-en`/`pro-de` assets and the variant filter applies to release
  downloads, so `pro-en` is selectable. Declaring the role automatically enables
  the second artifact's verification, which **must not** be skipped — the only
  exemption is a test that builds inside its own scenario and therefore owns its
  own verification. The obligation is mirrored as a comment on that manifest, and
  until it lands the fixture hard-errors.
- **Imagify** — add a manifest (and verify its identity row from its build
  definition) when the product is wired; everything else is data-driven.
- **Version-aware tests** — `resolution.json` already exposes the verified
  version (the zip's own header, see the preflight above) and the commit per role,
  for migration or version-gated-notice assertions. BackWPup's CLI feature already
  asserts `wp backwpup version` against it.
- **Deeper zip validation** (full CRC pass / trial install) — only if a real
  failure class appears; it slots behind the same aggregated report.
- **Shared-ref multi-variant builds** — when a Free and a Pro cell resolve the
  same ref *and* version, both variants could be built in one APVM call. The
  mechanism and where it belongs are described in the
  [orchestrator plan](../plans/orchestrator-plan.md).

## References

- [configuration.md](../guides/configuration.md#plugin-artifacts-build--verify) — the six `E2E_*` vars and their rules.
- [execution-model.md](execution-model.md) — per-cell projects, artifact directories, cell selection.
- [wordpress-automation.md](wordpress-automation.md#site-staging--file-transfer-wpstagingts) — getting a zip onto an `ssh`/`docker` site.
- [authoring-tests.md](../guides/authoring-tests.md#fixtures-srccommonfixturests) — the `pluginArtifact` fixture in a scenario.
- APVM: [repo](https://github.com/wp-media/automation-plugin-version-manager) · its `index.d.ts` is the authoritative API surface.
