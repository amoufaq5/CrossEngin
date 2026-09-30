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
  it("lists only additive or metadata-only operations", () => {
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
    ]);
  });

  it("has no step that drops a table, a column or a policy", () => {
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
      "index_removed",
      "policy_removed",
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
    expect(item?.detail).toContain("constraint");
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
