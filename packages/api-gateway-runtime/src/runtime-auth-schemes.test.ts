import {
  AUTH_OUTCOMES,
  AUTH_SCHEME_SUPPORT,
  AUTH_SCHEMES,
  RECOGNISABLE_AUTH_SCHEMES,
  SERVED_AUTH_SCHEMES,
  PipelineExecutionSchema,
  type AuthScheme,
  type IncomingRequest,
  type PipelineExecution,
  type RouteDefinition,
} from "@crossengin/api-gateway";
import {
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
  signEd25519,
} from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { API_KEY_QUERY_PARAM } from "./auth.js";
import { InMemoryJwksProvider } from "./auth.js";
import { HandlerRegistry } from "./dispatcher.js";
import { GatewayRuntime, type OpaqueTokenLookup } from "./runtime.js";
import {
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
} from "./stores.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";
const ISSUER = "https://issuer.example";
const AUDIENCE = "https://api.crossengin.io";
const NOW = "2026-05-16T12:00:00.000Z";

/**
 * A route declaring **no required scope**, which is what makes the pre-ADR-0384 behaviour a served
 * request rather than a 401 from somewhere else: every route the manifest compiler derives declares
 * `requiredScopes: []`, so the gateway's scope gate never fires and an unauthenticated request is
 * refused by RBAC inside the handler — or, when the handler self-authorizes, not at all.
 */
function openRoute(): RouteDefinition {
  return {
    id: "rt_route0001",
    operationId: "tenants.create",
    method: "POST",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "tenants" },
    ],
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

function request(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return {
    id: "req_test00000001",
    receivedAt: NOW,
    method: "POST",
    path: "/v1/tenants",
    query: {},
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: 0,
    bodySha256: null,
    clientIp: "203.0.113.1",
    forwardedFor: [],
    forwardedProto: null,
    forwardedHost: null,
    userAgent: null,
    tlsVersion: null,
    tlsCipher: null,
    clientCertSha256: null,
    correlationId: null,
    traceparent: null,
    tenantHint: null,
    edgeRegion: null,
    ...overrides,
  };
}

const ALWAYS_UNKNOWN: OpaqueTokenLookup = { async lookup() { return null; } };

function buildRuntime(
  opts: {
    readonly jwks?: InMemoryJwksProvider;
    readonly opaque?: OpaqueTokenLookup;
  } = {},
): GatewayRuntime {
  return new GatewayRuntime({
    routes: new InMemoryRouteRegistry().register(openRoute()),
    handlers: new HandlerRegistry().register("tenants.create", () => ({
      kind: "json",
      status: 201,
      body: { ok: true },
    })),
    principalResolver: new InMemoryPrincipalResolver().register(USER, {
      principalId: USER,
      tenantId: TENANT,
      principalKind: "user",
      authScheme: "bearer_jwt",
      grantedScopes: [],
      mfaProofAgeSeconds: null,
      resolvedAt: NOW,
    }),
    idempotencyStore: new InMemoryIdempotencyStore(),
    rateLimitChecker: new InMemoryRateLimitChecker({ limit: 1000 }),
    jwtIssuer: ISSUER,
    jwtAudience: AUDIENCE,
    clock: { now: () => new Date(NOW) },
    ...(opts.jwks !== undefined ? { jwksProvider: opts.jwks } : {}),
    ...(opts.opaque !== undefined ? { opaqueTokenLookup: opts.opaque } : {}),
  });
}

function stageReason(execution: PipelineExecution, stage: string): string | undefined {
  return execution.stages.find((s) => s.stage === stage)?.reason;
}

function problemBody(bodyBytes: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bodyBytes ?? new Uint8Array())) as Record<
    string,
    unknown
  >;
}

