# Site File Ownership Plan — keep the docroot writable by both users

**Status:** **Complete** — Phases 0–6.5 done (2026-08-26). After five audit rounds, verified against
both real cells, both `docker` containers, and the **full BackWPup suite green on both cells**
(13 passed each, `--retries=0`) on 2026-08-28.
**Owner:** Sandy Figueroa.
**Scope:** `src/common/wp/` (a new ownership primitive), the plugin lifecycle, pre-flight
reporting, and the `sites.json` transport schema. Linux targets only — see §2.7.

## TL;DR

On an `ssh` cell, WP-CLI runs as the transport's user (`ubuntu`) and PHP runs as the web
server (`www-data`). Every file the suite installs therefore lands owned by `ubuntu`, and
the web server cannot write inside it. This plan adds **one primitive** —
`normalizeOwnership(transport, path)` — that restores the site's own ownership convention
after the suite writes into the docroot, detecting the correct owner from the install
itself rather than assuming `www-data`. It never fails a run, and it is a no-op on
correctly-configured targets (including every `docker` cell).

---

## 1. Verified foundations

Everything below was measured on the two live BackWPup cells on **2026-08-26**. Nothing
here is inferred.

### 1.1 The two cells

| | `pro@nginx` — `simple.e2e.rocketlabsqa.ovh` | `pro@apache` — `auto-e2e-backwpup-apache.rocketlabsqa.ovh` |
| --- | --- | --- |
| Transport user | `ubuntu` (uid 1000, gid 1000) | `ubuntu` (uid 1000, gid 1000) |
| In `www-data` group? | **yes** (gid 33) — see §1.10 | **yes** (gid 33) |
| Web/PHP process user | `www-data` (nginx + php-fpm) | `www-data` (apache2 + php-fpm) |
| **Docroot owner** | **`www-data:www-data`** | **`sftp_backwpup:www-data`** (uid 1001) |
| Docroot mode | `777` throughout | `777` throughout |
| Passwordless `sudo` | yes | yes |
| `stat` | GNU coreutils 9.4 | GNU coreutils 9.4 |
| WordPress | 7.1 | 7.1 |

**The docroot owner is not the web-server user on `pro@apache`.** This single fact
invalidates the obvious design ("chown to `www-data:www-data`"): doing so would strip
`sftp_backwpup` — the host's SFTP deployment user — off the entire tree.

### 1.2 The bug, reproduced on both cells

The suite runs with `umask 0002`. Creating a directory under `wp-content/plugins` as
`ubuntu` yields `ubuntu:ubuntu 775` (dirs) / `ubuntu:ubuntu 664` (files). Then:

```
sudo -u www-data touch <that dir>/from_web.php
→ Permission denied          # on BOTH cells
```

That is the whole failure: any admin-request write into the installed plugin's own
directory, and any plugin update or delete through WP admin, fails.

**It is a raw `EACCES` inside `WP_Filesystem_Direct`, not an FTP-credentials prompt.**
Read from WP 7.1 core on the cell, `get_filesystem_method()` compares
`fileowner(wp-admin/includes/file.php)` against a temp file it creates in the context
directory — both are `www-data`, so WordPress still selects `direct`. The method choice is
correct; the subsequent filesystem call is what is denied.

### 1.3 `chown` always needs root

```
chown www-data:www-data <file>        → Operation not permitted   (both cells)
sudo -n chown www-data:www-data <file> → ok                        (both cells)
```

So the capability is gated on the existing `elevationSupport(transport) === "available"`.
Where elevation is unavailable there is nothing to fall back *to* — a guessed owner cannot
be applied either. This is why the fallback in the original proposal is dropped (§2.6).

### 1.4 The trap in a naive chown: it breaks the uninstall path

Chowning the plugin to the web user at its natural mode locks the *transport* user out —
which is who runs `wp plugin uninstall`. Measured on `pro@nginx`, where `ubuntu` is not in
`www-data`:

| Directory state | `ubuntu` can write inside | `ubuntu` can `rmdir` |
| --- | --- | --- |
| `www-data:www-data 775` | **denied** | **denied** |
| `www-data:www-data 777` | ok | ok |

So ownership alone is not the fix. The invariant is **both users must be able to manage the
tree**, which needs a mode grant alongside the chown (§2.3).

### 1.5 Why not "run WP-CLI as the docroot owner" instead

Tested, and rejected on evidence:

- **No single correct user.** On `pro@apache` the docroot owner is `sftp_backwpup`, whose
  primary gid is 123 and whose `umask` is `0022`. Running WP-CLI as it would create
  `sftp_backwpup:sftp_backwpup 755` files — which `www-data` cannot write. Strictly worse
  than today.
- **`$HOME` is broken for both candidates.** `sudo -u` sets the target's home:
  `HOME=/var/www` (nginx) and `HOME=/public` (apache — a path that does not exist).
  WP-CLI resolves its cache dir under them (`/public/.wp-cli/cache`).
- **Blast radius.** It changes how *every* WP-CLI call runs, at once, to fix a problem
  confined to file creation.

`sudo -n -u <owner> wp core is-installed` does exit `0` on both cells (including for the
`nologin` `sftp_backwpup`), so the mechanism works — it is the semantics that do not.

### 1.6 `docker` is already correct and must stay untouched

