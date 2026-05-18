import { describe, expect, it } from "vitest";
import type { Entity, Trait } from "@crossengin/types/meta-schema";
import { emitCreateTable, emitEntity, emitIndexes } from "./emit.js";
import { FieldNameCollisionError, ReservedFieldNameError, UnknownTraitError } from "./errors.js";

const schema = "t_acme";

describe("emitCreateTable — basics", () => {
  it("emits a minimal table with implicit id PK", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "first_name", type: { kind: "text", maxLength: 100 }, required: true }],
    };
    const sql = emitCreateTable(entity, { schema });
    expect(sql).toBe(
      `CREATE TABLE "t_acme"."patient" (\n` +
        `  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),\n` +
        `  "first_name" VARCHAR(100) NOT NULL,\n` +
        `  PRIMARY KEY ("id")\n` +
        `);`,
    );
  });

  it("converts PascalCase entity name to snake_case table name", () => {
    const entity: Entity = {
      name: "BatchRelease",
      fields: [{ name: "status", type: { kind: "text" } }],
    };
    const sql = emitCreateTable(entity, { schema });
    expect(sql).toContain(`"t_acme"."batch_release"`);
  });
});

describe("emitCreateTable — references", () => {
  it("emits FK with default ON DELETE RESTRICT and renames column to _id", () => {
    const entity: Entity = {
      name: "Prescription",
      fields: [
        {
          name: "patient",
          type: { kind: "reference", target: "Patient" },
          required: true,
        },
      ],
    };
    const sql = emitCreateTable(entity, { schema });
    expect(sql).toContain(
      `"patient_id" UUID NOT NULL REFERENCES "t_acme"."patient"("id") ON DELETE RESTRICT`,
    );
  });
});

describe("emitCreateTable — enum CHECK", () => {
  it("emits a CHECK constraint on enum values", () => {
    const entity: Entity = {
      name: "Order",
      fields: [
        {
          name: "status",
          type: { kind: "enum", values: ["pending", "shipped"] },
          required: true,
        },
      ],
    };
    const sql = emitCreateTable(entity, { schema });
    expect(sql).toContain(`"status" TEXT NOT NULL CHECK ("status" IN ('pending', 'shipped'))`);
  });
});

describe("emitCreateTable — composite unique", () => {
  it("emits a UNIQUE table constraint with the field and its scope", () => {
    const entity: Entity = {
      name: "Membership",
      fields: [
        { name: "email", type: { kind: "email" }, unique: { scope: ["org_id"] } },
        { name: "org_id", type: { kind: "uuid" }, required: true },
      ],
    };
    const sql = emitCreateTable(entity, { schema });
    expect(sql).toContain(`  UNIQUE ("email", "org_id")`);
  });
});

describe("emitCreateTable — traits", () => {
  it("merges auditable trait fields", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "first_name", type: { kind: "text" } }],
      traits: ["auditable"],
    };
    const sql = emitCreateTable(entity, { schema });
    expect(sql).toContain(`"created_at" TIMESTAMPTZ NOT NULL DEFAULT now()`);
    expect(sql).toContain(`"updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()`);
    expect(sql).toContain(`"created_by" UUID`);
    expect(sql).toContain(`"updated_by" UUID`);
  });

  it("merges soft_deletable trait fields", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "first_name", type: { kind: "text" } }],
      traits: ["soft_deletable"],
    };
    const sql = emitCreateTable(entity, { schema });
    expect(sql).toContain(`"deleted_at" TIMESTAMPTZ`);
    expect(sql).toContain(`"deleted_by" UUID`);
  });

  it("tenant_owned trait adds a tenant_id UUID NOT NULL column", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "first_name", type: { kind: "text" } }],
      traits: ["tenant_owned"],
    };
    const sql = emitCreateTable(entity, { schema });
    expect(sql).toContain(`"tenant_id" UUID NOT NULL`);
  });

  it("treats part_11_compliant as a marker trait with no columns", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "first_name", type: { kind: "text" } }],
      traits: ["part_11_compliant"],
    };
    const sql = emitCreateTable(entity, { schema });
    expect(sql).not.toContain(`part_11_compliant`);
    expect(sql).not.toContain(`tenant_id`);
  });

  it("accepts a custom trait from context.customTraits", () => {
    const customTrait: Trait = {
      name: "geocoded",
      fields: [
        {
          name: "latitude",
          type: { kind: "decimal", precision: 10, scale: 6 },
        },
        {
          name: "longitude",
          type: { kind: "decimal", precision: 10, scale: 6 },
        },
      ],
    };
    const entity: Entity = {
      name: "Address",
      fields: [{ name: "line1", type: { kind: "text" } }],
      traits: ["geocoded"],
    };
    const sql = emitCreateTable(entity, { schema, customTraits: [customTrait] });
    expect(sql).toContain(`"latitude" NUMERIC(10, 6)`);
    expect(sql).toContain(`"longitude" NUMERIC(10, 6)`);
  });

  it("throws UnknownTraitError for an unrecognized trait", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "name", type: { kind: "text" } }],
      traits: ["nonexistent"],
    };
    expect(() => emitCreateTable(entity, { schema })).toThrow(UnknownTraitError);
  });
});