describe("stageAuthenticate — a refused scheme is named, not served anonymously", () => {
  /**
   * The live defect, in the position the orchestrator measured it. Before this increment the same
   * request answered **201** with `authOutcome: "anonymous"` and the two stage reasons
   * `no_credential` / `no_credential_skipped` — byte-identical to a request that presented nothing.
   */
  it("an unrecognized Authorization scheme is a 401 recorded as credential_unrecognized", async () => {
    const { response, execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { authorization: "CE-HMAC-SHA256 keyId=k1,ts=1,sig=abc" } }),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("credential_unrecognized");
    expect(execution.finalStage).toBe("authenticate");
    expect(execution.finalOutcome).toBe("deny");
    expect(stageReason(execution, "parse_auth_credential")).toBe(
      "credential_in_unrecognized_scheme",
    );
    expect(stageReason(execution, "authenticate")).toBe(
      "credential_in_unrecognized_scheme_CE-HMAC-SHA256",
    );
  });

  /**
   * The auth-scheme token reaches the **record** and never the response. It is the half an
   * operator needs (*a client is sending `CE-HMAC-SHA256`*) and the half that is not the
   * credential; the body omits it because the client that sent it learns nothing from being told
   * which of its own schemes we failed to recognise.
   */
  it("the scheme token is recorded and absent from the body", async () => {
    const { response, execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { authorization: "Negotiate YIIZ" } }),
    );
    expect(stageReason(execution, "authenticate")).toBe(
      "credential_in_unrecognized_scheme_Negotiate",
    );
    expect(new TextDecoder().decode(response.bodyBytes ?? new Uint8Array())).not.toContain(
      "Negotiate",
    );
  });

  it("a bare token with no auth-scheme records no token at all", async () => {
    const { execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { authorization: "AN-OPAQUE-SECRET" } }),
    );
    expect(stageReason(execution, "authenticate")).toBe("credential_in_unrecognized_scheme");
    expect(JSON.stringify(execution)).not.toContain("AN-OPAQUE-SECRET");
  });

  it("an absent credential is still anonymous and still reaches the handler", async () => {
    const { response, execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request(),
    );
    expect(response.status).toBe(201);
    expect(execution.authOutcome).toBe("anonymous");
    expect(stageReason(execution, "parse_auth_credential")).toBe("no_credential");
    expect(stageReason(execution, "authenticate")).toBe("no_credential_skipped");
  });

  /**
   * The two facts kept apart. `absent` and `unrecognized` differ in the one place an operator
   * reads — the stage reason and the stored outcome — and their remedies differ: nothing to do, and
   * fix the client's header.
   */
  it("absent and unrecognized are distinguishable in the record", async () => {
    const runtime = buildRuntime({ opaque: ALWAYS_UNKNOWN });
    const absent = await runtime.handleRequest(request());
    const unrecognized = await runtime.handleRequest(
      request({ headers: { authorization: "Negotiate YIIZ" } }),
    );
    expect(absent.execution.authOutcome).not.toBe(unrecognized.execution.authOutcome);
    expect(stageReason(absent.execution, "parse_auth_credential")).not.toBe(
      stageReason(unrecognized.execution, "parse_auth_credential"),
    );
  });

  it("basic is refused by name and records scheme_not_supported", async () => {
    const { response, execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { authorization: "Basic dXNlcjpwYXNz" } }),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("scheme_not_supported");
    expect(stageReason(execution, "authenticate")).toBe("scheme_unsupported_basic");
  });

  it("api_key_query is refused by name", async () => {
    const { response, execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ query: { [API_KEY_QUERY_PARAM]: "ce_live_abcdefgh" } }),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("scheme_not_supported");
    expect(stageReason(execution, "authenticate")).toBe("scheme_unsupported_api_key_query");
  });

  it("mtls is refused by name", async () => {
    const { response, execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ clientCertSha256: "a".repeat(64) }),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("scheme_not_supported");
    expect(stageReason(execution, "authenticate")).toBe("scheme_unsupported_mtls");
  });

  /**
   * The refusal lands at stage 5 of 17, which is the other half of closing the defect: the
   * pre-fix request traversed a rate-limit decision and an idempotency read before anything looked
   * at its credential.
   */
  it("the refusal stops the pipeline at the authenticate stage", async () => {
    const { execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { authorization: "Basic dXNlcjpwYXNz" } }),
    );
    expect(execution.stages).toHaveLength(5);
    expect(execution.stages.map((s) => s.stage)).toEqual([
      "receive",
      "parse_request",
      "validate_tls",
      "parse_auth_credential",
      "authenticate",
    ]);
  });

  it("the 401 carries the scheme's declared reason, so the body says why", async () => {
    const { response } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ query: { [API_KEY_QUERY_PARAM]: "ce_live_abcdefgh" } }),
    );
    const body = problemBody(response.bodyBytes);
    expect(String(body["detail"])).toContain(AUTH_SCHEME_SUPPORT.api_key_query.reason);
  });

  /**
   * RFC 9110 §15.5.2 requires a challenge on every 401, and
   * `ProblemDetailsResponseSchema.superRefine` refuses a 401 without the `wwwAuthenticate`
   * extension — so one is mandatory and omitting it is not available. What this pins is the
   * *content*: RFC 6750 §3.1 defines `error="invalid_token"` for a bearer token that was presented
   * and rejected, and a request refused for its scheme presented none.
   */
  it("a scheme refusal challenges without claiming a token was presented", async () => {
    const { response } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { authorization: "Basic abc" } }),
    );
    expect(response.headers["www-authenticate"]).toBe('Bearer realm="crossengin"');
  });

  it("a rejected bearer token keeps the RFC 6750 error parameter, where it is true", async () => {
    const kp = generateEd25519Keypair();
    const { response } = await buildRuntime({
      jwks: new InMemoryJwksProvider({ keys: [{ kid: "k", publicKeyBase64: kp.publicKeyBase64 }] }),
      opaque: ALWAYS_UNKNOWN,
    }).handleRequest(request({ headers: { authorization: "Bearer not-a-jwt" } }));
    expect(response.headers["www-authenticate"]).toContain('error="invalid_token"');
  });

  it("the challenge is present on every scheme refusal, as the contract requires", async () => {
    const runtime = buildRuntime({ opaque: ALWAYS_UNKNOWN });
    for (const req of [
      request({ headers: { authorization: "Basic abc" } }),
      request({ headers: { authorization: "Negotiate YIIZ" } }),
      request({ query: { [API_KEY_QUERY_PARAM]: "k" } }),
      request({ clientCertSha256: "a".repeat(64) }),
      request({ headers: { authorization: "Bearer a.b.c" } }),
      request({ headers: { "x-api-key": "k" } }),
    ]) {
      const { response } = await runtime.handleRequest(req);
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toBeDefined();
      expect(
        (problemBody(response.bodyBytes)["extensions"] as Record<string, unknown>)[
          "wwwAuthenticate"
        ],
      ).toBeDefined();
    }
  });

  it("the 401 detail names the schemes this deployment does serve", async () => {
    const { response } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { authorization: "Negotiate YIIZ" } }),
    );
    expect(String(problemBody(response.bodyBytes)["detail"])).toContain("api_key_header");
  });

  it("the detail never echoes the presented credential", async () => {
    const secret = "CE-HMAC-SHA256 keyId=k1,sig=THE-SECRET-SIGNATURE";
    const { response, execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { authorization: secret } }),
    );
    const rendered = new TextDecoder().decode(response.bodyBytes ?? new Uint8Array());
    expect(rendered).not.toContain("THE-SECRET-SIGNATURE");
    expect(JSON.stringify(execution)).not.toContain("THE-SECRET-SIGNATURE");
  });

  it("an mtls refusal never echoes the certificate digest", async () => {
    const digest = "f".repeat(64);
    const { response, execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ clientCertSha256: digest }),
    );
    expect(new TextDecoder().decode(response.bodyBytes ?? new Uint8Array())).not.toContain(digest);
    expect(JSON.stringify(execution)).not.toContain(digest);
  });
});

