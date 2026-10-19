/**
 * A configuration the orchestrator cannot start with — its own config file, or a suite file it
 * reads, such as a product's sites file. The command prints the message alone — one line, or a
 * heading and one line per problem — and exits `1`: the operator fixes a file, not the code, so a
 * stack trace would only bury the lines that name it.
 *
 * Carries no `cause` on purpose: a cause's own message can quote the file it failed on — `JSON.parse`
 * prints the text around the error, credentials included — and a logged error prints its causes.
 * Whatever names the problem goes into the message.
 */
export class ConfigError extends Error {
  /**
   * @param message - what is wrong and where — a file, or a path in it (`tasks[1].cell`); never a
   *   value read from a file that holds credentials, and a key only as a name (`describeKey`).
   */
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
