import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { columnPlanForEntity, joinTablePlansForManifest } from "./column-plan.js";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  emitAddColumnDdl,
  emitEntityTableDdl,
  emitForeignKeyDdl,
  emitJoinTableDdl,
  onDeleteClause,
} from "./entity-ddl.js";

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

  it("emits a plain-column trigram GIN index for each plaintext text/varchar column", () => {
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "widget_sku_trgm" ON "tenant_app"."widget" USING gin ("sku" gin_trgm_ops);',
    );
  });

  it("uses a plain column trigram index, not a functional unaccent() index", () => {
    expect(sql).not.toContain("unaccent(");
  });

  it("does not trigram-index numeric columns", () => {
    expect(sql).not.toContain('"price_trgm"');
    expect(sql).not.toContain('"cost_trgm"');
  });

  it("does not trigram-index an encrypted (BYTEA) column", () => {
    // ssn is phi → stored BYTEA, so no trigram index despite its text field type.
    expect(sql).not.toContain('"widget_ssn_trgm"');
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

describe("emitEntityTableDdl — trait-supplied timestamps", () => {
  const AUDITED: Entity = {
    name: "Visit",
    traits: ["auditable"],
    fields: [{ name: "reason", type: { kind: "text" } }],
  };
  const PLAIN: Entity = { name: "Note", fields: [{ name: "body", type: { kind: "text" } }] };

  it("declares created_at exactly once when the trait already supplies it", () => {
    const create = emitEntityTableDdl(columnPlanForEntity(AUDITED, { schema: "app" }))[0] ?? "";
    expect(create.match(/"created_at"/g)).toHaveLength(1);
    expect(create.match(/"updated_at"/g)).toHaveLength(1);
  });

  it("keeps the trait column's own default, so inserts that omit it still work", () => {
    const create = emitEntityTableDdl(columnPlanForEntity(AUDITED, { schema: "app" }))[0] ?? "";
    expect(create).toContain('"created_at" TIMESTAMPTZ NOT NULL DEFAULT now()');
  });

  it("emits the trait's other columns as ordinary domain columns", () => {
    const create = emitEntityTableDdl(columnPlanForEntity(AUDITED, { schema: "app" }))[0] ?? "";
    expect(create).toContain('"created_by" UUID');
    expect(create).toContain('"updated_by" UUID');
  });

  it("still supplies the housekeeping timestamps for an entity with no auditable trait", () => {
    const create = emitEntityTableDdl(columnPlanForEntity(PLAIN, { schema: "app" }))[0] ?? "";
    expect(create).toContain('"created_at" TIMESTAMPTZ NOT NULL DEFAULT now()');
    expect(create).toContain('"updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()');
  });
});

describe("emitAddColumnDdl", () => {
  const WITH_REQUIRED: Entity = {
    name: "Visit",
    fields: [
      { name: "reason", type: { kind: "text" } },
      { name: "triage", type: { kind: "text" }, required: true },
      { name: "version", type: { kind: "integer" }, required: true, default: { kind: "literal", value: 1 } },
    ],
  };
  const stmts = emitAddColumnDdl(columnPlanForEntity(WITH_REQUIRED, { schema: "app" }));

  it("emits one idempotent ADD COLUMN per planned column", () => {
    expect(stmts).toHaveLength(3);
    for (const s of stmts) expect(s).toContain("ADD COLUMN IF NOT EXISTS");
  });

  it("drops NOT NULL on a required column with nothing to backfill with", () => {
    const triage = stmts.find((s) => s.includes('"triage"')) ?? "";
    expect(triage).toContain('ADD COLUMN IF NOT EXISTS "triage" TEXT;');
    expect(triage).not.toContain("NOT NULL");
  });

  it("keeps NOT NULL when a default can backfill the existing rows", () => {
    const version = stmts.find((s) => s.includes('"version"')) ?? "";
    expect(version).toContain("NOT NULL DEFAULT 1");
  });

  it("runs inside the table DDL, before any statement that references a column", () => {
    const sql = emitEntityTableDdl(columnPlanForEntity(WITH_REQUIRED, { schema: "app" }));
    const addIdx = sql.findIndex((s) => s.includes("ADD COLUMN IF NOT EXISTS"));
    const trigramIdx = sql.findIndex((s) => s.includes("gin_trgm_ops"));
    expect(addIdx).toBe(1);
    expect(trigramIdx).toBeGreaterThan(addIdx);
  });
});

describe("emitEntityTableDdl — trigram indexes", () => {
  const TEXTY: Entity = {
    name: "Place",
    fields: [
      { name: "label", type: { kind: "text" } },
      { name: "code", type: { kind: "text", maxLength: 20 } },
      { name: "country", type: { kind: "country_code" } },
      { name: "secret", type: { kind: "text" }, classification: "phi" },
      { name: "count", type: { kind: "integer" } },
    ],
  };
  const sql = emitEntityTableDdl(columnPlanForEntity(TEXTY, { schema: "app" })).join("\n");

  it("indexes TEXT and VARCHAR columns", () => {
    expect(sql).toContain('"label" gin_trgm_ops');
    expect(sql).toContain('"code" gin_trgm_ops');
  });

  it("skips CHAR(n), which gin_trgm_ops does not accept", () => {
    // bpchar is not binary-coercible to text; indexing it fails outright, and a
    // country_code field made pack-erp-core unbootable on this store.
    expect(sql).not.toContain('"country" gin_trgm_ops');
  });

  it("skips encrypted and non-text columns", () => {
    expect(sql).not.toContain('"secret" gin_trgm_ops');
    expect(sql).not.toContain('"count" gin_trgm_ops');
  });
});
