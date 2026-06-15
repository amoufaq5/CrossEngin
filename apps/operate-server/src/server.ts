import type { ForwardedProto, PipelineExecution } from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { RateLimitChecker } from "@crossengin/api-gateway-runtime";
import {
  buildOperateGateway,
  type EntityStore,
  type ExtraRoute,
  type OperateServer,
  type ReportRunner,
} from "@crossengin/operate-runtime";

import { parseMethod, rawToIncoming, splitTarget, type RawHttpRequest, type RawHttpResponse } from "./http.js";
import { buildPrincipalWiring, type ApiKeySpec, type JwtVerifyConfig } from "./principals.js";

let requestCounter = 0;
function defaultRequestId(): string {
  requestCounter += 1;
  return `req_${Date.now().toString(36)}${requestCounter.toString(36).padStart(4, "0")}`;
}

/**
 * A structural sink for the per-request `PipelineExecution` the gateway produces.
 * `OperateHttpServer.dispatchWithMatch` records each served request's execution
 * here after building the response — making the gateway request-audit trail
 * durable (e.g. to `meta.gateway_pipeline_executions` via
 * `PostgresPipelineExecutionStore`). The `GatewayRuntime` only *returns* the
 * execution on its `HandleResult`; this is the seam the serving binary uses to
 * persist it (P2.45 / ADR-0153). A record failure must never break the served
 * response, so the dispatcher routes it through `onExecutionSinkError` and
 * continues.
 */
export interface ExecutionSink {
  record(execution: PipelineExecution): Promise<void>;
}

export interface OperateHttpServerOptions {
  readonly gateway: OperateServer;
  readonly defaultScheme?: ForwardedProto;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
  /** Optional durable sink for each request's `PipelineExecution`. */
  readonly executionSink?: ExecutionSink;
  /** Routes a sink failure (never breaks the response); defaults to stderr. */
  readonly onExecutionSinkError?: (err: unknown) => void;
}

const METHOD_NOT_ALLOWED_TYPE = "https://crossengin.io/problems/method-not-allowed";

/**
 * The framework-agnostic serving core: turns a `RawHttpRequest` + body into a
 * `RawHttpResponse` by mapping it to a gateway `IncomingRequest`, running the
 * full pipeline, and projecting the `OutgoingResponse` back out. Binds no
 * socket, so it is unit-tested offline; the Node `http` adapter is a thin shell
 * over `dispatch`.
 */
export class OperateHttpServer {
  private readonly gateway: OperateServer;
  private readonly scheme: ForwardedProto;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly executionSink: ExecutionSink | null;
  private readonly onExecutionSinkError: (err: unknown) => void;

  constructor(opts: OperateHttpServerOptions) {
    this.gateway = opts.gateway;
    this.scheme = opts.defaultScheme ?? "http";
    this.idGenerator = opts.idGenerator ?? defaultRequestId;
    this.now = opts.now ?? (() => new Date());
    this.executionSink = opts.executionSink ?? null;
    this.onExecutionSinkError =
      opts.onExecutionSinkError ??
      ((err) =>
        process.stderr.write(
          `[operate-server] execution sink error: ${err instanceof Error ? err.message : String(err)}\n`,
        ));
  }

  async dispatch(raw: RawHttpRequest, body: Uint8Array | null): Promise<RawHttpResponse> {
    return (await this.dispatchWithMatch(raw, body)).response;
  }

  /**
   * Like `dispatch`, but additionally surfaces the matched route's operationId so
   * the listener can attribute the request to a per-route SLO surface. `null`
   * means no route matched (e.g. 404 or unknown method).
   */
  async dispatchWithMatch(
    raw: RawHttpRequest,
    body: Uint8Array | null,
  ): Promise<{ response: RawHttpResponse; matchedOperationId: string | null }> {
    // Public, unauthenticated liveness probe (no tenant data) — served before the
    // gateway so platform health checks get a 200 without hitting an authed route.
    if (raw.method.toUpperCase() === "GET" && splitTarget(raw.url).path === "/healthz") {
      const body = new TextEncoder().encode(JSON.stringify({ status: "ok" }));
      return {
        response: {
          status: 200,
          headers: { "content-type": "application/json", "content-length": body.byteLength.toString() },
          body,
        },
        matchedOperationId: null,
      };
    }
    const method = parseMethod(raw.method);
    if (method === null) {
      return {
        response: problem(
          405,
          METHOD_NOT_ALLOWED_TYPE,
          "Method not allowed",
          `unsupported method ${raw.method}`,
        ),
        matchedOperationId: null,
      };
    }
    const forwardedProto = headerScheme(raw) ?? this.scheme;
    const incoming = rawToIncoming(raw, body, {
      method,
      scheme: forwardedProto,
      id: this.idGenerator(),
      receivedAt: this.now().toISOString(),
    });
    const { response, execution } = await this.gateway.runtime.handleRequest(incoming);
    if (this.executionSink !== null) {
      try {
        await this.executionSink.record(execution);
      } catch (err) {
        this.onExecutionSinkError(err);
      }
    }
    return {
      response: { status: response.status, headers: { ...response.headers }, body: response.bodyBytes },
      matchedOperationId: execution.routeOperationId,
    };
  }
}

