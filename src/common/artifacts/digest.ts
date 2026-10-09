/**
 * A resolved zip's SHA-256: what names the **artifact**, where a commit only names its source — two
 * builds of one commit are different files (a build regenerates `languages/*.pot` and stamps every
 * entry's mtime). The resolver records it for every role, so a report can say exactly which bytes it
 * tested, and an orchestrator that stores zips by their digest can match a run to its zip.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** A SHA-256 as {@link sha256File} writes it: 64 lowercase hex characters. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Whether `value` is a SHA-256 in the form the resolver records (64 lowercase hex). */
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

/**
 * Hashes a file by streaming it, so a large zip is never held in memory.
 *
 * @param path - the file to hash.
 * @returns its SHA-256, as 64 lowercase hex characters.
 * @throws the read error when the file cannot be opened or read.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