[`docker/docker-compose.yml:84`](../../docker/docker-compose.yml#L84) pins the wp-cli
containers to `user: "33:33"`, matching the `wordpress` containers' file ownership. The
running user already *is* the owner, so the fast path in §2.4 makes this plan a complete
no-op there.

### 1.7 Prerequisite bug found while verifying (not caused by this work)

`pro@apache` in `src/projects/backwpup/config/sites.json` declares
`rootDir: /var/www/auto-e2e-backwpup-apache.rocketlabsqa.ovh/`, which contains no
WordPress. The install is one level down, in `public/`. Verified: `wp core is-installed`
exits `1` ("This does not seem to be a WordPress installation") from the declared path and
`0` from `public/`, so that cell could not pass pre-flight. **Fixed and re-verified on
2026-08-26** (Phase 0) — `wp core is-installed` now exits `0` and `siteurl` matches the
cell's `baseURL`. It was a prerequisite because Phase 6 cannot verify the apache branch
against a cell that does not boot.

### 1.8 What a non-interactive `sudo` probe can and cannot tell us

Measured on both cells, including the negative case (captured by running the probe as
`www-data`, which is not a sudoer):

| Probe | Passwordless sudoer | Non-sudoer | Verdict |
| --- | --- | --- | --- |
| `sudo -n true` | exit `0` | exit `1`, `sudo: a password is required` | **usable** |
| `sudo -n -l` | exit `0`, lists `(ALL) NOPASSWD: ALL` | exit `1`, `sudo: a password is required` | usable, but adds nothing |
| `sudo -n -v` | **exit `1`, `sudo: a password is required`** | exit `1`, same message | **unusable — false negative** |

Two consequences, both load-bearing for §2.11:

- **`sudo -n -v` must never be used.** It reports failure on both cells *even though
  passwordless sudo demonstrably works there* — `-v` validates the credential cache rather
  than testing a command. `elevationSupport` already uses `sudo -n true`, which is correct.
- **"Not a sudoer" and "sudoer, but a password is required" cannot be distinguished
  non-interactively.** sudo emits the identical `sudo: a password is required` for both, by
  design, so it does not leak who is a sudoer. (`sudo -n -v` does print
  `Sorry, user … may not run sudo on …` for a non-sudoer, but it is unusable per the row
  above.) The remedy is the same either way, so pre-flight reports **one** state and names
  both possible causes rather than guessing between them.

**Known limitation, documented rather than engineered around:** a host granting `NOPASSWD`
for a *specific command list* that excludes `true` would fail this probe while still
permitting `chown`. Both cells grant `(ALL) NOPASSWD: ALL` (read from `/etc/sudoers.d/`),
and a partial grant is not a configuration this fleet uses.

### 1.9 Symlinks: recursion is safe, one operand is not

`chown -R` and `chmod -R` are about to run as root over a tree this suite did not author, so
whether they follow a symlink out of it is a security question, not a detail. The first
measurement covered only links found **during recursion** and concluded "they do not escape".
Re-measured on 2026-08-27 against a **root-owned** target outside the tree (the earlier probe used
a target the test user already owned, so it could not tell "not followed" from "already correct"),
and adding the case it had missed — the link passed **as the operand**:

| Command | Operand is a link | Link found during recursion |
| --- | --- | --- |
| `chmod -R` | **followed** — target went `0700` → `0707` | not followed |
| `chown -Rh` | not followed — the link is chowned, target stays `root:root` | not followed |
| `rm -rf` | not followed — removes the link, target intact | not followed |

GNU coreutils 9.4, Ubuntu kernel 6.8. `-P` (*do not traverse any symbolic links*) is the default
under `-R` for both, which is what makes the right-hand column safe; `-h` is what additionally makes
`chown` safe on the operand. **`chmod` has no equivalent flag**, so that one cell is closed by
refusing a symlink operand instead (§10).

### 1.10 Group membership is host state, and it varies

`sudo usermod -aG www-data ubuntu` was applied across the fleet on 2026-08-26. Final state,
confirmed from fresh SSH sessions:

```
qa-auto-e2e-apache: www-data:x:33:sftp_backwpup,sftp_wprocket,ubuntu
qa-lnmp:            www-data:x:33:ubuntu
```

Both cells now take the narrow `g+rwX` branch (§2.3). Worth recording *how* that landed,
because it is the argument for detecting rather than configuring: an earlier check the
same day found `qa-lnmp` with `www-data:x:33:` — **no members at all** — and the change had
to be reapplied. A membership that can silently be absent is not something to encode in
`sites.json`.

The fleet is also expected to stay mixed in general ("will try to do this in all the
servers, but not guaranteed"). So §2.3 **measures** membership per target on every run: the
grant narrows to `g+rwX` wherever the membership exists and falls back to `o+rwX` where it
does not, with no config change and no code change either way. Verified that a fresh SSH
session picks the new membership up immediately (`id -nG` in-session), which is what the
suite gets — node-ssh opens new sessions.

**Testing consequence:** with both cells on the group branch, no cell exercises `o+rwX` in
its normal state. Rather than leave that branch hardware-unverified, the operator has
authorised temporarily removing the membership to exercise it — see Phase 6, step 5.

---

## 2. Design

### 2.1 The invariant

> After the suite writes files into the site's docroot, **both the transport's user and the
> web-server user must be able to read, write and delete them**, and the files must carry
> the site's own ownership convention.

### 2.2 Detect the owner — from the install, never from the process table

The probe is the ownership of `wp-content`, falling back to the WordPress root:

```
stat -c '%U:%G:%u:%g' <root>/wp-content
→ www-data:www-data:33:33              (nginx)
→ sftp_backwpup:www-data:1001:33       (apache)
```

Correct on both cells. Probing the web-server *process* user (`ps`) returns `www-data` on
both and is therefore wrong on `pro@apache` (§1.1). Numeric uid/gid are captured alongside
the names so a target whose passwd database does not map the id still works — `chown`
accepts numerics.

`wp-content` is the probe target because it is the directory plugins actually write to, and
pre-flight has already asserted a booting WordPress by the time anything calls this.

### 2.3 Grant the transport user continued access — additively, least-privilege

After the chown, the transport user is no longer the owner, so it needs an explicit grant.
The scope is **decided from measured group membership**, not assumed:

| Condition | Grant applied |
| --- | --- |
| Transport user is the target owner **or** a member of the target group | `chmod -R ug+rwX` |
| Neither | `chmod -R ug+rwX,o+rwX` |

`ug+rwX` is applied in **both** branches, which is a correction to this table's first draft. After
the chown, owner and group are exactly the pair the docroot itself uses, and on a host where those
are two different accounts — `sftp_backwpup` owning, `www-data` in the group — the group half is the
**web server's only access**. Granting it to the transport user alone would have fixed the wrong
user. `o+rwX` is then added only when the transport user is neither, so it can still remove what it
installed.

A tree that already has it right is never touched at all: when the transport user's uid *and* gid
both equal the target's, `normalizeOwnership` returns `unnecessary` before asking about
privileges — the `docker` case, where wp-cli runs as `33:33`.

Both cells take the group branch as of 2026-08-26 (`ubuntu` ∈ `www-data` on each), so
neither exercises `o+rwX` on real hardware — the scope is measured per target on every run,
never configured, and a host that loses or never gains the membership falls back
automatically (§1.10). Two properties make this safe:

- **Additive only** (`+`, never `=`). The suite can never tighten a host's permissions or
  lock anyone out of anything, and repeated runs are idempotent.
- **`X`, not `x`** — execute is set on directories and on files that already carry an
  execute bit, so PHP files are not made executable.

The `o+rwX` branch is world-writable, and that is stated plainly rather than hidden: it
matches these cells' existing state exactly (every file on both is already `777`) and
mirrors the reasoning already recorded for `DATA_DIR_MODE = "0777"` in
[`residue.ts`](../../src/common/wp/residue.ts). It is also **avoidable**, so taking that
branch emits a one-time, actionable notice naming the fix:

```
[wp/ownership] granted world-write on wp-content/plugins/backwpup-pro: the transport user
`ubuntu` is not a member of `www-data`, the group owning this site's files. Add it
(`usermod -aG www-data ubuntu`) to keep the grant group-scoped.
```

### 2.4 The primitive

```ts
normalizeOwnership(transport, sitePath): Promise<OwnershipOutcome>
```

`sitePath` is **relative to the WordPress root** (§2.5). Steps 1–3 are `planOwnership`,
which pre-flight also calls to *report* what will happen (§2.11); the rest is
`normalizeOwnership` carrying it out. Each step is attempted only because the previous one
demonstrably required it:

1. Resolve the target: `transport.fileOwner` if declared, else the detection in §2.2.
   `fileOwner: false` → `"disabled"`; an unusable `fileOwner` → `"failed"`, reported loudly.
2. No target, or no readable transport identity → warn once per site, `"skipped"`.
3. **Fast path:** the transport user's uid **and** gid already match the target →
   `"unnecessary"`, with no `sudo`, no `chown`, no `chmod`. This is the `docker` and
   well-configured-`local` answer, and it honours the "attempted second, never first"
   doctrine. (Both halves are required: a matching uid under a different gid still needs
   fixing.)
4. `elevationSupport !== "available"` → warn once per site, `"skipped"`.
5. **The mode grant from §2.3, first** — `chmod -R -- <mode> <abs>` (elevated).
6. **Then** `chown -Rh -- <user>:<group> <abs>` (elevated). This order is load-bearing, not
   stylistic: the commands commute in their final effect but not in their intermediate one,
   and chowning first would leave the tree owned by the site's user with no grant yet —
   locked away from the very user that must later uninstall it. Granting first means a
   failed `chown` leaves the tree exactly as it was. `--` ends option parsing in both, so a
   mistyped owner beginning with a dash cannot reach root as a *flag* (§6.3); `-h` acts on a
   symlink rather than its target (§1.9).
7. **Verify** by re-running the `stat` probe against `<abs>` and comparing — never inferred
   from `chown`'s exit code, matching the discipline in `residue.ts`.
8. Return the outcome. **This function never throws.** (`pluginSitePath` does, but only
   before anything is staged — see §2.9.)

```ts
type OwnershipOutcome =
  | "normalized"   // chown (and any grant) applied and verified
  | "unnecessary"  // the transport user already owns it
  | "skipped"      // no target detected, or no elevation — warned once
  | "disabled"     // transport.fileOwner === false
  | "failed";      // a step failed or verification disagreed — warned, run continues
```

Caches (detection, identity, the one-time notices) are keyed per **install** —
`installKey`, a sibling of the `targetKey` `elevationSupport` uses. The distinction is not
pedantry: passwordless sudo is a property of a host and a user, but file ownership is a
property of a *site*, and one host routinely serves several. Measured on the apache cell,
two docroots under the same `ubuntu@host`: `sftp_backwpup:www-data` and
`sftp_wprocket:www-data`. Keyed by host alone, whichever was probed first would answer for
both — a misreported fleet check, and a privileged `chown -R` aimed at another site's owner
in any process that normalised two sites.

### 2.5 Path safety — this runs as root, so the guard is not optional

`chown -R` / `chmod -R` under `sudo` on an unvalidated path is the one genuinely dangerous
thing in this plan. Mitigation:

- The parameter is **relative to the WordPress root**, so a stray leading `/` cannot
  escape; the absolute path is composed internally from `wpRootDir(transport)`.
- It is validated by the **same guard residue removal already uses** — rejecting empty,
  absolute, backslash, `.`/`..`, `../` escapes, and the `PROTECTED_PATHS` list (the WP root
  itself, `wp-admin`, `wp-includes`, `wp-content`, `wp-content/plugins`, …). Chowning
  `wp-content/plugins/<slug>` is allowed; chowning `wp-content/plugins` is not.
- To avoid two copies of a root-privileged guard, `normaliseResiduePath` /
  `residueRejection` / `PROTECTED_PATHS` move to a new shared `src/common/wp/paths.ts` as
  `normaliseSitePath`, re-exported from `residue.ts` so nothing else changes.
- Commands stay file + args arrays, as everywhere in this layer — no shell string, no
  injection surface. `transport.fileOwner` is still validated for shape so a typo produces
  a clear error rather than an opaque `chown` failure.

### 2.6 Failure policy — never fail a run, never guess an owner

The run continues in every failure mode. But the `www-data:www-data` fallback from the
original proposal is **dropped**, for three reasons:

1. It is wrong on `pro@apache` (§1.1), and a wrong owner applied *with root* is worse than
   no chown at all.
2. Detection cannot realistically fail alone — pre-flight already asserts rootDir access
   and a booting WordPress, so a `stat` that cannot answer means three louder checks
   already failed.
3. The real failure mode is missing elevation, and there a fallback *value* is unusable —
   nothing can apply it (§1.3).

So: detection fails → warn and skip. Elevation missing → warn and skip. `chown` fails or
verification disagrees → warn and continue. Every warning names the site, the path, and
the override that resolves it.

### 2.7 Linux only, deliberately

`stat -c` is GNU/busybox syntax; BSD/macOS needs `stat -f`. Targets are Linux 100% of the
time, so the plan does not carry a portability layer it would never exercise. The `stat`
invocation is confined to a single function so a future BSD branch is a local change, and
that constraint is stated in the module header.

### 2.8 The site override

Added to `TransportBase` (mode-independent, beside `stagingDir` and `elevate`):

```ts
readonly fileOwner?: string | false;
```

`"user:group"`, or `false` to opt out entirely — mirroring `elevate: false`. Precedence:
**declared → detected → skip**.

**A bare `"user"` is rejected**, which is a change from this section's first draft. The group is
load-bearing (see §2.3: on a host whose docroot owner is a deployment account, the group is the web
server's only access), so leaving it implicit would let an override silently fix one user and not
the other — in exactly the configuration an override is most likely reaching for. A malformed value
is reported loudly and returns `failed`; it is our configuration error, not the host's.

### 2.9 Where it gets called

| Write path | Action |
| --- | --- |
| `stageAndInstallPlugin` | **the single call site.** An optional `slug` turns on normalisation of `wp-content/plugins/<slug>` right after the install. Putting it here rather than in the hook means any direct caller is covered by the same code |
| `installPluginUnderTest` (the `@plugin` hook) | passes `artifact.slug` through; it does **not** call `normalizeOwnership` itself. One call site, not two |
| `stageArtifact` → `.e2e_temp/**` | **no** — only the transport user ever reads it, and `wp plugin install` runs as that user. Documented so the omission reads as a decision |
| `prepareSiteDataDirs` | keeps `0777` as a floor (§5) and **now normalises ownership too** (§9); **gained the root-plausibility guard** it was missing: it escalates, so it needs the same check removal has (§7.4) |

The slug is turned into a path by `pluginSitePath` in `paths.ts`, which requires a **single
segment** — `posix.join` would otherwise resolve `..` back out of `wp-content/plugins` into a
directory WordPress owns, and the result is composed into a path a privileged `chown -R` acts
on. It is evaluated **before** anything is staged or installed, so an unusable slug — our own
mistake — fails clean rather than aborting with the plugin half in place. It is the one throw
on this path, and deliberately so.

### 2.10 Where the detected value lives

**Lazily memoized per worker process, not persisted.** Pre-flight runs in the Playwright
*setup project* process while scenarios run in *worker* processes, so an in-memory value
set at pre-flight cannot cross that boundary, and persisting it (à la `resolution.json`)
buys a file lifecycle and a staleness window for no gain: the probe is one `stat` over an
already-pooled SSH connection, once per worker per site. Pre-flight therefore **reports**
the ownership (§Phase 3) without being the source of truth.

### 2.11 Pre-flight must say — loudly — when elevation is unavailable

Elevation is a silent dependency today: `elevationSupport` probes it lazily, deep inside a
teardown, and a host without it degrades quietly (residue is left behind, `debug.log` may
not clear, and under this plan ownership is not normalized). That is exactly the class of
problem an operator should learn about at the *start* of a run, not from a disk-full alert
weeks later.

**The probe already exists** — `elevationSupport(transport)` runs `sudo -n true` once per
target and caches the result ([`exec.ts`](../../src/common/wp/exec.ts#L335)). Pre-flight
reuses it; it does not add a second probe, and per §1.8 it must not switch to `sudo -n -v`
or try to distinguish the two negative causes.

Three states, three very different treatments:

| `ElevationSupport` | Treatment |
| --- | --- |
| `available` | a passing `✓ Elevation` check line, no banner |
| `disabled` (`transport.elevate: false`) | a passing check line noting it is **deliberate**, no banner — the operator already chose this |
| `unavailable` | passing check line **plus** the banner below |

**The banner.** Emitted **once per run**, after the per-site lines, listing every affected
site. Requirements, as asked:

- A blank line **above and below**, plus blank lines inside separating the cost from the
  remedy, so it cannot be lost in tightly-packed output.
- Colour via `styleText` from `node:util` — already the convention in
  [`preflight.ts`](../../src/common/setup/preflight.ts) and
  [`healthcheck.ts`](../../healthcheck.ts). Bold yellow for the rule and heading (warning,
  not error — nothing has failed), the site list plain, the remedy lines with the existing
  yellow `→` marker.
- It **never fails the run** and never changes a site's pass/fail verdict.
- It names both possible causes (§1.8), the concrete cost, and both remedies.

```text
                                          ← blank line

  ⚠  ELEVATION UNAVAILABLE — cleanup will be incomplete on 1 of 2 site(s)

     simple.e2e.rocketlabsqa.ovh  [ssh: ubuntu@51.91.147.85]

     `sudo -n true` failed for this transport's user. Either it is not a sudoer, or
     sudo requires a password — sudo reports both identically, so this cannot tell
     them apart.

     What this costs on this site:
       • plugin file ownership is NOT normalized → the web server cannot write into
         the plugin it is testing
       • leftover plugin data is NOT removed → the site accumulates it every scenario
       • `debug.log` may not be clearable between scenarios

     → grant passwordless sudo:  ubuntu ALL=(ALL) NOPASSWD:ALL   (in /etc/sudoers.d/)
     → or accept it deliberately: set `transport.elevate: false` on this site to
       silence this warning and keep the suite unprivileged.

                                          ← blank line
```

**Where it is emitted from.** `verifyPool` currently `return`s early and prints *nothing*
when every site passes, so the banner cannot ride the failure report — it needs its own
emission (`console.warn`) before that early return, and the same shared renderer is called
from `healthcheck.ts`. One renderer, two call sites; it takes the results and returns a
string, so it is unit-testable without a terminal.

---

## 3. File & directory structure

As built (Phases 1–4):

```text
src/common/wp/
├── paths.ts            NEW — normaliseSitePath, assertSafeElevatedTarget, pluginSitePath,
│                             PROTECTED_SITE_PATHS. Every guard a privileged command relies on.
├── paths.spec.ts       NEW
├── ownership.ts        NEW — planOwnership (the decision) + normalizeOwnership (carries it out),
│                             detection, identity, the grant rule
├── ownership.spec.ts   NEW
├── residue.ts          delegates both guards to paths.ts; behaviour unchanged
├── exec.ts             exports targetKey + describeTarget, so caches and messages agree
└── staging.ts          stageAndInstallPlugin takes an optional `slug` and normalises after install

src/common/setup/
├── elevation-report.ts       NEW — the pure banner renderer
├── elevation-report.spec.ts  NEW
└── preflight.ts              "File ownership" + "Elevation" checks (informational, never fail),
                              SitePreflightResult.elevation, warnAboutElevation

src/common/config/types.ts            TransportBase gains `fileOwner`
src/common/hooks/plugin-lifecycle.ts  installPluginUnderTest passes the artifact's slug
healthcheck.ts                        prints the same banner from the same renderer
```

`planOwnership` is the load-bearing piece of this layout: pre-flight *reports* the decision
and the plugin hook *acts* on it, and both call the same function, so a report can never
describe something other than what will happen.

---

## 4. Implementation phases

Each phase ends green on `npm run typecheck && npm run lint && npm run format && npm run test:unit`.

### Phase 0 — prerequisite: fix the `pro@apache` rootDir — ✅ DONE (2026-08-26)

`rootDir` corrected to `…/auto-e2e-backwpup-apache.rocketlabsqa.ovh/public/` in the
git-ignored `src/projects/backwpup/config/sites.json`.
**Verified on the cell:** `wp core is-installed` exits `0` at the new path,
`wp core version` → `7.1`, and `wp option get siteurl` →
`https://auto-e2e-backwpup-apache.rocketlabsqa.ovh`, matching the cell's `baseURL`.
*Independent of the rest; without it Phase 6 cannot verify the apache branch.*

### Phase 1 — extract the shared path guard — ✅ DONE (2026-08-26)

`src/common/wp/paths.ts` now owns `PROTECTED_SITE_PATHS`, `normaliseSitePath` and
`assertSafeElevatedTarget`. `assertSafeElevatedRemoval` moved too — it was not in the original
scope, but ownership normalisation runs `chown -R` as root against the same joined path, so
leaving the root-plausibility rule behind in `residue.ts` would have meant a second copy of a
root-privileged guard. Each function takes the **caller's own message builder**, so residue's
wording (and its remedy) is byte-identical to before while the rules live in one place.

`residue.ts` keeps `normaliseResiduePath` and `assertSafeElevatedRemoval` as thin wrappers, so
nothing else in the repo changed. Guard cases moved to `paths.spec.ts` (12 tests); `residue.spec.ts`
keeps three that pin the delegation and residue's own vocabulary.

**Verified:** typecheck, lint, format, unit all green; suite went 482 → 494 tests with no failures,
i.e. no coverage lost in the move.

### Phase 2 — the ownership primitive — ✅ DONE (2026-08-26)

`src/common/wp/ownership.ts`: `SiteOwnership`, `OwnershipOutcome`, `OwnershipPlan`,
`planOwnership`, `normalizeOwnership`, `detectSiteOwnership`, plus the pure helpers
`parseOwnerSpec` (validates `transport.fileOwner`), `parseStatOwnership`, `parseIdentity`
and `grantModeFor`. The last two replace the planned `parseGroupMembership` /
`decideGrantScope`: one bare `id` call answers who we are *and* every group we carry, in
both spellings, so the grant decision costs one round-trip instead of three.
`exec.ts` exports `targetKey`, `installKey` and `describeTarget`; `TransportBase` gains
`fileOwner`, **and `sites.ts` validates it** — a typed field the loader drops is not a
feature (§7.1).

**Testing** — follows the `residue.spec.ts` pattern (a real `local` transport over a temp
dir; nothing stubbed where a filesystem fact is what matters):

- Pure helpers exhaustively: valid/invalid `fileOwner` shapes, `stat`/`id` output parsing
  including numeric-only ids, the three grant-scope branches.
- Real `local` transport: the fast path returns `"unnecessary"` when the runner owns the
  tree; `elevate: false` returns `"skipped"` and mutates nothing; the additive `chmod`
  never removes a bit; path-guard rejections.
- `chown` itself cannot be exercised unprivileged, so the specs pin the *decision* and the
  *command shape*, and the real chown is covered by Phase 5 on the cells. Stated in the
  spec header rather than left implicit.

**Done (2026-08-26).** Built as specified, with the two deviations recorded in §2.3 and §2.8
(both are corrections to the plan, not drift). Also added beyond the plan: `resetOwnershipCaches`
for tests, and `describeTarget` exported from `exec.ts` alongside `targetKey` so warnings name a
site exactly as the elevation notices do.

**Verified:** typecheck, lint, format green; 517 passed, 3 skipped. The three skips are the cases
needing GNU `stat -c`, which macOS lacks — they skip loudly rather than passing vacuously, and CI
runs `test:unit` on `ubuntu-24.04`, where they execute.

**Verified on hardware, ahead of Phase 6.** Because the primitive is not wired in yet, the exact
command sequence it composes was rehearsed by hand on `qa-lnmp`: a tree created as `ubuntu` was
confirmed unwritable by `www-data` (the bug), then `chown -Rh www-data:www-data` + `chmod -R
ug+rwX` + the verifying `stat` were run, after which `www-data` could create files **and**
directories inside it, `ubuntu` could still write and delete both its own and the web server's
files, and **no world-write bit was added** (the group branch, since `ubuntu` is now in
`www-data`). The rehearsal directory was removed and its absence confirmed.

### Phase 3 — wire it into the write paths — ✅ DONE (2026-08-26)

`stageAndInstallPlugin` gained an optional `slug` and normalises
`wp-content/plugins/<slug>` right after the install; `installPluginUnderTest` passes
`artifact.slug`. Putting it in the staging helper rather than only in the hook means any
future direct caller is covered by the same code path.

Two refinements over the plan:

- **`pluginSitePath(slug)` lives in `paths.ts`**, not composed at the call site. The literal
  belongs in one place, and it is composed into a path a privileged `chown -R` acts on —
  `posix.join` would happily resolve `..` back out into `wp-content`, so the slug is
  required to be a single segment.
- **The slug is validated before anything is staged or installed.** An unusable one is our
  own mistake; failing on it up front beats aborting a scenario with the plugin half in
  place.

**Verified:** typecheck, lint, format green; 532 passed, 7 skipped. Tests pin the wiring
rather than its absence — that ownership is normalised *as part of* installing, that it is
aimed at **this artifact's** slug (an unusable slug is refused by name, before any `wp` call),
and that an install still succeeds and activates when normalisation cannot be done.

### Phase 4 — pre-flight & healthcheck reporting — ✅ DONE (2026-08-26)

Two additions, both **informational and never-failing**, surfacing in `npm run healthcheck`
and the auth-setup report alike.

**4a — the `File ownership` check.** Run after `WordPress installed`; `detail` reports the
detected owner, whether the transport user matches, and which grant scope §2.3 would take.

**4b — the `Elevation` check and its banner (§2.11).** Reuses `elevationSupport` — no new
probe, and per §1.8 not `sudo -n -v`. Renders `available` / `disabled` / `unavailable` as
three distinct outcomes, and emits the once-per-run banner only for `unavailable`. Extract
the banner into a pure renderer (results in → string out) called from both
`verifyPool` — before its early `return`, which today prints nothing on success — and
`healthcheck.ts`.

**Done (2026-08-26).** One refinement over the plan: rather than let pre-flight
re-implement the ownership decision, `planOwnership` was extracted from
`normalizeOwnership` and both now share it. Reporting and acting cannot drift apart, and
the half that would have drifted is the report — the one nobody can tell is wrong by looking
at the site. `SitePreflightResult` also carries `elevation` as a typed value, so the banner
reads it instead of parsing a detail string back apart.

**Verified against the live fleet.** `npm run healthcheck` on both cells:

```
pro@apache  ✓ File ownership: Installed files will be handed to sftp_backwpup:www-data with `ug+rwX`.
            ✓ Elevation: Passwordless `sudo` is available for housekeeping.
pro@nginx   ✓ File ownership: Installed files will be handed to www-data:www-data with `ug+rwX`.
            ✓ Elevation: Passwordless `sudo` is available for housekeeping.
```

Both report the **group** branch — no world-write — and the owner that is *not* the
web-server user is named correctly on `pro@apache`. No banner printed, which is the correct
output when nothing is wrong. All 7 checks passed on both sites, so the new checks changed
no verdict.

**The `unavailable` banner was forced end to end**, not merely unit-tested: run against a
`local` transport on a machine without passwordless sudo, `verifySite` reported
`elevation: "unavailable"` and `warnAboutElevation` printed the full block — affected site
named, both causes stated, all three costs listed, both remedies given, blank lines above and
below. The renderer additionally has its own spec covering silence for `available`/`disabled`
and the padding.

### Phase 5 — documentation — ✅ DONE (2026-08-26)

- **`CLAUDE.md`** — `ownership` and `paths` added to the `wp/` inventory; a bullet under
  *WordPress automation layer* covering detection, the `chmod`-then-`chown` order and the
  never-throws contract; a new **coding convention**: *never write to a site's docroot
  without restoring its ownership — call `normalizeOwnership` (or pass `slug` to
  `stageAndInstallPlugin`), never `chown`/`chmod` by hand, never run `wp` elevated*; and the
  doc-maintenance table now lists ownership and the path guards as triggers.
- **`docs/architecture/wordpress-automation.md`** — two new sections. *File ownership* covers
  the two-user problem, why the owner is detected rather than assumed (with the measured
  owner table for both cells), the command order and why it is load-bearing, the grant table,
  the `--` and `-Rh` rationale, the never-fails policy, per-install caching, and the MUST for
  future callers. *Path guards* documents `paths.ts`. The residue section also records the
  root guard `prepareSiteDataDirs` gained (§7.4).
- **`docs/guides/configuration.md`** — `fileOwner` added to the transport table for all three
  modes, plus a full entry beside `elevate`: what it is for, why both halves are required, and
  that it needs privileges.

**Deviation, deliberate: the `sites.example.json` files were left alone.** The plan listed a
commented example, but JSON has no comments, and neither `elevate` nor `stagingDir` — the two
existing optional site knobs — appears in them either. Adding only `fileOwner` would make the
rarest knob the only one shown and read as something a fresh checkout normally needs. It is
documented where `elevate` is documented instead.

### Phase 6 — verification on the real cells — ✅ DONE (2026-08-26)

**Both branches of §2.3 are now verified on real hardware**, together with the regression §1.4
warns about.

**Observed during a live `@plugin` scenario (`pro@nginx`).** A sampler on the cell recorded the
plugin directory every 0.3 s while `npm run test:backwpup --project=pro@nginx` ran one tagged
scenario. 99 samples with the directory present:

| Samples | State | Meaning |
| --- | --- | --- |
| 16 | `ubuntu:ubuntu` | the window between `wp plugin install` unpacking and normalisation |
| 82 | `www-data:www-data` | normalised, and holding for the rest of the scenario |
| 1 | dir present, inner file gone | teardown removing it |
| then | absent | **removed entirely, by the transport user, from a tree owned by `www-data`** |

That last line is the §1.4 regression check: chowning the plugin away did **not** cost the
transport user its own uninstall.

**Verified directly against both cells** by driving the real `normalizeOwnership` at a staged
directory (the browser half of a scenario proves nothing extra about ownership, and the link was
unreliable — see below):

| | `pro@nginx` | `pro@apache` |
| --- | --- | --- |
| Detected owner | `www-data:www-data:33:33` | **`sftp_backwpup:www-data:1001:33`** |
| Before | `ubuntu:ubuntu 775/664`, web server **denied** | same |
| Outcome | `normalized` | `normalized` |
| After | `www-data:www-data 775/664` | `sftp_backwpup:www-data 775/664` |
| Web server can write | yes | yes |
| Transport user can delete the web server's file | yes | yes |
| World-write added | **no** (group branch) | **no** (group branch) |

`pro@apache` is the only cell that proves the case the whole detection design exists for: an owner
that is **not** the web-server user.

**`docker` was not exercised** — the Docker daemon is not running on this machine. The fast path is
covered by unit tests, and BusyBox applet compatibility was checked separately (§7.7).

**Environment note, recorded because it cost several runs.** Full-suite runs against `pro@nginx`
failed intermittently on `Timed out while waiting for handshake` and on a login that reached
`/wp-admin/` just after its 15 s deadline. It is **not** the cell and not this work: `ping` measured
**12.5 % packet loss from this machine to `1.1.1.1`**, and one plain `curl` to the cell hit a 40 s
timeout while the next two returned in 0.65 s. `npm run healthcheck` — the same node-ssh — passed
against both cells throughout. A CI runner on a stable link should not see this.

### Phase 6.5 — the `o+rwX` branch, on real hardware — ✅ DONE (2026-08-26)

Carried out exactly as §Phase 6.5 specifies, under the authorisation recorded there.

1. **Pre-state recorded:** `www-data:x:33:ubuntu` on `qa-lnmp` — matching what the procedure said
   to expect, with `ubuntu` the sole member.
2. **Removed:** `sudo gpasswd -d ubuntu www-data` → `www-data:x:33:` (no members), confirmed.
3. **Exercised in a fresh process**, which re-read the membership and confirmed it in-session
   (`ubuntu in www-data: false`) before trusting the result.
4. **The branch fired**, with the notice naming the remedy:

   > granted world-write on "wp-content/plugins/…" because this site's commands run as a user that
   > is neither "www-data" nor a member of "www-data", and it must still be able to remove what it
   > installs. Adding that user to the "www-data" group keeps the grant group-scoped instead.

   Resulting state — and the contrast with the group branch above is the whole point:

   | | group branch (member) | `o+rwX` branch (non-member) |
   | --- | --- | --- |
   | Directories | `775` | **`777`** |
   | Files | `664` | **`666`** — `X`, so still not executable |
   | Web server can write | yes | yes |
   | Transport user can delete the web server's file | yes | **yes** — what keeps uninstall working |

5. **Restored:** `sudo gpasswd -a ubuntu www-data` → `www-data:x:33:ubuntu`, **byte-identical to the
   recorded pre-state**, with `id -nG ubuntu` listing `www-data` again.
6. **Cleaned:** the probe directory and the sampler log were removed and their absence confirmed;
   no `backwpup-pro` and no `.e2e_temp` left on the cell.

The verification script crashed on a network read error (`EADDRNOTAVAIL`) after reporting
`normalized` but before its own cleanup — the lossy link again. Restoration was performed first,
then the leftover directory was inspected (which is how the mode table above was captured) and
removed. The risk §Phase 6.5 names is exactly the one that materialised, and the bounded consequence
it predicted is what happened.

## 5. Deferred work — explicit obligations

- **Non-Linux targets** (§2.7). Revisit only if a BSD/macOS `local` cell appears.
- **`prepareSiteDataDirs` mode tightening.** `0777` is now a **floor** rather than the whole
  mechanism: preparation hands each directory to the site's ownership as well (§9), so on a
  cell where the transport user is in the docroot's group the §2.3 grant alone (`ug+rwX` ⇒
  `0775`) would suffice. Still deferred — dropping the floor is only safe where ownership
  correction is *guaranteed* to succeed, and it is best-effort by contract. Revisit if a cell
  is ever required to have working elevation.
- **Batching the per-path commands.** Measured on `pro@nginx`: `prepareSiteDataDirs` costs **15 s**
  for BackWPup's two paths — roughly seven round-trips each — and the plugin's own handover 1.8 s,
  putting the `@plugin` Before hook at ≈ 30 s against a 120 s budget. It is round-trip latency, not
  work: `mkdir`, `chmod`, `chmod -R` and `chown -R` all take several operands, so one command per
  *step* rather than per *path* would cut it roughly threefold. Deferred deliberately — it changes
  `normalizeOwnership`'s one-path contract and deserves its own tests, and nothing is near the
  budget. Revisit when a product declares more than a handful of data paths.
- **Running WP-CLI as the docroot owner** (§1.5). Rejected on evidence, not forgotten. If
  §2.9's call sites keep leaking, revisit as a per-site opt-in (`transport.runWpAs`) rather
  than a default.

## 6. Audit — Phases 1–2 (2026-08-26)

An independent review of both phases. Everything below was reproduced before being acted on; two
findings were confirmed by direct measurement on `qa-lnmp`.

### 6.1 Fixed — a declared `fileOwner` forced world-write, and lied about why

`resolveTarget` leaves the ids unknown (`NaN`) whenever a declaration overrides what was detected,
and the grant decision compared **only ids**: `1000 === NaN` is false and `groupIds.includes(NaN)` is
false, so *every* declared override took the world-writable branch — and printed a notice claiming
the transport user was not a member of a group it was in. The override path was therefore the one
path guaranteed to get it wrong.

Fixed by comparing **by id or by name**: `parseIdentity` now also reads the names `id` already
prints, so a name-only target is judged correctly at no extra round-trip.

### 6.2 Fixed — `chown` ran before the grant, leaving a broken intermediate state

The two commands commute in their final effect but not in their intermediate one: chowning first
leaves the tree owned by the site's user with no grant yet — the measured §1.4 lock-out, where the
transport user can no longer remove what it installed. A `chmod` that then fails (a host whose
`sudo` allows one and not the other, §1.8) or an interrupted run leaves the site broken.

**The grant is now applied first.** A failed `chown` leaves the tree exactly as it was. Verified on
`qa-lnmp`: at the intermediate point the tree still reads `ubuntu:ubuntu 775` and the transport user
can still write it.

### 6.3 Fixed — `chown` had no `--`, and the owner spec accepted a leading dash

`sudoArgv` ends *sudo's* option parsing, not `chown`'s, and GNU `chown` permutes options anywhere in
its argv. Measured on `qa-lnmp`:

```
sudo chown -Rh    --reference=/etc/hostname <path>   →  file became root:root
sudo chown -Rh -- --reference=/etc/hostname <path>   →  chown: invalid user
```

Both commands now pass `--`, and `parseOwnerSpec` validates each half against a name pattern, so the
same typo is reported as the configuration error it is. Two independent defences, because this runs
as root.

### 6.4 Fixed — smaller correctness and convention defects

- **`parseIdentity` truncated a group list at a space.** `groups=…,513(domain users),33(www-data)`
  captured only up to `domain`, dropping `www-data` — which would have world-written a correctly
  configured host. Now captured to end of line.
- **`parseStatOwnership` read an empty id as `0`** (root), and accepted hex/padded forms, because
  `Number("")` is `0`. Now digit-tested before conversion.
- **`normalizeOwnership` could reject**, contradicting its documented contract: `wpRootDir` was
  called outside the `try`. Now inside it.
- **`(error as Error).message`** replaced with the repo's `errorMessage` guard, as CLAUDE.md requires.
- **Warnings deduplicated per target only**, so the first warning silenced every later, different one
  — an invisible failure, since nothing consumes the return value yet. Now keyed per target **and**
  reason, with distinct bad inputs distinguished so two different mistakes are both reported while a
  repeat is not.
- **A spec comment referenced this plan by phase name**, which CLAUDE.md forbids outright. Removed.
- Missing `@param` blocks added; `parseOwnerSpec`'s TSDoc no longer claims to be "surfaced loudly"
  when its only caller catches it.

### 6.5 Fixed — tests that passed for the wrong reason

The real-transport cases gated themselves on `detectSiteOwnership(...) === undefined` — the output of
the function under test — so a regression breaking detection on Linux would have turned failures into
silent skips. Four sibling cases additionally passed *vacuously* on macOS, where every root reads as
unreadable. All are now gated on `process.platform`, and `resolveTarget` / `matches` / the
name-based grant decision are tested directly.

### 6.6 Recorded, not changed

- **One message changed in Phase 1**, contrary to "byte-identical": `"residue paths are resolved
  against…"` became `"site paths…"`, correct now that the rule is shared. The clause is pinned by a
  test so it cannot drift again unnoticed.
- **The fast path skips the grant entirely.** A host where the transport user owns the docroot but
  the web server is a *different* account relying on group bits could satisfy `unnecessary` under
  `umask 022` and still leave the web server unable to write. No cell hits this — on `docker` the web
  user **is** the owner — and detecting a third user is exactly what §2.2 rejects as unreliable, so
  this is documented rather than guessed at.
- **`transport.fileOwner` is a live, typed `sites.json` field with no operator documentation yet.**
  Phase 5 owns that; until it lands, the field is documented only in its own TSDoc.

## 7. Audit — Phases 1–4 (2026-08-26, second round)

A second independent review, covering all four implemented phases together and their
interactions. Every finding below was reproduced before being acted on; two were confirmed
against the live fleet.

### 7.1 Fixed — `transport.fileOwner` never reached the transport

`validateTransport` in `sites.ts` builds its shared block from an allow-list of `stagingDir`
and `elevate`. `fileOwner` was never read, so it was discarded before any `Transport` was
constructed: **the entire override surface was unreachable from configuration**, and every
spec hid it by passing TypeScript literals.

Two consequences, the second serious. An operator hitting the case the override exists for
would declare `fileOwner` and be told by pre-flight to declare `fileOwner`. And
`fileOwner: false` — the documented opt-out from a **root-privileged** `chown -R` — was
silently ignored, so the suite would chown a site whose owner had explicitly forbidden it.

Fixed with an `optionalFileOwner` validator beside `optionalBoolean`, rejecting anything that
is neither `"user:group"` nor `false` by name rather than coercing it. The sites spec gained
the `fileOwner` half of the block it already had for `elevate`.

### 7.2 Fixed — the ownership caches were keyed per host, not per install

`targetKey` is `ssh:<user>@<host>#<key>` with no `rootDir` — correct for elevation, which is
a property of a machine and a user. Phase 2 reused it for detected ownership, identity and
the one-time notices, which are properties of **a site**.

Confirmed live on the apache cell — two docroots under the same `ubuntu@host`:

```
/var/www/auto-e2e-backwpup-apache…/public  → sftp_backwpup:www-data:1001:33
/var/www/auto-e2e-wprocket-apache…/public  → sftp_wprocket:www-data:1002:33
```

`npm run healthcheck` walks every product × cell × site in one process, so the second site's
ownership line reported the first site's owner. Worse in principle: any process that
normalised two sites would have aimed a privileged `chown -R` at the wrong owner.

Fixed with `installKey` in `exec.ts` — a sibling of `targetKey`, so the two notions of
"the same thing" stay in one place — and a regression test that two roots on one host answer
independently.

### 7.3 Fixed — pre-flight promised a handover that would not happen

`planOwnership` deliberately says nothing about privileges, so `checkFileOwnership` reported
*"Installed files will be handed to …"* even when elevation was `unavailable` or `disabled`
— and in the `disabled` case no banner contradicts it, so the report was silently wrong. The
check now takes the elevation answer the caller already holds and says *"need handing to …,
but cannot be"* instead.

### 7.4 Fixed — `prepareSiteDataDirs` escalated without the root guard

It validated the relative half but never the root half, while `removeSiteResidue` did. A site
whose `rootDir` was a top-level directory would have had world-writable directories created
**as root** at the filesystem root — and teardown would then have refused to remove what setup
created. Pre-existing, but newly in scope because Phase 1 centralised that guard and named
this caller as one of its users. Guard added, with a test.

### 7.5 Fixed — nothing pinned the privileged command shape or its order

`--`, `-Rh`, and grant-before-chown — the three things the first audit identified as
dangerous — were asserted by no test; deleting `--` left the suite green. Added a describe
that drives the real module over a `local` transport with stub `sudo`/`stat`/`id`/`chmod`/
`chown` on `PATH` and asserts the exact argv and ordering, plus that an implausible root
composes **no** privileged command at all, plus that a `chown` which exits 0 while changing
nothing is still caught by the re-read.

**Both properties were mutation-tested**: removing `--` fails the suite, and swapping the two
commands fails the suite. A companion test in the staging spec pins that the chown is aimed at
`wp-content/plugins/<slug>` and never at the staging area or the plugins directory itself.

### 7.6 Fixed — smaller defects

- **Duplicated banner mapping.** `warnAboutElevation`'s TSDoc claimed the healthcheck used it;
  the healthcheck had grown its own copy and the export was dead. The healthcheck now calls it.
- **`?? "unavailable"` crutches** replaced with `flatMap`, so a reordering can never relabel a
  site that was merely never asked as one that cannot elevate.
- **The banner's denominator was misleading** — it counted only sites that got far enough to be
  asked, so "2 of 2" could appear on a run where a third site failed outright. It now reports
  affected sites without a denominator.
- **Unit tests shelled out to the real `sudo`.** Pre-flight now probes privileges, and the
  pre-existing `verifyPool` specs used a bare local site, so `npm run test:unit` left
  failed-auth entries in the developer's system log. `localSite()` now declares
  `elevate: false`, and `resetOwnershipCaches` covers every describe sharing one root.
  Verified with a `sudo` shim on `PATH`: the whole suite now makes **zero** calls from the
  specs this plan touches. (One call remains, from the pre-existing `log.spec.ts`, outside
  this plan's scope.)
- TSDoc gaps closed: `@param` on the new pre-flight checks, `@throws` updated for
  `stageAndInstallPlugin` and `installPluginUnderTest`, and the `HOOK_TIMEOUT_MS` breakdown
  now says its measured figures are a floor that predates two later additions.

### 7.7 Verified, not changed

- **BusyBox compatibility for `docker`.** The Docker daemon is not running on the development
  machine, so the actual `wordpress:cli` image was not exercised. BusyBox 1.36.1's applets were
  checked instead: `stat -c '%U:%G:%u:%g'` → `root:root:0:0`, and `id` → the same
  `uid=33(www-data) gid=33(www-data) groups=33(www-data)` shape `parseIdentity` already has a
  test for. A docker cell will therefore detect `33:33`, match its own identity, and take the
  no-op fast path. To settle it inside the real image:
  `docker run --rm --entrypoint sh wordpress:cli-php8.3 -c "stat -c '%U:%G:%u:%g' /var/www/html; id"`.
- **`docker` is no longer literally "byte-for-byte unchanged"** — it now runs `stat` and `id`
  (and `pwd`, where `rootDir` is undeclared) per worker before reaching the fast path. Three
  reads, nothing privileged, nothing mutated. The Phase 3 acceptance wording was too strong;
  the intent — no privileged command, no change on a correct host — holds.
- **The fast path still skips the grant** (§6.6 already records this): a host where the
  transport user owns the docroot but the web server is a different account on group bits could
  satisfy `unnecessary` under `umask 022`. No cell hits it, and detecting that third user is what
  §2.2 rejects as unreliable.

## 8. Audit — Phases 1–6 (2026-08-26, third round)

Split into two reviewers after a single broad one exhausted its budget reading context without
producing findings. One covered documentation accuracy, one covered code, system consistency and
test integrity. Every finding below was reproduced before being acted on.

### 8.1 Fixed — the docs described a validation that did not exist

`configuration.md` said a bare `"www-data"` "is rejected", stated inside the sites-file schema
section so it read as load-time rejection. It was not: the loader accepted any non-empty string and
only `parseOwnerSpec` checked the shape, at run time, where the failure becomes a warning and a
`failed` outcome — and pre-flight reports it as a **passing** check. A typo degraded silently on
precisely the site an operator was trying to fix.

**Fixed in the code rather than the prose**, on the repository owner's prompting: the rule now lives
in `src/common/config/file-owner.ts` — pure, dependency-free, so the loader does not pull the WP-CLI
transport layer in to read a JSON file — and is enforced **twice**: by `sites.ts` at load, where
every other site field is validated and a typo is cheapest to fix, and again by `ownership.ts`
before a privileged command is composed. One rule, two enforcement points, one spec
(`file-owner.spec.ts`).

### 8.2 Fixed — three earlier fixes had no test that would catch them regressing

Found by mutation testing. Each mutation restored a defect an earlier audit had fixed, and the whole
suite stayed green:

| Mutation | Now killed by |
| --- | --- |
| ownership caches keyed per **host** again | `detectSiteOwnership — two installs on one host` (docker, stubbed) |
| the warning key drops its **reason** | `a second, different failure is not silenced by the first` |
| pre-flight stops folding **elevation** into the ownership line | `says a needed handover cannot happen when privileges are unavailable` |

The cache-key test that existed was **vacuous**: it drove two `local` transports, and for `local`
`installKey` and `targetKey` return the same string by construction, so it could not tell them
apart. `exec.spec.ts` now pins both helpers directly — same target/different install for `ssh` and
`docker`, and an explicit case recording that they coincide for `local` so nobody "fixes" it back.

### 8.3 Fixed — a test polluted a machine-global path

`residue.spec.ts` asserted `existsSync("/tmp/wp-content") === false` and never cleaned up. During
mutation testing the guard was removed, the directory was created — and that test then failed
deterministically on every later run **with correct code restored**, pointing at the guard rather
than at stale state. Now cleaned in a `finally`.

### 8.4 Fixed — smaller corrections

- `assertSafeElevatedTarget` was documented as run by "every elevated caller". It is run by the three
  that build a privileged target from a site's `rootDir`; staging and `debug.log` elevate without it,
  correctly, because neither composes such a path. Reworded in CLAUDE.md and the architecture doc.
- The "second, never first" elevation rule now has a stated exception: `chown` has no unprivileged
  form, so ownership elevates directly. It still asks nothing of a host that does not need it.
- The `Transport` field table in `wordpress-automation.md` had not gained `fileOwner`.
- **Four `stageAndInstallPlugin` examples** across CLAUDE.md, `wordpress-automation.md`,
  `authoring-tests.md` and `plugin-artifacts.md` still omitted `slug`, contradicting the MUST that
  says to pass it — copying any of them would have reintroduced the bug.
- `prepareSiteDataDirs` now passes `--` to its privileged `mkdir`/`chmod`, matching ownership.
- The claim that "`chmod -R` never follows symlinks" was wrong for the **operand** itself; corrected
  to say both commands still dereference the operand, and why that is a property of the install.

### 8.5 Verified, not changed

- **No severe defect in the privileged paths.** Both reviewers independently failed to construct any
  input — slug, `sitePath`, `fileOwner`, `rootDir` — that reaches a root command outside the
  WordPress root or is read as a flag. Guard placement is mutation-verified in all three callers.
- **The never-throws contract holds** on every traced path.
- **Multiple sites per host is handled**: `connections` and `elevationProbes` are keyed per host+user
  (correct — an SSH connection and passwordless `sudo` are host properties), the four ownership
  caches per install.
- **Eleven other mutations were already killed** by the existing suite, including chown-before-chmod,
  the dropped `--`, both root guards, the post-chown verification, and `fileOwner` dropped by the
  loader.

## 9. Follow-up — data-directory preparation now normalises ownership (2026-08-27)

Raised by the operator against the §5 coverage answer: preparing the product's data directories
used `chmod 0777` as its *whole* mechanism, where the plugin install uses `normalizeOwnership`.
Two different answers to the same problem, and the weaker one was in the path that had already
produced a live fatal.

Reviewed and agreed. `prepareSiteDataDirs` now runs three steps per declared path — `mkdir -p`,
`chmod 0777`, then `normalizeOwnership` — and the third is not decoration:

- **It restores the owner.** A directory WP-CLI creates arrives `ubuntu:ubuntu`. `0777` makes that
  workable but leaves the suite writing into a site's docroot as the transport's user without
  handing it back, which is the one thing §2.9's MUST forbids. Preparation was the only remaining
  violator of the rule this plan added.
- **It is recursive, and the mode is not.** `chmod 0777 <dir>` opens the top level only. The grant
  reaches a subtree an earlier scenario's plugin wrote as the web server (one that survived a
  teardown where elevation was unavailable), and one the plugin's **own activation** created a
  moment earlier as WP-CLI. The second was raised in the third audit round and left open on the
  grounds that BackWPup's `activate()` creates no directories (verified in `class-install.php`);
  it is now closed by construction instead of by that product-specific fact.

Order is load-bearing the other way from §2.3's: the mode is applied *before* the hand-over, while
the directory is still the transport user's to change. Normalising first would need privileges for
a `chmod` that otherwise needs none.

`0777` stays as a **floor**, because ownership correction is best-effort by contract: a host with
no passwordless `sudo` gets prepared, writable directories and a warning, exactly as before. See
§5 for when the floor could be dropped.

Cost: two extra elevated commands plus a re-read per declared path, on cells that need a grant at
all — six round-trips for BackWPup's two paths, none on a `docker` cell, where the fast path fires.

Tested with the same `PATH`-stub harness `ownership.spec.ts` uses (`stat`/`id`/`sudo` stubbed,
`mkdir`/`chmod` real), asserting both privileged commands per path in grant-before-chown order,
plus that a refused correction does not fail preparation. Mutation-verified: deleting the call
fails the first test.

## 10. Audit — the whole change set (2026-08-27/28, fourth round)

A full review of everything since Phase 1, on the operator's instruction to verify rather than
assume. Thirteen defects in the code, one exported guard weaker than documented, seven tests that
proved less than they claimed, and sixteen documentation errors — all fixed, and every code fix
mutation-verified; the OS-level assumptions the design rests on were re-measured on `qa-lnmp`
(GNU coreutils 9.4, kernel 6.8) rather than recalled.

### 10.1 Fixed — a symlink operand could redirect a root `chmod` out of the docroot

The guards in `paths.ts` are lexical and say so; what none of them can see is that the target
*itself* is a link. Re-measured, because §1.9's table was incomplete — it only ever tested links
found **during recursion**:

| | Link during recursion | Link as the **operand** |
| --- | --- | --- |
| `chmod -R` | not followed | **followed** |
| `chown -Rh` | not followed | not followed (`-h` acts on the link) |
| `rm -rf` | not followed | not followed |

So removal and the chown were always safe, and §1.9's conclusion was right for the commands it
tested. `chmod` is the exception and has no flag that fixes it. Both privileged `chmod` callers were
reachable: `mkdir -p` succeeds silently against an existing symlink-to-directory, and an
unprivileged `chmod` on it fails with `Operation not permitted` — which is precisely what
`escalateIfDenied` retries **as root**.

Fixed by refusing a symlink operand before anything runs privileged (`isSymlink`, in `exec.ts`
beside the other transport primitives). `normalizeOwnership` warns and returns `failed`;
`prepareSiteDataDirs` throws, since it is not best-effort. Confirmed end to end on the cell: with a
`wp-content/uploads/…` symlink pointing at `/etc`, preparation refuses, normalisation returns
`failed`, and `/etc` stays `755`.

The code comment claiming "both still dereference the operand" was wrong about `chown -Rh`, and is
corrected — the flag is doing more work than the comment credited it with.

### 10.2 Fixed — a bare numeric `fileOwner` was accepted and then mishandled

`"33:33"` is documented as valid, and `resolveTarget` left its ids as `NaN`, so everything compared
by **name** — while `stat` answers with the name (`www-data`) for any id it can map. Two consequences,
both measured:

- verification never matched, so every successful `chown` was reported as `unverified`/`failed`;
- `grantModeFor` found the transport user neither the owner nor a group member and returned
  `ug+rwX,o+rwX` — **world-writable, for a reason that is not true**. The same class of defect as
  §6's, reached by a different route.

Fixed by reading a numeric half as the id it already is, and by deciding `matches` **per half**, so
a mixed `"www-data:33"` is judged by name on one side and by id on the other.

### 10.3 Fixed — a transport failure was cached as an answer

`detectSiteOwnership`/`transportIdentity` memoised `null` whether the probe *ran and could not
answer* or *could not be run at all*. One dropped SSH connection therefore disabled ownership
normalisation for every later scenario in that worker, on a site perfectly able to answer, with no
symptom beyond a plugin the web server cannot write. That contradicts this repository's own rule —
branch on `exitCode`, throw when it could not run — so the probes now throw and only a real answer
is remembered. `normalizeOwnership`'s post-chown re-read absorbs the new rejection, keeping the
never-throws contract.

### 10.4 Fixed — a vacuous test, found by mutation

`matches — decides each half on whichever spelling that half has` originally built a target with
**both** ids populated, so the old all-or-nothing comparison satisfied it too. Caught only because
the mutation survived. Rebuilt around the target `resolveTarget` actually produces (`NaN` + a known
id), and the mutation now fails it.

### 10.5 Fixed — one failure could permanently silence a different one

`applyOwnership`'s catch-all filed its warning under `chown-failed` — the same reason, and therefore
the same dedupe key, as a genuine chown refusal. Nothing consumes the return value, so whichever
happened first made the other invisible for the rest of the run on that site: exactly the failure
mode per-reason dedupe exists to prevent, and newly reachable, since the symlink probe added in
§10.1 throws through that same catch. It now has its own reason (`errored`), which also stops a
transport error being reported as "chown failed". Test added; mutation-verified (restoring
`chown-failed` fails it).

### 10.6 Fixed — documentation that did not match the code

Seven, found by checking each claim against the code rather than reading for sense:

- "Each takes the caller's own message builder" — `pluginSitePath` does not; it throws a fixed message.
- "Both guards", introducing a list of three items (two guards and a composer).
- `fileOwner` validation "fails with the offending value quoted" — true for the string cases, not for
  a non-string, which names the field and the rule instead.
- "The one exception is `chown`, which has no unprivileged form" — `chmod` is elevated without an
  attempt too, and `chmod` *does* have an unprivileged form (residue preparation uses it).
- The `wp/` module list omitted `cache.ts`; the doc-ownership table listed `guards.ts` as a `wp/`
  module (it is `src/common/guards.ts`).
- The new pre-flight checks (**File ownership**, **Elevation**) and the run-level banner appeared in
  no document at all, though CLAUDE.md's own rule requires it.
- A sentence added earlier the same day called the correction "recursive" unconditionally; it is,
  only on the `grant` path.

### 10.7 Phase 6 re-certified against the current code (2026-08-27)

No phase was unimplemented, but **Phase 6 had certified the state of 2026-08-26** and the privileged
path changed five times after it (§9, §10.1, §10.2, §10.3, §10.5). A certification older than the
code it certifies is not one, so it was re-run.

**A real `@plugin` scenario, `pro@nginx`** — `npm run test:backwpup --project=pro@nginx --grep "Files
and the database are backed up together by one job"`: **3 passed in 2.1 min** (auth setup, artifact
resolve + verify, and the scenario), exercising install → ownership handover → data-directory
preparation → the backup itself → debug-log scan → uninstall → residue sweep. No ownership warning
was emitted, which is what a correct site looks like.

**Driving the real functions, `pro@nginx`:**

| | Result |
| --- | --- |
| Detected owner | `www-data:www-data:33:33` |
| Plugin dir / file after normalisation | `www-data:www-data 775` / `664` |
| Transport user deletes a file the web server owns (§1.4) | **yes** |
| Data dir after preparation (§9) | `www-data:www-data 777` |

**The `o+rwX` branch, on real hardware (Phase 6.5, re-run).** Pre-state `www-data:x:33:ubuntu`;
`ubuntu` removed from the group; the exercise run in a **fresh process**, which confirmed in-session
that `www-data` was absent from its own group set before trusting anything. Plan `ug+rwX,o+rwX`
(`worldWritable=true`), outcome `normalized`, directory `777`, file `666` — `X` not `x`, so a PHP
file is still not executable — the notice emitted, and the transport user could still remove what it
installed. **Restored byte-identical to the pre-state**, confirmed by comparison, and the probe
directory removed.

**The `docker` transport, exercised on real hardware for the first time** (no earlier phase managed
it). Against `wpme-wpcli-nginx` from `npm run env:up`: root `/var/www/html` via `pwd`; detection
`33:33`; plan `unnecessary`, so the fast path ran **no** privileged command; a protected path
(`wp-content/plugins`) refused; preparation produced `777 33:33`; the symlink guard refused a link to
`/etc` and left it at `755`; and elevation — `docker exec -u 0:0`, not `sudo` — reported `uid 0`.
That run is also what exposed §10.8.

**A docroot owner that is not the web-server user** — the case `pro@apache` uniquely provides. With
that cell unreachable, it was reproduced on real hardware against a throwaway root owned
`daemon:www-data` (the same shape as `sftp_backwpup:www-data`): detection `daemon:www-data:1:33`,
the **group** branch chosen (`ug+rwX`, not world-write, because the transport user is in `www-data`),
`normalized`, directory `daemon:www-data 775`, file `664`, data directory `777`, and the transport
user could still delete a file the docroot owner owned. This exercises the same code path; it is not
a substitute for the cell's own configuration.

**`pro@apache`, completed 2026-08-28.** The host was unreachable the previous day because it was
down — it answered `up 2 min` on the next attempt, so the earlier SSH-banner timeouts were the box,
not this machine's link and not the connections made from it. Driving the real functions against it:

| | Result |
| --- | --- |
| Detected owner | `sftp_backwpup:www-data:1001:33` — **not** the web-server user |
| Plan | `grant`, `ug+rwX`, `worldWritable=false` (the transport user is in `www-data`) |
| Plugin dir / file after normalisation | `sftp_backwpup:www-data 775` / `664` |
| A file the *docroot owner* owns, removed by the transport user | **yes** |
| Data dir after preparation | `sftp_backwpup:www-data 777` |
| Symlink operand | refused; `/etc` left at `755` |
| Cleaned up afterwards | confirmed |

**Two docroots on one host, proven live** — the case §7.2's per-install keying exists for, until now
only stub-tested. Same host and user, so `targetKey` matches and `installKey` does not; probing both
returned `sftp_backwpup:www-data:1001:33` and `sftp_wprocket:www-data:1002:33`. One cache never
answered for the other.

**The `o+rwX` branch on this cell too**, which matters more here than on `qa-lnmp` because the owner
is not the web-server user: with `ubuntu` removed from `www-data`, the plan was `ug+rwX,o+rwX`, the
result `sftp_backwpup:www-data 777` / `666`, the notice named both `sftp_backwpup` and `www-data`
correctly, and the transport user could still remove what it installed. Group restored
byte-identical to `www-data:x:33:sftp_backwpup,sftp_wprocket,ubuntu`.

**Fleet healthcheck, both cells, exit 0** — the reporting layer end to end on real infrastructure:
`File ownership: Installed files will be handed to sftp_backwpup:www-data with ug+rwX` on apache,
`www-data:www-data` on nginx, `Elevation: Passwordless sudo is available` on both, and correctly no
banner.

**`pro@apache` scenarios: blocked by the cell's database, then repaired (2026-08-28).** The suite
failed there on `DebugLogFatalError` — BackWPup's `CREATE TABLE wp_bwpup_backups` returning *errno
184 "Tablespace already exists"* on every attempt. Nothing in this work touches the database; the
cause was an **orphaned InnoDB tablespace**, and the debug-log gate catching it is the feature
working.

Diagnosed rather than assumed, on MariaDB 10.11.14:

- `SHOW TABLES LIKE 'wp_bwpup_backups'` → nothing, and
  `information_schema.INNODB_SYS_TABLES` (queried as root) → no entry: the table is **absent from
  the data dictionary**.
- `/var/lib/mysql/backwpup/wp_bwpup_backups.ibd` was on disk, 114 688 bytes, dated **2026-05-04** —
  four months before this plan began.
- `DROP TABLE IF EXISTS` exits 0 and leaves the file, because there is no table to drop.
- A sweep of **every** `.ibd` in every schema on the host found exactly **one** orphan: this file.
- `mariadbd` prescribes the remedy itself: *"the file … already exists though the corresponding table
  did not exist in the InnoDB data dictionary. You can resolve the problem by removing the file."*

Repaired by moving it aside rather than deleting it — reversible, with the checksum recorded
(`e784c397…`) and the dictionary re-checked immediately before acting so the operation would abort
if it had stopped being an orphan:

```sh
sudo mv /var/lib/mysql/backwpup/wp_bwpup_backups.ibd /var/backups/orphaned-innodb-<stamp>/
```

Safe with the server running: a tablespace absent from the dictionary has no open handle. Verified
afterwards — the exact `CREATE TABLE` that had been failing succeeds, `DROP` now removes both the
table *and* its `.ibd` (so the file-per-table lifecycle is healthy again), and `journalctl` shows no
new InnoDB errors.

**The full BackWPup suite then passed on both cells**, `--retries=0` and no grep filter — all nine
onboarding scenarios plus the auth and artifact setups: `pro@apache` **13 passed in 10.7 min**,
`pro@nginx` **13 passed in 11.5 min**. That is the whole product suite green on real hardware with
this work in place.

### 10.8 Fixed — BusyBox reports no owner name, and it would have been passed to `chown`

Found by exercising `docker` for the first time. `stat -c '%U:%G:%u:%g' wp-content` in the
`wordpress:cli-php8.3` image (BusyBox 1.37.0) returns **`UNKNOWN:UNKNOWN:33:33`** — not the numeric
id GNU falls back to. Two documented claims were therefore false: `parseStatOwnership`'s ("`%U`/`%G`
fall back to the numeric id") and the module header's ("verified against BusyBox 1.36.1 … the same
shapes GNU does" — `id` there is `uid=33 gid=33 groups=33`, with no names at all).

No live defect on the default `docker` cell, because the ids match and the plan is `unnecessary`
before any name is used — and `parseIdentity` already handled the nameless `id` correctly. But on any
cell where the ids differed, the composed command would be `chown -Rh -- UNKNOWN:UNKNOWN <path>`,
which can never succeed. An unmapped name is now replaced by the id from the same `stat` call, which
is what the kernel stores and what `matches` verifies against; a host with a real account called
`UNKNOWN` resolves to the same owner either way. Test added from the container's verbatim output, and
mutation-verified.

### 10.9 Fixed — `parseIdentity` lost memberships, and a lost membership means world-write

Two asymmetries in one function, both reachable, both ending in the same place: `grantModeFor`
comparing by **name** (which is every site that declares `transport.fileOwner`) and finding the
transport user outside the target's group when it is not.

- The primary group's **id** was backfilled into `groupIds` when `groups=` did not repeat it —
  with a comment saying exactly why — but its **name** was never backfilled into `groupNames`.
  Measured: `uid=1000(ubuntu) gid=33(www-data) groups=1000(ubuntu)` against a declared
  `www-data:www-data` produced `ug+rwX,o+rwX`, world-writable, "because this site's commands run as
  a user that is neither www-data nor a member of www-data" — which was false.
- Group **ids** were parsed with `/(\d+)\(/g`, which requires a name in parentheses. BusyBox prints
  bare ids, so `groups=33,1000` yielded `[33]` and dropped the second membership entirely. The
  `wordpress:cli` image reports a single group, which is why §10.8's fix did not expose it.

Both now go through one `parseGroupSet`, which anchors each entry to the start or a comma — so
digits inside a name are never read as an id, and `513(domain users)` keeps its space — and treats
the name as optional. The primary group is backfilled in **both** spellings. Four tests added from
verbatim `id` output; both mutations killed.

### 10.10 Fixed — the elevation probe remembered a transport failure as "no sudo"

`elevationSupport` mapped *any* throw to `"unavailable"` and memoised it for the process. One
dropped round-trip during the probe therefore disabled escalation for the rest of that worker —
residue silently stops being removed, ownership silently stops being corrected — with a single
deduplicated warning as the only trace; and in pre-flight it produced a false `ELEVATION
UNAVAILABLE` banner telling the operator to edit `sudoers` on a healthy host. The ownership probes
already refused this exact discipline two files over (§10.3). A refusal is still cached; a failure
to ask is not. `resetElevationCaches` was added with it, and `resetOwnershipCaches` now calls it —
tests that reset one believed they were resetting both.

### 10.11 Fixed — the banner asserted a cost the check above it denied

`renderElevationWarning` listed "plugin file ownership is NOT normalized" for every site without
privileges, including sites whose pre-flight line one paragraph earlier said *"the transport's user
already owns the install, so nothing is changed"*. Two adjacent lines contradicting each other is
how a banner stops being read. `SiteElevation` now carries `ownershipPending`, taken from the same
`planOwnership` result the ownership check uses (computed once in `verifySite` and shared, rather
than twice), the cost is listed only when some affected site needs it, and those sites are marked.
The elevation check's own wording was split the same way. The headline also names distinct **hosts**
when they differ from the site count — the remedy is one `sudoers.d` edit per host, not per site.

### 10.12 Fixed — smaller defects, all mutation-verified

- `assertSafeElevatedTarget` compared the target **lexically**, so `/var/www/site/../../../etc` was
  accepted. Every caller composes with `posix.join`, so nothing was exploitable — but it is exported
  and documented as the shared last line of defence. It now resolves the target first.
- A malformed `transport.fileOwner` rendered in pre-flight as a **green tick** whose detail was an
  error message. It now fails the site: every other ownership branch describes a host, this one is
  our own configuration being unreadable.
- The healthcheck's banner went to **stderr** while its entire report goes to stdout, so the
  documented `healthcheck > fleet.log` captured every line except that one — and it sat *after* the
  `try/finally`, so a throw while printing lost it. It now takes a sink, and the healthcheck passes
  `console.log` from inside the `try`.
- The plugin slug was validated only inside `stageAndInstallPlugin`, after `clearDebugLog` and
  `ensurePluginAbsent` had already run commands with it. Validated first now.
- Missing `@param`/`@returns` on eleven functions; an orphaned doc block bound to no declaration;
  `"memoised per target"` where the code keys per *install*; `OwnershipOutcome`'s `failed`/`skipped`
  descriptions omitting half their producers; `"once per run"` where module state is per **worker
  process**; and `OWNER_SPEC_RULE` telling an operator that `"33:33"` is not allowed when the parser
  accepts it.
- Error messages without a remedy: `no-identity`, `unverified`, `chown-failed`, and residue's
  escalation failure — which also identified its site only as "this local site" while
  `describeTarget` existed for exactly that.
- `applyOwnership` was 112 lines doing four things; split into `elevatedTarget`, `refuseSymlink`,
  `grantThenChown` and `verifyHandover`. `prepareSiteDataDirs`'s loop body became
  `prepareOneDataDir`.

### 10.13 Fixed — tests that proved less than they claimed

- `installs and activates even when ownership cannot be normalised` passed with the entire handover
  deleted: a malformed `fileOwner` returns before touching the filesystem, so both assertions came
  from the install and the `mkdir`. It now asserts the refusal was actually reported.
- The staging spec's `not.toContain(<plugins dir> + " ")` was **unfalsifiable** — every logged line ends
  with its target, so a trailing space can never match, including in the regression it names.
- `does nothing at all when the product declares no residue` claimed "not even a root lookup" but
  used a `local` transport, whose root is a string read without running anything. Re-pinned against
  `docker`, where resolving the root is an observable command.
- The colour assertion in the elevation-report spec passes only because Playwright sets
  `FORCE_COLOR`; in the documented `healthcheck > fleet.log` use the banner is plain text. The test
  now says so, and pins the `⚠` and the padding that carry it when colour does not survive.
- **Never executed by any test**: the world-write branch and its one-time notice — the module's most
  consequential escape hatch — plus `planOwnership`'s `unknown-identity` branch, `isSymlink`'s own
  contract, and the `unavailable` elevation state, without which `verifySite` could stop populating
  `elevation` and either caller could stop calling `warnAboutElevation` with the suite still green.
  All now covered; the `verifyPool` call site is mutation-verified.
- `plugin-lifecycle.spec` did not pin `elevate: false`, so a unit run could shell out to the real
  `sudo` of whatever machine ran it.

### 10.14 Re-verified after all of it

- **Mutation sweep, 23 of 23 killed**, including the chmod-before-chown ordering, both `--`, both
  symlink guards, the post-chown verification, `installKey` vs `targetKey`, `grantModeFor`'s name
  comparison, the primary-group backfill, the BusyBox substitution, both probe-caching rules, the
  `PROTECTED_SITE_PATHS` check, the trailing-slash and `..` rules, the `depth < 2` root rule, the
  guard's target normalisation, the owner regex, the `verifyPool` banner call, the `bad-owner`
  verdict, and the conditional ownership cost. Every file restored byte-exact, `cmp`-confirmed.
- **Live, with the shipped code**: `pro@nginx` → `normalized`, `www-data:www-data 775`/`664`, a file
  the web server owns still removable by the transport user, data directory `777`, symlink refused
  with `/etc` left at `755`, everything cleaned up. `docker` → `unnecessary` with no privileged
  command, data directory `777 33:33`, symlink refused, `/etc` at `755`.
- **Gates**: typecheck, lint, format clean; 593 unit tests pass, 8 skipped.

### 10.15 Verified, not changed

- **`shell-escape` is sound.** node-ssh interpolates arguments into a shell string, so this was
  fuzzed: 4000 random arguments over quotes, `$()`, backticks, newlines, `;`, `|` and `&`
  round-tripped through `/bin/sh` with **zero** argv mismatches. The one flaw — an empty-string
  argument disappears from argv — is unreachable, since every value that reaches an args array is
  either a literal or rejected when empty.
- **`wp` is never elevated**, and no dynamic value reaches the `file` position of a command (only
  `parameters` are escaped by node-ssh, not the command itself).
- **`resetOwnershipCaches` clears all four caches**, and `warnOnce`'s key is
  install + reason + `distinguishBy`.
- **The never-throws contract holds** on every path traced, including `elevationSupport` (which
  catches internally) and `execElevated`'s refusal under `elevate: false` (guarded before it is
  reached).
- **`styleText` degrades correctly**: verified on Node 24 that it emits no escapes off a TTY and
  honours `NO_COLOR`.
- **The mixed optional chaining in `resolveTarget` is correct**, not sloppy: a non-nullable
  right-hand side narrows `detected`, and both `tsc` and ESLint reject the "tidier" spelling. Now
  commented, having been "fixed" once during this audit.
- **Mutation sweep re-run directly, 11 of 11 killed**: `--` on both privileged commands, `-R`/`-Rh`,
  `installKey` vs `targetKey`, the post-chown verification, both symlink guards,
  `PROTECTED_SITE_PATHS`, the trailing-slash normalisation, the `../` escape rule, the `depth < 2`
  root rule, the `normalizeOwnership` call in preparation, `grantModeFor`'s name comparison, and the
  owner-name regex. Every file restored byte-exact, confirmed with `cmp`.
- **The staging area's elevated `rm -rf` is guarded** by `assertSafeStagingRoot`, which is stricter
  than the shared guard — it also rejects any *ancestor* of the WordPress root. `debug.log`'s
  elevated `rm` composes no path from configuration at all. Neither needs `paths.ts`.
- **Pre-flight handles every `OwnershipPlan` variant**, exhaustively and enforced by the compiler,
  and reports all six as passing checks — ownership never fails a run.
- **All 152 documentation links and anchors resolve** (checked against GitHub's slug rules).
- **Three of the four commissioned reviewers were killed by a session rate limit**, one of them
  mid-mutation. Every invariant it could have touched was re-verified and the sweep redone directly,
  which is why the evidence above is first-hand.

## 11. Audit — fifth round (2026-08-28)

Two fresh reviewers, read-only this time. They converged independently on the same top defect, which
I then reproduced myself before touching anything.

### 11.1 Fixed — a symlinked **ancestor** walked straight through every guard

§10.1 closed the case where the *final component* is a link. It is not the only place a link can sit,
and the kernel resolves a parent before the command ever sees the path. Measured directly in a
container: with `wp-content/uploads` linked outside the docroot,

```
rm -rf <root>/wp-content/uploads/backwpup   →  deleted /out/backwpup
mkdir -p <root>/wp-content/uploads/newdir   →  created /out/newdir  (0755)
```

both **outside the WordPress root**, with `normaliseResiduePath`, `assertSafeElevatedTarget` and the
leaf-only `isSymlink` all reporting success. Every privileged path was affected — `chmod`, `chown`,
`mkdir` and `rm -rf`.

The question was the wrong one. "Is the last component a link?" is now **"where does this path really
lead?"**: `assertResolvedInsideRoot` resolves target and root with `readlink -f` and requires
containment, walking up to the deepest existing ancestor so a directory about to be created still
resolves. A path that cannot be resolved at all is refused — nothing is then known about where a root
command would land. `isSymlink` is gone; the resolver subsumes it.

Removal is guarded before **both** passes now, not only the elevated one: "unprivileged" bounds
nothing when the transport's user is root, which a container or a root SSH login does not rule out,
and deleting another part of the filesystem is wrong at any privilege.

The trade is deliberate and worth stating: a data directory genuinely relocated outside the root is
now **refused** rather than followed. Point `rootDir` at the real location, or declare a path that
stays inside it.

Verified live afterwards on `pro@nginx`, `pro@apache` and a container: preparation and removal both
refused a linked ancestor, and the outside directory kept its contents and its `0700` mode.

### 11.2 Fixed — a by-name `fileOwner` on a host whose `id` prints no names

BusyBox answers `uid=33 gid=33 groups=33`. A declaration made by **name** carries `NaN` ids, so every
comparison falls back to names — and there are none. All four insider tests then fail, and
`grantModeFor` returns `ug+rwX,o+rwX`: **world-writable, for a reason that is not true**, which is
verbatim the failure §6.1 was fixed to prevent, reached by the remaining spelling. `matches` then
compares the numeric `stat` answer against a name and calls the successful chown a failure.

The ids are now looked up from the host (`id -u`, `getent group`), best-effort and memoised per
install, so a host that cannot answer behaves exactly as before. That also un-blocks the
`"unnecessary"` fast path, which `NaN === n` had made unreachable for *every* declared owner — such a
site was paying two privileged commands per scenario, and being told a handover was pending, when
nothing needed doing.

### 11.3 Fixed — reports and notices that lost information

- A banner on a non-interactive SSH channel could supply half the identity: `uid=` was matched
  anywhere in the stream, so `uid=0(root)` in an MOTD paired with the real line's gid. `id` is now
  read from the single line it printed.
- The world-write notice was keyed per install, so of the three paths a scenario normalises only the
  first was ever announced. Keyed per path now, as are the `chmod`/`chown`/verification warnings.
- `healthcheck.ts` never carried `ownershipPending`, so the fleet banner — the one place §10.11 was
  written for — silently claimed the ownership cost for **no** site. Carried through now.
- `elevationCheck` said "Ownership needs no change here" for `unknown-ownership`, `unknown-identity`
  and `bad-owner` alike, contradicting the line printed directly above it. Only the two plans that
  actually know say so.
- `trimTrailingSlashes` replaced a quadratic regex (measured: 14 s on 200 000 slashes) applied to a
  raw `rootDir`.
- `rm -rf` gained the `--` its sibling commands already had.

### 11.4 Verified

- **Mutation sweep, 10 of 10 killed** on the new work — the containment check, the unknown-is-refusal
  rule, the ancestor walk, all three guarded call sites, the identity line anchoring, the per-path
  notice key, the declared-id lookup and the elevation wording. Five of those tests did not exist
  until the sweep proved they were missing. Every file restored byte-exact.
- **Live on `pro@nginx`, `pro@apache` and both containers** with the shipped code.
- **601 unit tests pass**, 8 skipped (GNU-`stat` gated; they run on CI's Ubuntu and were confirmed
  passing in a Linux container). Stable across 1 and 8 workers and three consecutive runs.
- **The `@plugin` scenario on `pro@nginx` passes** (3 passed, 1.9 min) with everything above in
  place. One earlier attempt failed and is recorded rather than hidden: the install hook hit its
  120 s budget, and the plugin logged `sort(): Argument #1 must be of type array, null given`
  (`inc/class-migrate.php:174`) during activation. Neither is this work — the guards refused nothing
  on that cell (`readlink -f` finds no symlink anywhere on its residue paths), and the guards added
  **2.5 s**: preparation went from 16.8 s to 16.9 s and the plugin handover from 1.8 s to 2.5 s,
  against a 120 s budget. `ping` measured **100 % loss** to that cell at the time. Teardown still
  cleaned up correctly through the failure — no plugin and no `backwpup*` options left behind.

## 12. References

- Bug and cell measurements: this document, §1 (2026-08-26).
- Existing elevation doctrine and its limits: [`src/common/wp/exec.ts`](../../src/common/wp/exec.ts).
- The two-user problem, already documented for data directories:
  [`src/common/wp/residue.ts`](../../src/common/wp/residue.ts).
- Docker's already-correct user pinning: [`docker/docker-compose.yml`](../../docker/docker-compose.yml).
