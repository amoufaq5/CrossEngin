import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_GATES,
  ConfirmationRecordSchema,
  GATE_PROPERTIES,
  requiresBulkConfirmation,
  validateConfirmation,
} from "./gates.js";

const now = "2026-05-13T10:00:00.000Z";

describe("CONFIRMATION_GATES + GATE_PROPERTIES", () => {
  it("declares the nine documented gates", () => {
    expect(CONFIRMATION_GATES).toHaveLength(9);
    expect(CONFIRMATION_GATES).toContain("compliance_pack_deactivation");
    expect(CONFIRMATION_GATES).toContain("low_confidence_apply");
  });

  it("compliance_pack_deactivation has a 90-day cooldown + reason requirement", () => {
    const props = GATE_PROPERTIES.compliance_pack_deactivation;
    expect(props.cooldownDays).toBe(90);
    expect(props.requiresReason).toBe(true);
  });

  it("residency_profile_change requires reason + 7-day wait", () => {
    const props = GATE_PROPERTIES.residency_profile_change;
    expect(props.cooldownDays).toBe(7);
    expect(props.requiresReason).toBe(true);
  });

  it("cross_pack_conflicting_permission requires compliance_officer", () => {
    expect(GATE_PROPERTIES.cross_pack_conflicting_permission.minPrincipalRole).toBe(
      "compliance_officer",
    );
  });
});

describe("requiresBulkConfirmation", () => {
  it("returns true past the 100-record delete threshold", () => {
    expect(requiresBulkConfirmation({ deleteRecords: 101 })).toBe(true);
    expect(requiresBulkConfirmation({ deleteRecords: 100 })).toBe(false);
  });

  it("returns true past the 1000-record update threshold", () => {
    expect(requiresBulkConfirmation({ updateRecords: 1001 })).toBe(true);
  });

  it("returns true past the 10-orchestration cancel threshold", () => {
    expect(requiresBulkConfirmation({ cancelOrchestrations: 11 })).toBe(true);
  });
});

describe("ConfirmationRecordSchema + validateConfirmation", () => {
  it("parses a typical confirmation record", () => {
    expect(() =>
      ConfirmationRecordSchema.parse({
        gate: "destructive_manifest_change",
        tenantId: "t_1",
        confirmedByUserId: "u_admin",
        confirmedAt: now,
        acknowledgement: "I understand this will permanently affect Prescription records",
      }),
    ).not.toThrow();
  });

  it("validateConfirmation rejects gate mismatches", () => {
    const record = ConfirmationRecordSchema.parse({
      gate: "destructive_manifest_change",
      tenantId: "t_1",
      confirmedByUserId: "u_admin",
      confirmedAt: now,
      acknowledgement: "ack",
    });
    expect(() => validateConfirmation("compliance_pack_deactivation", record)).toThrow(
      /confirmation gate mismatch/,
    );
  });

  it("validateConfirmation rejects missing reason when required", () => {
    const record = ConfirmationRecordSchema.parse({
      gate: "compliance_pack_deactivation",
      tenantId: "t_1",
      confirmedByUserId: "u_admin",
      confirmedAt: now,
      acknowledgement: "ack",
    });
    expect(() => validateConfirmation("compliance_pack_deactivation", record)).toThrow(
      /requires an explicit reason/,
    );
  });

  it("validateConfirmation passes when reason is supplied", () => {
    const record = ConfirmationRecordSchema.parse({
      gate: "compliance_pack_deactivation",
      tenantId: "t_1",
      confirmedByUserId: "u_admin",
      confirmedAt: now,
      acknowledgement: "ack",
      reason: "we are no longer running clinical trials under FDA jurisdiction",
    });
    expect(() => validateConfirmation("compliance_pack_deactivation", record)).not.toThrow();
  });
});
