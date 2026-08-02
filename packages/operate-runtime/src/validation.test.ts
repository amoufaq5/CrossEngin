import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import { buildValidationPlans, validateBody, type EntityValidationPlan } from "./validation.js";

const plan: EntityValidationPlan = [
  { name: "sku", required: true, kind: "text", maxLength: 8, serverManaged: false },
  { name: "name", required: true, kind: "text", serverManaged: false },
  { name: "qty", required: false, kind: "integer", serverManaged: false },
  { name: "price", required: true, kind: "decimal", serverManaged: false },
  { name: "active", required: false, kind: "boolean", serverManaged: false },
  { name: "email", required: false, kind: "email", serverManaged: false },
  { name: "status", required: true, kind: "enum", enumValues: ["open", "closed"], serverManaged: false },
  { name: "doc_no", required: true, kind: "text", serverManaged: true },
];

describe("validateBody — create", () => {
  const good = { sku: "S1", name: "A", price: 9.5, status: "open" };

  it("accepts a complete valid body", () => {
    expect(validateBody(plan, good, "create")).toEqual([]);
  });

  it("flags missing required fields", () => {
    const errs = validateBody(plan, { name: "A", price: 1, status: "open" }, "create");
    expect(errs).toEqual([{ field: "sku", code: "required", message: "sku is required" }]);
  });

  it("treats an empty string as missing for a required field", () => {
    const errs = validateBody(plan, { ...good, sku: "" }, "create");
    expect(errs.map((e) => e.code)).toEqual(["required"]);
  });

  it("does not require a server-managed (sequence) field", () => {
    // doc_no is required but serverManaged → never demanded from the client.
    expect(validateBody(plan, good, "create")).toEqual([]);
  });

  it("rejects a bad enum value", () => {
    const errs = validateBody(plan, { ...good, status: "pending" }, "create");
    expect(errs).toEqual([{ field: "status", code: "enum", message: "status must be one of: open, closed" }]);
  });

  it("rejects a non-numeric number and a non-integer integer", () => {
    expect(validateBody(plan, { ...good, price: "abc" }, "create").map((e) => e.code)).toEqual(["type"]);
    expect(validateBody(plan, { ...good, qty: 1.5 }, "create")[0]?.message).toContain("whole number");
  });

  it("accepts a numeric string for a number field", () => {
    expect(validateBody(plan, { ...good, price: "12.5" }, "create")).toEqual([]);
  });

  it("rejects a non-boolean boolean and a malformed email", () => {
    expect(validateBody(plan, { ...good, active: "yes" }, "create").map((e) => e.field)).toEqual(["active"]);
    expect(validateBody(plan, { ...good, email: "nope" }, "create").map((e) => e.field)).toEqual(["email"]);
  });

  it("enforces maxLength", () => {
    const errs = validateBody(plan, { ...good, sku: "TOOLONGSKU" }, "create");
    expect(errs).toEqual([{ field: "sku", code: "maxLength", message: "sku must be at most 8 characters" }]);
  });
});

describe("validateBody — update (partial)", () => {
  it("does not require absent fields", () => {
    expect(validateBody(plan, { name: "B" }, "update")).toEqual([]);
  });

  it("errors when a required field is explicitly emptied", () => {
    expect(validateBody(plan, { sku: "" }, "update")).toEqual([
      { field: "sku", code: "required", message: "sku is required" },
    ]);
  });

  it("still type-checks a present field", () => {
    expect(validateBody(plan, { status: "bogus" }, "update").map((e) => e.code)).toEqual(["enum"]);
  });
});

describe("buildValidationPlans", () => {
  it("distills rules from the manifest field schema", () => {
    const manifest = {
      entities: [
        {
          name: "Widget",
          fields: [
            { name: "code", type: { kind: "text", maxLength: 10 }, required: true },
            { name: "state", type: { kind: "enum", values: ["a", "b"] }, required: true },
            { name: "seq", type: { kind: "text" }, required: true, default: { kind: "sequence" } },
          ],
        },
      ],
    } as unknown as Manifest;
    const rules = buildValidationPlans(manifest).get("Widget")!;
    expect(rules.find((r) => r.name === "code")).toMatchObject({ required: true, kind: "text", maxLength: 10 });
    expect(rules.find((r) => r.name === "state")).toMatchObject({ enumValues: ["a", "b"] });
    expect(rules.find((r) => r.name === "seq")?.serverManaged).toBe(true);
  });
});