describe("emitCreateTable — name collisions", () => {
  it("throws when an entity declares a field named 'id'", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "id", type: { kind: "uuid" } }],
    };
    expect(() => emitCreateTable(entity, { schema })).toThrow(ReservedFieldNameError);
  });

  it("throws when an entity field collides with a trait field", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "created_at", type: { kind: "datetime" } }],
      traits: ["auditable"],
    };
    expect(() => emitCreateTable(entity, { schema })).toThrow(FieldNameCollisionError);
  });
});

describe("emitIndexes", () => {
  it("emits an index per reference field", () => {
    const entity: Entity = {
      name: "Prescription",
      fields: [{ name: "patient", type: { kind: "reference", target: "Patient" } }],
    };
    const indexes = emitIndexes(entity, { schema });
    expect(indexes).toEqual([
      `CREATE INDEX "idx_prescription_patient_id" ON "t_acme"."prescription" ("patient_id");`,
    ]);
  });

  it("emits an index per enum field", () => {
    const entity: Entity = {
      name: "Order",
      fields: [{ name: "status", type: { kind: "enum", values: ["a", "b"] } }],
    };
    expect(emitIndexes(entity, { schema })).toEqual([
      `CREATE INDEX "idx_order_status" ON "t_acme"."order" ("status");`,
    ]);
  });

  it("emits an index for indexed=true fields", () => {
    const entity: Entity = {
      name: "Doc",
      fields: [{ name: "title", type: { kind: "text" }, indexed: true }],
    };
    expect(emitIndexes(entity, { schema })).toEqual([
      `CREATE INDEX "idx_doc_title" ON "t_acme"."doc" ("title");`,
    ]);
  });

  it("emits a GIN index for indexed={kind:'gin'} fields", () => {
    const entity: Entity = {
      name: "Doc",
      fields: [{ name: "meta", type: { kind: "json" }, indexed: { kind: "gin" } }],
    };
    expect(emitIndexes(entity, { schema })).toEqual([
      `CREATE INDEX "idx_doc_meta" ON "t_acme"."doc" USING GIN ("meta");`,
    ]);
  });

  it("emits explicit composite indexes", () => {
    const entity: Entity = {
      name: "Prescription",
      fields: [
        { name: "status", type: { kind: "enum", values: ["a", "b"] } },
        { name: "written_at", type: { kind: "datetime" } },
      ],
      indexes: [{ fields: ["status", "written_at"] }],
    };
    const indexes = emitIndexes(entity, { schema });
    expect(indexes).toContain(
      `CREATE INDEX "idx_prescription_status_written_at" ON "t_acme"."prescription" ("status", "written_at");`,
    );
  });

  it("emits unique explicit indexes", () => {
    const entity: Entity = {
      name: "Membership",
      fields: [
        { name: "user_id", type: { kind: "uuid" } },
        { name: "org_id", type: { kind: "uuid" } },
      ],
      indexes: [{ fields: ["user_id", "org_id"], unique: true }],
    };
    const indexes = emitIndexes(entity, { schema });
    expect(indexes).toContain(
      `CREATE UNIQUE INDEX "idx_membership_user_id_org_id" ON "t_acme"."membership" ("user_id", "org_id");`,
    );
  });

  it("translates reference field names to _id columns inside explicit indexes", () => {
    const entity: Entity = {
      name: "Visit",
      fields: [
        { name: "doctor", type: { kind: "reference", target: "Doctor" } },
        { name: "at", type: { kind: "datetime" } },
      ],
      indexes: [{ fields: ["doctor", "at"] }],
    };
    const indexes = emitIndexes(entity, { schema });
    expect(indexes).toContain(
      `CREATE INDEX "idx_visit_doctor_id_at" ON "t_acme"."visit" ("doctor_id", "at");`,
    );
  });

  it("emits an index for the soft_deletable deleted_at trait field", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "name", type: { kind: "text" } }],
      traits: ["soft_deletable"],
    };
    const indexes = emitIndexes(entity, { schema });
    expect(indexes).toContain(
      `CREATE INDEX "idx_patient_deleted_at" ON "t_acme"."patient" ("deleted_at");`,
    );
  });
});

