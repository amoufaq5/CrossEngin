import {
  AUTH_SCHEME_SUPPORT,
  DEFAULT_SECURITY_HEADERS,
  type AuthOutcome,
  type IdempotencyOutcome,
  type IdempotencyRecord,
  type IncomingRequest,
  type PipelineExecution,
  type ResolvedPrincipal,
  type RouteMatchOutcome,
  computeRequestHashInputs,
  evaluateIdempotency,
} from "@crossengin/api-gateway";
import { sha256 } from "@crossengin/crypto";

import { type OutgoingResponse, outgoingResponseFromJson } from "./adapters.js";
import {
  servedAuthSchemesFor,
  type AuthSchemeServingInput,
} from "./auth-scheme-survey.js";
import {
  computeResponseRedaction,
  computeResponseRedactionForRecords,
  recordsIn,
  redactJsonValue,
  redactRecords,
  type RedactionRegistry,
} from "./redaction.js";
import {
  type JwksProvider,
  parseAuthHeader,
  resolvePrincipalForCredential,
  verifyBearerJwt,
} from "./auth.js";
import {
  HandlerRegistry,
  handlerOutputToResponse,
  type HandlerOutput,
} from "./dispatcher.js";
import { PipelineRecorder } from "./pipeline-runner.js";
import {
  authenticationRequired,
  forbidden,
  idempotencyMismatch,
  internalServerError,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  weakTlsRejected,
  type ProblemEnvelope,
} from "./problems.js";
import {
  type IdempotencyStore,
  type PrincipalResolver,
  type RateLimitChecker,
  type RouteRegistry,
} from "./stores.js";

export interface OpaqueTokenLookupResult {
  readonly principalRef: string;
  readonly scopes: readonly string[];
  readonly tenantId: string | null;
}

export interface OpaqueTokenLookup {
  lookup(request: IncomingRequest, token: string): Promise<OpaqueTokenLookupResult | null>;
}

export interface GatewayRuntimeOptions {
  readonly routes: RouteRegistry;
  readonly handlers: HandlerRegistry;
  readonly principalResolver: PrincipalResolver;
  readonly idempotencyStore: IdempotencyStore;
  readonly rateLimitChecker: RateLimitChecker;
  readonly jwksProvider?: JwksProvider;
  readonly jwtIssuer?: string;
  readonly jwtAudience?: string;
  readonly clockSkewSeconds?: number;
  readonly opaqueTokenLookup?: OpaqueTokenLookup;
  readonly clock?: { now(): Date };
  readonly defaultApiVersion?: string;
  readonly idempotencyTtlSeconds?: number;
  readonly redactionRegistry?: RedactionRegistry;
}

export interface HandleResult {
  readonly response: OutgoingResponse;
  readonly execution: PipelineExecution;
}

const HANDLER_ERROR_PROBLEM_TYPE = "https://crossengin.io/problems/handler-error";
const HEADER_API_VERSION = "x-api-version";
const HEADER_IDEMPOTENCY_KEY = "idempotency-key";

/**
 * What an uncaught handler throw tells the caller: that it failed and that somebody else can find
 * out why. A constant and not an interpolation, so no future edit can reintroduce a value from the
 * exception by editing one argument.
 *
 * It names the correlation id because that is the caller's handle for a support request — supplied
 * by the caller through `x-correlation-id`, so a caller who sends none has no handle and this
 * sentence is the whole of what they get. That is the intended end state: the diagnosis is the
 * operator's, and a caller who wants to be able to quote one sends the header.
 */
const HANDLER_THREW_CLIENT_DETAIL =
  "the request could not be completed; the failure has been recorded against this request's correlation id";

/**
 * `StageResultSchema.reason` is `z.string().max(500)`, which is what this budget plus the marker
 * below is sized for. The marker stays because it is the string an operator greps for, and it was
 * the *whole* of what the row used to say.
 */
const HANDLER_THREW_REASON_BUDGET = 480;

export class GatewayRuntime {
  private readonly routes: RouteRegistry;
  private readonly handlers: HandlerRegistry;
  private readonly principalResolver: PrincipalResolver;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly rateLimitChecker: RateLimitChecker;
  private readonly jwksProvider: JwksProvider | null;
  private readonly jwtIssuer: string;
  private readonly jwtAudience: string;
  private readonly clockSkewSeconds: number;
  private readonly opaqueTokenLookup: OpaqueTokenLookup | null;
  private readonly clock: { now(): Date };
  private readonly defaultApiVersion: string;
  private readonly idempotencyTtlSeconds: number;
  private readonly redactionRegistry: RedactionRegistry | null;

  constructor(opts: GatewayRuntimeOptions) {
    this.routes = opts.routes;
    this.handlers = opts.handlers;
    this.principalResolver = opts.principalResolver;
    this.idempotencyStore = opts.idempotencyStore;
    this.rateLimitChecker = opts.rateLimitChecker;
    this.jwksProvider = opts.jwksProvider ?? null;
    this.jwtIssuer = opts.jwtIssuer ?? "https://crossengin.io";
    this.jwtAudience = opts.jwtAudience ?? "https://api.crossengin.io";
    this.clockSkewSeconds = opts.clockSkewSeconds ?? 30;
    this.opaqueTokenLookup = opts.opaqueTokenLookup ?? null;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.defaultApiVersion = opts.defaultApiVersion ?? "v1";
    this.idempotencyTtlSeconds = opts.idempotencyTtlSeconds ?? 86_400;
    this.redactionRegistry = opts.redactionRegistry ?? null;
  }

