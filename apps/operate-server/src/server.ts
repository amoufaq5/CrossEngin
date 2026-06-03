import type { ForwardedProto } from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel/manifest";
import { buildOperateGateway, type EntityStore, type OperateServer } from "@crossengin/operate-runtime";

import { parseMethod, rawToIncoming, type RawHttpRequest, type RawHttpResponse } from "./http.js";
import { buildPrincipalWiring, type ApiKeySpec, type JwtVerifyConfig } from "./principals.js";

let requestCounter = 0;
function defaultRequestId(): string {
  requestCounter += 1;
  return `req_${Date.now().toString(36)}${requestCounter.toString(36).padStart(4, "0")}`;
}

export interface OperateHttpServerOptions {
  readonly gateway: OperateServer;
  readonly defaultScheme?: ForwardedProto;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
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

  constructor(opts: OperateHttpServerOptions) {
    this.gateway = opts.gateway;
    this.scheme = opts.defaultScheme ?? "http";
    this.idGenerator = opts.idGenerator ?? defaultRequestId;
    this.now = opts.now ?? (() => new Date());
  }

  async dispatch(raw: RawHttpRequest, body: Uint8Array | null): Promise<RawHttpResponse> {
    const method = parseMethod(raw.method);
    if (method === null) {
      return problem(405, METHOD_NOT_ALLOWED_TYPE, "Method not allowed", `unsupported method ${raw.method}`);
    }
    const forwardedProto = headerScheme(raw) ?? this.scheme;
    const incoming = rawToIncoming(raw, body, {
      method,
      scheme: forwardedProto,
      id: this.idGenerator(),
      receivedAt: this.now().toISOString(),
    });
    const { response } = await this.gateway.runtime.handleRequest(incoming);
    return { status: response.status, headers: { ...response.headers }, body: response.bodyBytes };
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
  });
  const httpServer = new OperateHttpServer({
    gateway,
    ...(options.defaultScheme !== undefined ? { defaultScheme: options.defaultScheme } : {}),
    ...(options.idGenerator !== undefined ? { idGenerator: options.idGenerator } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { httpServer, gateway };
}
