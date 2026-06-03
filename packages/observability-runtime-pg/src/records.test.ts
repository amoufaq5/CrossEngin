import { describe, expect, it } from "vitest";
import type {
  BurnRateVerdict,
  EnforcementDecision,
  EnforcementPlan,
} from "@crossengin/observability-runtime";
import {
  SloEnforcementActionRecordSchema,
  SloEvaluationRecordSchema,
  enforcementActionFromDecision,
  evaluationRecordFromVerdict,
  generateEnforcementActionId,
  generateEvaluationId,
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

describe("id generators", () => {
  it("produce ids matching the table patterns", () => {
    expect(generateEvaluationId()).toMatch(/^sloe_[a-z0-9]{8,40}$/);
    expect(generateEnforcementActionId()).toMatch(/^sloa_[a-z0-9]{8,40}$/);
  });
  it("produce distinct ids", () => {
    expect(generateEvaluationId()).not.toBe(generateEvaluationId());
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
      decision: {
        kind: "recovered",
        surface: "POST /v1/orders",
        sloId: "orders-availability",
        incidentId: "INC-2026-0001",
        killSwitchId: "fks_auto00000001",
      },
      tenantId: null,
      occurredAt: NOW,
    });
    expect(action.decision).toBe("recovered");
    expect(action.killSwitchId).toBe("fks_auto00000001");
    expect(action.flagId).toBeNull();
  });
});
