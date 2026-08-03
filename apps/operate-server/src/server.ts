import type { ForwardedProto, HttpMethod } from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  buildOperateGateway,
  type BillingPortalWiring,
  type EntitlementResolver,
  type EntityStore,
  type JobInvoker,
  type OperateServer,
  type SequenceAllocator,
  type SettingsStore,
  type WriteEffect,
} from "@crossengin/operate-runtime";

import { parseMethod, rawToIncoming, splitTarget, type RawHttpRequest, type RawHttpResponse } from "./http.js";
import { buildPrincipalWiring, type ApiKeySpec, type JwtVerifyConfig } from "./principals.js";

let requestCounter = 0;
function defaultRequestId(): string {
  requestCounter += 1;
  return `req_${Date.now().toString(36)}${requestCounter.toString(36).padStart(4, "0")}`;
}

/**
 * A pre-dispatch route handled directly (bypassing the gateway auth pipeline) — for
 * signature-authenticated ingress like Stripe webhooks, where the request is verified by
 * its signature, not an API key/JWT. Matched by exact method + path before the gateway runs.
 */
export interface WebhookRoute {
  readonly method: HttpMethod;
  readonly path: string;
  handle(body: Uint8Array | null, headers: RawHttpRequest["headers"]): Promise<RawHttpResponse>;
}

export interface OperateHttpServerOptions {
  readonly gateway: OperateServer;
  readonly webhookRoute?: WebhookRoute;
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
  private readonly webhookRoute: WebhookRoute | null;
  private readonly scheme: ForwardedProto;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;

  constructor(opts: OperateHttpServerOptions) {
    this.gateway = opts.gateway;
    this.webhookRoute = opts.webhookRoute ?? null;
    this.scheme = opts.defaultScheme ?? "http";
    this.idGenerator = opts.idGenerator ?? defaultRequestId;
    this.now = opts.now ?? (() => new Date());
  }

  async dispatch(raw: RawHttpRequest, body: Uint8Array | null): Promise<RawHttpResponse> {
    const method = parseMethod(raw.method);
    if (method === null) {
      return problem(405, METHOD_NOT_ALLOWED_TYPE, "Method not allowed", `unsupported method ${raw.method}`);
    }
    // Signature-authenticated webhook ingress bypasses the gateway auth pipeline.
    if (this.webhookRoute !== null && method === this.webhookRoute.method && splitTarget(raw.url).path === this.webhookRoute.path) {
      return this.webhookRoute.handle(body, raw.headers);
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
  /** Allocates document numbers for sequence-defaulted fields on create. */
  readonly allocator?: SequenceAllocator;
  /** Backs the `/v1/admin/settings` endpoints + runtime numbering overrides. */
  readonly settingsStore?: SettingsStore;
  /** Roles permitted to manage tenant settings. */
  readonly adminRoles?: readonly string[];
  /** Optional subscription gate: denies a lapsed tenant (past_due → read-only). */
  readonly entitlementResolver?: EntitlementResolver;
  /** Optional Stripe Billing Portal route (POST /v1/meta/billing-portal). */
  readonly billingPortal?: BillingPortalWiring;
  /** Optional signature-authenticated webhook route handled ahead of the gateway. */
  readonly webhookRoute?: WebhookRoute;
  /** Extra after-write effects appended to the defaults (e.g. entity-event → job emission). */
  readonly additionalWriteEffects?: readonly WriteEffect[];
  /** Optional on-demand job invocation route (POST /v1/meta/jobs/invoke). */
  readonly jobInvoker?: JobInvoker;
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
    ...(options.allocator !== undefined ? { allocator: options.allocator } : {}),
    ...(options.settingsStore !== undefined ? { settingsStore: options.settingsStore } : {}),
    ...(options.adminRoles !== undefined ? { adminRoles: options.adminRoles as never } : {}),
    ...(options.entitlementResolver !== undefined ? { entitlementResolver: options.entitlementResolver } : {}),
    ...(options.billingPortal !== undefined ? { billingPortal: options.billingPortal } : {}),
    ...(options.additionalWriteEffects !== undefined ? { additionalWriteEffects: options.additionalWriteEffects } : {}),
    ...(options.jobInvoker !== undefined ? { jobInvoker: options.jobInvoker } : {}),
    ...(options.now !== undefined ? { clock: { now: options.now } } : {}),
  });
  const httpServer = new OperateHttpServer({
    gateway,
    ...(options.webhookRoute !== undefined ? { webhookRoute: options.webhookRoute } : {}),
    ...(options.defaultScheme !== undefined ? { defaultScheme: options.defaultScheme } : {}),
    ...(options.idGenerator !== undefined ? { idGenerator: options.idGenerator } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { httpServer, gateway };
}
