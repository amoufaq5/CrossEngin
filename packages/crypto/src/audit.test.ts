import { describe, expect, it } from "vitest";

import {
  AUTO_AUDITED_OPERATIONS,
  CRYPTO_OPERATIONS,
  CryptoAuditRecordSchema,
  InMemoryAuditSink,
  isAutoAudited,
  isCryptoOperation,
  type CryptoAuditRecord,
} from "./audit.js";

const FIXTURE_RECORD: CryptoAuditRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000002",
  keyId: "key_ed25519_ABCDEFGHJKMNPQRSTVWXYZ0123",
  algorithm: "ed25519",
  purpose: "pack_signing",
  operation: "sign",
  principalId: "00000000-0000-4000-8000-000000000003",
  succeeded: true,
  errorMessage: null,
  durationMs: 5,
  performedAt: "2026-05-16T12:00:00.000Z",
};

describe("CRYPTO_OPERATIONS", () => {
  it("includes nine operations", () => {
    expect(CRYPTO_OPERATIONS).toHaveLength(9);
  });

  it("includes the high-leverage operations", () => {
    expect(CRYPTO_OPERATIONS).toContain("sign");
    expect(CRYPTO_OPERATIONS).toContain("verify");
    expect(CRYPTO_OPERATIONS).toContain("create_key");
    expect(CRYPTO_OPERATIONS).toContain("rotate_key");
    expect(CRYPTO_OPERATIONS).toContain("destroy_key");
  });
});

describe("AUTO_AUDITED_OPERATIONS", () => {
  it("includes create/rotate/destroy", () => {
    expect(AUTO_AUDITED_OPERATIONS.has("create_key")).toBe(true);
    expect(AUTO_AUDITED_OPERATIONS.has("rotate_key")).toBe(true);
    expect(AUTO_AUDITED_OPERATIONS.has("destroy_key")).toBe(true);
  });

  it("does not include hot-path verify or hash operations", () => {
    expect(AUTO_AUDITED_OPERATIONS.has("verify")).toBe(false);
    expect(AUTO_AUDITED_OPERATIONS.has("hash")).toBe(false);
  });
});

describe("isCryptoOperation", () => {
  it("accepts known operations", () => {
    expect(isCryptoOperation("sign")).toBe(true);
    expect(isCryptoOperation("verify")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isCryptoOperation("encrypt")).toBe(false);
    expect(isCryptoOperation(undefined)).toBe(false);
  });
});

describe("isAutoAudited", () => {
  it("returns true for management operations", () => {
    expect(isAutoAudited("create_key")).toBe(true);
  });

  it("returns false for sign/verify", () => {
    expect(isAutoAudited("sign")).toBe(false);
    expect(isAutoAudited("verify")).toBe(false);
  });
});

describe("CryptoAuditRecordSchema", () => {
  it("accepts a well-formed record", () => {
    expect(CryptoAuditRecordSchema.parse(FIXTURE_RECORD)).toBeDefined();
  });

  it("accepts platform-wide records (null tenant)", () => {
    const r = { ...FIXTURE_RECORD, tenantId: null };
    expect(CryptoAuditRecordSchema.parse(r).tenantId).toBeNull();
  });

  it("requires errorMessage when not succeeded", () => {
    const r = { ...FIXTURE_RECORD, succeeded: false, errorMessage: null };
    expect(() => CryptoAuditRecordSchema.parse(r)).toThrow();
  });

  it("rejects errorMessage when succeeded", () => {
    const r = { ...FIXTURE_RECORD, succeeded: true, errorMessage: "should not be here" };
    expect(() => CryptoAuditRecordSchema.parse(r)).toThrow();
  });

  it("rejects negative durationMs", () => {
    const r = { ...FIXTURE_RECORD, durationMs: -1 };
    expect(() => CryptoAuditRecordSchema.parse(r)).toThrow();
  });

  it("rejects invalid keyId shape", () => {
    const r = { ...FIXTURE_RECORD, keyId: "key_md5_AAA" };
    expect(() => CryptoAuditRecordSchema.parse(r)).toThrow();
  });

  it("rejects non-RFC3339 timestamp", () => {
    const r = { ...FIXTURE_RECORD, performedAt: "yesterday" };
    expect(() => CryptoAuditRecordSchema.parse(r)).toThrow();
  });

  it("rejects unknown operation values", () => {
    const r = { ...FIXTURE_RECORD, operation: "encrypt" as never };
    expect(() => CryptoAuditRecordSchema.parse(r)).toThrow();
  });
});

describe("InMemoryAuditSink", () => {
  it("records validated entries", () => {
    const sink = new InMemoryAuditSink();
    sink.record(FIXTURE_RECORD);
    expect(sink.count()).toBe(1);
    expect(sink.list()[0]).toEqual(FIXTURE_RECORD);
  });

  it("rejects malformed entries on record", () => {
    const sink = new InMemoryAuditSink();
    expect(() =>
      sink.record({ ...FIXTURE_RECORD, succeeded: false, errorMessage: null }),
    ).toThrow();
  });

  it("clears entries on demand", () => {
    const sink = new InMemoryAuditSink();
    sink.record(FIXTURE_RECORD);
    sink.clear();
    expect(sink.count()).toBe(0);
  });
});
