/**
 * BackWPup's storage destinations — slugs, labels, and which are Pro-only.
 *
 * Shared by `OnboardingPage` (step 3's picker) and `StorageSidebar` (the dashboard's picker), which
 * render the same destinations from the same registry.
 *
 * **There are two different `data-storage` namespaces in the DOM**, verified in the captured
 * markup, and confusing them is a silent locator failure:
 *  - the *pickers* use the plugin's canonical UPPERCASE slug (`FOLDER`, `MSAZURE`, `RSC`, …), which
 *    is also what `$locked_pro_slugs` compares against and what the `onboarding_storage[]` form
 *    field submits;
 *  - the *compact storage list* (`components/storage-list-compact.php`) uses a kebab-case display
 *    slug (`microsoft-azure`, `rackspace-cloud`, `sugar-sync`, …).
 *
 * This module owns the canonical namespace only. Anything reading the compact list must not assume
 * these values.
 */

/** A storage destination's canonical slug, exactly as `data-storage` carries it in the pickers. */
export type StorageSlug =
  | "FOLDER"
  | "DROPBOX"
  | "FTP"
  | "MSAZURE"
  | "S3"
  | "SUGARSYNC"
  | "RSC"
  | "GDRIVE"
  | "GLACIER"
  | "HIDRIVE"
  | "ONEDRIVE";

/**
 * Each destination's visible label — its accessible name in the picker, since the tile's `<button>`
 * takes its name from the `<label>` text it contains. Captured from the rendered page, so these are
 * what `getByRole("button", { name })` will match.
 */
export const STORAGE_LABELS: Readonly<Record<StorageSlug, string>> = {
  FOLDER: "Website Server",
  DROPBOX: "Dropbox",
  FTP: "FTP",
  MSAZURE: "Microsoft Azure",
  S3: "Amazon S3",
  SUGARSYNC: "Sugar Sync",
  RSC: "Rackspace Cloud",
  GDRIVE: "Google Drive",
  GLACIER: "Amazon Glacier",
  HIDRIVE: "HiDrive",
  ONEDRIVE: "Microsoft OneDrive",
};

/**
 * The heading each destination's **settings panel** carries (`<Title> Settings`).
 *
 * Deliberately a separate map rather than `${STORAGE_LABELS[slug]} Settings`: the two vocabularies
 * agree for ten destinations and **disagree for `FOLDER`**, which is offered as "Website Server" in
 * the picker but titles its panel "Folder Settings". Deriving one from the other looked right and was
 * wrong for exactly the destination every credential-free scenario uses. Captured from the rendered
 * page, one value per panel, and asserted by the locator contract.
 */
export const STORAGE_PANEL_TITLES: Readonly<Record<StorageSlug, string>> = {
  FOLDER: "Folder Settings",
  DROPBOX: "Dropbox Settings",
  FTP: "FTP Settings",
  MSAZURE: "Microsoft Azure Settings",
  S3: "Amazon S3 Settings",
  SUGARSYNC: "Sugar Sync Settings",
  RSC: "Rackspace Cloud Settings",
  GDRIVE: "Google Drive Settings",
  GLACIER: "Amazon Glacier Settings",
  HIDRIVE: "HiDrive Settings",
  ONEDRIVE: "Microsoft OneDrive Settings",
};

/**
 * The destinations Free renders as locked upsells rather than usable options.
 *
 * Verified as `$locked_pro_slugs` in `components/storage-list.php:37`, gated on
 * `! BackWPup::is_pro() && $show_locked`. On a Pro build the list is empty and every destination is
 * selectable, which is why the locked markup can only be exercised on a Free cell.
 */
export const PRO_ONLY_STORAGES: readonly StorageSlug[] = [
  "GDRIVE",
  "GLACIER",
  "HIDRIVE",
  "ONEDRIVE",
];

/**
 * The local "Website Server" destination — the archive is written into
 * `wp-content/uploads/backwpup…` on the site itself.
 *
 * Named because it is the destination every credential-free scenario uses, and the one where the
 * Pro/Free restore divergence is cleanest: Pro deep-links straight at the on-disk archive, Free
 * makes the user re-upload it.
 */
export const LOCAL_STORAGE: StorageSlug = "FOLDER";

/** True if `slug` is only usable on a Pro build. */
export function isProOnlyStorage(slug: StorageSlug): boolean {
  return PRO_ONLY_STORAGES.includes(slug);
}

/**
 * The destination offered under `label`, matched the way a reader would — case- and
 * whitespace-insensitively.
 *
 * Lets a scenario name a destination as the user sees it ("website server") while the code keeps
 * working in the plugin's canonical slugs, with {@link STORAGE_LABELS} as the single translation
 * table. A misspelt label resolves to `undefined` so the caller can fail with a useful message
 * instead of silently addressing the wrong destination.
 */
export function storageForLabel(label: string): StorageSlug | undefined {
  const wanted = label.trim().toLowerCase();
  return (Object.keys(STORAGE_LABELS) as StorageSlug[]).find(
    (slug) => STORAGE_LABELS[slug].toLowerCase() === wanted,
  );
}
