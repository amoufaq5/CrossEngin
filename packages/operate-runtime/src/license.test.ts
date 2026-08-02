import { generateEd25519Keypair, signEd25519 } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import {
  type LicenseClaims,
  LicenseEntitlementResolver,
  b64urlDecode,
  b64urlEncode,
  canonicalJson,
  parseLicenseToken,
  signLicense,
  verifyLicense,
} from "./license.js";

const CLOCK = { now: () => new Date("2026-06-01T00:00:00.000Z") };

function baseClaims(overrides: Partial<LicenseClaims> = {}): LicenseClaims {
  return {
    tenantId: "tenant-abc",
    status: "active",
    planId: "enterprise",
    features: ["sso", "audit"],
    maxRecordsPerEntity: 100000,
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("sorts object keys deterministically regardless of construction order", () => {
    const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it("preserves array order", () => {
    expect(canonicalJson({ f: [3, 1, 2] })).toBe('{"f":[3,1,2]}');
  });
});

describe("b64url", () => {
  it("round-trips arbitrary UTF-8", () => {
    const s = '{"a":1,"emoji":"✅","slash":"a/b+c"}';
    const enc = b64urlEncode(s);
    expect(enc).not.toMatch(/[+/=]/);
    expect(b64urlDecode(enc)).toBe(s);
  });

  it("returns null on invalid characters", () => {
    expect(b64urlDecode("not valid!!")).toBeNull();
  });
});

describe("parseLicenseToken", () => {
  it("splits a well-formed token", () => {
    expect(parseLicenseToken("abc.def")).toEqual({ payload: "abc", signature: "def" });
  });

  it("returns null when malformed", () => {
    expect(parseLicenseToken("nodot")).toBeNull();
    expect(parseLicenseToken(".def")).toBeNull();
    expect(parseLicenseToken("abc.")).toBeNull();
    expect(parseLicenseToken("")).toBeNull();
  });
});

describe("signLicense / verifyLicense", () => {
  it("round-trips a valid license with the right claims", () => {
    const kp = generateEd25519Keypair();
    const claims = baseClaims();
    const token = signLicense(kp.privateKeyBase64, kp.publicKeyBase64, claims);

    const result = verifyLicense(token, kp.publicKeyBase64, CLOCK.now());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims).toEqual(claims);
    }
  });

  it("rejects a tampered payload as bad_signature", () => {
    const kp = generateEd25519Keypair();
    const token = signLicense(kp.privateKeyBase64, kp.publicKeyBase64, baseClaims());
    const parsed = parseLicenseToken(token)!;
    // Flip a character in the payload.
    const flipped = (parsed.payload[0] === "a" ? "b" : "a") + parsed.payload.slice(1);
    const tampered = `${flipped}.${parsed.signature}`;

    const result = verifyLicense(tampered, kp.publicKeyBase64, CLOCK.now());
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects verification with the wrong public key", () => {
    const kp = generateEd25519Keypair();
    const other = generateEd25519Keypair();
    const token = signLicense(kp.privateKeyBase64, kp.publicKeyBase64, baseClaims());

    const result = verifyLicense(token, other.publicKeyBase64, CLOCK.now());
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects an expired license", () => {
    const kp = generateEd25519Keypair();
    const token = signLicense(
      kp.privateKeyBase64,
      kp.publicKeyBase64,
      baseClaims({ expiresAt: "2026-05-01T00:00:00.000Z" }),
    );

    const result = verifyLicense(token, kp.publicKeyBase64, CLOCK.now());
    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("reports malformed_token for a non-token string without throwing", () => {
    const kp = generateEd25519Keypair();
    expect(verifyLicense("garbage", kp.publicKeyBase64, CLOCK.now())).toEqual({
      valid: false,
      reason: "malformed_token",
    });
  });

  it("reports malformed_claims when the signed payload is not valid claims", () => {
    const kp = generateEd25519Keypair();
    // Sign a payload that is valid b64url but not valid claims JSON.
    const payload = b64urlEncode(JSON.stringify({ tenantId: "t", status: "not-a-status" }));
    const signature = signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, payload);
    const token = `${payload}.${signature}`;

    expect(verifyLicense(token, kp.publicKeyBase64, CLOCK.now())).toEqual({
      valid: false,
      reason: "malformed_claims",
    });
  });

  it("defaults now to the current time when omitted", () => {
    const kp = generateEd25519Keypair();
    const token = signLicense(
      kp.privateKeyBase64,
      kp.publicKeyBase64,
      baseClaims({ expiresAt: "1999-01-01T00:00:00.000Z" }),
    );
    const result = verifyLicense(token, kp.publicKeyBase64);
    expect(result).toEqual({ valid: false, reason: "expired" });
  });
});

describe("LicenseEntitlementResolver", () => {
  it("resolves the Entitlement from claims for the matching tenant", async () => {
    const kp = generateEd25519Keypair();
    const token = signLicense(kp.privateKeyBase64, kp.publicKeyBase64, baseClaims());
    const resolver = new LicenseEntitlementResolver(token, kp.publicKeyBase64, CLOCK);

    const entitlement = await resolver.resolve("tenant-abc");
    expect(entitlement).toEqual({
      status: "active",
      planId: "enterprise",
      features: ["sso", "audit"],
      maxRecordsPerEntity: 100000,
    });
  });

  it("omits undefined optionals in the resolved Entitlement", async () => {
    const kp = generateEd25519Keypair();
    const claims: LicenseClaims = {
      tenantId: "tenant-min",
      status: "trialing",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    const token = signLicense(kp.privateKeyBase64, kp.publicKeyBase64, claims);
    const resolver = new LicenseEntitlementResolver(token, kp.publicKeyBase64, CLOCK);

    const entitlement = await resolver.resolve("tenant-min");
    expect(entitlement).toEqual({ status: "trialing" });
    expect(entitlement).not.toHaveProperty("planId");
  });

  it("returns null for a non-matching tenant", async () => {
    const kp = generateEd25519Keypair();
    const token = signLicense(kp.privateKeyBase64, kp.publicKeyBase64, baseClaims());
    const resolver = new LicenseEntitlementResolver(token, kp.publicKeyBase64, CLOCK);

    expect(await resolver.resolve("someone-else")).toBeNull();
  });

  it("returns null when the license is expired against the clock", async () => {
    const kp = generateEd25519Keypair();
    const token = signLicense(
      kp.privateKeyBase64,
      kp.publicKeyBase64,
      baseClaims({ expiresAt: "2026-05-01T00:00:00.000Z" }),
    );
    const resolver = new LicenseEntitlementResolver(token, kp.publicKeyBase64, CLOCK);

    expect(await resolver.resolve("tenant-abc")).toBeNull();
  });

  it("returns null (no throw) for a malformed token", async () => {
    const kp = generateEd25519Keypair();
    const resolver = new LicenseEntitlementResolver("garbage", kp.publicKeyBase64, CLOCK);
    expect(await resolver.resolve("tenant-abc")).toBeNull();
  });
});
