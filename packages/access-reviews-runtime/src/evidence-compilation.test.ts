import { describe, expect, it } from "vitest";
import {
  AccessReviewEvidenceSchema,
  CONTROL_MAPPINGS,
  computeEvidenceSealSha256,
  verifyEvidenceSeal,
} from "@crossengin/access-reviews";

import {
  EVIDENCE_BUNDLE_URI_PREFIX,
  EVIDENCE_COMPILABLE_CAMPAIGN_STATUSES,
  EVIDENCE_COMPILATION_REFUSALS,
  EVIDENCE_RATE_FIELDS,
  EVIDENCE_RATE_SCALE,
  EvidenceCompilationRefusedError,
  compileCampaignEvidence,
  evidenceBundleJson,
  evidenceBundleUri,
  evidenceIdFor,
  isQuantizedEvidenceRate,
  quantizeEvidenceRate,
  sealCompiledEvidence,
  unquantizedEvidenceRates,
  verifyCompiledEvidenceSeal,
} from "./evidence-compilation.js";
import { makeCampaign, makeDecision, makeItem, UUID } from "./fixtures.js";

const NOW = new Date("2026-04-01T00:00:00.000Z");
const PERIOD_START = "2026-01-01T00:00:00.000Z";
const PERIOD_END = "2026-03-31T00:00:00.000Z";

/** A `decided` item, which the contract requires `decidedAt` and a `decisionId` for. */
const decided = (id: string, decisionId: string) =>
  makeItem({ id, status: "decided", decisionId, decidedAt: "2026-01-09T00:00:00.000Z" });

const finished = () =>
  makeCampaign({
    status: "completed",
    startedAt: PERIOD_START,
    completedAt: PERIOD_END,
  });

function compile(
  overrides: Partial<Parameters<typeof compileCampaignEvidence>[0]> = {},
) {
  return compileCampaignEvidence({
    tenantId: UUID.tenant,
    framework: "soc2_type2",
    periodStartAt: PERIOD_START,
    periodEndAt: PERIOD_END,
    campaigns: [finished()],
    items: [],
    decisions: [],
    createdBy: UUID.creator,
    now: NOW,
    ...overrides,
  });
}

describe("quantizeEvidenceRate", () => {
  it("rounds to the storage scale", () => {
    expect(EVIDENCE_RATE_SCALE).toBe(4);
    expect(quantizeEvidenceRate(2 / 3)).toBe(0.6667);
    expect(quantizeEvidenceRate(1 / 3)).toBe(0.3333);
  });

  it("is idempotent, which is what the store's refusal relies on", () => {
    const once = quantizeEvidenceRate(2 / 3);
    expect(quantizeEvidenceRate(once)).toBe(once);
    expect(isQuantizedEvidenceRate(once)).toBe(true);
  });

  it("clamps outside [0, 1] because every column is CHECK-ed to that range", () => {
    expect(quantizeEvidenceRate(1.5)).toBe(1);
    expect(quantizeEvidenceRate(-0.2)).toBe(0);
  });

  it("refuses a non-finite rate rather than storing NaN", () => {
    expect(() => quantizeEvidenceRate(Number.NaN)).toThrow(/not finite/);
    expect(() => quantizeEvidenceRate(Number.POSITIVE_INFINITY)).toThrow(/not finite/);
    expect(isQuantizedEvidenceRate(Number.NaN)).toBe(false);
  });

  it("calls an over-precise rate unquantized", () => {
    expect(isQuantizedEvidenceRate(2 / 3)).toBe(false);
    expect(isQuantizedEvidenceRate(0.5)).toBe(true);
  });

  it("names every rate field, and names only rate fields", () => {
    expect([...EVIDENCE_RATE_FIELDS]).toEqual([
      "completionRate",
      "keepRate",
      "revokeRate",
      "autoRevokeRate",
      "exceptionRate",
      "strongAttestationRate",
      "overdueRate",
    ]);
    expect(new Set(EVIDENCE_RATE_FIELDS).size).toBe(EVIDENCE_RATE_FIELDS.length);
  });

  it("unquantizedEvidenceRates reports each offending field", () => {
    const base = Object.fromEntries(
      EVIDENCE_RATE_FIELDS.map((f) => [f, 0.5]),
    ) as Record<(typeof EVIDENCE_RATE_FIELDS)[number], number>;
    expect(unquantizedEvidenceRates(base)).toEqual([]);
    expect(unquantizedEvidenceRates({ ...base, keepRate: 1 / 3 })).toEqual(["keepRate"]);
  });
});

