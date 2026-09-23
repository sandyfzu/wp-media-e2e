import { expect } from "@playwright/test";

import { Given, Then, When } from "../fixtures";
import {
  allowForBackup,
  listBackups,
  runScheduledBackup,
} from "../support/backups";
import { FILE_MARKER_NAME } from "../support/markers";
import {
  findArchiveEntries,
  readArchiveEntry,
} from "../../../common/wp/archive";
import type { SiteMarkers } from "../support/markers";
import type { Transport } from "../../../common/config/types";

/**
 * Steps that ask a finished backup what it actually captured.
 *
 * Everything here matches on a **value**, never on the shape of the archive, and that is a
 * correctness requirement rather than a style choice. One of the cells is named `e2eSimple` and
 * keeps a stray `e2eSimple.sql` in its docroot, so "does this archive contain a file named after the
 * database?" is answered *yes* by a files-only backup that dumped nothing at all. A marker planted
 * for this scenario cannot appear in a file that was already there, so looking for the value gives
 * the same answer on every site.
 */

/** Members that could carry the database marker: BackWPup writes its dump as plain, uncompressed SQL. */
const SQL_MEMBERS = "*.sql";

/**
 * The file marker's member, wherever in the tree the archive places it.
 *
 * Derived from the name the marker is written under, so the two can never drift apart; the leading
 * `*` is what makes it independent of the prefix the archive gives the site's files, and it crosses
 * `/` in GNU tar's matching.
 */
const FILE_MARKER_MEMBER = `*${FILE_MARKER_NAME}`;

/**
 * The newest archive's path on the site.
 *
 * Absolute, and reported by the plugin itself — which only lists archives it can read, so a path
 * that comes back is one that can be opened.
 */
async function newestArchive(transport: Transport): Promise<string> {
  const [newest] = await listBackups(transport);
  expect(
    newest,
    "a backup should exist for this scenario to inspect",
  ).toBeDefined();
  if (newest === undefined) throw new Error("unreachable: asserted above");
  const { path } = newest;
  expect(
    path,
    `the newest archive ("${newest.name}") should report where it lives on the site`,
  ).toBeDefined();
  if (path === undefined) throw new Error("unreachable: asserted above");
  return path;
}

/**
 * Whether any member matching `pattern` contains `value`.
 *
 * Members are read one at a time rather than the archive being searched whole: only the few that
 * could plausibly carry a marker are ever *transferred*. That bounds the wire cost, not the site's —
 * every call is a full tar pass, so an absence assertion on a multi-gigabyte archive costs a handful
 * of passes (tens of seconds), well inside the backup budget but not free.
 *
 * @returns `false` when nothing matches the pattern — an archive with no such member cannot hold the
 * value, and that is an answer rather than a failure.
 */
async function archiveHolds(
  transport: Transport,
  archive: string,
  pattern: string,
  value: string,
): Promise<boolean> {
  const members = await findArchiveEntries(transport, archive, pattern);
  for (const member of members) {
    const contents = await readArchiveEntry(transport, archive, member);
    if (contents.includes(value)) return true;
  }
  return false;
}

/**
 * Asserts the archive's verdict on one marker, naming what was searched when it disappoints.
 *
 * An **absence** claim gets a positive control first: the archive is required to list at least one
 * member. Without it "the marker is not in there" would be indistinguishable from "nothing was
 * searched", and an assertion that can only ever pass is worse than none. The other two ways an
 * absence could go vacuous are already closed — `findArchiveEntries` throws rather than returning
 * empty when tar cannot parse the archive, and both patterns are asserted *positively* by another
 * scenario in this feature, so a typo in either fails loudly there.
 */
async function expectMarker(
  transport: Transport,
  pattern: string,
  value: string,
  present: boolean,
  what: string,
): Promise<void> {
  const archive = await newestArchive(transport);
  if (!present) {
    expect(
      (await findArchiveEntries(transport, archive, "*")).length,
      `"${archive}" should contain something — an archive listing no members at all cannot show that the ${what} marker is absent`,
    ).toBeGreaterThan(0);
  }
  expect(
    await archiveHolds(transport, archive, pattern, value),
    present
      ? `the ${what} marker planted before this backup should be inside "${archive}" (searched its "${pattern}" members)`
      : `the ${what} marker should not be inside "${archive}" — this job was not configured to cover it (searched its "${pattern}" members)`,
  ).toBe(present);
}

// ── Arrangement ──────────────────────────────────────────────────────────────

/**
 * Plants the markers, by asking for the fixture that owns them.
 *
 * The fixture plants them on first use and removes them when the scenario ends, so the step is the
 * whole of the arrangement and no scenario can forget to clean up after itself. Its assertions live
 * in the seeding code, which reads both values back out of the site rather than trusting that
 * writing them worked.
 */
Given(
  "the site holds marker data in its files and in its database",
  ({ markers }: { markers: SiteMarkers }) => {
    expect(
      markers.file,
      "the file marker should be a single-line random value",
    ).toMatch(/^[0-9a-f]{32}$/);
    expect(
      markers.database,
      "the database marker should be a single-line random value",
    ).toMatch(/^[0-9a-f]{32}$/);
    expect(
      markers.file,
      "the two markers must differ, or neither could tell which half of a backup captured it",
    ).not.toBe(markers.database);
  },
);

/**
 * Runs the configured job and waits for its archive.
 *
 * Started through WP-CLI rather than the dashboard because these scenarios are about what a backup
 * contains, not about the controls that start one — those have their own coverage, and driving them
 * here would make a failure ambiguous between the two.
 */
When("a backup runs", async ({ site, $testInfo }) => {
  // Playwright times a scenario and its hooks against one clock, so make room before spending any
  // of the budget `waitForBackup` is entitled to — without this the wait can be cut short by the
  // scenario timeout and fail as a bare "test timeout" that names nothing. A files backup of a real
  // site is minutes of tar, so the room is not theoretical.
  allowForBackup($testInfo);
  await runScheduledBackup(site.transport);
});

// ── What the archive turned out to hold ──────────────────────────────────────

/** The database half was captured: the value planted in `wp_options` is inside the archive's dump. */
Then("the archive holds the database marker", async ({ site, markers }) => {
  await expectMarker(
    site.transport,
    SQL_MEMBERS,
    markers.database,
    true,
    "database",
  );
});

/** The database half was left out — the job covered files only, and did not dump the database. */
Then("the archive holds no database marker", async ({ site, markers }) => {
  await expectMarker(
    site.transport,
    SQL_MEMBERS,
    markers.database,
    false,
    "database",
  );
});

/** The files half was captured: the marker written under the content directory is in the archive. */
Then("the archive holds the file marker", async ({ site, markers }) => {
  await expectMarker(
    site.transport,
    FILE_MARKER_MEMBER,
    markers.file,
    true,
    "file",
  );
});

/** The files half was left out — the job covered the database only, and swept in no site files. */
Then("the archive holds no file marker", async ({ site, markers }) => {
  await expectMarker(
    site.transport,
    FILE_MARKER_MEMBER,
    markers.file,
    false,
    "file",
  );
});
