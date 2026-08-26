import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  columnIndex,
  columnPlanForEntity,
  columnPlansForManifest,
  joinTablePlansForManifest,
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

describe("joinTablePlansForManifest", () => {
  it("derives a join table per many_to_many with <left>_id / <right>_id columns", () => {
    const manifest = {
      relations: [
        { kind: "many_to_many", left: "Course", right: "Student" },
        { kind: "many_to_one", from: "X", field: "y", to: "Y" }, // ignored
      ],
    } as unknown as Manifest;
    const plans = joinTablePlansForManifest(manifest, { schema: "tenant_app" });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      table: "course_student",
      leftEntity: "Course",
      rightEntity: "Student",
      leftColumn: "course_id",
      rightColumn: "student_id",
    });
  });

  it("disambiguates a self many_to_many with _left_id / _right_id", () => {
    const manifest = { relations: [{ kind: "many_to_many", left: "Person", right: "Person" }] } as unknown as Manifest;
    const plan = joinTablePlansForManifest(manifest, { schema: "tenant_app" })[0]!;
    expect(plan.table).toBe("person_person");
    expect(plan.leftColumn).toBe("person_left_id");
    expect(plan.rightColumn).toBe("person_right_id");
  });

  it("emits a duplicate relation's table once", () => {
    const manifest = {
      relations: [
        { kind: "many_to_many", left: "A", right: "B" },
        { kind: "many_to_many", left: "A", right: "B" },
      ],
    } as unknown as Manifest;
    expect(joinTablePlansForManifest(manifest, { schema: "tenant_app" })).toHaveLength(1);
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

describe("columnPlanForEntity — trait fields", () => {
  const AUDITED: Entity = {
    name: "Visit",
    traits: ["auditable"],
    fields: [{ name: "reason", type: { kind: "text" } }],
  };

  it("plans a column for every field the entity resolves to, traits included", () => {
    const plan = columnPlanForEntity(AUDITED, { schema: "app" });
    expect(plan.columns.map((c) => c.field)).toEqual([
      "reason",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
    ]);
  });

  it("carries the trait's expression default so a NOT NULL column can be inserted into", () => {
    const byField = columnIndex(columnPlanForEntity(AUDITED, { schema: "app" }));
    expect(byField.get("created_at")).toMatchObject({
      sqlType: "TIMESTAMPTZ",
      notNull: true,
      defaultSql: "now()",
    });
    expect(byField.get("created_by")).toMatchObject({ sqlType: "UUID", notNull: false, defaultSql: null });
  });

  it("carries a literal default", () => {
    const versioned: Entity = { name: "Doc", traits: ["versioned"], fields: [] };
    const byField = columnIndex(columnPlanForEntity(versioned, { schema: "app" }));
    expect(byField.get("version")).toMatchObject({ notNull: true, defaultSql: "1" });
  });

  it("emits no default for a sequence-defaulted field, which the runtime allocates", () => {
    const seq: Entity = {
      name: "Inv",
      fields: [
        {
          name: "number",
          type: { kind: "text" },
          default: { kind: "sequence", sequence: "inv" },
        },
      ],
    };
    expect(columnPlanForEntity(seq, { schema: "app" }).columns[0]?.defaultSql).toBeNull();
  });

  it("expands a manifest-declared custom trait through columnPlansForManifest", () => {
    const manifest = {
      manifestVersion: "1.0",
      meta: { slug: "s", name: "n", version: "1.0.0" },
      traits: [{ name: "geocoded", fields: [{ name: "lat", type: { kind: "decimal", precision: 9, scale: 6 } }] }],
      entities: [{ name: "Site", traits: ["geocoded"], fields: [{ name: "label", type: { kind: "text" } }] }],
    } as unknown as Manifest;
    const plan = columnPlansForManifest(manifest, { schema: "app" }).get("Site");
    expect(plan?.columns.map((c) => c.field)).toEqual(["label", "lat"]);
  });

  it("keeps the entity's own field when a trait supplies the same name", () => {
    const shadowed: Entity = {
      name: "Visit",
      traits: ["versioned"],
      fields: [{ name: "version", type: { kind: "text" } }],
    };
    const cols = columnPlanForEntity(shadowed, { schema: "app" }).columns;
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ field: "version", sqlType: "TEXT" });
  });
});
