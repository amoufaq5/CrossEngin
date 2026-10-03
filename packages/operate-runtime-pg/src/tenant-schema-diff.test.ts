import { fieldTypeToPostgresType } from "@crossengin/kernel/ddl";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { Entity, FieldType, PrimitiveFieldType } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { columnPlanForEntity, type EntityTablePlan, type JoinTablePlan } from "./column-plan.js";
import {
  blockingChanges,
  canonicalDeclaredType,
  diffTenantSchema,
  formatTenantSchemaChange,
  introspectTenantSchema,
  storedTypeOf,
  type LiveColumn,
  type LiveSchema,
} from "./tenant-schema-diff.js";

const SCHEMA = "t_3f2a1b4c5d6e4f708192a3b4c5d6e7f8";

const WIDGET: Entity = {
  name: "Widget",
  fields: [
    { name: "sku", type: { kind: "text" }, required: true },
    { name: "price", type: { kind: "decimal", precision: 12, scale: 2 } },
    { name: "email", type: { kind: "email" } },
    { name: "mrn", type: { kind: "text" }, classification: "phi" },
  ],
};

function planOf(entity: Entity = WIDGET): ReadonlyMap<string, EntityTablePlan> {
  return new Map([[entity.name, columnPlanForEntity(entity, { schema: SCHEMA })]]);
}

function live(table: string, cols: readonly Omit<LiveColumn, "table">[]): LiveSchema {
  return new Map([[table, new Map(cols.map((c) => [c.column, { ...c, table }]))]]);
}

const NO_JOINS: readonly JoinTablePlan[] = [];

// The full shape the entity emitter writes, for the "no changes" baseline.
const WIDGET_LIVE: readonly Omit<LiveColumn, "table">[] = [
  { column: "tenant_id", formattedType: "uuid", notNull: true },
  { column: "id", formattedType: "text", notNull: true },
  { column: "sku", formattedType: "text", notNull: true },
  { column: "price", formattedType: "numeric(12,2)", notNull: false },
  { column: "email", formattedType: "character varying(320)", notNull: false },
  { column: "mrn", formattedType: "bytea", notNull: false },
  { column: "created_at", formattedType: "timestamp with time zone", notNull: true },
  { column: "updated_at", formattedType: "timestamp with time zone", notNull: true },
];

describe("canonicalDeclaredType", () => {
  it("rewrites every type this store emits into format_type's spelling", () => {
    expect(canonicalDeclaredType("TEXT")).toBe("text");
    expect(canonicalDeclaredType("VARCHAR(320)")).toBe("character varying(320)");
    expect(canonicalDeclaredType("CHAR(2)")).toBe("character(2)");
    expect(canonicalDeclaredType("INTEGER")).toBe("integer");
    expect(canonicalDeclaredType("BOOLEAN")).toBe("boolean");
    expect(canonicalDeclaredType("DATE")).toBe("date");
    expect(canonicalDeclaredType("TIME")).toBe("time without time zone");
    expect(canonicalDeclaredType("TIMESTAMPTZ")).toBe("timestamp with time zone");
    expect(canonicalDeclaredType("INTERVAL")).toBe("interval");
    expect(canonicalDeclaredType("UUID")).toBe("uuid");
    expect(canonicalDeclaredType("JSONB")).toBe("jsonb");
    expect(canonicalDeclaredType("BYTEA")).toBe("bytea");
  });

  it("drops the whitespace Postgres does not print inside a modifier", () => {
    expect(canonicalDeclaredType("NUMERIC(12, 2)")).toBe("numeric(12,2)");
    expect(canonicalDeclaredType("  NUMERIC(12,2)  ")).toBe("numeric(12,2)");
  });

  it("canonicalises an array element and keeps the [] suffix", () => {
    expect(canonicalDeclaredType("TEXT[]")).toBe("text[]");
    expect(canonicalDeclaredType("VARCHAR(50)[]")).toBe("character varying(50)[]");
    expect(canonicalDeclaredType("INTEGER[]")).toBe("integer[]");
  });

  it("covers every primitive the kernel can map, except the PostGIS pair", () => {
    const kinds: readonly PrimitiveFieldType[] = [
      { kind: "text" },
      { kind: "text", maxLength: 40 },
      { kind: "long_text" },
      { kind: "integer" },
      { kind: "decimal", precision: 12, scale: 2 },
      { kind: "boolean" },
      { kind: "date" },
      { kind: "time" },
      { kind: "datetime" },
      { kind: "duration" },
      { kind: "uuid" },
      { kind: "enum", values: ["a"] },
      { kind: "reference", target: "Account" },
      { kind: "json" },
      { kind: "file" },
      { kind: "email" },
      { kind: "phone" },
      { kind: "url" },
      { kind: "currency_amount" },
      { kind: "country_code" },
      { kind: "language_code" },
      { kind: "timezone" },
    ];
    for (const kind of kinds) {
      const sql = fieldTypeToPostgresType(kind as FieldType);
      expect(canonicalDeclaredType(sql), `${kind.kind} → ${sql}`).not.toBeNull();
    }
  });

  it("returns null — undetermined, never drift — for a type it cannot spell", () => {
    // PostGIS's format_type carries an SRID this function has no way to predict.
    expect(canonicalDeclaredType(fieldTypeToPostgresType({ kind: "geo_point" }))).toBeNull();
    expect(canonicalDeclaredType(fieldTypeToPostgresType({ kind: "geo_polygon" }))).toBeNull();
    expect(canonicalDeclaredType("hstore")).toBeNull();
  });
});

