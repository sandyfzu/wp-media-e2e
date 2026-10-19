/**
 * Waits for `work`, but no longer than `budgetMs`: for best-effort steps whose hang must not cost the
 * run the time it budgeted for its real work.
 *
 * The work is not cancelled — nothing here can stop a remote command — so it keeps whatever it holds
 * until it ends on its own. Its later outcome is ignored; a rejection then raises no unhandled error,
 * since the race already handles it.
 *
 * @param work - the step, already running.
 * @param budgetMs - how long it may take.
 * @param what - the step, for the message: "ending the saved session".
 * @returns what `work` resolved with.
 * @throws {@link Error} what `work` rejected with, or, once the budget is spent, one naming the step.
 */
export async function withinBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${what} had not finished after ${String(budgetMs / 1000)} s`,
        ),
      );
    }, budgetMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
