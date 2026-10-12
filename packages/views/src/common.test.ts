import { describe, expect, it } from "vitest";
import {
  FieldPathSchema,
  LocalizedTextSchema,
  PermissionRefSchema,
  ViewFilterSchema,
  ViewIdSchema,
  ViewSortSchema,
} from "./common.js";

describe("ViewIdSchema", () => {
  it("accepts camelCase", () => {
    expect(() => ViewIdSchema.parse("prescriptionInbox")).not.toThrow();
  });

  it("rejects uppercase first letter", () => {
    expect(() => ViewIdSchema.parse("Prescription")).toThrow();
  });
});

describe("FieldPathSchema", () => {
  it("accepts dotted lowercase paths", () => {
    expect(() => FieldPathSchema.parse("patient.name")).not.toThrow();
    expect(() => FieldPathSchema.parse("a.b.c")).not.toThrow();
  });

  it("rejects uppercase segments", () => {
    expect(() => FieldPathSchema.parse("Patient.Name")).toThrow();
  });
});

describe("LocalizedTextSchema", () => {
  it("accepts BCP-47 locale keys", () => {
    expect(() =>
      LocalizedTextSchema.parse({ en: "Hi", "ar-AE": "مرحبا" }),
    ).not.toThrow();
  });
});

describe("PermissionRefSchema", () => {
  it("accepts the literal 'inherit'", () => {
    expect(PermissionRefSchema.parse("inherit")).toBe("inherit");
  });

  it("accepts an explicit grant", () => {
    const r = PermissionRefSchema.parse({ roles: ["pharmacist"] });
    expect(r).toEqual({ roles: ["pharmacist"] });
  });

  it("rejects an empty role list", () => {
    expect(() => PermissionRefSchema.parse({ roles: [] })).toThrow();
  });

  // A view cannot carry an ABAC obligation, and this pins it rather than merely not testing it.
  // `surveyAbacObligations` walks `manifest.permissions` and nothing else, and the boot refusal for
  // an obligation this deployment cannot discharge is built from that survey — so a key here would
  // be an obligation no deployment could discharge and no boot check could see, served with its
  // qualifier silently removed. Zero views in any pack ever declared one.
  it("strips an abac key rather than carrying an obligation nothing surveys", () => {
    expect(PermissionRefSchema.parse({ roles: ["pharmacist"], abac: "same_department" })).toEqual({
      roles: ["pharmacist"],
    });
  });
});

describe("ViewFilterSchema", () => {
  it("accepts eq with value", () => {
    expect(() =>
      ViewFilterSchema.parse({ field: "status", operator: "eq", value: "active" }),
    ).not.toThrow();
  });

  it("rejects in without values", () => {
    expect(() =>
      ViewFilterSchema.parse({ field: "status", operator: "in" }),
    ).toThrow(/non-empty 'values' array/);
  });
});

describe("ViewSortSchema", () => {
  it("defaults direction to asc", () => {
    const s = ViewSortSchema.parse({ field: "createdAt" });
    expect(s.direction).toBe("asc");
  });
});
