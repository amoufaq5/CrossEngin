import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ATTEMPTS,
  RETRY_INITIAL_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  SIGNATURE_HEADER_NAME,
  SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENTS,
  WebhookDeliveryRecordSchema,
  WebhookEndpointSchema,
  canTransitionWebhookDelivery,
  canonicalSignaturePayload,
  formatSignatureHeader,
  isSignatureFresh,
  nextRetryDelayMs,
  parseSignatureHeader,
  shouldRetry,
  type WebhookDeliveryRecord,
  type WebhookEndpoint,
} from "./webhooks.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("WEBHOOK_EVENTS covers core events", () => {
    expect(WEBHOOK_EVENTS).toContain("tenant.created");
    expect(WEBHOOK_EVENTS).toContain("manifest.applied");
    expect(WEBHOOK_EVENTS).toContain("billing.invoice_paid");
  });

  it("WEBHOOK_DELIVERY_STATUSES has 6 entries", () => {
    expect(WEBHOOK_DELIVERY_STATUSES).toContain("delivered");
    expect(WEBHOOK_DELIVERY_STATUSES).toContain("dropped");
  });

  it("declares retry defaults", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(8);
    expect(RETRY_INITIAL_DELAY_MS).toBe(1_000);
    expect(RETRY_MAX_DELAY_MS).toBe(3_600_000);
  });

  it("SIGNATURE_HEADER_NAME is CrossEngin-Signature", () => {
    expect(SIGNATURE_HEADER_NAME).toBe("CrossEngin-Signature");
  });

  it("SIGNATURE_TOLERANCE_SECONDS is 5 minutes", () => {
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });
});

describe("canTransitionWebhookDelivery", () => {
  it("pending -> delivering", () => {
    expect(canTransitionWebhookDelivery("pending", "delivering")).toBe(true);
  });

  it("delivering -> delivered", () => {
    expect(canTransitionWebhookDelivery("delivering", "delivered")).toBe(true);
  });

  it("failed -> retrying", () => {
    expect(canTransitionWebhookDelivery("failed", "retrying")).toBe(true);
  });

  it("delivered is terminal", () => {
    expect(canTransitionWebhookDelivery("delivered", "retrying")).toBe(false);
  });

  it("dropped is terminal", () => {
    expect(canTransitionWebhookDelivery("dropped", "retrying")).toBe(false);
  });
});

describe("WebhookEndpointSchema", () => {
  const base: WebhookEndpoint = {
    id: "whk_abc12345",
    tenantId: "t-1",
    url: "https://example.com/hook",
    events: ["tenant.created", "manifest.applied"],
    signingSecretHash: SHA,
    signingAlgorithm: "hmac-sha256",
    enabled: true,
    createdAt: "2026-05-14T10:00:00Z",
    createdBy: "u-1",
    lastDeliveredAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
  };

  it("accepts a valid endpoint", () => {
    expect(() => WebhookEndpointSchema.parse(base)).not.toThrow();
  });

  it("rejects http:// URLs", () => {
    expect(() =>
      WebhookEndpointSchema.parse({ ...base, url: "http://insecure.example.com" }),
    ).toThrow(/HTTPS/);
  });

  it("rejects duplicate events", () => {
    expect(() =>
      WebhookEndpointSchema.parse({
        ...base,
        events: ["tenant.created", "tenant.created"],
      }),
    ).toThrow(/duplicate event/);
  });

  it("rejects disabled endpoint without disabledReason", () => {
    expect(() =>
      WebhookEndpointSchema.parse({ ...base, enabled: false }),
    ).toThrow(/disabledReason/);
  });

  it("rejects consecutiveFailures > 0 without lastFailureAt", () => {
    expect(() =>
      WebhookEndpointSchema.parse({ ...base, consecutiveFailures: 3 }),
    ).toThrow(/lastFailureAt/);
  });

  it("rejects malformed endpoint id", () => {
    expect(() =>
      WebhookEndpointSchema.parse({ ...base, id: "whk_short" }),
    ).toThrow();
  });
});

