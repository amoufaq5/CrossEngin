import { describe, expect, it, vi } from "vitest";
import {
  META_SCHEMA_NAME,
  META_TABLES,
  emitBootstrapSql,
  emitSchemaCreate,
  type TableDefinition,
} from "@crossengin/kernel/bootstrap";

import { diffSchema } from "./diff.js";
import { expressionKey } from "./expression-render.js";
import type { LiveSchema, LiveTable } from "./introspection.js";
import {
  RECONCILE_STEP_KINDS,
  UNRECONCILED_REASONS,
  formatReconciliationPlan,
  planLiveReconciliation,
  planSchemaReconciliation,
} from "./reconcile.js";
import type { PgConnection, PgQueryResult } from "./connection.js";

const WIDGETS: TableDefinition = {
  schema: "meta",
  name: "widgets",
  columns: [
    { name: "id", type: "UUID", notNull: true, default: "uuid_generate_v7()" },
    { name: "tenant_id", type: "UUID", notNull: true },
    { name: "code", type: "TEXT", notNull: true, unique: { constraintName: "widgets_code_key" } },
    { name: "label", type: "TEXT" },
    { name: "kind", type: "TEXT", notNull: true, default: "'basic'" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [{ name: "widgets_tenant_code_key", columns: ["tenant_id", "code"] }],
  indexes: [{ name: "idx_widgets_label", columns: ["label"] }],
  rls: {
    enabled: true,
    policies: [{ name: "widgets_isolation", using: "tenant_id = current_setting('x', true)::UUID" }],
  },
};

/** A live table matching `WIDGETS` exactly, as Postgres would report it. */
function liveWidgets(over: Partial<LiveTable> = {}): LiveTable {
  return {
    schema: "meta",
    name: "widgets",
    columns: [
      { name: "id", dataType: "uuid", isNullable: false, defaultExpr: "uuid_generate_v7()" },
      { name: "tenant_id", dataType: "uuid", isNullable: false, defaultExpr: null },
      { name: "code", dataType: "text", isNullable: false, defaultExpr: null },
      { name: "label", dataType: "text", isNullable: true, defaultExpr: null },
      { name: "kind", dataType: "text", isNullable: false, defaultExpr: "'basic'::text" },
    ],
    indexes: [
      { name: "widgets_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null, constraintBacked: true },
      { name: "idx_widgets_label", columns: ["label"], unique: false, primary: false, method: "btree", predicate: null, constraintBacked: false },
      { name: "widgets_code_key", columns: ["code"], unique: true, primary: false, method: "btree", predicate: null, constraintBacked: true },
      { name: "widgets_tenant_code_key", columns: ["tenant_id", "code"], unique: true, primary: false, method: "btree", predicate: null, constraintBacked: true },
    ],
    policies: [{ name: "widgets_isolation", using: "(tenant_id = ...)", check: null, command: "ALL", roles: ["PUBLIC"], permissive: true }],
    foreignKeys: [],
    checkConstraints: [],
    rlsEnabled: true,
    ...over,
  };
}

function live(tables: readonly LiveTable[]): LiveSchema {
  return { schema: "meta", tables };
}

function planFor(target: readonly TableDefinition[], liveSchema: LiveSchema) {
  return planSchemaReconciliation(diffSchema(target, liveSchema), target);
}

describe("RECONCILE_STEP_KINDS", () => {
  it("lists the operations a plan may contain", () => {
    expect([...RECONCILE_STEP_KINDS]).toEqual([
      "create_table",
      "rename_column",
      "add_column",
      "create_index",
      "add_unique_constraint",
      "enable_rls",
      "create_policy",
      "set_column_default",
      "drop_column_default",
      "drop_column_not_null",
      "alter_column_type",
      "add_foreign_key",
      "drop_foreign_key",
      "replace_index",
      "replace_unique_constraint",
      "replace_policy",
      "add_table_constraint",
      "replace_table_constraint",
      "add_column_check",
      "replace_column_check",
    ]);
  });

  it("never drops a table, a column, an index or a policy", () => {
    // A foreign key is the one constraint a plan may drop, and only to let a declared change
    // through — nothing here discards data or loosens access.
    for (const kind of RECONCILE_STEP_KINDS) {
      expect(kind).not.toMatch(/^drop_(table|column|policy|index)$/);
    }
  });
});

describe("UNRECONCILED_REASONS", () => {
  it("covers every difference the plan refuses to close", () => {
    expect([...UNRECONCILED_REASONS]).toEqual([
      "table_removed",
      "column_removed",
      "column_type_changed",
      "column_now_not_null",
      "column_needs_backfill",
      "column_rename_ambiguous",
      "depends_on_unreconciled",
      "index_removed",
      "policy_removed",
      "foreign_key_removed",
      "constraint_needs_validation",
      "constraint_removed",
      "column_check_name_unavailable",
      "rls_unexpectedly_enabled",
    ]);
  });
});

describe("planSchemaReconciliation — a matching schema", () => {
  it("plans nothing when the live schema matches", () => {
    const plan = planFor([WIDGETS], live([liveWidgets()]));
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled).toEqual([]);
    expect(plan.statements).toEqual([]);
  });

  it("carries the schema name through", () => {
    expect(planFor([WIDGETS], live([liveWidgets()])).schema).toBe("meta");
  });
});

describe("planSchemaReconciliation — an empty database", () => {
  it("plans the whole table, statement for statement", () => {
    const plan = planFor([WIDGETS], live([]));
    expect(plan.steps.every((s) => s.kind === "create_table")).toBe(true);
    expect(plan.unreconciled).toEqual([]);
  });

  it("is equivalent to the bootstrap SQL for the real catalog", () => {
    // The property that makes one code path safe for both cases: on an empty database the plan is
    // the bootstrap emission, so a fresh install cannot regress.
    const plan = planFor(META_TABLES, live([]));
    expect([emitSchemaCreate(META_SCHEMA_NAME), ...plan.statements]).toEqual(
      emitBootstrapSql(META_SCHEMA_NAME, META_TABLES),
    );
  });

  it("creates tables in catalog order, so a foreign key never precedes its target", () => {
    const plan = planFor(META_TABLES, live([]));
    const order: string[] = [];
    for (const step of plan.steps) {
      if (step.kind === "create_table" && !order.includes(step.table)) order.push(step.table);
    }
    expect(order).toEqual(META_TABLES.map((t) => t.name));
  });
});

describe("planSchemaReconciliation — additive differences", () => {
  it("adds a missing column with its full declaration", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.filter((c) => c.name !== "kind"),
    });
    const plan = planFor([WIDGETS], live([stale]));
    const step = plan.steps.find((s) => s.kind === "add_column");
    expect(step?.target).toBe("kind");
    expect(step?.sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(step?.sql).toContain("NOT NULL");
    expect(step?.sql).toContain("DEFAULT 'basic'");
  });

  it("creates a missing plain index with CREATE INDEX", () => {
    const stale = liveWidgets({
      indexes: liveWidgets().indexes.filter((i) => i.name !== "idx_widgets_label"),
    });
    const plan = planFor([WIDGETS], live([stale]));
    const step = plan.steps.find((s) => s.kind === "create_index");
    expect(step?.target).toBe("idx_widgets_label");
    expect(step?.sql).toContain("CREATE INDEX");
  });

  it("repairs a missing UNIQUE constraint with ADD CONSTRAINT, not CREATE INDEX", () => {
    // A unique index without the constraint behind it is not what the declaration asked for.
    const stale = liveWidgets({
      indexes: liveWidgets().indexes.filter((i) => i.name !== "widgets_tenant_code_key"),
    });
    const plan = planFor([WIDGETS], live([stale]));
    const step = plan.steps.find((s) => s.kind === "add_unique_constraint");
    expect(step?.target).toBe("widgets_tenant_code_key");
    expect(step?.sql).toContain("ADD CONSTRAINT");
    expect(step?.sql).toContain("UNIQUE");
    expect(step?.guarded).toBe(true);
    expect(plan.steps.some((s) => s.kind === "create_index")).toBe(false);
  });

  it("repairs a column-level UNIQUE constraint the same way", () => {
    const stale = liveWidgets({
      indexes: liveWidgets().indexes.filter((i) => i.name !== "widgets_code_key"),
    });
    const plan = planFor([WIDGETS], live([stale]));
    const step = plan.steps.find((s) => s.kind === "add_unique_constraint");
    expect(step?.target).toBe("widgets_code_key");
    expect(step?.sql).toContain('UNIQUE ("code")');
  });

  it("enables RLS when the catalog wants it and the database has it off", () => {
    const plan = planFor([WIDGETS], live([liveWidgets({ rlsEnabled: false })]));
    const step = plan.steps.find((s) => s.kind === "enable_rls");
    expect(step?.sql).toContain("ENABLE ROW LEVEL SECURITY");
  });

  it("creates a missing policy", () => {
    const plan = planFor([WIDGETS], live([liveWidgets({ policies: [] })]));
    const step = plan.steps.find((s) => s.kind === "create_policy");
    expect(step?.target).toBe("widgets_isolation");
    expect(step?.sql).toContain("CREATE POLICY");
  });

  it("sets a default the database is missing", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.map((c) =>
        c.name === "kind" ? { ...c, defaultExpr: null } : c,
      ),
    });
    const plan = planFor([WIDGETS], live([stale]));
    const step = plan.steps.find((s) => s.kind === "set_column_default");
    expect(step?.sql).toContain("SET DEFAULT 'basic'");
  });

  it("drops a default the catalog no longer declares", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.map((c) =>
        c.name === "label" ? { ...c, defaultExpr: "'x'::text" } : c,
      ),
    });
    const plan = planFor([WIDGETS], live([stale]));
    const step = plan.steps.find((s) => s.kind === "drop_column_default");
    expect(step?.sql).toContain("DROP DEFAULT");
  });

  it("relaxes NOT NULL when the catalog does", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.map((c) =>
        c.name === "label" ? { ...c, isNullable: false } : c,
      ),
    });
    const plan = planFor([WIDGETS], live([stale]));
    const step = plan.steps.find((s) => s.kind === "drop_column_not_null");
    expect(step?.sql).toContain("DROP NOT NULL");
  });

  it("flattens steps into the statement list in order", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.filter((c) => c.name !== "kind"),
      indexes: liveWidgets().indexes.filter((i) => i.name !== "idx_widgets_label"),
    });
    const plan = planFor([WIDGETS], live([stale]));
    expect(plan.statements).toEqual(plan.steps.map((s) => s.sql));
    expect(plan.statements.length).toBeGreaterThan(1);
  });
});

