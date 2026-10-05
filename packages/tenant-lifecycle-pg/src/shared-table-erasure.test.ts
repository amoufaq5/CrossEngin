import { META_TABLES, type ColumnDefinition, type TableDefinition } from "@crossengin/kernel/bootstrap";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DeletionAttestationSchema,
  SUBSYSTEM_SCOPE_FIELDS,
} from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  DELIBERATELY_ERASED_BILLING_TABLES,
  PLATFORM_RECORD_TABLES,
  RETAINED_SHARED_TABLES,
  SHARED_TABLE_ERASURE_REFUSAL_REASONS,
  STATUTORY_RETENTION_TABLES,
  TENANT_SCOPE_COLUMN,
  eraseSharedTablesWithin,
  partitionSharedTables,
  probeSharedTableErasability,
  sharedTableErasureAttestation,
  sharedTableErasureScope,
  sharedTableRetention,
  type SharedTableErasure,
} from "./shared-table-erasure.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const AT = "2026-10-05T09:00:00.000Z";
const ALICE = "alice@example.test";
const BOB = "bob@example.test";

function tenantTable(name: string, extra: readonly ColumnDefinition[] = []): TableDefinition {
  return {
    schema: "meta",
    name,
    columns: [
      { name: "id", type: "UUID", notNull: true },
      { name: TENANT_SCOPE_COLUMN, type: "UUID", notNull: true },
      ...extra,
    ],
    primaryKey: ["id"],
  };
}

/** Every retained name must resolve, so a fixture catalog has to carry all of them. */
const RETAINED_FIXTURES: readonly TableDefinition[] = RETAINED_SHARED_TABLES.map((n) =>
  tenantTable(n),
);

/**
 * Three erasable tables, declared in an order that makes the ordering rule observable:
 * `notification_deliveries` references `notification_dispatches`, which the catalog therefore
 * declares first.
 */
const CATALOG: readonly TableDefinition[] = [
  ...RETAINED_FIXTURES,
  tenantTable("operate_entity_records"),
  tenantTable("notification_dispatches"),
  tenantTable("notification_deliveries", [
    {
      name: "dispatch_id",
      type: "UUID",
      references: { schema: "meta", table: "notification_dispatches", column: "id" },
    },
  ]),
  // Platform-wide: no `tenant_id`, so it is in neither set and must never be touched.
  { schema: "meta", name: "plans", columns: [{ name: "id", type: "UUID", notNull: true }] },
];

const ERASABLE_FIXTURES = [
  "meta.notification_deliveries",
  "meta.notification_dispatches",
  "meta.operate_entity_records",
] as const;

/** The statutory set in the order the census reads it, taken from the partition rather than guessed. */
const STATUTORY_FIXTURES = partitionSharedTables(CATALOG).statutory.map((t) => t.qualified);

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeOptions {
  /** Qualified table → rows the tenant holds, which its `DELETE` therefore returns. */
  readonly rows?: Readonly<Record<string, number>>;
  /** Bare names the probe should report absent from `pg_class`. */
  readonly missing?: readonly string[];
  /** Bare names the probe should report `row_security_active` for. */
  readonly confined?: readonly string[];
  /** Qualified table → rows the confirm pass still sees. */
  readonly survivors?: Readonly<Record<string, number>>;
}

const RELATION_RE = /"([a-z_]+)"\."([a-z_]+)"/;

function relationOf(sql: string): string {
  const match = RELATION_RE.exec(sql);
  return match === null ? "" : `${match[1] ?? ""}.${match[2] ?? ""}`;
}

