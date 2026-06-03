import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { columnPlanForEntity, joinTablePlansForManifest } from "./column-plan.js";
import type { Manifest } from "@crossengin/kernel/manifest";
import { emitEntityTableDdl, emitForeignKeyDdl, emitJoinTableDdl, onDeleteClause } from "./entity-ddl.js";

const WIDGET: Entity = {
  name: "Widget",
  fields: [
    { name: "sku", type: { kind: "text" }, required: true },
    { name: "price", type: { kind: "decimal", precision: 12, scale: 2 } },
    { name: "ssn", type: { kind: "text" }, classification: "phi" },
    { name: "cost", type: { kind: "decimal", precision: 12, scale: 2 }, classification: "commercial_sensitive" },
  ],
};

describe("emitEntityTableDdl", () => {
  const sql = emitEntityTableDdl(columnPlanForEntity(WIDGET, { schema: "tenant_app" })).join("\n");

  it("creates the table idempotently with system + typed domain columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "tenant_app"."widget"');
    expect(sql).toContain('"tenant_id" UUID NOT NULL');
    expect(sql).toContain('"id" TEXT NOT NULL');
    expect(sql).toContain('"sku" TEXT NOT NULL');
    expect(sql).toContain('"price" NUMERIC(12, 2)');
    expect(sql).toContain('PRIMARY KEY ("tenant_id", "id")');
  });

  it("stores an encrypt-at-rest (phi) column as BYTEA, not its plaintext type", () => {
    expect(sql).toContain('"ssn" BYTEA');
    expect(sql).not.toContain('"ssn" TEXT');
  });

  it("enables RLS with an idempotent tenant-isolation policy", () => {
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain('DROP POLICY IF EXISTS "widget_tenant_isolation"');
    expect(sql).toContain("current_setting('app.current_tenant_id', true)::UUID");
  });

  it("creates a tenant index idempotently", () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_widget_tenant"');
  });

  it("writes classification comments (with encrypt=at_rest for phi)", () => {
    expect(sql).toContain(`COMMENT ON COLUMN "tenant_app"."widget"."ssn" IS 'crossengin.data_class=phi; crossengin.encrypt=at_rest'`);
    expect(sql).toContain(`COMMENT ON COLUMN "tenant_app"."widget"."cost" IS 'crossengin.data_class=commercial_sensitive'`);
  });

  it("does not comment unclassified columns", () => {
    expect(sql).not.toContain(`"sku" IS 'crossengin`);
  });
});

describe("emitForeignKeyDdl", () => {
  const ORDER: Entity = {
    name: "Order",
    fields: [
      { name: "account", type: { kind: "reference", target: "Account" } },
      { name: "note", type: { kind: "text" } },
    ],
  };
  const plan = columnPlanForEntity(ORDER, { schema: "tenant_app" });

  it("emits a composite (tenant_id, <ref>_id) FK to the target's (tenant_id, id)", () => {
    const sql = emitForeignKeyDdl(plan, new Set(["Account", "Order"])).join("\n");
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "fk_order_account_id"');
    expect(sql).toContain('ADD CONSTRAINT "fk_order_account_id"');
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "account_id") REFERENCES "tenant_app"."account" ("tenant_id", "id") ON DELETE RESTRICT');
  });

  it("skips a reference whose target is not a known table", () => {
    expect(emitForeignKeyDdl(plan, new Set(["Order"]))).toEqual([]);
  });

  it("emits nothing for an entity with no references", () => {
    const acct = columnPlanForEntity({ name: "Account", fields: [{ name: "name", type: { kind: "text" } }] }, { schema: "tenant_app" });
    expect(emitForeignKeyDdl(acct, new Set(["Account"]))).toEqual([]);
  });

  it("defaults to ON DELETE RESTRICT with no policy resolver", () => {
    const sql = emitForeignKeyDdl(plan, new Set(["Account", "Order"])).join("\n");
    expect(sql).toContain("ON DELETE RESTRICT");
  });

  it("applies a per-relation onDelete policy (cascade)", () => {
    const sql = emitForeignKeyDdl(plan, new Set(["Account", "Order"]), (f) =>
      f === "account" ? "cascade" : undefined,
    ).join("\n");
    expect(sql).toContain("REFERENCES \"tenant_app\".\"account\" (\"tenant_id\", \"id\") ON DELETE CASCADE");
  });

  it("uses the column-list SET NULL form (nulls only <ref>_id, never tenant_id)", () => {
    const sql = emitForeignKeyDdl(plan, new Set(["Account", "Order"]), () => "set_null").join("\n");
    expect(sql).toContain('ON DELETE SET NULL ("account_id")');
  });
});

describe("onDeleteClause", () => {
  it("maps each policy to its SQL clause", () => {
    expect(onDeleteClause("restrict", "x_id")).toBe("ON DELETE RESTRICT");
    expect(onDeleteClause("cascade", "x_id")).toBe("ON DELETE CASCADE");
    expect(onDeleteClause("set_null", "x_id")).toBe('ON DELETE SET NULL ("x_id")');
  });
});

describe("emitJoinTableDdl", () => {
  const manifest = { relations: [{ kind: "many_to_many", left: "Course", right: "Student" }] } as unknown as Manifest;
  const plan = joinTablePlansForManifest(manifest, { schema: "tenant_app" })[0]!;

  it("creates a tenant-scoped link table with a composite PK + RLS", () => {
    const sql = emitJoinTableDdl(plan, new Set(["Course", "Student"])).join("\n");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "tenant_app"."course_student"');
    expect(sql).toContain('PRIMARY KEY ("tenant_id", "course_id", "student_id")');
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain('DROP POLICY IF EXISTS "course_student_tenant_isolation"');
  });

  it("adds composite ON DELETE CASCADE FKs to both sides", () => {
    const sql = emitJoinTableDdl(plan, new Set(["Course", "Student"])).join("\n");
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "course_id") REFERENCES "tenant_app"."course" ("tenant_id", "id") ON DELETE CASCADE');
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "student_id") REFERENCES "tenant_app"."student" ("tenant_id", "id") ON DELETE CASCADE');
  });

  it("skips a FK whose side is not a known entity table", () => {
    const sql = emitJoinTableDdl(plan, new Set(["Course"])).join("\n");
    expect(sql).toContain('"course_id"'); // table still created
    expect(sql).not.toContain('REFERENCES "tenant_app"."student"');
  });
});
