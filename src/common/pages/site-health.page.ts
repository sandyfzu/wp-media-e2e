import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * Page object for Site Health's Info tab (`wp-admin/site-health.php?tab=debug`), which holds the
 * "Copy site info" text: every section of `WP_Debug_Data`, private fields left out by WordPress.
 *
 * The text sits in the copy button's `data-clipboard-text`, rendered by the server, so it is read
 * without touching the clipboard. Navigation is the caller's, through {@link goto}.
 */
export class SiteHealthPage {
  constructor(private readonly page: Page) {}

  /** The button holding the copy text — one on the page, found by its role and English name. */
  get copyButton(): Locator {
    return this.page.getByRole("button", {
      name: "Copy site info to clipboard",
    });
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
   * The copy text, read from the button once it is on the page. Its value is checked in code: a
   * failed attribute matcher would print the whole text into the report.
   *
   * @param options - `timeout` for the button to appear (ms).
   * @throws {@link Error} when there is not exactly one button, or it holds no text.
   */
  async siteInfoText(
    options: { readonly timeout?: number } = {},
  ): Promise<string> {
    await expect(
      this.copyButton,
      "Site Health shows one 'Copy site info to clipboard' button",
    ).toHaveCount(1, options);
    const text = await this.copyButton.getAttribute("data-clipboard-text");
    if (text === null || text.trim() === "") {
      throw new Error(
        "[site-health] the 'Copy site info to clipboard' button holds no site info",
      );
    }
    return text;
  }
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
