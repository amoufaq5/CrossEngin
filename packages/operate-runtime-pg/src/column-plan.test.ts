import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  columnIndex,
  columnPlanForEntity,
  columnPlansForManifest,
  referencedEntities,
  relationDeleteIndex,
  topologicalEntityOrder,
} from "./column-plan.js";

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

  it("suffixes a reference column with _id, types it TEXT (matches TEXT id), and records the target", () => {
    const owner = columnIndex(plan).get("owner");
    expect(owner?.column).toBe("owner_id");
    expect(owner?.sqlType).toBe("TEXT");
    expect(owner?.referenceTarget).toBe("Account");
    expect(columnIndex(plan).get("sku")?.referenceTarget).toBeNull();
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

const ACCOUNT: Entity = { name: "Account", fields: [{ name: "name", type: { kind: "text" } }] };
const LINE: Entity = {
  name: "OrderLine",
  fields: [
    { name: "qty", type: { kind: "integer" } },
    { name: "order", type: { kind: "reference", target: "Order" } },
  ],
};
const ORDER: Entity = {
  name: "Order",
  fields: [{ name: "account", type: { kind: "reference", target: "Account" } }],
};

function plansOf(...entities: Entity[]): ReturnType<typeof columnPlansForManifest> {
  return columnPlansForManifest({ entities } as unknown as Manifest, { schema: "tenant_app" });
}

describe("referencedEntities", () => {
  it("lists distinct reference targets", () => {
    const plan = columnPlanForEntity(ORDER, { schema: "tenant_app" });
    expect(referencedEntities(plan)).toEqual(["Account"]);
  });
});

describe("relationDeleteIndex", () => {
  it("indexes many_to_one onDelete policies by <from>.<field>", () => {
    const manifest = {
      relations: [
        { kind: "many_to_one", from: "Order", field: "account", to: "Account", onDelete: "cascade" },
        { kind: "many_to_one", from: "OrderLine", field: "order", to: "Order", onDelete: "set_null" },
        { kind: "many_to_one", from: "X", field: "y", to: "Y" }, // no onDelete → not indexed
        { kind: "one_to_many", from: "Account", field: "orders", to: "Order" }, // not a FK-bearing side
      ],
    } as unknown as Manifest;
    const index = relationDeleteIndex(manifest);
    expect(index.get("Order.account")).toBe("cascade");
    expect(index.get("OrderLine.order")).toBe("set_null");
    expect(index.has("X.y")).toBe(false);
    expect(index.has("Account.orders")).toBe(false);
  });
});

describe("topologicalEntityOrder", () => {
  it("orders a referenced entity before the entity that references it", () => {
    const order = topologicalEntityOrder(plansOf(LINE, ORDER, ACCOUNT));
    expect(order.indexOf("Account")).toBeLessThan(order.indexOf("Order"));
    expect(order.indexOf("Order")).toBeLessThan(order.indexOf("OrderLine"));
  });

  it("ignores references to entities not in the set", () => {
    // OrderLine → Order, but Order absent ⇒ no constraint on ordering
    const order = topologicalEntityOrder(plansOf(LINE, ACCOUNT));
    expect(order).toContain("OrderLine");
    expect(order).toContain("Account");
    expect(order).toHaveLength(2);
  });

  it("returns all nodes even with a reference cycle", () => {
    const a: Entity = { name: "A", fields: [{ name: "b", type: { kind: "reference", target: "B" } }] };
    const b: Entity = { name: "B", fields: [{ name: "a", type: { kind: "reference", target: "A" } }] };
    const order = topologicalEntityOrder(plansOf(a, b));
    expect([...order].sort()).toEqual(["A", "B"]);
  });
});
