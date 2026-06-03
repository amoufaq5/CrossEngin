import {
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
  computeRedactedFields,
  redactJsonValue,
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
  gatewayTimeout,
  idempotencyMismatch,
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
      reason: parsed.scheme === null ? "no_credential" : `scheme_${parsed.scheme}`,
    });
    return null;
  }

  private async stageAuthenticate(ctx: PipelineState, rec: PipelineRecorder): Promise<ProblemEnvelope | null> {
    const startedAt = this.now();
    const parsed = ctx.parsedAuth;
    if (parsed === undefined || parsed.scheme === null || parsed.token === null) {
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
    if (parsed.scheme === "bearer_jwt") {
      if (this.jwksProvider === null) {
        ctx.authOutcome = "credential_not_found";
        const env = authenticationRequired({ reason: "no JWKS provider configured", correlationId: ctx.request.correlationId ?? undefined });
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
        ctx.authOutcome = "credential_not_found";
        const env = authenticationRequired({ reason: "no opaque token lookup configured", correlationId: ctx.request.correlationId ?? undefined });
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
        const env = authenticationRequired({ reason: "api key not recognized", correlationId: ctx.request.correlationId ?? undefined });
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
    ctx.authOutcome = "credential_malformed";
    const env = authenticationRequired({
      reason: `unsupported auth scheme ${parsed.scheme}`,
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
      const env = gatewayTimeout({
        reason: err instanceof Error ? err.message.slice(0, 480) : "handler_threw_unknown",
        correlationId: ctx.request.correlationId ?? undefined,
      });
      rec.record({
        stage: "dispatch_handler",
        outcome: "error",
        startedAt,
        completedAt: this.now(),
        reason: "handler_threw",
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

  private applyResponseRedaction(ctx: PipelineState): number {
    if (this.redactionRegistry === null) return 0;
    const route = ctx.routeMatch?.route ?? null;
    const resp = ctx.finalResponse;
    if (route === null || resp === null || resp.bodyBytes === null) return 0;
    const contentType = resp.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) return 0;
    const spec = this.redactionRegistry.specFor(route.operationId);
    if (spec === null) return 0;
    const redacted = computeRedactedFields(spec, ctx.principal);
    if (redacted.length === 0) return 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(resp.bodyBytes));
    } catch {
      return 0;
    }
    const scrubbed = redactJsonValue(parsed, new Set(redacted));
    ctx.finalResponse = outgoingResponseFromJson({
      status: resp.status,
      headers: resp.headers,
      body: scrubbed,
    });
    return redacted.length;
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
