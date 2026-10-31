import {
  AUTH_OUTCOMES,
  AUTH_SCHEME_SUPPORT,
  PipelineExecutionSchema,
  REQUEST_SIGNATURE_HEADER_LOWER,
  type IncomingRequest,
  type PipelineExecution,
  type ResolvedPrincipal,
  type RouteDefinition,
} from "@crossengin/api-gateway";
import {
  DEFAULT_REQUEST_SIGNATURE_TOLERANCE_SECONDS,
  deriveRequestSigningKey,
  parseRequestSigningSecret,
  signRequest,
  type RequestSignatureFacts,
} from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { servedAuthSchemesFor } from "./auth-scheme-survey.js";
import { API_KEY_QUERY_PARAM } from "./auth.js";
import { HandlerRegistry } from "./dispatcher.js";
import {
  GatewayRuntime,
  type HmacKeyLookup,
  type HmacKeyLookupResult,
  type OpaqueTokenLookup,
} from "./runtime.js";
import {
  InMemoryIdempotencyStore,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
  type PrincipalResolver,
  type PrincipalResolverInput,
} from "./stores.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";
const NOW = "2026-05-16T12:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);

const KEY_ID = "k1";

/**
 * The **real derivation** rather than `new Uint8Array(32).fill(1)`, so this file exercises the
 * deployment-side half of the scheme too: a secret the floors would refuse, or a key id that
 * derived nothing, would fail here rather than at a deployment's first signed request.
 */
const REQUEST_SIGNING_SECRET = "hmac-request-signing/7Kq3Zx9Mb2Vn#Pw4Ld6!Tj8";
const KEY_BYTES = deriveRequestSigningKey(
  parseRequestSigningSecret(REQUEST_SIGNING_SECRET),
  KEY_ID,
);

/** Two body digests that differ, so the digest can be varied without varying anything else. */
const BODY_DIGEST_A = "1".repeat(64);
const BODY_DIGEST_B = "2".repeat(64);

/** The one sentence every signature refusal answers with. See the disclosure test below. */
const OPAQUE_REFUSAL_DETAIL = "request signature not accepted";

/** The clause `servedSchemeList()` renders into a 401's `detail`. */
const SERVES_MARKER = "this deployment serves ";

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

const KNOWN_KEY: HmacKeyLookupResult = Object.freeze({
  keyBytes: KEY_BYTES,
  principalRef: USER,
  scopes: Object.freeze(["tenants.write", "tenants.read"]),
  tenantId: TENANT,
});

interface RecordingHmacLookup extends HmacKeyLookup {
  readonly calls: ReadonlyArray<{ readonly keyId: string; readonly path: string }>;
}

/**
 * A lookup that records what it was asked, which is the only way to assert the arm's **ordering**:
 * a malformed header must be refused with no lookup at all, and `calls.length` is the one
 * observable that says so (the response and the stage reason are identical either way).
 */
function recordingLookup(
  answer: (keyId: string) => HmacKeyLookupResult | null = () => KNOWN_KEY,
): RecordingHmacLookup {
  const calls: Array<{ keyId: string; path: string }> = [];
  return {
    calls,
    async lookup(req, keyId) {
      calls.push({ keyId, path: req.path });
      return answer(keyId);
    },
  };
}

interface RecordingResolver extends PrincipalResolver {
  readonly calls: readonly PrincipalResolverInput[];
}

/**
 * Records what `resolve_principal` was handed, because that is where the lookup's `principalRef`,
 * `scopes` and `tenantId` have to arrive for the credential to mean anything —
 * `PipelineExecution` carries no `authScheme` field, so the scheme the stage stamped is observable
 * only here.
 */
function recordingResolver(): RecordingResolver {
  const calls: PrincipalResolverInput[] = [];
  return {
    calls,
    async resolve(input): Promise<ResolvedPrincipal | null> {
      calls.push(input);
      if (input.principalRef !== USER) return null;
      return {
        principalId: USER,
        tenantId: TENANT,
        principalKind: "user",
        authScheme: "bearer_jwt",
        grantedScopes: [],
        mfaProofAgeSeconds: null,
        resolvedAt: NOW,
      };
    },
  };
}

