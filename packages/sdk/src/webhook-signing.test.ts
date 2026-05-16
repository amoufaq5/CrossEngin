import { InMemoryKeyStore } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { SIGNATURE_HEADER_NAME } from "./webhooks.js";
import {
  extractSignatureFromHeaders,
  generateWebhookSecret,
  hashWebhookSecret,
  isParsedSignatureFresh,
  signWebhookDelivery,
  signWebhookDeliveryWithStore,
  verifyWebhookDelivery,
} from "./webhook-signing.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const FIXED_SECRET = new Uint8Array(32).fill(0xab);

describe("generateWebhookSecret", () => {
  it("returns 32 random bytes", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("hashWebhookSecret", () => {
  it("returns 64-char hex", () => {
    expect(hashWebhookSecret(FIXED_SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same secret", () => {
    expect(hashWebhookSecret(FIXED_SECRET)).toBe(hashWebhookSecret(FIXED_SECRET));
  });

  it("differs for different secrets", () => {
    const other = new Uint8Array(32).fill(0xcd);
    expect(hashWebhookSecret(FIXED_SECRET)).not.toBe(hashWebhookSecret(other));
  });
});

describe("signWebhookDelivery", () => {
  it("produces the documented header shape", () => {
    const ts = 1_700_000_000;
    const result = signWebhookDelivery({
      secretBytes: FIXED_SECRET,
      body: '{"event":"x"}',
      timestampSeconds: ts,
    });
    expect(result.signatureHeader).toBe(SIGNATURE_HEADER_NAME);
    expect(result.signatureValue).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(result.timestampSeconds).toBe(ts);
    expect(result.headers[SIGNATURE_HEADER_NAME]).toBe(result.signatureValue);
  });

  it("is deterministic", () => {
    const a = signWebhookDelivery({ secretBytes: FIXED_SECRET, body: "x", timestampSeconds: 1 });
    const b = signWebhookDelivery({ secretBytes: FIXED_SECRET, body: "x", timestampSeconds: 1 });
    expect(a.signatureValue).toBe(b.signatureValue);
  });
});

describe("verifyWebhookDelivery", () => {
  it("accepts a freshly signed payload", () => {
    const ts = 1_700_000_000;
    const signed = signWebhookDelivery({
      secretBytes: FIXED_SECRET,
      body: "body",
      timestampSeconds: ts,
    });
    const result = verifyWebhookDelivery({
      secretBytes: FIXED_SECRET,
      body: "body",
      signatureHeader: signed.signatureValue,
      opts: { nowSeconds: ts + 5 },
    });
    expect(result.ok).toBe(true);
  });

  it("uses the default 300s tolerance when not specified", () => {
    const ts = 1_700_000_000;
    const signed = signWebhookDelivery({
      secretBytes: FIXED_SECRET,
      body: "body",
      timestampSeconds: ts,
    });
    const fresh = verifyWebhookDelivery({
      secretBytes: FIXED_SECRET,
      body: "body",
      signatureHeader: signed.signatureValue,
      opts: { nowSeconds: ts + 299 },
    });
    expect(fresh.ok).toBe(true);
    const stale = verifyWebhookDelivery({
      secretBytes: FIXED_SECRET,
      body: "body",
      signatureHeader: signed.signatureValue,
      opts: { nowSeconds: ts + 600 },
    });
    expect(stale).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
  });

  it("rejects a tampered body", () => {
    const ts = 1_700_000_000;
    const signed = signWebhookDelivery({
      secretBytes: FIXED_SECRET,
      body: "body",
      timestampSeconds: ts,
    });
    const result = verifyWebhookDelivery({
      secretBytes: FIXED_SECRET,
      body: "tampered",
      signatureHeader: signed.signatureValue,
      opts: { nowSeconds: ts },
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a wrong secret", () => {
    const ts = 1_700_000_000;
    const signed = signWebhookDelivery({
      secretBytes: FIXED_SECRET,
      body: "body",
      timestampSeconds: ts,
    });
    const result = verifyWebhookDelivery({
      secretBytes: new Uint8Array(32).fill(0x99),
      body: "body",
      signatureHeader: signed.signatureValue,
      opts: { nowSeconds: ts },
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});

describe("signWebhookDeliveryWithStore", () => {
  it("round-trips through verifyWebhookDelivery using a store-managed key", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    const ts = 1_700_000_000;
    const signed = await signWebhookDeliveryWithStore({
      store,
      handle: record.handle,
      tenantId: TENANT,
      body: "body",
      timestampSeconds: ts,
    });
    expect(signed.signatureValue).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(signed.headers[SIGNATURE_HEADER_NAME]).toBe(signed.signatureValue);
  });

  it("rejects wrong-algorithm keys", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await expect(
      signWebhookDeliveryWithStore({
        store,
        handle: record.handle,
        tenantId: TENANT,
        body: "body",
        timestampSeconds: 1,
      }),
    ).rejects.toThrow(/hmac-sha256/);
  });

  it("rejects cross-tenant signing", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    await expect(
      signWebhookDeliveryWithStore({
        store,
        handle: record.handle,
        tenantId: "00000000-0000-4000-8000-000000000002",
        body: "body",
        timestampSeconds: 1,
      }),
    ).rejects.toThrow(/tenant/);
  });

  it("rejects non-positive timestamps", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    await expect(
      signWebhookDeliveryWithStore({
        store,
        handle: record.handle,
        tenantId: TENANT,
        body: "body",
        timestampSeconds: 0,
      }),
    ).rejects.toThrow(/timestamp/);
  });
});

describe("isParsedSignatureFresh", () => {
  it("returns true within 300s default tolerance", () => {
    expect(isParsedSignatureFresh(1_700_000_000, 1_700_000_100)).toBe(true);
  });

  it("returns false outside default tolerance", () => {
    expect(isParsedSignatureFresh(1_700_000_000, 1_700_001_000)).toBe(false);
  });

  it("respects a custom tolerance", () => {
    expect(isParsedSignatureFresh(1_700_000_000, 1_700_000_059, 60)).toBe(true);
    expect(isParsedSignatureFresh(1_700_000_000, 1_700_000_061, 60)).toBe(false);
  });
});

describe("extractSignatureFromHeaders", () => {
  it("reads the canonical header name", () => {
    const headers = { [SIGNATURE_HEADER_NAME]: `t=1,v1=${"a".repeat(64)}` };
    const parsed = extractSignatureFromHeaders(headers);
    expect(parsed?.timestampSeconds).toBe(1);
    expect(parsed?.sha256).toBe("a".repeat(64));
  });

  it("falls back to lowercase header name", () => {
    const headers = { [SIGNATURE_HEADER_NAME.toLowerCase()]: `t=1,v1=${"b".repeat(64)}` };
    const parsed = extractSignatureFromHeaders(headers);
    expect(parsed?.sha256).toBe("b".repeat(64));
  });

  it("returns null when absent", () => {
    expect(extractSignatureFromHeaders({})).toBeNull();
  });

  it("returns null when malformed", () => {
    const headers = { [SIGNATURE_HEADER_NAME]: "garbage" };
    expect(extractSignatureFromHeaders(headers)).toBeNull();
  });
});