describe("planSchemaReconciliation — what it refuses", () => {
  it("refuses a type change and hands over the SQL", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.map((c) =>
        c.name === "code" ? { ...c, dataType: "uuid" } : c,
      ),
    });
    const plan = planFor([WIDGETS], live([stale]));
    expect(plan.steps).toEqual([]);
    const item = plan.unreconciled.find((u) => u.reason === "column_type_changed");
    expect(item?.target).toBe("code");
    expect(item?.manualSql).toContain("ALTER COLUMN \"code\" TYPE text");
    expect(item?.detail).toContain("decision about existing data");
  });

  it("refuses to tighten a column to NOT NULL", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.map((c) =>
        c.name === "kind" ? { ...c, isNullable: true } : c,
      ),
    });
    const plan = planFor([WIDGETS], live([stale]));
    const item = plan.unreconciled.find((u) => u.reason === "column_now_not_null");
    expect(item?.target).toBe("kind");
    expect(item?.manualSql).toContain("SET NOT NULL");
    expect(plan.steps.some((s) => s.kind === "drop_column_not_null")).toBe(false);
  });

  it("refuses to drop a column that is no longer declared", () => {
    const stale = liveWidgets({
      columns: [
        ...liveWidgets().columns,
        { name: "legacy", dataType: "text", isNullable: true, defaultExpr: null },
      ],
    });
    const plan = planFor([WIDGETS], live([stale]));
    const item = plan.unreconciled.find((u) => u.reason === "column_removed");
    expect(item?.target).toBe("legacy");
    expect(item?.manualSql).toContain("DROP COLUMN");
    expect(plan.statements.some((s) => s.includes("DROP COLUMN"))).toBe(false);
  });

  it("refuses to drop an undeclared index, which may be a deliberate one", () => {
    const stale = liveWidgets({
      indexes: [
        ...liveWidgets().indexes,
        { name: "idx_widgets_adhoc", columns: ["kind"], unique: false, primary: false, method: "btree", predicate: null, constraintBacked: false },
      ],
    });
    const plan = planFor([WIDGETS], live([stale]));
    const item = plan.unreconciled.find((u) => u.reason === "index_removed");
    expect(item?.target).toBe("idx_widgets_adhoc");
    expect(item?.manualSql).toContain("DROP INDEX");
  });

  it("refuses to drop an undeclared policy, because that loosens access", () => {
    const stale = liveWidgets({
      policies: [
        ...liveWidgets().policies,
        { name: "widgets_extra", using: "true", check: null, command: "ALL", roles: ["PUBLIC"], permissive: true },
      ],
    });
    const plan = planFor([WIDGETS], live([stale]));
    const item = plan.unreconciled.find((u) => u.reason === "policy_removed");
    expect(item?.target).toBe("widgets_extra");
    expect(item?.manualSql).toContain("DROP POLICY");
  });

  it("refuses to disable RLS the catalog does not ask for", () => {
    const platform: TableDefinition = { ...WIDGETS, rls: undefined };
    const plan = planFor([platform], live([liveWidgets()]));
    const item = plan.unreconciled.find((u) => u.reason === "rls_unexpectedly_enabled");
    expect(item?.detail).toContain("loosen");
    expect(plan.statements.some((s) => s.includes("DISABLE ROW LEVEL SECURITY"))).toBe(false);
  });

  it("refuses to drop a table the catalog does not declare", () => {
    const orphan: LiveTable = { ...liveWidgets(), name: "old_widgets" };
    const plan = planFor([WIDGETS], live([liveWidgets(), orphan]));
    const item = plan.unreconciled.find((u) => u.reason === "table_removed");
    expect(item?.target).toBe("old_widgets");
    expect(item?.manualSql).toContain("DROP TABLE");
  });

  it("ignores the applier's own bookkeeping table", () => {
    const log: LiveTable = { ...liveWidgets(), name: "_meta_migrations" };
    const plan = planFor([WIDGETS], live([liveWidgets(), log]));
    expect(plan.unreconciled).toEqual([]);
  });

  it("plans the safe half of a column that changed in two ways at once", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.map((c) =>
        c.name === "kind" ? { ...c, dataType: "uuid", defaultExpr: null } : c,
      ),
    });
    const plan = planFor([WIDGETS], live([stale]));
    expect(plan.steps.map((s) => s.kind)).toEqual(["set_column_default"]);
    expect(plan.unreconciled.map((u) => u.reason)).toEqual(["column_type_changed"]);
  });
});

describe("formatReconciliationPlan", () => {
  it("says so when there is nothing to do", () => {
    const text = formatReconciliationPlan(planFor([WIDGETS], live([liveWidgets()])));
    expect(text).toContain("nothing to do");
  });

  it("lists each step with its kind and target", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.filter((c) => c.name !== "kind"),
    });
    const text = formatReconciliationPlan(planFor([WIDGETS], live([stale])));
    expect(text).toContain("add_column widgets.kind");
  });

  it("marks a guarded step", () => {
    const stale = liveWidgets({
      indexes: liveWidgets().indexes.filter((i) => i.name !== "widgets_tenant_code_key"),
    });
    const text = formatReconciliationPlan(planFor([WIDGETS], live([stale])));
    expect(text).toContain("[guarded]");
  });

  it("prints each refusal with its reason and manual SQL", () => {
    const stale = liveWidgets({
      columns: liveWidgets().columns.map((c) =>
        c.name === "code" ? { ...c, dataType: "uuid" } : c,
      ),
    });
    const text = formatReconciliationPlan(planFor([WIDGETS], live([stale])));
    expect(text).toContain("[column_type_changed] widgets.code");
    expect(text).toContain("manual:");
  });
});

describe("formatReconciliationPlan — grouping", () => {
  it("prints one line per table for a create, not one per statement", () => {
    const text = formatReconciliationPlan(planFor([WIDGETS], live([])));
    const createLines = text.split("\n").filter((l) => l.includes("create_table"));
    expect(createLines).toHaveLength(1);
    expect(createLines[0]).toContain("create_table widgets");
    expect(createLines[0]).toContain("statements)");
  });

  it("does not repeat the table name for a table-level step", () => {
    const text = formatReconciliationPlan(planFor([WIDGETS], live([])));
    expect(text).not.toContain("widgets.widgets");
  });

  it("keeps the whole catalog readable", () => {
    const text = formatReconciliationPlan(planFor(META_TABLES, live([])));
    expect(text.split("\n").filter((l) => l.includes("create_table"))).toHaveLength(
      META_TABLES.length,
    );
  });
});

const CHILD: TableDefinition = {
  schema: "meta",
  name: "children",
  columns: [
    { name: "id", type: "UUID", notNull: true },
    {
      name: "tenant_id",
      type: "UUID",
      notNull: true,
      references: { schema: "meta", table: "tenants", column: "id", onDelete: "CASCADE" },
    },
    {
      name: "owner_id",
      type: "UUID",
      // No onDelete: the emitter writes RESTRICT, so that is what the database will hold.
      references: { schema: "meta", table: "users", column: "id" },
    },
    { name: "label", type: "TEXT" },
  ],
  primaryKey: ["id"],
};

