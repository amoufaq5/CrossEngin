import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { columnPlanForEntity, joinTablePlansForManifest, UnresolvableUniqueScopeError } from "./column-plan.js";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  emitAddColumnDdl,
  emitEntityTableDdl,
  emitManifestSchemaDdl,
  emitForeignKeyDdl,
  emitJoinTableDdl,
  emitUniqueIndexDdl,
  onDeleteClause,
  UNIQUE_WITHHELD_REASONS,
  uniqueIndexFields,
  uniqueWithheldFor,
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
    // NULLIF, not the bare cast: on a pooled connection whose tenant GUC has been reset to the empty
    // string, `''::UUID` raises instead of matching no rows.
    expect(sql).toContain("NULLIF(current_setting('app.current_tenant_id', true), '')::UUID");
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

describe("emitUniqueIndexDdl", () => {
  // `unique` had TWO readers in the workspace and neither emitted anything: `kernel`'s
  // `ddl/diff.ts` reads it only to *throw* when it changes, and `ui-schema.ts` copies it onto the
  // `UiSchema` — where `unique` occurs exactly once in the whole apps/operate-web tree, as a type
  // declaration, and no component reads it. So it was authored, validated, hashed into
  // `manifestHash`, serialized to every client and read by nobody at either end, and two patients
  // could share an `mrn`. Measured: 45 distinct (entity, field) pairs across the seven resolved
  // packs (47 source declarations) and zero UNIQUE constraints on any of the 54 tables.
  const UNIQ: Entity = {
    name: "Widget",
    fields: [
      { name: "sku", type: { kind: "text" }, required: true, unique: true },
      { name: "price", type: { kind: "decimal", precision: 12, scale: 2 } },
      { name: "mrn", type: { kind: "text" }, classification: "phi", unique: true },
    ],
  };
  const plan = columnPlanForEntity(UNIQ, { schema: "tenant_app" });

  it("scopes the index by tenant, which is the whole reason it is not an inline UNIQUE", () => {
    // `(tenant_id, col)` and never `(col)`: these tables are multi-tenant with a `(tenant_id, id)`
    // primary key, so a bare UNIQUE would make one tenant's sku collide with another's — a
    // cross-tenant coupling, which is the one thing the isolation model exists to prevent.
    const sql = emitUniqueIndexDdl(plan).join("\n");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "widget_sku_uniq"');
    expect(sql).toContain('ON "tenant_app"."widget" ("tenant_id", "sku")');
    expect(sql).not.toContain('("sku")');
  });

  it("emits nothing for a field that does not declare unique", () => {
    expect(emitUniqueIndexDdl(plan).join("\n")).not.toContain("price");
  });

  it("withholds the index on an encrypted column rather than emitting one that cannot fire", () => {
    // `pgp_sym_encrypt` is non-deterministic, so two rows with the same plaintext encrypt to
    // different bytes and a UNIQUE over them never fires. Emitting it would be worse than nothing:
    // an operator reading `\d` would see a constraint that cannot do its job.
    expect(emitUniqueIndexDdl(plan).join("\n")).not.toContain("mrn");
    expect(uniqueWithheldFor(plan)).toEqual([
      { entity: "Widget", field: "mrn", reason: "encrypted_at_rest" },
    ]);
  });

  it("withholds nothing when no unique field is encrypted", () => {
    const clean = columnPlanForEntity(
      { name: "Thing", fields: [{ name: "code", type: { kind: "text" }, unique: true }] },
      { schema: "s" },
    );
    expect(uniqueWithheldFor(clean)).toEqual([]);
    expect(emitUniqueIndexDdl(clean)).toHaveLength(1);
  });

  it("is idempotent, because ensureSchema re-runs on every boot", () => {
    expect(emitUniqueIndexDdl(plan).every((x) => x.includes("IF NOT EXISTS"))).toBe(true);
  });

  it("is NOT part of emitEntityTableDdl, because these statements can fail on data", () => {
    // Adding a unique index to a populated table holding duplicates raises 23505 and no
    // `IF NOT EXISTS` helps, because the condition is in the rows. They are returned separately so
    // `ensureSchema` can report a failure rather than take the deployment down over rows it cannot
    // deduplicate — `kernel-pg`'s "anything whose outcome depends on existing data is reported"
    // line, one emitter over.
    expect(emitEntityTableDdl(plan).join("\n")).not.toContain("UNIQUE INDEX");
  });

  it("truncates an over-long index name rather than emitting an invalid identifier", () => {
    const long = columnPlanForEntity(
      {
        name: "A".repeat(50),
        fields: [{ name: "b".repeat(40), type: { kind: "text" }, unique: true }],
      },
      { schema: "s" },
    );
    const name = /"([^"]+)"/.exec(emitUniqueIndexDdl(long)[0]!)![1]!;
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("covers every withheld reason", () => {
    // `document_store` has no producer in this module and that is deliberate: it plans column
    // tables only, so the member lives here with the vocabulary and the boot survey emits it.
    expect(Object.keys(UNIQUE_WITHHELD_REASONS).sort()).toEqual([
      "document_store",
      "encrypted_at_rest",
    ]);
  });

  it("maps each emitted index name back to the field it enforces", () => {
    // Postgres reports a 23505 with the constraint *name* and nothing else usable, so a store can
    // only name the field by asking the thing that generated the name — the index name truncates
    // at 63 characters, so a parser would have to guess where the column started.
    expect([...uniqueIndexFields(plan).entries()]).toEqual([["widget_sku_uniq", "sku"]]);
    expect(uniqueIndexFields(plan).has("widget_mrn_uniq")).toBe(false);
  });

  it("maps every index it emits and nothing it does not", () => {
    // The two must agree in both directions or a 23505 resolves to a field whose index was never
    // created — the shape that would let an unattributable violation be attributed anyway.
    const named = [...uniqueIndexFields(plan).keys()].sort();
    const emitted = emitUniqueIndexDdl(plan)
      .map((s) => /"([^"]+)"/.exec(s)![1]!)
      .sort();
    expect(named).toEqual(emitted);
  });
});

