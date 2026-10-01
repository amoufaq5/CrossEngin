import { describe, expect, it } from "vitest";
import type {
  BurnRateVerdict,
  EnforcementDecision,
  EnforcementPlan,
  LatencyVerdict,
} from "@crossengin/observability-runtime";
import {
  INCIDENT_CLOSE_OUTS,
  type IncidentCloseOut,
} from "@crossengin/incident-response-runtime";
import {
  SloEnforcementActionRecordSchema,
  SloEvaluationRecordSchema,
  SloLatencyEvaluationRecordSchema,
  enforcementActionFromDecision,
  evaluationRecordFromVerdict,
  generateEnforcementActionId,
  generateEvaluationId,
  generateLatencyEvaluationId,
  latencyEvaluationRecordFromVerdict,
} from "./records.js";

const NOW = "2026-06-02T12:00:00.000Z";
const TENANT = "00000000-0000-4000-8000-000000000001";

const verdict: BurnRateVerdict = {
  breached: true,
  worstSeverity: "sev2",
  worstThresholdId: "fast-burn",
  evaluations: [
    {
      threshold: {
        id: "fast-burn",
        longWindow: "1h",
        shortWindow: "5m",
        burnRateMultiplier: 14.4,
        severity: "sev2",
        minSamples: 20,
      },
      longBurn: 100,
      shortBurn: 100,
      longCounts: { total: 25, failed: 25 },
      shortCounts: { total: 25, failed: 25 },
      firing: true,
    },
  ],
};

function breachOpened(): EnforcementDecision {
  const plan: EnforcementPlan = {
    incident: {
      id: "INC-2026-0001",
      title: "SLO burn",
      severity: "sev2",
      category: "availability",
      status: "declared",
      affectedTenantIds: [],
      affectedRegions: [],
      publiclyVisible: false,
      declaredAt: NOW,
      declaredBy: "system-slo-enforcer",
      ackedAt: null,
      mitigatedAt: null,
      resolvedAt: null,
      closedAt: null,
      cancelledAt: null,
      roleAssignments: [],
      timeline: [
        {
          occurredAt: NOW,
          actorUserId: "system-slo-enforcer",
          kind: "declared",
          message: "auto",
          metadata: {},
        },
      ],
      runbookExecutionIds: [],
      relatedDeploymentIds: [],
      securityIncident: false,
      breachDataClasses: [],
      postmortemId: null,
      autoDeclaredFor: null,
    },
    pages: [
      {
        severity: "sev2",
        alertSeverity: "P1",
        channels: [{ kind: "pagerduty_phone", serviceKey: "svc" }],
        incidentId: "INC-2026-0001",
      },
    ],
    killSwitch: {
      id: "fks_auto00000001",
      tenantId: TENANT,
      flagId: "ff_checkout01",
      status: "triggered_active",
      triggerKind: "automated_metric_breach",
      justification: "SLO enforcement rolled the flag back after a burn on the surface.",
      armedAt: NOW,
      armedByUserId: TENANT,
      triggeredAt: NOW,
      triggeredByUserId: TENANT,
      coTriggeredByUserId: null,
      coTriggeredAt: null,
      expiresAt: null,
      releasedAt: null,
      releasedByUserId: null,
      releasedReason: null,
      expiredAt: null,
      relatedIncidentId: "INC-2026-0001",
      overriddenValueJson: "false",
    },
  };
  return {
    kind: "breach_opened",
    surface: "POST /v1/orders",
    sloId: "orders-availability",
    severity: "sev2",
    verdict,
    plan,
  };
}

function recovered(
  overrides: { readonly closeOut?: IncidentCloseOut } = {},
): EnforcementDecision {
  return {
    kind: "recovered",
    surface: "POST /v1/orders",
    sloId: "orders-availability",
    incidentId: "INC-2026-0001",
    killSwitchId: "fks_auto00000001",
    closeOut: overrides.closeOut ?? "cancelled",
  };
}

const latencyVerdict: LatencyVerdict = {
  breached: true,
  worstSeverity: "sev2",
  worstThresholdId: "latency-page",
  worstPercentile: "p95",
  sampleCount: 30,
  breaches: [
    {
      percentile: "p95",
      observedMs: 700,
      budgetMs: 300,
      thresholdMs: 600,
      multiplier: 2,
      severity: "sev2",
      thresholdId: "latency-page",
    },
  ],
};

function latencyBreachOpened(): EnforcementDecision {
  const opened = breachOpened();
  if (opened.kind !== "breach_opened") throw new Error("unreachable");
  // structurally identical decision shape; reused to exercise the shared projector
  return opened;
}

