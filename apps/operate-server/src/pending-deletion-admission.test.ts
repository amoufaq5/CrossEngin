import { describe, expect, it } from "vitest";
import type { AdmissionFinding } from "@crossengin/kernel-pg";
import {
  PENDING_DELETION_ADMISSION_EFFECTS,
  PENDING_DELETION_ADMISSION_MAY_SERVE,
  decidePendingDeletionAdmission,
  pendingDeletionAdmissionMessage,
} from "./pending-deletion-admission.js";

const finding: AdmissionFinding = {
  table: "meta.tenants",
  column: "status",
  shape: "value_set",
  declaredExpression:
    "status IN ('active', 'suspended', 'archived', 'pending_deletion', 'deleted')",
  verdict: "refuses",
  refused: [
    {
      value: "pending_deletion",
      origin: "declared_member",
      constraintName: "tenants_status_check",
    },
  ],
  unevaluated: [],
  detail: 'meta.tenants.status refuses "pending_deletion"',
};

describe("decidePendingDeletionAdmission", () => {
  it("refuses the boot when the gate reads a value this database will not store", () => {
    // The one case where the cost is the thing the state exists for: the gate goes on admitting
    // writes for a tenant whose data is queued for destruction, and nothing in the request path
    // says so.
    expect(
      decidePendingDeletionAdmission({
        deletionRequestRoutes: true,
        tenantStatusGate: true,
        blocking: [finding],
      }),
    ).toBe("refuse_boot");
  });

  it("warns when nothing reads the value, because the behaviour is unchanged by it", () => {
    // ADR-0334's rule: a refusal for a column nothing reads would refuse a deployment whose
    // behaviour the reported fact does not change.
    expect(
      decidePendingDeletionAdmission({
        deletionRequestRoutes: true,
        tenantStatusGate: false,
        blocking: [finding],
      }),
    ).toBe("warn");
  });

  it("is silent when no surface writes the value", () => {
    for (const tenantStatusGate of [true, false]) {
      expect(
        decidePendingDeletionAdmission({
          deletionRequestRoutes: false,
          tenantStatusGate,
          blocking: [finding],
        }),
      ).toBe("silent");
    }
  });

  it("is silent when the database admits it, and when no survey could be taken", () => {
    // The same answer for both deliberately: a failed read establishes nothing, and at boot the
    // database may simply not be up.
    expect(
      decidePendingDeletionAdmission({
        deletionRequestRoutes: true,
        tenantStatusGate: true,
        blocking: [],
      }),
    ).toBe("silent");
  });

  it("serves on every effect but one, through a map rather than a comparison", () => {
    expect(PENDING_DELETION_ADMISSION_EFFECTS).toEqual(["refuse_boot", "warn", "silent"]);
    expect(
      PENDING_DELETION_ADMISSION_EFFECTS.filter((e) => !PENDING_DELETION_ADMISSION_MAY_SERVE[e]),
    ).toEqual(["refuse_boot"]);
  });
});

describe("pendingDeletionAdmissionMessage", () => {
  it("shares the half that names the write, and differs only on what the operator does next", () => {
    const refuse = pendingDeletionAdmissionMessage("refuse_boot", finding);
    const warn = pendingDeletionAdmissionMessage("warn", finding);
    for (const m of [refuse, warn]) {
      expect(m).toContain('refuses "pending_deletion"');
      expect(m).toContain("read-only between verification and the runner's commit");
      expect(m).toContain("the window stays open");
    }
    expect(refuse).toContain("--tenant-status-gate reads it");
    expect(warn).toContain("--tenant-status-gate is off");
  });

  it("names no remedy of its own, because the ALTER has one producer", () => {
    // `admissionRemedy` builds it. Two spellings of the SQL an operator pastes is the one thing
    // this repository has found wrong most often.
    for (const effect of ["refuse_boot", "warn"] as const) {
      expect(pendingDeletionAdmissionMessage(effect, finding)).not.toContain("ALTER TABLE");
    }
  });
});
