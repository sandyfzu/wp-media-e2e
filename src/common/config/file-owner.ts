/**
 * The `transport.fileOwner` value: who should own the files this suite writes into a site's docroot.
 *
 * Parsing lives here, apart from both the loader that reads it and the WordPress layer that acts on
 * it, because **both** need the same rule and neither should own it. `sites.ts` uses it to reject a
 * malformed declaration at load — where every other site field is validated, and where a typo is
 * cheapest to fix — and `wp/ownership.ts` uses it again before composing a privileged command, so a
 * value that reached it some other way is still checked. One rule, two enforcement points.
 *
 * Deliberately dependency-free: the loader must not pull the WP-CLI transport layer (and with it
 * execa and node-ssh) into reading a JSON file.
 */

/** A parsed `transport.fileOwner`. */
export interface OwnerSpec {
  readonly user: string;
  readonly group: string;
}

/**
 * Accepts a user or group name: what `useradd`/`groupadd` allow, plus a bare numeric id.
 *
 * Deliberately strict, because the value ends up as an argument to a command running as root. A
 * leading `-` is the case that matters: `chown` permutes options anywhere in its argv, so
 * `--reference=/etc/hostname` as a "user" was measured taking ownership from that file rather than
 * failing. The commands also pass `--`, so this is one of two independent defences.
 */
const OWNER_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\$?$/;

/** The rule, in the words an error message uses. Kept beside the pattern so the two cannot drift. */
export const OWNER_SPEC_RULE =
  '"user:group" (e.g. "www-data:www-data"), where each half is a user or group name, or a bare ' +
  'numeric id ("33:33") on a host whose passwd database cannot map one';

/**
 * Validates a declared `transport.fileOwner`.
 *
 * **Both halves are required.** A bare user would leave the group to be guessed, and the group is
 * what lets the web server write on a host whose docroot owner is a deployment account — precisely
 * the case an override is most likely reaching for.
 *
 * @param declared - the value as declared, already known to be a string.
 * @param context - prefixed to the error, so one rule reads correctly from either enforcement point
 * (loading a sites file, or composing the privileged command).
 * @returns the parsed spec.
 * @throws Error describing the rule, prefixed by `context` so the same failure reads correctly
 * whether it surfaced while loading a sites file or while normalising ownership.
 */
export function parseOwnerSpec(declared: string, context: string): OwnerSpec {
  const [user, group, ...rest] = declared.trim().split(":");
  if (
    user === undefined ||
    group === undefined ||
    rest.length > 0 ||
    !OWNER_NAME.test(user) ||
    !OWNER_NAME.test(group)
  ) {
    throw new Error(
      `${context} must be ${OWNER_SPEC_RULE} — got "${declared}". Both halves are required: the ` +
        "group is what lets the web server write when the docroot's owner is a deployment account " +
        "rather than the web-server user.",
    );
  }
  return { user, group };
}
