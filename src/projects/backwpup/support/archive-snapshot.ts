import { archivedRuns, readHistory } from "./history";
import { theScheduledJob } from "./job-options";
import { readBackupFolder } from "./plugin-folders";
import type { HistoryRecord, RunOrder } from "./history";
import type { SiteDirectory } from "../../../common/wp/files";
import type { Transport } from "../../../common/config/types";

/**
 * The archives a scenario arranged, as they were when it arranged them — what "untouched" is
 * measured against once a command has had its go at them.
 *
 * A refused delete is worth a scenario because a delete that half-worked is the failure users pay
 * for, and only a digest taken *before* the command can see that: the archive's own name and size
 * would survive a body rewritten in place, and nothing on the site records an archive's contents.
 * The digests are computed on the site, so recording a large archive costs one small reply.
 *
 * It is also what "the oldest backup" and "the newest backup" mean: the first and the latest the
 * scenario made, **fixed when they were made**. Reading that from the history afterwards would let
 * it move — deleting an archive through the dashboard removes its history row, and a command that
 * one day did the same would turn "the oldest backup" into another file between the delete and the
 * assertion about it.
 */

/**
 * The digests of the archives `runs` left, read from the folder they were written to.
 *
 * @param runs - the history's rows for the runs that left an archive.
 * @param folder - the backup folder, read with digests.
 * @returns each archive's name mapped to its SHA-256.
 * @throws {@link Error} if a run's archive is not in the folder, or the folder was read without
 * digests — either way there is nothing to hold the archive to later.
 */
export function archiveDigests(
  runs: readonly HistoryRecord[],
  folder: SiteDirectory,
): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  for (const { filename } of runs) {
    const file = folder.files.find((candidate) => candidate.name === filename);
    if (file?.sha256 === undefined) {
      throw new Error(
        `[backwpup/archive-snapshot] the backup history records "${filename}", but ${folder.dir} ` +
          (file === undefined
            ? `holds no such file (it holds: ${folder.files.map((entry) => entry.name).join(", ") || "nothing"}).`
            : "was read without digests."),
      );
    }
    digests.set(filename, file.sha256);
  }
  return digests;
}

/** One scenario's record of the archives it arranged, in the order they were made. */
export class ArchiveSnapshot {
  /** Each recorded archive's SHA-256, by filename, in the order the runs made them. */
  private readonly digests = new Map<string, string>();

  /**
   * Records every archive the scheduled job's runs have left so far, as it is on the site now.
   *
   * Taken from the backup history rather than from a listing command, so what is recorded is what
   * the runs themselves say they made, in the order they made it. Recording again adds any archive
   * made since, after the ones already recorded.
   *
   * @param transport - the scenario's site.
   * @throws {@link Error} if the site has no single scheduled job, or a run's archive is missing.
   */
  async record(transport: Transport): Promise<void> {
    const job = await theScheduledJob(transport);
    // Only runs not recorded yet: one recorded earlier may since have been deleted on purpose.
    const runs = archivedRuns(await readHistory(transport)).filter(
      (run) => run.jobId === job.jobId && !this.digests.has(run.filename),
    );
    const folder = await readBackupFolder(transport, job.jobId, {
      digests: true,
    });
    for (const [name, digest] of archiveDigests(runs, folder)) {
      this.digests.set(name, digest);
    }
  }

  /**
   * The first or the latest archive recorded — what a scenario means by "the oldest backup" and
   * "the newest backup".
   *
   * @throws {@link Error} if nothing was recorded.
   */
  named(order: RunOrder): string {
    const names = [...this.digests.keys()];
    const name = order === "oldest" ? names[0] : names.at(-1);
    if (name === undefined) {
      throw new Error(
        `[backwpup/archive-snapshot] no backup was recorded, so there is no ${order} one. The ` +
          "steps that make a scenario's backups record them.",
      );
    }
    return name;
  }

  /**
   * The digest an archive had when it was recorded.
   *
   * @throws {@link Error} if it never was — a scenario comparing against a snapshot it did not take
   * would otherwise compare against nothing.
   */
  digestOf(name: string): string {
    const digest = this.digests.get(name);
    if (digest === undefined) {
      throw new Error(
        `[backwpup/archive-snapshot] "${name}" was never recorded, so there is nothing to compare ` +
          "it with. The steps that make a scenario's backups record them.",
      );
    }
    return digest;
  }
}
