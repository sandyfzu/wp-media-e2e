import { expect } from "@playwright/test";

import { Then } from "../fixtures";
import {
  HEADER_VERSION,
  KEY_KINDS,
  readEncryptionHeader,
  temporaryFilesBeside,
} from "../support/encryption";
import { runOrder } from "../support/history";
import { theScheduledJob } from "../support/job-options";
import { readBackupFolder } from "../support/plugin-folders";
import type { ArchiveSnapshot } from "../support/archive-snapshot";
import type { KeyKind } from "../support/encryption";
import type { Transport } from "../../../common/config/types";

/**
 * Steps for what `wp backwpup backup-encrypt` and `backup-decrypt` do to an archive.
 *
 * Both commands work **in place, under the archive's own name**, so what they did is read off the
 * archive itself, on the site: its first bytes say whether it is encrypted and with which kind of
 * key, and its digest — held to the one taken when its run made it, by `the {word} backup is still on
 * the site, byte for byte` — says whether a decrypt gave back exactly what was there before. Neither
 * command's own line is taken as proof.
 */

/**
 * That a backup the scenario made is now encrypted with the kind of key named: its header is
 * BackWPup's — `BACKWPUP`, the current version, and that key's type.
 */
async function expectEncrypted(
  transport: Transport,
  archives: ArchiveSnapshot,
  which: string,
  kind: KeyKind,
): Promise<void> {
  const name = archives.named(runOrder(which));
  const job = await theScheduledJob(transport);
  expect(
    await readEncryptionHeader(transport, job.jobId, name),
    `${name} should begin with BackWPup's encryption header, for a ${kind}`,
  ).toEqual({ version: HEADER_VERSION, type: KEY_KINDS[kind] });
}

Then(
  "the {word} backup is encrypted with a symmetric key",
  async ({ site, archives }, which: string) => {
    await expectEncrypted(site.transport, archives, which, "symmetric key");
  },
);

Then(
  "the {word} backup is encrypted with a public key",
  async ({ site, archives }, which: string) => {
    await expectEncrypted(site.transport, archives, which, "public key");
  },
);

/**
 * That neither command left its temporary file beside the backup — `<archive>.encrypted` or
 * `<archive>.decrypted` — which a completed command renames away and a clean refusal never writes.
 * Some refusals do leave one (a key of the wrong length), and no scenario sends those.
 */
Then(
  "nothing is left beside the {word} backup",
  async ({ site, archives }, which: string) => {
    const name = archives.named(runOrder(which));
    const job = await theScheduledJob(site.transport);
    const folder = await readBackupFolder(site.transport, job.jobId);
    expect(
      temporaryFilesBeside(folder.files, name),
      `what ${folder.dir} holds beside ${name}`,
    ).toEqual([]);
  },
);
