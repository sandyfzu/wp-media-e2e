import { test, expect } from "@playwright/test";

import {
  renderElevationWarning,
  renderPluginDirWarning,
} from "./elevation-report";
import type { SiteElevation } from "./elevation-report";

/**
 * The run-level elevation warning, tested as what it is: a pure function from results to text.
 *
 * The properties worth pinning are the ones a terminal would hide — that it stays silent when
 * nothing is wrong, that a *deliberate* opt-out is never nagged about, that the affected sites are
 * named, and that the block is padded so it cannot be lost in tightly-packed output.
 */

/** One site's elevation state. Ownership is pending unless a case says otherwise. */
const site = (
  host: string,
  support: SiteElevation["support"],
  ownershipPending = true,
): SiteElevation => ({
  baseURL: `https://${host}`,
  transport: `ssh: ubuntu@${host}`,
  support,
  ownershipPending,
});

/**
 * ESC, built rather than written into a regex literal — lint bans a control character there, and
 * rightly: an invisible byte in a pattern is unreviewable in a diff.
 */
const ESC = String.fromCharCode(27);

/** ANSI colour sequences, for stripping. */
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** The banner with colour escapes stripped, so assertions read as the operator sees it. */
function plain(sites: readonly SiteElevation[]): string {
  return (renderElevationWarning(sites) ?? "").replace(ANSI, "");
}

test("says nothing when every site can elevate", () => {
  expect(
    renderElevationWarning([
      site("a.test", "available"),
      site("b.test", "available"),
    ]),
  ).toBeUndefined();
});

// The site declared `transport.elevate: false`. Warning about a choice the operator made every run
// is how a banner gets ignored when it finally matters.
test("says nothing about a site that declined privileges deliberately", () => {
  expect(
    renderElevationWarning([
      site("a.test", "disabled"),
      site("b.test", "available"),
    ]),
  ).toBeUndefined();
});

test("says nothing at all when there are no sites", () => {
  expect(renderElevationWarning([])).toBeUndefined();
});

test("names every affected site, and only those", () => {
  const text = plain([
    site("broken.test", "unavailable"),
    site("fine.test", "available"),
    site("opted-out.test", "disabled"),
    site("also-broken.test", "unavailable"),
  ]);

  expect(text).toContain("broken.test");
  expect(text).toContain("also-broken.test");
  expect(text).not.toContain("fine.test");
  expect(text).not.toContain("opted-out.test");
  // Counted as affected sites only. A denominator here would be the number of sites that got far
  // enough to be *asked* about privileges, not the fleet — so "2 of 2" on a run where a third site
  // failed its transport outright would quietly mean something other than it appears to.
  expect(text).toContain("on 2 site(s)");
  expect(text).not.toMatch(/\d+ of \d+/);
});

test("states both possible causes, because sudo reports them identically", () => {
  const text = plain([site("broken.test", "unavailable")]);
  expect(text).toMatch(/not a sudoer/);
  expect(text).toMatch(/requires a password/);
  expect(text).toMatch(/cannot tell\s+them apart/);
});

test("names the concrete cost and both remedies", () => {
  const text = plain([site("broken.test", "unavailable")]);
  expect(text).toMatch(/ownership is NOT normalized/);
  expect(text).toMatch(/leftover plugin data is NOT removed/);
  expect(text).toMatch(/debug\.log/);
  expect(text).toMatch(/NOPASSWD/);
  expect(text).toMatch(/transport\.elevate: false/);
});

// The whole point of the block: it must survive being printed between other output.
test("is padded with a blank line above and below", () => {
  const lines = plain([site("broken.test", "unavailable")]).split("\n");
  expect(lines[0]).toBe("");
  expect(lines.at(-1)).toBe("");
});

/**
 * Colour is asked for, and that is all this can pin.
 *
 * `styleText` decides at call time from the stream: interactively, and under CI runners that set
 * `FORCE_COLOR` (Playwright does, which is why this assertion holds here), the banner is yellow. In
 * the other documented use — `healthcheck > fleet.log`, or a cron pipe — it degrades to plain text
 * and the padding and the `⚠` are what make it stand out instead. Asserting the escape without
 * saying so would claim an operator experience that is only sometimes real.
 */