describe("evidenceIdFor", () => {
  const key = {
    tenantId: UUID.tenant,
    framework: "soc2_type2" as const,
    periodStartAt: PERIOD_START,
    periodEndAt: PERIOD_END,
  };

  it("matches the contract's id pattern", () => {
    expect(evidenceIdFor(key)).toMatch(/^arv_[a-z0-9]{8,32}$/);
  });

  it("is stable for one period, which is what makes a retry idempotent", () => {
    expect(evidenceIdFor(key)).toBe(evidenceIdFor({ ...key }));
  });

  it("separates tenants, frameworks and periods", () => {
    const id = evidenceIdFor(key);
    expect(evidenceIdFor({ ...key, tenantId: UUID.reviewer })).not.toBe(id);
    expect(evidenceIdFor({ ...key, framework: "iso27001" })).not.toBe(id);
    expect(evidenceIdFor({ ...key, periodEndAt: "2026-04-01T00:00:00.000Z" })).not.toBe(id);
  });
});

describe("compileCampaignEvidence", () => {
  it("compiles an empty finished campaign at 100% completion", () => {
    const { evidence } = compile();
    expect(evidence.status).toBe("compiled");
    expect(evidence.completionRate).toBe(1);
    expect(evidence.totalItemsAcrossCampaigns).toBe(0);
    expect(evidence.sealedSha256).toBeNull();
    expect(evidence.storageUri).toBeNull();
  });

  it("parses through the real schema, so the record is contract-valid", () => {
    const { evidence } = compile();
    expect(() => AccessReviewEvidenceSchema.parse(evidence)).not.toThrow();
  });

  it("takes the framework's control mappings from the contract", () => {
    const { evidence } = compile();
    expect(evidence.controlMappings).toEqual([...(CONTROL_MAPPINGS["soc2_type2"] ?? [])]);
  });

  it("quantizes every rate, so the digest and the column agree", () => {
    const items = [
      decided("ari_00000001", "ard_00000001"),
      makeItem({ id: "ari_00000002", status: "pending" }),
      makeItem({ id: "ari_00000003", status: "pending" }),
    ];
    const { evidence } = compile({
      items,
      decisions: [makeDecision({ id: "ard_00000001", itemId: "ari_00000001" })],
    });
    expect(evidence.completionRate).toBe(0.3333);
    expect(unquantizedEvidenceRates(evidence)).toEqual([]);
  });

  it("counts the item's own effective decision, not every decision naming it", () => {
    const items = [decided("ari_00000001", "ard_second01")];
    const { evidence } = compile({
      items,
      decisions: [
        makeDecision({ id: "ard_first001", itemId: "ari_00000001", kind: "keep", reason: "role_appropriate" }),
        makeDecision({
          id: "ard_second01",
          itemId: "ari_00000001",
          kind: "revoke",
          reason: "unused_access_revoked",
          supersedesDecisionId: "ard_first001",
        }),
      ],
    });
    expect(evidence.revokeRate).toBe(1);
    expect(evidence.keepRate).toBe(0);
  });

  it("counts a strong attestation only for the strong kinds", () => {
    const strong = compile({
      items: [decided("ari_00000001", "ard_ssssssss")],
      decisions: [
        makeDecision({
          id: "ard_ssssssss",
          itemId: "ari_00000001",
          attestation: {
            ...makeDecision().attestation,
            kind: "two_person_attestation",
            coAttestingUserId: UUID.manager,
            coAttestedAt: "2026-02-01T00:00:00.000Z",
          },
        }),
      ],
    });
    expect(strong.evidence.strongAttestationRate).toBe(1);
    const weak = compile({
      items: [decided("ari_00000001", "ard_wwwwwwww")],
      decisions: [makeDecision({ id: "ard_wwwwwwww", itemId: "ari_00000001" })],
    });
    expect(weak.evidence.strongAttestationRate).toBe(0);
  });

  it("measures overdue-ness at the period end by default", () => {
    const { evidence } = compile({
      items: [makeItem({ id: "ari_00000001", status: "pending", dueAt: "2026-02-01T00:00:00.000Z" })],
    });
    expect(evidence.overdueRate).toBe(1);
  });

  it("refuses an empty campaign set", () => {
    expect(() => compile({ campaigns: [] })).toThrow(EvidenceCompilationRefusedError);
    try {
      compile({ campaigns: [] });
    } catch (err) {
      expect((err as EvidenceCompilationRefusedError).refusal).toBe("no_campaigns");
    }
  });

  it("refuses a campaign that has not finished", () => {
    try {
      compile({ campaigns: [makeCampaign({ status: "in_progress", startedAt: PERIOD_START })] });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as EvidenceCompilationRefusedError).refusal).toBe("campaign_unfinished");
    }
  });

  it("refuses a cancelled campaign even though it is terminal", () => {
    expect(EVIDENCE_COMPILABLE_CAMPAIGN_STATUSES.has("cancelled")).toBe(false);
    try {
      compile({
        campaigns: [
          makeCampaign({
            status: "cancelled",
            cancelledAt: PERIOD_END,
            cancelledReason: "superseded",
          }),
        ],
      });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as EvidenceCompilationRefusedError).refusal).toBe("campaign_unfinished");
    }
  });

  it("refuses a campaign for another framework", () => {
    try {
      compile({ framework: "iso27001" });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as EvidenceCompilationRefusedError).refusal).toBe("framework_mismatch");
    }
  });

  it("refuses a campaign belonging to another tenant", () => {
    try {
      compile({ tenantId: UUID.reviewer });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as EvidenceCompilationRefusedError).refusal).toBe("tenant_mismatch");
    }
  });

  it("refuses an item from a campaign outside the pack", () => {
    try {
      compile({ items: [makeItem({ campaignId: "arc_elsewhere" })] });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as EvidenceCompilationRefusedError).refusal).toBe("foreign_item");
    }
  });

  it("refuses an inverted period", () => {
    try {
      compile({ periodStartAt: PERIOD_END, periodEndAt: PERIOD_START });
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as EvidenceCompilationRefusedError).refusal).toBe("period_invalid");
    }
  });

  it("names every refusal exactly once", () => {
    expect(new Set(EVIDENCE_COMPILATION_REFUSALS).size).toBe(
      EVIDENCE_COMPILATION_REFUSALS.length,
    );
  });
});

