import { EntityPermissionsSchema } from "@crossengin/auth";
import { describe, expect, it } from "vitest";

import { ERP_PAYMENTS_PERMISSIONS, PAYMENT_PERMISSIONS } from "./permissions.js";

describe("PAYMENT_PERMISSIONS", () => {
  it("parses against EntityPermissionsSchema", () => {
    expect(() => EntityPermissionsSchema.parse(PAYMENT_PERMISSIONS)).not.toThrow();
  });

  it("refund is admin-only", () => {
    expect(PAYMENT_PERMISSIONS.transitions?.["refund"]?.roles).toEqual(["erp_admin"]);
  });

  it("delete is admin-only", () => {
    expect(PAYMENT_PERMISSIONS.delete?.roles).toEqual(["erp_admin"]);
  });

  it("accountants can capture / settle / fail / cancel (not refund)", () => {
    const t = PAYMENT_PERMISSIONS.transitions;
    expect(t?.["capture"]?.roles).toContain("erp_accountant");
    expect(t?.["settle"]?.roles).toContain("erp_accountant");
    expect(t?.["fail"]?.roles).toContain("erp_accountant");
    expect(t?.["cancel"]?.roles).toContain("erp_accountant");
    expect(t?.["refund"]?.roles).not.toContain("erp_accountant");
  });

  it("viewers can list + read but not write", () => {
    expect(PAYMENT_PERMISSIONS.list?.roles).toContain("erp_viewer");
    expect(PAYMENT_PERMISSIONS.read?.roles).toContain("erp_viewer");
    expect(PAYMENT_PERMISSIONS.create?.roles).not.toContain("erp_viewer");
    expect(PAYMENT_PERMISSIONS.delete?.roles).not.toContain("erp_viewer");
  });
});

describe("ERP_PAYMENTS_PERMISSIONS", () => {
  it("covers only the Payment entity (the rest are merged from core)", () => {
    expect(Object.keys(ERP_PAYMENTS_PERMISSIONS)).toEqual(["Payment"]);
  });
});
