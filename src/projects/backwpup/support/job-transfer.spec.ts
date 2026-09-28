import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JobExports,
  STRIPPED_KEYS,
  describeExport,
  describeStoredJob,
  exportJob,
  jobsDigest,
  nameExportedJob,
  parseExportedJobs,
  parseKeyNames,
  settingsDifferingFromExport,
  settingsMissingFromExport,
} from "./job-transfer";
import type { LocalTransport } from "../../../common/config/types";

/**
 * A stub `wp` on PATH: every snippet and argv it is handed is recorded, and it answers with
 * `$WP_STUB_REPLY` — or, for `$WP_STUB_REPLY=refused`, the way WP-CLI answers a refusal.
 */
const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$*" > "$WP_STUB_CAPTURE.argv"
printf '%s' "$2" > "$WP_STUB_CAPTURE"
if [ "$WP_STUB_REPLY" = "refused" ]; then
  printf 'Error: the site stores no job 9' >&2
  exit 1
fi
printf '%s' "$WP_STUB_REPLY"
exit 0
`;

let binDir: string;
let capture: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-transfer-bin-"));
  capture = join(binDir, "captured-php.txt");
  writeFileSync(join(binDir, "wp"), STUB_WP);
  chmodSync(join(binDir, "wp"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CAPTURE = capture;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CAPTURE;
  delete process.env.WP_STUB_REPLY;
  rmSync(binDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir: binDir });
const captured = (): string => readFileSync(capture, "utf8");

/** The values the last snippet embedded, decoded the way PHP will decode them. */
function embedded(): unknown[] {
  return [...captured().matchAll(/base64_decode\( '([^']+)' \)/g)].map(
    (match) =>
      JSON.parse(Buffer.from(match[1] ?? "", "base64").toString()) as unknown,
  );
}

test.describe("STRIPPED_KEYS", () => {
  // As `JobExport.php` lists them, the run history and schedule state it never exports.
  test("names the nine keys job-export strips from every job", () => {
    expect([...STRIPPED_KEYS].sort()).toEqual(
      [
        "activ",
        "activetype",
        "backup_ids",
        "lastbackupdownloadurl",
        "lastrun",
        "lastruntime",
        "legacy",
        "logfile",
        "tempjob",
      ].sort(),
    );
  });
});

test.describe("parseKeyNames", () => {
  test("reads a list of key names", () => {
    expect(parseKeyNames('["name","type"]', "x")).toEqual(["name", "type"]);
    expect(parseKeyNames("[]", "x")).toEqual([]);
  });

  // "No keys differ" is the passing answer, so nothing else may read as it.
  for (const reply of ["", "Warning: x", "{}", '["name",3]', "null"]) {
    test(`refuses what is not a list of key names (${JSON.stringify(reply)})`, () => {
      expect(() => parseKeyNames(reply, "comparing")).toThrow(
        /comparing (did not come back as JSON|came back as .*, not a list of key names)/,
      );
    });
  }
});

test.describe("parseExportedJobs", () => {
  test("reads each job's id, keys and encrypted keys", () => {
    expect(
      parseExportedJobs(
        '[{"job_id":3,"keys":["jobid","name"],"encrypted":[]}]',
      ),
    ).toEqual([{ jobId: 3, keys: ["jobid", "name"], encrypted: [] }]);
  });

  for (const entry of [
    { job_id: 0, keys: [], encrypted: [] },
    { job_id: "3", keys: [], encrypted: [] },
    { job_id: 3, keys: "jobid", encrypted: [] },
    { job_id: 3, keys: [] },
    null,
  ]) {
    test(`refuses an entry that is not a job's description (${JSON.stringify(entry)})`, () => {
      expect(() => parseExportedJobs(JSON.stringify([entry]))).toThrow(
        /expected a job's id and keys/,
      );
    });
  }

  test("refuses a reply that is not a list", () => {
    expect(() => parseExportedJobs("{}")).toThrow(
      /expected the export file's jobs/,
    );
  });
});