describe("emitEntity", () => {
  it("returns CREATE TABLE followed by indexes", () => {
    const entity: Entity = {
      name: "Prescription",
      fields: [
        { name: "patient", type: { kind: "reference", target: "Patient" }, required: true },
        { name: "status", type: { kind: "enum", values: ["pending", "done"] } },
      ],
      traits: ["soft_deletable"],
    };
    const statements = emitEntity(entity, { schema });
    expect(statements[0]).toMatch(/^CREATE TABLE/);
    expect(statements.slice(1).every((s) => s.startsWith("CREATE "))).toBe(true);
    expect(statements.length).toBeGreaterThan(1);
  });
});

describe("emitEntity — tenant_owned trait", () => {
  it("emits tenant_id column + index", () => {
    const entity: Entity = {
      name: "Invoice",
      fields: [{ name: "total", type: { kind: "decimal", precision: 14, scale: 2 } }],
      traits: ["tenant_owned"],
    };
    const statements = emitEntity(entity, { schema });
    expect(statements[0]).toContain(`"tenant_id" UUID NOT NULL`);
    expect(statements.some((s) => /CREATE INDEX.*"tenant_id"/.test(s))).toBe(true);
  });

  it("emits the cross-schema FK to meta.tenants(id)", () => {
    const entity: Entity = {
      name: "Invoice",
      fields: [{ name: "total", type: { kind: "decimal", precision: 14, scale: 2 } }],
      traits: ["tenant_owned"],
    };
    const statements = emitEntity(entity, { schema });
    const fk = statements.find((s) => s.includes("FOREIGN KEY"));
    expect(fk).toBeDefined();
    expect(fk).toContain(`"meta"."tenants"`);
    expect(fk).toContain(`ON DELETE CASCADE`);
  });

  it("emits ENABLE ROW LEVEL SECURITY + a tenant_isolation policy", () => {
    const entity: Entity = {
      name: "Invoice",
      fields: [{ name: "total", type: { kind: "decimal", precision: 14, scale: 2 } }],
      traits: ["tenant_owned"],
    };
    const statements = emitEntity(entity, { schema });
    expect(statements.some((s) => /ALTER TABLE.*ENABLE ROW LEVEL SECURITY/.test(s))).toBe(true);
    const policy = statements.find((s) => s.startsWith("CREATE POLICY"));
    expect(policy).toBeDefined();
    expect(policy).toContain(`invoice_tenant_isolation`);
    expect(policy).toContain(
      `tenant_id = current_setting('app.current_tenant_id', true)::UUID`,
    );
  });

  it("entities without tenant_owned get no RLS / FK / tenant_id", () => {
    const entity: Entity = {
      name: "Plan",
      fields: [{ name: "name", type: { kind: "text" } }],
    };
    const statements = emitEntity(entity, { schema });
    const sql = statements.join("\n");
    expect(sql).not.toContain("tenant_id");
    expect(sql).not.toContain("ROW LEVEL SECURITY");
    expect(sql).not.toContain("CREATE POLICY");
  });

  it("works alongside other traits (auditable + tenant_owned)", () => {
    const entity: Entity = {
      name: "Account",
      fields: [{ name: "name", type: { kind: "text" }, required: true }],
      traits: ["auditable", "tenant_owned"],
    };
    const statements = emitEntity(entity, { schema });
    const create = statements[0]!;
    expect(create).toContain(`"created_at"`);
    expect(create).toContain(`"updated_at"`);
    expect(create).toContain(`"tenant_id"`);
    expect(statements.some((s) => /ENABLE ROW LEVEL SECURITY/.test(s))).toBe(true);
  });
});
