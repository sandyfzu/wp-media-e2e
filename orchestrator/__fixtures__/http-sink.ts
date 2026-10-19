import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local HTTP server standing in for Slack or Datator: it records each request and answers as the
 * test says — so the notifiers are tested over a real socket, with the real `fetch`.
 */

/** A request the sink received. */
export interface SunkRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

/** A running sink. */
export interface HttpSink {
  /** Its base URL, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** What it received, in order. */
  readonly requests: SunkRequest[];
  /** Stops it, ending any answer still open. */
  close(): Promise<void>;
}

/**
 * Starts a sink.
 *
 * @param answer - writes the answer to each request, after its body is read; may leave it open.
 * @returns the sink, listening.
 */
export async function startSink(
  answer: (request: SunkRequest, response: ServerResponse) => void,
): Promise<HttpSink> {
  const requests: SunkRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const request: SunkRequest = {
        method: incoming.method ?? "",
        path: incoming.url ?? "",
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(request);
      answer(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * An answer with a status and a body.
 *
 * @param status - the HTTP status.
 * @param body - the body.
 * @returns the answer.
 */
export function reply(
  status: number,
  body = "",
): (request: SunkRequest, response: ServerResponse) => void {
  return (_request, response) => {
    response.writeHead(status, { "Content-Type": "text/plain" });
    response.end(body);
  };
}
