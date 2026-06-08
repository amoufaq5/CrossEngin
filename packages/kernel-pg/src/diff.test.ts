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

  it("treats SQL type aliases as equal (TIMESTAMPTZ ↔ timestamp with time zone, etc.)", () => {
    const target: TableDefinition = {
      schema: "meta",
      name: "t",
      columns: [
        { name: "ts", type: "TIMESTAMPTZ", notNull: true },
        { name: "n", type: "NUMERIC(12, 4)" },
        { name: "s", type: "VARCHAR(255)" },
        { name: "b", type: "BOOLEAN" },
      ],
    };
    const live = liveSchema([
      liveTable("t", [
        { name: "ts", dataType: "timestamp with time zone", isNullable: false, defaultExpr: null },
        { name: "n", dataType: "numeric(12,4)", isNullable: true, defaultExpr: null },
        { name: "s", dataType: "character varying(255)", isNullable: true, defaultExpr: null },
        { name: "b", dataType: "boolean", isNullable: true, defaultExpr: null },
      ]),
    ]);
    expect(diffSchema([target], live).hasDrift).toBe(false);
  });

  it("ignores Postgres ::type casts on defaults", () => {
    const target: TableDefinition = {
      schema: "meta",
      name: "t",
      columns: [
        { name: "status", type: "TEXT", notNull: true, default: "'active'" },
        { name: "tags", type: "JSONB", notNull: true, default: "'[]'::jsonb" },
        { name: "ts", type: "TIMESTAMPTZ", notNull: true, default: "now()" },
      ],
    };
    const live = liveSchema([
      liveTable("t", [
        { name: "status", dataType: "text", isNullable: false, defaultExpr: "'active'::text" },
        { name: "tags", dataType: "jsonb", isNullable: false, defaultExpr: "'[]'::jsonb" },
        { name: "ts", dataType: "timestamp with time zone", isNullable: false, defaultExpr: "now()" },
      ]),
    ]);
    expect(diffSchema([target], live).hasDrift).toBe(false);
  });

  it("does not flag unique-constraint backing indexes as removed", () => {
    const target: TableDefinition = {
      schema: "meta",
      name: "users",
      columns: [
        { name: "id", type: "UUID", notNull: true, primaryKey: true },
        { name: "email", type: "TEXT", notNull: true, unique: true },
        { name: "external_id", type: "TEXT", notNull: true, unique: { constraintName: "users_external_id_key" } },
        { name: "tenant_id", type: "UUID", notNull: true },
      ],
      uniqueConstraints: [{ name: "users_tenant_email_key", columns: ["tenant_id", "email"] }],
    };
    const live = liveSchema([
      liveTable("users", [
        { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
        { name: "email", dataType: "text", isNullable: false, defaultExpr: null },
        { name: "external_id", dataType: "text", isNullable: false, defaultExpr: null },
        { name: "tenant_id", dataType: "uuid", isNullable: false, defaultExpr: null },
      ], {
        indexes: [
          { name: "users_pkey", columns: ["id"], unique: true, primary: true },
          { name: "users_email_key", columns: ["email"], unique: true, primary: false },
          { name: "users_external_id_key", columns: ["external_id"], unique: true, primary: false },
          { name: "users_tenant_email_key", columns: ["tenant_id", "email"], unique: true, primary: false },
        ],
      }),
    ]);
    const diff = diffSchema([target], live);
    expect(diff.hasDrift).toBe(false);
  });

  it("flags a declared unique constraint whose backing index is missing live", () => {
    const target: TableDefinition = {
      schema: "meta",
      name: "users",
      columns: [
        { name: "id", type: "UUID", notNull: true, primaryKey: true },
        { name: "email", type: "TEXT", notNull: true, unique: true },
      ],
    };
    const live = liveSchema([
      liveTable("users", [
        { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
        { name: "email", dataType: "text", isNullable: false, defaultExpr: null },
      ], {
        indexes: [{ name: "users_pkey", columns: ["id"], unique: true, primary: true }],
      }),
    ]);
    const diff = diffSchema([target], live);
    expect(diff.modifiedTables[0]?.addedIndexes).toContain("users_email_key");
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
    expect(out).toContain("RLS target=true live=false");
  });
});