function liveChild(over: Partial<LiveTable> = {}): LiveTable {
  return {
    schema: "meta",
    name: "children",
    columns: [
      { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
      { name: "tenant_id", dataType: "uuid", isNullable: false, defaultExpr: null },
      { name: "owner_id", dataType: "uuid", isNullable: true, defaultExpr: null },
      { name: "label", dataType: "text", isNullable: true, defaultExpr: null },
    ],
    indexes: [{ name: "children_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null, constraintBacked: true }],
    policies: [],
    foreignKeys: [
      {
        name: "children_tenant_id_fkey",
        columns: ["tenant_id"],
        targetSchema: "meta",
        targetTable: "tenants",
        targetColumns: ["id"],
        onDelete: "CASCADE",
        onUpdate: "NO ACTION",
      },
      {
        name: "children_owner_id_fkey",
        columns: ["owner_id"],
        targetSchema: "meta",
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "RESTRICT",
        onUpdate: "NO ACTION",
      },
    ],
    checkConstraints: [],
    rlsEnabled: false,
    ...over,
  };
}

describe("foreign keys — a matching schema", () => {
  it("plans nothing when every declared reference is present", () => {
    const plan = planFor([CHILD], live([liveChild()]));
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled).toEqual([]);
  });

  it("treats an omitted onDelete as the RESTRICT the emitter writes", () => {
    // The default is not "unspecified" in the database; comparing against undefined would report
    // drift on every reference that leaves it out.
    const plan = planFor([CHILD], live([liveChild()]));
    expect(plan.statements).toEqual([]);
  });
});

describe("foreign keys — additive", () => {
  it("adds a declared reference the database lacks", () => {
    const stale = liveChild({
      foreignKeys: liveChild().foreignKeys.filter((f) => f.columns[0] !== "owner_id"),
    });
    const plan = planFor([CHILD], live([stale]));
    const step = plan.steps.find((s) => s.kind === "add_foreign_key");
    expect(step?.target).toBe("owner_id");
    expect(step?.sql).toContain('ADD CONSTRAINT "children_owner_id_fkey"');
    expect(step?.sql).toContain('REFERENCES "meta"."users"("id")');
    expect(step?.sql).toContain("ON DELETE RESTRICT");
  });

  it("uses the declared onDelete when one is given", () => {
    const stale = liveChild({
      foreignKeys: liveChild().foreignKeys.filter((f) => f.columns[0] !== "tenant_id"),
    });
    const plan = planFor([CHILD], live([stale]));
    const step = plan.steps.find((s) => s.kind === "add_foreign_key");
    expect(step?.sql).toContain("ON DELETE CASCADE");
  });

  it("is not guarded, because a failure means the data already contradicts the catalog", () => {
    const stale = liveChild({ foreignKeys: [] });
    const plan = planFor([CHILD], live([stale]));
    expect(plan.steps.filter((s) => s.kind === "add_foreign_key").every((s) => !s.guarded)).toBe(
      true,
    );
  });
});

describe("foreign keys — changed declarations", () => {
  it("replaces a reference whose onDelete changed, dropping before adding", () => {
    const drifted = liveChild({
      foreignKeys: liveChild().foreignKeys.map((f) =>
        f.columns[0] === "tenant_id" ? { ...f, onDelete: "RESTRICT" as const } : f,
      ),
    });
    const plan = planFor([CHILD], live([drifted]));
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toEqual(["drop_foreign_key", "add_foreign_key"]);
    expect(plan.steps[0]?.sql).toContain('DROP CONSTRAINT IF EXISTS "children_tenant_id_fkey"');
    expect(plan.steps[1]?.sql).toContain("ON DELETE CASCADE");
  });

  it("replaces a reference whose target changed", () => {
    const drifted = liveChild({
      foreignKeys: liveChild().foreignKeys.map((f) =>
        f.columns[0] === "owner_id" ? { ...f, targetTable: "tenants" } : f,
      ),
    });
    const plan = planFor([CHILD], live([drifted]));
    expect(plan.steps.map((s) => s.kind)).toEqual(["drop_foreign_key", "add_foreign_key"]);
    expect(plan.steps[1]?.sql).toContain('REFERENCES "meta"."users"("id")');
  });

  it("treats a composite constraint on a single-column declaration as a change", () => {
    const drifted = liveChild({
      foreignKeys: liveChild().foreignKeys.map((f) =>
        f.columns[0] === "owner_id" ? { ...f, targetColumns: ["id", "email"] } : f,
      ),
    });
    const plan = planFor([CHILD], live([drifted]));
    expect(plan.steps.map((s) => s.kind)).toEqual(["drop_foreign_key", "add_foreign_key"]);
  });
});

describe("foreign keys — undeclared", () => {
  it("reports an undeclared constraint rather than dropping it", () => {
    const extra = liveChild({
      foreignKeys: [
        ...liveChild().foreignKeys,
        {
          name: "children_label_fkey",
          columns: ["label"],
          targetSchema: "meta",
          targetTable: "tenants",
          targetColumns: ["slug"],
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
        },
      ],
    });
    const plan = planFor([CHILD], live([extra]));
    expect(plan.steps).toEqual([]);
    const item = plan.unreconciled.find((u) => u.reason === "foreign_key_removed");
    expect(item?.target).toBe("children_label_fkey");
    expect(item?.detail).toContain("meta.tenants(slug)");
    expect(item?.manualSql).toContain("DROP CONSTRAINT");
  });

  it("drops it under allowLoosening, which is the only thing that flag does", () => {
    const extra = liveChild({
      foreignKeys: [
        ...liveChild().foreignKeys,
        {
          name: "children_label_fkey",
          columns: ["label"],
          targetSchema: "meta",
          targetTable: "tenants",
          targetColumns: ["slug"],
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
        },
      ],
    });
    const plan = planSchemaReconciliation(
      diffSchema([CHILD], live([extra])),
      [CHILD],
      undefined,
      { allowLoosening: true },
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(["drop_foreign_key"]);
    expect(plan.steps[0]?.target).toBe("children_label_fkey");
    expect(plan.steps[0]?.sql).toBe(
      `ALTER TABLE "meta"."children" DROP CONSTRAINT IF EXISTS "children_label_fkey";`,
    );
    expect(plan.unreconciled).toEqual([]);
  });

  it("is byte-identical to the default when the flag is false", () => {
    const extra = liveChild({
      foreignKeys: [
        ...liveChild().foreignKeys,
        {
          name: "children_label_fkey",
          columns: ["label"],
          targetSchema: "meta",
          targetTable: "tenants",
          targetColumns: ["slug"],
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
        },
      ],
    });
    const diff = diffSchema([CHILD], live([extra]));
    expect(
      planSchemaReconciliation(diff, [CHILD], undefined, { allowLoosening: false }),
    ).toEqual(planSchemaReconciliation(diff, [CHILD]));
  });

  it("names the columns the undeclared constraint sits on", () => {
    const extra = liveChild({
      foreignKeys: [
        ...liveChild().foreignKeys,
        {
          name: "children_pair_fkey",
          columns: ["id", "label"],
          targetSchema: "meta",
          targetTable: "tenants",
          targetColumns: ["id", "slug"],
          onDelete: "NO ACTION",
          onUpdate: "NO ACTION",
        },
      ],
    });
    const plan = planFor([CHILD], live([extra]));
    expect(plan.unreconciled[0]?.detail).toContain("(id, label)");
  });
});

describe("a type change, now that foreign keys are visible", () => {
  /** `owner_id` loses its reference and becomes TEXT — ADR-0289's `declared_by` change exactly. */
  const retyped: TableDefinition = {
    ...CHILD,
    columns: CHILD.columns.map((c) =>
      c.name === "owner_id" ? { name: "owner_id", type: "TEXT" } : c,
    ),
  };

  it("drops the blocking constraint first, then rewrites the type", () => {
    const plan = planSchemaReconciliation(
      diffSchema([retyped], live([liveChild()])),
      [retyped],
      { rowCounts: new Map([["children", 0]]) },
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(["drop_foreign_key", "alter_column_type"]);
    expect(plan.steps[0]?.target).toBe("children_owner_id_fkey");
    expect(plan.steps[1]?.sql).toContain("ALTER COLUMN \"owner_id\" TYPE text");
    expect(plan.unreconciled).toEqual([]);
  });

  it("guards the rewrite on the table still being empty", () => {
    const plan = planSchemaReconciliation(
      diffSchema([retyped], live([liveChild()])),
      [retyped],
      { rowCounts: new Map([["children", 0]]) },
    );
    const step = plan.steps.find((s) => s.kind === "alter_column_type");
    expect(step?.guarded).toBe(true);
    expect(step?.sql).toContain("SELECT count(*) INTO existing");
    expect(step?.sql).toContain("RAISE EXCEPTION");
  });

  it("refuses the rewrite when the table holds rows, and keeps the constraint", () => {
    const plan = planSchemaReconciliation(
      diffSchema([retyped], live([liveChild()])),
      [retyped],
      { rowCounts: new Map([["children", 7]]) },
    );
    expect(plan.steps.some((s) => s.kind === "alter_column_type")).toBe(false);
    expect(plan.steps.some((s) => s.kind === "drop_foreign_key")).toBe(false);
    const item = plan.unreconciled.find((u) => u.reason === "column_type_changed");
    expect(item?.detail).toContain("7 row(s)");
    expect(plan.unreconciled.some((u) => u.reason === "foreign_key_removed")).toBe(true);
  });

  it("refuses the rewrite when no probe says how many rows there are", () => {
    // Fail closed: not knowing is not the same as knowing it is empty.
    const plan = planFor([retyped], live([liveChild()]));
    expect(plan.steps.some((s) => s.kind === "alter_column_type")).toBe(false);
    expect(plan.unreconciled.find((u) => u.reason === "column_type_changed")?.detail).toContain(
      "unknown number of",
    );
  });
});

describe("adding a column to a table that already holds rows", () => {
  /** `stamp` is NOT NULL with no default; `note` is nullable; `kind` has a default. */
  const grown: TableDefinition = {
    ...CHILD,
    columns: [
      ...CHILD.columns,
      { name: "stamp", type: "INTEGER", notNull: true },
      { name: "note", type: "TEXT" },
      { name: "kind", type: "TEXT", notNull: true, default: "'basic'" },
    ],
  };

  function planWithRows(rows: number) {
    return planSchemaReconciliation(diffSchema([grown], live([liveChild()])), [grown], {
      rowCounts: new Map([["children", rows]]),
    });
  }

  it("adds all three when the table is empty", () => {
    const plan = planWithRows(0);
    expect(plan.steps.map((s) => s.target)).toEqual(["stamp", "note", "kind"]);
    expect(plan.unreconciled).toEqual([]);
  });

  it("refuses only the unfillable one when the table holds rows", () => {
    // The defect this guards: the step was planned unconditionally, so a live upgrade halted on
    // statement #1 and left every later statement unapplied.
    const plan = planWithRows(3);
    expect(plan.steps.map((s) => s.target)).toEqual(["note", "kind"]);
    const item = plan.unreconciled.find((u) => u.reason === "column_needs_backfill");
    expect(item?.target).toBe("stamp");
    expect(item?.detail).toContain("3 row(s)");
  });

  it("hands over SQL that adds the column nullable, then tightens it", () => {
    const item = planWithRows(3).unreconciled.find((u) => u.reason === "column_needs_backfill");
    expect(item?.manualSql).toContain('ADD COLUMN "stamp" INTEGER');
    expect(item?.manualSql).not.toContain('ADD COLUMN "stamp" INTEGER NOT NULL');
    expect(item?.manualSql).toContain("backfill");
    expect(item?.manualSql).toContain("SET NOT NULL");
  });

  it("refuses when no probe says how many rows there are", () => {
    const plan = planFor([grown], live([liveChild()]));
    expect(plan.steps.map((s) => s.target)).toEqual(["note", "kind"]);
    expect(plan.unreconciled.some((u) => u.reason === "column_needs_backfill")).toBe(true);
  });

  it("still adds a NOT NULL column that carries a default, whatever the row count", () => {
    // Postgres fills existing rows from the default, so there is no decision to make.
    const plan = planWithRows(1000);
    expect(plan.steps.some((s) => s.target === "kind")).toBe(true);
  });
});

describe("refusals propagate to whatever depends on them", () => {
  const grown: TableDefinition = {
    ...CHILD,
    columns: [...CHILD.columns, { name: "stamp", type: "INTEGER", notNull: true }],
    uniqueConstraints: [{ name: "children_stamp_key", columns: ["stamp", "id"] }],
    indexes: [
      { name: "idx_children_stamp", columns: ["stamp"] },
      { name: "idx_children_label", columns: ["label"] },
    ],
  };

  function planWithRows(rows: number) {
    return planSchemaReconciliation(diffSchema([grown], live([liveChild()])), [grown], {
      rowCounts: new Map([["children", rows]]),
    });
  }

  it("creates everything when the column can be added", () => {
    const plan = planWithRows(0);
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "add_column",
      "create_index",
      "create_index",
      "add_unique_constraint",
    ]);
    expect(plan.unreconciled).toEqual([]);
  });

  it("refuses an index over a column it is not adding", () => {
    // Found live: the constraint failed with `column "year" named in key does not exist` after the
    // column it covers was refused.
    const plan = planWithRows(2);
    const blocked = plan.unreconciled.filter((u) => u.reason === "depends_on_unreconciled");
    expect(blocked.map((b) => b.target).sort()).toEqual([
      "children_stamp_key",
      "idx_children_stamp",
    ]);
    expect(blocked[0]?.detail).toContain("'stamp'");
  });

  it("still creates the objects that do not depend on the refused column", () => {
    const plan = planWithRows(2);
    expect(plan.steps.map((s) => s.target)).toEqual(["idx_children_label"]);
  });

  it("refuses a foreign key on a column it is not adding", () => {
    const withRef: TableDefinition = {
      ...CHILD,
      columns: [
        ...CHILD.columns,
        {
          name: "parent_id",
          type: "UUID",
          notNull: true,
          references: { schema: "meta", table: "tenants", column: "id" },
        },
      ],
    };
    const plan = planSchemaReconciliation(diffSchema([withRef], live([liveChild()])), [withRef], {
      rowCounts: new Map([["children", 5]]),
    });
    expect(plan.steps.some((s) => s.kind === "add_foreign_key")).toBe(false);
    const blocked = plan.unreconciled.find((u) => u.reason === "depends_on_unreconciled");
    expect(blocked?.target).toBe("parent_id");
    expect(blocked?.detail).toContain("foreign key");
  });
});

describe("replacing a changed index, constraint or policy", () => {
  const RENDERED = {
    byRequest: new Map<string, string | null>([
      // Must equal what the fixture's live policy reports, so the matching case matches.
      [expressionKey("widgets", "tenant_id = current_setting('x', true)::UUID"), "(tenant_id = ...)"],
    ]),
  };

  function planChanged(over: Partial<LiveTable>) {
    const liveSchema = live([liveWidgets(over)]);
    return planSchemaReconciliation(diffSchema([WIDGETS], liveSchema, RENDERED), [WIDGETS]);
  }

  it("replaces an index whose definition changed, in one statement", () => {
    // One statement because the applier wraps each in its own transaction; two would leave a window
    // with the index gone.
    const plan = planChanged({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "idx_widgets_label" ? { ...i, columns: ["code"] } : i,
      ),
    });
    const step = plan.steps.find((s) => s.kind === "replace_index");
    expect(step?.target).toBe("idx_widgets_label");
    expect(step?.sql).toContain("DROP INDEX");
    expect(step?.sql).toContain("CREATE INDEX");
    expect(step?.sql.split(";").filter((s) => s.trim().length > 0)).toHaveLength(2);
  });

  it("routes a constraint-backed index through the constraint, not DROP INDEX", () => {
    // `DROP INDEX` on a constraint's index is refused outright by Postgres.
    const plan = planChanged({
      indexes: liveWidgets().indexes.map((i) =>
        i.name === "widgets_tenant_code_key" ? { ...i, columns: ["code", "tenant_id"] } : i,
      ),
    });
    const step = plan.steps.find((s) => s.kind === "replace_unique_constraint");
    expect(step?.target).toBe("widgets_tenant_code_key");
    expect(step?.sql).toContain("DROP CONSTRAINT IF EXISTS");
    expect(step?.sql).toContain("ADD CONSTRAINT");
    expect(step?.sql).not.toContain("DROP INDEX");
    expect(step?.guarded).toBe(true);
  });

  it("drops the constraint when a declared index is constraint-backed in the database", () => {
    // A unique constraint promoted to a predicated unique index — the only way to express a
    // predicate, since a UNIQUE constraint cannot carry one. The catalog now declares an *index*, so
    // the old branch read `constraintBacked` from the declaration and emitted a plain DROP INDEX,
    // which Postgres refuses: "cannot drop index … because constraint … requires it". That put a step
    // in the plan that could not succeed, which the plan's one invariant forbids. Measured live.
    const PROMOTED: TableDefinition = {
      ...WIDGETS,
      uniqueConstraints: [],
      indexes: [
        ...(WIDGETS.indexes ?? []),
        {
          name: "widgets_tenant_code_key",
          columns: ["tenant_id", "code"],
          unique: true,
          where: "code IS NOT NULL",
        },
      ],
    };
    // The declared predicate needs a rendering, or it is not compared at all and the promotion reads
    // as no change — which is correct caution, not a bug (ADR-0292), but it means this case only
    // surfaces where the renderings are supplied, as the CLI supplies them.
    const rendered = {
      byRequest: new Map<string, string | null>([
        ...RENDERED.byRequest,
        [expressionKey("widgets", "code IS NOT NULL"), "(code IS NOT NULL)"],
      ]),
    };
    const plan = planSchemaReconciliation(
      diffSchema([PROMOTED], live([liveWidgets()]), rendered),
      [PROMOTED],
    );
    const step = plan.steps.find((s) => s.target === "widgets_tenant_code_key");
    expect(step?.kind).toBe("replace_index");
    expect(step?.sql).toContain("DROP CONSTRAINT");
    expect(step?.sql).toContain("CREATE UNIQUE INDEX");
    expect(step?.sql).toContain("WHERE code IS NOT NULL");
    // The refused spelling: dropping the index directly leaves the constraint owning it.
    expect(step?.sql).not.toContain("DROP INDEX");
    expect(plan.unreconciled).toHaveLength(0);
  });

  it("replaces a policy whose clause changed, in one statement", () => {
    // A table with RLS on and no policy denies every row, so a window between the two would be an
    // outage rather than a leak — and one statement means there is no window.
    const plan = planChanged({
      policies: [{ name: "widgets_isolation", using: "(something else)", check: null, command: "ALL", roles: ["PUBLIC"], permissive: true }],
    });
    const step = plan.steps.find((s) => s.kind === "replace_policy");
    expect(step?.target).toBe("widgets_isolation");
    expect(step?.sql).toContain("DROP POLICY");
    expect(step?.sql).toContain("CREATE POLICY");
  });

  it("replaces a policy whose command changed, through the same step kind", () => {
    // A command change is unambiguous — the catalog says what the policy should govern — so it needs
    // no new step kind, only the existing replacement carrying the clause.
    const plan = planChanged({
      policies: [
        {
          name: "widgets_isolation",
          using: "(tenant_id = ...)",
          check: null,
          command: "SELECT",
          roles: ["PUBLIC"],
          permissive: true,
        },
      ],
    });
    const step = plan.steps.find((s) => s.kind === "replace_policy");
    expect(step?.target).toBe("widgets_isolation");
    expect(step?.sql).toContain("DROP POLICY");
    expect(step?.sql).toContain("CREATE POLICY");
    expect(plan.steps.map((s) => s.kind)).toEqual(["replace_policy"]);
  });

  it("replaces a policy whose role list changed, re-stating the declared grant", () => {
    const plan = planChanged({
      policies: [
        {
          name: "widgets_isolation",
          using: "(tenant_id = ...)",
          check: null,
          command: "ALL",
          roles: ["app_reader"],
          permissive: true,
        },
      ],
    });
    const step = plan.steps.find((s) => s.kind === "replace_policy");
    expect(step?.target).toBe("widgets_isolation");
    // The catalog declares neither, so the replacement restores `FOR ALL TO PUBLIC` by writing
    // neither clause — a narrowed grant nobody declared is widened back to the declaration.
    expect(step?.sql).not.toContain(" TO ");
    expect(step?.sql).not.toContain(" FOR ");
  });

  it("re-states a declared command and role list when it replaces a scoped policy", () => {
    const scoped: TableDefinition = {
      ...WIDGETS,
      rls: {
        enabled: true,
        policies: [
          {
            name: "widgets_isolation",
            using: "tenant_id = current_setting('x', true)::UUID",
            command: "SELECT",
            roles: ["app_reader"],
          },
        ],
      },
    };
    const liveSchema = live([
      liveWidgets({
        policies: [
          {
            name: "widgets_isolation",
            using: "(tenant_id = ...)",
            check: null,
            command: "ALL",
            roles: ["PUBLIC"],
            permissive: true,
          },
        ],
      }),
    ]);
    const plan = planSchemaReconciliation(diffSchema([scoped], liveSchema, RENDERED), [scoped]);
    const step = plan.steps.find((s) => s.kind === "replace_policy");
    expect(step?.sql).toContain("FOR SELECT");
    expect(step?.sql).toContain(`TO "app_reader"`);
    // One statement: a table with RLS on and no policy denies every row.
    expect(step?.sql.split(";").filter((s) => s.trim().length > 0)).toHaveLength(2);
  });

  it("creates a scoped policy with its command and roles when the database has none", () => {
    const scoped: TableDefinition = {
      ...WIDGETS,
      rls: {
        enabled: true,
        policies: [
          {
            name: "widgets_isolation",
            using: "tenant_id = current_setting('x', true)::UUID",
            command: "UPDATE",
            roles: ["app_writer"],
          },
        ],
      },
    };
    const plan = planSchemaReconciliation(
      diffSchema([scoped], live([liveWidgets({ policies: [] })]), RENDERED),
      [scoped],
    );
    const step = plan.steps.find((s) => s.kind === "create_policy");
    expect(step?.sql).toContain("FOR UPDATE");
    expect(step?.sql).toContain(`TO "app_writer"`);
  });

  it("plans nothing when the definitions match", () => {
    expect(planChanged({}).steps).toEqual([]);
  });

  it("plans nothing when a scoped policy matches the database exactly", () => {
    const scoped: TableDefinition = {
      ...WIDGETS,
      rls: {
        enabled: true,
        policies: [
          {
            name: "widgets_isolation",
            using: "tenant_id = current_setting('x', true)::UUID",
            command: "SELECT",
            roles: ["app_reader"],
          },
        ],
      },
    };
    const liveSchema = live([
      liveWidgets({
        policies: [
          {
            name: "widgets_isolation",
            using: "(tenant_id = ...)",
            check: null,
            command: "SELECT",
            roles: ["app_reader"],
            permissive: true,
          },
        ],
      }),
    ]);
    expect(
      planSchemaReconciliation(diffSchema([scoped], liveSchema, RENDERED), [scoped]).steps,
    ).toEqual([]);
  });

  /**
   * An INSERT-scoped policy carries only `WITH CHECK` — Postgres refuses `USING` on one — so these
   * cover the two things that have to hold for such a policy to be declarable at all: it is planned
   * with no `USING` clause, and a database that already has it reads as matching rather than as
   * drifted (which is how an unplannable statement would otherwise be re-planned forever).
   */
  const INSERT_ONLY: TableDefinition = {
    ...WIDGETS,
    rls: {
      enabled: true,
      policies: [
        {
          name: "widgets_isolation",
          using: "tenant_id = current_setting('x', true)::UUID",
        },
        {
          name: "widgets_platform_write",
          command: "INSERT",
          check: "tenant_id IS NULL",
        },
      ],
    },
  };
  const INSERT_RENDERED = {
    byRequest: new Map<string, string | null>([
      ...RENDERED.byRequest,
      [expressionKey("widgets", "tenant_id IS NULL"), "(tenant_id IS NULL)"],
    ]),
  };

  it("plans an INSERT-scoped policy with WITH CHECK and no USING", () => {
    const plan = planSchemaReconciliation(
      diffSchema([INSERT_ONLY], live([liveWidgets()]), INSERT_RENDERED),
      [INSERT_ONLY],
    );
    const step = plan.steps.find(
      (st) => st.kind === "create_policy" && st.target === "widgets_platform_write",
    );
    expect(step?.sql).toContain("FOR INSERT");
    expect(step?.sql).toContain("WITH CHECK (tenant_id IS NULL)");
    expect(step?.sql).not.toContain("USING");
  });

  it("reads an existing INSERT-scoped policy as matching, not as drifted", () => {
    const liveSchema = live([
      liveWidgets({
        policies: [
          ...liveWidgets().policies,
          {
            name: "widgets_platform_write",
            using: null,
            check: "(tenant_id IS NULL)",
            command: "INSERT",
            roles: ["PUBLIC"],
            permissive: true,
          },
        ],
      }),
    ]);
    const plan = planSchemaReconciliation(
      diffSchema([INSERT_ONLY], liveSchema, INSERT_RENDERED),
      [INSERT_ONLY],
    );
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled).toEqual([]);
  });

  it("refuses to replace an index covering a column it is not adding", () => {
    const grown: TableDefinition = {
      ...WIDGETS,
      columns: [...WIDGETS.columns, { name: "stamp", type: "INTEGER", notNull: true }],
      indexes: [{ name: "idx_widgets_label", columns: ["stamp"] }],
    };
    const plan = planSchemaReconciliation(
      diffSchema([grown], live([liveWidgets()]), RENDERED),
      [grown],
      { rowCounts: new Map([["widgets", 4]]) },
    );
    expect(plan.steps.some((s) => s.kind === "replace_index")).toBe(false);
    expect(plan.unreconciled.some((u) => u.reason === "depends_on_unreconciled")).toBe(true);
  });
});

