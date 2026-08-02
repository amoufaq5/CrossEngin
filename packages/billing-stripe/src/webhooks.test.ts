import { describe, expect, it } from "vitest";

import {
  computeStripeSignatureHeader,
  parseStripeSignatureHeader,
  verifyStripeWebhook,
} from "./webhooks.js";

const SECRET = "whsec_test_secret_at_least_sixteen_bytes_long";
const PAYLOAD = JSON.stringify({ id: "evt_1", type: "invoice.paid", object: "event" });
const TIMESTAMP = 1_700_000_000;
const NOW = new Date(TIMESTAMP * 1000);

describe("parseStripeSignatureHeader", () => {
  it("extracts the timestamp and all v1 signatures", () => {
    const parsed = parseStripeSignatureHeader("t=123,v1=aaaa,v1=bbbb,v0=cccc");
    expect(parsed.timestamp).toBe(123);
    expect(parsed.signatures).toEqual(["aaaa", "bbbb"]);
  });

  it("nulls the timestamp when absent", () => {
    expect(parseStripeSignatureHeader("v1=aaaa").timestamp).toBeNull();
  });
});

describe("verifyStripeWebhook", () => {
  it("accepts a correctly signed payload and parses the event", () => {
    const header = computeStripeSignatureHeader(PAYLOAD, SECRET, TIMESTAMP);
    const result = verifyStripeWebhook(PAYLOAD, header, SECRET, { now: NOW });
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.event).toMatchObject({ id: "evt_1", type: "invoice.paid" });
  });

  it("accepts when one of several v1 signatures matches", () => {
    const good = computeStripeSignatureHeader(PAYLOAD, SECRET, TIMESTAMP);
    const header = `${good},v1=${"0".repeat(64)}`;
    expect(verifyStripeWebhook(PAYLOAD, header, SECRET, { now: NOW }).valid).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const header = `t=${TIMESTAMP},v1=${"a".repeat(64)}`;
    const result = verifyStripeWebhook(PAYLOAD, header, SECRET, { now: NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects a payload signed with a different secret", () => {
    const header = computeStripeSignatureHeader(PAYLOAD, "whsec_a_totally_different_secret_value", TIMESTAMP);
    const result = verifyStripeWebhook(PAYLOAD, header, SECRET, { now: NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects a tampered payload", () => {
    const header = computeStripeSignatureHeader(PAYLOAD, SECRET, TIMESTAMP);
    const result = verifyStripeWebhook(`${PAYLOAD} `, header, SECRET, { now: NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects a stale timestamp beyond tolerance", () => {
    const header = computeStripeSignatureHeader(PAYLOAD, SECRET, TIMESTAMP);
    const staleNow = new Date((TIMESTAMP + 10_000) * 1000);
    const result = verifyStripeWebhook(PAYLOAD, header, SECRET, { now: staleNow });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_outside_tolerance");
  });

  it("honors a custom tolerance", () => {
    const header = computeStripeSignatureHeader(PAYLOAD, SECRET, TIMESTAMP);
    const laterNow = new Date((TIMESTAMP + 120) * 1000);
    expect(verifyStripeWebhook(PAYLOAD, header, SECRET, { now: laterNow, toleranceSeconds: 60 }).valid).toBe(false);
    expect(verifyStripeWebhook(PAYLOAD, header, SECRET, { now: laterNow, toleranceSeconds: 600 }).valid).toBe(true);
  });

  it("rejects a header with no timestamp or no signature", () => {
    expect(verifyStripeWebhook(PAYLOAD, "v1=aaaa", SECRET, { now: NOW }).reason).toBe("missing_timestamp");
    expect(verifyStripeWebhook(PAYLOAD, `t=${TIMESTAMP}`, SECRET, { now: NOW }).reason).toBe("missing_signature");
  });

  it("reports invalid_event_json when a validly-signed body is not JSON", () => {
    const nonJson = "not-json";
    const header = computeStripeSignatureHeader(nonJson, SECRET, TIMESTAMP);
    const result = verifyStripeWebhook(nonJson, header, SECRET, { now: NOW });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_event_json");
  });
});
