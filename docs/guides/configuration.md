# Configuration reference

The two configuration surfaces are **sites files** (per product, secret) and
**`.env`** (runtime flags + service credentials). This is the schema reference;
for the operational quick-start see the [README](../../README.md).

## Sites files (per product)

A product's site definitions live in one or more JSON files under
`src/projects/<product>/config/`. All are **git-ignored** because they hold
credentials. Each product ships a committed `sites.example.json` with placeholder
data on the reserved `.example.test` domain.

### Which files are loaded

Files are discovered and merged in stable order by
[`loadSites`](../../src/common/config/sites.ts):

1. **`sites.json`** — the primary file (if present).
2. **`sites.<name>.json` overlays** (e.g. `sites.docker.json`, `sites.local.json`,
   `sites.ssh.json`) — merged in alphabetically after `sites.json`. Overlay names
   must be a single segment with no extra dots (`sites.a.json` is valid;
   `sites.a.b.json` is ignored).

Each file declares a **disjoint set of cells**; a cell name appearing in two files
is a hard error that names both source files. Edition consistency (all-or-none) is
checked per-file _and_ across the merged result.

When **none** of the above exist, `sites.example.json` is loaded with a warning so
the suite still starts, `@noauth` smoke scenarios stay green, and auth setup is
skipped for all placeholder (`.example.test`) sites.

Every field is validated with an actionable error that names the offending cell and
index, so a malformed file fails fast.

### Shape

The top-level keys are **cell names** (`apache`, `nginx`, `pro@nginx`, …). A cell
is either a bare array of sites (editionless) or an object `{ edition?, sites }`:

```jsonc
{
  // Editionless cell (e.g. WP Rocket): bare site array.
  "apache": [
    {
      "baseURL": "https://example.test",
      "username": "admin",
      "password": "…",
      "transport": { "mode": "ssh", "host": "203.0.113.10", "username": "ubuntu",
                     "privateKeyPath": "/home/ci/.ssh/id_ed25519",
                     "rootDir": "/var/www/html/site" },
      "overrides": { "storage": { "ftp": { "host": "ftp.alt.example" } } }
    }
  ],

  // Edition-ful cell (e.g. BackWPup): object with an edition.
  "pro@nginx": {
    "edition": "pro",
    "sites": [ { "baseURL": "…", "username": "…", "password": "…", "transport": { … } } ]
  }
}
```

### Site fields ([`SiteInput`](../../src/common/config/types.ts))

| Field        | Required | Notes                                                              |
| ------------ | -------- | ------------------------------------------------------------------ |
| `baseURL`    | yes      | The site's URL. Each pooled worker navigates relative to its own.  |
| `username`   | yes      | WordPress admin login.                                             |
| `password`   | yes      | WordPress admin password.                                          |
| `transport`  | yes      | How WP-CLI reaches the site (below).                               |
| `overrides`  | no       | Per-site service-credential overrides, merged over product globals. |