describe("id generators", () => {
  it("produce ids matching the table patterns", () => {
    expect(generateEvaluationId()).toMatch(/^sloe_[a-z0-9]{8,40}$/);
    expect(generateEnforcementActionId()).toMatch(/^sloa_[a-z0-9]{8,40}$/);
    expect(generateLatencyEvaluationId()).toMatch(/^slle_[a-z0-9]{8,40}$/);
  });
  it("produce distinct ids", () => {
    expect(generateEvaluationId()).not.toBe(generateEvaluationId());
  });
});

describe("latencyEvaluationRecordFromVerdict", () => {
  it("builds a schema-valid latency evaluation record", () => {
    const record = latencyEvaluationRecordFromVerdict({
      sloId: "catalog-latency",
      surface: "GET /v1/catalog",
      tenantId: TENANT,
      verdict: latencyVerdict,
      evaluatedAt: NOW,
    });
    expect(SloLatencyEvaluationRecordSchema.safeParse(record).success).toBe(true);
    expect(record.worstPercentile).toBe("p95");
    expect(record.sampleCount).toBe(30);
    expect(record.breaches).toHaveLength(1);
  });
});

describe("enforcementActionFromDecision signal", () => {
  it("defaults signal to availability", () => {
    const action = enforcementActionFromDecision({
      decision: breachOpened(),
      tenantId: null,
      occurredAt: NOW,
    });
    expect(action.signal).toBe("availability");
  });

  it("tags latency enforcement actions with the latency signal", () => {
    const action = enforcementActionFromDecision({
      decision: latencyBreachOpened(),
      tenantId: null,
      occurredAt: NOW,
      signal: "latency",
    });
    expect(action.signal).toBe("latency");
    expect(SloEnforcementActionRecordSchema.safeParse(action).success).toBe(true);
  });
});

describe("evaluationRecordFromVerdict", () => {
  it("builds a schema-valid evaluation record", () => {
    const record = evaluationRecordFromVerdict({
      sloId: "orders-availability",
      surface: "POST /v1/orders",
      tenantId: TENANT,
      target: 0.99,
      verdict,
      evaluatedAt: NOW,
    });
    expect(SloEvaluationRecordSchema.safeParse(record).success).toBe(true);
    expect(record.breached).toBe(true);
    expect(record.worstSeverity).toBe("sev2");
    expect(record.evaluations).toHaveLength(1);
  });

  it("rejects an out-of-range target", () => {
    expect(() =>
      evaluationRecordFromVerdict({
        sloId: "x",
        surface: "y",
        tenantId: null,
        target: 1.5,
        verdict,
        evaluatedAt: NOW,
      }),
    ).toThrow();
  });
});

describe("enforcementActionFromDecision", () => {
  it("maps a breach_opened decision with incident + kill switch + paging", () => {
    const action = enforcementActionFromDecision({
      decision: breachOpened(),
      tenantId: TENANT,
      occurredAt: NOW,
    });
    expect(SloEnforcementActionRecordSchema.safeParse(action).success).toBe(true);
    expect(action.decision).toBe("breach_opened");
    expect(action.incidentId).toBe("INC-2026-0001");
    expect(action.killSwitchId).toBe("fks_auto00000001");
    expect(action.flagId).toBe("ff_checkout01");
    expect(action.paged).toBe(true);
    expect(action.pageChannelCount).toBe(1);
    expect(action.severity).toBe("sev2");
    expect(action.thresholdId).toBe("fast-burn");
  });

  it("maps a breach_ongoing decision with no kill switch or paging", () => {
    const action = enforcementActionFromDecision({
      decision: {
        kind: "breach_ongoing",
        surface: "POST /v1/orders",
        sloId: "orders-availability",
        incidentId: "INC-2026-0001",
      },
      tenantId: null,
      occurredAt: NOW,
    });
    expect(action.decision).toBe("breach_ongoing");
    expect(action.severity).toBeNull();
    expect(action.killSwitchId).toBeNull();
    expect(action.paged).toBe(false);
    expect(action.pageChannelCount).toBe(0);
  });

  it("maps a recovered decision carrying the kill switch id", () => {
    const action = enforcementActionFromDecision({
      decision: recovered(),
      tenantId: null,
      occurredAt: NOW,
    });
    expect(action.decision).toBe("recovered");
    expect(action.killSwitchId).toBe("fks_auto00000001");
    expect(action.flagId).toBeNull();
  });

  it("leaves a breach_opened action with no close-out", () => {
    const action = enforcementActionFromDecision({
      decision: breachOpened(),
      tenantId: null,
      occurredAt: NOW,
    });
    expect(action.closeOut).toBeNull();
  });

  it("leaves a breach_ongoing action with no close-out", () => {
    const action = enforcementActionFromDecision({
      decision: {
        kind: "breach_ongoing",
        surface: "POST /v1/orders",
        sloId: "orders-availability",
        incidentId: "INC-2026-0001",
      },
      tenantId: null,
      occurredAt: NOW,
    });
    expect(action.closeOut).toBeNull();
  });
});

