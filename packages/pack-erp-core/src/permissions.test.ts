import { EntityPermissionsSchema } from "@crossengin/auth";
import { describe, expect, it } from "vitest";

import { ACCOUNT_PERMISSIONS, ERP_CORE_PERMISSIONS, INVOICE_PERMISSIONS } from "./permissions.js";

describe("ACCOUNT_PERMISSIONS", () => {
  it("parses", () => {
    expect(() => EntityPermissionsSchema.parse(ACCOUNT_PERMISSIONS)).not.toThrow();
  });

  it("admin-only delete", () => {
    expect(ACCOUNT_PERMISSIONS.delete?.roles).toEqual(["erp_admin"]);
  });

  it("viewer can list and read", () => {
    expect(ACCOUNT_PERMISSIONS.list?.roles).toContain("erp_viewer");
    expect(ACCOUNT_PERMISSIONS.read?.roles).toContain("erp_viewer");
  });

  it("viewer cannot create / update / delete", () => {
    expect(ACCOUNT_PERMISSIONS.create?.roles).not.toContain("erp_viewer");
    expect(ACCOUNT_PERMISSIONS.update?.roles).not.toContain("erp_viewer");
    expect(ACCOUNT_PERMISSIONS.delete?.roles).not.toContain("erp_viewer");
  });
});

describe("INVOICE_PERMISSIONS", () => {
  it("has transitions for send / mark_paid / mark_overdue / void", () => {
    const t = INVOICE_PERMISSIONS.transitions;
    expect(Object.keys(t ?? {}).sort()).toEqual(["mark_overdue", "mark_paid", "send", "void"]);
  });

  it("void is admin-only", () => {
    expect(INVOICE_PERMISSIONS.transitions?.["void"]?.roles).toEqual(["erp_admin"]);
  });
});

describe("ERP_CORE_PERMISSIONS", () => {
  it("covers all 4 entities", () => {
    expect(Object.keys(ERP_CORE_PERMISSIONS).sort()).toEqual([
      "Account",
      "Contact",
      "Invoice",
      "InvoiceLine",
    ]);
  });
});
