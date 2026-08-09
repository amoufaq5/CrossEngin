import type { ForwardedProto, HttpMethod, PipelineExecution } from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Region } from "@crossengin/residency";
import { decideRegionRouting, type TenantResidencyDirectory } from "@crossengin/residency-runtime";
import {
  buildOperateGateway,
  type BillingPortalWiring,
  type EntitlementResolver,
  type EntityStore,
  type ExtraGatewayRoute,
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

/**
 * Data-residency edge routing: this instance's `region` + a tenant→profile
 * directory. Before dispatch, a request carrying a tenant hint whose profile
 * forbids `region` is redirected to the tenant's home region (or denied), so a
 * tenant's data is only ever served from a residency-compatible region.
 */
export interface RegionGuardConfig {
  readonly region: Region;
  readonly directory: TenantResidencyDirectory;
  /** Header carrying the tenant hint used for pre-auth routing (default `x-tenant-id`). */
  readonly tenantHeader?: string;
}

export interface OperateHttpServerOptions {
  readonly gateway: OperateServer;
  readonly webhookRoute?: WebhookRoute;
  readonly regionGuard?: RegionGuardConfig;
  readonly defaultScheme?: ForwardedProto;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
  /**
   * Invoked with the `PipelineExecution` of every gateway-dispatched request
   * (after the response is produced). The SLO request observer subscribes here
   * to feed the live request stream into the enforcement engines. Never throws
   * out of dispatch — an observer error is swallowed so observation can't break
   * serving.
   */
  readonly onExecution?: (execution: PipelineExecution) => void;
}

const METHOD_NOT_ALLOWED_TYPE = "https://crossengin.io/problems/method-not-allowed";
const MISDIRECTED_REGION_TYPE = "https://crossengin.io/problems/misdirected-region";
const RESIDENCY_VIOLATION_TYPE = "https://crossengin.io/problems/residency-violation";

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
  private readonly regionGuard: RegionGuardConfig | null;
  private readonly scheme: ForwardedProto;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly onExecution: ((execution: PipelineExecution) => void) | null;

  constructor(opts: OperateHttpServerOptions) {
    this.gateway = opts.gateway;
    this.webhookRoute = opts.webhookRoute ?? null;
    this.regionGuard = opts.regionGuard ?? null;
    this.scheme = opts.defaultScheme ?? "http";
    this.idGenerator = opts.idGenerator ?? defaultRequestId;
    this.now = opts.now ?? (() => new Date());
    this.onExecution = opts.onExecution ?? null;
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
    // Data-residency edge routing (pre-auth): route/deny by the request's tenant hint before dispatch.
    const residency = await this.checkResidency(raw);
    if (residency !== null) return residency;
    const forwardedProto = headerScheme(raw) ?? this.scheme;
    const incoming = rawToIncoming(raw, body, {
      method,
      scheme: forwardedProto,
      id: this.idGenerator(),
      receivedAt: this.now().toISOString(),
    });
    const { response, execution } = await this.gateway.runtime.handleRequest(incoming);
    if (this.onExecution !== null) {
      try {
        this.onExecution(execution);
      } catch {
        // Observation must never break serving.
      }
    }
    return { status: response.status, headers: { ...response.headers }, body: response.bodyBytes };
  }

  /**
   * Residency edge decision for a request. Uses the (unverified) tenant hint header only to *route*
   * (redirect to the tenant's home region) or *deny* a forbidden region — never to grant access, so a
   * spoofed hint can at worst misdirect the attacker's own request. A tenant with no residency profile
   * is unconstrained (returns null → dispatch proceeds); the gateway still authenticates authoritatively.
   */
  private async checkResidency(raw: RawHttpRequest): Promise<RawHttpResponse | null> {
    if (this.regionGuard === null) return null;
    const header = this.regionGuard.tenantHeader ?? "x-tenant-id";
    const raw0 = raw.headers[header];
    const hint = Array.isArray(raw0) ? raw0[0] : raw0;
    if (hint === undefined || hint === "") return null;
    const profile = await this.regionGuard.directory.resolve(hint);
    if (profile === null) return null;
    const decision = decideRegionRouting(profile, this.regionGuard.region);
    if (decision.action === "redirect") {
      return regionProblem(421, MISDIRECTED_REGION_TYPE, "Misdirected region", decision.reason, decision.region);
    }
    if (decision.action === "deny") {
      return regionProblem(403, RESIDENCY_VIOLATION_TYPE, "Residency violation", decision.reason, null);
    }
    return null;
  }
}

/** A residency problem doc carrying the correct region (as a header + an extension). */
function regionProblem(status: number, type: string, title: string, detail: string, correctRegion: Region | null): RawHttpResponse {
  const extensions = correctRegion !== null ? { correctRegion } : {};
  const bodyBytes = new TextEncoder().encode(JSON.stringify({ type, title, status, detail, extensions }));
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    "content-length": bodyBytes.byteLength.toString(),
  };
  if (correctRegion !== null) headers["x-crossengin-region"] = correctRegion;
  return { status, headers, body: bodyBytes };
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
  /** Optional data-residency edge guard: routes/denies by tenant home region before dispatch. */
  readonly regionGuard?: RegionGuardConfig;
  /** Extra after-write effects appended to the defaults (e.g. entity-event → job emission). */
  readonly additionalWriteEffects?: readonly WriteEffect[];
  /** Optional on-demand job invocation route (POST /v1/meta/jobs/invoke). */
  readonly jobInvoker?: JobInvoker;
  /** Roles permitted to call the job-invoke route; omit to leave it open to any tenant principal. */
  readonly jobInvokeRoles?: readonly string[];
  /** Per-action role overrides for the job-invoke route ({action → roles}). */
  readonly jobInvokeActionRoles?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Deployment-injected admin routes (e.g. marketplace pack install), registered ungated. */
  readonly extraRoutes?: readonly ExtraGatewayRoute[];
  readonly defaultScheme?: ForwardedProto;
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
  /** Optional live-request observer sink (e.g. the SLO request observer). */
  readonly onExecution?: (execution: PipelineExecution) => void;
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
    ...(options.jobInvokeRoles !== undefined ? { jobInvokeRoles: options.jobInvokeRoles as never } : {}),
    ...(options.jobInvokeActionRoles !== undefined ? { jobInvokeActionRoles: options.jobInvokeActionRoles } : {}),
    ...(options.extraRoutes !== undefined ? { extraRoutes: options.extraRoutes } : {}),
    ...(options.now !== undefined ? { clock: { now: options.now } } : {}),
  });
  const httpServer = new OperateHttpServer({
    gateway,
    ...(options.webhookRoute !== undefined ? { webhookRoute: options.webhookRoute } : {}),
    ...(options.regionGuard !== undefined ? { regionGuard: options.regionGuard } : {}),
    ...(options.defaultScheme !== undefined ? { defaultScheme: options.defaultScheme } : {}),
    ...(options.idGenerator !== undefined ? { idGenerator: options.idGenerator } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onExecution !== undefined ? { onExecution: options.onExecution } : {}),
  });
  return { httpServer, gateway };
}
