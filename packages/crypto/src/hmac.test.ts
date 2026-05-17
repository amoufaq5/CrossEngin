import { describe, expect, it } from "vitest";

import {
  generateHmacKey,
  hmacSha256Hex,
  parseWebhookSignatureHeader,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./hmac.js";

const FIXED_KEY = new Uint8Array(32).fill(0xab);

describe("hmacSha256Hex", () => {
  it("produces 64-char lowercase hex", () => {
    const out = hmacSha256Hex(FIXED_KEY, "message");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs", () => {
    expect(hmacSha256Hex(FIXED_KEY, "x")).toBe(hmacSha256Hex(FIXED_KEY, "x"));
  });

  it("produces different output for different keys", () => {
    const key2 = new Uint8Array(32).fill(0xcd);
    expect(hmacSha256Hex(FIXED_KEY, "x")).not.toBe(hmacSha256Hex(key2, "x"));
  });

  it("rejects keys shorter than 16 bytes", () => {
    const short = new Uint8Array(8);
    expect(() => hmacSha256Hex(short, "x")).toThrow(/HMAC key/);
  });
});

describe("generateHmacKey", () => {
  it("returns 32 random bytes by default", () => {
    const key = generateHmacKey();
    expect(key.length).toBe(32);
  });

  it("accepts a custom length", () => {
    const key = generateHmacKey(64);
    expect(key.length).toBe(64);
  });

  it("rejects out-of-range lengths", () => {
    expect(() => generateHmacKey(8)).toThrow(/HMAC key length/);
    expect(() => generateHmacKey(128)).toThrow(/HMAC key length/);
  });

  it("produces unique values per call", () => {
    const a = Buffer.from(generateHmacKey()).toString("hex");
    const b = Buffer.from(generateHmacKey()).toString("hex");
    expect(a).not.toBe(b);
  });
});

describe("signWebhookPayload", () => {
  it("produces the documented header shape", () => {
    const signed = signWebhookPayload(FIXED_KEY, '{"event":"x"}', 1_700_000_000);
    expect(signed.header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(signed.timestampSeconds).toBe(1_700_000_000);
    expect(signed.signatureHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects non-positive timestamps", () => {
    expect(() => signWebhookPayload(FIXED_KEY, "x", 0)).toThrow(/timestamp/);
    expect(() => signWebhookPayload(FIXED_KEY, "x", -1)).toThrow(/timestamp/);
  });

  it("is deterministic", () => {
    const a = signWebhookPayload(FIXED_KEY, "body", 1700);
    const b = signWebhookPayload(FIXED_KEY, "body", 1700);
    expect(a.header).toBe(b.header);
  });

  it("produces different signatures for different timestamps (binds against replay)", () => {
    const a = signWebhookPayload(FIXED_KEY, "body", 1700);
    const b = signWebhookPayload(FIXED_KEY, "body", 1701);
    expect(a.signatureHex).not.toBe(b.signatureHex);
  });
});

describe("parseWebhookSignatureHeader", () => {
  it("parses a valid header", () => {
    const sig = "a".repeat(64);
    const parsed = parseWebhookSignatureHeader(`t=1234567890,v1=${sig}`);
    expect(parsed?.timestampSeconds).toBe(1_234_567_890);
    expect(parsed?.signatureHex).toBe(sig);
  });

  it("rejects a missing v1 part", () => {
    expect(parseWebhookSignatureHeader("t=1234567890")).toBeNull();
  });

  it("rejects a wrong-length signature", () => {
    expect(parseWebhookSignatureHeader("t=1,v1=abc")).toBeNull();
  });

  it("rejects an uppercase signature", () => {
    const sig = "A".repeat(64);
    expect(parseWebhookSignatureHeader(`t=1,v1=${sig}`)).toBeNull();
  });

  it("rejects a non-numeric timestamp", () => {
    expect(parseWebhookSignatureHeader(`t=xx,v1=${"a".repeat(64)}`)).toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a freshly signed payload", () => {
    const ts = 1_700_000_000;
    const signed = signWebhookPayload(FIXED_KEY, "body", ts);
    const result = verifyWebhookSignature(FIXED_KEY, "body", signed.header, {
      toleranceSeconds: 300,
      nowSeconds: ts + 5,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed header", () => {
    const result = verifyWebhookSignature(FIXED_KEY, "body", "garbage", {
      toleranceSeconds: 300,
      nowSeconds: 1_700_000_000,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("rejects an old timestamp (replay)", () => {
    const ts = 1_700_000_000;
    const signed = signWebhookPayload(FIXED_KEY, "body", ts);
    const result = verifyWebhookSignature(FIXED_KEY, "body", signed.header, {
      toleranceSeconds: 60,
      nowSeconds: ts + 3_600,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
  });

  it("rejects a future timestamp outside tolerance", () => {
    const ts = 1_700_000_000;
    const signed = signWebhookPayload(FIXED_KEY, "body", ts);
    const result = verifyWebhookSignature(FIXED_KEY, "body", signed.header, {
      toleranceSeconds: 60,
      nowSeconds: ts - 3_600,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
  });

  it("rejects a tampered body", () => {
    const ts = 1_700_000_000;
    const signed = signWebhookPayload(FIXED_KEY, "body", ts);
    const result = verifyWebhookSignature(FIXED_KEY, "tampered", signed.header, {
      toleranceSeconds: 60,
      nowSeconds: ts,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a different key", () => {
    const ts = 1_700_000_000;
    const signed = signWebhookPayload(FIXED_KEY, "body", ts);
    const otherKey = new Uint8Array(32).fill(0x77);
    const result = verifyWebhookSignature(otherKey, "body", signed.header, {
      toleranceSeconds: 60,
      nowSeconds: ts,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});
