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
  instance ??= Apvm.createWithTokenResolution({});
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
            (event.message !== undefined ? `: ${event.message}` : ""),
        );
        break;
      case "warning":
        if (event.message !== undefined) {
          console.warn(
            `  ${styleText(["yellow"], `[${label}] warning:`)} ${event.message}`,
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
    return parts.join("");
  };

  return { onProgress, failureContext };
}
