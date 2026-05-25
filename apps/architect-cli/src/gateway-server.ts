import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import type { HttpMethod, PipelineExecution } from "@crossengin/api-gateway";
import {
  buildIncomingRequest,
  type GatewayRuntime,
  type OutgoingResponse,
} from "@crossengin/api-gateway-runtime";

export interface PipelineExecutionSink {
  record(execution: PipelineExecution): Promise<void>;
}

export interface RequestLogEntry {
  readonly method: HttpMethod;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly requestId: string;
  readonly tenantId: string | null;
  readonly operationId: string | null;
}

export interface StartGatewayServerOptions {
  readonly runtime: GatewayRuntime;
  readonly port: number;
  readonly host?: string;
  readonly executionSink?: PipelineExecutionSink;
  readonly onRequest?: (entry: RequestLogEntry) => void;
  readonly idGenerator?: () => string;
  readonly clock?: () => Date;
  readonly maxBodyBytes?: number;
  readonly beforeHandle?: () => Promise<void>;
}

export interface RunningGatewayServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export function generateRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

export async function startGatewayServer(
  opts: StartGatewayServerOptions,
): Promise<RunningGatewayServer> {
  const host = opts.host ?? "127.0.0.1";
  const idGen = opts.idGenerator ?? generateRequestId;
  const clock = opts.clock ?? (() => new Date());
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const server: Server = createServer((req, res) => {
    void handleNodeRequest({
      req,
      res,
      runtime: opts.runtime,
      executionSink: opts.executionSink,
      onRequest: opts.onRequest,
      idGen,
      clock,
      maxBodyBytes,
      beforeHandle: opts.beforeHandle,
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(opts.port, host);
  });

  const address = server.address();
  const boundPort = address !== null && typeof address === "object" ? address.port : opts.port;

  return {
    host,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined && err !== null) reject(err);
          else resolve();
        });
      }),
  };
}

interface HandleNodeRequestInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly runtime: GatewayRuntime;
  readonly executionSink: PipelineExecutionSink | undefined;
  readonly onRequest: ((entry: RequestLogEntry) => void) | undefined;
  readonly idGen: () => string;
  readonly clock: () => Date;
  readonly maxBodyBytes: number;
  readonly beforeHandle: (() => Promise<void>) | undefined;
}

async function handleNodeRequest(input: HandleNodeRequestInput): Promise<void> {
  const startedAt = input.clock();
  const requestId = input.idGen();
  try {
    if (input.beforeHandle !== undefined) {
      await input.beforeHandle();
    }
    const bodyBytes = await readBody(input.req, input.maxBodyBytes);
    const incoming = buildIncomingFromNode({
      req: input.req,
      bodyBytes,
      requestId,
      receivedAtIso: startedAt.toISOString(),
    });
    if (incoming === null) {
      writeJson(input.res, 400, { error: "unsupported_method_or_path" });
      input.onRequest?.({
        method: (input.req.method ?? "GET") as HttpMethod,
        path: input.req.url ?? "",
        status: 400,
        durationMs: input.clock().getTime() - startedAt.getTime(),
        requestId,
        tenantId: null,
        operationId: null,
      });
      return;
    }
    const result = await input.runtime.handleRequest(incoming);
    writeOutgoing(input.res, result.response);
    if (input.executionSink !== undefined) {
      await input.executionSink.record(result.execution).catch(() => undefined);
    }
    input.onRequest?.({
      method: incoming.method,
      path: incoming.path,
      status: result.response.status,
      durationMs: input.clock().getTime() - startedAt.getTime(),
      requestId,
      tenantId: result.execution.tenantId,
      operationId: result.execution.routeOperationId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(input.res, 500, { error: "internal_error", reason: message.slice(0, 200) });
    input.onRequest?.({
      method: (input.req.method ?? "GET") as HttpMethod,
      path: input.req.url ?? "",
      status: 500,
      durationMs: input.clock().getTime() - startedAt.getTime(),
      requestId,
      tenantId: null,
      operationId: null,
    });
  }
}

export interface BuildIncomingFromNodeInput {
  readonly req: IncomingMessage;
  readonly bodyBytes: Uint8Array | null;
  readonly requestId: string;
  readonly receivedAtIso: string;
}

export function buildIncomingFromNode(
  input: BuildIncomingFromNodeInput,
): ReturnType<typeof buildIncomingRequest> | null {
  const method = input.req.method;
  const rawUrl = input.req.url;
  if (method === undefined || rawUrl === undefined) return null;
  if (!isHttpMethod(method)) return null;
  const host = headerOne(input.req.headers["host"]) ?? "localhost";
  const url = new URL(rawUrl, `http://${host}`);
  const query: Record<string, string | readonly string[]> = {};
  for (const key of url.searchParams.keys()) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(input.req.headers)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) continue;
    headers[name] = value;
  }
  const remoteAddress = input.req.socket.remoteAddress ?? "127.0.0.1";
  const isEncrypted =
    "encrypted" in input.req.socket &&
    Boolean((input.req.socket as { encrypted?: boolean }).encrypted);
  return buildIncomingRequest({
    id: input.requestId,
    receivedAt: input.receivedAtIso,
    method,
    path: url.pathname,
    query,
    headers,
    host,
    scheme: isEncrypted ? "https" : "http",
    bodyBytes: input.bodyBytes,
    clientIp: remoteAddress.slice(0, 45),
  });
}

export function writeOutgoing(res: ServerResponse, outgoing: OutgoingResponse): void {
  for (const [name, value] of Object.entries(outgoing.headers)) {
    res.setHeader(name, value);
  }
  res.statusCode = outgoing.status;
  if (outgoing.bodyBytes !== null && outgoing.bodyBytes.byteLength > 0) {
    res.end(Buffer.from(outgoing.bodyBytes));
  } else {
    res.end();
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", bytes.byteLength.toString());
  res.end(Buffer.from(bytes));
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        req.destroy(new Error(`request body exceeds ${maxBytes.toString()} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const combined = Buffer.concat(chunks, total);
      resolve(new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength));
    });
    req.on("error", reject);
  });
}

const HTTP_METHODS_SET: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
]);

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHODS_SET.has(value as HttpMethod);
}

function headerOne(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