describe("enforcementActionFromDecision close-out", () => {
  it("carries a cancelled close-out onto the row", () => {
    const action = enforcementActionFromDecision({
      decision: recovered({ closeOut: "cancelled" }),
      tenantId: TENANT,
      occurredAt: NOW,
    });
    expect(action.closeOut).toBe("cancelled");
    expect(SloEnforcementActionRecordSchema.safeParse(action).success).toBe(true);
  });

  it("carries every close-out the declarer can report", () => {
    for (const closeOut of INCIDENT_CLOSE_OUTS) {
      const action = enforcementActionFromDecision({
        decision: recovered({ closeOut }),
        tenantId: null,
        occurredAt: NOW,
      });
      expect(action.closeOut).toBe(closeOut);
    }
  });

  it("carries a failed close-out rather than reporting a clean recovery", () => {
    // The distinction the column exists for: `failed` means the incident row is still open.
    const action = enforcementActionFromDecision({
      decision: recovered({ closeOut: "failed" }),
      tenantId: null,
      occurredAt: NOW,
    });
    expect(action.closeOut).toBe("failed");
  });

  it("carries the close-out through the latency signal too", () => {
    const action = enforcementActionFromDecision({
      decision: recovered({ closeOut: "human_owned" }),
      tenantId: null,
      occurredAt: NOW,
      signal: "latency",
    });
    expect(action.signal).toBe("latency");
    expect(action.closeOut).toBe("human_owned");
  });
});

describe("SloEnforcementActionRecordSchema close-out invariant", () => {
  const base = {
    actionId: "sloa_auto00000001",
    tenantId: null,
    sloId: "orders-availability",
    surface: "POST /v1/orders",
    signal: "availability" as const,
    severity: null,
    incidentId: "INC-2026-0001",
    killSwitchId: null,
    flagId: null,
    paged: false,
    pageChannelCount: 0,
    thresholdId: null,
    occurredAt: NOW,
  };

  it("accepts a recovered row carrying a close-out", () => {
    const parsed = SloEnforcementActionRecordSchema.safeParse({
      ...base,
      decision: "recovered",
      closeOut: "cancelled",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a recovered row with no close-out", () => {
    const parsed = SloEnforcementActionRecordSchema.safeParse({
      ...base,
      decision: "recovered",
      closeOut: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a recovered row that omits the close-out entirely", () => {
    // Omission defaults to null, so the invariant catches it rather than the field being optional.
    const parsed = SloEnforcementActionRecordSchema.safeParse({
      ...base,
      decision: "recovered",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a breach_opened row carrying a close-out", () => {
    const parsed = SloEnforcementActionRecordSchema.safeParse({
      ...base,
      decision: "breach_opened",
      severity: "sev2",
      closeOut: "cancelled",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a breach_ongoing row carrying a close-out", () => {
    const parsed = SloEnforcementActionRecordSchema.safeParse({
      ...base,
      decision: "breach_ongoing",
      closeOut: "failed",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a breach_ongoing row with a null close-out", () => {
    const parsed = SloEnforcementActionRecordSchema.safeParse({
      ...base,
      decision: "breach_ongoing",
      closeOut: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults an omitted close-out to null on a non-recovery", () => {
    const parsed = SloEnforcementActionRecordSchema.parse({
      ...base,
      decision: "breach_ongoing",
    });
    expect(parsed.closeOut).toBeNull();
  });

  it("refuses a close-out outside the declarer's vocabulary", () => {
    const parsed = SloEnforcementActionRecordSchema.safeParse({
      ...base,
      decision: "recovered",
      closeOut: "resolved",
    });
    expect(parsed.success).toBe(false);
  });

  it("reports the contradiction on the closeOut path", () => {
    const parsed = SloEnforcementActionRecordSchema.safeParse({
      ...base,
      decision: "breach_ongoing",
      closeOut: "cancelled",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual(["closeOut"]);
  });
});
