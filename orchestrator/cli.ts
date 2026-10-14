import { runCommand } from "./command";

/**
 * The orchestrator's command: `npm run orchestrator -- start …`. It parses the arguments and exits
 * with the code the command returns — nothing between: `start` has already settled every run,
 * released the lock and emptied the terminal, and only `process.exit` ends a process a paused
 * terminal or a run's pending wait would keep alive.
 *
 * The `orchestrator` script runs it as `exec node --import tsx`: one process, npm's own child. Never
 * through the `tsx` CLI, which runs it in a child and relays signals — repeated SIGINTs made that
 * relay SIGKILL the child, leaving the lock and the runs behind. And `exec`, because Ubuntu's `sh`
 * (dash) otherwise stays between npm and Node and keeps npm's relay from it: a SIGINT to npm's PID
 * never reached the orchestrator, and a SIGTERM ended npm and left the orchestrator running.
 *
 * It runs as it is imported, so it is the one module the import boundary's probe never imports.
 */

process.exit(await runCommand(process.argv.slice(2)));