  async handleRequest(request: IncomingRequest): Promise<HandleResult> {
    const startedAt = this.clock.now();
    const recorder = new PipelineRecorder({ requestId: request.id, startedAt });
    const ctx: PipelineState = {
      request,
      tenantId: null,
      principal: null,
      authOutcome: "anonymous",
      routeMatchOutcome: null,
      idempotencyOutcome: null,
      idempotencyRecord: null,
      idempotencyKey: null,
      requestHash: null,
      routeOperationId: null,
      resolvedApiVersion: null,
      rateLimitDecisionId: null,
      parsedBody: null,
      params: {},
      routeMatch: null,
      finalResponse: null,
    };

    const stages: Array<() => Promise<ProblemEnvelope | null>> = [
      () => this.stageReceive(ctx, recorder),
      () => this.stageParseRequest(ctx, recorder),
      () => this.stageValidateTls(ctx, recorder),
      () => this.stageParseAuthCredential(ctx, recorder),
      () => this.stageAuthenticate(ctx, recorder),
      () => this.stageResolvePrincipal(ctx, recorder),
      () => this.stageMatchRoute(ctx, recorder),
      () => this.stageNegotiateVersion(ctx, recorder),
      () => this.stageNegotiateContent(ctx, recorder),
      () => this.stageCheckIdempotency(ctx, recorder),
      () => this.stageCheckRateLimit(ctx, recorder),
      () => this.stageValidateRequestSignature(ctx, recorder),
      () => this.stageValidateRequestSchema(ctx, recorder),
      () => this.stageDispatchHandler(ctx, recorder),
      () => this.stageTransformResponse(ctx, recorder),
      () => this.stageApplySecurityHeaders(ctx, recorder),
      () => this.stageEmitAudit(ctx, recorder),
    ];

    for (const stage of stages) {
      const denial = await stage();
      if (denial !== null) {
        ctx.finalResponse = denial.response;
        break;
      }
    }

    if (ctx.finalResponse === null) {
      ctx.finalResponse = outgoingResponseFromJson({
        status: 500,
        body: serviceUnavailable({ reason: "no_response_assembled" }).body,
      });
    }

    const completedAt = this.clock.now();
    const execution = recorder.build({
      request,
      completedAt,
      finalResponseStatus: ctx.finalResponse.status,
      tenantId: ctx.tenantId,
      authOutcome: ctx.authOutcome,
      routeMatchOutcome: ctx.routeMatchOutcome,
      idempotencyOutcome: ctx.idempotencyOutcome,
      principalId: ctx.principal?.principalId ?? null,
      routeOperationId: ctx.routeOperationId,
      resolvedApiVersion: ctx.resolvedApiVersion,
      rateLimitDecisionId: ctx.rateLimitDecisionId,
      bytesOut: ctx.finalResponse.bodyBytes?.byteLength ?? 0,
    });

    return { response: ctx.finalResponse, execution };
  }

  private now(): Date {
    return this.clock.now();
  }

  private async stageReceive(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    rec.record({
      stage: "receive",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: `received_${ctx.request.method.toLowerCase()}`,
    });
    return null;
  }

