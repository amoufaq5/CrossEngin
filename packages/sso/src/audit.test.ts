import { describe, expect, it } from "vitest";
import {
  FAILURE_CATEGORIES,
  LOGIN_INITIATIONS,
  LOGIN_OUTCOMES,
  LoginRecordSchema,
  MFA_FACTORS,
  ScimProvisioningRecordSchema,
  aggregateLogins,
  classifyFailure,
  isLoginBurstFailure,
  isWeakMfaFactor,
  type LoginRecord,
} from "./audit.js";

const successRecord: LoginRecord = {
  id: "login_abcd1234",
  tenantId: "11111111-1111-1111-1111-111111111111",
  providerId: "sso_acmeokta1",
  requestId: "req-1",
  initiatedAt: "2026-05-15T10:00:00.000Z",
  completedAt: "2026-05-15T10:00:00.500Z",
  latencyMs: 500,
  outcome: "success",
  initiation: "sp_initiated",
  federatedSubjectId: "alice@acme.com",
  requestedNameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  principalId: "22222222-2222-2222-2222-222222222222",
  mfaFactor: "totp",
  mfaCompletedAt: "2026-05-15T10:00:00.300Z",
  failureCategory: null,
  failureReason: null,
  ipAddress: "203.0.113.10",
  userAgent: "Mozilla/5.0",
  asNumber: 15169,
  geoCountry: "US",
};

describe("constants", () => {
  it("has 8 login outcomes", () => {
    expect(LOGIN_OUTCOMES).toHaveLength(8);
  });
  it("has 3 login initiations", () => {
    expect(LOGIN_INITIATIONS).toHaveLength(3);
  });
  it("has 5 MFA factors", () => {
    expect(MFA_FACTORS).toHaveLength(5);
  });
  it("has 6 failure categories", () => {
    expect(FAILURE_CATEGORIES).toHaveLength(6);
  });
});

describe("classifyFailure", () => {
  it("maps mfa_failed → mfa", () => {
    expect(classifyFailure("mfa_failed")).toBe("mfa");
  });
  it("maps idp_unreachable → network", () => {
    expect(classifyFailure("idp_unreachable")).toBe("network");
  });
  it("maps success → null", () => {
    expect(classifyFailure("success")).toBeNull();
  });
});

describe("isWeakMfaFactor", () => {
  it("SMS is weak", () => {
    expect(isWeakMfaFactor("sms")).toBe(true);
  });
  it("WebAuthn is strong", () => {
    expect(isWeakMfaFactor("webauthn")).toBe(false);
  });
});

describe("LoginRecordSchema", () => {
  it("accepts a valid success record", () => {
    expect(() => LoginRecordSchema.parse(successRecord)).not.toThrow();
  });

  it("rejects success with null principalId", () => {
    expect(() => LoginRecordSchema.parse({ ...successRecord, principalId: null })).toThrow(
      /success outcome requires principalId/,
    );
  });

  it("rejects success with failureCategory set", () => {
    expect(() => LoginRecordSchema.parse({ ...successRecord, failureCategory: "mfa" })).toThrow(
      /success outcome must not have failureCategory/,
    );
  });

  it("rejects mismatched outcome/failureCategory", () => {
    expect(() =>
      LoginRecordSchema.parse({
        ...successRecord,
        outcome: "idp_unreachable",
        failureCategory: "mfa",
        principalId: null,
      }),
    ).toThrow(/requires failureCategory network/);
  });

  it("rejects completedAt before initiatedAt", () => {
    expect(() =>
      LoginRecordSchema.parse({
        ...successRecord,
        completedAt: "2026-05-15T09:59:00.000Z",
      }),
    ).toThrow(/cannot precede initiatedAt/);
  });

  it("rejects latencyMs mismatch", () => {
    expect(() => LoginRecordSchema.parse({ ...successRecord, latencyMs: 9999 })).toThrow(
      /does not match/,
    );
  });

  it("rejects mfa_failed without mfaFactor", () => {
    expect(() =>
      LoginRecordSchema.parse({
        ...successRecord,
        outcome: "mfa_failed",
        mfaFactor: null,
        principalId: null,
        failureCategory: "mfa",
      }),
    ).toThrow(/mfa_failed outcome requires mfaFactor/);
  });
});