test("asks for colour, so it reads as a warning wherever colour survives", () => {
  const raw =
    renderElevationWarning([site("broken.test", "unavailable")]) ?? "";
  expect(raw).toContain(ESC);
  // What carries the warning when colour does not: these are unconditional.
  expect(plain([site("broken.test", "unavailable")])).toContain("⚠");
});

/**
 * The banner must not assert a cost the pre-flight check printed one line above it denies. A site
 * whose transport user already owns the install is told there that nothing will be changed; saying
 * "ownership is NOT normalized" for it in the next paragraph is how a warning stops being read.
 */
test("claims the ownership cost only for sites that actually needed a handover", () => {
  const owned = plain([site("owns-it.test", "unavailable", false)]);
  expect(owned).not.toContain("ownership is NOT normalized");
  expect(owned).not.toContain("ownership handover pending");
  // The costs that are true for every affected site are still stated.
  expect(owned).toContain("leftover plugin data is NOT removed");

  const needs = plain([site("needs-it.test", "unavailable", true)]);
  expect(needs).toContain("ownership is NOT normalized");

  // Mixed: the cost appears once, and only the site it is true for is marked.
  const mixed = plain([
    site("owns-it.test", "unavailable", false),
    site("needs-it.test", "unavailable", true),
  ]);
  expect(mixed).toContain("ownership is NOT normalized");
  expect(
    mixed
      .split("\n")
      .filter((line) => line.includes("ownership handover pending")),
  ).toHaveLength(1);
  expect(mixed).toContain("needs-it.test  [ssh: ubuntu@needs-it.test]  ←");
});

test("names each site by maskSiteUrl: credentials ***@, a baseURL that is no URL never printed", () => {
  const banner = plain([
    {
      baseURL: "https://admin:pw-0001@creds.test/wp?k=v",
      transport: "ssh: ubuntu@creds.test",
      support: "unavailable",
      ownershipPending: true,
    },
    {
      baseURL: "https://admin:pa ss-word9@bad host/",
      transport: "ssh: ubuntu@bad",
      support: "unavailable",
      ownershipPending: true,
    },
  ]);
  expect(banner).toContain(
    "https://***@creds.test/wp  [ssh: ubuntu@creds.test]",
  );
  expect(banner).toContain("(not a valid http(s) URL)  [ssh: ubuntu@bad]");
  for (const secret of ["pw-0001", "ss-word9", "k=v"])
    expect(banner).not.toContain(secret);
});

test.describe("renderPluginDirWarning", () => {
  const sites = (leftovers: readonly string[][]) =>
    leftovers.map((dirs, i) => ({
      baseURL: `https://site${String(i)}.test`,
      transport: `ssh: ubuntu@site${String(i)}.test`,
      leftovers: dirs,
    }));

  test("says nothing when no site holds a leftover folder", () => {
    expect(renderPluginDirWarning(sites([[], []]))).toBeUndefined();
    expect(renderPluginDirWarning([])).toBeUndefined();
  });

  test("names only the affected sites, each folder, the cause and what happens next", () => {
    const banner = (
      renderPluginDirWarning(sites([[], ["/p/backwpup-pro: a folder …"]])) ?? ""
    ).replace(ANSI, "");
    expect(banner).toContain("LEFTOVER PLUGIN FOLDERS");
    expect(banner).toContain("on 1 site(s)");
    expect(banner).not.toContain("site0.test");
    expect(banner).toContain("https://site1.test  [ssh: ubuntu@site1.test]");
    expect(banner).toContain("• /p/backwpup-pro: a folder …");
    expect(banner).toContain("PHP-FPM restart, a reboot");
    expect(banner).toContain(
      "The next @plugin scenario on the site removes it",
    );
    // Padded like the elevation banner, so it cannot be lost in packed output.
    expect(banner.startsWith("\n")).toBe(true);
    expect(banner.endsWith("\n")).toBe(true);
  });

  test("masks credentials in a site's address", () => {
    const banner = renderPluginDirWarning([
      {
        baseURL: "https://user:secret@site.test",
        transport: "local",
        leftovers: ["x"],
      },
    ]);
    expect(banner).not.toContain("secret");
  });
});
