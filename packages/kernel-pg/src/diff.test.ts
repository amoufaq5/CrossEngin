import type { TableDefinition } from "@crossengin/kernel/bootstrap";
import { describe, expect, it } from "vitest";

import { POLICY_DELTA_REASONS, diffSchema, formatSchemaDiff } from "./diff.js";
import { expressionKey } from "./expression-render.js";
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
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false, method: "btree", predicate: null }],
          policies: [{ name: "tenants_policy", using: "true", check: null, command: "ALL", roles: ["PUBLIC"] }],
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
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false, method: "btree", predicate: null }],
          policies: [{ name: "tenants_policy", using: "true", check: null, command: "ALL", roles: ["PUBLIC"] }],
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
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false, method: "btree", predicate: null }],
          policies: [{ name: "tenants_policy", using: "true", check: null, command: "ALL", roles: ["PUBLIC"] }],
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
            { name: "tenants_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null },
            { name: "tenants_name_idx", columns: ["name"], unique: false, primary: false, method: "btree", predicate: null },
          ],
          policies: [{ name: "tenants_policy", using: "true", check: null, command: "ALL", roles: ["PUBLIC"] }],
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
            { name: "tenants_legacy_idx", columns: ["name"], unique: false, primary: false, method: "btree", predicate: null },
          ],
          policies: [{ name: "tenants_policy", using: "true", check: null, command: "ALL", roles: ["PUBLIC"] }],
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
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false, method: "btree", predicate: null }],
          policies: [{ name: "old_policy", using: "true", check: null, command: "ALL", roles: ["PUBLIC"] }],
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
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false, method: "btree", predicate: null }],
          policies: [{ name: "tenants_policy", using: "true", check: null, command: "ALL", roles: ["PUBLIC"] }],
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
          indexes: [{ name: "tenants_name_idx", columns: ["name"], unique: false, primary: false, method: "btree", predicate: null }],
          policies: [{ name: "tenants_policy", using: "true", check: null, command: "ALL", roles: ["PUBLIC"] }],
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
          changedIndexes: [
            {
              name: "i_changed",
              reasons: ["predicate"],
              detail: "(a = 1) → (a = 2)",
              constraintBacked: false,
            },
          ],
          changedPolicies: [
            { name: "p_changed", reasons: ["using"], detail: "USING (a) → (b)" },
          ],
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
    expect(out).toContain("~ index i_changed [predicate]");
    expect(out).toContain("~ policy p_changed [using]");
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
      { name: "widgets_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null },
      { name: "idx_widgets_status", columns: ["status"], unique: false, primary: false, method: "btree", predicate: null },
      { name: "widgets_code_key", columns: ["code"], unique: true, primary: false, method: "btree", predicate: null },
      { name: "widgets_id_code_key", columns: ["id", "code"], unique: true, primary: false, method: "btree", predicate: null },
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
        { name: "idx_widgets_adhoc", columns: ["hash"], unique: false, primary: false, method: "btree", predicate: null },
      ],
    };
    const diff = diffSchema([target], { schema: "meta", tables: [drifted] });
    expect(diff.modifiedTables[0]?.removedIndexes).toEqual(["idx_widgets_adhoc"]);
  });
});

describe("POLICY_DELTA_REASONS", () => {
  it("lists every way a policy can differ under an unchanged name", () => {
    expect([...POLICY_DELTA_REASONS]).toEqual(["using", "check", "command", "roles"]);
  });
});

