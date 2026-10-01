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
  unplannedSystemTimestamps,
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

  it("emits a trigram GIN index over the FOLDED expression for each free-text column", () => {
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "widget_sku_fold_trgm" ON "tenant_app"."widget" '
      + 'USING gin ("tenant_app"."crossengin_fold_text"("sku"::text) gin_trgm_ops);',
    );
  });

  it("indexes the expression the predicate compares through, NOT the bare column", () => {
    // The inverse of what this file asserted before ADR-0285. A plain-column index
    // cannot match a function-call predicate at any volatility — measured as a
    // `Seq Scan` even with `enable_seqscan = off` — so the bare-column form was an
    // index that existed and could never be used.
    expect(sql).toContain('gin ("tenant_app"."crossengin_fold_text"("sku"::text) gin_trgm_ops)');
    expect(sql).not.toContain('gin ("sku" gin_trgm_ops)');
  });

  it("drops the pre-fold plain-column index by name", () => {
    // CREATE INDEX IF NOT EXISTS on an existing name keeps the OLD definition, so
    // the unusable index has to be dropped rather than redefined.
    expect(sql).toContain('DROP INDEX IF EXISTS "tenant_app"."widget_sku_trgm";');
  });

  it("does not trigram-index numeric columns", () => {
    expect(sql).not.toContain('"price_fold_trgm"');
    expect(sql).not.toContain('"cost_fold_trgm"');
  });

  it("does not trigram-index an encrypted (BYTEA) column", () => {
    // ssn is phi → stored BYTEA, so no trigram index despite its text field type.
    expect(sql).not.toContain('"widget_ssn_fold_trgm"');
    // …and no DROP either: a BYTEA column never had one to drop.
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
      { name: "blurb", type: { kind: "long_text" } },
      { name: "contact", type: { kind: "email" } },
      { name: "country", type: { kind: "country_code" } },
      { name: "secret", type: { kind: "text" }, classification: "phi" },
      { name: "count", type: { kind: "integer" } },
      { name: "state", type: { kind: "enum", values: ["open", "shut", "gone"] } },
      { name: "owner", type: { kind: "reference", target: "Place" } },
      { name: "tags", type: { kind: "array", element: { kind: "text" } } },
    ],
  };
  const stmts = emitEntityTableDdl(columnPlanForEntity(TEXTY, { schema: "app" }));
  const sql = stmts.join("\n");
  const indexed = (column: string): boolean => sql.includes(`("${column}"::text) gin_trgm_ops`);

  it("indexes TEXT, VARCHAR, long_text and email columns", () => {
    expect(indexed("label")).toBe(true);
    expect(indexed("code")).toBe(true);
    expect(indexed("blurb")).toBe(true);
    expect(indexed("contact")).toBe(true);
  });

  it("skips an enum column — a closed token set is matched by equality, not substring", () => {
    // `enum` emits TEXT, so the pre-ADR-0285 type-only test indexed it. Measured on
    // a composed pack: 67 of 291 trigram indexes were over enums, and one over a
    // five-value enum was larger than the table's own primary key.
    expect(indexed("state")).toBe(false);
    // the useless one it used to have is dropped
    expect(sql).toContain('DROP INDEX IF EXISTS "app"."place_state_trgm";');
  });

  it("skips a reference column — an opaque id is matched by equality too", () => {
    expect(indexed("owner_id")).toBe(false);
    expect(sql).toContain('DROP INDEX IF EXISTS "app"."place_owner_id_trgm";');
  });

  it("skips CHAR(n), which gin_trgm_ops does not accept", () => {
    // bpchar is not binary-coercible to text; indexing it fails outright, and a
    // country_code field made pack-erp-core unbootable on this store.
    expect(indexed("country")).toBe(false);
  });

  it("skips an array column: no text operator class accepts <element>[]", () => {
    expect(indexed("tags")).toBe(false);
  });

  it("skips encrypted and non-text columns", () => {
    expect(indexed("secret")).toBe(false);
    expect(indexed("count")).toBe(false);
  });

  it("drops every legacy index before creating any fold index", () => {
    const lastDrop = stmts.reduce((acc, s, i) => (s.startsWith("DROP INDEX") ? i : acc), -1);
    const firstFold = stmts.findIndex((s) => s.includes("_fold_trgm"));
    expect(lastDrop).toBeGreaterThanOrEqual(0);
    expect(firstFold).toBeGreaterThan(lastDrop);
  });

  it("caps both index names at Postgres's 63-char identifier limit", () => {
    const long = "x".repeat(70);
    const wide: Entity = { name: "Place", fields: [{ name: long, type: { kind: "text" } }] };
    const names = emitEntityTableDdl(columnPlanForEntity(wide, { schema: "app" }))
      .flatMap((s) => [...s.matchAll(/"(place_x+[a-z_]*)"/g)].map((m) => m[1]!));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(63);
  });
});

describe("unplannedSystemTimestamps", () => {
  it("names both timestamps for an entity that declares neither", () => {
    const plan = columnPlanForEntity(
      { name: "Plain", fields: [{ name: "title", type: { kind: "text" } }] },
      { schema: "app" },
    );
    expect(unplannedSystemTimestamps(plan)).toEqual(["created_at", "updated_at"]);
  });

  it("names neither for an auditable entity, whose trait declares both as real columns", () => {
    const plan = columnPlanForEntity(
      { name: "Audited", traits: ["auditable"], fields: [{ name: "title", type: { kind: "text" } }] },
      { schema: "app", traits: [] },
    );
    expect(unplannedSystemTimestamps(plan)).toEqual([]);
  });

  it("agrees with the CREATE TABLE: a named timestamp is one the emitter supplies", () => {
    const plan = columnPlanForEntity(
      { name: "Plain", fields: [{ name: "title", type: { kind: "text" } }] },
      { schema: "app" },
    );
    const create = emitEntityTableDdl(plan)[0]!;
    for (const name of unplannedSystemTimestamps(plan)) {
      expect(create).toContain(`"${name}" TIMESTAMPTZ NOT NULL DEFAULT now()`);
    }
  });
});
