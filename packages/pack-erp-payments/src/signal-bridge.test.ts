import { signWebhookDelivery } from "@crossengin/sdk";
import type { SecretResolver, SignalSubmitter } from "@crossengin/workflow-signal-bridge";
import { describe, expect, it } from "vitest";

import {
  PAYMENT_SIGNAL_NAMES,
  PROVIDER_EVENT_SIGNAL_MAP,
  buildPaymentBridgesByEvent,
  buildPaymentSignalBridge,
  paymentReferenceExtractor,
  resolvePaymentSignalForEvent,
} from "./signal-bridge.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

function fixedSecret(secretBytes: Uint8Array): SecretResolver {
  return {
    async resolve() {
      return { secretBytes, toleranceSeconds: 300 };
    },
  };
}

class RecordingSubmitter implements SignalSubmitter {
  readonly calls: Array<Parameters<SignalSubmitter["submitSignal"]>[0]> = [];

  async submitSignal(input: Parameters<SignalSubmitter["submitSignal"]>[0]) {
    this.calls.push(input);
    return {
      deduplicated: false,
      matchedInstanceIds: ["wfi_1"],
      signalId: "sig_1",
    };
  }
}

function makeWebhook(payload: unknown, secretBytes: Uint8Array) {
  const body = JSON.stringify(payload);
  const signed = signWebhookDelivery({
    secretBytes,
    body,
    timestampSeconds: Math.floor(Date.now() / 1000),
  });
  return { body, signatureHeader: signed.signatureValue };
}

describe("PAYMENT_SIGNAL_NAMES", () => {
  it("exports the 5 lifecycle signal names", () => {
    expect(Object.values(PAYMENT_SIGNAL_NAMES).sort()).toEqual([
      "payment.cancelled",
      "payment.captured",
      "payment.failed",
      "payment.refunded",
      "payment.settled",
    ]);
  });
});

describe("PROVIDER_EVENT_SIGNAL_MAP", () => {
  it("maps the canonical Stripe event types", () => {
    expect(PROVIDER_EVENT_SIGNAL_MAP["payment_intent.succeeded"]).toBe(
      PAYMENT_SIGNAL_NAMES.CAPTURED,
    );
    expect(PROVIDER_EVENT_SIGNAL_MAP["payment_intent.payment_failed"]).toBe(
      PAYMENT_SIGNAL_NAMES.FAILED,
    );
    expect(PROVIDER_EVENT_SIGNAL_MAP["charge.refunded"]).toBe(
      PAYMENT_SIGNAL_NAMES.REFUNDED,
    );
  });

  it("maps the canonical Adyen event types", () => {
    expect(PROVIDER_EVENT_SIGNAL_MAP["AUTHORISATION"]).toBe(
      PAYMENT_SIGNAL_NAMES.CAPTURED,
    );
    expect(PROVIDER_EVENT_SIGNAL_MAP["REFUND"]).toBe(PAYMENT_SIGNAL_NAMES.REFUNDED);
    expect(PROVIDER_EVENT_SIGNAL_MAP["CANCELLATION"]).toBe(
      PAYMENT_SIGNAL_NAMES.CANCELLED,
    );
  });
});

describe("resolvePaymentSignalForEvent", () => {
  it("returns the mapped signal for known events", () => {
    expect(resolvePaymentSignalForEvent("payment_intent.succeeded")).toBe(
      "payment.captured",
    );
  });

  it("returns null for unknown events", () => {
    expect(resolvePaymentSignalForEvent("unknown.event")).toBeNull();
  });
});

