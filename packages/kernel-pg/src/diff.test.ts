import type { TableDefinition } from "@crossengin/kernel/bootstrap";
import { describe, expect, it } from "vitest";

import { diffSchema, formatSchemaDiff } from "./diff.js";
import type { LiveSchema, LiveTable } from "./introspection.js";

function liveTable(name: string, columns: LiveTable["columns"], extras: Partial<LiveTable> = {}): LiveTable {
  return {
    schema: "meta",
    name,
    columns,
    indexes: [],
    policies: [],
    foreignKeys: [],
    rlsEnabled: false,
    ...extras,
  };
}

function liveSchema(tables: LiveTable[]): LiveSchema {
  return { schema: "meta", tables };
}

const targetTenants: TableDefinition = {
  schema: "meta",
  name: "tenants",
  columns: [
    { name: "id", type: "UUID", notNull: true, primaryKey: true },
    { name: "name", type: "TEXT", notNull: true },
  ],
  indexes: [{ name: "tenants_name_idx", columns: ["name"] }],
  rls: { enabled: true, policies: [{ name: "tenants_policy", using: "true" }] },
};

describe("diffSchema", () => {
  it("reports no drift on an exact match", () => {
    const live = liveSchema([
      liveTable(
        "tenants",
        [
          { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
          { name: "name", dataType: "text", isNullable: false, defaultExpr: null },
        ],
        {
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false }],
          policies: [{ name: "tenants_policy", using: "true", check: null }],
          rlsEnabled: true,
        },
      ),
    ]);
    const diff = diffSchema([targetTenants], live);
    expect(diff.hasDrift).toBe(false);
    expect(diff.addedTables).toEqual([]);
    expect(diff.removedTables).toEqual([]);
    expect(diff.modifiedTables).toEqual([]);
    expect(diff.unchangedTables).toEqual(["tenants"]);
  });

  it("reports a target table missing from live as an added table", () => {
    const diff = diffSchema([targetTenants], liveSchema([]));
    expect(diff.hasDrift).toBe(true);
    expect(diff.addedTables).toEqual(["tenants"]);
  });

  it("reports a live table missing from target as a removed table", () => {
    const live = liveSchema([liveTable("orphan", [])]);
    const diff = diffSchema([], live);
    expect(diff.hasDrift).toBe(true);
    expect(diff.removedTables).toEqual(["orphan"]);
  });

  it("reports added columns", () => {
    const live = liveSchema([
      liveTable("tenants", [
        { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
      ]),
    ]);
    const diff = diffSchema([targetTenants], live);
    expect(diff.modifiedTables).toHaveLength(1);
    expect(diff.modifiedTables[0]?.addedColumns).toEqual(["name"]);
  });

  it("reports removed columns", () => {
    const live = liveSchema([
      liveTable(
        "tenants",
        [
          { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
          { name: "name", dataType: "text", isNullable: false, defaultExpr: null },
          { name: "legacy", dataType: "text", isNullable: true, defaultExpr: null },
        ],
        {
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false }],
          policies: [{ name: "tenants_policy", using: "true", check: null }],
          rlsEnabled: true,
        },
      ),
    ]);
    const diff = diffSchema([targetTenants], live);
    expect(diff.modifiedTables[0]?.removedColumns).toEqual(["legacy"]);
  });

  it("reports type, nullability, and default drift", () => {
    const live = liveSchema([
      liveTable(
        "tenants",
        [
          { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
          { name: "name", dataType: "varchar(255)", isNullable: true, defaultExpr: "'anon'::text" },
        ],
        {
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false }],
          policies: [{ name: "tenants_policy", using: "true", check: null }],
          rlsEnabled: true,
        },
      ),
    ]);
    const diff = diffSchema([targetTenants], live);
    const change = diff.modifiedTables[0]?.changedColumns[0];
    expect(change?.column).toBe("name");
    expect(change?.reasons).toContain("type");
    expect(change?.reasons).toContain("nullable");
    expect(change?.reasons).toContain("default");
  });

  it("ignores primary-key indexes when reporting removed indexes", () => {
    const live = liveSchema([
      liveTable(
        "tenants",
        [
          { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
          { name: "name", dataType: "text", isNullable: false, defaultExpr: null },
        ],
        {
          indexes: [
            { name: "tenants_pkey", columns: ["id"], unique: true, primary: true },
            { name: "tenants_name_idx", columns: ["name"], unique: false, primary: false },
          ],
          policies: [{ name: "tenants_policy", using: "true", check: null }],
          rlsEnabled: true,
        },
      ),
    ]);
    const diff = diffSchema([targetTenants], live);
    expect(diff.modifiedTables).toEqual([]);
    expect(diff.unchangedTables).toEqual(["tenants"]);
  });

  it("reports added and removed indexes", () => {
    const live = liveSchema([
      liveTable(
        "tenants",
        [
          { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
          { name: "name", dataType: "text", isNullable: false, defaultExpr: null },
        ],
        {
          indexes: [
            { name: "tenants_legacy_idx", columns: ["name"], unique: false, primary: false },
          ],
          policies: [{ name: "tenants_policy", using: "true", check: null }],
          rlsEnabled: true,
        },
      ),
    ]);
    const diff = diffSchema([targetTenants], live);
    expect(diff.modifiedTables[0]?.addedIndexes).toEqual(["tenants_name_idx"]);
    expect(diff.modifiedTables[0]?.removedIndexes).toEqual(["tenants_legacy_idx"]);
  });

  it("reports added and removed policies", () => {
    const live = liveSchema([
      liveTable(
        "tenants",
        [
          { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
          { name: "name", dataType: "text", isNullable: false, defaultExpr: null },
        ],
        {
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false }],
          policies: [{ name: "old_policy", using: "true", check: null }],
          rlsEnabled: true,
        },
      ),
    ]);
    const diff = diffSchema([targetTenants], live);
    expect(diff.modifiedTables[0]?.addedPolicies).toEqual(["tenants_policy"]);
    expect(diff.modifiedTables[0]?.removedPolicies).toEqual(["old_policy"]);
  });

  it("reports RLS-enabled drift", () => {
    const live = liveSchema([
      liveTable(
        "tenants",
        [
          { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
          { name: "name", dataType: "text", isNullable: false, defaultExpr: null },
        ],
        {
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false }],
          policies: [{ name: "tenants_policy", using: "true", check: null }],
          rlsEnabled: false,
        },
      ),
    ]);
    const diff = diffSchema([targetTenants], live);
    expect(diff.modifiedTables[0]?.rlsTargetEnabled).toBe(true);
    expect(diff.modifiedTables[0]?.rlsLiveEnabled).toBe(false);
  });

  it("normalizes type, default, and whitespace before comparing", () => {
    const live = liveSchema([
      liveTable(
        "tenants",
        [
          { name: "id", dataType: "  UUID  ", isNullable: false, defaultExpr: null },
          { name: "name", dataType: "TEXT", isNullable: false, defaultExpr: null },
        ],
        {
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false }],
          policies: [{ name: "tenants_policy", using: "true", check: null }],
          rlsEnabled: true,
        },
      ),
    ]);
    const diff = diffSchema([targetTenants], live);
    expect(diff.hasDrift).toBe(false);
  });
});

