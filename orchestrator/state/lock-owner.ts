import { isAbsolute } from "node:path";
import { z } from "zod";

import {
  BOOT_TEXT,
  HOST_TEXT,
  MACHINE_TEXT,
  PID_NAMESPACE_TEXT,
  type PidSpace,
} from "./pid-space";

/**
 * What the lock and its claims hold: who wrote them — the PID, the start time of that process, the
 * PID space the PID means something in, and a random token that tells this holder from any other,
 * a reused PID's included; a site's lock also names the cell its holder runs there and its latest run. One line of JSON, so a newer field is a version, never a guess.
 */

/** The lock's name in the state directory. */
export const LOCK_FILE = "orchestrator.lock";

/** The owner record's version. */
export const OWNER_VERSION = 2;

/** The largest PID `process.kill` takes: a signed 32-bit integer. */
export const MAX_PID = 2 ** 31 - 1;

/** A token: 32 lowercase hex digits. */
export const TOKEN_TEXT = /^[0-9a-f]{32}$/;

/** The longest run record path an owner names, in UTF-16 units. */
export const MAX_RUN_PATH = 4096;

/** The longest site key an owner carries, in UTF-16 units. */
export const MAX_KEY = 2048;

/** The longest label an owner carries, in UTF-16 units. */
export const MAX_LABEL = 256;

/**
 * The most bytes an owner file holds: what a lock is read with. {@link isWritableOwner} refuses an
 * owner whose text is longer, so no lock is ever written that its readers would refuse.
 */
export const MAX_OWNER_BYTES = 8192;

/** A start as `readLeaderStart` writes it (`linux:<boot>:<ticks>`, `ps:<date>`): printable, short. */
const START_TEXT = /^[\x20-\x7e]{1,128}$/;

/** What the first orchestrators wrote: `<pid>\n<token>\n`, with no PID space. */
const LEGACY_TEXT = /^[1-9][0-9]{0,9}\n[0-9a-f]{32}\n$/;

/** A label: printable, one line, as messages quote it. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point.
const LABEL_TEXT = /^[^\u0000-\u001f\u007f-\u009f]+$/;

/** An owner record, as written. */
const ownerSchema = z.strictObject({
  v: z.literal(OWNER_VERSION),
  pid: z.number().int().min(1).max(MAX_PID),
  token: z.string().regex(TOKEN_TEXT),
  start: z.string().regex(START_TEXT).nullable(),
  platform: z.string().regex(/^[a-z0-9]{1,32}$/),
  host: z.string().regex(HOST_TEXT).nullable(),
  boot: z.string().regex(BOOT_TEXT).nullable(),
  pidns: z.string().regex(PID_NAMESPACE_TEXT).nullable(),
  machine: z.string().regex(MACHINE_TEXT).nullable(),
  run: z
    .string()
    .max(MAX_RUN_PATH)
    .refine(isRunPath, "an absolute path, with no control character")
    .optional(),
  label: z.string().regex(LABEL_TEXT).max(MAX_LABEL).optional(),
  key: z.string().regex(LABEL_TEXT).max(MAX_KEY).optional(),
});

/**
 * Whether a text may name a run's record in an owner: absolute, and free of control characters — it
 * is read back and printed.
 *
 * @param path - the text.
 * @returns whether it may.
 */
function isRunPath(path: string): boolean {
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point.
  return isAbsolute(path) && !/[\u0000-\u001f\u007f-\u009f]/.test(path);
}

/** Who holds a lock, or a claim on one. */
export interface LockOwner {
  readonly pid: number;
  /** Tells this holder's lock from any other's, a reused PID's included. */
  readonly token: string;
  /** Its process's start, as `readLeaderStart` read it; `null` when it could not. */
  readonly start: string | null;
  /** Where its PID means something. */
  readonly space: PidSpace;
  /**
   * A cell's lock only: the `run.json` of the run its holder runs on the cell — what tells, once the
   * holder has died, whether that run still does.
   */
  readonly run?: string;
  /** A site's lock only: what its holder runs there, in words — `backwpup pro@nginx`. */
  readonly label?: string;
  /** A site's lock only: the site's key, so a lock file named by its hash still says which site it is. */
  readonly key?: string;
}

/** An owner file's text, read. */
export type ParsedOwner =
  | { readonly kind: "owner"; readonly owner: LockOwner }
  /** The first orchestrators' `<pid>\n<token>\n`: no PID space, so it cannot be judged. */
  | { readonly kind: "legacy"; readonly pid: number }
  | { readonly kind: "invalid" };

/**
 * An owner's text: one line of JSON.
 *
 * @param owner - the owner.
 * @returns the line, ending in a newline.
 */
export function formatOwner(owner: LockOwner): string {
  const record: z.input<typeof ownerSchema> = {
    v: OWNER_VERSION,
    pid: owner.pid,
    token: owner.token,
    start: owner.start,
    platform: owner.space.platform,
    host: owner.space.host,
    boot: owner.space.boot,
    pidns: owner.space.pidns,
    machine: owner.space.machine,
    ...(owner.run === undefined ? {} : { run: owner.run }),
    ...(owner.label === undefined ? {} : { label: owner.label }),
    ...(owner.key === undefined ? {} : { key: owner.key }),
  };
  return `${JSON.stringify(record)}\n`;
}

/**
 * Reads an owner's text.
 *
 * @param text - an owner file's content.
 * @returns the owner; or that it is the first orchestrators' lock; or that it is neither.
 */
export function parseOwner(text: string): ParsedOwner {
  if (LEGACY_TEXT.test(text))
    return { kind: "legacy", pid: Number(text.slice(0, text.indexOf("\n"))) };
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1)
    return { kind: "invalid" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const parsed = ownerSchema.safeParse(json);
  if (!parsed.success) return { kind: "invalid" };
  const {
    pid,
    token,
    start,
    platform,
    host,
    boot,
    pidns,
    machine,
    run,
    label,
    key,
  } = parsed.data;
  return {
    kind: "owner",
    owner: {
      pid,
      token,
      start,
      space: { platform, host, boot, pidns, machine },
      ...(run === undefined ? {} : { run }),
      ...(label === undefined ? {} : { label }),
      ...(key === undefined ? {} : { key }),
    },
  };
}

/**
 * Whether `owner` can be written and read back as itself: what {@link parseOwner} accepts.
 *
 * @param owner - an owner, e.g. one built from injected values.
 * @returns `false` when writing it would leave a lock no start can read.
 */
export function isWritableOwner(owner: LockOwner): boolean {
  // Every field is a string, `null` or a whole number, so one that parses back reads back as itself.
  const text = formatOwner(owner);
  return (
    Buffer.byteLength(text) <= MAX_OWNER_BYTES &&
    parseOwner(text).kind === "owner"
  );
}
