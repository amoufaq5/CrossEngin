import { describe, expect, it } from "vitest";

import {
  KeyHandleSchema,
  assertHandleTenant,
  generateKeyId,
  isKeyId,
  parseKeyHandle,
  parseKeyIdAlgorithm,
  serializeKeyHandle,
  withRotatedVersion,
  type KeyHandle,
} from "./key-handles.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";

function fixtureHandle(overrides: Partial<KeyHandle> = {}): KeyHandle {
  return {
    id: generateKeyId("ed25519"),
    tenantId: TENANT_A,
    algorithm: "ed25519",
    purpose: "pack_signing",
    version: 1,
    ...overrides,
  };
}

describe("generateKeyId", () => {
  it("uses the key_<algorithm>_<26 base32> shape", () => {
    const id = generateKeyId("ed25519");
    expect(id).toMatch(/^key_ed25519_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("supports hmac-sha256", () => {
    expect(generateKeyId("hmac-sha256")).toMatch(/^key_hmac-sha256_/);
  });

  it("returns unique ids", () => {
    const a = generateKeyId("ed25519");
    const b = generateKeyId("ed25519");
    expect(a).not.toBe(b);
  });
});

describe("isKeyId", () => {
  it("accepts valid ids", () => {
    expect(isKeyId(generateKeyId("ed25519"))).toBe(true);
    expect(isKeyId(generateKeyId("hmac-sha256"))).toBe(true);
  });

  it("rejects missing prefix", () => {
    expect(isKeyId("ed25519_AAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });

  it("rejects lowercase suffix (Crockford base32 is uppercase)", () => {
    expect(isKeyId("key_ed25519_" + "a".repeat(26))).toBe(false);
  });

  it("rejects wrong-length suffix", () => {
    expect(isKeyId("key_ed25519_" + "A".repeat(25))).toBe(false);
  });

  it("rejects unsupported algorithms", () => {
    expect(isKeyId("key_md5_" + "A".repeat(26))).toBe(false);
  });
});

describe("parseKeyIdAlgorithm", () => {
  it("extracts ed25519", () => {
    const id = generateKeyId("ed25519");
    expect(parseKeyIdAlgorithm(id)).toBe("ed25519");
  });

  it("extracts hmac-sha256", () => {
    const id = generateKeyId("hmac-sha256");
    expect(parseKeyIdAlgorithm(id)).toBe("hmac-sha256");
  });

  it("returns null for invalid ids", () => {
    expect(parseKeyIdAlgorithm("not-a-key-id")).toBeNull();
  });
});

describe("KeyHandleSchema", () => {
  it("accepts a well-formed handle", () => {
    const handle = fixtureHandle();
    expect(KeyHandleSchema.parse(handle)).toEqual(handle);
  });

  it("accepts a platform handle (tenantId = null)", () => {
    const handle = fixtureHandle({ tenantId: null });
    expect(KeyHandleSchema.parse(handle).tenantId).toBeNull();
  });

  it("rejects an invalid algorithm", () => {
    expect(() => KeyHandleSchema.parse(fixtureHandle({ algorithm: "rsa" as never }))).toThrow();
  });

  it("rejects a zero or negative version", () => {
    expect(() => KeyHandleSchema.parse(fixtureHandle({ version: 0 }))).toThrow();
    expect(() => KeyHandleSchema.parse(fixtureHandle({ version: -1 }))).toThrow();
  });

  it("rejects an invalid uuid tenantId", () => {
    expect(() => KeyHandleSchema.parse(fixtureHandle({ tenantId: "not-a-uuid" }))).toThrow();
  });
});

describe("serializeKeyHandle / parseKeyHandle", () => {
  it("roundtrips a handle", () => {
    const handle = fixtureHandle();
    expect(parseKeyHandle(serializeKeyHandle(handle))).toEqual(handle);
  });

  it("produces base64", () => {
    const handle = fixtureHandle();
    expect(serializeKeyHandle(handle)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("rejects non-base64 input", () => {
    expect(() => parseKeyHandle("not!base64!")).toThrow(/base64/);
  });

  it("rejects non-JSON content", () => {
    const garbage = Buffer.from("garbage").toString("base64");
    expect(() => parseKeyHandle(garbage)).toThrow();
  });

  it("rejects handles failing schema validation", () => {
    const bad = Buffer.from(JSON.stringify({ id: "x" }), "utf8").toString("base64");
    expect(() => parseKeyHandle(bad)).toThrow();
  });
});

describe("assertHandleTenant", () => {
  it("passes when tenantIds match", () => {
    const handle = fixtureHandle();
    expect(() => assertHandleTenant(handle, TENANT_A)).not.toThrow();
  });

  it("throws on mismatch", () => {
    const handle = fixtureHandle();
    expect(() => assertHandleTenant(handle, TENANT_B)).toThrow(/belongs to tenant/);
  });

  it("treats null-tenant handles as platform-wide (any caller passes)", () => {
    const handle = fixtureHandle({ tenantId: null });
    expect(() => assertHandleTenant(handle, TENANT_A)).not.toThrow();
    expect(() => assertHandleTenant(handle, null)).not.toThrow();
  });

  it("throws when caller passes null for a tenant-scoped handle", () => {
    const handle = fixtureHandle();
    expect(() => assertHandleTenant(handle, null)).toThrow(/belongs to tenant/);
  });
});

describe("withRotatedVersion", () => {
  it("bumps version and changes id", () => {
    const handle = fixtureHandle();
    const next = withRotatedVersion(handle);
    expect(next.version).toBe(handle.version + 1);
    expect(next.id).not.toBe(handle.id);
    expect(next.algorithm).toBe(handle.algorithm);
    expect(next.tenantId).toBe(handle.tenantId);
    expect(next.purpose).toBe(handle.purpose);
  });
});