describe("formatSchemaDiff", () => {
  it("prints a no-drift report", () => {
    const out = formatSchemaDiff({
      schema: "meta",
      addedTables: [],
      removedTables: [],
      modifiedTables: [],
      unchangedTables: ["a"],
      hasDrift: false,
    });
    expect(out).toContain("Drift report for schema");
    expect(out).toContain("(no drift)");
  });

  it("prints added, removed, and modified sections", () => {
    const out = formatSchemaDiff({
      schema: "meta",
      addedTables: ["new_table"],
      removedTables: ["dropped_table"],
      modifiedTables: [
        {
          table: "tenants",
          addedColumns: ["new_col"],
          removedColumns: ["old_col"],
          changedColumns: [
            {
              column: "name",
              target: { type: "TEXT", nullable: false, defaultExpr: null },
              live: { type: "VARCHAR", nullable: true, defaultExpr: null },
              reasons: ["type", "nullable"],
            },
          ],
          addedIndexes: ["i_new"],
          removedIndexes: ["i_old"],
          addedPolicies: ["p_new"],
          removedPolicies: ["p_old"],
          addedForeignKeys: ["owner_id"],
          removedForeignKeys: [
            { name: "tenants_old_fkey", columns: ["old_id"], target: "meta.old(id)" },
          ],
          changedForeignKeys: [
            {
              column: "tenant_id",
              constraintName: "tenants_tenant_id_fkey",
              target: { table: "meta.tenants", column: "id", onDelete: "CASCADE" },
              live: { table: "meta.tenants", column: "id", onDelete: "RESTRICT" },
              reasons: ["on_delete"],
            },
          ],
          rlsTargetEnabled: true,
          rlsLiveEnabled: false,
        },
      ],
      unchangedTables: [],
      hasDrift: true,
    });
    expect(out).toContain("+ new_table");
    expect(out).toContain("- dropped_table");
    expect(out).toContain("~ tenants");
    expect(out).toContain("+ column new_col");
    expect(out).toContain("- column old_col");
    expect(out).toContain("~ column name [type, nullable]");
    expect(out).toContain("+ index i_new");
    expect(out).toContain("- index i_old");
    expect(out).toContain("+ policy p_new");
    expect(out).toContain("- policy p_old");
    expect(out).toContain("+ foreign key on owner_id");
    expect(out).toContain("- foreign key tenants_old_fkey");
    expect(out).toContain("~ foreign key on tenant_id [on_delete]");
    expect(out).toContain("RLS target=true live=false");
  });
});

