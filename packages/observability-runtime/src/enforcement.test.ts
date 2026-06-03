import { describe, expect, it } from "vitest";
import { IncidentRecordSchema } from "@crossengin/incident-response";
import { KillSwitchSchema } from "@crossengin/feature-flags";
import type { AlertPolicy } from "@crossengin/observability";
import {
  FlagRollbackSchema,
  SEVERITY_TO_ALERT_SEVERITY,
  alertSeverityFor,
  formatIncidentId,
  formatKillSwitchId,
  planIncidentDeclaration,
  planKillSwitchActivation,
  planPageDirective,
} from "./enforcement.js";

const NOW = "2026-06-02T12:00:00.000Z";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001";

const policy: AlertPolicy = {
  id: "default",
  routes: [
    { severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-oncall" }] },
    {
      severity: "P2",
      channels: [{ kind: "slack", channel: "#alerts" }],
    },
  ],
};

describe("severity mapping", () => {
  it("maps every incident severity to an alert severity", () => {
    expect(Object.keys(SEVERITY_TO_ALERT_SEVERITY)).toHaveLength(5);
    expect(alertSeverityFor("sev1")).toBe("P0");
    expect(alertSeverityFor("sev2")).toBe("P1");
    expect(alertSeverityFor("sev5")).toBe("P3");
  });
});

describe("id formatting", () => {
  it("formats incident ids matching INC-YYYY-NNNN", () => {
    expect(formatIncidentId(2026, 42)).toBe("INC-2026-0042");
    expect(formatIncidentId(2026, 42)).toMatch(/^INC-\d{4}-\d{4,8}$/);
  });
  it("formats kill switch ids matching the feature-flag pattern", () => {
    expect(formatKillSwitchId(7)).toBe("fks_auto00000007");
    expect(formatKillSwitchId(7)).toMatch(/^fks_[a-z0-9]{8,40}$/);
  });
  it("rejects invalid sequences", () => {
    expect(() => formatIncidentId(2026, -1)).toThrow();
    expect(() => formatKillSwitchId(-1)).toThrow();
  });
});

describe("FlagRollbackSchema", () => {
  it("accepts a valid rollback", () => {
    expect(
      FlagRollbackSchema.safeParse({ flagId: "ff_checkout01", safeValueJson: "false" }).success,
    ).toBe(true);
  });
  it("rejects invalid JSON", () => {
    expect(
      FlagRollbackSchema.safeParse({ flagId: "ff_checkout01", safeValueJson: "{bad" }).success,
    ).toBe(false);
  });
  it("rejects a malformed flag id", () => {
    expect(
      FlagRollbackSchema.safeParse({ flagId: "checkout", safeValueJson: "false" }).success,
    ).toBe(false);
  });
});

describe("planIncidentDeclaration", () => {
  it("builds a schema-valid declared incident", () => {
    const incident = planIncidentDeclaration({
      incidentId: "INC-2026-0001",
      title: "SLO burn alert",
      severity: "sev2",
      surface: "POST /v1/orders",
      nowIso: NOW,
      declaredBy: "system-slo-enforcer",
      detail: "auto-declared after burst",
    });
    expect(IncidentRecordSchema.safeParse(incident).success).toBe(true);
    expect(incident.status).toBe("declared");
    expect(incident.category).toBe("availability");
    expect(incident.timeline).toHaveLength(1);
    expect(incident.timeline[0]?.metadata).toMatchObject({ surface: "POST /v1/orders" });
  });

  it("honours an explicit category and affected tenants", () => {
    const incident = planIncidentDeclaration({
      incidentId: "INC-2026-0002",
      title: "t",
      severity: "sev1",
      category: "performance",
      surface: "s",
      nowIso: NOW,
      declaredBy: "system",
      affectedTenantIds: ["11111111-1111-1111-1111-111111111111"],
      detail: "d",
    });
    expect(incident.category).toBe("performance");
    expect(incident.affectedTenantIds).toHaveLength(1);
  });
});

describe("planPageDirective", () => {
  it("resolves channels for a mapped severity", () => {
    const page = planPageDirective(policy, "sev2", "INC-2026-0001");
    expect(page).not.toBeNull();
    expect(page?.alertSeverity).toBe("P1");
    expect(page?.channels[0]?.kind).toBe("pagerduty_phone");
  });

  it("returns null when no route exists for the severity", () => {
    expect(planPageDirective(policy, "sev1", "INC-2026-0001")).toBeNull();
  });
});

describe("planKillSwitchActivation", () => {
  it("builds a schema-valid triggered kill switch", () => {
    const ks = planKillSwitchActivation({
      killSwitchId: "fks_auto00000001",
      flagId: "ff_checkout01",
      safeValueJson: "false",
      tenantId: null,
      systemActorUserId: SYSTEM_ACTOR,
      incidentId: "INC-2026-0001",
      nowIso: NOW,
      justification: "SLO enforcement rolled back the checkout flag after a burn.",
    });
    expect(KillSwitchSchema.safeParse(ks).success).toBe(true);
    expect(ks.status).toBe("triggered_active");
    expect(ks.triggerKind).toBe("automated_metric_breach");
    expect(ks.relatedIncidentId).toBe("INC-2026-0001");
    expect(ks.triggeredByUserId).toBe(SYSTEM_ACTOR);
  });

  it("does not require four-eyes for automated breaches", () => {
    const ks = planKillSwitchActivation({
      killSwitchId: "fks_auto00000002",
      flagId: "ff_checkout01",
      safeValueJson: "0",
      tenantId: null,
      systemActorUserId: SYSTEM_ACTOR,
      incidentId: "INC-2026-0003",
      nowIso: NOW,
      justification: "Automated rollback with no human co-signer required here.",
    });
    expect(ks.coTriggeredByUserId).toBeNull();
  });
});
