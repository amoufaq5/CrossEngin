import { describe, expect, it } from "vitest";
import {
  META_SCHEMA_NAME,
  META_TABLES,
  emitBootstrapSql,
  emitSchemaCreate,
  type TableDefinition,
} from "@crossengin/kernel/bootstrap";

import { diffSchema } from "./diff.js";
import type { LiveSchema, LiveTable } from "./introspection.js";
import {
  RECONCILE_STEP_KINDS,
  UNRECONCILED_REASONS,
  formatReconciliationPlan,
  planSchemaReconciliation,
} from "./reconcile.js";

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
      { name: "widgets_pkey", columns: ["id"], unique: true, primary: true },
      { name: "idx_widgets_label", columns: ["label"], unique: false, primary: false },
      { name: "widgets_code_key", columns: ["code"], unique: true, primary: false },
      { name: "widgets_tenant_code_key", columns: ["tenant_id", "code"], unique: true, primary: false },
    ],
    policies: [{ name: "widgets_isolation", using: "(tenant_id = ...)", check: null }],
    foreignKeys: [],
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
      "depends_on_unreconciled",
      "index_removed",
      "policy_removed",
      "foreign_key_removed",
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
        { name: "idx_widgets_adhoc", columns: ["kind"], unique: false, primary: false },
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
        { name: "widgets_extra", using: "true", check: null },
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
    indexes: [{ name: "children_pkey", columns: ["id"], unique: true, primary: true }],
    policies: [],
    foreignKeys: [
      {
        name: "children_tenant_id_fkey",
        columns: ["tenant_id"],
        targetSchema: "meta",
        targetTable: "tenants",
        targetColumns: ["id"],
        onDelete: "CASCADE",
      },
      {
        name: "children_owner_id_fkey",
        columns: ["owner_id"],
        targetSchema: "meta",
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "RESTRICT",
      },
    ],
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
