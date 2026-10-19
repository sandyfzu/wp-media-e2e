/**
 * Noticing the orchestrator's parent is gone: npm, or the shell, ended without passing a signal on —
 * npm relays only SIGINT and SIGTERM, so a SIGHUP to npm's PID alone ends npm and leaves the
 * orchestrator running, reparented, holding its locks. A parent that ended counts as a hangup.
 *
 * The baseline is the parent as the process booted, read as this module is evaluated — `command.ts`
 * imports it first, so before the rest of the module graph, the command line and the config — never
 * when `start` begins watching: npm ending while Node still boots would otherwise be read as the
 * baseline itself, and never seen. Gone before even this module ran, the process is already
 * reparented: under npm, whose script runs Node as npm's own child (`exec`), a parent that is PID 1
 * then means npm is gone. Not caught: npm gone that early on a Linux host whose orphans go to a
 * subreaper (`PR_SET_CHILD_SUBREAPER`) rather than to PID 1. And npm run as PID 1 itself (a
 * container's command) reads as npm gone: run Node there directly.
 *
 * Importing this module changes nothing: it only reads `process.ppid`.
 */

/** The parent's PID as the process booted: read as this module is evaluated. */
export const BOOT_PARENT_PID = process.ppid;

/** How often the parent's PID is read, to notice the parent is gone. */
export const PARENT_WATCH_MS = 1_000;

/** How the parent is watched; every field has a production default. */
export interface ParentWatch {
  /** The parent's PID now; `process.ppid` by default, which Node reads afresh each time. */
  readonly parentPid?: () => number;
  /** The parent's PID at boot, the baseline; {@link BOOT_PARENT_PID} by default. */
  readonly bootParentPid?: number;
  /** How often it is read; {@link PARENT_WATCH_MS} by default. */
  readonly intervalMs?: number;
}

/**
 * Whether npm runs this process: npm sets `npm_lifecycle_event` (the script's name) for the script.
 *
 * @param env - the process's environment.
 * @returns `true` under `npm run`.
 */
export function runByNpm(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const event = env.npm_lifecycle_event;
  return event !== undefined && event !== "";
}

/**
 * Why the parent is taken as gone, if it is.
 *
 * @param boot - the parent's PID at boot.
 * @param now - the parent's PID now.
 * @param underNpm - whether npm runs the process ({@link runByNpm}): its parent at boot was then npm.
 * @returns the reason, to be followed by what is done about it; `undefined` while the parent lives.
 */
export function parentGone(
  boot: number,
  now: number,
  underNpm: boolean,
): string | undefined {
  if (now !== boot)
    return `the parent process ${String(boot)} ended (now ${String(now)})`;
  if (underNpm && boot === 1)
    return "npm, the parent process, ended before the orchestrator started (its parent is PID 1)";
  return undefined;
}

/**
 * Watches the parent: reads it at once, then every interval, until it is gone ({@link parentGone}) —
 * then stops watching and tells `onGone`, once. Unreferenced: the watch never keeps a process alive by
 * itself — `start`'s loops do while there is work, and `process.exit` ends the process — so it never
 * holds a spec's process, nor keeps alive one whose work waits on nothing.
 *
 * @param watch - the reader, the baseline and the interval.
 * @param underNpm - whether npm runs the process.
 * @param onGone - told why, once the parent is gone; possibly before this returns.
 * @returns what stops the watch; harmless to call again.
 */
export function watchParent(
  watch: ParentWatch,
  underNpm: boolean,
  onGone: (why: string) => void,
): () => void {
  const parentPid = watch.parentPid ?? (() => process.ppid);
  const boot = watch.bootParentPid ?? BOOT_PARENT_PID;
  let timer: NodeJS.Timeout | undefined;
  /** Stops the watch; harmless when already stopped. */
  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  /**
   * Reads the parent once; gone, stops the watch and reports it.
   *
   * @returns whether the parent is gone.
   */
  const check = (): boolean => {
    const why = parentGone(boot, parentPid(), underNpm);
    if (why === undefined) return false;
    stop();
    onGone(why);
    return true;
  };
  if (!check())
    timer = setInterval(check, watch.intervalMs ?? PARENT_WATCH_MS).unref();
  return stop;
}