describe("the bundle", () => {
  const items = [
    decided("ari_00000003", "ard_cccccccc"),
    decided("ari_00000001", "ard_aaaaaaaa"),
    makeItem({ id: "ari_00000002", status: "pending" }),
  ];
  const decisions = [
    makeDecision({ id: "ard_aaaaaaaa", itemId: "ari_00000001" }),
    makeDecision({ id: "ard_cccccccc", itemId: "ari_00000003" }),
  ];

  it("is byte-stable under a reordered input, which is why the digest means anything", () => {
    const a = evidenceBundleJson(compile({ items, decisions }).bundle);
    const b = evidenceBundleJson(
      compile({ items: [...items].reverse(), decisions: [...decisions].reverse() }).bundle,
    );
    expect(a).toBe(b);
  });

  it("sorts its item rows by id", () => {
    const { bundle } = compile({ items, decisions });
    expect(bundle.items.map((r) => r.itemId)).toEqual([
      "ari_00000001",
      "ari_00000002",
      "ari_00000003",
    ]);
  });

  it("carries the resolving decision on each item, and null where there is none", () => {
    const { bundle } = compile({ items, decisions });
    expect(bundle.items[0]?.decision?.decisionId).toBe("ard_aaaaaaaa");
    expect(bundle.items[1]?.decision).toBeNull();
  });

  it("changes when an item's status changes, which is the tamper it detects", () => {
    const before = evidenceBundleJson(compile({ items, decisions }).bundle);
    const after = evidenceBundleJson(
      compile({
        items: items.map((i) =>
          i.id === "ari_00000002" ? makeItem({ ...i, status: "withdrawn" }) : i,
        ),
        decisions,
      }).bundle,
    );
    expect(after).not.toBe(before);
  });

  it("names the derivation rather than a blob it does not have", () => {
    const uri = evidenceBundleUri("arv_abcdef01");
    expect(uri.startsWith(EVIDENCE_BUNDLE_URI_PREFIX)).toBe(true);
    expect(uri).toContain("arv_abcdef01");
  });
});