function fake(opts: FakeOptions = {}): { readonly conn: PgConnection; readonly calls: Call[] } {
  const calls: Call[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("row_security_active")) {
        const requested = (params?.[1] ?? []) as readonly string[];
        const rows = requested
          .filter((name) => !(opts.missing ?? []).includes(name))
          .map((name) => ({
            table_name: name,
            confined: (opts.confined ?? []).includes(name),
          }));
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("WITH deleted AS (DELETE FROM")) {
        const n = opts.rows?.[relationOf(sql)] ?? 0;
        return { rows: [{ n, bytes: n * 100 }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT count(*) AS n FROM")) {
        return { rows: [{ n: opts.survivors?.[relationOf(sql)] ?? 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}

function erase(
  opts: FakeOptions = {},
  over: { readonly tenantId?: string; readonly approvedBy?: string; readonly schema?: string } = {},
): Promise<{ readonly out: SharedTableErasure; readonly calls: Call[] }> {
  const h = fake(opts);
  return eraseSharedTablesWithin(
    h.conn,
    over.tenantId ?? TENANT,
    { executedBy: ALICE, approvedBy: over.approvedBy ?? BOB },
    {
      catalog: CATALOG,
      clock: () => new Date(AT),
      ...(over.schema !== undefined ? { schema: over.schema } : {}),
    },
  ).then((out) => ({ out, calls: h.calls }));
}

describe("the erasable set is derived, the retention set is named", () => {
  it("derives the erasable set from every tenant_id-bearing table in the live catalog", () => {
    const partition = partitionSharedTables();
    const tenantScoped = META_TABLES.filter((t) =>
      t.columns.some((c) => c.name === TENANT_SCOPE_COLUMN),
    );
    expect(partition.tenantScoped).toHaveLength(tenantScoped.length);
    // 114 of the catalog's 145 tables carry a `tenant_id`. The figure moves whenever a
    // tenant-scoped table is added, which is why the assertion above derives it from the live
    // catalog and only this line pins the number — a new table should make *one* line fail here,
    // visibly, rather than let the erasable set drift silently.
    expect(tenantScoped).toHaveLength(114);
    expect(partition.erasable).toHaveLength(114 - RETAINED_SHARED_TABLES.length);
    expect(partition.retained).toHaveLength(RETAINED_SHARED_TABLES.length);
  });

  it("names its retention set, so changing it is a visible edit", () => {
    // Asserted by name on purpose. Adding a name here stops a deletion erasing a tenant's data;
    // removing one destroys the evidence that the deletion happened. Neither belongs in a diff that
    // only moves a count.
    expect([...RETAINED_SHARED_TABLES]).toEqual([
      "access_review_campaigns",
      "access_review_decisions",
      "access_review_evidence",
      "access_review_exceptions",
      "access_review_items",
      "access_review_templates",
      "audit_integrity_verdicts",
      "audit_log",
      "certification_reports",
      "compliance_attestations",
      "crypto_keys",
      "forensic_chain_checkpoints",
      "forensic_chain_entries",
      "gdpr_deletion_requests",
      "invoices",
      "tenant_credits",
      "tenant_lifecycle_events",
      "tenant_tombstones",
    ]);
  });

  it("retains every table that is evidence the deletion happened", () => {
    const retained = new Set(partitionSharedTables().retained.map((t) => t.table));
    for (const evidence of [
      "tenant_tombstones",
      "gdpr_deletion_requests",
      "forensic_chain_entries",
      "forensic_chain_checkpoints",
      "audit_log",
      "audit_integrity_verdicts",
      "tenant_lifecycle_events",
    ]) {
      expect(retained.has(evidence)).toBe(true);
    }
  });

  it("leaves no tenant-scoped table in neither set", () => {
    const partition = partitionSharedTables();
    const classified = new Set(
      [...partition.erasable, ...partition.retained].map((t) => t.qualified),
    );
    const orphans = partition.tenantScoped
      .filter((t) => !classified.has(t.qualified))
      .map((t) => t.qualified);
    expect(
      orphans,
      `these ${TENANT_SCOPE_COLUMN}-bearing tables are in neither set — add each to` +
        " PLATFORM_RECORD_TABLES if it is the platform's record of the deletion, or to" +
        " STATUTORY_RETENTION_TABLES with its obligation if the law requires it, or leave it" +
        ` erasable: ${orphans.join(", ")}`,
    ).toEqual([]);
    expect(partition.unclassified).toEqual([]);
  });

  it("resolves every retention entry against the catalog", () => {
    // The direction that rots silently and severely: an entry for a renamed table protects nothing,
    // so the evidence it was written to keep is erased with everything else.
    expect(partitionSharedTables().unresolvedRetention).toEqual([]);
  });

  it("reports a retention entry that resolves to nothing", () => {
    const partition = partitionSharedTables([tenantTable("operate_entity_records")]);
    expect(partition.unresolvedRetention).toEqual([...RETAINED_SHARED_TABLES]);
  });

  it("ignores tables with no tenant_id at all", () => {
    const partition = partitionSharedTables(CATALOG);
    expect(partition.tenantScoped.some((t) => t.table === "plans")).toBe(false);
    expect(partition.erasable.some((t) => t.table === "plans")).toBe(false);
  });

  it("qualifies every target with its schema, because DeletionScope.tables is flat", () => {
    expect(partitionSharedTables(CATALOG).erasable.map((t) => t.qualified)).toEqual([
      ...ERASABLE_FIXTURES,
    ]);
  });

  it("honours a schema override on every target", () => {
    const partition = partitionSharedTables(CATALOG, "platform");
    expect(partition.erasable[0]?.qualified).toBe("platform.notification_deliveries");
    expect(partition.retained.every((t) => t.schema === "platform")).toBe(true);
  });
});

describe("deletion order follows the catalog's foreign-key invariant", () => {
  it("deletes in reverse catalog order, so a child precedes its parent", () => {
    const order = partitionSharedTables(CATALOG).erasable.map((t) => t.table);
    expect(order.indexOf("notification_deliveries")).toBeLessThan(
      order.indexOf("notification_dispatches"),
    );
  });

  it("puts every erasable table before every table it references, over the live catalog", () => {
    const partition = partitionSharedTables();
    const position = new Map(partition.erasable.map((t, i) => [t.table, i]));
    const violations: string[] = [];
    for (const table of META_TABLES) {
      const self = position.get(table.name);
      if (self === undefined) continue;
      const targets = [
        ...table.columns.flatMap((c) => (c.references === undefined ? [] : [c.references.table])),
        ...(table.constraints ?? []).flatMap((c) =>
          c.kind === "foreign_key" ? [c.references.table] : [],
        ),
      ];
      for (const target of targets) {
        if (target === table.name) continue;
        const at = position.get(target);
        if (at !== undefined && at < self) violations.push(`${table.name} -> ${target}`);
      }
    }
    // The catalog guarantees a reference resolves to a table declared *earlier*, so reversing it
    // cannot produce one of these. A violation would mean a DELETE trips a foreign key and aborts
    // the whole deletion.
    expect(violations).toEqual([]);
  });

  it("has no retained or platform-wide table referencing an erasable one", () => {
    // The hazard in the other direction: deleting the parent would either fail on RESTRICT or
    // cascade the retained evidence away with it.
    const partition = partitionSharedTables();
    const erasable = new Set(partition.erasable.map((t) => t.table));
    const hazards: string[] = [];
    for (const table of META_TABLES) {
      if (erasable.has(table.name)) continue;
      const targets = [
        ...table.columns.flatMap((c) => (c.references === undefined ? [] : [c.references.table])),
        ...(table.constraints ?? []).flatMap((c) =>
          c.kind === "foreign_key" ? [c.references.table] : [],
        ),
      ];
      for (const target of targets) {
        if (target !== table.name && erasable.has(target)) hazards.push(`${table.name} -> ${target}`);
      }
    }
    expect(hazards).toEqual([]);
  });
});

describe("eraseSharedTablesWithin", () => {
  it("empties every erasable table and nothing else", async () => {
    const { out, calls } = await erase({ rows: { "meta.operate_entity_records": 7 } });
    expect(out.erased).toBe(true);
    const deleted = calls
      .filter((c) => c.sql.startsWith("WITH deleted AS (DELETE FROM"))
      .map((c) => relationOf(c.sql));
    expect(deleted).toEqual([...ERASABLE_FIXTURES]);
    for (const retained of RETAINED_SHARED_TABLES) {
      expect(calls.some((c) => c.sql.includes(`DELETE FROM "meta"."${retained}"`))).toBe(false);
    }
  });

  it("binds the tenant id once per statement, cast to uuid", async () => {
    const { calls } = await erase({ rows: { "meta.notification_dispatches": 2 } });
    const destructive = calls.filter((c) => c.sql.startsWith("WITH deleted AS (DELETE FROM"));
    expect(destructive).toHaveLength(ERASABLE_FIXTURES.length);
    for (const call of destructive) {
      expect(call.params).toEqual([TENANT]);
      expect(call.sql).toContain(`"${TENANT_SCOPE_COLUMN}" = $1::uuid`);
    }
  });

  it("measures each table with count(*) over the rows its own DELETE returned", async () => {
    const { out, calls } = await erase({
      rows: { "meta.operate_entity_records": 7, "meta.notification_deliveries": 3 },
    });
    // One statement, so the figure and the deletion cannot disagree — and `count(*)`, never
    // `reltuples` (ADR-0316), because the proof commits to it.
    for (const call of calls.filter((c) => c.sql.startsWith("WITH deleted AS"))) {
      expect(call.sql).toContain("SELECT count(*) AS n");
      expect(call.sql).not.toContain("reltuples");
    }
    expect(out.rowCount).toBe(10);
    expect(out.erasedTables).toEqual([
      { table: "meta.notification_deliveries", rowCount: 3, storageBytes: 300 },
      { table: "meta.operate_entity_records", rowCount: 7, storageBytes: 700 },
    ]);
    expect(out.storageBytes).toBe(1000);
  });

  it("lists only the tables that actually lost rows, and carries coverage beside them", async () => {
    const { out } = await erase({ rows: { "meta.notification_dispatches": 1 } });
    // A table emptied of nothing was examined, not destroyed; a scope naming it would claim a
    // destruction that did not happen.
    expect(out.erasedTables.map((t) => t.table)).toEqual(["meta.notification_dispatches"]);
    expect(out.examinedTables).toEqual([...ERASABLE_FIXTURES]);
    expect(out.retainedTables).toEqual(
      RETAINED_SHARED_TABLES.map((n) => `meta.${n}`),
    );
  });

  it("confirms absence in every erasable table, not only the ones that lost rows", async () => {
    const { calls } = await erase({ rows: { "meta.operate_entity_records": 7 } });
    const confirmed = calls
      .filter((c) => c.sql.startsWith("SELECT count(*) AS n FROM"))
      .map((c) => relationOf(c.sql));
    // The claim is that no row of this tenant remains in any *erasable* shared table, so that is
    // what is checked — followed by the statutory census, which asks the opposite question of the
    // tables whose rows are supposed to remain.
    expect(confirmed).toEqual([...ERASABLE_FIXTURES, ...STATUTORY_FIXTURES]);
  });

  it("confirms absence after the last delete, never before", async () => {
    const { calls } = await erase({ rows: { "meta.operate_entity_records": 7 } });
    const deleteIndexes = calls
      .map((c, i) => (c.sql.startsWith("WITH deleted AS") ? i : -1))
      .filter((i) => i >= 0);
    const lastDelete = deleteIndexes[deleteIndexes.length - 1] ?? -1;
    const firstConfirm = calls.findIndex((c) => c.sql.startsWith("SELECT count(*) AS n FROM"));
    expect(lastDelete).toBeGreaterThan(-1);
    expect(firstConfirm).toBeGreaterThan(lastDelete);
  });

  it("throws rather than reporting success when a row survives", async () => {
    await expect(
      erase({
        rows: { "meta.operate_entity_records": 7 },
        survivors: { "meta.notification_dispatches": 2 },
      }),
    ).rejects.toThrow(/left rows behind in meta\.notification_dispatches \(2 row\(s\)\)/);
  });

  it("reports nothing to erase when the tenant held no shared rows", async () => {
    const { out } = await erase();
    expect(out.erased).toBe(false);
    expect(out.nothingToErase).toBe(true);
    expect(out.refusals).toEqual([]);
    expect(out.rowCount).toBe(0);
  });

  it("stamps the erasure from the injected clock", async () => {
    const { out } = await erase({ rows: { "meta.operate_entity_records": 1 } });
    expect(out.erasedAt).toBe(AT);
  });

  it("declares its refusal reasons", () => {
    expect([...SHARED_TABLE_ERASURE_REFUSAL_REASONS]).toEqual([
      "invalid_tenant_id",
      "four_eyes_violated",
      "unclassified_tenant_table",
      "retention_entry_unresolved",
      "retention_reason_unassigned",
      "retention_reason_ambiguous",
      "retained_table_blocks_erasure",
      "table_missing",
      "rls_would_confine_this_session",
    ]);
  });

  it("throws on a schema name that is not an identifier, before any statement", async () => {
    const h = fake();
    await expect(
      eraseSharedTablesWithin(
        h.conn,
        TENANT,
        { executedBy: ALICE, approvedBy: BOB },
        { catalog: CATALOG, schema: 'meta"; DROP SCHEMA meta' },
      ),
    ).rejects.toThrow(/invalid schema identifier/);
    expect(h.calls).toEqual([]);
  });
});

describe("a refusal erases nothing", () => {
  it("refuses four-eyes without touching the database", async () => {
    const { out, calls } = await erase({}, { approvedBy: ALICE });
    expect(out.refusals.map((r) => r.reason)).toEqual(["four_eyes_violated"]);
    expect(out.erased).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a non-uuid tenant id without touching the database", async () => {
    const { out, calls } = await erase({}, { tenantId: "not-a-uuid" });
    expect(out.refusals.map((r) => r.reason)).toEqual(["invalid_tenant_id"]);
    expect(calls).toEqual([]);
  });

  it("collects every cheap refusal rather than the first", async () => {
    const { out } = await erase({}, { tenantId: "nope", approvedBy: ALICE });
    expect(out.refusals.map((r) => r.reason)).toEqual([
      "invalid_tenant_id",
      "four_eyes_violated",
    ]);
  });

  it("refuses a catalog whose retention entries do not resolve, before the probe", async () => {
    const h = fake();
    const out = await eraseSharedTablesWithin(
      h.conn,
      TENANT,
      { executedBy: ALICE, approvedBy: BOB },
      { catalog: [tenantTable("operate_entity_records")], clock: () => new Date(AT) },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(
      RETAINED_SHARED_TABLES.map(() => "retention_entry_unresolved"),
    );
    expect(h.calls).toEqual([]);
  });

  it("refuses a table the catalog declares and the database lacks, after deleting nothing", async () => {
    const { out, calls } = await erase({ missing: ["notification_dispatches"] });
    expect(out.refusals.map((r) => r.reason)).toEqual(["table_missing"]);
    expect(out.refusals[0]?.detail).toContain("meta.notification_dispatches");
    expect(calls.some((c) => c.sql.startsWith("WITH deleted AS"))).toBe(false);
  });

  it("refuses when row-level security would confine this session, after deleting nothing", async () => {
    const { out, calls } = await erase({ confined: ["operate_entity_records"] });
    // Verified live: as a non-owner role the DELETE matched 0 rows, reported 0, and the
    // confirm-absence count *also* saw 0 while the rows were still there. Both read through the same
    // policy, so the only place to catch it is before the first statement.
    expect(out.refusals.map((r) => r.reason)).toEqual(["rls_would_confine_this_session"]);
    expect(out.refusals[0]?.detail).toContain("meta.operate_entity_records");
    expect(calls.some((c) => c.sql.startsWith("WITH deleted AS"))).toBe(false);
    expect(calls.some((c) => c.sql.startsWith("SELECT count(*) AS n FROM"))).toBe(false);
  });

  it("reports both probe refusals together", async () => {
    const { out } = await erase({
      missing: ["notification_deliveries"],
      confined: ["operate_entity_records"],
    });
    expect(out.refusals.map((r) => r.reason)).toEqual([
      "table_missing",
      "rls_would_confine_this_session",
    ]);
  });

  it("still reports what it would have examined and retained when it refuses", async () => {
    const { out } = await erase({}, { approvedBy: ALICE });
    expect(out.examinedTables).toEqual([...ERASABLE_FIXTURES]);
    expect(out.retainedTables).toHaveLength(RETAINED_SHARED_TABLES.length);
  });
});

describe("probeSharedTableErasability", () => {
  it("asks one read-only statement for both questions", async () => {
    const h = fake({ missing: ["b"], confined: ["c"] });
    const probe = await probeSharedTableErasability(
      h.conn,
      [
        { schema: "meta", table: "a", qualified: "meta.a" },
        { schema: "meta", table: "b", qualified: "meta.b" },
        { schema: "meta", table: "c", qualified: "meta.c" },
      ],
      "meta",
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.params).toEqual(["meta", ["a", "b", "c"]]);
    expect(probe.missing).toEqual(["meta.b"]);
    expect(probe.confined).toEqual(["meta.c"]);
  });

  it("asks nothing when there is nothing to erase", async () => {
    const h = fake();
    expect(await probeSharedTableErasability(h.conn, [], "meta")).toEqual({
      missing: [],
      confined: [],
    });
    expect(h.calls).toEqual([]);
  });
});

describe("sharedTableErasureScope", () => {
  it("fills exactly the fields shared_tables owns", async () => {
    const { out } = await erase({ rows: { "meta.operate_entity_records": 7 } });
    const scope = sharedTableErasureScope(out);
    expect(Object.keys(scope).sort()).toEqual([...SUBSYSTEM_SCOPE_FIELDS.shared_tables].sort());
    // Notably not `schemas`: the shared schema is not this tenant's and is not going anywhere, and a
    // scope's every list has one provenance (ADR-0317).
    expect(Object.keys(scope)).not.toContain("schemas");
  });

  it("claims nothing when nothing was erased", async () => {
    const { out } = await erase();
    expect(sharedTableErasureScope(out)).toEqual({ tables: [], rowCount: 0, storageBytes: 0 });
  });
});

/**
 * The two retention sets, which are not two halves of one list.
 *
 * `PLATFORM_RECORD_TABLES` is *not the tenant's data* and is silent in the proof.
 * `STATUTORY_RETENTION_TABLES` **is** the tenant's data, Article 17 reaches it, and the proof names
 * the obligation keeping it. A table may be in exactly one.
 */
describe("the two retention sets", () => {
  it("names the statutory set and its obligations, so changing it is a visible edit", () => {
    // Asserted by name for `RETAINED_SHARED_TABLES`' reason, and harder: adding a name here keeps
    // the tenant's own data after an Article 17 erasure, and the proof will say a law required it.
    expect([...STATUTORY_RETENTION_TABLES]).toEqual([
      { table: "invoices", obligation: "tax_records_7y" },
      { table: "tenant_credits", obligation: "tax_records_7y" },
    ]);
  });

  it("never names 'none' as an obligation", () => {
    // `DeletionAttestationSchema` refuses it, so an entry declaring it would refuse every deletion.
    for (const entry of STATUTORY_RETENTION_TABLES) {
      expect(entry.obligation, entry.table).not.toBe("none");
    }
  });

  it("derives the union, so the retained set has one source", () => {
    expect([...RETAINED_SHARED_TABLES]).toEqual(
      [...PLATFORM_RECORD_TABLES, ...STATUTORY_RETENTION_TABLES.map((r) => r.table)].sort(),
    );
    expect(PLATFORM_RECORD_TABLES).toHaveLength(16);
    expect(STATUTORY_RETENTION_TABLES).toHaveLength(2);
  });

  it("keeps the two sets disjoint in the live catalog", () => {
    const partition = partitionSharedTables();
    expect(
      partition.ambiguousRetention,
      "a table cannot be both 'not the tenant's data' and 'the tenant's data lawfully kept'" +
        ` — remove from one: ${partition.ambiguousRetention.join(", ")}`,
    ).toEqual([]);
    expect(partition.platformRecord).toHaveLength(PLATFORM_RECORD_TABLES.length);
    expect(partition.statutory).toHaveLength(STATUTORY_RETENTION_TABLES.length);
    expect(partition.retained).toHaveLength(partition.platformRecord.length + partition.statutory.length);
  });

  it("assigns every retained table a reason in the live catalog", () => {
    expect(partitionSharedTables().unassignedRetention).toEqual([]);
  });

  it("resolves every statutory entry against the live catalog, tenant-scoped", () => {
    const tenantScoped = new Set(
      META_TABLES.filter((t) => t.columns.some((c) => c.name === TENANT_SCOPE_COLUMN)).map(
        (t) => t.name,
      ),
    );
    for (const entry of STATUTORY_RETENTION_TABLES) {
      expect(tenantScoped.has(entry.table), entry.table).toBe(true);
    }
    const statutory = partitionSharedTables().statutory;
    expect(statutory.map((t) => t.qualified)).toEqual(["meta.invoices", "meta.tenant_credits"]);
    expect(statutory.every((t) => t.obligation === "tax_records_7y")).toBe(true);
  });

  it("leaves the billing tables it decided against erasable", () => {
    const erasable = new Set(partitionSharedTables().erasable.map((t) => t.table));
    for (const name of DELIBERATELY_ERASED_BILLING_TABLES) {
      expect(erasable.has(name), `${name} should still be erased`).toBe(true);
    }
  });

  it("finds no retained foreign key that would block an erasable DELETE", () => {
    // ADR-0318's defect, derived rather than discovered: a retained row referencing an erasable
    // parent with ON DELETE RESTRICT makes that parent undeletable *because* the retention exists,
    // and every deletion for a tenant holding one aborts.
    const blocked = partitionSharedTables().blockedByRetention;
    expect(blocked, `retained rows would refuse an erasable table's DELETE: ${blocked.join("; ")}`).toEqual(
      [],
    );
  });

  it("detects one when the catalog has it, naming the column and the action", async () => {
    // Reachable through the catalog, which is the only injectable half — the sets themselves are
    // constants on purpose (a caller-supplied retention list is ADR-0328's defect in a new field).
    const blocking: readonly TableDefinition[] = CATALOG.map((t) =>
      t.name === "invoices"
        ? {
            ...t,
            columns: [
              ...t.columns,
              {
                name: "issued_by",
                type: "UUID",
                references: {
                  schema: "meta",
                  table: "operate_entity_records",
                  column: "id",
                  onDelete: "RESTRICT" as const,
                },
              },
            ],
          }
        : t,
    );
    const partition = partitionSharedTables(blocking);
    expect(partition.blockedByRetention).toEqual([
      "meta.invoices.issued_by -> operate_entity_records (ON DELETE RESTRICT)",
    ]);
    const h = fake();
    const out = await eraseSharedTablesWithin(
      h.conn,
      TENANT,
      { executedBy: ALICE, approvedBy: BOB },
      { catalog: blocking, clock: () => new Date(AT) },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["retained_table_blocks_erasure"]);
    expect(out.refusals[0]?.detail).toContain("the whole transaction would abort");
    // A cheap refusal: settled before the probe, so nothing was read and nothing destroyed.
    expect(h.calls).toEqual([]);
  });

  it("treats an FK the retention can survive as no blocker", () => {
    for (const onDelete of ["CASCADE", "SET NULL"] as const) {
      const catalog: readonly TableDefinition[] = CATALOG.map((t) =>
        t.name === "invoices"
          ? {
              ...t,
              columns: [
                ...t.columns,
                {
                  name: "issued_by",
                  type: "UUID",
                  references: {
                    schema: "meta",
                    table: "operate_entity_records",
                    column: "id",
                    onDelete,
                  },
                },
              ],
            }
          : t,
      );
      expect(partitionSharedTables(catalog).blockedByRetention, onDelete).toEqual([]);
    }
  });

  it("flags SET DEFAULT, which this module cannot prove will succeed", () => {
    const catalog: readonly TableDefinition[] = CATALOG.map((t) =>
      t.name === "invoices"
        ? {
            ...t,
            columns: [
              ...t.columns,
              {
                name: "issued_by",
                type: "UUID",
                references: {
                  schema: "meta",
                  table: "operate_entity_records",
                  column: "id",
                  onDelete: "SET DEFAULT" as const,
                },
              },
            ],
          }
        : t,
    );
    expect(partitionSharedTables(catalog).blockedByRetention).toHaveLength(1);
  });
});

/**
 * The statutory census: the mirror image of the confirm-absence pass.
 *
 * A retained table's rows are *supposed* to remain, so confirming their absence would refuse every
 * deletion. What is confirmed is **presence**, and only to decide whether there is a retention to
 * claim — a proof asserting a seven-year hold over an invoice the tenant never had is the same
 * defect as a scope claiming a destruction that did not happen.
 */
describe("the statutory census", () => {
  it("claims a retention only for the statutory tables that still hold rows", async () => {
    const { out } = await erase({
      rows: { "meta.operate_entity_records": 7 },
      survivors: { "meta.invoices": 3 },
    });
    expect(out.statutoryRetained).toEqual([
      { table: "meta.invoices", obligation: "tax_records_7y" },
    ]);
    // `meta.tenant_credits` is in the statutory *set* and held nothing, so it is coverage and not a
    // claim — exactly how `examinedTables` relates to `erasedTables`.
    expect(out.statutoryTables).toEqual([...STATUTORY_FIXTURES]);
  });

  it("claims nothing when the statutory tables are empty for this tenant", async () => {
    const { out } = await erase({ rows: { "meta.operate_entity_records": 7 } });
    expect(out.statutoryRetained).toEqual([]);
    expect(sharedTableRetention(out)).toBeNull();
  });

  it("carries no count beside a retained table, only the obligation", async () => {
    const { out } = await erase({ survivors: { "meta.invoices": 9999 } });
    expect(Object.keys(out.statutoryRetained[0] ?? {}).sort()).toEqual(["obligation", "table"]);
  });

  it("reads the statutory tables after the last delete, never before", async () => {
    const { calls } = await erase({
      rows: { "meta.operate_entity_records": 7 },
      survivors: { "meta.invoices": 1 },
    });
    const lastDelete = calls.reduce(
      (acc, c, i) => (c.sql.startsWith("WITH deleted AS") ? i : acc),
      -1,
    );
    const census = calls.findIndex(
      (c) => c.sql.startsWith("SELECT count(*) AS n FROM") && relationOf(c.sql) === "meta.invoices",
    );
    expect(lastDelete).toBeGreaterThan(-1);
    expect(census).toBeGreaterThan(lastDelete);
  });

  it("probes the statutory tables too, so a confined session cannot under-report a retention", async () => {
    // The dangerous direction: a confined session reads 0 from meta.invoices, claims no retention,
    // and the proof goes quiet about rows it did not destroy.
    const { out } = await erase({ confined: ["invoices"] });
    expect(out.refusals.map((r) => r.reason)).toEqual(["rls_would_confine_this_session"]);
    expect(out.refusals[0]?.detail).toContain("meta.invoices");
  });

  it("refuses a statutory table the database does not have", async () => {
    const { out } = await erase({ missing: ["tenant_credits"] });
    expect(out.refusals.map((r) => r.reason)).toEqual(["table_missing"]);
    expect(out.refusals[0]?.detail).toContain("meta.tenant_credits");
  });

  it("claims nothing on a refusal, because no erasure happened to retain anything from", async () => {
    const { out } = await erase({ survivors: { "meta.invoices": 3 } }, { approvedBy: ALICE });
    expect(out.refusals.map((r) => r.reason)).toEqual(["four_eyes_violated"]);
    expect(out.statutoryRetained).toEqual([]);
    expect(sharedTableRetention(out)).toBeNull();
  });

  it("splits the retained tables by reason", async () => {
    const { out } = await erase({ rows: { "meta.operate_entity_records": 1 } });
    expect(out.platformRecordTables).toEqual(PLATFORM_RECORD_TABLES.map((n) => `meta.${n}`).sort());
    expect([...out.retainedTables].sort()).toEqual(
      [...out.platformRecordTables, ...out.statutoryTables].sort(),
    );
  });
});

/** The combined claim: destroyed these, kept those under this obligation, in one attestation. */
describe("sharedTableErasureAttestation", () => {
  const BY = "tenant-lifecycle-pg/deletion:alice";

  it("reports erased_and_retained when it destroyed some and kept some", async () => {
    const { out } = await erase({
      rows: { "meta.operate_entity_records": 7, "meta.notification_dispatches": 2 },
      survivors: { "meta.invoices": 3, "meta.tenant_credits": 1 },
    });
    const attestation = sharedTableErasureAttestation(out, BY);
    expect(DeletionAttestationSchema.safeParse(attestation).success).toBe(true);
    expect(attestation.outcome).toBe("erased_and_retained");
    expect(attestation.retainedObligations).toEqual(["tax_records_7y"]);
    expect(attestation.retainedDataReference).toBe("meta.invoices, meta.tenant_credits");
    // The figures describe only what was destroyed.
    expect(attestation.scope).toEqual({
      tables: ["meta.notification_dispatches", "meta.operate_entity_records"],
      rowCount: 9,
      storageBytes: 900,
    });
  });

  it("reports erased when nothing was lawfully kept", async () => {
    const { out } = await erase({ rows: { "meta.operate_entity_records": 7 } });
    const attestation = sharedTableErasureAttestation(out, BY);
    expect(DeletionAttestationSchema.safeParse(attestation).success).toBe(true);
    expect(attestation.outcome).toBe("erased");
    expect(attestation.retainedObligations).toBeUndefined();
    expect(attestation.retainedDataReference).toBeUndefined();
  });

  it("reports retained when the tenant held only statutory rows", async () => {
    const { out } = await erase({ survivors: { "meta.invoices": 3 } });
    const attestation = sharedTableErasureAttestation(out, BY);
    expect(DeletionAttestationSchema.safeParse(attestation).success).toBe(true);
    expect(attestation.outcome).toBe("retained");
    // Singular, because with nothing destroyed there is no scope to carry and `retained` is the
    // contract's shape for that.
    expect(attestation.retentionObligation).toBe("tax_records_7y");
    expect(attestation.retainedDataReference).toBe("meta.invoices");
    expect(attestation.scope).toBeUndefined();
  });

  it("refuses rather than name one of two obligations on the retained outcome", () => {
    // Unreachable through `erase()` while both statutory entries are `tax_records_7y`, so the
    // erasure is constructed directly — which is the point. The day a second obligation joins the
    // set this path becomes live, and the failure it used to have was silent: `obligations[0]`
    // builds a valid `retained` attestation, so `DeletionAttestationSchema` sees nothing wrong with
    // it and the second obligation is simply absent from the signed claim.
    const twoObligations: SharedTableErasure = {
      tenantId: TENANT,
      schema: "meta",
      erased: false,
      nothingToErase: true,
      erasedTables: [],
      rowCount: 0,
      storageBytes: 0,
      examinedTables: [],
      retainedTables: ["meta.invoices", "meta.patients"],
      platformRecordTables: [],
      statutoryTables: ["meta.invoices", "meta.patients"],
      statutoryRetained: [
        { table: "meta.invoices", obligation: "tax_records_7y" },
        { table: "meta.patients", obligation: "medical_records_10y" },
      ],
      refusals: [],
      erasedAt: AT,
    };
    expect(sharedTableRetention(twoObligations)?.obligations).toEqual([
      "medical_records_10y",
      "tax_records_7y",
    ]);
    expect(() => sharedTableErasureAttestation(twoObligations, BY)).toThrow(
      /more than one obligation/,
    );
  });

  it("reports nothing_to_erase when the tenant held nothing anywhere", async () => {
    const { out } = await erase();
    const attestation = sharedTableErasureAttestation(out, BY);
    expect(DeletionAttestationSchema.safeParse(attestation).success).toBe(true);
    expect(attestation.outcome).toBe("nothing_to_erase");
    expect(attestation.scope).toBeUndefined();
  });

  it("owns only the three scope fields shared_tables is allowed", async () => {
    const { out } = await erase({
      rows: { "meta.operate_entity_records": 7 },
      survivors: { "meta.invoices": 1 },
    });
    const attestation = sharedTableErasureAttestation(out, BY);
    expect(Object.keys(attestation.scope ?? {}).sort()).toEqual(
      [...SUBSYSTEM_SCOPE_FIELDS.shared_tables].sort(),
    );
  });

  it("stamps the attestation from the erasure's own clock, never a fresh now", async () => {
    const { out } = await erase({ rows: { "meta.operate_entity_records": 1 } });
    expect(sharedTableErasureAttestation(out, BY).attestedAt).toBe(AT);
    expect(sharedTableErasureAttestation(out, BY).attestedBy).toBe(BY);
  });

  it("sorts and deduplicates the obligations so the claim does not depend on catalog order", async () => {
    const { out } = await erase({
      rows: { "meta.operate_entity_records": 1 },
      survivors: { "meta.invoices": 1, "meta.tenant_credits": 1 },
    });
    const retention = sharedTableRetention(out);
    expect(retention?.obligations).toEqual(["tax_records_7y"]);
    expect(retention?.dataReference).toBe("meta.invoices, meta.tenant_credits");
  });
});