test.describe("describeExport", () => {
  test("describes the file's jobs on the site, refusing a file that is not a list of jobs", async () => {
    process.env.WP_STUB_REPLY =
      '[{"job_id":3,"keys":["jobid","secret"],"encrypted":["secret"]}]';
    expect(await describeExport(local(), "/site/job.json")).toEqual([
      { jobId: 3, keys: ["jobid", "secret"], encrypted: ["secret"] },
    ]);
    const php = captured();
    expect(embedded()[0]).toBe("/site/job.json");
    expect(php).toContain(
      "$jobs = json_decode( (string) file_get_contents( $path ), true );",
    );
    expect(php).toContain(
      "if ( ! is_array( $jobs ) || array() === $jobs ) {\n\tWP_CLI::error( 'the file at ' . $path . ' is not a list of jobs' );\n}",
    );
    expect(php).toContain("! isset( $job['jobid'] )");
    // What counts as a secret: BackWPup's own encrypted form, `$BackWPup$…`.
    expect(php).toContain("0 === strpos( $value, '$BackWPup$' )");
  });
});

test.describe("describeStoredJob", () => {
  test("reads the job's keys raw from the jobs option, by its id", async () => {
    process.env.WP_STUB_REPLY =
      '{"keys":["jobid","dbdumpdbpassword"],"encrypted":["dbdumpdbpassword"]}';
    expect(await describeStoredJob(local(), 3)).toEqual({
      keys: ["jobid", "dbdumpdbpassword"],
      encrypted: ["dbdumpdbpassword"],
    });
    expect(embedded().slice(0, 2)).toEqual([3, "backwpup_jobs"]);
    expect(captured()).toContain("(int) $candidate['jobid'] === $id");
  });

  test("passes on the site's answer that it stores no such job", async () => {
    process.env.WP_STUB_REPLY = "refused";
    await expect(describeStoredJob(local(), 9)).rejects.toThrow(
      /stores no job 9/,
    );
  });

  test("refuses a reply that is not the job's keys", async () => {
    process.env.WP_STUB_REPLY = '{"keys":["jobid"]}';
    await expect(describeStoredJob(local(), 3)).rejects.toThrow(
      /expected job 3's keys/,
    );
  });
});

test.describe("settingsDifferingFromExport", () => {
  test("compares the file's one job with the stored one, value against value, on the site", async () => {
    process.env.WP_STUB_REPLY = '["dbdumpdbhost"]';
    expect(
      await settingsDifferingFromExport(local(), "/site/job.json", 5, [
        "jobid",
      ]),
    ).toEqual(["dbdumpdbhost"]);
    const php = captured();
    expect(php).toContain(
      "if ( 1 !== count( $jobs ) ) {\n\tWP_CLI::error( 'the file at ' . $path . ' holds ' . count( $jobs ) . ' jobs, not one' );\n}",
    );
    expect(php).toContain(
      "! array_key_exists( $key, $stored ) || wp_json_encode( $stored[ $key ] ) !== wp_json_encode( $value )",
    );
    expect(embedded()).toEqual([
      "/site/job.json",
      5,
      "backwpup_jobs",
      ["jobid"],
    ]);
  });

  test("ignores nothing unless told to", async () => {
    process.env.WP_STUB_REPLY = "[]";
    await settingsDifferingFromExport(local(), "/site/job.json", 3);
    expect(embedded().at(-1)).toEqual([]);
  });
});

