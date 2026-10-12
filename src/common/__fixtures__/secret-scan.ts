import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import AdmZip from "adm-zip";

/**
 * For specs: where a secret appears in a folder of run output — reports, Allure results, traces.
 *
 * Reports hide what they hold: a trace is a zip, the HTML report embeds its data as a base64 zip in
 * `index.html`, and a value may be stored base64-encoded. So each file is searched as bytes, every
 * zip is opened (nested ones too), and an embedded zip is decoded, for the secret itself and for its
 * base64 forms at each of the three byte alignments.
 */

/** The marker before the HTML report's embedded zip. */
const EMBEDDED_ZIP = "data:application/zip;base64,";

/** How deep zips nest before the scan stops opening them: a guard, not a limit reports reach. */
const MAX_DEPTH = 4;

/**
 * Every place under `root` that holds `secret`: a file's path relative to `root`, with `!entry` for
 * each zip entry opened on the way and `!embedded` for the HTML report's data.
 *
 * @param root - the folder to search; symlinks are not followed.
 * @param secret - at least 8 characters, so a base64 form cannot match by chance.
 */
export function findSecret(root: string, secret: string): string[] {
  if (secret.length < 8) {
    throw new Error("findSecret: a secret this short would match by chance");
  }
  const needles = needlesFor(secret);
  const found: string[] = [];
  for (const file of filesUnder(root)) {
    scan(readFileSync(file), relative(root, file), needles, found, 0);
  }
  return found;
}

/** The byte strings that betray `secret`: itself, and its base64 forms at each alignment. */
function needlesFor(secret: string): Buffer[] {
  const bytes = Buffer.from(secret, "utf8");
  const needles = [bytes];
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(
      "base64",
    );
    // Only the characters made of the secret's bits alone: the first ones mix in the padding bytes
    // before it, the last ones whatever follows it.
    const first = Math.ceil((offset * 8) / 6);
    const last = Math.floor(((offset + bytes.length) * 8) / 6);
    needles.push(Buffer.from(encoded.slice(first, last), "ascii"));
  }
  return needles;
}

/** Every regular file under `dir`, recursively, never through a symlink. */
function filesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) files.push(...filesUnder(path));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}

/** Searches one buffer, then whatever it contains: a zip's entries, an embedded zip. */
function scan(
  data: Buffer,
  label: string,
  needles: readonly Buffer[],
  found: string[],
  depth: number,
): void {
  if (needles.some((needle) => data.includes(needle))) found.push(label);
  if (depth >= MAX_DEPTH) return;
  if (data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    for (const entry of new AdmZip(data).getEntries()) {
      if (entry.isDirectory) continue;
      scan(
        entry.getData(),
        `${label}!${entry.entryName}`,
        needles,
        found,
        depth + 1,
      );
    }
  }
  const text = data.toString("latin1");
  let at = text.indexOf(EMBEDDED_ZIP);
  while (at !== -1) {
    const start = at + EMBEDDED_ZIP.length;
    const end = /[^A-Za-z0-9+/=]/.exec(text.slice(start))?.index;
    const payload = text.slice(
      start,
      end === undefined ? undefined : start + end,
    );
    scan(
      Buffer.from(payload, "base64"),
      `${label}!embedded`,
      needles,
      found,
      depth + 1,
    );
    at = text.indexOf(EMBEDDED_ZIP, start);
  }
}