describe("paymentReferenceExtractor", () => {
  it("extracts from a Stripe payment_intent.succeeded body", () => {
    const extractor = paymentReferenceExtractor();
    const ref = extractor.extract({
      data: { object: { id: "pi_abc123" } },
    });
    expect(ref).toBe("pi_abc123");
  });

  it("extracts from a Stripe charge.refunded body (payment_intent field)", () => {
    const extractor = paymentReferenceExtractor();
    const ref = extractor.extract({
      data: { object: { id: "ch_xxx", payment_intent: "pi_xxx" } },
    });
    expect(ref).toBe("ch_xxx");
  });

  it("extracts from an Adyen body (pspReference)", () => {
    const extractor = paymentReferenceExtractor();
    const ref = extractor.extract({ pspReference: "8814689190961342" });
    expect(ref).toBe("8814689190961342");
  });

  it("extracts from a Braintree body (transaction.id)", () => {
    const extractor = paymentReferenceExtractor();
    const ref = extractor.extract({ transaction: { id: "txn_yyy" } });
    expect(ref).toBe("txn_yyy");
  });

  it("falls back to provider_reference for generic payloads", () => {
    const extractor = paymentReferenceExtractor();
    const ref = extractor.extract({ provider_reference: "generic_ref" });
    expect(ref).toBe("generic_ref");
  });

  it("returns null when no field matches", () => {
    const extractor = paymentReferenceExtractor();
    expect(extractor.extract({ foo: "bar" })).toBeNull();
  });
});

describe("buildPaymentSignalBridge", () => {
  it("defaults to the payment.captured signal", async () => {
    const secretBytes = new Uint8Array(32).fill(7);
    const submitter = new RecordingSubmitter();
    const bridge = buildPaymentSignalBridge({
      engine: submitter,
      secretResolver: fixedSecret(secretBytes),
    });
    const wh = makeWebhook(
      { data: { object: { id: "pi_capture_1" } } },
      secretBytes,
    );
    const outcome = await bridge.handle({
      bodyBytes: wh.body,
      signatureHeader: wh.signatureHeader,
      nowSeconds: Math.floor(Date.now() / 1000),
      tenantId: TENANT,
    });
    expect(outcome.kind).toBe("advanced");
    expect(submitter.calls).toHaveLength(1);
    expect(submitter.calls[0]?.signalName).toBe("payment.captured");
    expect(submitter.calls[0]?.correlationKey).toBe("pi_capture_1");
    expect(submitter.calls[0]?.tenantId).toBe(TENANT);
  });

  it("accepts a custom signal name", async () => {
    const secretBytes = new Uint8Array(32).fill(7);
    const submitter = new RecordingSubmitter();
    const bridge = buildPaymentSignalBridge({
      engine: submitter,
      secretResolver: fixedSecret(secretBytes),
      signalName: PAYMENT_SIGNAL_NAMES.REFUNDED,
    });
    const wh = makeWebhook(
      { data: { object: { id: "ch_refund_1" } } },
      secretBytes,
    );
    await bridge.handle({
      bodyBytes: wh.body,
      signatureHeader: wh.signatureHeader,
      nowSeconds: Math.floor(Date.now() / 1000),
      tenantId: TENANT,
    });
    expect(submitter.calls[0]?.signalName).toBe("payment.refunded");
  });

  it("returns signature_invalid when HMAC fails", async () => {
    const secretBytes = new Uint8Array(32).fill(7);
    const wrongSecret = new Uint8Array(32).fill(9);
    const submitter = new RecordingSubmitter();
    const bridge = buildPaymentSignalBridge({
      engine: submitter,
      secretResolver: fixedSecret(secretBytes),
    });
    const wh = makeWebhook(
      { data: { object: { id: "pi_x" } } },
      wrongSecret,
    );
    const outcome = await bridge.handle({
      bodyBytes: wh.body,
      signatureHeader: wh.signatureHeader,
      nowSeconds: Math.floor(Date.now() / 1000),
      tenantId: TENANT,
    });
    expect(outcome.kind).toBe("signature_invalid");
    expect(submitter.calls).toHaveLength(0);
  });

  it("returns correlation_missing when no reference is present", async () => {
    const secretBytes = new Uint8Array(32).fill(7);
    const submitter = new RecordingSubmitter();
    const bridge = buildPaymentSignalBridge({
      engine: submitter,
      secretResolver: fixedSecret(secretBytes),
    });
    const wh = makeWebhook({ no: "reference" }, secretBytes);
    const outcome = await bridge.handle({
      bodyBytes: wh.body,
      signatureHeader: wh.signatureHeader,
      nowSeconds: Math.floor(Date.now() / 1000),
      tenantId: TENANT,
    });
    expect(outcome.kind).toBe("correlation_missing");
    expect(submitter.calls).toHaveLength(0);
  });
});