describe("aggregateLogins", () => {
  it("returns zeros for empty list", () => {
    const stats = aggregateLogins([]);
    expect(stats.totalLogins).toBe(0);
    expect(stats.successRate).toBe(0);
  });

  it("aggregates success rate and failure categories", () => {
    const records = [
      successRecord,
      successRecord,
      {
        ...successRecord,
        id: "login_abcd1235",
        outcome: "mfa_failed" as const,
        principalId: null,
        failureCategory: "mfa" as const,
        mfaFactor: "totp" as const,
      },
      {
        ...successRecord,
        id: "login_abcd1236",
        outcome: "idp_unreachable" as const,
        principalId: null,
        failureCategory: "network" as const,
      },
    ];
    const stats = aggregateLogins(records);
    expect(stats.totalLogins).toBe(4);
    expect(stats.successfulLogins).toBe(2);
    expect(stats.failedLogins).toBe(2);
    expect(stats.successRate).toBe(0.5);
    expect(stats.failuresByCategory.mfa).toBe(1);
    expect(stats.failuresByCategory.network).toBe(1);
  });

  it("computes p50 and p99 latencies", () => {
    const make = (latency: number): LoginRecord => ({
      ...successRecord,
      id: `login_${latency.toString().padStart(8, "0")}`,
      latencyMs: latency,
      completedAt: new Date(Date.parse("2026-05-15T10:00:00Z") + latency).toISOString(),
    });
    const stats = aggregateLogins([make(50), make(100), make(200), make(500)]);
    expect(stats.p50LatencyMs).toBeGreaterThan(0);
    expect(stats.p99LatencyMs).toBe(500);
  });
});

describe("isLoginBurstFailure", () => {
  it("flags burst when multiple recent failures for same subject", () => {
    const now = new Date("2026-05-15T10:05:00Z");
    const record: LoginRecord = {
      ...successRecord,
      id: "login_now12345",
      initiatedAt: now.toISOString(),
    };
    const priors: LoginRecord[] = [
      {
        ...successRecord,
        id: "login_prior001",
        initiatedAt: "2026-05-15T10:04:00.000Z",
        outcome: "mfa_failed",
        principalId: null,
        failureCategory: "mfa",
        mfaFactor: "totp",
      },
      {
        ...successRecord,
        id: "login_prior002",
        initiatedAt: "2026-05-15T10:04:30.000Z",
        outcome: "mfa_failed",
        principalId: null,
        failureCategory: "mfa",
        mfaFactor: "totp",
      },
      {
        ...successRecord,
        id: "login_prior003",
        initiatedAt: "2026-05-15T10:04:45.000Z",
        outcome: "mfa_failed",
        principalId: null,
        failureCategory: "mfa",
        mfaFactor: "totp",
      },
    ];
    expect(isLoginBurstFailure(record, priors, 120, 3)).toBe(true);
  });

  it("returns false outside the window", () => {
    const now = new Date("2026-05-15T11:00:00Z");
    const record: LoginRecord = {
      ...successRecord,
      id: "login_xyz98765",
      initiatedAt: now.toISOString(),
    };
    expect(isLoginBurstFailure(record, [], 120, 3)).toBe(false);
  });
});

describe("ScimProvisioningRecordSchema", () => {
  const base = {
    id: "scim_abcd1234",
    tenantId: "11111111-1111-1111-1111-111111111111",
    scimClientId: "33333333-3333-3333-3333-333333333333",
    providerId: "sso_acmeokta1",
    requestId: "scim-req-1",
    resourceType: "User" as const,
    operation: "create" as const,
    targetResourceId: "user-alice",
    requestedAt: "2026-05-15T10:00:00.000Z",
    completedAt: "2026-05-15T10:00:00.200Z",
    latencyMs: 200,
    outcome: "created" as const,
    bytesRequest: 256,
    bytesResponse: 512,
    errorMessage: null,
  };

  it("accepts a successful create", () => {
    expect(() => ScimProvisioningRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects latency mismatch", () => {
    expect(() => ScimProvisioningRecordSchema.parse({ ...base, latencyMs: 9999 })).toThrow(
      /does not match/,
    );
  });

  it("rejects conflict without errorMessage", () => {
    expect(() =>
      ScimProvisioningRecordSchema.parse({
        ...base,
        outcome: "conflict",
        errorMessage: null,
      }),
    ).toThrow(/requires errorMessage/);
  });
});
