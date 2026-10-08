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

The top-level keys are **cell names** (`apache`, `nginx`, `pro@nginx`, …). A name
starts with a lowercase letter or digit and holds only lowercase letters, digits, `@`,
`.`, `_` and `-`, checked at load. It names folders, so it must be one safe path
segment. It also names Playwright projects, whose `--project` filter ignores case.
Names starting with `_` are kept for the suite's own folders (`_all`, `_unit`). A cell
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

| `mode`   | Required fields                                 | Optional fields                                 |
| -------- | ----------------------------------------------- | ----------------------------------------------- |
| `local`  | `rootDir`                                       | `stagingDir`, `elevate`, `fileOwner`            |
| `docker` | `container`                                     | `rootDir`, `stagingDir`, `elevate`, `fileOwner` |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir` | `stagingDir`, `elevate`, `fileOwner`            |

- `rootDir` is the WordPress root (the directory holding `wp-load.php`), and the
  working directory every WP-CLI command runs in. It is **optional for `docker`**
  only because the container's `WORKDIR` already is that root; declare it to skip the
  one-off `pwd` lookup, or when a custom image's `WORKDIR` differs.
- `stagingDir` overrides where test artifacts (plugin zips, imports, dumps) are
  copied **on that site** — absolute, or relative to `rootDir`. It beats the global
  `E2E_SITE_STAGING_DIR`; both default to `.e2e_temp` under the WordPress root. It
  must be a **dedicated** directory (cleanup removes it whole), so the WordPress root
  itself, any ancestor of it, and top-level paths like `/var` are rejected. See
  [wordpress-automation.md](../architecture/wordpress-automation.md#site-staging--file-transfer-wpstagingts).
- `elevate` (default: allowed) controls whether **cleanup** may re-run a command with
  privileges when the transport's user is not permitted to finish it. A plugin writes
  files as the web-server user, and some land in directories only that user can write —
  so without this, the site keeps them and grows every run. Cleanup always tries
  unprivileged first and escalates only what survived; `wp` is never elevated. Needs
  passwordless `sudo` for the transport's user on `local`/`ssh` (nothing at all on
  `docker`). Set `false` on a host where that user must stay unprivileged; cleanup then
  reports what it could not remove. See
  [wordpress-automation.md](../architecture/wordpress-automation.md#elevated-housekeeping).
- `fileOwner` (**leave it unset**) overrides who should own the files this suite installs, as
  `"user:group"` — or `false` to switch ownership normalisation off entirely for that site.

  WP-CLI runs as the transport's user while PHP runs as the web server, so a plugin the suite
  installs lands owned by someone the web server is not, and its next admin request cannot write
  it. That is fixed automatically: the ownership the install *already uses* is read from
  `wp-content` and restored afterwards. Detection is correct wherever a site is consistently
  owned — including hosts where the owner is a deployment account rather than the web-server
  user — so this exists only for a site where it is not.

  **Both halves are required**, and both the type and the shape are rejected **at load**, by name,
  like every other site field: `"www-data"` (group omitted), `"a:b:c"` and a value with spaces all
  fail immediately with the offending value quoted; a non-string such as `5` or `true` fails naming
  the field and the rule, since quoting a value that has no readable spelling helps nobody. The
  group is load-bearing —
  on a host whose docroot owner is not the web-server user, the shared group is the web server's
  only write access — so it is never guessed at.

  Validating here rather than later is deliberate: ownership normalisation never fails a run, so a
  shape checked only at run time would be warned about once and then silently ignored for the whole
  suite, on exactly the site somebody was trying to fix. The same rule is enforced again before any
  privileged command is composed, so the two can never disagree.

  Either half may be a **bare numeric id** (`"33:33"`, or a mix such as `"www-data:33"`), for a host
  whose passwd database cannot map the name. A numeric half is compared as the id it is: `stat`
  reports the *name* for an id it can map, so treating `33` as a name would make every successful
  `chown` read back as a failure — and would make the tree world-writable for a reason that is not
  true, because the transport user would look like a non-member of its own group.

  Normalisation also needs privileges (`chown` always does), so a site with `elevate: false` or
  no passwordless `sudo` reports that it cannot and carries on. See
  [wordpress-automation.md](../architecture/wordpress-automation.md#file-ownership-wpownershipts).

## Editions (Free / Pro)

For products shipped as two packages (BackWPup), a cell declares `edition`.
Editions are **all-or-none across a product's cells**: if any cell declares one,
every cell must — so an edition-ful product can never silently run an
edition-less cell. The config factory turns a cell's edition into a Cucumber tag
filter (`pro` → `not @free`, `free` → `not @pro`).

**Edition vs. variant.** `edition` (our binary Free/Pro _behavioral_ tier) is distinct
from an APVM build **variant** (`free`/`pro-de`/`pro-en`). Edition is language-blind and
drives scenarios/POM; a variant is the exact package APVM builds. The artifacts manifest
maps each edition to the single variant it builds (`pro` → `pro-en`) — see
[plugin-artifacts.md](../architecture/plugin-artifacts.md).

## `.env` ([`.env.example`](../../.env.example))

Copied to `.env` and loaded once by
[`load-env.ts`](../../src/common/config/load-env.ts), imported first by every product
Playwright config and script (healthcheck, artifact warm, fixture capture, `report`,
`report:allure`) — never by the unit config — from the **working directory**. **Real
environment variables always win** over `.env`, even blank ones (CI secrets are never
overwritten). Every key is loaded, unknown ones included; a malformed line is skipped. A
`.env` that exists but cannot be read (a directory, no permission, a link to a missing
file) fails the run naming it; a missing one is fine. Validation happens only at this boundary,
through the typed accessors in [`env.ts`](../../src/common/config/env.ts)
(`env`, `requireEnv`, `intEnv`, `boolEnv`).

### Runtime flags

| Var           | Default                | Purpose                                                                 |
| ------------- | ---------------------- | ----------------------------------------------------------------------- |
| `E2E_LOAD_DOTENV` | `true`              | `false`/`0` **in the environment** skips `.env` entirely, in every process of the run — for a caller that hands the run its whole environment (the orchestrator). Any other value but `true`/`1`/blank fails the run naming it. Set inside `.env` it has no effect (the file is already being read) and a warning says so — once per process that reads the file, so `npm run test:*` (`bddgen`, then the runner) prints it twice. |
| `REPORT_MODE` | _(unset)_ → self-contained | `rich` → external attachments + embedded trace viewer (serve over http). |
| `RUN_ID`      | auto-stamped           | Per-run report token; pin to share one token across a batch.            |
| `CI`          | _(unset)_              | Non-empty enables CI config (retries, `forbidOnly`).                    |
| `E2E_CELL`    | _(unset)_ → no pin     | Pins the run — `bddgen`, the runner, its workers — to one cell of the product: the config holds that cell alone, so `bddgen` regenerates only its specs and cells can run side by side. Exact name; blank means unset. A name the product lacks, or a `--project` selecting none of the cell's projects, fails naming the variable. **Pass it per command, never in `.env`**, which would pin every run started from that folder. Ignored by the healthcheck and the artifact warm, which span cells by design. |
| `PRODUCT`     | `wp-rocket`            | Product for the bare `playwright.config.ts`: a name listed in [`products.ts`](../../src/projects/products.ts) (whitespace ignored). Any other name fails the run. |
| `REPORT_ROOT` | `reports`              | Report artifact root (accumulates).                                     |
| `OUTPUT_ROOT` | `test-results`         | Ephemeral Playwright artifact root: `<product>/<cell>` for a run targeting that cell, `<product>/_all/<cell>` for any other run, `_unit` for unit tests. |
| `AUTH_ROOT`   | `.auth`                | Ephemeral `storageState` root.                                          |
| `ARTIFACTS_ROOT` | `.artifacts`        | Resolved plugin-zip root (**wiped & rebuilt each run**; see Plugin artifacts). |
| `E2E_SITE_STAGING_DIR` | `.e2e_temp`   | Where artifacts are staged **on each site** (absolute, or relative to its WordPress root). A site's own `transport.stagingDir` wins over this. |

### Plugin artifacts (build & verify)

Which plugin zips a run resolves, builds (via [APVM](https://github.com/wp-media/automation-plugin-version-manager)),
and verifies. Two **roles** per product: `plugin` (the artifact under test) and
`previous` (an older artifact some tests compare against — e.g. an update path).
Full model and rationale:
[plugin-artifacts.md](../architecture/plugin-artifacts.md).

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
  abort a broad run. Apply them to a run of one cell: `E2E_CELL=<cell>`, or
  `--project=<cell>`. To resolve the zips without running scenarios, select
  `--project=artifacts:<cell>` alone (with or without the pin). Without a pin, a wildcard or
  differently-cased `--project` still runs the cell, but counts as a broad selection here and
  warns instead — spell the cell out.
  No override → defaults.
- **Values are trimmed**, so a stray space in `.env` or a CI YAML block never becomes part of a
  ref or a path. A blank value means "unset".
- **Don't keep a `_ZIP` under `ARTIFACTS_ROOT`.** That tree is ephemeral: each cell's directory
  is wiped whole every time it resolves. Pointing a role at a zip inside *its own* cell's
  directory (e.g. reusing the previous run's build) is rejected up front rather than deleting
  the file; anywhere else under the tree simply disappears the next time that cell runs.
- **Version policy.** BackWPup **requires** a version to build; its `plugin` role defaults to
  `9.99.99` (a `previous` role, when added, gets its own default one patch lower so it is
  always the older artifact). WP Rocket / Imagify embed their version, so a `_VERSION` var is
  optional but, when set, rewrites the built artifact's version. A `_VERSION` is ignored (with
  a warning) alongside a `_ZIP` path or a `release:*` ref.
- **Unsupported role.** `E2E_PREVIOUS_*` vars are ignored (with a warning) for a product with
  no `previous` role yet (BackWPup — see
  [plugin-artifacts.md](../architecture/plugin-artifacts.md#deferred-obligations)).

### Fleet health check (`npm run healthcheck`)

| Var                           | Default | Purpose                                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------------------------ |
| `HEALTHCHECK_CONCURRENCY`     | `4`     | Max sites checked at once within a product (1–32).                             |
| `HEALTHCHECK_LOGIN_TIMEOUT_MS`| `30000` | Per-site UI-login settle budget in ms (1000–300000); raise for slow remotes.  |
| `HEALTHCHECK_HEADED`          | `false` | Run the browser headed (visible). `npm run healthcheck:ui` sets this.          |

### BackWPup storage credentials

Read by [`backwpup.config.ts`](../../src/projects/backwpup/config/backwpup.config.ts)
into the product's `services`; ignored by WP Rocket. Any can be overridden per
site via that site's `overrides` block. They come from the environment or `.env` alike;
with `E2E_LOAD_DOTENV=false`, only from the environment.

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