describe("storedTypeOf", () => {
  it("reports BYTEA for an encrypted column, not its plaintext type", () => {
    const plan = columnPlanForEntity(WIDGET, { schema: SCHEMA });
    const mrn = plan.columns.find((c) => c.column === "mrn");
    const sku = plan.columns.find((c) => c.column === "sku");
    expect(mrn !== undefined && storedTypeOf(mrn)).toBe("BYTEA");
    expect(sku !== undefined && storedTypeOf(sku)).toBe("TEXT");
  });
});

describe("introspectTenantSchema", () => {
  function conn(rows: readonly Record<string, unknown>[]): {
    conn: PgConnection;
    calls: { sql: string; params: readonly unknown[] }[];
  } {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const c: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows, rowCount: rows.length };
      }) as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(c)) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    return { conn: c, calls };
  }

  it("asks pg_catalog with format_type and binds the schema as a parameter", async () => {
    const { conn: c, calls } = conn([]);
    await introspectTenantSchema(c, SCHEMA);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("pg_catalog.format_type(a.atttypid, a.atttypmod)");
    expect(calls[0]?.sql).toContain("n.nspname = $1");
    expect(calls[0]?.sql).toContain("NOT a.attisdropped");
    expect(calls[0]?.params).toEqual([SCHEMA]);
  });

  it("groups columns by table", async () => {
    const { conn: c } = conn([
      { table_name: "widget", column_name: "sku", formatted_type: "text", not_null: true },
      { table_name: "widget", column_name: "price", formatted_type: "numeric(12,2)", not_null: false },
    ]);
    const schema = await introspectTenantSchema(c, SCHEMA);
    expect([...schema.keys()]).toEqual(["widget"]);
    expect(schema.get("widget")?.get("sku")).toEqual({
      table: "widget",
      column: "sku",
      formattedType: "text",
      notNull: true,
    });
  });

  it("reads a text boolean from a driver that does not parse it", async () => {
    const { conn: c } = conn([
      { table_name: "widget", column_name: "sku", formatted_type: "text", not_null: "t" },
    ]);
    const schema = await introspectTenantSchema(c, SCHEMA);
    expect(schema.get("widget")?.get("sku")?.notNull).toBe(true);
  });

  it("yields an empty schema when the schema does not exist", async () => {
    const { conn: c } = conn([]);
    expect((await introspectTenantSchema(c, SCHEMA)).size).toBe(0);
  });
});

