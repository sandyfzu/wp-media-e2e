/**
 * A state file the orchestrator refuses to go on with: a lock another orchestrator holds, or one it
 * cannot read; a run counter it cannot trust. The message names the file and what to do about it —
 * the operator acts on a file, so it is meant to be printed alone, without a stack.
 */
export class StateError extends Error {
  /**
   * @param message - what is wrong, the file's path, and the way out.
   */
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}