describe("emitUniqueIndexDdl — the scoped form", () => {
  // `UniqueHintSchema` is `boolean | {scope: string[]}` and has been since it was written, so
  // `field.unique === true` silently drops a declared composite key — this increment's own class
  // inside its own fix. Measured: 0 of the 47 source declarations use it, so reading it costs
  // nothing today and is the only reading that cannot go quietly wrong later.
  const SCOPED: Entity = {
    name: "Employee",
    fields: [
      { name: "department_id", type: { kind: "reference", target: "Employee" } },
      { name: "staff_no", type: { kind: "text" }, unique: { scope: ["department_id"] } },
    ],
  };

  it("puts tenant first, then the declared scope, then the column", () => {
    // Tenant first because a multi-column index serves a *prefix* of its own columns: leading with
    // `tenant_id` makes it useful to the tenant-filtered lookups every read here issues, where
    // leading with the scope would leave it serving a cross-tenant prefix no query ever asks for.
    const sql = emitUniqueIndexDdl(columnPlanForEntity(SCOPED, { schema: "s" })).join("\n");
    expect(sql).toContain('ON "s"."employee" ("tenant_id", "department_id", "staff_no")');
  });

  it("resolves the scope to COLUMNS, not field names", () => {
    // The one transform `columnNameForField` makes is appending `_id` to a **reference** field, so
    // a scope naming `department` must index `department_id`. Field names are
    // `/^[a-z][a-z0-9_]*$/`, so there is no case conversion to observe and this is the whole of the
    // difference between the two namespaces — index the field name and the statement names a
    // column that does not exist.
    const ref: Entity = {
      name: "Thing",
      fields: [
        { name: "department", type: { kind: "reference", target: "Thing" } },
        { name: "code", type: { kind: "text" }, unique: { scope: ["department"] } },
      ],
    };
    const sql = emitUniqueIndexDdl(columnPlanForEntity(ref, { schema: "s" })).join("\n");
    expect(sql).toContain('("tenant_id", "department_id", "code")');
    expect(sql).not.toContain('"department"');
  });

  it("refuses a scope naming a field the entity does not have, rather than emitting a narrower one", () => {
    // Emitting the index without the unresolved column would enforce a *stricter* constraint than
    // the manifest declares — refusing writes a reviewer approved — so the plan throws and
    // `applyTenantManifestSchema` reports it as a blocking change, which is `UNDECIDED_SQL_TYPES`'
    // precedent in the same function.
    expect(() =>
      columnPlanForEntity(
        {
          name: "Thing",
          fields: [{ name: "code", type: { kind: "text" }, unique: { scope: ["nope"] } }],
        },
        { schema: "s" },
      ),
    ).toThrow(UnresolvableUniqueScopeError);
  });

  it("names the entity, the field and the scope field in the refusal", () => {
    try {
      columnPlanForEntity(
        {
          name: "Thing",
          fields: [{ name: "code", type: { kind: "text" }, unique: { scope: ["nope"] } }],
        },
        { schema: "s" },
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnresolvableUniqueScopeError);
      const e = err as UnresolvableUniqueScopeError;
      // All three, because a field name may be declared on several entities and an operator
      // reading a boot failure needs to know which one to edit.
      expect([e.entity, e.field, e.scopeField]).toEqual(["Thing", "code", "nope"]);
    }
  });

  it("resolves a scope naming a TRAIT-supplied field", () => {
    // A unique field and the field its scope names can both arrive from a trait, so resolution
    // goes through `resolvedFields` — a rule reading `entity.fields` raw while the emitter resolves
    // traits is a divergence this repo keeps finding.
    const plan = columnPlanForEntity(
      {
        name: "Visit",
        traits: ["auditable"],
        fields: [{ name: "ref", type: { kind: "text" }, unique: { scope: ["created_by"] } }],
      },
      { schema: "s" },
    );
    expect(emitUniqueIndexDdl(plan).join("\n")).toContain('("tenant_id", "created_by", "ref")');
  });

  it("still withholds a scoped unique on an encrypted column", () => {
    // The scope changes which rows collide; it does not make ciphertext comparable.
    const plan = columnPlanForEntity(
      {
        name: "Patient",
        fields: [
          { name: "ward", type: { kind: "text" } },
          {
            name: "mrn",
            type: { kind: "text" },
            classification: "phi",
            unique: { scope: ["ward"] },
          },
        ],
      },
      { schema: "s" },
    );
    expect(emitUniqueIndexDdl(plan)).toEqual([]);
    expect(uniqueWithheldFor(plan)).toEqual([
      { entity: "Patient", field: "mrn", reason: "encrypted_at_rest" },
    ]);
  });

  it("treats `unique: false` as no declaration at all", () => {
    const plan = columnPlanForEntity(
      { name: "Thing", fields: [{ name: "code", type: { kind: "text" }, unique: false }] },
      { schema: "s" },
    );
    expect(emitUniqueIndexDdl(plan)).toEqual([]);
    expect(uniqueWithheldFor(plan)).toEqual([]);
    expect(plan.columns[0]!.uniqueScope).toBeNull();
  });

  it("distinguishes an unscoped declaration from no declaration in the plan itself", () => {
    // `[]` (unique within the tenant) against `null` (declares none) — the distinction a boolean
    // could not carry, and the reason the plan does not hold one.
    const plan = columnPlanForEntity(
      {
        name: "Thing",
        fields: [
          { name: "code", type: { kind: "text" }, unique: true },
          { name: "note", type: { kind: "text" } },
        ],
      },
      { schema: "s" },
    );
    expect(plan.columns[0]!.uniqueScope).toEqual([]);
    expect(plan.columns[1]!.uniqueScope).toBeNull();
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
    // The trait declares `now()` and the emitter does not rewrite a declared default — a planned
    // column's default is the manifest's statement, not this emitter's. Its *precision* is
    // corrected by the `ALTER COLUMN … SET DEFAULT` that follows, which is the one place that
    // reaches a table an earlier manifest already created.
    expect(create).toContain('"created_at" TIMESTAMPTZ NOT NULL DEFAULT now()');
  });

  it("follows up with a millisecond-truncating SET DEFAULT, reaching an existing table too", () => {
    const stmts = emitEntityTableDdl(columnPlanForEntity(AUDITED, { schema: "app" }));
    const alters = stmts.filter((s) => s.includes("SET DEFAULT"));
    expect(alters).toEqual([
      `ALTER TABLE "app"."visit" ALTER COLUMN "created_at" SET DEFAULT date_trunc('milliseconds', now());`,
      `ALTER TABLE "app"."visit" ALTER COLUMN "updated_at" SET DEFAULT date_trunc('milliseconds', now());`,
    ]);
    // After the ADD COLUMNs: on an `auditable` entity the timestamps are planned columns, so a
    // table created by an earlier manifest may not hold them yet and the ALTER would fail.
    const lastAdd = stmts.reduce(
      (acc, stmt, i) => (stmt.includes("ADD COLUMN IF NOT EXISTS") ? i : acc),
      -1,
    );
    expect(stmts.indexOf(alters[0]!)).toBeGreaterThan(lastAdd);
  });

  it("truncates to the millisecond because that is all the wire form holds", () => {
    // `TIMESTAMPTZ` keeps microseconds; a JS `Date` does not; so `isoInstant` serves a truncated
    // instant, the keyset cursor is rendered from the served value, and the seek then compares a
    // truncated cursor against an untruncated column. Measured live before this: six rows 100
    // microseconds apart, walked with `limit 2`, returned `us-0 us-1 us-1 us-2 us-1 us-2 …` and
    // never terminated. Storing what the contract can hold is the fix; truncating in the ORDER BY
    // would pay per row forever and could never back an index (`date_trunc` is STABLE).
    const stmts = emitEntityTableDdl(columnPlanForEntity(PLAIN, { schema: "app" }));
    expect(stmts.join("\n")).not.toMatch(/DEFAULT now\(\)/);
  });

  it("emits the trait's other columns as ordinary domain columns", () => {
    const create = emitEntityTableDdl(columnPlanForEntity(AUDITED, { schema: "app" }))[0] ?? "";
    expect(create).toContain('"created_by" UUID');
    expect(create).toContain('"updated_by" UUID');
  });

  it("still supplies the housekeeping timestamps for an entity with no auditable trait", () => {
    const create = emitEntityTableDdl(columnPlanForEntity(PLAIN, { schema: "app" }))[0] ?? "";
    expect(create).toContain(`"created_at" TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', now())`);
    expect(create).toContain(`"updated_at" TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', now())`);
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

describe("emitManifestSchemaDdl", () => {
  const ACCOUNT: Entity = { name: "Account", fields: [{ name: "name", type: { kind: "text" } }] };
  const ORDER: Entity = {
    name: "Order",
    fields: [{ name: "account", type: { kind: "reference", target: "Account" } }],
  };
  const plans = new Map([
    ["Order", columnPlanForEntity(ORDER, { schema: "app" })],
    ["Account", columnPlanForEntity(ACCOUNT, { schema: "app" })],
  ]);
  const joins = joinTablePlansForManifest(
    { relations: [{ kind: "many_to_many", left: "Order", right: "Account" }] } as unknown as Manifest,
    { schema: "app" },
  );

  it("creates a referenced table before the one referencing it", () => {
    const stmts = emitManifestSchemaDdl(plans);
    const account = stmts.findIndex((s) => s.includes('"app"."account" ('));
    const order = stmts.findIndex((s) => s.includes('"app"."order" ('));
    expect(account).toBeLessThan(order);
  });

  it("defers every foreign key until after every table, so a reference cycle applies", () => {
    const stmts = emitManifestSchemaDdl(plans);
    const lastTable = stmts.reduce((acc, s, i) => (s.startsWith("CREATE TABLE") ? i : acc), -1);
    const firstFk = stmts.findIndex((s) => s.includes("ADD CONSTRAINT"));
    expect(firstFk).toBeGreaterThan(lastTable);
  });

  it("puts join tables last, after both of their FK targets exist", () => {
    const stmts = emitManifestSchemaDdl(plans, joins);
    const join = stmts.findIndex((s) => s.includes('"app"."order_account"'));
    const order = stmts.findIndex((s) => s.includes('"app"."order" ('));
    expect(order).toBeLessThan(join);
    expect(join).toBeGreaterThan(stmts.findIndex((s) => s.includes('"app"."account" (')));
  });

  it("applies the per-relation ON DELETE policy", () => {
    const stmts = emitManifestSchemaDdl(plans, [], new Map([["Order.account", "cascade"]]));
    expect(stmts.join("\n")).toContain("ON DELETE CASCADE");
  });

  it("does not emit CREATE SCHEMA — the caller owns it, so the tenant applier can introspect first", () => {
    expect(emitManifestSchemaDdl(plans).some((s) => s.startsWith("CREATE SCHEMA"))).toBe(false);
  });

  it("emits nothing for a manifest with no entities", () => {
    expect(emitManifestSchemaDdl(new Map())).toEqual([]);
  });
});