describe("a column arriving with the constraints ADD COLUMN carries", () => {
  /**
   * The defect this pins, measured against a real Postgres: a column declared with an inline
   * `REFERENCES` and missing from the live schema was planned twice — once as `add_column`, which
   * carries the reference, and again as `add_foreign_key`, which then failed with
   * `constraint "…_fkey" for relation "…" already exists`. The diff is computed against the schema as
   * it was *before* the plan runs, where the column does not exist at all, so the reference reads as
   * declared-but-missing. One guaranteed failure per added reference is the plan's central invariant
   * being false, not a reporting wrinkle.
   */
  const CARRIER: TableDefinition = {
    schema: "meta",
    name: "flags",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      {
        name: "tenant_id",
        type: "UUID",
        references: { schema: "meta", table: "tenants", column: "id", onDelete: "CASCADE" },
      },
      { name: "slug", type: "TEXT", unique: true },
      { name: "named", type: "TEXT", unique: { constraintName: "flags_named_key" } },
      { name: "status", type: "TEXT", check: "status IN ('on','off')" },
    ],
    primaryKey: ["id"],
  };

  /** The live table before any of the five columns but `id` exist. */
  function bareFlags(): LiveTable {
    return {
      schema: "meta",
      name: "flags",
      columns: [{ name: "id", dataType: "uuid", isNullable: false, defaultExpr: null }],
      indexes: [
        { name: "flags_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null, constraintBacked: true },
      ],
      policies: [],
      foreignKeys: [],
      checkConstraints: [],
      rlsEnabled: false,
    };
  }

  const plan = planSchemaReconciliation(
    diffSchema([CARRIER], live([bareFlags()])),
    [CARRIER],
    { rowCounts: new Map([["flags", 0]]) },
  );

  it("plans one step for a column that carries its own reference, not two", () => {
    const touching = plan.steps.filter((s) => s.target === "tenant_id");
    expect(touching.map((s) => s.kind)).toEqual(["add_column"]);
    expect(plan.steps.some((s) => s.kind === "add_foreign_key")).toBe(false);
  });

  it("still writes the reference into the ADD COLUMN, so the constraint is really created", () => {
    const step = plan.steps.find((s) => s.target === "tenant_id");
    expect(step?.sql).toContain(`REFERENCES "meta"."tenants"("id") ON DELETE CASCADE`);
  });

  it("does not plan the unnamed column UNIQUE either, since ADD COLUMN writes it", () => {
    expect(plan.steps.some((s) => s.target === "flags_slug_key")).toBe(false);
    expect(plan.steps.find((s) => s.target === "slug")?.sql).toContain("UNIQUE");
  });

  it("does plan a named column UNIQUE, because emitColumn does not write that one", () => {
    // The asymmetry is in the emitter: `unique: true` becomes an inline `UNIQUE`, while
    // `unique: { constraintName }` is a table-level line only `emitCreateTable` emits.
    const step = plan.steps.find((s) => s.target === "flags_named_key");
    expect(step?.kind).toBe("add_unique_constraint");
    expect(plan.steps.find((s) => s.target === "named")?.sql).not.toContain("UNIQUE");
  });

  it("plans no separate step for a column-level CHECK, which ADD COLUMN also carries", () => {
    expect(plan.steps.find((s) => s.target === "status")?.sql).toContain("CHECK");
    expect(plan.steps.filter((s) => s.target === "status")).toHaveLength(1);
    expect(plan.steps.some((s) => s.kind === "add_table_constraint")).toBe(false);
  });

  it("plans every column exactly once", () => {
    const added = plan.steps.filter((s) => s.kind === "add_column").map((s) => s.target);
    expect(added).toEqual(["tenant_id", "slug", "named", "status"]);
  });

  it("still adds a reference on a column that already exists", () => {
    // The suppression is scoped to columns *this plan* adds; an existing column whose reference the
    // database lacks still needs the constraint.
    const withColumns: LiveTable = {
      ...bareFlags(),
      columns: [
        ...bareFlags().columns,
        { name: "tenant_id", dataType: "uuid", isNullable: true, defaultExpr: null },
      ],
    };
    const p = planSchemaReconciliation(diffSchema([CARRIER], live([withColumns])), [CARRIER], {
      rowCounts: new Map([["flags", 0]]),
    });
    expect(p.steps.some((s) => s.kind === "add_foreign_key" && s.target === "tenant_id")).toBe(true);
  });
});

