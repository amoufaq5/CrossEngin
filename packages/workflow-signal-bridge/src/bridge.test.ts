import { generateWebhookSecret, signWebhookDelivery } from "@crossengin/sdk";
import { describe, expect, it, vi } from "vitest";

import { WorkflowSignalBridge, type SignalSubmitter } from "./bridge.js";
import { fieldPathExtractor } from "./correlation.js";
import { StaticSecretResolver } from "./secret-resolver.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const SECRET = generateWebhookSecret();
const NOW_SECONDS = 1_700_000_000;

function buildEngine(
  result: Awaited<ReturnType<SignalSubmitter["submitSignal"]>> | Error = {
    deduplicated: false,
    matchedInstanceIds: ["wfi_inst0001"],
    signalId: "wfs_sig00001",
  },
): SignalSubmitter & { calls: number } {
  let calls = 0;
  return {
    submitSignal: vi.fn(async () => {
      calls += 1;
      if (result instanceof Error) throw result;
      return result;
    }) as SignalSubmitter["submitSignal"],
    get calls() {
      return calls;
    },
  };
}

function buildBridge(opts: {
  engine?: SignalSubmitter;
  signalName?: string;
  correlationPath?: string;
  secretBytes?: Uint8Array;
  toleranceSeconds?: number;
} = {}) {
  const secretResolver = new StaticSecretResolver(
    [{ tenantId: null, sourceSystem: null, secretBytes: opts.secretBytes ?? SECRET }],
    { defaultToleranceSeconds: opts.toleranceSeconds ?? 300 },
  );
  return new WorkflowSignalBridge({
    engine: opts.engine ?? buildEngine(),
    secretResolver,
    correlationExtractor: fieldPathExtractor(opts.correlationPath ?? "order.id"),
    signalName: opts.signalName ?? "order.shipped",
  });
}

function signedBody(body: unknown, secret = SECRET, ts = NOW_SECONDS) {
  const bodyString = JSON.stringify(body);
  const signed = signWebhookDelivery({
    secretBytes: secret,
    body: bodyString,
    timestampSeconds: ts,
  });
  return { bodyString, signatureValue: signed.signatureValue };
}

describe("WorkflowSignalBridge — constructor", () => {
  it("rejects empty signalName", () => {
    expect(() =>
      new WorkflowSignalBridge({
        engine: buildEngine(),
        secretResolver: new StaticSecretResolver([]),
        correlationExtractor: fieldPathExtractor("x"),
        signalName: "",
      }),
    ).toThrow(/non-empty signalName/);
  });
});