describe("diffTenantSchema", () => {
  it("reports nothing on a first activation — everything is additive", () => {
    expect(diffTenantSchema(planOf(), NO_JOINS, new Map())).toEqual([]);
  });

  it("reports nothing when the live table already matches the plan", () => {
    expect(diffTenantSchema(planOf(), NO_JOINS, live("widget", WIDGET_LIVE))).toEqual([]);
  });

  it("reports nothing for a field whose column is simply absent — ADD COLUMN handles it", () => {
    const without = WIDGET_LIVE.filter((c) => c.column !== "price");
    expect(diffTenantSchema(planOf(), NO_JOINS, live("widget", without))).toEqual([]);
  });

  it("blocks a changed column type and hands over the ALTER that would do it", () => {
    const drifted = WIDGET_LIVE.map((c) => (c.column === "price" ? { ...c, formattedType: "text" } : c));
    const changes = diffTenantSchema(planOf(), NO_JOINS, live("widget", drifted));
    const change = changes.find((c) => c.kind === "column_type_change");
    expect(change?.blocking).toBe(true);
    expect(change?.column).toBe("price");
    expect(change?.detail).toContain("declared NUMERIC(12, 2)");
    expect(change?.detail).toContain("live text");
    expect(change?.sql).toBe(
      `ALTER TABLE "${SCHEMA}"."widget" ALTER COLUMN "price" TYPE NUMERIC(12, 2);`,
    );
  });

  it("blocks a field newly classified for encryption, since the rows are still plaintext", () => {
    const plaintext = WIDGET_LIVE.map((c) => (c.column === "mrn" ? { ...c, formattedType: "text" } : c));
    const changes = diffTenantSchema(planOf(), NO_JOINS, live("widget", plaintext));
    const change = changes.find((c) => c.kind === "column_encryption_change");
    expect(change?.blocking).toBe(true);
    expect(change?.detail).toContain("must be stored encrypted");
    // No SQL: there is no statement that encrypts the existing rows for you.
    expect(change?.sql).toBeNull();
    expect(changes.some((c) => c.kind === "column_type_change")).toBe(false);
  });

  it("blocks a field that stopped being classified while its column is still ciphertext", () => {
    const plain: Entity = {
      name: "Widget",
      fields: [{ name: "mrn", type: { kind: "text" } }],
    };
    const changes = diffTenantSchema(
      planOf(plain),
      NO_JOINS,
      live("widget", [{ column: "mrn", formattedType: "bytea", notNull: false }]),
    );
    expect(changes[0]?.kind).toBe("column_encryption_change");
    expect(changes[0]?.detail).toContain("no longer classifies it");
  });

  it("does not compare a type it cannot spell — undetermined must not read as drift", () => {
    const geo: Entity = { name: "Place", fields: [{ name: "at", type: { kind: "geo_point" } }] };
    const changes = diffTenantSchema(
      planOf(geo),
      NO_JOINS,
      live("place", [{ column: "at", formattedType: "geography(Point,4326)", notNull: false }]),
    );
    expect(changes).toEqual([]);
  });

  it("reports a NOT NULL tightening without blocking — ADR-0283 already serves it nullable", () => {
    const nullable = WIDGET_LIVE.map((c) => (c.column === "sku" ? { ...c, notNull: false } : c));
    const changes = diffTenantSchema(planOf(), NO_JOINS, live("widget", nullable));
    const change = changes.find((c) => c.kind === "not_null_tightening");
    expect(change?.blocking).toBe(false);
    expect(change?.detail).toContain("no default to backfill");
    expect(change?.sql).toBe(`ALTER TABLE "${SCHEMA}"."widget" ALTER COLUMN "sku" SET NOT NULL;`);
  });

  it("reports a NOT NULL relaxation, because the reconciler does not loosen integrity", () => {
    const tightened = WIDGET_LIVE.map((c) => (c.column === "price" ? { ...c, notNull: true } : c));
    const changes = diffTenantSchema(planOf(), NO_JOINS, live("widget", tightened));
    const change = changes.find((c) => c.kind === "not_null_relaxation");
    expect(change?.blocking).toBe(false);
    expect(change?.sql).toBe(`ALTER TABLE "${SCHEMA}"."widget" ALTER COLUMN "price" DROP NOT NULL;`);
  });

  it("reports a removed field's column without dropping it", () => {
    const extra = [...WIDGET_LIVE, { column: "legacy_code", formattedType: "text", notNull: false }];
    const changes = diffTenantSchema(planOf(), NO_JOINS, live("widget", extra));
    const change = changes.find((c) => c.kind === "undeclared_column");
    expect(change?.blocking).toBe(false);
    expect(change?.column).toBe("legacy_code");
    expect(change?.detail).toContain("left in place");
    expect(change?.sql).toBe(`ALTER TABLE "${SCHEMA}"."widget" DROP COLUMN "legacy_code";`);
  });

  it("never reports the emitter's own system columns as undeclared", () => {
    const changes = diffTenantSchema(planOf(), NO_JOINS, live("widget", WIDGET_LIVE));
    expect(changes.filter((c) => c.kind === "undeclared_column")).toEqual([]);
  });

  it("still excludes created_at/updated_at when the entity declares them itself", () => {
    const auditable: Entity = {
      name: "Widget",
      fields: [
        { name: "sku", type: { kind: "text" } },
        { name: "created_at", type: { kind: "datetime" } },
      ],
    };
    const changes = diffTenantSchema(
      planOf(auditable),
      NO_JOINS,
      live("widget", [
        { column: "sku", formattedType: "text", notNull: false },
        { column: "created_at", formattedType: "timestamp with time zone", notNull: false },
        { column: "updated_at", formattedType: "timestamp with time zone", notNull: true },
      ]),
    );
    expect(changes).toEqual([]);
  });

  it("reports a removed entity's table without dropping it", () => {
    const schema: LiveSchema = new Map([
      ...live("widget", WIDGET_LIVE),
      ...live("gadget", [{ column: "id", formattedType: "text", notNull: true }]),
    ]);
    const changes = diffTenantSchema(planOf(), NO_JOINS, schema);
    const change = changes.find((c) => c.kind === "undeclared_table");
    expect(change?.table).toBe("gadget");
    expect(change?.column).toBeNull();
    expect(change?.blocking).toBe(false);
    expect(change?.sql).toBeNull();
  });

  it("counts a declared join table as declared, so it is not reported as orphaned", () => {
    const joins: readonly JoinTablePlan[] = [
      {
        schema: SCHEMA,
        table: "widget_gadget",
        leftEntity: "Widget",
        rightEntity: "Gadget",
        leftColumn: "widget_id",
        rightColumn: "gadget_id",
      },
    ];
    const schema: LiveSchema = new Map([
      ...live("widget", WIDGET_LIVE),
      ...live("widget_gadget", [{ column: "widget_id", formattedType: "text", notNull: true }]),
    ]);
    expect(diffTenantSchema(planOf(), joins, schema)).toEqual([]);
  });
});