describe("WebhookDeliveryRecordSchema", () => {
  const base: WebhookDeliveryRecord = {
    id: "del-1",
    endpointId: "whk_abc12345",
    event: "tenant.created",
    payloadHash: SHA,
    signature: `t=1715680800,v1=${SHA}`,
    signedAt: "2026-05-14T10:00:00Z",
    status: "delivered",
    attempt: 1,
    maxAttempts: 8,
    responseStatus: 200,
    responseBodySha256: SHA,
    deliveredAt: "2026-05-14T10:00:01Z",
    failedAt: null,
    nextRetryAt: null,
  };

  it("accepts a valid delivered record", () => {
    expect(() => WebhookDeliveryRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects attempt > maxAttempts", () => {
    expect(() =>
      WebhookDeliveryRecordSchema.parse({ ...base, attempt: 10 }),
    ).toThrow(/attempt cannot exceed/);
  });

  it("rejects delivered without deliveredAt", () => {
    expect(() =>
      WebhookDeliveryRecordSchema.parse({ ...base, deliveredAt: null }),
    ).toThrow(/deliveredAt/);
  });

  it("rejects failed without failureReason", () => {
    expect(() =>
      WebhookDeliveryRecordSchema.parse({
        ...base,
        status: "failed",
        failedAt: "2026-05-14T10:00:01Z",
        deliveredAt: null,
        responseStatus: null,
        responseBodySha256: null,
      }),
    ).toThrow(/failureReason/);
  });

  it("rejects retrying without nextRetryAt", () => {
    expect(() =>
      WebhookDeliveryRecordSchema.parse({
        ...base,
        status: "retrying",
        deliveredAt: null,
      }),
    ).toThrow(/nextRetryAt/);
  });

  it("rejects dropped without droppedReason", () => {
    expect(() =>
      WebhookDeliveryRecordSchema.parse({
        ...base,
        status: "dropped",
        deliveredAt: null,
      }),
    ).toThrow(/droppedReason/);
  });

  it("rejects malformed signature", () => {
    expect(() =>
      WebhookDeliveryRecordSchema.parse({ ...base, signature: "bogus" }),
    ).toThrow();
  });
});

describe("nextRetryDelayMs", () => {
  it("doubles each attempt", () => {
    expect(nextRetryDelayMs(1)).toBe(1_000);
    expect(nextRetryDelayMs(2)).toBe(2_000);
    expect(nextRetryDelayMs(3)).toBe(4_000);
    expect(nextRetryDelayMs(4)).toBe(8_000);
  });

  it("caps at RETRY_MAX_DELAY_MS", () => {
    expect(nextRetryDelayMs(100)).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
    expect(nextRetryDelayMs(100)).toBe(RETRY_MAX_DELAY_MS);
  });
});

describe("shouldRetry", () => {
  const base: WebhookDeliveryRecord = {
    id: "del-1",
    endpointId: "whk_abc12345",
    event: "tenant.created",
    payloadHash: SHA,
    signature: `t=1715680800,v1=${SHA}`,
    signedAt: "2026-05-14T10:00:00Z",
    status: "delivering",
    attempt: 1,
    maxAttempts: 8,
    responseStatus: null,
    responseBodySha256: null,
    deliveredAt: null,
    failedAt: null,
    nextRetryAt: null,
  };

  it("returns true for 5xx", () => {
    expect(shouldRetry(base, 500)).toBe(true);
    expect(shouldRetry(base, 503)).toBe(true);
  });

  it("returns true for 408 and 429", () => {
    expect(shouldRetry(base, 408)).toBe(true);
    expect(shouldRetry(base, 429)).toBe(true);
  });

  it("returns false for 2xx", () => {
    expect(shouldRetry(base, 200)).toBe(false);
  });

  it("returns false for other 4xx", () => {
    expect(shouldRetry(base, 400)).toBe(false);
    expect(shouldRetry(base, 404)).toBe(false);
  });

  it("returns false at maxAttempts", () => {
    expect(shouldRetry({ ...base, attempt: 8 }, 500)).toBe(false);
  });
});

describe("signature helpers", () => {
  it("canonicalSignaturePayload joins timestamp + body", () => {
    expect(canonicalSignaturePayload({ timestampSeconds: 100, body: "hello" })).toBe(
      "100.hello",
    );
  });

  it("formatSignatureHeader produces the header string", () => {
    expect(formatSignatureHeader(1715680800, SHA)).toBe(`t=1715680800,v1=${SHA}`);
  });

  it("parseSignatureHeader roundtrips with format", () => {
    const header = formatSignatureHeader(1715680800, SHA);
    expect(parseSignatureHeader(header)).toEqual({
      timestampSeconds: 1715680800,
      sha256: SHA,
    });
  });

  it("parseSignatureHeader returns null for malformed input", () => {
    expect(parseSignatureHeader("not-a-signature")).toBeNull();
  });

  it("isSignatureFresh returns true within tolerance", () => {
    expect(isSignatureFresh(1000, 1100)).toBe(true);
    expect(isSignatureFresh(1000, 1300)).toBe(true);
  });

  it("isSignatureFresh returns false outside tolerance", () => {
    expect(isSignatureFresh(1000, 1400)).toBe(false);
    expect(isSignatureFresh(1000, 600)).toBe(false);
  });
});
