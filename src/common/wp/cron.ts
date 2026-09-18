import { evalPhp, phpLiteral } from "./php";
import type { Transport } from "../config/types";

/**
 * WP-Cron: reading what a site has scheduled, and making a scheduled event happen now.
 *
 * A scenario about a *scheduled* feature has to answer two separate questions, and this module
 * keeps them separate: **is the event registered** ({@link nextScheduled}) and **what happens when
 * it fires** ({@link triggerScheduledEvent}). Asserting the first is what proves the product
 * scheduled anything at all; the second replaces waiting out a real schedule.
 *
 * ## Why not `wp cron event run <hook>`
 *
 * Two reasons, both measured on a live cell rather than assumed:
 *
 *  1. **It is not selective.** WP-CLI 2.12's own help says it "runs the next scheduled cron event
 *     for the given hook", but a probe with three events on one hook executed **all three**,
 *     including one scheduled hours ahead. A hook that several events share — which is exactly how
 *     per-job schedules are modelled — would therefore fire every one of them. Adding `--due-now`
 *     *does* restrict it to genuinely due events (verified separately), which is why the trigger
 *     below makes only the target event due.
 *  2. **It runs the work inside the WP-CLI process**, whose PHP is typically configured very
 *     differently from the web server's. On a host where the CLI has `memory_limit = -1`, a plugin
 *     that grows its own limit from the current value can end up *lowering* it and then dying —
 *     observed as a hard PHP fatal in a run that succeeds every time through the web server.
 *
 * So the trigger goes through **WordPress's own** `spawn_cron()`, which posts to `wp-cron.php` and
 * therefore executes the event in the same web context a real schedule would. That holds whether the
 * host disables WordPress's own cron and pokes `wp-cron.php` from a system crontab, or lets
 * WordPress spawn it from page loads — `spawn_cron()` is gated by neither. The one arrangement it
 * cannot serve is `ALTERNATE_WP_CRON`, whose branch reads `$_SERVER['REQUEST_METHOD']` and so
 * always declines under WP-CLI; a site using it would fail loudly rather than quietly.
 */

/**
 * Arguments identifying one scheduled event.
 *
 * WordPress keys an event by hook **and** by its argument array, so two events on the same hook
 * with different arguments are different events. Pass exactly the array the product scheduled with:
 * a list for the positional form core uses (`wp_schedule_event($t, 'daily', 'hook', [123])`), or an
 * object for the named form (BackWPup's `['arg' => <job id>]`). An empty object means "the event
 * registered with no arguments" — PHP decodes both `{}` and `[]` to the same empty array, which is
 * what WordPress hashes to key the event.
 */
export type CronArgs =
  | readonly (string | number | boolean)[]
  | Readonly<Record<string, string | number | boolean>>;

/**
 * Least time {@link triggerScheduledEvent} keeps offering the work to WordPress, in seconds.
 *
 * `spawn_cron()` declines while another cron run holds the `doing_cron` lock, and that is a fact
 * about the host, not about the test — so it is retried rather than reported. WordPress ignores a
 * lock once it is older than `WP_CRON_LOCK_TIMEOUT` (60s by default), so outlasting that is all a
 * budget has to do. It is a floor rather than the budget itself because a site may raise the
 * constant, which the snippet reads for itself.
 */
const SPAWN_BUDGET_FLOOR_SECONDS = 70;

/**
 * Most time {@link triggerScheduledEvent} will wait for the lock, in seconds.
 *
 * A site is free to set `WP_CRON_LOCK_TIMEOUT` to something extreme, and no scenario should hang for
 * it. Past this the trigger fails and names the constant, so the cause is the operator's to see
 * rather than a test that never returns.
 */
const SPAWN_BUDGET_CAP_SECONDS = 300;

/**
 * When WordPress will next run `hook` with `args`, as a Unix timestamp — or `undefined` when no
 * such event is scheduled.
 *
 * Asked of WordPress itself (`wp_next_scheduled`) rather than read out of `wp cron event list`,
 * because the list prints a formatted date and drops the distinction between two events that share
 * a hook. The timestamp is the assertion-grade value: a scenario can prove an event exists, and
 * compare two schedules, without parsing display text.
 *
 * @param transport - the site to ask.
 * @param hook - the cron hook name.
 * @param args - the argument array the event was scheduled with; omit for an argument-less event.
 * @throws {@link Error} if WordPress could not be asked at all — which is not the same answer as
 * "nothing is scheduled", so an empty or non-numeric reply is a fault rather than a `undefined`.
 */
export async function nextScheduled(
  transport: Transport,
  hook: string,
  args: CronArgs = {},
): Promise<number | undefined> {
  const out = await evalPhp(
    transport,
    `echo (int) wp_next_scheduled( ${phpLiteral(hook)}, ${phpLiteral(args)} );`,
    `reading the next run of "${hook}"`,
    "wp/cron",
  );
  // `Number("")` is 0, so an empty reply would otherwise read as "not scheduled" — the exact
  // confusion this function's contract promises never to make.
  const timestamp = out === "" ? Number.NaN : Number(out);
  if (!Number.isInteger(timestamp)) {
    throw new Error(
      `[wp/cron] expected a timestamp for "${hook}", got ${JSON.stringify(out)}.`,
    );
  }
  // `wp_next_scheduled` returns false — cast to 0 above — when the event is not scheduled.
  return timestamp === 0 ? undefined : timestamp;
}