The resolved [`SiteConfig`](../../src/common/config/types.ts) adds a computed
`storageState` path (where the worker's saved login is written).

### Transport modes ([`Transport`](../../src/common/config/types.ts))

Discriminated on `mode` — see
[wordpress-automation.md](../architecture/wordpress-automation.md) for dispatch
detail.

| `mode`   | Required fields                                          |
| -------- | ------------------------------------------------------- |
| `local`  | `rootDir`                                               |
| `docker` | `container`                                             |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir`         |

## Editions (Free / Pro)

For products shipped as two packages (BackWPup), a cell declares `edition`.
Editions are **all-or-none across a product's cells**: if any cell declares one,
every cell must — so an edition-ful product can never silently run an
edition-less cell. The config factory turns a cell's edition into a Cucumber tag
filter (`pro` → `not @free`, `free` → `not @pro`).

**Edition vs. variant.** `edition` (our binary Free/Pro _behavioral_ tier) is distinct
from an APVM build **variant** (`free`/`pro-de`/`pro-en`). Edition is language-blind and
drives scenarios/POM; a variant is the exact package APVM builds. The artifacts manifest
maps each edition to the single variant it builds (`pro` → `pro-en`) — see the
[plugin-artifact management plan](../plans/plugin-artifact-management-plan.md).

## `.env` ([`.env.example`](../../.env.example))

Copied to `.env` and loaded once by
[`load-env.ts`](../../src/common/config/load-env.ts), imported first by every
Playwright config entry. **Real environment variables always win** over `.env`
(CI secrets are never overwritten). Validation happens only at this boundary,
through the typed accessors in [`env.ts`](../../src/common/config/env.ts)
(`env`, `requireEnv`, `intEnv`, `boolEnv`).

### Runtime flags

| Var           | Default                | Purpose                                                                 |
| ------------- | ---------------------- | ----------------------------------------------------------------------- |
| `REPORT_MODE` | _(unset)_ → self-contained | `rich` → external attachments + embedded trace viewer (serve over http). |
| `RUN_ID`      | auto-stamped           | Per-run report token; pin to share one token across a batch.            |
| `CI`          | _(unset)_              | Non-empty enables CI config (retries, `forbidOnly`).                    |
| `PRODUCT`     | `wp-rocket`            | Default product for the bare `playwright.config.ts`.                    |
| `REPORT_ROOT` | `reports`              | Report artifact root (accumulates).                                     |
| `OUTPUT_ROOT` | `test-results`         | Ephemeral Playwright artifact root.                                     |
| `AUTH_ROOT`   | `.auth`                | Ephemeral `storageState` root.                                          |
| `ARTIFACTS_ROOT` | `.artifacts`        | Resolved plugin-zip root (**wiped & rebuilt each run**; see Plugin artifacts). |

### Plugin artifacts (build & verify)

Which plugin zips a run resolves, builds (via [APVM](https://github.com/wp-media/automation-plugin-version-manager)),
and verifies. Two **roles** per product: `plugin` (the artifact under test) and
`previous` (an older artifact some tests compare against — e.g. an update path).
Full model and rationale:
[plugin-artifact-management-plan.md](../plans/plugin-artifact-management-plan.md).

| Var                    | Applies              | Purpose                                                                      |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `E2E_PLUGIN_REF`       | `plugin` (a ref)     | APVM ref to build the artifact under test (branch/tag/commit/PR/`release:*`). |
| `E2E_PLUGIN_ZIP`       | `plugin` (a zip)     | Path to a prebuilt zip of the artifact under test (absolute or repo-relative). |
| `E2E_PREVIOUS_REF`     | `previous` (a ref)   | APVM ref to build the previous-version artifact.                             |
| `E2E_PREVIOUS_ZIP`     | `previous` (a zip)   | Path to a prebuilt previous-version zip.                                     |
| `E2E_PLUGIN_VERSION`   | `plugin` build       | Version to build with (see version policy below).                           |
| `E2E_PREVIOUS_VERSION` | `previous` build     | Version to build the previous-version artifact with.                        |

Rules (enforced in
[`request.ts`](../../src/common/artifacts/request.ts), unset all → per-product defaults):

- **Ref XOR zip per role.** Setting both `E2E_PLUGIN_REF` and `E2E_PLUGIN_ZIP` (or both
  `PREVIOUS` vars) fails fast — they are mutually exclusive and neither wins by default.
- **Overrides need a cell, named exactly.** On a serial (cell-less) run these are **ignored with
  a warning** and the defaults are used — never a hard failure, so leftover/shared env can't
  abort a broad run. Apply them with `--project=<cell>` (or `--project=artifacts:<cell>`, to
  resolve zips without running scenarios). A wildcard or differently-cased `--project` still
  runs the cell, but counts as a broad selection here and warns instead — spell the cell out.
  No override → defaults.
- **Values are trimmed**, so a stray space in `.env` or a CI YAML block never becomes part of a
  ref or a path. A blank value means "unset".
- **Don't keep a `_ZIP` under `ARTIFACTS_ROOT`.** That tree is ephemeral: each cell's directory
  is wiped whole every time it resolves. Pointing a role at a zip inside *its own* cell's
  directory (e.g. reusing the previous run's build) is rejected up front rather than deleting
  the file; anywhere else under the tree simply disappears the next time that cell runs.
- **Version policy.** BackWPup **requires** a version to build, defaulting to `9.99.99`
  (`plugin`) / `9.99.98` (`previous`) — staggered so `previous` is older; WP Rocket /
  Imagify embed their version, so a `_VERSION` var is optional but, when set, rewrites the
  built artifact's version. A `_VERSION` is ignored (with a warning) alongside a `_ZIP`
  path or a `release:*` ref.
- **Unsupported role.** `E2E_PREVIOUS_*` vars are ignored (with a warning) for a product
  with no `previous` role yet (BackWPup — see the plan's §5).

### Fleet health check (`npm run healthcheck`)

| Var                           | Default | Purpose                                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------------------------ |
| `HEALTHCHECK_CONCURRENCY`     | `4`     | Max sites checked at once within a product (1–32).                             |
| `HEALTHCHECK_LOGIN_TIMEOUT_MS`| `30000` | Per-site UI-login settle budget in ms (1000–300000); raise for slow remotes.  |
| `HEALTHCHECK_HEADED`          | `false` | Run the browser headed (visible). `npm run healthcheck:ui` sets this.          |

### BackWPup storage credentials

Read by [`backwpup.config.ts`](../../src/projects/backwpup/config/backwpup.config.ts)
into the product's `services`; ignored by WP Rocket. Any can be overridden per
site via that site's `overrides` block.

| Var                       | Default       |
| ------------------------- | ------------- |
| `BWP_FTP_HOST` / `BWP_FTP_USERNAME` / `BWP_FTP_PASSWORD` | _(blank)_ |
| `BWP_FTP_PORT`            | `21`          |
| `BWP_FTP_SECURE`          | `true`        |
| `BWP_S3_ACCESS_KEY_ID` / `BWP_S3_SECRET_ACCESS_KEY` / `BWP_S3_BUCKET` | _(blank)_ |
| `BWP_S3_REGION`           | `us-east-1`   |

## Local WordPress via Docker

[`docker/`](../../docker/) provides a self-contained environment for the `docker`
transport (Apache on `:8100`, Nginx on `:8101` over one MariaDB). Point a product
at it by copying [`docker/sites.example.json`](../../docker/sites.example.json)
into the product's `sites.json`. See the README's
"Local WordPress (Docker)" section for commands (`env:up` / `env:down` /
`env:logs`).
