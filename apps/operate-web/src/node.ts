import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

import type { WebServeOptions } from "./cli.js";
import type { RawWebRequest } from "./http.js";
import { loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { OperateWebServer, buildOperateWebServer } from "./server.js";

/** The slice of Node's `IncomingMessage` the adapter reads. */
export interface NodeReqLike {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
}

/** The slice of Node's `ServerResponse` the adapter writes. */
export interface NodeResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(chunk?: Uint8Array): void;
}

/**
 * Builds a Node `http` listener over an `OperateWebServer`: maps the request,
 * dispatches, and writes the JSON response. A dispatch throw becomes a 500
 * problem document rather than a hung socket. (The view-model routes are read
 * only, so no body is collected.)
 */
export function createNodeRequestListener(
  server: OperateWebServer,
): (req: NodeReqLike, res: NodeResLike) => Promise<void> {
  return async (req, res) => {
    try {
      const raw: RawWebRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
      };
      const response = await server.dispatch(raw);
      res.writeHead(response.status, response.headers);
      res.end(response.body ?? undefined);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "https://crossengin.io/problems/internal-error",
          title: "Internal server error",
          status: 500,
          detail,
        }),
      );
      res.writeHead(500, {
        "content-type": "application/problem+json",
        "content-length": payload.byteLength.toString(),
      });
      res.end(payload);
    }
  };
}

export interface RunningServer {
  readonly port: number;
  readonly server: Server;
  readonly webServer: OperateWebServer;
  close(): Promise<void>;
}

/**
 * Boots the web server from `WebServeOptions`: loads + resolves the manifest
 * (pack or file), builds the in-memory store, wires the API keys, and starts
 * listening. Returns a handle for graceful shutdown (and the `OperateWebServer`
 * so a caller can seed the in-memory store).
 */
export async function serve(options: WebServeOptions): Promise<RunningServer> {
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const apiKeySpecs = options.apiKeys.map(parseApiKeySpec);
  const webServer = buildOperateWebServer({ manifest, apiKeySpecs });
  const listener = createNodeRequestListener(webServer);
  const server = createServer((req, res) => {
    void listener(req as unknown as NodeReqLike, res as unknown as NodeResLike);
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    server,
    webServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
