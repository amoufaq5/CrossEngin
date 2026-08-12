import { describe, expect, it } from "vitest";
import { assessControl, assessFramework } from "./assessment.js";
import { DEFAULT_CONTROL_CATALOG } from "./controls.js";
import {
  evidenceFromDrReadiness,
  evidenceFromEncryptionCoverage,
  evidenceFromForensicChain,
  evidenceFromAccessReviewEvidence,
  type ControlEvidence,
} from "./evidence.js";

const AT = "2026-06-01T00:00:00.000Z";

function fullyCompliantEvidence(): ControlEvidence[] {
  return [
    evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      {
        framework: "soc2_type2",
        status: "sealed",
        sealedSha256: "a".repeat(64),
        completionRate: 1,
        strongAttestationRate: 1,
        controlMappings: ["CC6.1"],
      },
      AT,
    ),
    evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      { schema: "meta", pgcryptoInstalled: true, total: 2, plaintext: 0, issues: [] },
      AT,
    ),
    evidenceFromForensicChain(
      "audit.tamper_evident_log",
      { valid: true, brokenAt: null },
      AT,
    ),
    evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: true, counts: { totalIssues: 0 } },
      AT,
    ),
  ];
}

describe("assessControl", () => {
  const enc = DEFAULT_CONTROL_CATALOG.find(
    (c) => c.id === "data.encryption_at_rest",
  )!;

  it("not_assessed when no matching evidence", () => {
    const a = assessControl(enc, "soc2_type2", []);
    expect(a.status).toBe("not_assessed");
    expect(a.evidenceCount).toBe(0);
    expect(a.frameworkRefs).toContain("CC6.7");
  });

  it("satisfied when evidence passes", () => {
    const ev = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      { schema: "meta", pgcryptoInstalled: true, total: 1, plaintext: 0, issues: [] },
      AT,
    );
    expect(assessControl(enc, "soc2_type2", [ev]).status).toBe("satisfied");
  });

  it("deficient when evidence fails, surfacing findings", () => {
    const ev = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      {
        schema: "meta",
        pgcryptoInstalled: false,
        total: 1,
        plaintext: 1,
        issues: [{ kind: "pgcrypto_missing", detail: "extension not installed" }],
      },
      AT,
    );
    const a = assessControl(enc, "soc2_type2", [ev]);
    expect(a.status).toBe("deficient");
    expect(a.findings.length).toBeGreaterThan(0);
  });

  it("ignores evidence whose sourceKind does not match the control", () => {
    const wrong = evidenceFromDrReadiness(
      "data.encryption_at_rest",
      { ready: true, counts: { totalIssues: 0 } },
      AT,
    );
    expect(assessControl(enc, "soc2_type2", [wrong]).status).toBe("not_assessed");
  });
});

describe("assessFramework", () => {
  it("certifiable when every in-scope control is satisfied", () => {
    const fa = assessFramework("soc2_type2", fullyCompliantEvidence());
    expect(fa.counts.total).toBe(4);
    expect(fa.counts.satisfied).toBe(4);
    expect(fa.certifiable).toBe(true);
  });

  it("not certifiable when a control is deficient", () => {
    const evidence = fullyCompliantEvidence();
    evidence[1] = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      {
        schema: "meta",
        pgcryptoInstalled: true,
        total: 1,
        plaintext: 1,
        issues: [{ kind: "plaintext_at_rest", detail: "x is plaintext" }],
      },
      AT,
    );
    const fa = assessFramework("soc2_type2", evidence);
    expect(fa.counts.deficient).toBe(1);
    expect(fa.certifiable).toBe(false);
  });

  it("not certifiable when a control is not assessed (missing evidence)", () => {
    const fa = assessFramework("hipaa_security_rule", [
      evidenceFromEncryptionCoverage(
        "data.encryption_at_rest",
        { schema: "meta", pgcryptoInstalled: true, total: 1, plaintext: 0, issues: [] },
        AT,
      ),
    ]);
    expect(fa.counts.notAssessed).toBe(3);
    expect(fa.certifiable).toBe(false);
  });

  it("cfr_21_part_11 scopes out the DR-readiness control", () => {
    const fa = assessFramework("cfr_21_part_11", []);
    expect(fa.controls.map((c) => c.controlId)).not.toContain(
      "resilience.dr_readiness",
    );
    expect(fa.counts.total).toBe(3);
  });

  it("custom framework has zero controls and is not certifiable", () => {
    const fa = assessFramework("custom", []);
    expect(fa.counts.total).toBe(0);
    expect(fa.certifiable).toBe(false);
  });
});