function headerScheme(raw: RawHttpRequest): ForwardedProto | null {
  const v = raw.headers["x-forwarded-proto"];
  const proto = Array.isArray(v) ? v[0] : v;
  return proto === "https" || proto === "http" ? proto : null;
}

function problem(status: number, type: string, title: string, detail: string): RawHttpResponse {
  const body = new TextEncoder().encode(JSON.stringify({ type, title, status, detail, extensions: {} }));
  return {
    status,
    headers: {
      "content-type": "application/problem+json",
      "content-length": body.byteLength.toString(),
    },
    body,
  };
}

export interface BuildOperateHttpServerOptions {
  readonly manifest: Manifest;
  readonly store: EntityStore;
  readonly apiKeys: readonly ApiKeySpec[];
  /** Optional production identity: verify Bearer JWTs against a JWKS. */
  readonly jwt?: JwtVerifyConfig;
  readonly defaultScheme?: ForwardedProto;
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
  /** Optional durable sink for each request's `PipelineExecution`. */
  readonly executionSink?: ExecutionSink;
  readonly onExecutionSinkError?: (err: unknown) => void;
  /**
   * Optional rate-limit checker (defaults to the gateway's in-memory checker).
   * A Postgres-backed checker persists its decisions to
   * `meta.rate_limit_decisions`, which keeps a persisted execution's
   * `rateLimitDecisionId` resolvable to a real row.
   */
  readonly rateLimitChecker?: RateLimitChecker;
  /**
   * Optional report runner. When set, `GET /v1/reports/:report` serves executed
   * report data (full-dataset SQL pushdown or bounded in-memory) under the same
   * gateway pipeline + auth as the entity routes.
   */
  readonly reportRunner?: ReportRunner;
  /** When set, register `GET /v1/openapi.json` (the API description). */
  readonly serveApiDescriptor?: boolean;
  /** Info block for the served OpenAPI document. */
  readonly openApiInfo?: { readonly title: string; readonly version: string };
  /** Additional non-entity gateway routes (e.g. the marketplace install surface). */
  readonly extraRoutes?: readonly ExtraRoute[];
}

export interface BuiltOperateHttpServer {
  readonly httpServer: OperateHttpServer;
  readonly gateway: OperateServer;
}

/**
 * Composes a resolved manifest + an entity store + an API-key set into a ready
 * `OperateHttpServer`: builds the gateway (routes + handlers + redaction from
 * the manifest) wired to the auth resolver derived from the API keys.
 */
export function buildOperateHttpServer(options: BuildOperateHttpServerOptions): BuiltOperateHttpServer {
  const wiring = buildPrincipalWiring(options.apiKeys, options.now !== undefined ? { now: options.now } : {});
  const gateway = buildOperateGateway(options.manifest, {
    store: options.store,
    principalRoles: wiring.principalRoles,
    principalResolver: wiring.principalResolver,
    opaqueTokenLookup: wiring.opaqueTokenLookup,
    ...(options.jwt !== undefined
      ? {
          jwksProvider: options.jwt.jwksProvider,
          jwtIssuer: options.jwt.issuer,
          jwtAudience: options.jwt.audience,
        }
      : {}),
    ...(options.now !== undefined ? { clock: { now: options.now } } : {}),
    ...(options.rateLimitChecker !== undefined ? { rateLimitChecker: options.rateLimitChecker } : {}),
    ...(options.reportRunner !== undefined ? { reportRunner: options.reportRunner } : {}),
    ...(options.serveApiDescriptor !== undefined ? { serveApiDescriptor: options.serveApiDescriptor } : {}),
    ...(options.openApiInfo !== undefined ? { openApiInfo: options.openApiInfo } : {}),
    ...(options.extraRoutes !== undefined ? { extraRoutes: options.extraRoutes } : {}),
  });
  const httpServer = new OperateHttpServer({
    gateway,
    ...(options.defaultScheme !== undefined ? { defaultScheme: options.defaultScheme } : {}),
    ...(options.idGenerator !== undefined ? { idGenerator: options.idGenerator } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.executionSink !== undefined ? { executionSink: options.executionSink } : {}),
    ...(options.onExecutionSinkError !== undefined ? { onExecutionSinkError: options.onExecutionSinkError } : {}),
  });
  return { httpServer, gateway };
}
