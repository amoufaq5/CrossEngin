import { describe, expect, it } from "vitest";
import { EVIDENCE_SOURCE_KINDS } from "./controls.js";
import {
  ACCESS_REVIEW_SCOPE_ABSENT_FINDING,
  ControlEvidenceSchema,
  evidenceFromAccessReviewEvidence,
  evidenceFromDrReadiness,
  drAxisUnevidencedFinding,
  DR_AXIS_UNEVIDENCED_KIND,
  DR_EVIDENCE_SCOPE_UNKNOWN_FINDING,
  DR_VERDICT_UNEXPLAINED_FINDING,
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

  it("fails closed when the column total is not readable as a positive number", () => {
    // The sibling of the access-review case, through the one shared `scopeIsAbsent` predicate:
    // leaving one adapter fail-closed and the other fail-open is the divergence this file keeps
    // producing.
    for (const unreadable of [undefined, NaN, -1]) {
      const e = evidenceFromEncryptionCoverage(
        "data.encryption_at_rest",
        {
          schema: "meta",
          pgcryptoInstalled: true,
          total: unreadable as unknown as number,
          plaintext: 0,
          issues: [],
        },
        AT,
      );
      expect(e.satisfied).toBe(false);
      expect(e.findings).toContain(ENCRYPTION_SCOPE_ABSENT_FINDING);
    }
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
  it("satisfied when ready and every axis carried a record", () => {
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: true, unevidencedAxes: [], counts: { totalIssues: 0 } },
      AT,
    );
    expect(e.satisfied).toBe(true);
    expect(e.findings).toEqual([]);
    expect(e.summary).toBe("DR readiness: READY (0 issues)");
  });

  it("is NOT satisfied when an axis carried no record at all", () => {
    // The defect this closes, and the sibling's rule applied to the member ADR-0337 left open in
    // this same file. Measured on the committed tree: `assessDrReadiness({now})` answered
    // `ready: true, totalIssues: 0` for an estate with no backup, no drill and no runbook, so this
    // control answered `satisfied: true` with the summary "DR readiness: READY (0 issues)" — DR
    // readiness certified in a SOC 2 evidence pack over nothing — and on every deployment rather
    // than a misconfigured one, since three of the four evidence axes have no durable source and
    // `meta.backup_records` has no writer anywhere in the workspace.
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      {
        ready: false,
        unevidencedAxes: ["drills", "runbooks", "backups", "replication"],
        counts: { totalIssues: 0 },
      },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings).toContain(drAxisUnevidencedFinding("backups"));
    expect(e.findings).toHaveLength(4);
    expect(e.summary).toContain("unevidenced, not satisfied");
  });

  it("cannot be satisfied by a stored ready:true that disagrees with its own axes", () => {
    // `satisfied` is derived from the same sources the verdict is, never read off `report.ready`,
    // so a hand-edited or future row claiming readiness over an unevidenced axis buys nothing.
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: true, unevidencedAxes: ["backups"], counts: { totalIssues: 0 } },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings).toEqual([drAxisUnevidencedFinding("backups")]);
  });

  it("says a report predating the check cannot evidence the control, in its own words", () => {
    // A different sentence from "axes are unevidenced": that one names which axes carried nothing,
    // this one says the report cannot say. `null` is the gap, `[]` is the claim (ADR-0331).
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: true, unevidencedAxes: null, counts: { totalIssues: 0 } },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings).toEqual([DR_EVIDENCE_SCOPE_UNKNOWN_FINDING]);
    expect(e.summary).toContain("predates the unevidenced-axis check");
    expect(e.summary).not.toContain("no DR record on");
  });

  it("puts the absence first, so a real issue cannot bury it", () => {
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      {
        ready: false,
        unevidencedAxes: ["backups"],
        counts: { totalIssues: 1, overdueDrills: 1 },
      },
      AT,
    );
    expect(e.findings[0]).toBe(drAxisUnevidencedFinding("backups"));
    expect(e.findings.some((f) => f.includes("overdue drills"))).toBe(true);
  });

  it("deficient with itemized findings", () => {
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      {
        ready: false,
        unevidencedAxes: [],
        counts: { totalIssues: 2, expiredBackups: 1, failoverBreaches: 1 },
      },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings.some((f) => f.includes("expired backups"))).toBe(true);
    expect(e.findings.some((f) => f.includes("failover"))).toBe(true);
    // The itemized list is driven by the issue count now and not by `!ready`, so it must not open
    // with the "0 DR readiness issue(s)" sentence the old condition would have produced.
    expect(e.findings[0]).toBe("2 DR readiness issue(s)");
  });

  it("does not open the findings with a zero issue count when only an axis is unevidenced", () => {
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: false, unevidencedAxes: ["drills"], counts: { totalIssues: 0 } },
      AT,
    );
    expect(e.findings.some((f) => f.includes("0 DR readiness issue(s)"))).toBe(false);
  });

  it("itemizes component counts even when the stored total disagrees at zero", () => {
    // The row `DR_VERDICT_UNEXPLAINED_FINDING` was added for. The itemization was gated on
    // `counts.totalIssues > 0`, so this row's two component counts were surfaced nowhere and the
    // fallback then asserted the report carried none — a finding that misdescribed its own
    // trigger. Gated on whether anything is itemizable now, so the components come out and the
    // fallback does not fire.
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      {
        ready: false,
        unevidencedAxes: [],
        counts: { totalIssues: 0, overdueDrills: 3, expiredBackups: 2 },
      },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings).not.toContain(DR_VERDICT_UNEXPLAINED_FINDING);
    expect(e.findings).toEqual(["overdue drills: 3", "expired backups: 2"]);
    // The header restates the stored total, so a zero total must not publish "0 DR readiness
    // issue(s)" as though it were a finding.
    expect(e.findings.some((f) => f.includes("DR readiness issue(s)"))).toBe(false);
    // And the summary must not be the self-contradictory bare pair.
    expect(e.summary).not.toBe("DR readiness: NOT READY (0 issue(s))");
    expect(e.summary).toContain("disagrees with the 2 component count(s)");
  });

  it("itemizes replication violations, the seventh summand", () => {
    // `DrReadinessLike.counts` omitted `replicationViolations` while `assessDrReadiness` sums it
    // into `totalIssues` and `meta.dr_readiness_snapshots` projects it as its own column — so a
    // deployment whose only DR issues were replication violations was told
    // `NOT READY (3 issue(s))` with the bare header as its entire findings list: three issues and
    // not one word about what they were.
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: false, unevidencedAxes: [], counts: { totalIssues: 3, replicationViolations: 3 } },
      AT,
    );
    expect(e.findings).toEqual(["3 DR readiness issue(s)", "replication violations: 3"]);
  });

  it("says something rather than nothing when a not-ready verdict explains itself nowhere", () => {
    // Unreachable from `assessDrReadiness`, whose `ready` is exactly
    // `totalIssues === 0 && unevidencedAxes.length === 0`. Reachable from a hand-edited row, and
    // the alternative is `satisfied: false` with an empty findings list — a claim with no evidence,
    // in the function written to end that.
    const e = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      { ready: false, unevidencedAxes: [], counts: { totalIssues: 0 } },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings).toEqual([DR_VERDICT_UNEXPLAINED_FINDING]);
  });

  it("names the kind first in both findings, as the encryption sibling does", () => {
    expect(DR_EVIDENCE_SCOPE_UNKNOWN_FINDING.startsWith("evidence_scope_unknown: ")).toBe(true);
    expect(drAxisUnevidencedFinding("backups").startsWith(`${DR_AXIS_UNEVIDENCED_KIND}: `)).toBe(
      true,
    );
    expect(ENCRYPTION_SCOPE_ABSENT_FINDING.startsWith("scope_absent: ")).toBe(true);
    expect(ACCESS_REVIEW_SCOPE_ABSENT_FINDING.startsWith("scope_absent: ")).toBe(true);
  });

  it("the verdict_unexplained sentence names every condition that triggers it", () => {
    // It used to name two of three and was therefore false about the row it was added for. The
    // trigger is: no issue count, no component count, no unevidenced axis.
    expect(DR_VERDICT_UNEXPLAINED_FINDING).toContain("no issue count");
    expect(DR_VERDICT_UNEXPLAINED_FINDING).toContain("no component count");
    expect(DR_VERDICT_UNEXPLAINED_FINDING).toContain("no unevidenced axis");
  });
});