test.describe("settingsMissingFromExport", () => {
  test("lists the job's settings the file's one job leaves out, beyond those job-export drops by design", async () => {
    process.env.WP_STUB_REPLY = '["archiveformat"]';
    expect(
      await settingsMissingFromExport(local(), "/site/job.json", 5),
    ).toEqual(["archiveformat"]);
    const php = captured();
    expect(php).toContain(
      "if ( 1 !== count( $jobs ) ) {\n\tWP_CLI::error( 'the file at ' . $path . ' holds ' . count( $jobs ) . ' jobs, not one' );\n}",
    );
    // What the export drops on purpose — an empty string, a secret, a stripped key — is not missing.
    expect(php).toContain(
      "\tif ( '' === $value || $encrypted( $value ) || in_array( (string) $key, $stripped, true ) ) {\n\t\tcontinue;\n\t}\n",
    );
    expect(php).toContain(
      "\tif ( ! array_key_exists( $key, $exported ) ) {\n\t\t$missing[] = (string) $key;\n\t}\n",
    );
    expect(embedded()).toEqual([
      "/site/job.json",
      5,
      "backwpup_jobs",
      [...STRIPPED_KEYS],
    ]);
  });

  // "Nothing is missing" is the passing answer, so nothing else may read as it.
  for (const reply of ["", "Warning: x", "null"]) {
    test(`refuses a reply that is not a list of key names (${JSON.stringify(reply)})`, async () => {
      process.env.WP_STUB_REPLY = reply;
      await expect(
        settingsMissingFromExport(local(), "/site/job.json", 5),
      ).rejects.toThrow(
        /comparing job 5 with the export file (did not come back as JSON|came back as)/,
      );
    });
  }

  test("passes on the site's answer that it stores no such job", async () => {
    process.env.WP_STUB_REPLY = "refused";
    await expect(
      settingsMissingFromExport(local(), "/site/job.json", 9),
    ).rejects.toThrow(/stores no job 9/);
  });
});

test.describe("jobsDigest", () => {
  test("digests the jobs option's row as the database holds it", async () => {
    process.env.WP_STUB_REPLY = "a".repeat(64);
    expect(await jobsDigest(local())).toBe("a".repeat(64));
    const php = captured();
    expect(php).toContain(
      '$wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",',
    );
    expect(php).toContain("echo hash( 'sha256', $raw );");
    expect(embedded()).toEqual(["backwpup_jobs"]);
  });

  test("refuses a reply that is not a digest", async () => {
    process.env.WP_STUB_REPLY = "Notice: x";
    await expect(jobsDigest(local())).rejects.toThrow(
      /expected a digest of the site's jobs/,
    );
  });
});

test.describe("nameExportedJob", () => {
  test("renames the file's one job, rewrites the file keyed as it was, and reads it back", async () => {
    process.env.WP_STUB_REPLY = "named";
    await nameExportedJob(local(), "/site/job.json", "Renamed by the import");
    const php = captured();
    expect(embedded()).toEqual(["/site/job.json", "Renamed by the import"]);
    expect(php).toContain("$jobs[ $key ]['name'] = $name;");
    expect(php).toContain(
      "file_put_contents( $path, wp_json_encode( $jobs, JSON_PRETTY_PRINT ) )",
    );
    expect(php).toContain("array_keys( $back ) === array_keys( $jobs )");
  });

  test("refuses a file that did not read back renamed", async () => {
    process.env.WP_STUB_REPLY = "differs";
    await expect(
      nameExportedJob(local(), "/site/job.json", "x"),
    ).rejects.toThrow(/did not read back with its job renamed/);
  });
});

test.describe("exportJob", () => {
  test("exports the job to the file given, relative to where WP-CLI runs", async () => {
    process.env.WP_STUB_REPLY = "Success: Job exported successfully.";
    await exportJob(local(), 3, ".e2e_temp/private/k/job.json");
    expect(readFileSync(`${capture}.argv`, "utf8")).toBe(
      "backwpup job-export 3 --file=.e2e_temp/private/k/job.json",
    );
  });

  // An arrangement: a refusal here means the scenario cannot start as written.
  test("throws when the command refused", async () => {
    process.env.WP_STUB_REPLY = "refused";
    await expect(exportJob(local(), 9, "job.json")).rejects.toThrow(
      /exporting job 9 failed/,
    );
  });
});

test.describe("JobExports", () => {
  test("hands back the digest recorded for each export", () => {
    const exports = new JobExports();
    exports.record("job.json", "a".repeat(64));
    exports.record("other.json", "b".repeat(64));
    expect(exports.digestAt("job.json")).toBe("a".repeat(64));
    expect(exports.digestAt("other.json")).toBe("b".repeat(64));
  });

  // A comparison with nothing must not pass.
  test("refuses an export the scenario never recorded", () => {
    expect(() => new JobExports().digestAt("job.json")).toThrow(
      /was never exported by an arranging step/,
    );
  });
});
