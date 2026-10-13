import { styleText } from "node:util";

import { redactSecrets } from "../text";
import type { ElevationSupport } from "../wp/exec";

/**
 * The run-level warning for sites that cannot run a privileged housekeeping command.
 *
 * Elevation is otherwise a **silent** dependency: it is probed lazily, deep inside a teardown, and a
 * host without it degrades quietly — leftover plugin data is never removed, `debug.log` may not be
 * clearable, and the plugin under test keeps the transport user's ownership so the web server cannot
 * write it. Every one of those surfaces days later as a disk-full alert or an unexplained failure,
 * which is why this says so at the *start* of a run instead.
 *
 * It is a **warning, not a failure**: nothing is broken, and a suite on such a host still runs. So
 * this only ever renders text — the caller prints it and carries on, and no site's pass/fail verdict
 * depends on it.
 *
 * Kept apart from `preflight.ts` because it is wanted in two places (the auth setup's pool
 * verification and the standalone fleet healthcheck) and because a pure results-in/string-out
 * function can be tested without a terminal, a transport, or a WordPress.
 */

/** One site's elevation state, as the banner needs to name it. */
export interface SiteElevation {
  /** The site's base URL, as reports identify it. */
  readonly baseURL: string;
  /** The site's transport, already rendered (e.g. `ssh: ubuntu@203.0.113.10`). */
  readonly transport: string;
  /** What `elevationSupport` answered for it. */
  readonly support: ElevationSupport;
  /**
   * Whether this site's files actually need handing to another owner. `false` when the transport's
   * user already owns the install — the normal `docker` shape — where losing privileges costs
   * cleanup but not ownership. Kept per site so the banner cannot assert a cost the pre-flight check
   * printed directly above it denies.
   */
  readonly ownershipPending: boolean;
}

/**
 * What every affected site loses without privileges, in the order an operator will notice it. Kept
 * as one list because they share a cause, and reporting them separately would invite fixing one.
 */
const COSTS: readonly string[] = [
  "leftover plugin data is NOT removed → the site accumulates it every scenario",
  "`debug.log` may not be clearable between scenarios",
];

/**
 * The cost that applies only where a handover was actually needed.
 *
 * Stated separately because it is the one an operator can check: pre-flight prints each site's
 * ownership decision, and a site whose transport user already owns the install is told there that
 * nothing will be changed. Listing this unconditionally would contradict that line one paragraph
 * later, which is how a banner stops being read.
 */
const OWNERSHIP_COST =
  "plugin file ownership is NOT normalized → the web server cannot write into the plugin it is testing";

/**
 * Renders the warning for whichever sites answered `unavailable`.
 *
 * `disabled` is deliberately **not** reported: the site declares `transport.elevate: false`, so the
 * operator already chose this and warning about it every run would train them to ignore the banner
 * that matters.
 *
 * @param sites - every real site checked in this run, with the elevation each reported.
 * @returns the banner, already coloured and padded with blank lines above and below so it cannot be
 * lost in tightly-packed output — or `undefined` when no site needs it, which is the normal case and
 * must print nothing at all.
 */
export function renderElevationWarning(
  sites: readonly SiteElevation[],
): string | undefined {
  const affected = sites.filter((site) => site.support === "unavailable");
  if (affected.length === 0) return undefined;

  const lines: string[] = [""];
  // Counted as affected sites only, with no denominator: the caller passes the sites that got far
  // enough to be *asked*, so "2 of 2" would be the reading on a run where a third site failed its
  // transport outright — a denominator that quietly means something other than "the fleet".
  // Sites *and* hosts: the remedy below is one `sudoers.d` edit per host, and a fleet where ten
  // sites share one box would otherwise read as ten things to fix.
  const hosts = new Set(affected.map((site) => site.transport));
  const scope =
    hosts.size === affected.length
      ? `${String(affected.length)} site(s)`
      : `${String(affected.length)} site(s) across ${String(hosts.size)} host(s)`;
  lines.push(
    styleText(
      ["bold", "yellow"],
      `  ⚠  ELEVATION UNAVAILABLE — cleanup will be incomplete on ${scope}`,
    ),
  );
  lines.push("");
  const pending = affected.filter((site) => site.ownershipPending);
  for (const site of affected) {
    // Marked rather than listed twice: the operator needs one list of sites and one remedy, and the
    // marker is what ties the extra cost below to the sites it is true for.
    const mark = site.ownershipPending ? "  ←  ownership handover pending" : "";
    // The report becomes a setup's output, which the reports keep: a basic-auth `baseURL` is masked.
    lines.push(
      `     ${redactSecrets(site.baseURL)}  [${site.transport}]${mark}`,
    );
  }
  lines.push("");
  // Both causes are named because `sudo` reports them identically — it will not say whether a user
  // is a sudoer — and the remedy is the same either way.
  lines.push(
    "     `sudo -n true` failed for this transport's user. Either it is not a sudoer, or",
  );
  lines.push(
    "     sudo requires a password — sudo reports both identically, so this cannot tell",
  );
  lines.push("     them apart.");
  lines.push("");
  lines.push("     What this costs on each site above:");
  for (const cost of COSTS) {
    lines.push(`       • ${cost}`);
  }
  if (pending.length > 0) {
    lines.push(`       • ${OWNERSHIP_COST}`);
    lines.push(
      "         (on the sites marked above; the others already own their install)",
    );
  }
  lines.push("");
  lines.push(
    `     ${styleText(["yellow"], "→")} grant passwordless sudo, e.g. \`<user> ALL=(ALL) NOPASSWD:ALL\` in /etc/sudoers.d/`,
  );
  lines.push(
    `     ${styleText(["yellow"], "→")} or accept it deliberately: set \`transport.elevate: false\` on the site to`,
  );
  lines.push("       silence this warning and keep the suite unprivileged.");
  lines.push("");
  return lines.join("\n");
}