describe("sealCompiledEvidence", () => {
  it("seals with the contract's digest over the compiled record's own bundle", () => {
    const compiled = compile();
    const sealed = sealCompiledEvidence({ compiled, now: NOW });
    expect(sealed.evidence.status).toBe("sealed");
    expect(sealed.evidence.sealedAt).toBe(NOW.toISOString());
    expect(sealed.evidence.sealedSha256).toBe(
      computeEvidenceSealSha256({
        evidence: compiled.evidence,
        bundleBytes: evidenceBundleJson(compiled.bundle),
      }),
    );
  });

  it("defaults storageUri to the derivation reference", () => {
    const sealed = sealCompiledEvidence({ compiled: compile(), now: NOW });
    expect(sealed.evidence.storageUri).toBe(evidenceBundleUri(sealed.evidence.id));
  });

  it("takes a caller's storage URI when the bundle really is stored", () => {
    const sealed = sealCompiledEvidence({
      compiled: compile(),
      now: NOW,
      storageUri: "s3://evidence/q1.json",
    });
    expect(sealed.evidence.storageUri).toBe("s3://evidence/q1.json");
  });

  it("verifies against its own bundle", () => {
    const sealed = sealCompiledEvidence({ compiled: compile(), now: NOW });
    expect(verifyCompiledEvidenceSeal(sealed)).toEqual({ ok: true, reason: null });
  });

  it("fails to verify against a bundle whose rows moved", () => {
    const sealed = sealCompiledEvidence({
      compiled: compile({
        items: [decided("ari_00000001", "ard_aaaaaaaa")],
        decisions: [makeDecision({ id: "ard_aaaaaaaa", itemId: "ari_00000001" })],
      }),
      now: NOW,
    });
    const tampered = {
      ...sealed,
      bundle: {
        ...sealed.bundle,
        items: sealed.bundle.items.map((r) => ({ ...r, status: "withdrawn" as const })),
      },
    };
    expect(verifyCompiledEvidenceSeal(tampered).ok).toBe(false);
  });

  it("refuses to seal twice, because `sealed -> sealed` is not a transition", () => {
    const sealed = sealCompiledEvidence({ compiled: compile(), now: NOW });
    expect(() => sealCompiledEvidence({ compiled: sealed, now: NOW })).toThrow(
      /cannot transition evidence from sealed/,
    );
  });

  it("rounds nothing at seal time, so verifyEvidenceSeal holds at the stored scale", () => {
    const sealed = sealCompiledEvidence({
      compiled: compile({
        items: [
          decided("ari_00000001", "ard_aaaaaaaa"),
          makeItem({ id: "ari_00000002", status: "pending" }),
          makeItem({ id: "ari_00000003", status: "pending" }),
        ],
        decisions: [makeDecision({ id: "ard_aaaaaaaa", itemId: "ari_00000001" })],
      }),
      now: NOW,
    });
    // Round-trip the record through the storage scale and the seal must still verify — the property
    // the quantization exists for.
    const roundTripped = {
      ...sealed,
      evidence: {
        ...sealed.evidence,
        ...Object.fromEntries(
          EVIDENCE_RATE_FIELDS.map((f) => [f, quantizeEvidenceRate(sealed.evidence[f])]),
        ),
      },
    };
    expect(
      verifyEvidenceSeal({
        evidence: roundTripped.evidence,
        bundleBytes: evidenceBundleJson(roundTripped.bundle),
      }),
    ).toEqual({ ok: true, reason: null });
  });
});