function buildRuntime(
  opts: {
    readonly hmac?: HmacKeyLookup;
    readonly opaque?: OpaqueTokenLookup;
    readonly toleranceSeconds?: number;
    readonly resolver?: PrincipalResolver;
  } = {},
): GatewayRuntime {
  return new GatewayRuntime({
    routes: new InMemoryRouteRegistry().register(openRoute()),
    handlers: new HandlerRegistry().register("tenants.create", () => ({
      kind: "json",
      status: 201,
      body: { ok: true },
    })),
    principalResolver: opts.resolver ?? recordingResolver(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    rateLimitChecker: new InMemoryRateLimitChecker({ limit: 1000 }),
    clock: { now: () => new Date(NOW) },
    ...(opts.hmac !== undefined ? { hmacKeyLookup: opts.hmac } : {}),
    ...(opts.opaque !== undefined ? { opaqueTokenLookup: opts.opaque } : {}),
    ...(opts.toleranceSeconds !== undefined
      ? { requestSignatureToleranceSeconds: opts.toleranceSeconds }
      : {}),
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

function withSignature(req: IncomingRequest, header: string): IncomingRequest {
  return { ...req, headers: { ...req.headers, [REQUEST_SIGNATURE_HEADER_LOWER]: header } };
}

/**
 * The facts of a request **as the stage reads them off it** — the six covered fields plus the key
 * id and timestamp the header carries. A caller overriding one of the six signs for a request
 * other than the one it sends, which is how each binding is tested.
 */
function factsFor(
  req: IncomingRequest,
  overrides: Partial<RequestSignatureFacts> = {},
): RequestSignatureFacts {
  return {
    keyId: KEY_ID,
    timestampSeconds: NOW_SECONDS,
    method: req.method,
    path: req.path,
    query: req.query,
    bodySha256: req.bodySha256,
    host: req.host,
    scheme: req.scheme,
    ...overrides,
  };
}

function signedRequest(
  overrides: Partial<IncomingRequest> = {},
  factOverrides: Partial<RequestSignatureFacts> = {},
): IncomingRequest {
  const base = request(overrides);
  return withSignature(base, signRequest(KEY_BYTES, factsFor(base, factOverrides)));
}

describe("hmac_signature — the scheme is served, so the arm exists", () => {
  it("is declared served in the support map", () => {
    expect(AUTH_SCHEME_SUPPORT.hmac_signature.treatment).toBe("served");
  });

  it("the parse stage names the scheme, so the credential is recorded as presented", async () => {
    const { execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(
      signedRequest(),
    );
    expect(stageReason(execution, "parse_auth_credential")).toBe("scheme_hmac_signature");
  });
});

describe("hmac_signature — no lookup configured", () => {
  it("is scheme_not_supported, not credential_not_found, because nothing was looked up", async () => {
    const { response, execution } = await buildRuntime().handleRequest(signedRequest());
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("scheme_not_supported");
    expect(stageReason(execution, "authenticate")).toBe("no_hmac_key_lookup");
    expect(execution.finalStage).toBe("authenticate");
  });

  it("the detail names the operator's remedy and not a different credential", async () => {
    const { response } = await buildRuntime().handleRequest(signedRequest());
    expect(String(problemBody(response.bodyBytes)["detail"])).toContain(
      "no signing-key lookup is configured",
    );
  });

  /**
   * The scheme is named as the one **refused**, so it must not also appear in the served list the
   * same sentence renders — a deployment with no lookup telling a client to present a signature is
   * a remedy that cannot work.
   */
  it("hmac_signature is never in the served list of its own refusal", async () => {
    const runtime = buildRuntime({ opaque: { async lookup() { return null; } } });
    expect(servedAuthSchemesFor(runtime.authSchemeServing)).not.toContain("hmac_signature");
    const { response } = await runtime.handleRequest(signedRequest());
    const detail = String(problemBody(response.bodyBytes)["detail"]);
    // Asserted present first, or the slice below would search a prefix and pass vacuously.
    expect(detail).toContain(SERVES_MARKER);
    const served = detail.slice(detail.indexOf(SERVES_MARKER) + SERVES_MARKER.length);
    expect(served).not.toContain("hmac_signature");
    expect(served).toContain("api_key_header");
  });

  it("with no credential scheme configured at all the served list says so", async () => {
    const { response } = await buildRuntime().handleRequest(signedRequest());
    expect(String(problemBody(response.bodyBytes)["detail"])).toContain(
      `${SERVES_MARKER}no credential scheme`,
    );
  });
});

describe("hmac_signature — a malformed header is refused before any lookup", () => {
  const MALFORMED: ReadonlyArray<readonly [string, string]> = [
    ["no fields at all", "garbage"],
    ["missing the timestamp field", `k=${KEY_ID},v1=${"a".repeat(64)}`],
    ["missing the key-id field", `t=${NOW_SECONDS.toString()},v1=${"a".repeat(64)}`],
    [
      "fields in the wrong order",
      `t=${NOW_SECONDS.toString()},k=${KEY_ID},v1=${"a".repeat(64)}`,
    ],
    ["upper-case hex", `k=${KEY_ID},t=${NOW_SECONDS.toString()},v1=${"A".repeat(64)}`],
    ["a 63-char signature", `k=${KEY_ID},t=${NOW_SECONDS.toString()},v1=${"a".repeat(63)}`],
    ["a 65-char signature", `k=${KEY_ID},t=${NOW_SECONDS.toString()},v1=${"a".repeat(65)}`],
    ["a key id carrying a comma", `k=k,1,t=${NOW_SECONDS.toString()},v1=${"a".repeat(64)}`],
    // Past the regex and refused by the parser's own bound: `\d{1,19}` admits a value
    // `parseInt` cannot round-trip, and a timestamp that cannot round-trip cannot be compared.
    ["a zero timestamp", `k=${KEY_ID},t=0,v1=${"a".repeat(64)}`],
    ["a timestamp past the safe range", `k=${KEY_ID},t=9999999999999999999,v1=${"a".repeat(64)}`],
  ];

  it.each(MALFORMED)("%s is credential_malformed", async (_label, header) => {
    const lookup = recordingLookup();
    const { response, execution } = await buildRuntime({ hmac: lookup }).handleRequest(
      withSignature(request(), header),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("credential_malformed");
    expect(stageReason(execution, "authenticate")).toBe("request_signature_malformed");
    // The arm parses before resolving, deliberately: a verifier cannot be handed a key, it has to
    // be told which one, so a header with no readable key id has nothing to look up.
    expect(lookup.calls).toHaveLength(0);
  });

  /**
   * The non-vacuity floor for the group above: the same lookup, with a **well-formed** header, is
   * called — so `calls.length === 0` there is the ordering and not a lookup that is never reached.
   */
  it("a well-formed header does reach the lookup, with the key id it carried", async () => {
    const lookup = recordingLookup();
    await buildRuntime({ hmac: lookup }).handleRequest(signedRequest());
    expect(lookup.calls).toEqual([{ keyId: KEY_ID, path: "/v1/tenants" }]);
  });

  it("the malformed detail names the expected grammar and echoes no part of the header", async () => {
    const header = `k=${KEY_ID},t=bad,v1=NOT-A-SIGNATURE-BUT-A-SECRET`;
    const { response, execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(
      withSignature(request(), header),
    );
    const detail = String(problemBody(response.bodyBytes)["detail"]);
    expect(detail).toContain("k=<keyId>,t=<unixSeconds>,v1=<hex64>");
    expect(detail).not.toContain("NOT-A-SIGNATURE-BUT-A-SECRET");
    expect(JSON.stringify(execution)).not.toContain("NOT-A-SIGNATURE-BUT-A-SECRET");
  });
});

describe("hmac_signature — an unknown key id", () => {
  const UNKNOWN_KEY_ID = "retired-key-7";

  function unknownKeyRequest(): IncomingRequest {
    return signedRequest({}, { keyId: UNKNOWN_KEY_ID });
  }

  it("is credential_not_found, because the lookup did happen", async () => {
    const lookup = recordingLookup(() => null);
    const { response, execution } = await buildRuntime({ hmac: lookup }).handleRequest(
      unknownKeyRequest(),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("credential_not_found");
    expect(lookup.calls).toEqual([{ keyId: UNKNOWN_KEY_ID, path: "/v1/tenants" }]);
  });

  /**
   * The key id is on the **record** and in neither the body nor the headers. It is not a secret —
   * it travels in the clear in the header — but the body stays one sentence so the surface is not
   * a key-id oracle, and the record is where an operator tells a retired key from a typo.
   */
  it("the key id is in the stage reason and nowhere in the response", async () => {
    const { response, execution } = await buildRuntime({
      hmac: recordingLookup(() => null),
    }).handleRequest(unknownKeyRequest());
    expect(stageReason(execution, "authenticate")).toBe(
      `request_signature_key_not_found_${UNKNOWN_KEY_ID}`,
    );
    expect(new TextDecoder().decode(response.bodyBytes ?? new Uint8Array())).not.toContain(
      UNKNOWN_KEY_ID,
    );
    expect(JSON.stringify(response.headers)).not.toContain(UNKNOWN_KEY_ID);
  });

  /** `StageResultSchema.reason` is `max(500)`; the longest key id the grammar admits is 120. */
  it("a maximal key id still yields a persistable execution", async () => {
    const maximal = "k".repeat(120);
    const { execution } = await buildRuntime({
      hmac: recordingLookup(() => null),
    }).handleRequest(signedRequest({}, { keyId: maximal }));
    expect(stageReason(execution, "authenticate")).toBe(
      `request_signature_key_not_found_${maximal}`,
    );
    expect(() => PipelineExecutionSchema.parse(execution)).not.toThrow();
  });
});

describe("hmac_signature — the timestamp tolerance", () => {
  async function outcomeAt(
    timestampSeconds: number,
    toleranceSeconds?: number,
  ): Promise<{ status: number; outcome: string; reason: string | undefined }> {
    const { response, execution } = await buildRuntime({
      hmac: recordingLookup(),
      ...(toleranceSeconds !== undefined ? { toleranceSeconds } : {}),
    }).handleRequest(signedRequest({}, { timestampSeconds }));
    return {
      status: response.status,
      outcome: execution.authOutcome,
      reason: stageReason(execution, "authenticate"),
    };
  }

  const TOLERANCE = DEFAULT_REQUEST_SIGNATURE_TOLERANCE_SECONDS;

  it("a timestamp too far in the past is expired_token", async () => {
    const result = await outcomeAt(NOW_SECONDS - TOLERANCE - 1);
    expect(result.status).toBe(401);
    expect(result.outcome).toBe("expired_token");
    expect(result.reason).toBe("request_signature_timestamp_outside_tolerance");
  });

  it("a timestamp too far in the future is expired_token too", async () => {
    const result = await outcomeAt(NOW_SECONDS + TOLERANCE + 1);
    expect(result.status).toBe(401);
    expect(result.outcome).toBe("expired_token");
    expect(result.reason).toBe("request_signature_timestamp_outside_tolerance");
  });

  /**
   * The window is `Math.abs(...) > tolerance`, so the boundary itself is **inside** it. Both ends
   * are pinned because an off-by-one in either direction is invisible to a test that only probes
   * well inside and well outside.
   */
  it("the boundary is accepted and one second beyond is refused, on both sides", async () => {
    for (const sign of [-1, 1]) {
      const atBoundary = await outcomeAt(NOW_SECONDS + sign * TOLERANCE);
      expect(atBoundary.outcome, `at boundary, sign ${sign.toString()}`).toBe("authenticated");
      expect(atBoundary.status, `at boundary, sign ${sign.toString()}`).toBe(201);
      const beyond = await outcomeAt(NOW_SECONDS + sign * (TOLERANCE + 1));
      expect(beyond.outcome, `beyond boundary, sign ${sign.toString()}`).toBe("expired_token");
    }
  });

  /**
   * The default is pinned **behaviourally** — the boundary test above runs at
   * `DEFAULT_REQUEST_SIGNATURE_TOLERANCE_SECONDS` against a runtime that names no tolerance, so a
   * changed default moves that test rather than this one, which only fixes the number.
   */
  it("the default tolerance is the primitive's own constant", () => {
    expect(DEFAULT_REQUEST_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });

  it("a configured tolerance is honoured in both directions", async () => {
    const narrow = 10;
    expect((await outcomeAt(NOW_SECONDS - narrow, narrow)).outcome).toBe("authenticated");
    expect((await outcomeAt(NOW_SECONDS - narrow - 1, narrow)).outcome).toBe("expired_token");
    // The same timestamp the default would accept, which is what makes the narrowing observable
    // rather than a second spelling of the boundary test above.
    expect((await outcomeAt(NOW_SECONDS - 60, narrow)).outcome).toBe("expired_token");
    expect((await outcomeAt(NOW_SECONDS - 60)).outcome).toBe("authenticated");
  });

  it("a wider tolerance accepts what the default refuses", async () => {
    const wide = TOLERANCE * 4;
    expect((await outcomeAt(NOW_SECONDS - TOLERANCE - 60, wide)).outcome).toBe("authenticated");
    expect((await outcomeAt(NOW_SECONDS - TOLERANCE - 60)).outcome).toBe("expired_token");
  });
});

describe("hmac_signature — a bad signature", () => {
  function tamperedSignature(): IncomingRequest {
    const signed = signedRequest();
    const header = signed.headers[REQUEST_SIGNATURE_HEADER_LOWER]!;
    // One hex digit flipped, so the header stays well-formed and the *comparison* is what fails.
    const flipped = header.slice(0, -1) + (header.endsWith("f") ? "e" : "f");
    return withSignature(signed, flipped);
  }

  it("is invalid_signature", async () => {
    const { response, execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(
      tamperedSignature(),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("invalid_signature");
    expect(stageReason(execution, "authenticate")).toBe("request_signature_signature_mismatch");
  });

  it("a signature made with another key is invalid_signature, not credential_not_found", async () => {
    const otherKey = deriveRequestSigningKey(
      parseRequestSigningSecret(REQUEST_SIGNING_SECRET),
      "some-other-key-id",
    );
    const base = request();
    const req = withSignature(base, signRequest(otherKey, factsFor(base)));
    const { execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(req);
    expect(execution.authOutcome).toBe("invalid_signature");
    expect(stageReason(execution, "authenticate")).toBe("request_signature_signature_mismatch");
  });
});

describe("hmac_signature — the disclosure property", () => {
  /**
   * The one assertion worth making hardest. Telling a caller *which* half failed turns the header
   * into a key-id oracle and a clock oracle, so the three refusals answer one sentence — while the
   * three recorded reasons differ, because the remedies are a retired key, a drifted clock and a
   * wrong key or canonicalisation, and each belongs to a different party.
   */
  async function refuse(
    kind: "unknown_key" | "stale_timestamp" | "bad_signature",
  ): Promise<{ bytes: Uint8Array; headers: Record<string, string>; reason: string | undefined }> {
    const lookup = recordingLookup(() => (kind === "unknown_key" ? null : KNOWN_KEY));
    const req =
      kind === "stale_timestamp"
        ? signedRequest({}, { timestampSeconds: NOW_SECONDS - 100_000 })
        : kind === "unknown_key"
          ? signedRequest({}, { keyId: "no-such-key" })
          : withSignature(request(), `k=${KEY_ID},t=${NOW_SECONDS.toString()},v1=${"b".repeat(64)}`);
    const { response, execution } = await buildRuntime({ hmac: lookup }).handleRequest(req);
    expect(response.status).toBe(401);
    return {
      bytes: response.bodyBytes ?? new Uint8Array(),
      headers: response.headers,
      reason: stageReason(execution, "authenticate"),
    };
  }

  it("the three bodies are byte-identical", async () => {
    const unknown = await refuse("unknown_key");
    const stale = await refuse("stale_timestamp");
    const bad = await refuse("bad_signature");
    expect([...stale.bytes]).toEqual([...unknown.bytes]);
    expect([...bad.bytes]).toEqual([...unknown.bytes]);
    // Non-vacuity: a pair of empty bodies would also be equal.
    expect(String(problemBody(unknown.bytes)["detail"])).toBe(OPAQUE_REFUSAL_DETAIL);
    expect(unknown.bytes.byteLength).toBeGreaterThan(0);
  });

  it("the three responses carry identical headers", async () => {
    const unknown = await refuse("unknown_key");
    const stale = await refuse("stale_timestamp");
    const bad = await refuse("bad_signature");
    expect(stale.headers).toEqual(unknown.headers);
    expect(bad.headers).toEqual(unknown.headers);
    expect(unknown.headers["www-authenticate"]).toBe('Bearer realm="crossengin"');
  });

  it("the three recorded reasons are all different", async () => {
    const reasons = [
      (await refuse("unknown_key")).reason,
      (await refuse("stale_timestamp")).reason,
      (await refuse("bad_signature")).reason,
    ];
    expect(new Set(reasons).size).toBe(3);
    expect(reasons).toEqual([
      "request_signature_key_not_found_no-such-key",
      "request_signature_timestamp_outside_tolerance",
      "request_signature_signature_mismatch",
    ]);
  });

  /**
   * A stale timestamp is the one of the three a well-behaved client hits, so it is the one an
   * operator must be able to filter out of a forgery count — which is why it lands on a different
   * `authOutcome` and not only on a different reason.
   */
  it("a drifted clock is a different outcome from a forgery", async () => {
    const runtime = buildRuntime({ hmac: recordingLookup() });
    const stale = await runtime.handleRequest(
      signedRequest({}, { timestampSeconds: NOW_SECONDS - 100_000 }),
    );
    const forged = await runtime.handleRequest(
      withSignature(request(), `k=${KEY_ID},t=${NOW_SECONDS.toString()},v1=${"b".repeat(64)}`),
    );
    expect(stale.execution.authOutcome).toBe("expired_token");
    expect(forged.execution.authOutcome).toBe("invalid_signature");
  });
});

describe("hmac_signature — a verified signature", () => {
  /**
   * The most important test here: it is the only one that proves the **stage and the signer agree
   * about the canonical message**, because the facts are read off the very request that is sent.
   * Any disagreement — a dropped field, a differently-rendered query, a host read from
   * `forwardedHost` — fails here rather than silently narrowing what a signature covers.
   */
  it("authenticates and reaches the handler", async () => {
    const resolver = recordingResolver();
    const { response, execution } = await buildRuntime({
      hmac: recordingLookup(),
      resolver,
    }).handleRequest(signedRequest());
    expect(response.status).toBe(201);
    expect(execution.authOutcome).toBe("authenticated");
    expect(stageReason(execution, "authenticate")).toBe("request_signature_verified");
    expect(stageReason(execution, "resolve_principal")).toBe("principal_resolved");
    expect(execution.finalStage).toBe("emit_audit");
    expect(execution.finalOutcome).toBe("pass");
  });

  it("carries what the lookup returned into resolve_principal and into the row", async () => {
    const resolver = recordingResolver();
    const { execution } = await buildRuntime({
      hmac: recordingLookup(),
      resolver,
    }).handleRequest(signedRequest());
    expect(resolver.calls).toEqual([
      {
        authScheme: "hmac_signature",
        principalRef: KNOWN_KEY.principalRef,
        scopes: KNOWN_KEY.scopes,
        tenantId: KNOWN_KEY.tenantId,
      },
    ]);
    expect(execution.tenantId).toBe(TENANT);
    expect(execution.principalId).toBe(USER);
  });

  it("a signature whose key names an unresolvable principal is principal_not_found", async () => {
    const lookup = recordingLookup(() => ({ ...KNOWN_KEY, principalRef: "not-registered" }));
    const { response, execution } = await buildRuntime({ hmac: lookup }).handleRequest(
      signedRequest(),
    );
    expect(response.status).toBe(401);
    // The signature verified; the refusal is the next stage's, which is the split that keeps a
    // provisioning gap from reading as a bad credential.
    expect(stageReason(execution, "authenticate")).toBe("request_signature_verified");
    expect(execution.authOutcome).toBe("principal_not_found");
  });

  it("every execution this arm produces parses as a PipelineExecution", async () => {
    const cases: ReadonlyArray<readonly [HmacKeyLookup | undefined, IncomingRequest]> = [
      [undefined, signedRequest()],
      [recordingLookup(), withSignature(request(), "garbage")],
      [recordingLookup(() => null), signedRequest()],
      [recordingLookup(), signedRequest({}, { timestampSeconds: NOW_SECONDS - 100_000 })],
      [
        recordingLookup(),
        withSignature(request(), `k=${KEY_ID},t=${NOW_SECONDS.toString()},v1=${"b".repeat(64)}`),
      ],
      [recordingLookup(), signedRequest()],
    ];
    const seen = new Set<string>();
    for (const [hmac, req] of cases) {
      const { execution } = await buildRuntime({
        ...(hmac !== undefined ? { hmac } : {}),
      }).handleRequest(req);
      expect(() => PipelineExecutionSchema.parse(execution)).not.toThrow();
      expect(AUTH_OUTCOMES).toContain(execution.authOutcome);
      seen.add(execution.authOutcome);
    }
    expect([...seen].sort()).toEqual([
      "authenticated",
      "credential_malformed",
      "credential_not_found",
      "expired_token",
      "invalid_signature",
      "scheme_not_supported",
    ]);
  });
});

describe("hmac_signature — each covered fact is bound", () => {
  /**
   * One case per field the canonical message covers. Each runs **both arms over the same sent
   * request** — signed for its own facts, then signed for a different value — so a signature that
   * never verified could not pass the group.
   */
  const BOUND: ReadonlyArray<
    readonly [string, Partial<IncomingRequest>, Partial<RequestSignatureFacts>]
  > = [
    ["method", {}, { method: "PUT" }],
    ["path", {}, { path: "/v1/tenants/other" }],
    ["query", { query: { filter: "theirs" } }, { query: { filter: "mine" } }],
    // Varied with a non-zero `bodyBytes`, because `IncomingRequestSchema` refuses a non-empty body
    // with no digest — so a digest-bearing request has to claim a body to stay representable.
    ["bodySha256", { bodyBytes: 7, bodySha256: BODY_DIGEST_A }, { bodySha256: BODY_DIGEST_B }],
    ["host", {}, { host: "evil.example.com" }],
    ["scheme", {}, { scheme: "http" }],
  ];

  it.each(BOUND)(
    "%s is covered: signed for another value, the signature is refused",
    async (label, reqOverrides, factOverrides) => {
      const runtime = buildRuntime({ hmac: recordingLookup() });
      const honest = await runtime.handleRequest(signedRequest(reqOverrides));
      expect(honest.execution.authOutcome, `${label}: honest arm`).toBe("authenticated");
      expect(honest.response.status, `${label}: honest arm`).toBe(201);
      const crossed = await runtime.handleRequest(signedRequest(reqOverrides, factOverrides));
      expect(crossed.execution.authOutcome, `${label}: crossed arm`).toBe("invalid_signature");
      expect(crossed.response.status, `${label}: crossed arm`).toBe(401);
      expect(stageReason(crossed.execution, "authenticate"), `${label}: crossed arm`).toBe(
        "request_signature_signature_mismatch",
      );
    },
  );

  /**
   * The query is covered **sorted, with each multi-value's own order preserved** — the primitive's
   * rule, asserted through the stage: `?sort=a&sort=b` and `?sort=b&sort=a` are different requests
   * to `parseListQuery`, so they must be different messages.
   */
  it("a multi-value query is covered, and a reordered multi-value is a different message", async () => {
    const runtime = buildRuntime({ hmac: recordingLookup() });
    const overrides = { query: { sort: ["a", "b"], filter: "x" } } satisfies Partial<IncomingRequest>;
    const honest = await runtime.handleRequest(signedRequest(overrides));
    expect(honest.execution.authOutcome).toBe("authenticated");
    const reordered = await runtime.handleRequest(
      signedRequest(overrides, { query: { sort: ["b", "a"], filter: "x" } }),
    );
    expect(reordered.execution.authOutcome).toBe("invalid_signature");
  });

  /** Key-insertion order is *not* a fact, because the message sorts the keys. */
  it("the same query written in another key order is the same message", async () => {
    const base = request({ query: { b: "2", a: "1" } });
    const req = withSignature(
      base,
      signRequest(KEY_BYTES, factsFor(base, { query: { a: "1", b: "2" } })),
    );
    const { execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(req);
    expect(execution.authOutcome).toBe("authenticated");
  });

  /** A signature is not transferable between key ids, because the key id is inside the message. */
  it("the key id is covered: replacing it in the header invalidates the signature", async () => {
    const signed = signedRequest();
    const header = signed.headers[REQUEST_SIGNATURE_HEADER_LOWER]!;
    const relabelled = header.replace(`k=${KEY_ID},`, "k=k2,");
    // The lookup answers the *same* key for any id, so a refusal here is the message and not the key.
    const { execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(
      withSignature(signed, relabelled),
    );
    expect(execution.authOutcome).toBe("invalid_signature");
  });

  /** And the timestamp, likewise: it is inside the message, not only compared against the clock. */
  it("the timestamp is covered: moving it within tolerance invalidates the signature", async () => {
    const signed = signedRequest();
    const header = signed.headers[REQUEST_SIGNATURE_HEADER_LOWER]!;
    const moved = header.replace(
      `t=${NOW_SECONDS.toString()},`,
      `t=${(NOW_SECONDS - 1).toString()},`,
    );
    const { execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(
      withSignature(signed, moved),
    );
    expect(execution.authOutcome).toBe("invalid_signature");
  });
});

describe("hmac_signature — precedence among the recognition positions", () => {
  /**
   * `x-api-key` sits above the signature header, so nothing that resolved before the scheme
   * existed resolves differently. First match wins, as it already did for
   * `Authorization` + `x-api-key`.
   */
  it("an api key beside a signature resolves api_key_header, and the hmac lookup is never asked", async () => {
    const hmac = recordingLookup();
    const { response, execution } = await buildRuntime({
      hmac,
      opaque: {
        async lookup() {
          return { principalRef: USER, scopes: [], tenantId: TENANT };
        },
      },
    }).handleRequest({
      ...signedRequest(),
      headers: {
        ...signedRequest().headers,
        "x-api-key": "ce_live_abcdefgh",
      },
    });
    expect(response.status).toBe(201);
    expect(stageReason(execution, "parse_auth_credential")).toBe("scheme_api_key_header");
    expect(stageReason(execution, "authenticate")).toBe("api_key_recognized");
    expect(hmac.calls).toHaveLength(0);
  });

  /**
   * Measured rather than assumed: the signature position sits **before** the residual, so an
   * unrecognised `Authorization` plus a good signature authenticates as `hmac_signature`.
   *
   * That is right, and it is the file's own stated rule rather than an accident: the residual means
   * *nothing recognised this*, and a verdict meaning that must not outrank a position that did —
   * which is exactly why `x-api-key` was already ahead of it, so a request with an unrecognised
   * `Authorization` and an api key resolved the api key. The ignored `Authorization` header is the
   * cost, and it is the same cost that precedent already pays.
   */
  it("an unrecognised Authorization beside a good signature resolves hmac_signature", async () => {
    const { response, execution } = await buildRuntime({
      hmac: recordingLookup(),
    }).handleRequest({
      ...signedRequest(),
      headers: {
        ...signedRequest().headers,
        authorization: "Negotiate YIIZ",
      },
    });
    expect(stageReason(execution, "parse_auth_credential")).toBe("scheme_hmac_signature");
    expect(execution.authOutcome).toBe("authenticated");
    expect(response.status).toBe(201);
  });

  /**
   * `api_key_query`'s refusal stays ahead of it, which is right rather than incidental: that
   * refusal is about a credential already copied into access logs and a Referer, and that happened
   * regardless of what else the request carried.
   */
  it("a key in the URL beside a good signature is still refused for the key in the URL", async () => {
    const { response, execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(
      signedRequest({ query: { [API_KEY_QUERY_PARAM]: "ce_live_abcdefgh" } }),
    );
    expect(response.status).toBe(401);
    expect(execution.authOutcome).toBe("scheme_not_supported");
    expect(stageReason(execution, "authenticate")).toBe("scheme_unsupported_api_key_query");
  });

  /**
   * `mtls` is a property of the connection and sits last, so a cert-forwarding edge does not turn
   * every signed request into an `mtls` refusal.
   */
  it("a forwarded client certificate beside a good signature resolves hmac_signature", async () => {
    const { response, execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(
      signedRequest({ clientCertSha256: "a".repeat(64) }),
    );
    expect(stageReason(execution, "parse_auth_credential")).toBe("scheme_hmac_signature");
    expect(response.status).toBe(201);
  });
});

describe("hmac_signature — an empty header is nothing supplied", () => {
  /**
   * ADR-0365's rule: a form serialises an unset field as an empty value, so an empty header is
   * nothing supplied rather than something malformed. Such a request is served anonymously where
   * the route allows it — refusing it would make an unset client field a 401.
   */
  it.each([
    ["an empty value", ""],
    ["a single space", " "],
    ["whitespace only", "   \t  "],
  ])("%s is absent, not malformed", async (_label, header) => {
    const lookup = recordingLookup();
    const { response, execution } = await buildRuntime({ hmac: lookup }).handleRequest(
      withSignature(request(), header),
    );
    expect(response.status).toBe(201);
    expect(execution.authOutcome).toBe("anonymous");
    expect(stageReason(execution, "parse_auth_credential")).toBe("no_credential");
    expect(stageReason(execution, "authenticate")).toBe("no_credential_skipped");
    expect(lookup.calls).toHaveLength(0);
  });

  /**
   * **Measured, and an asymmetry worth naming rather than a property worth having.**
   * `parseAuthHeader` recognises on `signature.trim().length > 0` and carries `token:
   * signature.trim()`, while the stage re-reads `ctx.request.headers[…]` **raw** and parses that —
   * so a padded well-formed header is the one band that is *recognised* as a credential and then
   * refused `credential_malformed` by an anchored pattern. `parsed.token` is dead on this arm, and
   * it holds exactly the value the stage wants.
   *
   * Latent rather than live for an HTTP-sourced request: RFC 9112 §5 has the recipient strip the
   * OWS around a field value, and both node's parser and `Headers.get()` do — `normalizeHeaders`
   * joins repeats and trims nothing, so the padding can only arrive from a direct
   * `handleRequest` caller. Pinned here so the asymmetry is visible, and so that closing it moves
   * this test rather than going unnoticed.
   */
  it("a padded but well-formed header authenticates, because the stage takes the parsed token", async () => {
    // This test was written the other way round and pinned a real defect, which is why it moved
    // rather than being deleted: the stage used to re-read `request.headers[...]` and parse *that*
    // against an anchored pattern, while `parseAuthHeader` recognises on the **trimmed** value and
    // carries it — so a padded well-formed header was recognised as a credential and then refused
    // `credential_malformed`, and `parsed.token` was dead on the only served arm that did not use
    // it. Two readings of one credential, in the increment whose subject is one spelling per thing.
    //
    // Latent rather than live either way: RFC 9112 §5 has the recipient strip the surrounding
    // whitespace and both node's parser and `Headers.get()` do, so the padding can only arrive from
    // a direct `handleRequest` caller — which the public API permits, which is why it is fixed.
    const signed = signedRequest();
    const header = signed.headers[REQUEST_SIGNATURE_HEADER_LOWER]!;
    const padded = withSignature(signed, `  ${header}  `);
    const { execution } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(padded);
    expect(stageReason(execution, "parse_auth_credential")).toBe("scheme_hmac_signature");
    expect(execution.authOutcome).toBe("authenticated");
    // And the unpadded header over the same request answers identically, which is the property:
    // the two spellings of one credential are now one credential.
    const { execution: clean } = await buildRuntime({ hmac: recordingLookup() }).handleRequest(
      signed,
    );
    expect(clean.authOutcome).toBe(execution.authOutcome);
    expect(clean.authOutcome).toBe("authenticated");
  });
});
