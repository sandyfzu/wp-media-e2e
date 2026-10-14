import { readFile, readlink } from "node:fs/promises";
import { hostname } from "node:os";

import { BOOT_ID_PATH } from "../runs/leader";

/**
 * Where a PID means something: its **PID space**. A bare PID names a process only in one PID
 * namespace of one boot of one machine — two containers sharing a state volume are both PID 1, and
 * `kill(pid, 0)` in one answers for the other's PID with whatever process, or none, has that number
 * in its own namespace. So a lock records the PID space it was written in, and its PID is judged only
 * from the same one.
 *
 * - **Linux** — the boot (`/proc/sys/kernel/random/boot_id`, new at each boot, shared by every
 *   container of that boot) and the PID namespace (`/proc/self/ns/pid`, `pid:[<inode>]`: two live
 *   namespaces never share one; a dead one's may be handed to a new one, which is harmless — every
 *   process of the dead one is gone). The machine's id (`/etc/machine-id`, kept across boots; absent
 *   in most containers) adds one more answer: a lock from an **earlier boot** of the same machine's
 *   initial namespace names only dead processes.
 * - **Elsewhere (macOS)** — one PID namespace per machine, named by its host name. A changed host
 *   name reads as another machine: refused, never misjudged.
 *
 * Whatever cannot be read is `null`, and a `null` never matches: the lock is then refused, not judged.
 */

/** The initial PID namespace's inode, a kernel constant: the host's own, outside every container. */
export const INIT_PID_NAMESPACE = "pid:[4026531836]";

/** Where Linux names this process's PID namespace. */
export const PID_NAMESPACE_PATH = "/proc/self/ns/pid";

/** Where Linux keeps the machine's id. */
export const MACHINE_ID_PATH = "/etc/machine-id";

/** A host name as a lock may hold it: printable, one line, at most 255 characters. */
export const HOST_TEXT = /^\P{Cc}{1,255}$/u;

/** A boot id as Linux writes it: a lowercase UUID. */
export const BOOT_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A PID namespace as `readlink` gives it. */
export const PID_NAMESPACE_TEXT = /^pid:\[[1-9][0-9]{0,19}\]$/;

/** A machine id: 32 lowercase hex digits. */
export const MACHINE_TEXT = /^[0-9a-f]{32}$/;

/** A process's PID space, as far as it could be read. */
export interface PidSpace {
  /** `process.platform`: `linux`, `darwin`. */
  readonly platform: string;
  /** The host name, for the messages — and the space itself off Linux. */
  readonly host: string | null;
  /** Linux's boot id. */
  readonly boot: string | null;
  /** Linux's PID namespace, `pid:[<inode>]`. */
  readonly pidns: string | null;
  /** Linux's machine id. */
  readonly machine: string | null;
}

/** What {@link readPidSpace} reads the system through: injected, so each answer is tested. */
export interface PidSpaceDeps {
  readonly platform: NodeJS.Platform;
  readonly hostname: () => string;
  readonly readText: (path: string) => Promise<string>;
  readonly readLink: (path: string) => Promise<string>;
}

/**
 * Reads this process's PID space. Never rejects: what cannot be read, or is not what the system
 * writes, is `null`.
 *
 * @param deps - the system; the real one by default.
 * @returns the space.
 */
export async function readPidSpace(
  deps: PidSpaceDeps = SYSTEM,
): Promise<PidSpace> {
  const host = safely(() => deps.hostname(), HOST_TEXT);
  if (deps.platform !== "linux")
    return {
      platform: deps.platform,
      host,
      boot: null,
      pidns: null,
      machine: null,
    };
  const [boot, pidns, machine] = await Promise.all([
    read(() => deps.readText(BOOT_ID_PATH), BOOT_TEXT),
    read(() => deps.readLink(PID_NAMESPACE_PATH), PID_NAMESPACE_TEXT),
    read(() => deps.readText(MACHINE_ID_PATH), MACHINE_TEXT),
  ]);
  return { platform: deps.platform, host, boot, pidns, machine };
}

/**
 * Whether a PID written in `a` names the same process in `b`: the same boot and PID namespace on
 * Linux, the same host name elsewhere — every part known.
 *
 * @param a - one space.
 * @param b - the other.
 */
export function sameSpace(a: PidSpace, b: PidSpace): boolean {
  if (a.platform !== b.platform) return false;
  if (a.platform !== "linux") return a.host !== null && a.host === b.host;
  return (
    a.boot !== null &&
    a.boot === b.boot &&
    a.pidns !== null &&
    a.pidns === b.pidns
  );
}

/**
 * Whether `earlier` is an earlier boot of `now`'s machine, both in its initial PID namespace: then
 * every process `earlier` names has ended with that boot. Needs the machine's id on both sides — a
 * container without one is never so judged.
 *
 * @param earlier - the space a lock was written in.
 * @param now - this process's.
 */
export function earlierBoot(earlier: PidSpace, now: PidSpace): boolean {
  return (
    earlier.platform === "linux" &&
    now.platform === "linux" &&
    earlier.machine !== null &&
    earlier.machine === now.machine &&
    earlier.pidns === INIT_PID_NAMESPACE &&
    now.pidns === INIT_PID_NAMESPACE &&
    earlier.boot !== null &&
    now.boot !== null &&
    earlier.boot !== now.boot
  );
}

/**
 * A space in a few words, for a message: `linux boot 1b2c…, pid:[4026532829]` or `darwin host mac`.
 *
 * @param space - the space.
 */
export function describeSpace(space: PidSpace): string {
  return space.platform === "linux"
    ? `linux boot ${space.boot ?? "unknown"}, ${space.pidns ?? "unknown PID namespace"}`
    : `${space.platform} host ${space.host ?? "unknown"}`;
}

/**
 * A value read from the system, trimmed, or `null` when it fails or is not of `shape`.
 *
 * @param get - reads it.
 * @param shape - what it must be.
 */
async function read(
  get: () => Promise<string>,
  shape: RegExp,
): Promise<string | null> {
  try {
    const value = (await get()).trim();
    return shape.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * {@link read}'s synchronous twin.
 *
 * @param get - reads it.
 * @param shape - what it must be.
 */
function safely(get: () => string, shape: RegExp): string | null {
  try {
    const value = get().trim();
    return shape.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** The real system. */
const SYSTEM: PidSpaceDeps = {
  platform: process.platform,
  hostname,
  readText: (path) => readFile(path, "utf8"),
  readLink: (path) => readlink(path),
};