describe("blockingChanges / formatTenantSchemaChange", () => {
  it("selects only the blocking subset", () => {
    const drifted = WIDGET_LIVE.map((c) =>
      c.column === "price" ? { ...c, formattedType: "text" } : c,
    ).concat({ column: "legacy", formattedType: "text", notNull: false });
    const changes = diffTenantSchema(planOf(), NO_JOINS, live("widget", drifted));
    expect(changes.length).toBeGreaterThan(1);
    expect(blockingChanges(changes).map((c) => c.kind)).toEqual(["column_type_change"]);
  });

  it("renders a change as one line carrying its manual SQL", () => {
    const drifted = WIDGET_LIVE.map((c) => (c.column === "price" ? { ...c, formattedType: "text" } : c));
    const change = diffTenantSchema(planOf(), NO_JOINS, live("widget", drifted))[0];
    expect(change).toBeDefined();
    if (change === undefined) return;
    const line = formatTenantSchemaChange(change);
    expect(line).toContain("column_type_change widget.price");
    expect(line).toContain("manual: ALTER TABLE");
  });

  it("omits the manual clause when there is no statement that would do it", () => {
    const plaintext = WIDGET_LIVE.map((c) => (c.column === "mrn" ? { ...c, formattedType: "text" } : c));
    const change = diffTenantSchema(planOf(), NO_JOINS, live("widget", plaintext))[0];
    expect(change).toBeDefined();
    if (change === undefined) return;
    expect(formatTenantSchemaChange(change)).not.toContain("manual:");
  });
});
