import type { TableDefinition } from "@crossengin/kernel/bootstrap";
import { describe, expect, it } from "vitest";

import { diffSchema, formatSchemaDiff } from "./diff.js";
import type { LiveSchema, LiveTable } from "./introspection.js";

function liveTable(
  name: string,
  columns: LiveTable["columns"],
  extras: Partial<LiveTable> = {},
): LiveTable {
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
