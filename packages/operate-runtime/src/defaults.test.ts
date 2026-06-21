import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { applyLiteralDefaults, literalDefaultPlans } from "./defaults.js";

const ENTITY: Entity = {
  name: "Invoice",
  traits: ["auditable"],
  fields: [
    { name: "total", type: { kind: "decimal", precision: 14, scale: 2 }, required: true },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "sent", "paid"] },
      required: true,
      default: { kind: "literal", value: "draft" },
    },
    { name: "is_active", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: true } },
    {
      name: "number",
      type: { kind: "text", maxLength: 40 },
      required: true,
      default: { kind: "sequence", sequence: "erp.invoice", format: "INV-{SEQ:5}" },
    },
  ],
};

describe("literalDefaultPlans", () => {
  it("extracts only literal defaults (not sequences)", () => {
    const plans = literalDefaultPlans(ENTITY);
    expect(plans.map((p) => p.field)).toEqual(["state", "is_active"]);
    expect(plans.find((p) => p.field === "state")?.value).toBe("draft");
  });
});

describe("applyLiteralDefaults", () => {
  const plans = literalDefaultPlans(ENTITY);

  it("fills omitted fields with their declared default", () => {
    const out = applyLiteralDefaults({ total: 10 }, plans);
    expect(out.state).toBe("draft");
    expect(out.is_active).toBe(true);
    expect(out.total).toBe(10);
  });

  it("never overrides a caller-supplied value, including explicit null", () => {
    const out = applyLiteralDefaults({ state: "sent", is_active: null }, plans);
    expect(out.state).toBe("sent");
    expect(out.is_active).toBeNull();
  });

  it("is a no-op with no plans", () => {
    const rec = { a: 1 };
    expect(applyLiteralDefaults(rec, [])).toBe(rec);
  });
});
