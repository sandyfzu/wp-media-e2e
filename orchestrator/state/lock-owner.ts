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
 * a reused PID's included. One line of JSON, so a newer field is a version, never a guess.
 */

/** The lock's name in the state directory. */
export const LOCK_FILE = "orchestrator.lock";

/** The owner record's version. */
export const OWNER_VERSION = 2;

/** The largest PID `process.kill` takes: a signed 32-bit integer. */
export const MAX_PID = 2 ** 31 - 1;

/** A token: 32 lowercase hex digits. */
export const TOKEN_TEXT = /^[0-9a-f]{32}$/;

/** A start as `readLeaderStart` writes it (`linux:<boot>:<ticks>`, `ps:<date>`): printable, short. */
const START_TEXT = /^[\x20-\x7e]{1,128}$/;

/** What the first orchestrators wrote: `<pid>\n<token>\n`, with no PID space. */
const LEGACY_TEXT = /^[1-9][0-9]{0,9}\n[0-9a-f]{32}\n$/;

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
});

/** Who holds a lock, or a claim on one. */
export interface LockOwner {
  readonly pid: number;
  /** Tells this holder's lock from any other's, a reused PID's included. */
  readonly token: string;
  /** Its process's start, as `readLeaderStart` read it; `null` when it could not. */
  readonly start: string | null;
  /** Where its PID means something. */
  readonly space: PidSpace;
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
  const { pid, token, start, platform, host, boot, pidns, machine } =
    parsed.data;
  return {
    kind: "owner",
    owner: {
      pid,
      token,
      start,
      space: { platform, host, boot, pidns, machine },
    },
  };
}

/**
 * Whether `owner` can be written and read back as itself: what {@link parseOwner} accepts.
 *
 * @param owner - an owner, e.g. one built from injected values.
 */
export function isWritableOwner(owner: LockOwner): boolean {
  // Every field is a string, `null` or a whole number, so one that parses back reads back as itself.
  return parseOwner(formatOwner(owner)).kind === "owner";
}
