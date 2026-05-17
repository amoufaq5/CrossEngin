import { describe, expect, it } from "vitest";
import {
  IncidentRecordSchema,
  notificationOverdueHours,
  SECURITY_SEVERITY_DESCRIPTIONS,
} from "./incidents.js";

const now = "2026-05-13T10:00:00.000Z";

describe("IncidentRecordSchema", () => {
  it("parses a P2 single-feature outage record", () => {
    const i = IncidentRecordSchema.parse({
      id: "i_1",
      severity: "P2",
      kind: "service_outage",
      title: "Slow search typeahead",
      detectedAt: now,
      containedAt: null,
      resolvedAt: null,
      customerNotification: {
        required: false,
        status: "not_required",
        completedAt: null,
      },
    });
    expect(i.severity).toBe("P2");
  });

  it("rejects P0 with empty affectedTenantIds", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        id: "i_1",
        severity: "P0",
        kind: "cross_tenant_data_access",
        title: "Cross-tenant leak",
        detectedAt: now,
        containedAt: null,
        resolvedAt: null,
        affectedTenantIds: [],
        customerNotification: {
          required: true,
          status: "pending",
          completedAt: null,
        },
      }),
    ).toThrow(/affected tenant/);
  });

  it("rejects P0 with customerNotification.required=false", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        id: "i_1",
        severity: "P0",
        kind: "cross_tenant_data_access",
        title: "Cross-tenant leak",
        detectedAt: now,
        containedAt: null,
        resolvedAt: null,
        affectedTenantIds: ["t_1"],
        customerNotification: {
          required: false,
          status: "not_required",
          completedAt: null,
        },
      }),
    ).toThrow(/always require customer notification/);
  });

  it("rejects containedAt > resolvedAt", () => {
    expect(() =>
      IncidentRecordSchema.parse({
        id: "i_1",
        severity: "P2",
        kind: "service_outage",
        title: "x",
        detectedAt: "2026-05-13T10:00:00.000Z",
        containedAt: "2026-05-13T12:00:00.000Z",
        resolvedAt: "2026-05-13T11:00:00.000Z",
        customerNotification: {
          required: false,
          status: "not_required",
          completedAt: null,
        },
      }),
    ).toThrow(/containedAt must be <= resolvedAt/);
  });

  it("supports optional regulator notification", () => {
    const i = IncidentRecordSchema.parse({
      id: "i_1",
      severity: "P0",
      kind: "data_loss",
      title: "Partial data loss",
      detectedAt: now,
      containedAt: now,
      resolvedAt: null,
      affectedTenantIds: ["t_1"],
      affectedDataClasses: ["phi"],
      customerNotification: {
        required: true,
        status: "in_progress",
        completedAt: null,
      },
      regulatorNotification: {
        regulator: "HHS OCR",
        slaHours: 60 * 24,
        status: "pending",
        completedAt: null,
      },
    });
    expect(i.regulatorNotification?.regulator).toBe("HHS OCR");
  });
});

describe("notificationOverdueHours", () => {
  const fixed = new Date("2026-05-13T20:00:00.000Z");

  it("returns null when notification is not required", () => {
    const i = IncidentRecordSchema.parse({
      id: "i_1",
      severity: "P2",
      kind: "service_outage",
      title: "x",
      detectedAt: now,
      containedAt: null,
      resolvedAt: null,
      customerNotification: {
        required: false,
        status: "not_required",
        completedAt: null,
      },
    });
    expect(notificationOverdueHours(i, fixed)).toBeNull();
  });

  it("returns hours overdue when past SLA", () => {
    const i = IncidentRecordSchema.parse({
      id: "i_1",
      severity: "P0",
      kind: "credential_compromise_user",
      title: "Compromise",
      detectedAt: "2026-05-12T10:00:00.000Z",
      containedAt: null,
      resolvedAt: null,
      affectedTenantIds: ["t_1"],
      customerNotification: {
        required: true,
        status: "pending",
        slaHours: 24,
        completedAt: null,
      },
    });
    const overdue = notificationOverdueHours(i, fixed);
    expect(overdue).not.toBeNull();
    expect(overdue!).toBeGreaterThan(0);
  });

  it("returns null after notification completion", () => {
    const i = IncidentRecordSchema.parse({
      id: "i_1",
      severity: "P0",
      kind: "data_loss",
      title: "Data loss",
      detectedAt: "2026-05-12T10:00:00.000Z",
      containedAt: now,
      resolvedAt: null,
      affectedTenantIds: ["t_1"],
      customerNotification: {
        required: true,
        status: "completed",
        slaHours: 24,
        completedAt: now,
      },
    });
    expect(notificationOverdueHours(i, fixed)).toBeNull();
  });
});

describe("SECURITY_SEVERITY_DESCRIPTIONS", () => {
  it("describes each tier", () => {
    expect(SECURITY_SEVERITY_DESCRIPTIONS.P0).toContain("Tenant data leak");
    expect(SECURITY_SEVERITY_DESCRIPTIONS.P1).toContain("5 minutes");
  });
});
