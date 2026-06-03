import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";
import { InMemoryEntityStore, type EntityStore } from "@crossengin/operate-runtime";
import { PostgresEntityStore } from "@crossengin/operate-runtime-pg";

import type { ServeOptions } from "./cli.js";
import type { RawHttpRequest } from "./http.js";
import { loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";
import { parseApiKeySpec } from "./principals.js";
import { OperateHttpServer, buildOperateHttpServer } from "./server.js";

/** The slice of Node's `IncomingMessage` the adapter reads. */
export interface NodeReqLike extends AsyncIterable<Uint8Array> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

/** The slice of Node's `ServerResponse` the adapter writes. */
export interface NodeResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(chunk?: Uint8Array): void;
}

async function readBody(req: NodeReqLike): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Builds a Node `http` request listener over an `OperateHttpServer`: collects
 * the body, dispatches through the gateway, and writes the `RawHttpResponse`. A
 * dispatch throw becomes a 500 problem document rather than a hung socket.
 */
export function createNodeRequestListener(
  server: OperateHttpServer,
): (req: NodeReqLike, res: NodeResLike) => Promise<void> {
  return async (req, res) => {
    try {
      const body = await readBody(req);
      const raw: RawHttpRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        remoteAddress: req.socket?.remoteAddress ?? null,
      };
      const response = await server.dispatch(raw, body);
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
          extensions: {},
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

async function resolveStore(options: ServeOptions): Promise<EntityStore> {
  if (options.store === "memory") return new InMemoryEntityStore();
  const conn = createNodePgConnection(parsePgEnvConfig());
  return new PostgresEntityStore(conn, options.schema !== null ? { schema: options.schema } : {});
}

export interface RunningServer {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * Boots the full server from `ServeOptions`: loads + resolves the manifest
 * (pack or file), builds the entity store (in-memory or Postgres), wires the
 * API keys, and starts listening. Returns a handle for graceful shutdown.
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const store = await resolveStore(options);
  const apiKeys = options.apiKeys.map(parseApiKeySpec);
  const { httpServer } = buildOperateHttpServer({
    manifest,
    store,
    apiKeys,
    defaultScheme: options.defaultScheme,
  });
  const listener = createNodeRequestListener(httpServer);
  const server = createServer((req, res) => {
    void listener(req as unknown as NodeReqLike, res as unknown as NodeResLike);
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
