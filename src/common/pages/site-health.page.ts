import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * Page object for Site Health's Info tab (`wp-admin/site-health.php?tab=debug`), which holds the
 * "Copy site info" text: every section of `WP_Debug_Data`, private fields left out by WordPress.
 *
 * The text sits in the copy button's `data-clipboard-text`, rendered by the server, so it is read
 * without touching the clipboard. Navigation is the caller's, through {@link SiteHealthPage.goto}.
 */
export class SiteHealthPage {
  constructor(private readonly page: Page) {}

  /** The button holding the copy text — one on the page, found by its role and English name. */
  get copyButton(): Locator {
    return this.page.getByRole("button", { name: COPY_BUTTON_NAME });
  }

  /**
   * Opens the Info tab. The page asks the REST API for directory sizes as it loads — a walk of the
   * whole docroot on a cold cache — which the copy text never needs, so that request is aborted.
   *
   * @param options - `timeout` for the navigation (ms).
   * @throws {@link Error} at once when the page answers an HTTP error — 403 for a user who may not
   *   view Site Health — rather than leaving the wait for its button to time out.
   */
  async goto(options: { readonly timeout?: number } = {}): Promise<void> {
    await this.page.route(isDirectorySizesRequest, (route) => route.abort());
    const response = await this.page.goto(
      "/wp-admin/site-health.php?tab=debug",
      options,
    );
    if (response !== null && !response.ok()) {
      throw new Error(
        `[site-health] the Info tab answered HTTP ${String(response.status())}`,
      );
    }
  }

  /**
   * The copy text cut down to the fields asked for: every `### section ###` header, and each
   * `key: value` line whose `section.key` is in `fields` — the rest never leaves the page. Whatever a
   * call returns is recorded in a trace, and a locator's wait logs its element with the attribute in
   * it, so the text is found and filtered by one `page.evaluate` once the button is there.
   *
   * @param fields - the `section.key` names to keep, e.g. `wp-core.version`.
   * @param options - `timeout` for the button to appear (ms).
   * @returns the kept lines, in Site Health's own format.
   * @throws {@link Error} when there is not exactly one button, or it holds no text.
   */
  async siteInfoFields(
    fields: readonly string[],
    options: { readonly timeout?: number } = {},
  ): Promise<string> {
    // Only counted: the matcher's log names the locator, never the element's attributes.
    await expect(
      this.copyButton,
      "Site Health shows one 'Copy site info to clipboard' button",
    ).toHaveCount(1, options);
    const kept = await this.page.evaluate(pickSiteInfoFields, {
      name: COPY_BUTTON_NAME,
      fields: [...fields],
    });
    if (kept.buttons !== 1) {
      throw new Error(
        `[site-health] expected one 'Copy site info to clipboard' button holding the site info, found ${String(kept.buttons)}`,
      );
    }
    if (kept.text === undefined) {
      throw new Error(
        "[site-health] the 'Copy site info to clipboard' button holds no site info",
      );
    }
    return kept.text;
  }
}

/** The copy button's accessible name: its text in WordPress's markup. */
const COPY_BUTTON_NAME = "Copy site info to clipboard";

/** What {@link pickSiteInfoFields} found. */
interface PickedFields {
  /** How many copy buttons the page holds. */
  readonly buttons: number;
  /** The kept lines; absent when the one button holds no text. */
  readonly text?: string;
}

/**
 * Runs **in the page** (so it may use nothing from this module): finds the copy button by its name
 * and keeps the headers and the asked-for field lines of its text, as {@link SiteHealthPage.siteInfoFields}
 * describes.
 *
 * @param arg - the button's name, and the `section.key` names to keep.
 */
function pickSiteInfoFields(arg: {
  readonly name: string;
  readonly fields: readonly string[];
}): PickedFields {
  const label = (button: Element): string =>
    (button.getAttribute("aria-label") ?? button.textContent)
      .replace(/\s+/g, " ")
      .trim();
  const buttons = [
    ...document.querySelectorAll("button[data-clipboard-text]"),
  ].filter((button) => label(button) === arg.name);
  const [button] = buttons;
  if (buttons.length !== 1 || button === undefined) {
    return { buttons: buttons.length };
  }
  const text = button.getAttribute("data-clipboard-text") ?? "";
  if (text.trim() === "") return { buttons: 1 };
  const kept: string[] = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const header = /^### (\S+)(?: \(\d+\))? ###\s*$/.exec(line);
    if (header !== null) {
      section = header[1] ?? "";
      kept.push(line.trimEnd());
      continue;
    }
    const key = /^([\w-]+):/.exec(line)?.[1];
    if (key !== undefined && arg.fields.includes(`${section}.${key}`)) {
      kept.push(line.trimEnd());
    }
  }
  return { buttons: 1, text: kept.join("\n") };
}

/** The directory-sizes REST route, under pretty permalinks (`/wp-json/…`) or plain ones (`?rest_route=`). */
const DIRECTORY_SIZES_ROUTE = "/wp-site-health/v1/directory-sizes";

/** Whether a request is the directory-sizes call, in either permalink form. */
export function isDirectorySizesRequest(url: URL): boolean {
  return (
    url.pathname.endsWith(DIRECTORY_SIZES_ROUTE) ||
    url.searchParams.get("rest_route") === DIRECTORY_SIZES_ROUTE
  );
}
