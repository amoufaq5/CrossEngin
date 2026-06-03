import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { columnIndex, columnPlanForEntity } from "./column-plan.js";

const WIDGET: Entity = {
  name: "Widget",
  fields: [
    { name: "sku", type: { kind: "text" }, required: true },
    { name: "price", type: { kind: "decimal", precision: 12, scale: 2 } },
    { name: "ssn", type: { kind: "text" }, classification: "phi" },
    { name: "note", type: { kind: "text" }, classification: "internal" },
    { name: "status", type: { kind: "enum", values: ["active", "archived"] } },
    { name: "owner", type: { kind: "reference", target: "Account" } },
  ],
};

describe("columnPlanForEntity", () => {
  const plan = columnPlanForEntity(WIDGET, { schema: "tenant_app" });

  it("snake-cases the table and carries the schema", () => {
    expect(plan.table).toBe("widget");
    expect(plan.schema).toBe("tenant_app");
  });

  it("maps each field to a typed column", () => {
    const byField = columnIndex(plan);
    expect(byField.get("sku")).toMatchObject({ column: "sku", sqlType: "TEXT", notNull: true });
    expect(byField.get("price")?.sqlType).toBe("NUMERIC(12, 2)");
    expect(byField.get("status")?.sqlType).toBe("TEXT");
  });

  it("suffixes a reference column with _id and types it UUID", () => {
    const owner = columnIndex(plan).get("owner");
    expect(owner?.column).toBe("owner_id");
    expect(owner?.sqlType).toBe("UUID");
  });

  it("flags encrypt-at-rest only for phi/regulated classifications", () => {
    const byField = columnIndex(plan);
    expect(byField.get("ssn")).toMatchObject({ classification: "phi", encryptAtRest: true });
    expect(byField.get("note")).toMatchObject({ classification: "internal", encryptAtRest: false });
    expect(byField.get("sku")).toMatchObject({ classification: null, encryptAtRest: false });
  });

  it("rejects an invalid schema name", () => {
    expect(() => columnPlanForEntity(WIDGET, { schema: "bad; DROP" })).toThrow(/invalid schema/);
  });
});