describe("WorkflowSignalBridge.handle — success path", () => {
  it("verifies signature, extracts correlation, submits signal, returns advanced", async () => {
    const engine = buildEngine();
    const bridge = buildBridge({ engine });
    const { bodyString, signatureValue } = signedBody({ order: { id: "po-99" } });
    const result = await bridge.handle({
      bodyBytes: bodyString,
      signatureHeader: signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("advanced");
    expect(result.signalId).toBe("wfs_sig00001");
    expect(result.matchedInstanceIds).toEqual(["wfi_inst0001"]);
    expect(engine.calls).toBe(1);
  });

  it("accepts Uint8Array body", async () => {
    const bridge = buildBridge();
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ order: { id: "po-1" } }));
    const signed = signWebhookDelivery({
      secretBytes: SECRET,
      body: bodyBytes,
      timestampSeconds: NOW_SECONDS,
    });
    const result = await bridge.handle({
      bodyBytes,
      signatureHeader: signed.signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("advanced");
  });

  it("returns deduplicated when the engine reports dedup", async () => {
    const engine = buildEngine({
      deduplicated: true,
      matchedInstanceIds: [],
      signalId: null,
    });
    const bridge = buildBridge({ engine });
    const { bodyString, signatureValue } = signedBody({ order: { id: "po-1" } });
    const result = await bridge.handle({
      bodyBytes: bodyString,
      signatureHeader: signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
      idempotencyKey: "evt-1",
    });
    expect(result.kind).toBe("deduplicated");
    expect(result.deduplicated).toBe(true);
  });

  it("returns no_matching_instance when no instances correlate", async () => {
    const engine = buildEngine({
      deduplicated: false,
      matchedInstanceIds: [],
      signalId: "wfs_sig00001",
    });
    const bridge = buildBridge({ engine });
    const { bodyString, signatureValue } = signedBody({ order: { id: "po-1" } });
    const result = await bridge.handle({
      bodyBytes: bodyString,
      signatureHeader: signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("no_matching_instance");
    expect(result.signalId).toBe("wfs_sig00001");
  });
});

describe("WorkflowSignalBridge.handle — auth failure paths", () => {
  it("returns secret_not_found when resolver returns null", async () => {
    const bridge = new WorkflowSignalBridge({
      engine: buildEngine(),
      secretResolver: new StaticSecretResolver([]),
      correlationExtractor: fieldPathExtractor("order.id"),
      signalName: "order.shipped",
    });
    const result = await bridge.handle({
      bodyBytes: "{}",
      signatureHeader: "t=1,v1=" + "a".repeat(64),
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("secret_not_found");
  });

  it("returns signature_malformed for a bad header", async () => {
    const bridge = buildBridge();
    const result = await bridge.handle({
      bodyBytes: JSON.stringify({ order: { id: "x" } }),
      signatureHeader: "garbage",
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("signature_malformed");
  });

  it("returns timestamp_outside_tolerance for stale signatures", async () => {
    const bridge = buildBridge({ toleranceSeconds: 60 });
    const { bodyString, signatureValue } = signedBody(
      { order: { id: "x" } },
      SECRET,
      NOW_SECONDS - 3_600,
    );
    const result = await bridge.handle({
      bodyBytes: bodyString,
      signatureHeader: signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("timestamp_outside_tolerance");
  });

  it("returns signature_invalid for a tampered body", async () => {
    const bridge = buildBridge();
    const { signatureValue } = signedBody({ order: { id: "real" } });
    const result = await bridge.handle({
      bodyBytes: JSON.stringify({ order: { id: "tampered" } }),
      signatureHeader: signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("signature_invalid");
  });
});

describe("WorkflowSignalBridge.handle — client errors", () => {
  it("returns body_not_json for non-JSON body", async () => {
    const bridge = buildBridge();
    const signed = signWebhookDelivery({
      secretBytes: SECRET,
      body: "not-json",
      timestampSeconds: NOW_SECONDS,
    });
    const result = await bridge.handle({
      bodyBytes: "not-json",
      signatureHeader: signed.signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("body_not_json");
  });

  it("returns body_not_json for a JSON array (not object)", async () => {
    const bridge = buildBridge();
    const bodyString = JSON.stringify([1, 2, 3]);
    const signed = signWebhookDelivery({
      secretBytes: SECRET,
      body: bodyString,
      timestampSeconds: NOW_SECONDS,
    });
    const result = await bridge.handle({
      bodyBytes: bodyString,
      signatureHeader: signed.signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("body_not_json");
  });

  it("returns correlation_missing when extractor returns null", async () => {
    const bridge = buildBridge({ correlationPath: "missing.field" });
    const { bodyString, signatureValue } = signedBody({ order: { id: "po-1" } });
    const result = await bridge.handle({
      bodyBytes: bodyString,
      signatureHeader: signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("correlation_missing");
  });
});

describe("WorkflowSignalBridge.handle — engine failure", () => {
  it("returns engine_error when submitSignal throws", async () => {
    const engine = buildEngine(new Error("engine down"));
    const bridge = buildBridge({ engine });
    const { bodyString, signatureValue } = signedBody({ order: { id: "po-1" } });
    const result = await bridge.handle({
      bodyBytes: bodyString,
      signatureHeader: signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
    });
    expect(result.kind).toBe("engine_error");
    expect(result.reason).toContain("engine down");
  });
});

describe("WorkflowSignalBridge — passes idempotencyKey to engine", () => {
  it("threads idempotency key into submitSignal call", async () => {
    let captured!: Parameters<SignalSubmitter["submitSignal"]>[0];
    const engine: SignalSubmitter = {
      submitSignal: vi.fn(async (input) => {
        captured = input;
        return { deduplicated: false, matchedInstanceIds: ["wfi_x"], signalId: "wfs_y" };
      }),
    };
    const bridge = buildBridge({ engine });
    const { bodyString, signatureValue } = signedBody({ order: { id: "po-1" } });
    await bridge.handle({
      bodyBytes: bodyString,
      signatureHeader: signatureValue,
      nowSeconds: NOW_SECONDS,
      tenantId: TENANT,
      idempotencyKey: "evt-99",
      sourceSystem: "stripe",
    });
    expect(captured?.idempotencyKey).toBe("evt-99");
    expect(captured?.sourceSystem).toBe("stripe");
    expect(captured?.correlationKey).toBe("po-1");
  });
});