describe("table-level constraints — planning", () => {
  const COMMS: TableDefinition = {
    schema: "meta",
    name: "comms",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      { name: "tenant_id", type: "UUID", notNull: true },
      { name: "recipient_count", type: "INTEGER", notNull: true },
      { name: "bounces_count", type: "INTEGER", notNull: true },
    ],
    primaryKey: ["id"],
    constraints: [
      {
        kind: "check",
        name: "comms_bounces_check",
        expression: "bounces_count <= recipient_count",
      },
      {
        kind: "foreign_key",
        name: "comms_incident_fkey",
        columns: ["tenant_id", "id"],
        references: { schema: "meta", table: "incidents", columns: ["tenant_id", "id"] },
        onDelete: "CASCADE",
      },
      { kind: "unique", name: "comms_pair_key", columns: ["tenant_id", "id"] },
    ],
  };

  const RENDERED = {
    byRequest: new Map<string, string | null>([
      [
        expressionKey("comms", "bounces_count <= recipient_count"),
        "(bounces_count <= recipient_count)",
      ],
    ]),
  };

  function liveComms(over: Partial<LiveTable> = {}): LiveTable {
    return {
      schema: "meta",
      name: "comms",
      columns: [
        { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
        { name: "tenant_id", dataType: "uuid", isNullable: false, defaultExpr: null },
        { name: "recipient_count", dataType: "integer", isNullable: false, defaultExpr: null },
        { name: "bounces_count", dataType: "integer", isNullable: false, defaultExpr: null },
      ],
      indexes: [
        { name: "comms_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null, constraintBacked: true },
        { name: "comms_pair_key", columns: ["tenant_id", "id"], unique: true, primary: false, method: "btree", predicate: null, constraintBacked: true },
      ],
      policies: [],
      foreignKeys: [
        {
          name: "comms_incident_fkey",
          columns: ["tenant_id", "id"],
          targetSchema: "meta",
          targetTable: "incidents",
          targetColumns: ["tenant_id", "id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
      ],
      checkConstraints: [
        {
          name: "comms_bounces_check",
          expression: "(bounces_count <= recipient_count)",
          columns: ["recipient_count", "bounces_count"],
        },
      ],
      rlsEnabled: false,
      ...over,
    };
  }

  /** `rows: null` means no probe at all, which is what a caller that did not count looks like. */
  function planWith(over: Partial<LiveTable>, rows: number | null = 0) {
    return planSchemaReconciliation(
      diffSchema([COMMS], live([liveComms(over)]), RENDERED),
      [COMMS],
      rows === null ? undefined : { rowCounts: new Map([["comms", rows]]) },
    );
  }

  it("plans nothing when every constraint matches", () => {
    expect(planWith({}).steps).toEqual([]);
    expect(planWith({}).unreconciled).toEqual([]);
  });

  it("emits the constraints inside CREATE TABLE on a fresh install, with no separate step", () => {
    const fresh = planSchemaReconciliation(diffSchema([COMMS], live([]), RENDERED), [COMMS]);
    expect(fresh.steps.every((s) => s.kind === "create_table")).toBe(true);
    expect(fresh.statements[0]).toContain(
      `CONSTRAINT "comms_bounces_check" CHECK (bounces_count <= recipient_count)`,
    );
    expect(fresh.statements[0]).toContain(`CONSTRAINT "comms_incident_fkey" FOREIGN KEY`);
    expect(fresh.unreconciled).toEqual([]);
  });

  it("adds a missing CHECK on an empty table, guarded", () => {
    const plan = planWith({ checkConstraints: [] });
    const step = plan.steps.find((s) => s.kind === "add_table_constraint");
    expect(step?.target).toBe("comms_bounces_check");
    expect(step?.guarded).toBe(true);
    expect(step?.sql).toContain("SELECT count(*) INTO existing");
    expect(step?.sql).toContain(
      `ADD CONSTRAINT "comms_bounces_check" CHECK (bounces_count <= recipient_count);`,
    );
    expect(plan.unreconciled).toEqual([]);
  });

  it("refuses a missing CHECK on a populated table, with the SQL and the violating rows", () => {
    const plan = planWith({ checkConstraints: [] }, 4);
    expect(plan.steps).toEqual([]);
    const item = plan.unreconciled.find((u) => u.reason === "constraint_needs_validation");
    expect(item?.target).toBe("comms_bounces_check");
    expect(item?.detail).toContain("holds 4 row(s)");
    expect(item?.manualSql).toContain("WHERE NOT (bounces_count <= recipient_count)");
    expect(item?.manualSql).toContain(`ADD CONSTRAINT "comms_bounces_check" CHECK`);
  });

  it("never plans a NOT VALID constraint, which would record an unchecked rule", () => {
    for (const plan of [planWith({ checkConstraints: [] }), planWith({ checkConstraints: [] }, 4)]) {
      for (const step of plan.steps) expect(step.sql).not.toContain("NOT VALID");
      for (const item of plan.unreconciled) expect(item.manualSql).not.toContain("NOT VALID");
    }
  });

  it("refuses when the row count is unknown, rather than assuming the table is empty", () => {
    const plan = planWith({ checkConstraints: [] }, null);
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled[0]?.detail).toContain("an unknown number of row(s)");
  });

  it("adds a missing composite foreign key, unguarded", () => {
    const step = planWith({ foreignKeys: [] }).steps.find(
      (s) => s.kind === "add_table_constraint",
    );
    expect(step?.target).toBe("comms_incident_fkey");
    expect(step?.guarded).toBe(false);
    expect(step?.sql).toBe(
      `ALTER TABLE "meta"."comms" ` +
        `ADD CONSTRAINT "comms_incident_fkey" FOREIGN KEY ("tenant_id", "id") ` +
        `REFERENCES "meta"."incidents"("tenant_id", "id") ON DELETE CASCADE;`,
    );
  });

  it("adds a missing composite foreign key on a populated table too", () => {
    // ADR-0291's rule, not ADR-0299's: the add fails only when the rows already contradict a
    // constraint the catalog declares, which is an integrity problem to surface rather than a
    // decision about data. Gating it on emptiness is what left a composite key never reconciled.
    const plan = planWith({ foreignKeys: [] }, 1);
    expect(plan.steps.map((s) => s.kind)).toEqual(["add_table_constraint"]);
    expect(plan.unreconciled).toEqual([]);
  });

  it("matches a composite key by its columns and target when the name differs", () => {
    // The emitter names a table-level key, but the database may hold the same key under Postgres's
    // own name. Matching only by name read that as declared-but-missing *and* undeclared, and planned
    // a second, duplicate constraint.
    const plan = planWith({
      foreignKeys: [
        { ...liveComms().foreignKeys[0] as NonNullable<LiveTable["foreignKeys"][number]>, name: "comms_tenant_id_id_fkey" },
      ],
    });
    const step = plan.steps.find((s) => s.kind === "replace_table_constraint");
    expect(step?.target).toBe("comms_incident_fkey");
    // Dropped under the name the database holds, or the drop is a no-op and both survive.
    expect(step?.sql).toContain(`DROP CONSTRAINT IF EXISTS "comms_tenant_id_id_fkey";`);
    expect(step?.sql).toContain(`ADD CONSTRAINT "comms_incident_fkey" FOREIGN KEY`);
    expect(step?.sql.indexOf("DROP CONSTRAINT")).toBeLessThan(
      step?.sql.indexOf("ADD CONSTRAINT") ?? -1,
    );
    // One statement, so the table is never committed without the key.
    expect(plan.statements).toHaveLength(1);
    expect(plan.unreconciled).toEqual([]);
  });

  it("replaces a composite key whose ON DELETE changed, under its own name", () => {
    const plan = planWith({
      foreignKeys: liveComms().foreignKeys.map((f) => ({ ...f, onDelete: "RESTRICT" as const })),
    });
    const step = plan.steps.find((s) => s.kind === "replace_table_constraint");
    expect(step?.guarded).toBe(false);
    expect(step?.sql).toContain(`DROP CONSTRAINT IF EXISTS "comms_incident_fkey";`);
    expect(step?.sql).toContain("ON DELETE CASCADE;");
  });

  it("replaces a composite key whose target changed", () => {
    const plan = planWith({
      foreignKeys: liveComms().foreignKeys.map((f) => ({ ...f, targetTable: "tenants" })),
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(["replace_table_constraint"]);
    expect(plan.steps[0]?.sql).toContain(`REFERENCES "meta"."incidents"("tenant_id", "id")`);
  });

  it("reports an undeclared composite key rather than dropping it", () => {
    const plan = planWith({
      foreignKeys: [
        ...liveComms().foreignKeys,
        {
          name: "comms_adhoc_fkey",
          columns: ["id", "tenant_id"],
          targetSchema: "meta",
          targetTable: "tenants",
          targetColumns: ["id", "tenant_id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
      ],
    });
    expect(plan.steps).toEqual([]);
    const item = plan.unreconciled.find((u) => u.reason === "foreign_key_removed");
    expect(item?.target).toBe("comms_adhoc_fkey");
  });

  it("replaces a changed CHECK in one guarded statement, dropping before adding", () => {
    const plan = planWith({
      checkConstraints: [
        {
          name: "comms_bounces_check",
          expression: "(bounces_count < recipient_count)",
          columns: ["recipient_count", "bounces_count"],
        },
      ],
    });
    const step = plan.steps.find((s) => s.kind === "replace_table_constraint");
    expect(step?.target).toBe("comms_bounces_check");
    expect(step?.guarded).toBe(true);
    expect(step?.sql.indexOf("DROP CONSTRAINT")).toBeLessThan(
      step?.sql.indexOf("ADD CONSTRAINT") ?? -1,
    );
    expect(plan.statements).toHaveLength(1);
  });

  it("refuses a changed CHECK on a populated table and hands over both halves", () => {
    const item = planWith(
      {
        checkConstraints: [
          {
            name: "comms_bounces_check",
            expression: "(bounces_count < recipient_count)",
            columns: ["recipient_count", "bounces_count"],
          },
        ],
      },
      9,
    ).unreconciled[0];
    expect(item?.reason).toBe("constraint_needs_validation");
    expect(item?.manualSql).toContain("DROP CONSTRAINT");
    expect(item?.manualSql).toContain("ADD CONSTRAINT");
  });

  it("reports an undeclared CHECK rather than dropping it", () => {
    const plan = planWith({
      checkConstraints: [
        ...liveComms().checkConstraints,
        { name: "comms_adhoc_check", expression: "(recipient_count > 0)", columns: ["recipient_count"] },
      ],
    });
    expect(plan.steps).toEqual([]);
    const item = plan.unreconciled.find((u) => u.reason === "constraint_removed");
    expect(item?.target).toBe("comms_adhoc_check");
    expect(item?.detail).toContain("over (recipient_count)");
    expect(item?.detail).toContain("(recipient_count > 0)");
    expect(item?.manualSql).toContain(`DROP CONSTRAINT "comms_adhoc_check"`);
  });

  it("repairs a missing kind:unique constraint with ADD CONSTRAINT, not the guarded path", () => {
    // ADR-0291 settled this: a unique constraint over duplicate rows is the database contradicting
    // the catalog, not an ambiguous decision, so it keeps the existing unguarded-by-emptiness step.
    const plan = planWith({
      indexes: liveComms().indexes.filter((i) => i.name !== "comms_pair_key"),
    });
    const step = plan.steps.find((s) => s.target === "comms_pair_key");
    expect(step?.kind).toBe("add_unique_constraint");
    expect(step?.sql).toContain(`ADD CONSTRAINT "comms_pair_key" UNIQUE ("tenant_id", "id")`);
  });

  it("replaces a changed kind:unique constraint through its constraint", () => {
    const plan = planWith({
      indexes: liveComms().indexes.map((i) =>
        i.name === "comms_pair_key" ? { ...i, columns: ["id", "tenant_id"] } : i,
      ),
    });
    const step = plan.steps.find((s) => s.kind === "replace_unique_constraint");
    expect(step?.target).toBe("comms_pair_key");
    expect(step?.sql).not.toContain("DROP INDEX");
  });

  it("drops a declared table-level foreign key that blocks a column type change, then re-adds it", () => {
    const retyped: TableDefinition = {
      ...COMMS,
      columns: COMMS.columns.map((c) =>
        c.name === "tenant_id" ? { ...c, type: "TEXT" } : c,
      ),
    };
    const plan = planSchemaReconciliation(
      diffSchema([retyped], live([liveComms()]), RENDERED),
      [retyped],
      { rowCounts: new Map([["comms", 0]]) },
    );
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds.indexOf("drop_foreign_key")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("drop_foreign_key")).toBeLessThan(kinds.indexOf("alter_column_type"));
    expect(kinds.indexOf("alter_column_type")).toBeLessThan(kinds.indexOf("add_table_constraint"));
    expect(plan.steps.find((s) => s.kind === "add_table_constraint")?.target).toBe(
      "comms_incident_fkey",
    );
  });

  it("plans a table constraint after the columns it covers are added", () => {
    const stale: LiveTable = {
      ...liveComms({ checkConstraints: [] }),
      columns: liveComms().columns.filter((c) => c.name !== "bounces_count"),
    };
    const plan = planSchemaReconciliation(
      diffSchema([COMMS], live([stale]), RENDERED),
      [COMMS],
      { rowCounts: new Map([["comms", 0]]) },
    );
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds.indexOf("add_column")).toBeLessThan(kinds.indexOf("add_table_constraint"));
  });

  it("names the constraint in the guard's error message", () => {
    expect(planWith({ checkConstraints: [] }).steps[0]?.sql).toContain(
      "refusing to add constraint comms_bounces_check to meta.comms",
    );
  });

  it("prints the new step kinds and reasons in the plan report", () => {
    const added = formatReconciliationPlan(planWith({ checkConstraints: [] }));
    expect(added).toContain("add_table_constraint comms.comms_bounces_check");
    expect(added).toContain("[guarded]");
    const refused = formatReconciliationPlan(planWith({ checkConstraints: [] }, 2));
    expect(refused).toContain("[constraint_needs_validation] comms.comms_bounces_check");
  });
});

describe("allowLoosening — what it does not reach", () => {
  /**
   * The flag's whole point is that it is narrow. Everything here is a refusal it must leave alone:
   * each is either a decision about existing data or an object someone may have created on purpose,
   * and neither becomes safe because a flag was passed.
   */
  const target: TableDefinition = {
    schema: "meta",
    name: "widgets",
    columns: [{ name: "id", type: "UUID", notNull: true, primaryKey: true }],
  };
  const drifted: LiveTable = {
    schema: "meta",
    name: "widgets",
    columns: [
      { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
      { name: "legacy", dataType: "text", isNullable: true, defaultExpr: null },
    ],
    indexes: [
      { name: "widgets_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null, constraintBacked: true },
      { name: "idx_adhoc", columns: ["legacy"], unique: false, primary: false, method: "btree", predicate: null, constraintBacked: false },
    ],
    policies: [{ name: "adhoc_policy", using: "true", check: null, command: "ALL", roles: ["PUBLIC"], permissive: true }],
    foreignKeys: [],
    checkConstraints: [
      { name: "widgets_adhoc_check", expression: "(legacy <> ''::text)", columns: ["legacy"] },
    ],
    rlsEnabled: true,
  };
  const loose = planSchemaReconciliation(
    diffSchema([target, { ...target, name: "gone" }].slice(0, 1), live([drifted, {
      ...drifted,
      name: "orphan",
    }])),
    [target],
    { rowCounts: new Map([["widgets", 3]]) },
    { allowLoosening: true },
  );

  it("drops nothing but a foreign key", () => {
    for (const step of loose.steps) {
      expect(step.kind).not.toMatch(/^(create_table|add_column)$/);
      if (step.kind.startsWith("drop_")) {
        expect(["drop_foreign_key", "drop_column_default", "drop_column_not_null"]).toContain(
          step.kind,
        );
      }
    }
  });

  it("still refuses the column, the index, the policy, the CHECK, the table and the RLS", () => {
    const reasons = new Set(loose.unreconciled.map((u) => u.reason));
    expect(reasons).toContain("column_removed");
    expect(reasons).toContain("index_removed");
    expect(reasons).toContain("policy_removed");
    expect(reasons).toContain("constraint_removed");
    expect(reasons).toContain("table_removed");
    expect(reasons).toContain("rls_unexpectedly_enabled");
  });
});

describe("renaming a column", () => {
  /** `default_value` becomes `default_json` — ADR-0300's stranded NOT NULL column exactly. */
  const RENAMED: TableDefinition = {
    schema: "meta",
    name: "flags",
    columns: [
      { name: "id", type: "UUID", notNull: true, primaryKey: true },
      { name: "tenant_id", type: "UUID", notNull: true, references: { schema: "meta", table: "tenants", column: "id" } },
      { name: "default_json", type: "JSONB", notNull: true, renamedFrom: "default_value" },
    ],
    indexes: [{ name: "idx_flags_default", columns: ["default_json"] }],
  };

  function liveFlags(columnName: string, extra: Partial<LiveTable> = {}): LiveTable {
    return {
      schema: "meta",
      name: "flags",
      columns: [
        { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
        { name: "tenant_id", dataType: "uuid", isNullable: false, defaultExpr: null },
        { name: columnName, dataType: "jsonb", isNullable: false, defaultExpr: null },
      ],
      indexes: [
        { name: "flags_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null, constraintBacked: true },
        { name: "idx_flags_default", columns: [columnName], unique: false, primary: false, method: "btree", predicate: null, constraintBacked: false },
      ],
      policies: [],
      foreignKeys: [
        {
          name: "flags_tenant_id_fkey",
          columns: ["tenant_id"],
          targetSchema: "meta",
          targetTable: "tenants",
          targetColumns: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
      ],
      checkConstraints: [],
      rlsEnabled: false,
      ...extra,
    };
  }

  it("plans a rename when only the old name exists", () => {
    const plan = planFor([RENAMED], live([liveFlags("default_value")]));
    expect(plan.steps.map((s) => s.kind)).toEqual(["rename_column"]);
    expect(plan.steps[0]?.target).toBe("default_json");
    expect(plan.steps[0]?.guarded).toBe(true);
    expect(plan.steps[0]?.sql).toContain(
      `ALTER TABLE "meta"."flags" RENAME COLUMN "default_value" TO "default_json";`,
    );
  });

  it("does not also report the old name as undeclared", () => {
    // The ADR-0300 failure: the column was added under the new name and the old NOT NULL one left
    // standing, so every insert failed on a column nothing could fill.
    const plan = planFor([RENAMED], live([liveFlags("default_value")]));
    expect(plan.unreconciled).toEqual([]);
    expect(plan.steps.some((s) => s.kind === "add_column")).toBe(false);
  });

  it("reports the rename in the drift report, as neither an addition nor a removal", () => {
    const diff = diffSchema([RENAMED], live([liveFlags("default_value")]));
    const table = diff.modifiedTables[0];
    expect(table?.renamedColumns).toEqual([
      { column: "default_json", from: "default_value", ambiguous: false },
    ]);
    expect(table?.addedColumns).toEqual([]);
    expect(table?.removedColumns).toEqual([]);
  });

  it("plans nothing once the rename has happened", () => {
    const plan = planFor([RENAMED], live([liveFlags("default_json")]));
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled).toEqual([]);
  });

  it("refuses when both names exist, and hands over both resolutions", () => {
    const both = liveFlags("default_value");
    const plan = planFor([RENAMED], live([{
      ...both,
      columns: [
        ...both.columns,
        { name: "default_json", dataType: "jsonb", isNullable: false, defaultExpr: null },
      ],
    }]));
    expect(plan.steps.some((s) => s.kind === "rename_column")).toBe(false);
    const item = plan.unreconciled.find((u) => u.reason === "column_rename_ambiguous");
    expect(item?.target).toBe("default_json");
    expect(item?.detail).toContain("the database holds both");
    expect(item?.manualSql).toContain(`DROP COLUMN "default_value";`);
    expect(item?.manualSql).toContain(`DROP COLUMN "default_json";`);
  });

  it("treats a renamedFrom nobody holds as an ordinary addition", () => {
    const neither = liveFlags("default_value");
    const plan = planSchemaReconciliation(
      diffSchema([RENAMED], live([{
        ...neither,
        columns: neither.columns.filter((c) => c.name !== "default_value"),
        indexes: neither.indexes.filter((i) => i.name !== "idx_flags_default"),
      }])),
      [RENAMED],
      { rowCounts: new Map([["flags", 0]]) },
    );
    expect(plan.steps.some((s) => s.kind === "rename_column")).toBe(false);
    expect(plan.steps.find((s) => s.kind === "add_column")?.target).toBe("default_json");
  });

  it("never renames onto a column the catalog still declares", () => {
    // Declaring both names means both columns are wanted; renaming one onto the other would destroy
    // a declared column.
    const keepsBoth: TableDefinition = {
      ...RENAMED,
      columns: [
        ...RENAMED.columns,
        { name: "default_value", type: "TEXT" },
      ],
    };
    const plan = planSchemaReconciliation(
      diffSchema([keepsBoth], live([liveFlags("default_value")])),
      [keepsBoth],
      { rowCounts: new Map([["flags", 0]]) },
    );
    expect(plan.steps.some((s) => s.kind === "rename_column")).toBe(false);
    expect(plan.steps.find((s) => s.kind === "add_column")?.target).toBe("default_json");
  });

  it("renames before changing the column, because the later statement names the new column", () => {
    const retyped: TableDefinition = {
      ...RENAMED,
      columns: RENAMED.columns.map((c) =>
        c.name === "default_json" ? { ...c, type: "TEXT", default: "'{}'" } : c,
      ),
    };
    const plan = planSchemaReconciliation(
      diffSchema([retyped], live([liveFlags("default_value")])),
      [retyped],
      { rowCounts: new Map([["flags", 0]]) },
    );
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds[0]).toBe("rename_column");
    expect(kinds).toContain("alter_column_type");
    expect(kinds).toContain("set_column_default");
    expect(kinds.indexOf("rename_column")).toBeLessThan(kinds.indexOf("alter_column_type"));
    expect(kinds.indexOf("rename_column")).toBeLessThan(kinds.indexOf("set_column_default"));
    for (const step of plan.steps.slice(1)) expect(step.sql).toContain("default_json");
  });

  it("does not re-add the foreign key on a column that was renamed", () => {
    // A foreign key survives a rename pointing at the same column, so the database still reports the
    // old name for it. Matching on that read the declared reference as missing and planned a second,
    // duplicate constraint.
    const renamedRef: TableDefinition = {
      ...RENAMED,
      columns: [
        { name: "id", type: "UUID", notNull: true, primaryKey: true },
        { name: "owner_tenant_id", type: "UUID", notNull: true, renamedFrom: "tenant_id", references: { schema: "meta", table: "tenants", column: "id" } },
        { name: "default_json", type: "JSONB", notNull: true },
      ],
      indexes: [],
    };
    const plan = planSchemaReconciliation(
      diffSchema([renamedRef], live([{
        ...liveFlags("default_json"),
        indexes: liveFlags("default_json").indexes.filter((i) => i.name !== "idx_flags_default"),
      }])),
      [renamedRef],
      { rowCounts: new Map([["flags", 0]]) },
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(["rename_column"]);
    expect(plan.unreconciled).toEqual([]);
  });

  it("does not rebuild an index over a renamed column for nothing", () => {
    const plan = planFor([RENAMED], live([liveFlags("default_value")]));
    expect(plan.steps.some((s) => s.kind === "replace_index")).toBe(false);
  });

  it("renames on a populated table, because no row is read or written", () => {
    const plan = planSchemaReconciliation(
      diffSchema([RENAMED], live([liveFlags("default_value")])),
      [RENAMED],
      { rowCounts: new Map([["flags", 20_000]]) },
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(["rename_column"]);
  });

  it("prints the rename in the plan report", () => {
    const out = formatReconciliationPlan(planFor([RENAMED], live([liveFlags("default_value")])));
    expect(out).toContain("rename_column flags.default_json");
  });
});

describe("planSchemaReconciliation — column-level CHECK expressions", () => {
  const TARGET: TableDefinition = {
    schema: "meta",
    name: "events",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      { name: "kind", type: "TEXT", notNull: true, check: "kind IN ('a', 'b')" },
      { name: "seq", type: "INTEGER", notNull: true, check: "seq >= 0" },
    ],
    primaryKey: ["id"],
  };
  const KIND = "(kind = ANY (ARRAY['a'::text, 'b'::text]))";
  const SEQ = "(seq >= 0)";
  const RENDERED = {
    byRequest: new Map<string, string | null>([
      [expressionKey("events", "kind IN ('a', 'b')"), KIND],
      [expressionKey("events", "seq >= 0"), SEQ],
    ]),
    columnsByRequest: new Map<string, readonly string[] | null>([
      [expressionKey("events", "kind IN ('a', 'b')"), ["kind"]],
      [expressionKey("events", "seq >= 0"), ["seq"]],
    ]),
  };

  function liveEvents(checks: LiveTable["checkConstraints"]): LiveSchema {
    return {
      schema: "meta",
      tables: [
        {
          schema: "meta",
          name: "events",
          columns: [
            { name: "id", dataType: "uuid", isNullable: false, defaultExpr: null },
            { name: "kind", dataType: "text", isNullable: false, defaultExpr: null },
            { name: "seq", dataType: "integer", isNullable: false, defaultExpr: null },
          ],
          indexes: [
            { name: "events_pkey", columns: ["id"], unique: true, primary: true, method: "btree", predicate: null, constraintBacked: true },
          ],
          policies: [],
          foreignKeys: [],
          checkConstraints: checks,
          rlsEnabled: false,
        },
      ],
    };
  }

  const NARROWED: LiveTable["checkConstraints"] = [
    { name: "events_kind_check", expression: "(kind = 'a'::text)", columns: ["kind"] },
    { name: "events_seq_check", expression: SEQ, columns: ["seq"] },
  ];

  function planWith(checks: LiveTable["checkConstraints"], rowCount: number | undefined) {
    const diff = diffSchema([TARGET], liveEvents(checks), RENDERED);
    return planSchemaReconciliation(
      diff,
      [TARGET],
      rowCount === undefined ? undefined : { rowCounts: new Map([["events", rowCount]]) },
    );
  }

  it("plans nothing for a correctly-applied table", () => {
    const plan = planWith(
      [
        { name: "events_kind_check", expression: KIND, columns: ["kind"] },
        { name: "events_seq_check", expression: SEQ, columns: ["seq"] },
      ],
      0,
    );
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled).toEqual([]);
  });

  it("replaces a changed inline CHECK on an empty table, guarded", () => {
    const plan = planWith(NARROWED, 0);
    expect(plan.steps.map((s) => s.kind)).toEqual(["replace_column_check"]);
    const step = plan.steps[0];
    expect(step?.target).toBe("kind");
    expect(step?.guarded).toBe(true);
    // One statement, so the table is never committed without the rule.
    expect(step?.sql).toContain('DROP CONSTRAINT IF EXISTS "events_kind_check"');
    expect(step?.sql).toContain('ADD CONSTRAINT "events_kind_check" CHECK (kind IN (\'a\', \'b\'))');
    expect(step?.sql).toContain("SELECT count(*) INTO existing");
    expect(plan.unreconciled).toEqual([]);
  });

  it("refuses a changed inline CHECK on a populated table, with the SQL and the violators query", () => {
    const plan = planWith(NARROWED, 7);
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled).toHaveLength(1);
    const item = plan.unreconciled[0];
    expect(item?.reason).toBe("constraint_needs_validation");
    expect(item?.target).toBe("kind");
    expect(item?.detail).toContain("7 row(s)");
    expect(item?.manualSql).toContain(
      "-- SELECT * FROM \"meta\".\"events\" WHERE NOT (kind IN ('a', 'b'));",
    );
    expect(item?.manualSql).toContain('DROP CONSTRAINT "events_kind_check"');
    expect(item?.manualSql).toContain('ADD CONSTRAINT "events_kind_check" CHECK (kind IN (\'a\', \'b\'))');
  });

  it("refuses when the row count is unknown rather than assuming the table is empty", () => {
    const plan = planWith(NARROWED, undefined);
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled[0]?.detail).toContain("an unknown number of row(s)");
  });

  it("adds a missing inline CHECK on an empty table", () => {
    const plan = planWith([{ name: "events_seq_check", expression: SEQ, columns: ["seq"] }], 0);
    expect(plan.steps.map((s) => s.kind)).toEqual(["add_column_check"]);
    expect(plan.steps[0]?.sql).toContain('ADD CONSTRAINT "events_kind_check"');
    expect(plan.steps[0]?.sql).not.toContain("DROP CONSTRAINT");
    expect(plan.steps[0]?.guarded).toBe(true);
  });

  it("refuses a missing inline CHECK on a populated table", () => {
    const plan = planWith([{ name: "events_seq_check", expression: SEQ, columns: ["seq"] }], 3);
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled[0]).toMatchObject({
      reason: "constraint_needs_validation",
      target: "kind",
    });
    expect(plan.unreconciled[0]?.manualSql).not.toContain("DROP CONSTRAINT");
  });

  it("refuses rather than predicting a name Postgres would choose for itself", () => {
    const shared: TableDefinition = {
      schema: "meta",
      name: "events",
      columns: [
        { name: "id", type: "UUID", notNull: true },
        { name: "kind", type: "TEXT", notNull: true },
        { name: "seq", type: "INTEGER", notNull: true, check: "seq >= 0 OR kind IS NULL" },
      ],
      primaryKey: ["id"],
    };
    const rendered = {
      byRequest: new Map<string, string | null>([
        [expressionKey("events", "seq >= 0 OR kind IS NULL"), "((seq >= 0) OR (kind IS NULL))"],
      ]),
      columnsByRequest: new Map<string, readonly string[] | null>([
        [expressionKey("events", "seq >= 0 OR kind IS NULL"), ["kind", "seq"]],
      ]),
    };
    // The database holds `events_check` under a *different* expression that no declaration renders
    // to, and `events_check1` is where Postgres would land — which depends on what else it names.
    const diff = diffSchema(
      [shared],
      liveEvents([{ name: "events_check", expression: "(seq > 0)", columns: ["seq"] }]),
      rendered,
    );
    const plan = planSchemaReconciliation(diff, [shared], { rowCounts: new Map([["events", 0]]) });
    // Matched by name, so it is a replace under the live name — nothing is predicted.
    expect(plan.steps.map((s) => s.kind)).toEqual(["replace_column_check"]);
    expect(plan.steps[0]?.sql).toContain('DROP CONSTRAINT IF EXISTS "events_check"');
    expect(plan.steps[0]?.sql).toContain('ADD CONSTRAINT "events_check"');
  });

  it("reports a missing check whose name is contested, with no name written", () => {
    const pair: TableDefinition = {
      schema: "meta",
      name: "events",
      columns: [
        { name: "id", type: "UUID", notNull: true },
        { name: "kind", type: "TEXT", notNull: true, check: "kind IS NULL OR seq >= 0" },
        { name: "seq", type: "INTEGER", notNull: true, check: "seq >= 0 OR kind IS NULL" },
      ],
      primaryKey: ["id"],
    };
    const rendered = {
      byRequest: new Map<string, string | null>([
        [expressionKey("events", "kind IS NULL OR seq >= 0"), "((kind IS NULL) OR (seq >= 0))"],
        [expressionKey("events", "seq >= 0 OR kind IS NULL"), "((seq >= 0) OR (kind IS NULL))"],
      ]),
      columnsByRequest: new Map<string, readonly string[] | null>([
        [expressionKey("events", "kind IS NULL OR seq >= 0"), ["kind", "seq"]],
        [expressionKey("events", "seq >= 0 OR kind IS NULL"), ["kind", "seq"]],
      ]),
    };
    const diff = diffSchema([pair], liveEvents([]), rendered);
    const plan = planSchemaReconciliation(diff, [pair], { rowCounts: new Map([["events", 0]]) });
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled.map((u) => u.reason)).toEqual([
      "column_check_name_unavailable",
      "column_check_name_unavailable",
    ]);
    expect(plan.unreconciled[0]?.manualSql).toContain('ADD CONSTRAINT "events_check"');
  });

  it("plans nothing and refuses nothing when no renderings were supplied", () => {
    const plan = planSchemaReconciliation(diffSchema([TARGET], liveEvents(NARROWED)), [TARGET], {
      rowCounts: new Map([["events", 0]]),
    });
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled).toEqual([]);
  });

  it("names the replace after the type change, so the retype does not undo it", () => {
    const retyped: TableDefinition = {
      ...TARGET,
      columns: TARGET.columns.map((c) => (c.name === "seq" ? { ...c, type: "BIGINT" } : c)),
    };
    const diff = diffSchema([retyped], liveEvents(NARROWED), RENDERED);
    const plan = planSchemaReconciliation(diff, [retyped], {
      rowCounts: new Map([["events", 0]]),
    });
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("alter_column_type");
    expect(kinds.indexOf("alter_column_type")).toBeLessThan(kinds.indexOf("replace_column_check"));
  });

  it("prints the column-check steps in the plan report", () => {
    const out = formatReconciliationPlan(planWith(NARROWED, 0));
    expect(out).toContain("replace_column_check events");
  });
});

describe("planLiveReconciliation — the row count a column-check finding needs", () => {
  const TARGET: TableDefinition = {
    schema: "meta",
    name: "events",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      { name: "kind", type: "TEXT", notNull: true, check: "kind IN ('a', 'b')" },
    ],
    primaryKey: ["id"],
  };

  interface Captured {
    sql: string;
    params: readonly unknown[] | undefined;
  }

  /**
   * A connection that answers every introspection query for one `meta.events`, renders the probe,
   * and records what it was asked. The probe runs inside `transaction`, so the fake has to let the
   * rollback sentinel escape the way node-postgres would.
   */
  function fakeConnection(capture: Captured[], rowCount: string): PgConnection {
    const respond = (sql: string): PgQueryResult => {
      if (sql.includes("c.relrowsecurity")) {
        return { rows: [{ schema: "meta", name: "events", rls_enabled: false }], rowCount: 1 };
      }
      if (sql.includes("format_type")) {
        return {
          rows: [
            { table_name: "events", column_name: "id", data_type: "uuid", not_null: true, default_expr: null, attnum: 1 },
            { table_name: "events", column_name: "kind", data_type: "text", not_null: true, default_expr: null, attnum: 2 },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes("pg_get_indexdef")) {
        return {
          rows: [
            { table_name: "events", index_name: "events_pkey", is_unique: true, is_primary: true, method: "btree", predicate: null, constraint_backed: true, columns: ["id"] },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("polwithcheck")) return { rows: [], rowCount: 0 };
      if (sql.includes("confdeltype")) return { rows: [], rowCount: 0 };
      if (sql.includes("con.conbin")) {
        return {
          rows: [
            { table_name: "events", constraint_name: "events_kind_check", expression: "(kind = 'a'::text)", columns: ["kind"] },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("pg_get_constraintdef")) {
        return {
          rows: [{ def: "CHECK ((kind = ANY (ARRAY['a'::text, 'b'::text]))) NOT VALID", cols: ["kind"] }],
          rowCount: 1,
        };
      }
      if (sql.includes("count(*)")) return { rows: [{ count: rowCount }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const tx: PgConnection = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        capture.push({ sql, params });
        return respond(sql);
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    return {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        capture.push({ sql, params });
        return respond(sql);
      }) as PgConnection["query"],
      transaction: vi.fn(async <T>(fn: (c: PgConnection) => Promise<T>) => fn(tx)) as
        PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
  }

  it("counts the table, so a changed column check can be planned at all", async () => {
    const capture: Captured[] = [];
    const plan = await planLiveReconciliation(fakeConnection(capture, "0"), "meta", [TARGET]);
    expect(capture.map((c) => c.sql)).toContain(
      'SELECT count(*)::TEXT AS count FROM "meta"."events"',
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(["replace_column_check"]);
  });

  it("refuses when that count comes back non-zero", async () => {
    const plan = await planLiveReconciliation(fakeConnection([], "12"), "meta", [TARGET]);
    expect(plan.steps).toEqual([]);
    expect(plan.unreconciled[0]).toMatchObject({
      reason: "constraint_needs_validation",
      target: "kind",
    });
    expect(plan.unreconciled[0]?.detail).toContain("12 row(s)");
  });

  it("probes the column check's expression against its own table", async () => {
    const capture: Captured[] = [];
    await planLiveReconciliation(fakeConnection(capture, "0"), "meta", [TARGET]);
    const probe = capture.find((c) => c.sql.includes("_crossengin_expr_probe") && c.sql.includes("ADD CONSTRAINT"));
    expect(probe?.sql).toContain("CHECK (kind IN ('a', 'b'))");
    expect(probe?.sql).toContain("NOT VALID");
  });
});