describe("stageAuthenticate — the served schemes still work", () => {
  function jwtFor(kp: { privateKeyBase64: string; publicKeyBase64: string }, kid: string): string {
    const enc = (o: unknown): string =>
      Buffer.from(new TextEncoder().encode(JSON.stringify(o)))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const header = enc({ alg: "EdDSA", typ: "JWT", kid });
    const payload = enc({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: USER,
      exp: Math.floor(Date.parse(NOW) / 1000) + 3600,
      tenant_id: TENANT,
    });
    const sig = signEd25519(
      kp.privateKeyBase64,
      kp.publicKeyBase64,
      new TextEncoder().encode(`${header}.${payload}`),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${header}.${payload}.${sig}`;
  }

  it("a valid JWT authenticates", async () => {
    const kp = generateEd25519Keypair();
    const kid = ed25519PublicKeyFingerprint(kp.publicKeyBase64).slice(0, 16);
    const runtime = buildRuntime({
      jwks: new InMemoryJwksProvider({ keys: [{ kid, publicKeyBase64: kp.publicKeyBase64 }] }),
    });
    const { response, execution } = await runtime.handleRequest(
      request({ headers: { authorization: `Bearer ${jwtFor(kp, kid)}` } }),
    );
    expect(response.status).toBe(201);
    expect(execution.authOutcome).toBe("authenticated");
    expect(stageReason(execution, "authenticate")).toBe("jwt_verified");
  });

  it("a recognised api key authenticates", async () => {
    const runtime = buildRuntime({
      opaque: {
        async lookup() {
          return { principalRef: USER, scopes: [], tenantId: TENANT };
        },
      },
    });
    const { response, execution } = await runtime.handleRequest(
      request({ headers: { "x-api-key": "ce_live_abcdefgh" } }),
    );
    expect(response.status).toBe(201);
    expect(execution.authOutcome).toBe("authenticated");
    expect(stageReason(execution, "authenticate")).toBe("api_key_recognized");
  });

  it("an unknown api key is credential_not_found, because the lookup did happen", async () => {
    const { execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { "x-api-key": "ce_live_nope" } }),
    );
    expect(execution.authOutcome).toBe("credential_not_found");
    expect(stageReason(execution, "authenticate")).toBe("api_key_not_found");
  });

  /**
   * ADR-0331's distinction, which is why these two arms moved off `credential_not_found`: an
   * unconfigured verifier looked nothing up, so "not found" was a claim about a lookup that never
   * happened. The remedy is the operator's and lives in the reason.
   */
  it("an unconfigured JWKS is scheme_not_supported, not credential_not_found", async () => {
    const { response, execution } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { authorization: "Bearer a.b.c" } }),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("scheme_not_supported");
    expect(stageReason(execution, "authenticate")).toBe("no_jwks_provider");
    expect(String(problemBody(response.bodyBytes)["detail"])).toContain("no JWKS provider");
  });

  it("an unconfigured opaque lookup is scheme_not_supported", async () => {
    const { execution } = await buildRuntime().handleRequest(
      request({ headers: { "x-api-key": "k" } }),
    );
    expect(execution.authOutcome).toBe("scheme_not_supported");
    expect(stageReason(execution, "authenticate")).toBe("no_opaque_lookup");
  });

  it("a malformed JWT is still credential_malformed, which is the caller's fault", async () => {
    const kp = generateEd25519Keypair();
    const { execution } = await buildRuntime({
      jwks: new InMemoryJwksProvider({ keys: [{ kid: "k", publicKeyBase64: kp.publicKeyBase64 }] }),
      opaque: ALWAYS_UNKNOWN,
    }).handleRequest(request({ headers: { authorization: "Bearer not-a-jwt" } }));
    expect(execution.authOutcome).toBe("credential_malformed");
  });
});

describe("the stage and the support map agree", () => {
  /**
   * A **literal pin**, and deliberately nothing more: it reads the map and not `stageAuthenticate`,
   * so it catches the set changing and cannot catch the set *disagreeing with the stage*. Its
   * previous title claimed the second ("…is exactly the schemes stageAuthenticate implements") with
   * a doc comment claiming "both directions", which is ADR-0351's documented-the-hazard-checked-
   * nothing shape — the hazard is real and the fence for it is the behavioural test below, which
   * drives every recognisable scheme through the real 17 stages.
   */
  it("pins SERVED_AUTH_SCHEMES by literal, so the set cannot change unnoticed", () => {
    expect([...SERVED_AUTH_SCHEMES].sort()).toEqual(["api_key_header", "bearer_jwt"]);
  });

  it("every recognisable scheme either authenticates or is refused by the stage", async () => {
    const samples: ReadonlyArray<readonly [AuthScheme, IncomingRequest]> = [
      ["bearer_jwt", request({ headers: { authorization: "Bearer a.b.c" } })],
      ["basic", request({ headers: { authorization: "Basic abc" } })],
      ["api_key_header", request({ headers: { "x-api-key": "k" } })],
      ["api_key_query", request({ query: { [API_KEY_QUERY_PARAM]: "k" } })],
      ["mtls", request({ clientCertSha256: "a".repeat(64) })],
    ];
    expect(samples.map(([s]) => s).sort()).toEqual([...RECOGNISABLE_AUTH_SCHEMES].sort());
    // Both served schemes must be **configured** here, or the fence below is unsound in the
    // direction that hides the thing it checks. An unconfigured verifier deliberately folds into
    // `scheme_not_supported` (ADR-0384's third-candidate decision: `credential_not_found` would be
    // a claim about a lookup that never happened — ADR-0331), so with no JWKS a served `bearer_jwt`
    // answers exactly the outcome a *declared-served-with-no-arm* scheme answers, and the two
    // failures become indistinguishable. Measured: without the provider this test fails
    // `bearer_jwt: expected 'scheme_not_supported' not to be 'scheme_not_supported'`.
    // An empty key set is enough and is the honest minimum: it makes the verifier *configured*
    // without making the sample token verify, so the refusal still comes from the credential —
    // which is the property under test — rather than from the scheme.
    const runtime = buildRuntime({
      opaque: ALWAYS_UNKNOWN,
      jwks: new InMemoryJwksProvider({ keys: [] }),
    });
    for (const [scheme, req] of samples) {
      const { response, execution } = await runtime.handleRequest(req);
      if (AUTH_SCHEME_SUPPORT[scheme].treatment === "refused") {
        expect(execution.authOutcome, scheme).toBe("scheme_not_supported");
        expect(response.status, scheme).toBe(401);
      } else {
        // Served, so the refusal must come from the credential or the configuration — never from
        // the scheme itself. **Both** exclusions are the fence, and the second is the one that
        // makes this test do the job the literal pin above only claimed to: `scheme_not_supported`
        // is precisely what the terminal fail-closed line answers for a scheme declared `served`
        // with no arm in `stageAuthenticate`, so asserting `not.toBe("credential_unrecognized")`
        // alone was *satisfied* by that failure and such a scheme passed. This is the direction the
        // type system cannot give, because `support.treatment === "served"` does not narrow
        // `parsed.scheme` to a union of two literals.
        expect(execution.authOutcome, scheme).not.toBe("credential_unrecognized");
        expect(execution.authOutcome, scheme).not.toBe("scheme_not_supported");
      }
    }
  });

  it("authSchemeServing reads the runtime's own configuration", () => {
    const kp = generateEd25519Keypair();
    expect(buildRuntime().authSchemeServing).toEqual({
      jwtVerifierConfigured: false,
      opaqueLookupConfigured: false,
    });
    expect(
      buildRuntime({
        jwks: new InMemoryJwksProvider({
          keys: [{ kid: "k", publicKeyBase64: kp.publicKeyBase64 }],
        }),
        opaque: ALWAYS_UNKNOWN,
      }).authSchemeServing,
    ).toEqual({ jwtVerifierConfigured: true, opaqueLookupConfigured: true });
  });

  /**
   * Every outcome the stage can store must be a declared member, which the catalogued
   * `auth_outcome` CHECK and `PipelineExecutionSchema`'s `z.enum(AUTH_OUTCOMES)` both require. The
   * execution is parsed rather than inspected, so a row this gateway could not persist fails here.
   */
  it("every execution this stage produces parses as a PipelineExecution", async () => {
    const runtime = buildRuntime({ opaque: ALWAYS_UNKNOWN });
    const requests = [
      request(),
      request({ headers: { authorization: "Basic abc" } }),
      request({ headers: { authorization: "Negotiate YIIZ" } }),
      request({ headers: { authorization: "Bearer a.b.c" } }),
      request({ headers: { "x-api-key": "k" } }),
      request({ query: { [API_KEY_QUERY_PARAM]: "k" } }),
      request({ clientCertSha256: "a".repeat(64) }),
    ];
    for (const req of requests) {
      const { execution } = await runtime.handleRequest(req);
      expect(() => PipelineExecutionSchema.parse(execution)).not.toThrow();
      expect(AUTH_OUTCOMES).toContain(execution.authOutcome);
    }
  });

  it("no scheme is both recognisable and absent from the support map", () => {
    for (const scheme of RECOGNISABLE_AUTH_SCHEMES) {
      expect(AUTH_SCHEMES).toContain(scheme);
      expect(AUTH_SCHEME_SUPPORT[scheme].treatment).not.toBe("indistinguishable");
    }
  });
});

describe("the RFC 6750 error parameter is only asserted where it is true", () => {
  /**
   * `error="invalid_token"` is RFC 6750 §3.1's code for a **bearer token** that was presented and
   * rejected. An api key is not a bearer token, so this arm was asserting a fact about a credential
   * family the request did not use — found by this increment's own post-fix measurement rather than
   * by reading, which is why it is pinned here.
   */
  it("an unknown api key is challenged without the bearer error code", async () => {
    const { response } = await buildRuntime({ opaque: ALWAYS_UNKNOWN }).handleRequest(
      request({ headers: { "x-api-key": "ce_live_nope" } }),
    );
    expect(response.headers["www-authenticate"]).toBe('Bearer realm="crossengin"');
  });

  it("the three families are distinguishable: presented-and-bad, unknown key, refused scheme", async () => {
    const kp = generateEd25519Keypair();
    const runtime = buildRuntime({
      jwks: new InMemoryJwksProvider({ keys: [{ kid: "k", publicKeyBase64: kp.publicKeyBase64 }] }),
      opaque: ALWAYS_UNKNOWN,
    });
    const badToken = await runtime.handleRequest(
      request({ headers: { authorization: "Bearer not-a-jwt" } }),
    );
    const unknownKey = await runtime.handleRequest(request({ headers: { "x-api-key": "k" } }));
    const refusedScheme = await runtime.handleRequest(
      request({ headers: { authorization: "Basic abc" } }),
    );
    expect(badToken.execution.authOutcome).toBe("credential_malformed");
    expect(unknownKey.execution.authOutcome).toBe("credential_not_found");
    expect(refusedScheme.execution.authOutcome).toBe("scheme_not_supported");
    expect(badToken.response.headers["www-authenticate"]).toContain("invalid_token");
    expect(unknownKey.response.headers["www-authenticate"]).not.toContain("invalid_token");
    expect(refusedScheme.response.headers["www-authenticate"]).not.toContain("invalid_token");
  });
});
