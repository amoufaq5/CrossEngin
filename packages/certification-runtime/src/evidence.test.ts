import { describe, expect, it } from "vitest";
import {
  ControlEvidenceSchema,
  evidenceFromAccessReviewEvidence,
  evidenceFromDrReadiness,
  ENCRYPTION_SCOPE_ABSENT_FINDING,
  evidenceFromEncryptionCoverage,
  evidenceFromForensicChain,
  type AccessReviewEvidenceLike,
} from "./evidence.js";

const AT = "2026-06-01T00:00:00.000Z";

describe("evidenceFromEncryptionCoverage", () => {
  it("is NOT satisfied when the schema declares no at-rest column at all", () => {
    // The defect this closes, verified live: a JSONB-store deployment keeps every field — `phi`
    // and `regulated` included — inside one `document` JSONB column, so it declares zero at-rest
    // columns and therefore zero issues, and this control answered `satisfied: true` with the
    // summary "0 at-rest column(s) in meta are ciphertext; pgcrypto installed". The same
    // `POST /v1/patients` that 500s on the column store returns 201 on the JSONB store and
    // `document->>'mrn'` reads back in plaintext. So the control affirmed encryption at rest over
    // unencrypted PHI. `issues.length === 0` means "no plaintext column was found", which is not
    // "no column was found".
    const e = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      { schema: "meta", pgcryptoInstalled: true, total: 0, plaintext: 0, issues: [] },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings).toContain(ENCRYPTION_SCOPE_ABSENT_FINDING);
    expect(e.summary).toContain("unevidenced, not satisfied");
    expect(() => ControlEvidenceSchema.parse(e)).not.toThrow();
  });

  it("keeps the scope_absent finding alongside real plaintext findings", () => {
    // Zero columns and a pgcrypto problem can co-occur, and neither should mask the other.
    const e = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      {
        schema: "meta",
        pgcryptoInstalled: false,
        total: 0,
        plaintext: 0,
        issues: [{ kind: "pgcrypto_missing", detail: "extension not installed" }],
      },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings[0]).toBe(ENCRYPTION_SCOPE_ABSENT_FINDING);
    expect(e.findings).toHaveLength(2);
  });

  it("satisfied when there are no issues", () => {
    const e = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      { schema: "meta", pgcryptoInstalled: true, total: 3, plaintext: 0, issues: [] },
      AT,
    );
    expect(e.satisfied).toBe(true);
    expect(e.findings).toEqual([]);
    expect(e.detailRef).toBe("meta");
    expect(() => ControlEvidenceSchema.parse(e)).not.toThrow();
  });

  it("deficient with findings when a plaintext column drifts", () => {
    const e = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      {
        schema: "meta",
        pgcryptoInstalled: true,
        total: 3,
        plaintext: 1,
        issues: [{ kind: "plaintext_at_rest", detail: "patients.mrn is plaintext" }],
      },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings[0]).toContain("plaintext_at_rest");
  });
});

describe("evidenceFromDrReadiness", () => {
  it("satisfied when ready", () => {
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: true, counts: { totalIssues: 0 } },
      AT,
    );
    expect(e.satisfied).toBe(true);
  });

  it("deficient with itemized findings", () => {
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      {
        ready: false,
        counts: { totalIssues: 2, expiredBackups: 1, failoverBreaches: 1 },
      },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings.some((f) => f.includes("expired backups"))).toBe(true);
    expect(e.findings.some((f) => f.includes("failover"))).toBe(true);
  });
});

describe("evidenceFromForensicChain", () => {
  it("satisfied when the chain verifies", () => {
    const e = evidenceFromForensicChain(
      "audit.tamper_evident_log",
      { valid: true, brokenAt: null },
      AT,
    );
    expect(e.satisfied).toBe(true);
  });

  it("deficient records the break point", () => {
    const e = evidenceFromForensicChain(
      "audit.tamper_evident_log",
      { valid: false, brokenAt: 42, reason: "hash mismatch" },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings[0]).toContain("42");
    expect(e.findings[0]).toContain("hash mismatch");
  });
});

describe("evidenceFromAccessReviewEvidence", () => {
  const base: AccessReviewEvidenceLike = {
    framework: "soc2_type2",
    status: "sealed",
    sealedSha256: "a".repeat(64),
    completionRate: 1,
    strongAttestationRate: 1,
    controlMappings: ["CC6.1"],
  };

  it("satisfied when sealed and above completion threshold", () => {
    const e = evidenceFromAccessReviewEvidence("access.periodic_review", base, AT);
    expect(e.satisfied).toBe(true);
    expect(e.detailRef).toBe("a".repeat(64));
  });

  it("deficient when not sealed", () => {
    const e = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      { ...base, status: "compiled", sealedSha256: null },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings.some((f) => f.includes("not sealed"))).toBe(true);
  });

  it("deficient when completion below threshold", () => {
    const e = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      { ...base, completionRate: 0.5 },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings.some((f) => f.includes("completion rate"))).toBe(true);
  });

  it("requireSeal:false accepts an unsealed but complete campaign", () => {
    const e = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      { ...base, status: "compiled", sealedSha256: null },
      AT,
      { requireSeal: false },
    );
    expect(e.satisfied).toBe(true);
  });
});
