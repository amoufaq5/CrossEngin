import type { ForwardedProto, HttpMethod, PipelineExecution } from "@crossengin/api-gateway";
import type { AbacBatchEvaluator, AbacEvaluator, SensitiveFieldPolicy } from "@crossengin/auth";
import type { IdempotencyStore, RateLimitChecker } from "@crossengin/api-gateway-runtime";
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
  type WriteMaskMode,
} from "@crossengin/operate-runtime";

import { parseMethod, rawToIncoming, splitTarget, type RawHttpRequest, type RawHttpResponse } from "./http.js";
import { buildPrincipalWiring, type ApiKeySpec, type JwtVerifyConfig } from "./principals.js";
import { applyTenantStatusGate, type TenantStatusGateOptions } from "./tenant-status-gate.js";
import { AbacObligationsUnevaluable, checkAbacObligations } from "./abac-obligations.js";
import { withAbacAttributes, type AbacAttributeDirectory } from "./abac-attributes.js";

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
  /**
   * Who is privileged for each sensitive data class, for **both** the response redaction and the
   * write mask (ADR-0339).
   *
   * Absent until this option existed, which is why 39 of the 46 classified fields in the packs
   * were unreadable by every role: the redaction policy was `{}`, so `privilegedForClass` answered
   * false for everyone and only a field with an explicit per-field `read` grant came back. One
   * policy reaches both directions deliberately — `privilegedForClass` has one definition so that a
   * role cannot end up able to write a class it may not read (ADR-0329), and two policy sources
   * would have made that property unenforceable.
   */
  readonly policyForEntity?: (entity: string) => SensitiveFieldPolicy | undefined;
  /**
   * `explicit_only` (the default) enforces a per-field `update` grant the manifest declares;
   * `classified` adds the classification default. See `--classified-write-mask` for why the second
   * is opt-in and refuses at boot.
   */
  readonly writeMaskMode?: WriteMaskMode;
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
  /**
   * Enforce the caller tenant's lifecycle state on every request (ADR-0334). Absent ⇒ no gate, which
   * is what every deployment had: `meta.tenants.status` was a column nothing on the request path
   * read, so a `pending_deletion` tenant went on accepting writes into data about to be destroyed.
   */
  readonly tenantStatusGate?: TenantStatusGateOptions;
  /**
   * The per-request rate-limit decision maker. Absent ⇒ `buildOperateGateway` installs
   * `InMemoryRateLimitChecker` at 10,000/window, which is today's behaviour and persists nothing:
   * `meta.rate_limit_decisions` had a store and no caller, so no deployment has ever written a row.
   */
  readonly rateLimitChecker?: RateLimitChecker;
  /**
   * The gateway's replay guard. Absent ⇒ `buildOperateGateway` installs `InMemoryIdempotencyStore`,
   * which is today's behaviour and is **per process**: a retried `POST` landing on another replica,
   * or on this one after a restart, is not deduplicated — including on the tenant-deletion route,
   * the one route here that requires an idempotency key precisely because a retry mints a second
   * tombstone.
   */
  readonly idempotencyStore?: IdempotencyStore;
  /**
   * The deployment's ABAC policy layer, or absent for none — in which case a manifest declaring an
   * obligation is refused below (ADR-0340).
   *
   * One object rather than three options, because the three must agree and two of the pairings are
   * silently wrong if they can be formed separately. An `evaluator` without its `answerableKeys`
   * leaves this function unable to check that the manifest's obligations are ones the layer can
   * answer, which is the per-key gap ADR-0341 made the boot refusal ask about; and an evaluator
   * without an `attributeDirectory` refuses every obligation, since `dischargeAbac` treats an
   * unresolved attribute set as unanswerable. So `answerableKeys` is required beside the evaluator
   * and the directory is the one genuinely optional member — a policy over no attributes at all
   * (`present` on nothing) is expressible, if useless.
   *
   * `recordBearingKeys` joined them for the same reason: without it this function cannot tell a
   * policy that compares against the record from one that does not, so a manifest putting a record
   * policy on a `create` would compile and deny that grant at every request.
   *
   * `evaluateBatch` is the **second** genuinely optional member, beside the directory, and for the
   * opposite reason to the two required ones: absent, every obligation is still enforced through
   * one call per question, which is what every deployment did before it existed. It can only make
   * the asking cheaper, never the answer different — so there is nothing for its absence to break
   * and nothing to refuse at boot.
   */
  readonly abac?: {
    readonly evaluator: AbacEvaluator;
    /** The policy keys `evaluator` can answer. Checked against the manifest's obligations. */
    readonly answerableKeys: ReadonlySet<string>;
    /** Of those, the keys whose comparison references a field of the record. */
    readonly recordBearingKeys: ReadonlySet<string>;
    /** Answers a whole set of questions at once, for the per-record redaction pass (ADR-0344). */
    readonly evaluateBatch?: AbacBatchEvaluator;
    readonly attributeDirectory?: AbacAttributeDirectory;
  };
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
  // Before anything is compiled, and here rather than in `node.ts`, because this function is also
  // what compiles a *per-tenant* activated manifest — the same placement that gives a per-tenant
  // gateway the tenant-status gate (ADR-0334). A tenant whose own manifest declares an obligation
  // this deployment cannot discharge gets no gateway, which is the fail-closed answer: ADR-0314's
  // degradation to the JSONB fallback is right for a schema it cannot apply and wrong for an
  // authorization rule it cannot enforce, because serving the rule unenforced is the defect.
  const obligations = checkAbacObligations({
    manifest: options.manifest,
    answerableKeys: options.abac?.answerableKeys ?? new Set(),
    recordBearingKeys: options.abac?.recordBearingKeys ?? new Set(),
  });
  if (obligations.refusal !== null) throw new AbacObligationsUnevaluable(obligations);

  const wiring = buildPrincipalWiring(options.apiKeys, options.now !== undefined ? { now: options.now } : {});
  // Decorated here rather than inside `buildPrincipalWiring`: the directory needs a connection and
  // this is the seam that already takes deployment-supplied collaborators, so the api-key and JWT
  // paths both get attributes from one wrap instead of two.
  const principalResolver =
    options.abac?.attributeDirectory !== undefined
      ? withAbacAttributes(wiring.principalResolver, options.abac.attributeDirectory)
      : wiring.principalResolver;
  const gateway = buildOperateGateway(options.manifest, {
    store: options.store,
    principalRoles: wiring.principalRoles,
    principalResolver,
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
    ...(options.rateLimitChecker !== undefined ? { rateLimitChecker: options.rateLimitChecker } : {}),
    ...(options.idempotencyStore !== undefined ? { idempotencyStore: options.idempotencyStore } : {}),
    ...(options.policyForEntity !== undefined ? { policyForEntity: options.policyForEntity } : {}),
    ...(options.writeMaskMode !== undefined ? { writeMaskMode: options.writeMaskMode } : {}),
    ...(options.abac !== undefined ? { abacEvaluator: options.abac.evaluator } : {}),
    ...(options.abac?.evaluateBatch !== undefined
      ? { abacBatchEvaluator: options.abac.evaluateBatch }
      : {}),
    ...(options.now !== undefined ? { clock: { now: options.now } } : {}),
  });
  // After every registration and before the first request. The gate goes on the registry rather than
  // on each `register` call because that is the only way it is *total*: `operationIds()` is the whole
  // surface — manifest CRUD, lifecycle transitions, associations, the meta routes and every injected
  // `extraRoutes` entry — and a decorator applied per call site covers the ones somebody remembered.
  // `GatewayRuntime` resolves a handler per request from this same registry, so replacing entries
  // after it was constructed takes effect.
  if (options.tenantStatusGate !== undefined) {
    applyTenantStatusGate(gateway.handlers, options.tenantStatusGate);
  }
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
