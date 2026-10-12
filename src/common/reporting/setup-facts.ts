import { readFileSync, statSync } from "node:fs";

import type { TestResult } from "@playwright/test/reporter";

import { isNonEmptyString, isObject } from "../guards";
import type { SiteVersions } from "../setup/site-info";

/**
 * What a run's setups found out, read back from the attachments they leave on their results: the
 * plugin zips under test (the artifacts setup's `artifacts-resolution.json`) and each site's versions
 * (the auth setup's `site-info.json`). Read in the runner by the reporters, which see a setup's
 * attachments in `onTestEnd` whether the setup then passed, failed or skipped.
 *
 * Every parser is total: an attachment that is missing, unreadable or of another shape reads as "not
 * known", never as an error — these facts describe a run, and must never fail one.
 */

/** The largest attachment read back: both are a few KB; anything far larger is not theirs. */
const MAX_ATTACHMENT_BYTES = 1024 * 1024;

/** One plugin zip under test, as the artifacts setup resolved and verified it. */
export type PluginFact =
  | {
      /** The role: `plugin` (under test) or `previous`. */
      readonly role: string;
      readonly ok: true;
      /** The `Plugin Name:` the zip was proven to carry. */
      readonly name?: string;
      /** Its `Version:` header. */
      readonly version?: string;
      /** The git ref asked for (`develop`, `release:latest-stable`). */
      readonly ref?: string;
      /** The full commit built. */
      readonly commit?: string;
      /** The ref that rebuilds it, when it says more than the commit (`release:3.17.4`). */
      readonly pin?: string;
      /** The zip's file name — what names an operator-provided zip. */
      readonly zip?: string;
      /** How the zip was chosen: `default-ref`, `env-ref`, `env-zip`. */
      readonly source?: string;
    }
  | {
      readonly role: string;
      readonly ok: false;
      /** The first check that failed, as one line: `<check>: <detail>`. */
      readonly error: string;
    };

/** One site's versions, or why they are unknown (`site-info.ts`'s entry, re-read). */
export type SiteFact =
  | { readonly baseURL: string; readonly versions: SiteVersions }
  | { readonly baseURL: string; readonly error: string };

/**
 * The JSON body of an attachment of a result, or `undefined` when it has none, or none readable.
 * Playwright keeps a body attached in memory as `body`, and one attached from a file as `path`.
 *
 * @param result - the setup's result.
 * @param name - the attachment's name.
 */
export function readJsonAttachment(
  result: Pick<TestResult, "attachments">,
  name: string,
): unknown {
  const attachment = result.attachments.find((a) => a.name === name);
  if (attachment === undefined) return undefined;
  try {
    let text: string | undefined;
    if (attachment.body !== undefined) {
      text = attachment.body.toString("utf8");
    } else if (attachment.path !== undefined) {
      // A regular file only: reading a FIFO would block the runner.
      const stat = statSync(attachment.path);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) return undefined;
      text = readFileSync(attachment.path, "utf8");
    }
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** A string field, or `undefined`. */
function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return isNonEmptyString(field) ? field : undefined;
}

/** Copies the string fields that are present, under their new names. */
function pickStrings(
  from: Record<string, unknown>,
  keys: Readonly<Record<string, string>>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [to, key] of Object.entries(keys)) {
    const value = stringField(from, key);
    if (value !== undefined) picked[to] = value;
  }
  return picked;
}

/** One role's fact, or `undefined` when the entry is not a role. */
function pluginFactOf(
  role: unknown,
  name: string | undefined,
): PluginFact | undefined {
  if (!isObject(role) || !isNonEmptyString(role.role)) return undefined;
  const checks = Array.isArray(role.checks) ? role.checks.filter(isObject) : [];
  const failed = checks.find((check) => check.ok !== true);
  if (role.ok !== true || failed !== undefined) {
    const check = stringField(failed ?? {}, "name") ?? "verification";
    const detail = stringField(failed ?? {}, "detail") ?? "failed";
    return {
      role: role.role,
      ok: false,
      error: `${check}: ${firstLine(detail)}`,
    };
  }
  const artifact = isObject(role.artifact) ? role.artifact : {};
  const info = isObject(role.info) ? role.info : {};
  return {
    role: role.role,
    ok: true,
    ...(name !== undefined ? { name } : {}),
    ...pickStrings(artifact, {
      version: "version",
      ref: "ref",
      commit: "commit",
      zip: "zipFilename",
      source: "source",
    }),
    // The setup's info names a pin only when it says more than the commit.
    ...pickStrings(info, { pin: "pin" }),
  };
}

/**
 * The plugin zips under test, from the artifacts setup's attachment.
 *
 * @param attachment - the attachment's parsed JSON.
 * @returns one fact per role, in the setup's order; none when the attachment is not one.
 */
export function parsePluginFacts(attachment: unknown): PluginFact[] {
  if (!isObject(attachment) || !Array.isArray(attachment.roles)) return [];
  const name = stringField(attachment, "pluginName");
  return attachment.roles
    .map((role) => pluginFactOf(role, name))
    .filter((fact): fact is PluginFact => fact !== undefined);
}

/**
 * Each site's versions, from the auth setup's attachment.
 *
 * @param attachment - the attachment's parsed JSON.
 * @returns one fact per site, in the setup's order; none when the attachment is not one.
 */
export function parseSiteFacts(attachment: unknown): SiteFact[] {
  if (!Array.isArray(attachment)) return [];
  const facts: SiteFact[] = [];
  for (const entry of attachment) {
    if (!isObject(entry) || !isNonEmptyString(entry.baseURL)) continue;
    if (isNonEmptyString(entry.error)) {
      facts.push({ baseURL: entry.baseURL, error: firstLine(entry.error) });
    } else if (isObject(entry.versions)) {
      facts.push({
        baseURL: entry.baseURL,
        versions: pickStrings(entry.versions, {
          wordpress: "wordpress",
          php: "php",
          phpSapi: "phpSapi",
          webServer: "webServer",
          database: "database",
          databaseExtension: "databaseExtension",
        }),
      });
    }
  }
  return facts;
}

/** A text's first line. */
function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}