describe("diffSchema — in-place index and policy changes", () => {
  /**
   * The gap this closes. Indexes and policies were compared by *name* only, so renaming nothing and
   * editing a predicate, a column list, an access method or a policy clause reconciled to no change.
   */
  const target: TableDefinition = {
    schema: "meta",
    name: "widgets",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      { name: "tenant_id", type: "UUID", notNull: true },
      { name: "status", type: "TEXT", notNull: true },
      { name: "tags", type: "JSONB", notNull: true },
    ],
    primaryKey: ["id"],
    uniqueConstraints: [{ name: "widgets_tenant_status_key", columns: ["tenant_id", "status"] }],
    indexes: [
      { name: "idx_widgets_open", columns: ["status"], where: "status = 'open'" },
      { name: "idx_widgets_tags", columns: ["tags"], kind: "gin" },
      { name: "idx_widgets_pair", columns: ["tenant_id", "status"] },
    ],
    rls: {
      enabled: true,
      policies: [{ name: "widgets_isolation", using: "tenant_id IS NOT NULL" }],
    },
  };

  const RENDERED = {
    byRequest: new Map<string, string | null>([
      [expressionKey("widgets", "status = 'open'"), "(status = 'open'::text)"],
      [expressionKey("widgets", "tenant_id IS NOT NULL"), "(tenant_id IS NOT NULL)"],
    ]),
  };

  function liveWidgets(over: Partial<LiveTable> = {}): LiveTable {
    return liveTable(
      "widgets",
      [
        { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
        { name: "tenant_id", dataType: "uuid", isNullable: false, defaultExpr: null },
        { name: "status", dataType: "text", isNullable: false, defaultExpr: null },
        { name: "tags", dataType: "jsonb", isNullable: false, defaultExpr: null },
      ],
      {
        indexes: [
          { name: "widgets_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null },
          {
            name: "idx_widgets_open",
            columns: ["status"],
            unique: false,
            primary: false,
            method: "btree",
            predicate: "(status = 'open'::text)",
          },
          { name: "idx_widgets_tags", columns: ["tags"], unique: false, primary: false, method: "gin", predicate: null },
          {
            name: "idx_widgets_pair",
            columns: ["tenant_id", "status"],
            unique: false,
            primary: false,
            method: "btree",
            predicate: null,
          },
          {
            name: "widgets_tenant_status_key",
            columns: ["tenant_id", "status"],
            unique: true,
            primary: false,
            method: "btree",
            predicate: null,
          },
        ],
        policies: [{ name: "widgets_isolation", using: "(tenant_id IS NOT NULL)", check: null, command: "ALL", roles: ["PUBLIC"] }],
        rlsEnabled: true,
        ...over,
      },
    );
  }

  function diffWith(over: Partial<LiveTable> = {}) {
    return diffSchema([target], { schema: "meta", tables: [liveWidgets(over)] }, RENDERED);
  }

  it("reports no drift when every definition matches", () => {
    expect(diffWith().hasDrift).toBe(false);
  });

  it("sees a predicate changed under the same name", () => {
    const changed = diffWith({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "idx_widgets_open" ? { ...i, predicate: "(status = 'closed'::text)" } : i,
      ),
    }).modifiedTables[0]?.changedIndexes;
    expect(changed?.[0]?.name).toBe("idx_widgets_open");
    expect(changed?.[0]?.reasons).toEqual(["predicate"]);
    expect(changed?.[0]?.detail).toContain("(status = 'closed'::text) → (status = 'open'::text)");
  });

  it("sees a predicate that was dropped entirely", () => {
    const changed = diffWith({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "idx_widgets_open" ? { ...i, predicate: null } : i,
      ),
    }).modifiedTables[0]?.changedIndexes;
    expect(changed?.[0]?.detail).toContain("absent from the database");
  });

  it("sees a predicate the database has but the catalog does not declare", () => {
    const changed = diffWith({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "idx_widgets_pair" ? { ...i, predicate: "(status = 'x'::text)" } : i,
      ),
    }).modifiedTables[0]?.changedIndexes;
    expect(changed?.[0]?.name).toBe("idx_widgets_pair");
    expect(changed?.[0]?.detail).toContain("not declared");
  });

  it("sees a changed access method", () => {
    const changed = diffWith({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "idx_widgets_tags" ? { ...i, method: "btree" } : i,
      ),
    }).modifiedTables[0]?.changedIndexes;
    expect(changed?.[0]?.reasons).toEqual(["method"]);
    expect(changed?.[0]?.detail).toContain("method btree → gin");
  });

  it("sees a reordered column list", () => {
    const changed = diffWith({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "idx_widgets_pair" ? { ...i, columns: ["status", "tenant_id"] } : i,
      ),
    }).modifiedTables[0]?.changedIndexes;
    expect(changed?.[0]?.reasons).toEqual(["columns"]);
  });

  it("sees uniqueness gained or lost", () => {
    const changed = diffWith({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "idx_widgets_pair" ? { ...i, unique: true } : i,
      ),
    }).modifiedTables[0]?.changedIndexes;
    expect(changed?.[0]?.reasons).toEqual(["unique"]);
  });

  it("reports several reasons at once", () => {
    const changed = diffWith({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "idx_widgets_open"
          ? { ...i, columns: ["id"], method: "hash", predicate: null }
          : i,
      ),
    }).modifiedTables[0]?.changedIndexes;
    expect(changed?.[0]?.reasons).toEqual(["columns", "method", "predicate"]);
  });

  it("sees a changed unique constraint and marks it constraint-backed", () => {
    const changed = diffWith({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "widgets_tenant_status_key" ? { ...i, columns: ["status", "tenant_id"] } : i,
      ),
    }).modifiedTables[0]?.changedIndexes;
    expect(changed?.[0]?.name).toBe("widgets_tenant_status_key");
    expect(changed?.[0]?.constraintBacked).toBe(true);
  });

  it("sees a unique constraint that lost its uniqueness", () => {
    const changed = diffWith({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "widgets_tenant_status_key" ? { ...i, unique: false } : i,
      ),
    }).modifiedTables[0]?.changedIndexes;
    expect(changed?.[0]?.reasons).toEqual(["columns", "unique"]);
  });

  it("sees a changed policy clause", () => {
    const changed = diffWith({
      policies: [{ name: "widgets_isolation", using: "(tenant_id IS NULL)", check: null, command: "ALL", roles: ["PUBLIC"] }],
    }).modifiedTables[0]?.changedPolicies;
    expect(changed?.[0]?.name).toBe("widgets_isolation");
    expect(changed?.[0]?.reasons).toEqual(["using"]);
    expect(changed?.[0]?.detail).toContain("USING (tenant_id IS NULL) → (tenant_id IS NOT NULL)");
  });

  it("compares nothing at all without renderings, rather than inventing drift", () => {
    // Unknown must not read as changed: a caller that did not probe would otherwise see every
    // correct index and policy as drifted.
    const noRenderings = diffSchema([target], { schema: "meta", tables: [liveWidgets()] });
    expect(noRenderings.hasDrift).toBe(false);
    const drifted = diffSchema(
      [target],
      {
        schema: "meta",
        tables: [
          liveWidgets({
            policies: [{ name: "widgets_isolation", using: "(something else)", check: null, command: "ALL", roles: ["PUBLIC"] }],
          }),
        ],
      },
    );
    expect(drifted.hasDrift).toBe(false);
  });

  it("reports a changed command, with no renderer involved", () => {
    const changed = diffWith({
      policies: [
        {
          name: "widgets_isolation",
          using: "(tenant_id IS NOT NULL)",
          check: null,
          command: "SELECT",
          roles: ["PUBLIC"],
        },
      ],
    }).modifiedTables[0]?.changedPolicies;
    expect(changed?.[0]?.name).toBe("widgets_isolation");
    expect(changed?.[0]?.reasons).toEqual(["command"]);
    expect(changed?.[0]?.detail).toContain("FOR SELECT → FOR ALL");
  });

  it("reports a changed role list", () => {
    const changed = diffWith({
      policies: [
        {
          name: "widgets_isolation",
          using: "(tenant_id IS NOT NULL)",
          check: null,
          command: "ALL",
          roles: ["app_reader"],
        },
      ],
    }).modifiedTables[0]?.changedPolicies;
    expect(changed?.[0]?.reasons).toEqual(["roles"]);
    expect(changed?.[0]?.detail).toContain("TO app_reader → TO PUBLIC");
  });

  it("reports a command and a role change together, in reason order", () => {
    const changed = diffWith({
      policies: [
        {
          name: "widgets_isolation",
          using: "(tenant_id IS NULL)",
          check: null,
          command: "DELETE",
          roles: ["app_reader", "app_writer"],
        },
      ],
    }).modifiedTables[0]?.changedPolicies;
    expect(changed?.[0]?.reasons).toEqual(["using", "command", "roles"]);
  });

  it("ignores the order Postgres happens to return the roles in", () => {
    const scoped: TableDefinition = {
      ...target,
      rls: {
        enabled: true,
        policies: [
          {
            name: "widgets_isolation",
            using: "tenant_id IS NOT NULL",
            command: "SELECT",
            roles: ["app_writer", "app_reader"],
          },
        ],
      },
    };
    const live = {
      schema: "meta",
      tables: [
        liveWidgets({
          policies: [
            {
              name: "widgets_isolation",
              using: "(tenant_id IS NOT NULL)",
              check: null,
              command: "SELECT",
              roles: ["app_reader", "app_writer"],
            },
          ],
        }),
      ],
    };
    expect(diffSchema([scoped], live, RENDERED).hasDrift).toBe(false);
  });

  it("reports no drift when the declaration spells the defaults out explicitly", () => {
    // `FOR ALL TO PUBLIC` is what an omitted command and role list already mean, so saying so must
    // not change the answer.
    const explicit: TableDefinition = {
      ...target,
      rls: {
        enabled: true,
        policies: [
          {
            name: "widgets_isolation",
            using: "tenant_id IS NOT NULL",
            command: "ALL",
            roles: ["PUBLIC"],
          },
        ],
      },
    };
    const live = { schema: "meta", tables: [liveWidgets()] };
    expect(diffSchema([explicit], live, RENDERED).hasDrift).toBe(false);
  });

  it("treats an undetermined command or role list as unknown, not as drift", () => {
    // A polcmd this version does not know, or a role oid that resolved to nothing. Reporting either
    // as a difference would invent drift on a policy nobody touched.
    const unknown = diffWith({
      policies: [
        {
          name: "widgets_isolation",
          using: "(tenant_id IS NOT NULL)",
          check: null,
          command: null,
          roles: null,
        },
      ],
    });
    expect(unknown.hasDrift).toBe(false);
  });

  it("reports an expression the table cannot even carry", () => {
    const rendered = {
      byRequest: new Map<string, string | null>([
        [expressionKey("widgets", "tenant_id IS NOT NULL"), null],
      ]),
    };
    const diff = diffSchema([target], { schema: "meta", tables: [liveWidgets()] }, rendered);
    expect(diff.modifiedTables[0]?.changedPolicies[0]?.detail).toContain("cannot be applied");
  });
});