describe("diffSchema — no false drift on a correct schema", () => {
  /**
   * The regression this guards. Comparing declared SQL against what `pg_catalog` reports back
   * reported 138 of 139 tables as modified on a database that had just been applied correctly,
   * which made the drift report unusable and would have made a reconciler act on nothing real.
   */
  const target: TableDefinition = {
    schema: "meta",
    name: "widgets",
    columns: [
      { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
      { name: "created_at", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
      { name: "status", type: "TEXT", notNull: true, default: "'active'" },
      { name: "hash", type: "CHAR(64)" },
      { name: "rate", type: "NUMERIC(12, 6)" },
      { name: "tags", type: "TEXT[]", notNull: true, default: "'{}'" },
      { name: "payload", type: "JSONB", notNull: true, default: "'{}'::jsonb" },
      { name: "code", type: "TEXT", notNull: true, unique: { constraintName: "widgets_code_key" } },
    ],
    primaryKey: ["id"],
    uniqueConstraints: [{ name: "widgets_id_code_key", columns: ["id", "code"] }],
    indexes: [{ name: "idx_widgets_status", columns: ["status"] }],
  };

  const liveTable: LiveTable = {
    schema: "meta",
    name: "widgets",
    columns: [
      { name: "id", dataType: "uuid", isNullable: false, defaultExpr: "uuid_generate_v7()" },
      {
        name: "created_at",
        dataType: "timestamp with time zone",
        isNullable: false,
        defaultExpr: "now()",
      },
      { name: "status", dataType: "text", isNullable: false, defaultExpr: "'active'::text" },
      { name: "hash", dataType: "character(64)", isNullable: true, defaultExpr: null },
      { name: "rate", dataType: "numeric(12,6)", isNullable: true, defaultExpr: null },
      { name: "tags", dataType: "text[]", isNullable: false, defaultExpr: "'{}'::text[]" },
      { name: "payload", dataType: "jsonb", isNullable: false, defaultExpr: "'{}'::jsonb" },
      { name: "code", dataType: "text", isNullable: false, defaultExpr: null },
    ],
    indexes: [
      { name: "widgets_pkey", columns: ["id"], unique: true, primary: true },
      { name: "idx_widgets_status", columns: ["status"], unique: false, primary: false },
      { name: "widgets_code_key", columns: ["code"], unique: true, primary: false },
      { name: "widgets_id_code_key", columns: ["id", "code"], unique: true, primary: false },
    ],
    policies: [],
    foreignKeys: [],
    rlsEnabled: false,
  };

  it("reports no drift for a table Postgres renders differently than it was declared", () => {
    const diff = diffSchema([target], { schema: "meta", tables: [liveTable] });
    expect(diff.hasDrift).toBe(false);
    expect(diff.unchangedTables).toEqual(["widgets"]);
  });

  it("does not report TIMESTAMPTZ as a type change", () => {
    const diff = diffSchema([target], { schema: "meta", tables: [liveTable] });
    expect(diff.modifiedTables).toEqual([]);
  });

  it("does not report a constraint-backed index as removed", () => {
    const diff = diffSchema([target], { schema: "meta", tables: [liveTable] });
    expect(diff.modifiedTables.flatMap((m) => m.removedIndexes)).toEqual([]);
  });

  it("ignores the applier's own migration-log table", () => {
    const diff = diffSchema([target], {
      schema: "meta",
      tables: [liveTable, { ...liveTable, name: "_meta_migrations" }],
    });
    expect(diff.removedTables).toEqual([]);
    expect(diff.hasDrift).toBe(false);
  });

  it("still sees a real type change", () => {
    const drifted: LiveTable = {
      ...liveTable,
      columns: liveTable.columns.map((c) =>
        c.name === "code" ? { ...c, dataType: "uuid" } : c,
      ),
    };
    const diff = diffSchema([target], { schema: "meta", tables: [drifted] });
    expect(diff.modifiedTables[0]?.changedColumns[0]?.reasons).toEqual(["type"]);
  });

  it("still sees a real default change", () => {
    const drifted: LiveTable = {
      ...liveTable,
      columns: liveTable.columns.map((c) =>
        c.name === "status" ? { ...c, defaultExpr: "'archived'::text" } : c,
      ),
    };
    const diff = diffSchema([target], { schema: "meta", tables: [drifted] });
    expect(diff.modifiedTables[0]?.changedColumns[0]?.reasons).toEqual(["default"]);
  });

  it("still sees a genuinely missing constraint-backed index", () => {
    const drifted: LiveTable = {
      ...liveTable,
      indexes: liveTable.indexes.filter((i) => i.name !== "widgets_id_code_key"),
    };
    const diff = diffSchema([target], { schema: "meta", tables: [drifted] });
    expect(diff.modifiedTables[0]?.addedIndexes).toEqual(["widgets_id_code_key"]);
  });

  it("still sees a genuinely extra index", () => {
    const drifted: LiveTable = {
      ...liveTable,
      indexes: [
        ...liveTable.indexes,
        { name: "idx_widgets_adhoc", columns: ["hash"], unique: false, primary: false },
      ],
    };
    const diff = diffSchema([target], { schema: "meta", tables: [drifted] });
    expect(diff.modifiedTables[0]?.removedIndexes).toEqual(["idx_widgets_adhoc"]);
  });
});