describe("buildPaymentBridgesByEvent — multi-signal dispatch", () => {
  it("builds one bridge per provider event type", () => {
    const secretBytes = new Uint8Array(32).fill(7);
    const submitter = new RecordingSubmitter();
    const bridges = buildPaymentBridgesByEvent({
      engine: submitter,
      secretResolver: fixedSecret(secretBytes),
    });
    expect(Object.keys(bridges)).toEqual(Object.keys(PROVIDER_EVENT_SIGNAL_MAP));
  });

  it("dispatching payment_intent.succeeded fires payment.captured", async () => {
    const secretBytes = new Uint8Array(32).fill(7);
    const submitter = new RecordingSubmitter();
    const bridges = buildPaymentBridgesByEvent({
      engine: submitter,
      secretResolver: fixedSecret(secretBytes),
    });
    const wh = makeWebhook(
      { type: "payment_intent.succeeded", data: { object: { id: "pi_capture" } } },
      secretBytes,
    );
    const bridge = bridges["payment_intent.succeeded"]!;
    await bridge.handle({
      bodyBytes: wh.body,
      signatureHeader: wh.signatureHeader,
      nowSeconds: Math.floor(Date.now() / 1000),
      tenantId: TENANT,
    });
    expect(submitter.calls[0]?.signalName).toBe("payment.captured");
  });

  it("dispatching charge.refunded fires payment.refunded", async () => {
    const secretBytes = new Uint8Array(32).fill(7);
    const submitter = new RecordingSubmitter();
    const bridges = buildPaymentBridgesByEvent({
      engine: submitter,
      secretResolver: fixedSecret(secretBytes),
    });
    const wh = makeWebhook(
      { type: "charge.refunded", data: { object: { id: "ch_refund" } } },
      secretBytes,
    );
    const bridge = bridges["charge.refunded"]!;
    await bridge.handle({
      bodyBytes: wh.body,
      signatureHeader: wh.signatureHeader,
      nowSeconds: Math.floor(Date.now() / 1000),
      tenantId: TENANT,
    });
    expect(submitter.calls[0]?.signalName).toBe("payment.refunded");
  });
});

describe("end-to-end: Stripe webhook → workflow signal", () => {
  it("a signed payment_intent.succeeded webhook produces a payment.captured signal on the right Payment instance", async () => {
    const secretBytes = new Uint8Array(32).fill(0x42);
    const submitter = new RecordingSubmitter();
    const bridge = buildPaymentSignalBridge({
      engine: submitter,
      secretResolver: fixedSecret(secretBytes),
    });

    const stripeEvent = {
      id: "evt_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_3ABC123_xyz",
          amount: 5000,
          currency: "usd",
          status: "succeeded",
        },
      },
    };
    const wh = makeWebhook(stripeEvent, secretBytes);

    const outcome = await bridge.handle({
      bodyBytes: wh.body,
      signatureHeader: wh.signatureHeader,
      nowSeconds: Math.floor(Date.now() / 1000),
      tenantId: TENANT,
      sourceSystem: "stripe",
      idempotencyKey: stripeEvent.id,
    });

    expect(outcome.kind).toBe("advanced");
    expect(outcome.matchedInstanceIds).toEqual(["wfi_1"]);
    expect(submitter.calls).toHaveLength(1);
    expect(submitter.calls[0]).toMatchObject({
      signalName: "payment.captured",
      correlationKey: "pi_3ABC123_xyz",
      tenantId: TENANT,
      sourceSystem: "stripe",
      idempotencyKey: "evt_1",
    });
  });
});