/**
 * Makes one scheduled event due and lets WordPress run it, as if its time had simply arrived.
 *
 * The event is re-scheduled a second into the past and then handed to `spawn_cron()`, WordPress's
 * own "there is work to do" call, which posts to `wp-cron.php`. **Only the target event is moved**;
 * whatever else the site already had due runs alongside it, exactly as it would on any real cron
 * tick. A recurring event stays recurring: its schedule is read back and re-applied, so this cannot
 * silently downgrade one to a single event.
 *
 * **This returns as soon as WordPress has accepted the work**, not when the work has finished: the
 * cron request is deliberately non-blocking in core. Callers must wait on the product's own evidence
 * that the work completed — an artefact appearing, a status settling — never on this resolving. It
 * also returns when the event was picked up by *something else* — a host running `wp-cron.php` from
 * a system crontab will often get there first — because the event being gone is the work having been
 * accepted, and waiting for a spawn that can no longer happen would fail a scenario that succeeded.
 *
 * `spawn_cron()` declines while another cron run holds WordPress's `doing_cron` lock, which is a
 * property of the host rather than of the test, so it is retried until the lock can no longer be
 * the reason. The lock is **never deleted**: WordPress already ignores one older than
 * `WP_CRON_LOCK_TIMEOUT`, so deleting it buys nothing, while deleting a lock held by a run that is
 * merely slow would truncate that run — `wp-cron.php` re-reads the lock between events and stops
 * once it has changed. Waiting the timeout out is therefore both sufficient and safe.
 *
 * @param transport - the site whose schedule to advance.
 * @param hook - the cron hook name.
 * @param args - the argument array identifying the event; omit for an argument-less event.
 * @throws {@link Error} if the event is not scheduled (so a scenario cannot "trigger" something the
 * product never registered), if it could not be moved, or if WordPress never accepted the work.
 */
export async function triggerScheduledEvent(
  transport: Transport,
  hook: string,
  args: CronArgs = {},
): Promise<void> {
  const php = `
$hook = ${phpLiteral(hook)};
$args = ${phpLiteral(args)};
$event = wp_get_scheduled_event( $hook, $args );
if ( ! $event ) {
	WP_CLI::error( 'no event is scheduled for this hook and arguments' );
}
if ( false === wp_unschedule_event( $event->timestamp, $hook, $args ) ) {
	WP_CLI::error( 'the event could not be unscheduled' );
}
$due = time() - 1;
$moved = $event->schedule
	? wp_schedule_event( $due, $event->schedule, $hook, $args )
	: wp_schedule_single_event( $due, $hook, $args );
if ( false === $moved ) {
	// The event is already unscheduled at this point, so put it back: failing to advance a schedule
	// must not cost the site the schedule itself.
	$restored = $event->schedule
		? wp_schedule_event( $event->timestamp, $event->schedule, $hook, $args )
		: wp_schedule_single_event( $event->timestamp, $hook, $args );
	WP_CLI::error(
		'the event could not be re-scheduled as due; its original run was '
		. ( false === $restored ? 'lost as well' : 'put back' )
	);
}

// WordPress ignores a lock older than WP_CRON_LOCK_TIMEOUT, so outlasting that constant is the
// whole job — and the constant is read rather than assumed, because a site may raise it.
$budget = min( ${String(SPAWN_BUDGET_CAP_SECONDS)}, max( ${String(SPAWN_BUDGET_FLOOR_SECONDS)}, WP_CRON_LOCK_TIMEOUT + 10 ) );
$deadline = time() + $budget;
while ( true ) {
	if ( spawn_cron() ) {
		break;
	}
	// spawn_cron() returns false for two unrelated reasons: another run holds the lock, or nothing
	// is ready. Only the first is worth retrying. If something else already took the event — on a host
	// that pokes wp-cron.php from a system crontab, the likeliest outcome of all — then nothing is
	// ready any more and this would decline forever, so the work having been done must be recognised
	// as success rather than waited out and then reported as a failure to spawn.
	//
	// The cache drop is what makes that question answerable at all. WordPress autoloads the cron array
	// into the in-process options cache at bootstrap and never re-reads it, so both this call and
	// spawn_cron()'s own lock check would otherwise keep returning the values this snippet wrote
	// itself — measured on a live cell: zero queries, and wp_load_alloptions( true ) does not force one
	// either. Dropping the key is the only way a long-lived eval sees another process's writes.
	wp_cache_delete( 'alloptions', 'options' );
	$pending = wp_next_scheduled( $hook, $args );
	if ( false === $pending || $pending > $due ) {
		break;
	}
	if ( time() >= $deadline ) {
		WP_CLI::error(
			'WordPress declined to spawn cron for ' . $budget . 's'
			. ' (WP_CRON_LOCK_TIMEOUT is ' . WP_CRON_LOCK_TIMEOUT . 's)'
		);
	}
	sleep( 1 );
}
`;
  await evalPhp(
    transport,
    php,
    `triggering "${hook}" with ${JSON.stringify(args)}`,
    "wp/cron",
  );
}
