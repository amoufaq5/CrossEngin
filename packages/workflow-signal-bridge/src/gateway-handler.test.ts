import { SIGNATURE_HEADER_NAME, generateWebhookSecret, signWebhookDelivery } from "@crossengin/sdk";
import type { HandlerInput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it, vi } from "vitest";

import { WorkflowSignalBridge, type SignalSubmitter } from "./bridge.js";
import { fieldPathExtractor } from "./correlation.js";
import { createSignalBridgeHandler } from "./gateway-handler.js";
import { StaticSecretResolver } from "./secret-resolver.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000010";
const SECRET = generateWebhookSecret();
const NOW_SECONDS = 1_700_000_000;

function buildEngine(): SignalSubmitter & { calls: number } {
  let calls = 0;
  return {
    submitSignal: vi.fn(async () => {
      calls += 1;
      return {
        deduplicated: false,
        matchedInstanceIds: ["wfi_inst0001"],
        signalId: "wfs_sig00001",
      };
    }) as SignalSubmitter["submitSignal"],
    get calls() {
      return calls;
    },
  };
}

function buildBridge(opts: { engine?: SignalSubmitter } = {}) {
  return new WorkflowSignalBridge({
    engine: opts.engine ?? buildEngine(),
    secretResolver: new StaticSecretResolver([
      { tenantId: null, sourceSystem: null, secretBytes: SECRET },
    ]),
    correlationExtractor: fieldPathExtractor("order.id"),
    signalName: "order.shipped",
  });
}

