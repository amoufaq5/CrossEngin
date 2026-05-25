import { describe, expect, it } from "vitest";
import {
  CONSENT_STATUSES,
  DATA_CLASSES,
  FORBIDDEN_TRAINING_DATA_CLASSES,
  TRAINING_PURPOSES,
  TrainingConsentSchema,
  activeConsentsFor,
  isConsentActive,
  permitsDataClass,
  type TrainingConsent,
} from "./consent.js";

describe("constants", () => {
  it("TRAINING_PURPOSES has 5 entries", () => {
    expect(TRAINING_PURPOSES).toContain("global_model_improvement");
    expect(TRAINING_PURPOSES).toContain("tenant_specific_finetune");
    expect(TRAINING_PURPOSES).toContain("redteam_evaluation");
  });

  it("DATA_CLASSES has 6 entries", () => {
    expect(DATA_CLASSES).toEqual([
      "public",
      "internal",
      "commercial_sensitive",
      "pii",
      "phi",
      "regulated",
    ]);
  });

  it("FORBIDDEN_TRAINING_DATA_CLASSES = phi + regulated", () => {
    expect(FORBIDDEN_TRAINING_DATA_CLASSES.has("phi")).toBe(true);
    expect(FORBIDDEN_TRAINING_DATA_CLASSES.has("regulated")).toBe(true);
    expect(FORBIDDEN_TRAINING_DATA_CLASSES.has("pii")).toBe(false);
  });

  it("CONSENT_STATUSES has 4 entries", () => {
    expect(CONSENT_STATUSES).toContain("active");
    expect(CONSENT_STATUSES).toContain("withdrawn");
    expect(CONSENT_STATUSES).toContain("superseded");
  });
});

describe("TrainingConsentSchema", () => {
  const base: TrainingConsent = {
    id: "consent-1",
    tenantId: "t-1",
    purpose: "global_model_improvement",
    allowedDataClasses: ["public", "internal"],
    redactPii: true,
    minimumKAnonymity: 5,
    status: "active",
    grantedAt: "2026-05-14T10:00:00Z",
    grantedBy: "u-1",
    grantedByRole: "tenant_admin",
    expiresAt: null,
    withdrawnAt: null,
    withdrawnBy: null,
    supersedingConsentId: null,
    termsVersion: "1.0.0",
    legalBasis: "consent",
  };

  it("accepts a valid active consent", () => {
    expect(() => TrainingConsentSchema.parse(base)).not.toThrow();
  });

  it("rejects consent that allows phi", () => {
    expect(() =>
      TrainingConsentSchema.parse({
        ...base,
        allowedDataClasses: ["public", "phi"],
      }),
    ).toThrow(/forbidden regardless of consent/);
  });

  it("rejects consent that allows regulated", () => {
    expect(() =>
      TrainingConsentSchema.parse({
        ...base,
        allowedDataClasses: ["regulated"],
      }),
    ).toThrow(/forbidden/);
  });

  it("rejects duplicate data classes", () => {
    expect(() =>
      TrainingConsentSchema.parse({
        ...base,
        allowedDataClasses: ["public", "public"],
      }),
    ).toThrow(/duplicate data class/);
  });

  it("rejects pii without redactPii", () => {
    expect(() =>
      TrainingConsentSchema.parse({
        ...base,
        allowedDataClasses: ["pii"],
        redactPii: false,
      }),
    ).toThrow(/redactPii=true/);
  });

  it("rejects withdrawn without withdrawnAt + reason", () => {
    expect(() => TrainingConsentSchema.parse({ ...base, status: "withdrawn" })).toThrow(
      /withdrawnAt/,
    );
  });

  it("rejects superseded without supersedingConsentId", () => {
    expect(() => TrainingConsentSchema.parse({ ...base, status: "superseded" })).toThrow(
      /supersedingConsentId/,
    );
  });

  it("rejects expiresAt <= grantedAt", () => {
    expect(() =>
      TrainingConsentSchema.parse({
        ...base,
        expiresAt: "2026-05-14T10:00:00Z",
      }),
    ).toThrow(/after grantedAt/);
  });

  it("rejects tenant_specific_finetune without contract basis", () => {
    expect(() =>
      TrainingConsentSchema.parse({
        ...base,
        purpose: "tenant_specific_finetune",
        legalBasis: "consent",
      }),
    ).toThrow(/contract/);
  });
});

describe("helpers", () => {
  const base: TrainingConsent = {
    id: "c-1",
    tenantId: "t-1",
    purpose: "global_model_improvement",
    allowedDataClasses: ["public", "internal"],
    redactPii: true,
    minimumKAnonymity: 5,
    status: "active",
    grantedAt: "2026-05-14T10:00:00Z",
    grantedBy: "u-1",
    grantedByRole: "tenant_admin",
    expiresAt: null,
    withdrawnAt: null,
    withdrawnBy: null,
    supersedingConsentId: null,
    termsVersion: "1.0.0",
    legalBasis: "consent",
  };

  it("isConsentActive returns true for active w/o expiry", () => {
    expect(isConsentActive(base)).toBe(true);
  });

  it("isConsentActive returns false for non-active status", () => {
    expect(
      isConsentActive({
        ...base,
        status: "withdrawn",
        withdrawnAt: "2026-05-15T00:00:00Z",
        withdrawnBy: "u-1",
        withdrawnReason: "x",
      }),
    ).toBe(false);
  });

  it("isConsentActive returns false after expiry", () => {
    const c: TrainingConsent = { ...base, expiresAt: "2026-06-14T10:00:00Z" };
    expect(isConsentActive(c, new Date("2026-07-01T00:00:00Z"))).toBe(false);
    expect(isConsentActive(c, new Date("2026-05-20T00:00:00Z"))).toBe(true);
  });

  it("permitsDataClass returns true for allowed class", () => {
    expect(permitsDataClass(base, "public")).toBe(true);
    expect(permitsDataClass(base, "internal")).toBe(true);
  });

  it("permitsDataClass returns false for phi (always forbidden)", () => {
    expect(permitsDataClass(base, "phi")).toBe(false);
  });

  it("permitsDataClass returns false for not-allowed class", () => {
    expect(permitsDataClass(base, "pii")).toBe(false);
  });

  it("activeConsentsFor filters by tenant + purpose + active", () => {
    const other: TrainingConsent = {
      ...base,
      id: "c-2",
      purpose: "benchmarking_only",
    };
    expect(
      activeConsentsFor([base, other], "t-1", "global_model_improvement").map((c) => c.id),
    ).toEqual(["c-1"]);
  });
});