describe("zero scope across every evidence adapter", () => {
  // The class census, pinned so a fifth adapter cannot land answering `satisfied: true` over
  // nothing. ADR-0337's criticism of itself was that it fixed the member it had found and not the
  // class, in this file; three of the four are guarded here and the fourth is guarded at its
  // source, so there is no adapter left whose zero-scope answer is satisfaction.
  //
  // `EVIDENCE_SOURCE_KINDS` has exactly four members and each has exactly one adapter, so this
  // table is the whole class — and the assertion on its length is what makes a fifth source kind
  // land here rather than quietly.
  it("covers every declared evidence source kind", () => {
    expect(EVIDENCE_SOURCE_KINDS).toHaveLength(4);
  });

  it("encryption, DR and access review all refuse an empty scope in the adapter", () => {
    const encryption = evidenceFromEncryptionCoverage(
      "data.encryption_at_rest",
      { schema: "meta", pgcryptoInstalled: true, total: 0, plaintext: 0, issues: [] },
      AT,
    );
    const dr = evidenceFromDrReadiness(
      "resilience.dr_readiness",
      {
        ready: false,
        unevidencedAxes: ["drills", "runbooks", "backups", "replication"],
        counts: { totalIssues: 0 },
      },
      AT,
    );
    const accessReview = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      {
        framework: "soc2_type2",
        status: "sealed",
        sealedSha256: "a".repeat(64),
        totalItemsAcrossCampaigns: 0,
        completionRate: 1,
        strongAttestationRate: 0,
        controlMappings: ["CC6.1"],
      },
      AT,
    );
    for (const e of [encryption, dr, accessReview]) {
      expect(e.satisfied).toBe(false);
      expect(e.findings.length).toBeGreaterThan(0);
      expect(e.summary).toContain("unevidenced, not satisfied");
    }
  });

  it("the forensic chain is satisfied on an empty chain and is guarded at its source", () => {
    // Deliberately **not** guarded in the adapter, and this test records why rather than changing
    // it. `verifyChainIntegrity([])` is vacuously valid and this adapter reports exactly what it
    // was handed, while `forensicChainSource` in `apps/operate-server/src/certification.ts` returns
    // `[]` for an empty chain so the control stays `not_assessed` — its comment reads "a
    // valid-by-vacuity empty log must not read as a satisfied control". Guarding here as well
    // would be a second opinion about one fact in two packages, and the source is the layer that
    // knows the chain was empty rather than broken.
    const e = evidenceFromForensicChain(
      "audit.tamper_evident_log",
      { valid: true, brokenAt: null },
      AT,
    );
    expect(e.satisfied).toBe(true);
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
    // Positive and never 0: this fixture's job is a pack that really is complete, and a
    // `completionRate: 1` over zero items is the division guard rather than a measurement — which
    // is the defect the required field refuses. The zero case gets its own tests below.
    totalItemsAcrossCampaigns: 50,
    completionRate: 1,
    strongAttestationRate: 1,
    controlMappings: ["CC6.1"],
  };

  it("satisfied when sealed and above completion threshold", () => {
    const e = evidenceFromAccessReviewEvidence("access.periodic_review", base, AT);
    expect(e.satisfied).toBe(true);
    expect(e.detailRef).toBe("a".repeat(64));
  });

  it("is NOT satisfied when the pack covered no item at all", () => {
    // The defect this closes, and the fourth member of the class ADR-0337 found in this file.
    // Measured end to end through the real production functions — no hand-editing: a finished
    // campaign with no items compiles `totalItemsAcrossCampaigns: 0, completionRate: 1`
    // (`compileCampaignEvidence` has no zero-item refusal among its six, and the repo's own test is
    // titled "compiles an empty finished campaign at 100% completion"), `sealEvidence` turns it
    // into a contract-valid `sealed` record with a real digest, and this control then answered
    // `satisfied: true` with the summary "soc2_type2 access review sealed at 100% completion" and
    // an empty findings list — a SOC 2 pack certifying that access was reviewed, over zero reviewed
    // items. `completionRate` was the only quantitative gate here and `1 < 0.95` is false.
    const e = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      { ...base, totalItemsAcrossCampaigns: 0 },
      AT,
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings).toContain(ACCESS_REVIEW_SCOPE_ABSENT_FINDING);
    expect(e.summary).toContain("unevidenced, not satisfied");
    expect(e.summary).not.toContain("100% completion");
    expect(() => ControlEvidenceSchema.parse(e)).not.toThrow();
  });

  it("keeps the scope_absent finding alongside a real deficiency, absence first", () => {
    // The encryption sibling's rule: a real finding beside an empty scope must not bury the one
    // fact that says the control was never evaluated.
    const e = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      { ...base, totalItemsAcrossCampaigns: 0, status: "compiled", sealedSha256: null },
      AT,
    );
    expect(e.findings[0]).toBe(ACCESS_REVIEW_SCOPE_ABSENT_FINDING);
    expect(e.findings).toHaveLength(2);
    expect(e.satisfied).toBe(false);
  });

  it("fails closed when the item count is not readable as a positive number", () => {
    // These are structural views, so a caller the compiler never sees — plain JS, or a row off
    // `JSON.parse` whose producer predates the field — can hand over `undefined`. The obvious
    // `=== 0` spelling answered `false` for it and certified the control, which is how the census
    // script written for this increment still reported `satisfied: true` after the fix was in.
    // `NaN` and a negative count take the same branch.
    for (const unreadable of [undefined, NaN, -1]) {
      const e = evidenceFromAccessReviewEvidence(
        "access.periodic_review",
        { ...base, totalItemsAcrossCampaigns: unreadable as unknown as number },
        AT,
      );
      expect(e.satisfied).toBe(false);
      expect(e.findings).toContain(ACCESS_REVIEW_SCOPE_ABSENT_FINDING);
    }
  });

  it("an empty scope is not rescued by requireSeal:false", () => {
    // The option relaxes the seal, which is a statement about custody; it says nothing about
    // whether anything was reviewed, so it must not reopen the unevidenced path.
    const e = evidenceFromAccessReviewEvidence(
      "access.periodic_review",
      { ...base, totalItemsAcrossCampaigns: 0 },
      AT,
      { requireSeal: false, minCompletionRate: 0 },
    );
    expect(e.satisfied).toBe(false);
    expect(e.findings).toEqual([ACCESS_REVIEW_SCOPE_ABSENT_FINDING]);
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
