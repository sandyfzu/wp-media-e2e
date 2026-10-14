import { open, type FileHandle } from "node:fs/promises";

/**
 * Replacing one `FileHandle` method for the length of a test — the one way to make a real file do
 * what a race or a failing disk would (grow between `stat` and `read`, fail to flush) on cue. Every
 * handle in the process shares the prototype, so the original is always put back. `close` is each
 * handle's own property, not the prototype's: {@link failClose} replaces it on one handle.
 */

/** The `FileHandle` methods a test may replace: the prototype's. */
export type HandleMethod = "stat" | "read" | "sync" | "datasync";

/**
 * Runs `body` with every `FileHandle`'s `method` replaced by `replacement`, then restores it.
 *
 * @param method - the method replaced.
 * @param replacement - called with the handle as `this` and the original method, then the call's
 *   arguments.
 * @param body - the test's code.
 * @returns what `body` returns.
 */
export async function withHandleMethod<T>(
  method: HandleMethod,
  replacement: (
    this: FileHandle,
    original: (...args: unknown[]) => Promise<unknown>,
    ...args: unknown[]
  ) => Promise<unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const prototype = await handlePrototype();
  const original = prototype[method] as (
    ...args: unknown[]
  ) => Promise<unknown>;
  prototype[method] = function (this: FileHandle, ...args: unknown[]) {
    return replacement.call(
      this,
      (...forwarded: unknown[]) => original.apply(this, forwarded),
      ...args,
    );
  };
  try {
    return await body();
  } finally {
    prototype[method] = original;
  }
}

/** The prototype every `FileHandle` shares, from a handle opened on this module's own file. */
async function handlePrototype(): Promise<Record<HandleMethod, unknown>> {
  const handle = await open(new URL(import.meta.url), "r");
  try {
    return Object.getPrototypeOf(handle) as Record<HandleMethod, unknown>;
  } finally {
    await handle.close();
  }
}

/**
 * Makes `handle`'s close fail with `EIO` — after really closing it, so no descriptor leaks.
 *
 * @param handle - an open handle, typically `this` in a {@link withHandleMethod} replacement.
 */
export function failClose(handle: FileHandle): void {
  const close = handle.close.bind(handle);
  Object.defineProperty(handle, "close", {
    configurable: true,
    value: async (): Promise<void> => {
      await close();
      throw Object.assign(new Error("close failed"), { code: "EIO" });
    },
  });
}
