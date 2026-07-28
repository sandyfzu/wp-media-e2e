/**
 * The APVM boundary: a lazily-created, per-process {@link Apvm} instance, the token rules that
 * gate private-repo builds, and a progress reporter that turns APVM's event stream into concise
 * console lines while buffering command output for failure diagnostics.
 *
 * This is the only module that imports `apvm-napi` (loading its native binding), so pure logic
 * (`request.ts`, `manifest.ts`) and the identity preflight (`verify.ts`) stay free of it and of
 * the native dependency. `resolve.ts` is the sole caller.
 */

import { styleText } from "node:util";

import { Apvm } from "apvm-napi";
import type { JsBuildEvent } from "apvm-napi";

/**
 * Projects whose source repository is **private**, so a build/warm needs a GitHub token.
 * BackWPup builds from `wp-media/backwpup-pro` (private); WP Rocket and Imagify are public
 * (a token there only raises rate limits). Kept as data so adding a private
 * product later is a one-line change.
 */
const TOKEN_REQUIRED_PROJECTS: ReadonlySet<string> = new Set(["backwpup"]);

/** The fix shown whenever a token is required but absent — the two ways to provide one. */
export const TOKEN_HINT =
  "Set GITHUB_TOKEN (a PAT with `repo` scope) or run `gh auth login`, then re-run.";

/** Whether building {@link project} requires a GitHub token (its source repo is private). */
export function requiresToken(project: string): boolean {
  return TOKEN_REQUIRED_PROJECTS.has(project);
}

/**
 * The process-wide {@link Apvm} instance, created once. Cached as the **promise** (not the
 * resolved value) so concurrent callers share a single `createWithTokenResolution` — which may
 * shell out to `gh auth token` — rather than racing to build several instances.
 */
let instance: Promise<Apvm> | undefined;

/**
 * Returns the lazily-created, process-wide {@link Apvm}. Token resolution follows APVM's own
 * order (config → `GITHUB_TOKEN` → `GH_TOKEN` → `gh` CLI → gh config); we never set `cacheDir`,
 * leaving APVM's cache at its default `~/.apvm/cache`. Created only on first build —
 * a placeholder-only run that skips resolution never triggers token resolution.
 */
export function getApvm(): Promise<Apvm> {
  instance ??= Apvm.createWithTokenResolution({}).catch((error: unknown) => {
    // Drop the failed promise so a later role/request retries rather than inheriting a
    // one-off failure (token resolution may shell out to `gh`, which can fail transiently).
    instance = undefined;
    throw error;
  });
  return instance;
}

/**
 * Throws an actionable error if {@link project} needs a token and {@link apvm} has none — caught
 * *before* any clone/download is attempted, so a missing token surfaces as one clear message
 * with the fix, not a deep-in-the-build git failure.
 */
export function assertToken(apvm: Apvm, project: string): void {
  if (requiresToken(project) && !apvm.hasToken()) {
    throw new Error(
      `Building "${project}" needs a GitHub token — its source repository is private. ${TOKEN_HINT}`,
    );
  }
}

// ── Secret redaction ───────────────────────────────────────────────────────────────
//
// A private-repo build authenticates with a GitHub token, and git echoes the remote URL
// verbatim in several of its failure messages (`fatal: unable to access
// 'https://user:token@github.com/…'`) — so raw builder output can carry the token. Everything
// we retain from APVM reaches a console log and the error a Playwright HTML/Allure report
// keeps, which CI routinely publishes as an artifact; scrubbing here is what keeps a token
// out of them.

/** GitHub tokens in every issued form: `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and `github_pat_`. */
const GITHUB_TOKEN_RE = /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/g;

/** `scheme://userinfo@host` — credentials embedded in a URL; the scheme and host are kept. */
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** The placeholder a redacted secret is replaced with. */
const REDACTED = "***";

/**
 * Replaces anything that looks like a credential in `text`. Applied to every APVM-sourced
 * string we log or attach to an error — never a substitute for not passing secrets around,
 * but the last line of defence before third-party output reaches a report. Idempotent, so
 * scrubbing twice on the way through nested handlers is harmless.
 *
 * Uses only `replace`, which resets a global regex's `lastIndex` on every call. Do **not**
 * switch these module-level `/g/` patterns to `test`/`exec`: those advance `lastIndex` and
 * would make every other call silently skip the start of the string.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(GITHUB_TOKEN_RE, REDACTED)
    .replace(URL_USERINFO_RE, `$1${REDACTED}@`);
}

/** How many trailing command-output lines to retain for a failed build's error context. */
const OUTPUT_TAIL = 40;

/** A build/warm progress reporter: the APVM callback plus the failure context it accumulates. */
export interface BuildReporter {
  /** Pass as the `onProgress` argument to `apvm.build()` / `apvm.warmCache()`. */
  readonly onProgress: (err: Error | null, event: JsBuildEvent) => void;
  /**
   * A formatted tail of the build — the `build_failed` reason and the last command-output lines —
   * to append to a thrown error when a build rejects. Empty when nothing noteworthy was seen.
   */
  failureContext(): string;
}

/**
 * Creates a {@link BuildReporter} for one build. Progress maps to concise console lines
 * (`phase_started`, `warning`); `command_output` stays quiet but is buffered, so on failure the
 * reason and the last {@link OUTPUT_TAIL} output lines can be attached to the error.
 *
 * Redaction placement follows where the text *escapes*: lines printed as they arrive are
 * scrubbed on arrival, while the buffer — private to this closure and only ever read by
 * {@link BuildReporter.failureContext} — is scrubbed once on the way out. A build emits tens of
 * thousands of output lines and at most one failure context, so this is the same guarantee for a
 * fraction of the work.
 *
 * @param label - short identifier for the artifact being built (e.g. `plugin develop`), prefixed
 * onto each line so parallel-free serial builds still read clearly.
 */
export function createBuildReporter(label: string): BuildReporter {
  const tail: string[] = [];
  let failureReason: string | undefined;

  const onProgress = (err: Error | null, event: JsBuildEvent): void => {
    // Error-first callback: ignore transport errors and absent events (per apvm-napi's contract).
    if (err !== null || (event as JsBuildEvent | undefined) === undefined)
      return;
    switch (event.type) {
      case "phase_started":
        console.log(
          `  ${styleText(["dim"], `[${label}]`)} ${String(event.phase)}` +
            (event.message !== undefined
              ? `: ${redactSecrets(event.message)}`
              : ""),
        );
        break;
      case "warning":
        if (event.message !== undefined) {
          console.warn(
            `  ${styleText(["yellow"], `[${label}] warning:`)} ${redactSecrets(event.message)}`,
          );
        }
        break;
      case "command_output":
        if (event.line !== undefined) {
          tail.push(event.line);
          if (tail.length > OUTPUT_TAIL) tail.shift();
        }
        break;
      case "build_failed":
        failureReason = event.reason;
        break;
      default:
        break;
    }
  };

  const failureContext = (): string => {
    const parts: string[] = [];
    if (failureReason !== undefined) parts.push(`\n  reason: ${failureReason}`);
    if (tail.length > 0) {
      parts.push(
        `\n  last output:\n${tail.map((line) => `    ${line}`).join("\n")}`,
      );
    }
    // Scrub on the way out — this is the only place the buffer and the reason are exposed.
    return redactSecrets(parts.join(""));
  };

  return { onProgress, failureContext };
}