function fixtureRoute(): HandlerInput["route"] {
  return {
    id: "rt_route0001",
    operationId: "webhooks.order_shipped",
    method: "POST",
    pathSegments: [
      { kind: "literal", value: "webhooks" },
      { kind: "literal", value: "order" },
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
    sourcePack: null,
  };
}

function fixturePrincipal(): NonNullable<HandlerInput["principal"]> {
  return {
    principalId: USER,
    tenantId: TENANT,
    principalKind: "service_account",
    authScheme: "hmac_signature",
    grantedScopes: [],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-05-16T12:00:00.000Z",
  };
}

function fixtureRequest(overrides: Partial<HandlerInput["request"]> = {}): HandlerInput["request"] {
  return {
    id: "req_test00000001",
    receivedAt: "2026-05-16T12:00:00.000Z",
    method: "POST",
    path: "/webhooks/order",
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

function handlerInput(opts: {
  body: unknown;
  headers?: Record<string, string>;
  withPrincipal?: boolean;
  tenantHint?: string | null;
}): HandlerInput {
  const bodyString = JSON.stringify(opts.body);
  const signed = signWebhookDelivery({
    secretBytes: SECRET,
    body: bodyString,
    timestampSeconds: NOW_SECONDS,
  });
  return {
    request: fixtureRequest({
      headers: {
        [SIGNATURE_HEADER_NAME.toLowerCase()]: signed.signatureValue,
        ...(opts.headers ?? {}),
      },
      tenantHint: opts.tenantHint ?? null,
    }),
    route: fixtureRoute(),
    principal: opts.withPrincipal !== false ? fixturePrincipal() : null,
    params: {},
    parsedBody: opts.body as Record<string, unknown>,
  };
}

describe("createSignalBridgeHandler — success", () => {
  it("returns 202 + advanced when signature verifies + signal advances", async () => {
    const engine = buildEngine();
    const bridge = buildBridge({ engine });
    const handler = createSignalBridgeHandler({ bridge, nowSeconds: () => NOW_SECONDS });
    const result = await handler(handlerInput({ body: { order: { id: "po-1" } } }));
    if (result.kind !== "json") throw new Error("expected json");
    expect(result.status).toBe(202);
    const body = result.body as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["outcome"]).toBe("advanced");
    expect(body["matchedInstanceIds"]).toEqual(["wfi_inst0001"]);
    expect(engine.calls).toBe(1);
  });

  it("threads Idempotency-Key into the bridge", async () => {
    let captured!: Parameters<SignalSubmitter["submitSignal"]>[0];
    const engine: SignalSubmitter = {
      submitSignal: vi.fn(async (input) => {
        captured = input;
        return { deduplicated: true, matchedInstanceIds: [], signalId: null };
      }),
    };
    const bridge = buildBridge({ engine });
    const handler = createSignalBridgeHandler({ bridge, nowSeconds: () => NOW_SECONDS });
    await handler(
      handlerInput({
        body: { order: { id: "po-99" } },
        headers: { "idempotency-key": "evt-42" },
      }),
    );
    expect(captured?.idempotencyKey).toBe("evt-42");
  });

  it("uses sourceSystem option when provided", async () => {
    let captured!: Parameters<SignalSubmitter["submitSignal"]>[0];
    const engine: SignalSubmitter = {
      submitSignal: vi.fn(async (input) => {
        captured = input;
        return { deduplicated: false, matchedInstanceIds: ["wfi_x"], signalId: "wfs_y" };
      }),
    };
    const bridge = buildBridge({ engine });
    const handler = createSignalBridgeHandler({
      bridge,
      nowSeconds: () => NOW_SECONDS,
      sourceSystem: "stripe",
    });
    await handler(handlerInput({ body: { order: { id: "po-1" } } }));
    expect(captured?.sourceSystem).toBe("stripe");
  });
});

describe("createSignalBridgeHandler — auth + client errors", () => {
  it("returns 401 when signature header is missing", async () => {
    const bridge = buildBridge();
    const handler = createSignalBridgeHandler({ bridge, nowSeconds: () => NOW_SECONDS });
    const result = await handler({
      request: fixtureRequest({ headers: {} }),
      route: fixtureRoute(),
      principal: fixturePrincipal(),
      params: {},
      parsedBody: { order: { id: "po-1" } },
    });
    if (result.kind !== "json") throw new Error("expected json");
    expect(result.status).toBe(401);
    const body = result.body as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(String(body["reason"])).toContain("missing");
  });

  it("returns 400 when tenantId cannot be resolved", async () => {
    const bridge = buildBridge();
    const handler = createSignalBridgeHandler({ bridge, nowSeconds: () => NOW_SECONDS });
    const result = await handler(
      handlerInput({ body: { order: { id: "x" } }, withPrincipal: false, tenantHint: null }),
    );
    if (result.kind !== "json") throw new Error("expected json");
    expect(result.status).toBe(400);
    const body = result.body as Record<string, unknown>;
    expect(String(body["reason"])).toContain("tenant");
  });

  it("falls back to tenantHint when no principal is resolved", async () => {
    const engine = buildEngine();
    const bridge = buildBridge({ engine });
    const handler = createSignalBridgeHandler({ bridge, nowSeconds: () => NOW_SECONDS });
    const result = await handler(
      handlerInput({
        body: { order: { id: "po-h" } },
        withPrincipal: false,
        tenantHint: TENANT,
      }),
    );
    if (result.kind !== "json") throw new Error("expected json");
    expect(result.status).toBe(202);
  });

  it("returns 400 when correlation extractor returns null", async () => {
    const bridge = new WorkflowSignalBridge({
      engine: buildEngine(),
      secretResolver: new StaticSecretResolver([
        { tenantId: null, sourceSystem: null, secretBytes: SECRET },
      ]),
      correlationExtractor: fieldPathExtractor("missing.path"),
      signalName: "order.shipped",
    });
    const handler = createSignalBridgeHandler({ bridge, nowSeconds: () => NOW_SECONDS });
    const result = await handler(handlerInput({ body: { order: { id: "po-1" } } }));
    if (result.kind !== "json") throw new Error("expected json");
    expect(result.status).toBe(400);
    const body = result.body as Record<string, unknown>;
    expect(body["outcome"]).toBe("correlation_missing");
  });
});

describe("createSignalBridgeHandler — header lookup", () => {
  it("respects custom signatureHeaderName", async () => {
    const bridge = buildBridge();
    const handler = createSignalBridgeHandler({
      bridge,
      signatureHeaderName: "X-Custom-Signature",
      nowSeconds: () => NOW_SECONDS,
    });
    const bodyString = JSON.stringify({ order: { id: "po-1" } });
    const signed = signWebhookDelivery({
      secretBytes: SECRET,
      body: bodyString,
      timestampSeconds: NOW_SECONDS,
    });
    const result = await handler({
      request: fixtureRequest({
        headers: { "x-custom-signature": signed.signatureValue },
      }),
      route: fixtureRoute(),
      principal: fixturePrincipal(),
      params: {},
      parsedBody: { order: { id: "po-1" } },
    });
    if (result.kind !== "json") throw new Error("expected json");
    expect(result.status).toBe(202);
  });
});
