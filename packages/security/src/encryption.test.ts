import { describe, expect, it } from "vitest";
import {
  cadenceToDays,
  EncryptionProfileSchema,
  KeyRotationPolicySchema,
  KeyRotationPolicyEntrySchema,
  rotationReminder,
  SECRET_KINDS,
} from "./encryption.js";

describe("EncryptionProfileSchema", () => {
  it("parses a typical PHI profile", () => {
    const p = EncryptionProfileSchema.parse({
      appliesTo: ["phi"],
      atRest: { algorithm: "aes-256-gcm", keyManagement: "supabase-vault", byokRequired: false },
      inTransit: {},
    });
    expect(p.inTransit.minVersion).toBe("1.3");
    expect(p.inTransit.requireHsts).toBe(true);
  });

  it("requires at least one data class", () => {
    expect(() =>
      EncryptionProfileSchema.parse({
        appliesTo: [],
        atRest: { algorithm: "aes-256", keyManagement: "supabase-vault" },
        inTransit: {},
      }),
    ).toThrow();
  });

  it("accepts a BYOK profile under aws-kms", () => {
    const p = EncryptionProfileSchema.parse({
      appliesTo: ["phi", "regulated"],
      atRest: {
        algorithm: "aes-256-gcm",
        keyManagement: "customer-managed-byok",
        byokRequired: true,
      },
      inTransit: { minVersion: "1.3", certificatePinning: true },
    });
    expect(p.atRest.byokRequired).toBe(true);
    expect(p.inTransit.certificatePinning).toBe(true);
  });
});

describe("KeyRotationPolicyEntrySchema", () => {
  it("parses a 90d JWT rotation", () => {
    const e = KeyRotationPolicyEntrySchema.parse({
      secretKind: "jwt_signing",
      cadence: "90d",
      overlapWindow: "14d",
    });
    expect(e.secretKind).toBe("jwt_signing");
  });

  it("rejects overlap larger than cadence", () => {
    expect(() =>
      KeyRotationPolicyEntrySchema.parse({
        secretKind: "stripe_key",
        cadence: "30d",
        overlapWindow: "60d",
      }),
    ).toThrow(/overlapWindow must be <= cadence/);
  });

  it("rejects malformed cadence", () => {
    expect(() =>
      KeyRotationPolicyEntrySchema.parse({
        secretKind: "jwt_signing",
        cadence: "ninety days",
      }),
    ).toThrow();
  });
});

describe("KeyRotationPolicySchema", () => {
  it("rejects duplicate secret kinds", () => {
    expect(() =>
      KeyRotationPolicySchema.parse([
        { secretKind: "jwt_signing", cadence: "90d" },
        { secretKind: "jwt_signing", cadence: "60d" },
      ]),
    ).toThrow(/duplicate entry/);
  });

  it("SECRET_KINDS covers all named secrets in the ADR", () => {
    expect(SECRET_KINDS).toContain("jwt_signing");
    expect(SECRET_KINDS).toContain("manifest_signing");
    expect(SECRET_KINDS).toContain("fireworks_api_key");
  });
});

describe("cadenceToDays", () => {
  it("converts each unit", () => {
    expect(cadenceToDays("7d")).toBe(7);
    expect(cadenceToDays("2w")).toBe(14);
    expect(cadenceToDays("3m")).toBe(90);
    expect(cadenceToDays("1y")).toBe(365);
  });
});

describe("rotationReminder", () => {
  const entry = KeyRotationPolicyEntrySchema.parse({
    secretKind: "jwt_signing",
    cadence: "90d",
  });

  it("flags overdue rotation", () => {
    const past = new Date(Date.now() - 100 * 86_400_000);
    const r = rotationReminder(entry, past);
    expect(r.overdue).toBe(true);
    expect(r.daysUntilRotation).toBeLessThan(0);
  });

  it("does not flag fresh rotation", () => {
    const recent = new Date(Date.now() - 10 * 86_400_000);
    const r = rotationReminder(entry, recent);
    expect(r.overdue).toBe(false);
    expect(r.daysUntilRotation).toBeGreaterThan(0);
  });
});