  private async stageParseRequest(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    let reason = ctx.request.bodySha256 === null ? "no_body" : "body_hashed";
    const raw = (ctx.request as { rawBody?: Uint8Array | null }).rawBody ?? null;
    const contentType = ctx.request.headers["content-type"] ?? "";
    if (raw !== null && raw.byteLength > 0 && contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          ctx.parsedBody = parsed as Record<string, unknown>;
          reason = "body_parsed_json";
        }
      } catch {
        reason = "body_unparseable_json";
      }
    }
    rec.record({
      stage: "parse_request",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason,
    });
    return null;
  }

  private async stageValidateTls(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    if (ctx.request.tlsVersion === "tls_1_0" || ctx.request.tlsVersion === "tls_1_1") {
      const env = weakTlsRejected({ tlsVersion: ctx.request.tlsVersion, correlationId: ctx.request.correlationId ?? undefined });
      rec.record({
        stage: "validate_tls",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        reason: `weak_tls_${ctx.request.tlsVersion}`,
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    rec.record({
      stage: "validate_tls",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: ctx.request.tlsVersion === null ? "tls_not_reported" : `tls_${ctx.request.tlsVersion}`,
    });
    return null;
  }

  private async stageParseAuthCredential(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    const parsed = parseAuthHeader(ctx.request);
    ctx.parsedAuth = parsed;
    rec.record({
      stage: "parse_auth_credential",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      // Three reasons for three findings, where the first two used to share `no_credential`. The
      // stage still passes for all three: *what* was presented is the parse's answer and *whether
      // it is accepted* is the next stage's, which is the split the pipeline's stage list declares.
      reason:
        parsed.kind === "absent"
          ? "no_credential"
          : parsed.kind === "unrecognized"
            ? "credential_in_unrecognized_scheme"
            : `scheme_${parsed.scheme}`,
    });
    return null;
  }

  /**
   * The challenge a scheme-refusal 401 carries.
   *
   * RFC 9110 §15.5.2 requires at least one challenge on a 401 and
   * `ProblemDetailsResponseSchema.superRefine` refuses a 401 whose `wwwAuthenticate` extension is
   * missing, so one is mandatory and omitting it is not available. What is wrong with the default
   * (`Bearer realm="crossengin", error="invalid_token"`) on *these* arms is the `error` parameter:
   * RFC 6750 §3.1 defines `invalid_token` for a bearer token that was **presented** and rejected,
   * and a request refused for its scheme presented none — so the default asserts a fact about a
   * credential that does not exist. The default stays correct, and stays, on the JWT verification
   * arms, which do reject a presented token.
   *
   * It is a constant rather than a function of `authSchemeServing`, and that is a decision a test of
   * mine refuted first: rendering `Bearer` only when a JWKS is configured leaves a deployment
   * serving only api keys with *nothing* to challenge with, and both ways out are worse — a
   * `CrossEngin-ApiKey` auth-scheme would be a syntactically valid challenge a client cannot
   * satisfy, because this gateway reads api keys from `x-api-key` and would refuse the
   * `Authorization` form (ADR-0334: a remedy that cannot work is worse than none), and the
   * RFC-6750-flavoured default would be back. So the challenge names the one HTTP authentication
   * scheme this binary can serve, and what *this deployment* serves goes in the `detail`, where a
   * credential that is not an HTTP auth scheme can be named at all.
   */
  private authChallenge(): string {
    return 'Bearer realm="crossengin"';
  }

  /**
   * Which of the two served schemes this *deployment* can actually authenticate, read off the
   * runtime's own fields rather than re-derived.
   *
   * It is a getter on the instance so a boot survey and the request path cannot disagree: the
   * alternative — a caller passing the same two booleans it passed to the options — is two
   * derivations of one fact, and ADR-0361's finding is that two readers agreeing is not evidence
   * either is right.
   */
  get authSchemeServing(): AuthSchemeServingInput {
    return {
      jwtVerifierConfigured: this.jwksProvider !== null,
      opaqueLookupConfigured: this.opaqueTokenLookup !== null,
    };
  }

  /**
   * The served schemes as a sentence for a 401's `detail`.
   *
   * It names what this deployment accepts rather than what it refused, because that is the half the
   * caller can act on — and it is the deployment's list and not the binary's, so a request refused
   * because no JWKS is configured is not told to present a JWT.
   */
  private servedSchemeList(): string {
    const served = servedAuthSchemesFor(this.authSchemeServing);
    return served.length === 0 ? "no credential scheme" : served.join(", ");
  }

  private async stageAuthenticate(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    const parsed = ctx.parsedAuth;
    if (parsed === undefined || parsed.kind === "absent") {
      ctx.authOutcome = "anonymous";
      rec.record({
        stage: "authenticate",
        outcome: "pass",
        startedAt,
        completedAt: this.now(),
        reason: "no_credential_skipped",
      });
      return null;
    }
    if (parsed.kind === "unrecognized") {
      // The residual refusal, and the one that closes the live defect: before it, `?api_key=`,
      // a client certificate and any `Authorization` scheme but `Bearer`/`Basic` resolved
      // `scheme: null` and were served **anonymously** — a request carrying
      // `Authorization: CE-HMAC-SHA256 …` traversed all 17 stages and answered 201 on a route
      // declaring no required scope.
      ctx.authOutcome = "credential_unrecognized";
      const env = authenticationRequired({
        reason: `the Authorization header names no scheme this deployment accepts; it serves ${this.servedSchemeList()}`,
        wwwAuthenticate: this.authChallenge(),
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "authenticate",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        // The auth-scheme **token** goes in the recorded reason and never in the response: it is
        // the half an operator needs and the half that is not the credential, which is what
        // `authSchemeToken` establishes by refusing a header that carries no `SP`. It is on the
        // record rather than in the body because the body is read by the client that sent it, and
        // telling a caller which of its own schemes we failed to recognise buys them nothing.
        reason:
          parsed.schemeToken === null
            ? "credential_in_unrecognized_scheme"
            : `credential_in_unrecognized_scheme_${parsed.schemeToken}`,
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    const support = AUTH_SCHEME_SUPPORT[parsed.scheme];
    if (support.treatment !== "served") {
      // Derived from the map rather than from a list of unsupported schemes beside it, which is
      // ADR-0288's maintained-list shape: before this, `basic` alone reached a named refusal — the
      // only unserved scheme the parser happened to emit — and the register recorded that as all
      // five being "honestly named".
      ctx.authOutcome = "scheme_not_supported";
      const env = authenticationRequired({
        reason: `auth scheme ${parsed.scheme} is not accepted here: ${support.reason}`,
        wwwAuthenticate: this.authChallenge(),
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "authenticate",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        reason: `scheme_unsupported_${parsed.scheme}`,
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    if (parsed.scheme === "bearer_jwt") {
      if (this.jwksProvider === null) {
        // `scheme_not_supported` and not `credential_not_found`, which is what this arm recorded:
        // nothing looked the credential up, so "not found" is a claim about a lookup that never
        // happened — ADR-0331's distinction, failing in the direction that blames the caller. From
        // the caller's position this deployment does not accept bearer tokens, and the *reason*
        // carries the operator's remedy, which is a configuration flag and not a different
        // credential.
        ctx.authOutcome = "scheme_not_supported";
        const env = authenticationRequired({
          reason: `auth scheme bearer_jwt is not accepted here: no JWKS provider is configured, so no signature can be verified; this deployment serves ${this.servedSchemeList()}`,
          wwwAuthenticate: this.authChallenge(),
          correlationId: ctx.request.correlationId ?? undefined,
        });
        rec.record({
          stage: "authenticate",
          outcome: "deny",
          startedAt,
          completedAt: this.now(),
          reason: "no_jwks_provider",
          problemTypeUri: env.body.type,
          responseStatus: env.body.status,
        });
        return env;
      }
      const nowSeconds = Math.floor(this.now().getTime() / 1000);
      const verifyResult = await verifyBearerJwt({
        token: parsed.token,
        jwks: this.jwksProvider,
        opts: {
          expectedIssuer: this.jwtIssuer,
          expectedAudience: this.jwtAudience,
          clockSkewSeconds: this.clockSkewSeconds,
          nowSeconds,
        },
      });
      if (verifyResult.outcome !== "authenticated") {
        ctx.authOutcome = verifyResult.outcome;
        const env = authenticationRequired({
          reason: `jwt verification failed: ${verifyResult.outcome}`,
          correlationId: ctx.request.correlationId ?? undefined,
        });
        rec.record({
          stage: "authenticate",
          outcome: "deny",
          startedAt,
          completedAt: this.now(),
          reason: verifyResult.outcome,
          problemTypeUri: env.body.type,
          responseStatus: env.body.status,
        });
        return env;
      }
      ctx.authOutcome = "authenticated";
      ctx.authScheme = "bearer_jwt";
      const jwt = verifyResult.jwt!;
      ctx.authPrincipalRef = jwt.payload.sub ?? "";
      const scope = jwt.payload.scope;
      const scp = jwt.payload.scp;
      ctx.authScopes =
        typeof scope === "string"
          ? scope.split(" ").filter((s: string) => s.length > 0)
          : Array.isArray(scp)
            ? (scp as readonly string[])
            : [];
      if (typeof jwt.payload.tenant_id === "string") {
        ctx.tenantId = jwt.payload.tenant_id;
      }
      rec.record({
        stage: "authenticate",
        outcome: "pass",
        startedAt,
        completedAt: this.now(),
        reason: "jwt_verified",
      });
      return null;
    }
    if (parsed.scheme === "api_key_header") {
      if (this.opaqueTokenLookup === null) {
        // The same correction as the JWKS arm one scheme over, and unreachable from
        // `apps/operate-server`, which passes `wiring.opaqueTokenLookup` unconditionally from a
        // `principals.ts` that always builds one. Corrected rather than deleted because this
        // runtime is a library: `buildOperateGateway` forwards the option only when it is present,
        // so another caller can reach it.
        ctx.authOutcome = "scheme_not_supported";
        const env = authenticationRequired({
          reason: `auth scheme api_key_header is not accepted here: no opaque-token lookup is configured, so no key can be resolved; this deployment serves ${this.servedSchemeList()}`,
          wwwAuthenticate: this.authChallenge(),
          correlationId: ctx.request.correlationId ?? undefined,
        });
        rec.record({
          stage: "authenticate",
          outcome: "deny",
          startedAt,
          completedAt: this.now(),
          reason: "no_opaque_lookup",
          problemTypeUri: env.body.type,
          responseStatus: env.body.status,
        });
        return env;
      }
      const lookup = await this.opaqueTokenLookup.lookup(ctx.request, parsed.token);
      if (lookup === null) {
        ctx.authOutcome = "credential_not_found";
        // Same `error`-parameter correction as the scheme refusals, found in this increment's own
        // post-fix measurement rather than reasoned: this arm rejects an **api key**, not a bearer
        // token, so the default challenge's RFC 6750 `error="invalid_token"` was asserting a fact
        // about a credential family the request did not use. The JWT verification arm above keeps
        // the default, where it is exactly what RFC 6750 §3.1 defines it for.
        const env = authenticationRequired({
          reason: "api key not recognized",
          wwwAuthenticate: this.authChallenge(),
          correlationId: ctx.request.correlationId ?? undefined,
        });
        rec.record({
          stage: "authenticate",
          outcome: "deny",
          startedAt,
          completedAt: this.now(),
          reason: "api_key_not_found",
          problemTypeUri: env.body.type,
          responseStatus: env.body.status,
        });
        return env;
      }
      ctx.authOutcome = "authenticated";
      ctx.authScheme = "api_key_header";
      ctx.authPrincipalRef = lookup.principalRef;
      ctx.authScopes = lookup.scopes;
      ctx.tenantId = lookup.tenantId;
      rec.record({
        stage: "authenticate",
        outcome: "pass",
        startedAt,
        completedAt: this.now(),
        reason: "api_key_recognized",
      });
      return null;
    }
    // Unreachable while `SERVED_AUTH_SCHEMES` is exactly the two schemes with an arm above, which is
    // what `runtime-auth-schemes.test.ts`'s "the stage and the support map agree" asserts in both
    // directions — the fence the type system cannot give, because `support.treatment === "served"`
    // does not narrow `parsed.scheme`. A third served scheme declared in `AUTH_SCHEME_SUPPORT` and
    // not implemented here lands on this line and **fails closed**, which is the only safe
    // disposition: the alternative, falling through to the served path, would authenticate a scheme
    // nothing verified.
    ctx.authOutcome = "scheme_not_supported";
    const env = authenticationRequired({
      reason: `auth scheme ${parsed.scheme} is declared served and has no authenticator in this gateway; this deployment serves ${this.servedSchemeList()}`,
      wwwAuthenticate: this.authChallenge(),
      correlationId: ctx.request.correlationId ?? undefined,
    });
    rec.record({
      stage: "authenticate",
      outcome: "deny",
      startedAt,
      completedAt: this.now(),
      reason: `scheme_declared_served_without_authenticator_${parsed.scheme}`,
      problemTypeUri: env.body.type,
      responseStatus: env.body.status,
    });
    return env;
  }

  private async stageResolvePrincipal(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    if (ctx.authOutcome !== "authenticated" || ctx.authPrincipalRef === undefined) {
      rec.record({
        stage: "resolve_principal",
        outcome: "pass",
        startedAt,
        completedAt: this.now(),
        reason: "no_credential_to_resolve",
      });
      return null;
    }
    const result = await resolvePrincipalForCredential({
      request: ctx.request,
      scheme: ctx.authScheme as never,
      principalRef: ctx.authPrincipalRef,
      scopes: ctx.authScopes ?? [],
      resolver: this.principalResolver,
      nowIso: this.now().toISOString(),
      authenticatedTenantId: ctx.tenantId,
    });
    if (result.outcome !== "authenticated" || result.principal === null) {
      ctx.authOutcome = result.outcome;
      const env = authenticationRequired({
        reason: result.outcome,
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "resolve_principal",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        reason: result.outcome,
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    ctx.principal = result.principal;
    ctx.tenantId = result.principal.tenantId;
    rec.record({
      stage: "resolve_principal",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: "principal_resolved",
    });
    return null;
  }

  private async stageMatchRoute(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    const headerVersion = ctx.request.headers[HEADER_API_VERSION];
    const apiVersion = typeof headerVersion === "string" && /^v\d+$/.test(headerVersion) ? headerVersion : this.defaultApiVersion;
    const match = this.routes.lookup({ method: ctx.request.method, path: ctx.request.path, apiVersion });
    if (match === null) {
      const versions = this.routes.listVersionsFor(ctx.request.method, ctx.request.path);
      if (versions.length > 0) {
        ctx.routeMatchOutcome = "version_not_supported";
        const env = notFound({
          reason: `version ${apiVersion} not supported for ${ctx.request.method} ${ctx.request.path}; available: ${versions.join(", ")}`,
          correlationId: ctx.request.correlationId ?? undefined,
        });
        rec.record({
          stage: "match_route",
          outcome: "deny",
          startedAt,
          completedAt: this.now(),
          reason: "version_not_supported",
          problemTypeUri: env.body.type,
          responseStatus: env.body.status,
        });
        return env;
      }
      ctx.routeMatchOutcome = "no_route";
      const env = notFound({
        reason: `no route for ${ctx.request.method} ${ctx.request.path}`,
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "match_route",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        reason: "no_route",
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    ctx.routeMatch = match;
    ctx.routeOperationId = match.route.operationId;
    ctx.resolvedApiVersion = apiVersion;
    ctx.params = match.params;
    ctx.routeMatchOutcome = "matched";
    rec.record({
      stage: "match_route",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: `matched_${match.route.operationId}`,
    });
    return null;
  }

  private async stageNegotiateVersion(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    rec.record({
      stage: "negotiate_version",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: `version_${ctx.resolvedApiVersion ?? "default"}`,
    });
    return null;
  }

  private async stageNegotiateContent(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    if (ctx.request.method === "OPTIONS") {
      ctx.finalResponse = {
        status: 204,
        headers: {
          "access-control-allow-methods": ctx.routeMatch?.route.method ?? "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, idempotency-key, x-api-version",
          "content-length": "0",
        },
        bodyBytes: null,
      };
      rec.record({
        stage: "negotiate_content",
        outcome: "short_circuit_replay",
        startedAt,
        completedAt: this.now(),
        reason: "cors_preflight",
        responseStatus: 204,
      });
      return { response: ctx.finalResponse, body: serviceUnavailable({ reason: "unused" }).body };
    }
    rec.record({
      stage: "negotiate_content",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: "content_ok",
    });
    return null;
  }

  private async stageCheckIdempotency(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    const route = ctx.routeMatch?.route ?? null;
    const headerKey = ctx.request.headers[HEADER_IDEMPOTENCY_KEY];
    ctx.idempotencyKey = typeof headerKey === "string" ? headerKey : null;
    if (route === null || ctx.tenantId === null) {
      ctx.idempotencyOutcome = "no_key_required";
      rec.record({
        stage: "check_idempotency",
        outcome: "pass",
        startedAt,
        completedAt: this.now(),
        reason: "no_route_or_tenant",
      });
      return null;
    }
    const existing =
      ctx.idempotencyKey !== null
        ? await this.idempotencyStore.get({ tenantId: ctx.tenantId, key: ctx.idempotencyKey })
        : null;
    const requestHashInput = computeRequestHashInputs({
      method: ctx.request.method,
      path: ctx.request.path,
      principalId: ctx.principal?.principalId ?? null,
      bodySha256: ctx.request.bodySha256,
    });
    ctx.requestHash = sha256(requestHashInput);
    const decision = evaluateIdempotency({
      key: ctx.idempotencyKey,
      method: ctx.request.method,
      operationIdempotencyRequired: route.idempotencyRequired,
      existing,
      currentRequestHashSha256: ctx.requestHash,
      now: this.now(),
    });
    ctx.idempotencyOutcome = decision.outcome;
    if (decision.outcome === "no_key_provided") {
      const env = authenticationRequired({
        reason: "operation requires Idempotency-Key header",
        wwwAuthenticate: 'Idempotency-Key required',
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "check_idempotency",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        reason: "no_idempotency_key",
        problemTypeUri: env.body.type,
        responseStatus: 400,
      });
      const overridden: OutgoingResponse = { ...env.response, status: 400 };
      ctx.finalResponse = overridden;
      return { response: overridden, body: env.body };
    }
    if (decision.outcome === "replay_hit_mismatch") {
      const env = idempotencyMismatch({
        reason: "same Idempotency-Key used with a different request body",
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "check_idempotency",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        reason: "replay_hit_mismatch",
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    if (decision.outcome === "replay_hit_match" && decision.replayedRecord !== null) {
      ctx.idempotencyRecord = decision.replayedRecord;
      const status = decision.replayedRecord.responseStatus ?? 200;
      const replayResponse: OutgoingResponse = {
        status,
        headers: {
          "x-idempotent-replay": "true",
          "content-length": "0",
        },
        bodyBytes: null,
      };
      rec.record({
        stage: "check_idempotency",
        outcome: "short_circuit_replay",
        startedAt,
        completedAt: this.now(),
        reason: "served_from_idempotency_cache",
        responseStatus: status,
      });
      ctx.finalResponse = replayResponse;
      return { response: replayResponse, body: serviceUnavailable({ reason: "unused" }).body };
    }
    rec.record({
      stage: "check_idempotency",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: decision.outcome,
    });
    return null;
  }

  private async stageCheckRateLimit(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    const decision = await this.rateLimitChecker.check({
      tenantId: ctx.tenantId,
      principalId: ctx.principal?.principalId ?? null,
      route: ctx.routeMatch?.route ?? null,
      request: ctx.request,
      now: this.now(),
    });
    ctx.rateLimitDecisionId = decision.decisionId;
    if (!decision.allowed) {
      const env = tooManyRequests({
        retryAfterSeconds: decision.retryAfterSeconds,
        reason: decision.reason,
        quotaExceeded: decision.quotaExceeded,
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "check_rate_limit",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        reason: decision.reason,
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    rec.record({
      stage: "check_rate_limit",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: `within_limit_${decision.remaining.toString()}`,
      appliedHeaders: {
        "ratelimit-limit": decision.limit.toString(),
        "ratelimit-remaining": decision.remaining.toString(),
        "ratelimit-reset": decision.resetAt,
      },
    });
    return null;
  }

  private async stageValidateRequestSignature(_ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    rec.record({
      stage: "validate_request_signature",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: "no_request_signature_required",
    });
    return null;
  }

  private async stageValidateRequestSchema(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    rec.record({
      stage: "validate_request_schema",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: ctx.request.bodySha256 === null ? "no_body" : "body_present",
    });
    return null;
  }

  private async stageDispatchHandler(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    const route = ctx.routeMatch?.route ?? null;
    if (route === null) {
      const env = serviceUnavailable({ reason: "no_route_dispatch_called_without_match", correlationId: ctx.request.correlationId ?? undefined });
      rec.record({
        stage: "dispatch_handler",
        outcome: "error",
        startedAt,
        completedAt: this.now(),
        reason: "no_route",
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    if (route.requiredScopes.length > 0 && ctx.principal === null) {
      const env = authenticationRequired({
        reason: "authentication required to access this route",
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "dispatch_handler",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        reason: "no_principal_required_scopes",
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    const insufficient = route.requiredScopes.filter(
      (s) => !(ctx.principal?.grantedScopes ?? []).includes(s),
    );
    if (insufficient.length > 0) {
      const env = forbidden({
        reason: `missing required scope: ${insufficient[0]!}`,
        requiredScope: insufficient[0],
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "dispatch_handler",
        outcome: "deny",
        startedAt,
        completedAt: this.now(),
        reason: "insufficient_scope",
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    const handler = this.handlers.resolve(route.operationId);
    if (handler === null) {
      const env = serviceUnavailable({
        reason: `no handler registered for ${route.operationId}`,
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "dispatch_handler",
        outcome: "error",
        startedAt,
        completedAt: this.now(),
        reason: "no_handler",
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    let output: HandlerOutput;
    try {
      output = await handler({
        request: ctx.request,
        route,
        principal: ctx.principal,
        params: ctx.params,
        parsedBody: ctx.parsedBody,
      });
    } catch (err) {
      // The two destinations are the opposite way round from how this read until ADR-0359, and that
      // single move is both the disclosure fix and what makes the status change safe. The exception
      // message went to the response body, where it is the RFC 9457 `detail`; measured on the
      // at-rest-encryption paths at 190, 391 and 438 characters, all under the slice, so each
      // reached an anonymous caller in full carrying entity names and tenant UUIDs. Meanwhile the
      // recorded reason was the bare constant `handler_threw`, so the row an operator reads — what
      // `--gateway-execution-capture` persists and `GatewayReplayer` reads — said nothing at all
      // about why. The diagnosis belongs to the operator and the fact of failure to the caller.
      //
      // 500 and not 504: an uncaught throw is by definition unclassified, and 500 is the one status
      // claiming neither "retry this" nor "your request was wrong", where 504 invites the retry a
      // permanent fault cannot survive. Deliberately *not* a permanent/transient map keyed on error
      // classes: no error thrown through here declares a disposition, and recognising one by name
      // would mean the gateway importing the pg or crypto packages. Such a map can only be built
      // from the other end — by the throwers declaring what they are — so do not attempt it here.
      const env = internalServerError({
        reason: HANDLER_THREW_CLIENT_DETAIL,
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "dispatch_handler",
        outcome: "error",
        startedAt,
        completedAt: this.now(),
        reason:
          err instanceof Error
            ? `handler_threw: ${err.message.slice(0, HANDLER_THREW_REASON_BUDGET)}`
            : "handler_threw_unknown",
        problemTypeUri: env.body.type,
        responseStatus: env.body.status,
      });
      return env;
    }
    ctx.finalResponse = handlerOutputToResponse(output);
    if (ctx.idempotencyKey !== null && ctx.tenantId !== null) {
      await this.persistIdempotency(ctx, output.status);
    }
    // A handler that returns a 4xx/5xx is a terminal outcome, not a "pass":
    // record it as deny (4xx) / error (5xx) and halt the pipeline so the
    // PipelineExecution's "pass cannot be 4xx" invariant holds. The handler's
    // own response body is preserved (returned via the envelope's response).
    if (output.status >= 400) {
      const isServerError = output.status >= 500;
      rec.record({
        stage: "dispatch_handler",
        outcome: isServerError ? "error" : "deny",
        startedAt,
        completedAt: this.now(),
        reason: `handler_returned_${output.status.toString()}`,
        ...(isServerError ? {} : { problemTypeUri: HANDLER_ERROR_PROBLEM_TYPE }),
        responseStatus: output.status,
      });
      return {
        response: ctx.finalResponse,
        body: {
          type: HANDLER_ERROR_PROBLEM_TYPE,
          title: "Handler error",
          status: output.status as ProblemEnvelope["body"]["status"],
          detail: `handler returned status ${output.status.toString()}`,
          extensions: {},
        },
      };
    }
    rec.record({
      stage: "dispatch_handler",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: `handler_returned_${output.status.toString()}`,
    });
    return null;
  }

  private async persistIdempotency(ctx: PipelineState, status: number): Promise<void> {
    if (ctx.idempotencyKey === null || ctx.tenantId === null || ctx.requestHash === null) return;
    const route = ctx.routeMatch?.route ?? null;
    if (route === null) return;
    const method = ctx.request.method;
    if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") {
      return;
    }
    const bodyBytes = ctx.finalResponse?.bodyBytes ?? null;
    const responseSha256 = bodyBytes !== null && bodyBytes.byteLength > 0 ? sha256(bodyBytes) : null;
    const succeeded = status >= 200 && status < 400;
    const nowIso = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.idempotencyTtlSeconds * 1000).toISOString();
    const record: IdempotencyRecord = {
      id: `idem_${sha256(ctx.idempotencyKey + ctx.tenantId).slice(0, 32)}`,
      tenantId: ctx.tenantId,
      operationId: route.operationId,
      method,
      idempotencyKey: ctx.idempotencyKey,
      requestHashSha256: ctx.requestHash,
      principalId: ctx.principal?.principalId ?? null,
      receivedAt: ctx.request.receivedAt,
      expiresAt,
      status: succeeded ? "completed_success" : "completed_error",
      responseStatus: status,
      responseSha256,
      responseStorageUri: null,
      completedAt: nowIso,
      errorCode: succeeded ? null : `http_${status.toString()}`,
      errorMessage: succeeded ? null : `dispatch returned status ${status.toString()}`,
    };
    await this.idempotencyStore.put({ tenantId: ctx.tenantId, record });
  }

  private async stageTransformResponse(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    const redactedCount = this.applyResponseRedaction(ctx);
    rec.record({
      stage: "transform_response",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason:
        redactedCount > 0
          ? `redacted_${redactedCount.toString()}_fields`
          : `status_${ctx.finalResponse?.status.toString() ?? "unknown"}`,
    });
    return null;
  }

  /**
   * Two passes, keyed on the deferral (ADR-0342's field-`read` closure).
   *
   * The first pass asks with **no record** — today's single evaluation. If nothing deferred, the
   * old whole-tree walk applies and the stage is byte-identical and costs exactly what it did,
   * which is every deployment that has declared no record-bearing field policy. Only when a field
   * answered `deferred` does the response carry an obligation a record could change, and only then
   * is the set recomputed per record.
   *
   * The direction matters and is what makes every fallback safe: a per-record pass can only
   * **relax** the record-free one (a `deferred` becoming `satisfied`), never tighten it. So any
   * position where a record cannot be found gets the record-free set, which is the stricter one.
   *
   * The per-record pass is **one** evaluation for the whole response, not one per record: the
   * records are enumerated from the same traversal that will rebuild the body, and their field sets
   * are computed in a single `computeResponseRedactionForRecords` call. The fast path is untouched
   * by that — no deferral still means one record-free evaluation and today's whole-tree walk, which
   * is every deployment that has declared no record-bearing field policy.
   */
  private applyResponseRedaction(ctx: PipelineState): number {
    if (this.redactionRegistry === null) return 0;
    const route = ctx.routeMatch?.route ?? null;
    const resp = ctx.finalResponse;
    if (route === null || resp === null || resp.bodyBytes === null) return 0;
    const contentType = resp.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) return 0;
    const spec = this.redactionRegistry.specFor(route.operationId);
    if (spec === null) return 0;
    const base = computeResponseRedaction(spec, ctx.principal);
    // Still safe as the first gate: without a record every record-bearing obligation answers
    // `deferred`, which redacts — so `redacted` empty implies `deferred` empty, and the fast path
    // cannot skip an obligation a record would have changed.
    if (base.redacted.length === 0) return 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(resp.bodyBytes));
    } catch {
      return 0;
    }
    const baseSet = new Set(base.redacted);
    let scrubbed: unknown;
    if (base.deferred.length === 0) {
      scrubbed = redactJsonValue(parsed, baseSet);
    } else {
      // Enumerated from the traversal that is about to rebuild the body, so the two cannot disagree
      // about which objects are records — which is what lets the sets be keyed by object identity
      // below rather than by a position both walks would have to agree on independently.
      const records = recordsIn(spec.recordShape, parsed);
      const perRecord = computeResponseRedactionForRecords(spec, ctx.principal, records);
      const byRecord = new Map<Readonly<Record<string, unknown>>, ReadonlySet<string>>();
      records.forEach((record, index) => {
        const result = perRecord[index];
        if (result !== undefined) byRecord.set(record, new Set(result.redacted));
      });
      scrubbed = redactRecords(spec.recordShape, parsed, (record) =>
        // Fail-closed, both arms. `null` is a position with no record, and a lookup miss degrades to
        // the same answer: the per-record pass can only ever *relax* the record-free set, so the
        // fallback is the **stricter** of the two rather than a throw. The miss is unreachable while
        // enumeration and rebuild share one definition — it is here so that a fourth response shape
        // added later, or an enumeration that stops reaching one of the rebuild's positions, cannot
        // fail open.
        record === null ? baseSet : (byRecord.get(record) ?? baseSet),
      );
    }
    ctx.finalResponse = outgoingResponseFromJson({
      status: resp.status,
      headers: resp.headers,
      body: scrubbed,
    });
    // The **record-free** count, on both paths. It is the one figure that describes the response as
    // a whole: on the per-record path the counts differ per row, so a sum would scale with the page
    // size and a max or min would name a figure true of one row and of no other. The record-free
    // count is also the honest reading of the stage's claim — "this many classified fields were
    // withheld from this principal before any record was consulted" — and reporting it keeps the
    // reason comparable across the two paths rather than making it depend on how many rows came
    // back.
    return base.redacted.length;
  }

  private async stageApplySecurityHeaders(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    if (ctx.finalResponse !== null) {
      const merged = { ...ctx.finalResponse.headers };
      merged["strict-transport-security"] = merged["strict-transport-security"] ?? DEFAULT_SECURITY_HEADERS.strict_transport_security;
      merged["content-security-policy"] = merged["content-security-policy"] ?? DEFAULT_SECURITY_HEADERS.content_security_policy;
      merged["x-content-type-options"] = merged["x-content-type-options"] ?? DEFAULT_SECURITY_HEADERS.x_content_type_options;
      merged["x-frame-options"] = merged["x-frame-options"] ?? DEFAULT_SECURITY_HEADERS.x_frame_options;
      merged["referrer-policy"] = merged["referrer-policy"] ?? DEFAULT_SECURITY_HEADERS.referrer_policy;
      merged["permissions-policy"] = merged["permissions-policy"] ?? DEFAULT_SECURITY_HEADERS.permissions_policy;
      ctx.finalResponse = { ...ctx.finalResponse, headers: merged };
    }
    rec.record({
      stage: "apply_security_headers",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: "default_security_headers_applied",
    });
    return null;
  }

  private async stageEmitAudit(_ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    rec.record({
      stage: "emit_audit",
      outcome: "pass",
      startedAt,
      completedAt: this.now(),
      reason: "audit_emitted",
    });
    return null;
  }
}

interface PipelineState {
  readonly request: IncomingRequest;
  tenantId: string | null;
  principal: ResolvedPrincipal | null;
  authOutcome: AuthOutcome;
  authScheme?: string;
  authPrincipalRef?: string;
  authScopes?: readonly string[];
  parsedAuth?: ReturnType<typeof parseAuthHeader>;
  routeMatchOutcome: RouteMatchOutcome | null;
  idempotencyOutcome: IdempotencyOutcome | null;
  idempotencyRecord: IdempotencyRecord | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  routeOperationId: string | null;
  resolvedApiVersion: string | null;
  rateLimitDecisionId: string | null;
  parsedBody: Record<string, unknown> | null;
  params: Readonly<Record<string, string>>;
  routeMatch: { readonly route: import("@crossengin/api-gateway").RouteDefinition; readonly params: Readonly<Record<string, string>> } | null;
  finalResponse: OutgoingResponse | null;
}
