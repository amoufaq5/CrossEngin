import { createHash, hkdfSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AI_TENANT_PSEUDONYM_BYTES,
  AI_TENANT_PSEUDONYM_DERIVATION_INFO,
  AI_TENANT_PSEUDONYM_PREFIX,
  COLUMN_KEY_DERIVATION_INFO,
  CURSOR_KEY_DERIVATION_INFO,
  ColumnSecretRefused,
  KEK_KEY_DERIVATION_INFO,
  REQUEST_SIGNING_KEY_DERIVATION_INFO,
  deriveAiTenantPseudonym,
  deriveTenantCursorKey,
  parseCursorEncryptionSecret,
} from "./key-derivation.js";

const SECRET_TEXT = "crossengin-column-secret-0123456789abcdef";
const SECRET = parseCursorEncryptionSecret(SECRET_TEXT);
const OTHER_SECRET = parseCursorEncryptionSecret("a-different-deployment-secret-ABCDEFGHIJKL");
const TENANT = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7b";
const OTHER_TENANT = "0196f2a8-7c3b-7d4e-9a1b-2c3d4e5f6a7c";
const SHAPE = /^ctp_[0-9a-f]{32}$/;

describe("deriveAiTenantPseudonym", () => {
  it("pins its own info label, distinct from every other derivation's", () => {
    expect(AI_TENANT_PSEUDONYM_DERIVATION_INFO).toBe("crossengin.ai-tenant-pseudonym.v1");
    expect(
      new Set([
        COLUMN_KEY_DERIVATION_INFO,
        CURSOR_KEY_DERIVATION_INFO,
        KEK_KEY_DERIVATION_INFO,
        REQUEST_SIGNING_KEY_DERIVATION_INFO,
        AI_TENANT_PSEUDONYM_DERIVATION_INFO,
      ]).size,
    ).toBe(5);
    expect(AI_TENANT_PSEUDONYM_PREFIX).toBe("ctp_");
    expect(AI_TENANT_PSEUDONYM_BYTES).toBe(16);
  });

  it("is ctp_ plus 32 lowercase hex, 36 characters", () => {
    const p = deriveAiTenantPseudonym(SECRET, TENANT);
    expect(p).toMatch(SHAPE);
    expect(p).toHaveLength(36);
  });

  it("matches HKDF-SHA256 computed independently, and a pinned known answer", () => {
    const expected = Buffer.from(
      hkdfSync(
        "sha256",
        new TextEncoder().encode(SECRET_TEXT),
        new TextEncoder().encode(TENANT),
        new TextEncoder().encode("crossengin.ai-tenant-pseudonym.v1"),
        16,
      ),
    ).toString("hex");
    expect(deriveAiTenantPseudonym(SECRET, TENANT)).toBe(`ctp_${expected}`);
    // Pinned as a literal too: changing the derivation silently would give every tenant a new
    // identity at the provider and orphan its abuse history, which should be a deliberate edit.
    expect(deriveAiTenantPseudonym(SECRET, TENANT)).toBe("ctp_f045990d8518bdda4f768266de4316b6");
  });

  it("is stable for one tenant and distinct across tenants and across deployments", () => {
    expect(deriveAiTenantPseudonym(SECRET, TENANT)).toBe(deriveAiTenantPseudonym(SECRET, TENANT));
    expect(deriveAiTenantPseudonym(SECRET, TENANT)).not.toBe(
      deriveAiTenantPseudonym(SECRET, OTHER_TENANT),
    );
    expect(deriveAiTenantPseudonym(SECRET, TENANT)).not.toBe(
      deriveAiTenantPseudonym(OTHER_SECRET, TENANT),
    );
  });

  it("contains no part of the tenant id and is not an unkeyed digest of it", () => {
    const p = deriveAiTenantPseudonym(SECRET, TENANT);
    expect(p).not.toContain(TENANT);
    expect(p).not.toContain(TENANT.replaceAll("-", ""));
    for (const group of TENANT.split("-")) expect(p).not.toContain(group);
    // The guessable construction a provider could reproduce from a candidate id.
    const unkeyed = createHash("sha256").update(TENANT).digest("hex");
    expect(p.slice(4)).not.toBe(unkeyed.slice(0, 32));
  });

  it("does not disclose the cursor key derived from the same secret for the same tenant", () => {
    const cursorHex = Buffer.from(deriveTenantCursorKey(SECRET, TENANT)).toString("hex");
    expect(cursorHex).not.toContain(deriveAiTenantPseudonym(SECRET, TENANT).slice(4));
  });

  it("refuses an empty tenant id rather than salting with nothing", () => {
    expect(() => deriveAiTenantPseudonym(SECRET, "")).toThrow(/tenantId must be non-empty/);
  });

  it("refuses a weak secret naming the variable, and never echoes the secret", () => {
    const weak = new TextEncoder().encode("zzzz");
    let caught: unknown;
    try {
      deriveAiTenantPseudonym(weak, TENANT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ColumnSecretRefused);
    expect((caught as Error).message).toContain("CURSOR_ENCRYPTION_SECRET");
    expect((caught as Error).message).not.toContain("zzzz");
  });
});
