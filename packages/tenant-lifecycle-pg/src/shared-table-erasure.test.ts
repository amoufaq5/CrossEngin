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
  censusBootSchemaTables,
  eraseSharedTablesWithin,
  partitionSharedTables,
  probeSharedTableErasability,
  sharedTableErasureAttestation,
  sharedTableErasureScope,
  sharedTableRetention,
  type BootSchemaErasureInput,
  type BootSchemaErasureTarget,
  type SharedTableErasure,
  type SharedTableErasureRefusalReason,
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

/**
 * `CATALOG` with a retained table referencing an erasable one under RESTRICT.
 *
 * Reachable through the catalog, which is the only injectable half — the retention sets themselves
 * are constants on purpose, since a caller-supplied retention list is ADR-0328's defect in a new
 * field.
 */
const BLOCKING_CATALOG: readonly TableDefinition[] = CATALOG.map((t) =>
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

/** The statutory set in the order the census reads it, taken from the partition rather than guessed. */
const STATUTORY_FIXTURES = partitionSharedTables(CATALOG).statutory.map((t) => t.qualified);

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeOptions {
  /** Qualified table → rows the tenant holds, which its `DELETE` therefore returns. */
  readonly rows?: Readonly<Record<string, number>>;
  /**
   * Qualified names the probe should report absent from `pg_class`.
   *
   * Qualified and not bare: the target list spans two schemas now, so a bare key cannot say which
   * relation it means — and a fake that answers for the wrong one is a test asserting the wrong
   * thing (ADR-0333).
   */
  readonly missing?: readonly string[];
  /** Qualified names the probe should report `row_security_active` for. */
  readonly confined?: readonly string[];
  /** Qualified names the probe should report present and carrying no `tenant_id` column. */
  readonly unscoped?: readonly string[];
  /**
   * Qualified names whose `scoped` column the probe answers with nothing at all.
   *
   * A separate list from `unscoped` rather than a `false` in it, because the production rule is that
   * only an affirmative yes licenses a `tenant_id` predicate — so a fake that could only ever say
   * `false` would leave the "absence is the finding" branch unexercised.
   */
  readonly scopeUnanswered?: readonly string[];
  /**
   * Qualified names the boot-schema census reports: relations in the schemas it was asked about that
   * carry a `<relname>_tenant_isolation` policy.
   *
   * `erase()` defaults it to the boot targets, so a census agreeing with the target list is the
   * baseline and no test acquires a `boot_schema_table_undeclared` it was not written for.
   */
  readonly census?: readonly string[];
  /** Qualified table → rows the confirm pass still sees. */
  readonly survivors?: Readonly<Record<string, number>>;
}

const RELATION_RE = /"([a-z_]+)"\."([a-z_]+)"/;

function relationOf(sql: string): string {
  const match = RELATION_RE.exec(sql);
  return match === null ? "" : `${match[1] ?? ""}.${match[2] ?? ""}`;
}

function schemaOf(qualified: string): string {
  const at = qualified.indexOf(".");
  return at < 0 ? "" : qualified.slice(0, at);
}

function fake(opts: FakeOptions = {}): { readonly conn: PgConnection; readonly calls: Call[] } {
  const calls: Call[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("row_security_active")) {
        const probed = String(params?.[0] ?? "");
        const requested = (params?.[1] ?? []) as readonly string[];
        const rows = requested
          .filter((name) => !(opts.missing ?? []).includes(`${probed}.${name}`))
          .map((name) => {
            const qualified = `${probed}.${name}`;
            const row = {
              table_name: name,
              confined: (opts.confined ?? []).includes(qualified),
            };
            if ((opts.scopeUnanswered ?? []).includes(qualified)) return row;
            return { ...row, scoped: !(opts.unscoped ?? []).includes(qualified) };
          });
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("pg_policy")) {
        // Modelling the `nspname = ANY($1)` filter rather than answering every declared row: a bare
        // name present in one schema must not mark another schema's as declared, which is the same
        // attribution the probe's per-schema grouping exists for.
        const asked = (params?.[0] ?? []) as readonly string[];
        const rows = (opts.census ?? [])
          .filter((q) => asked.includes(schemaOf(q)))
          .map((qualified) => ({ qualified }));
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("WITH deleted AS (DELETE FROM")) {
        const n = opts.rows?.[relationOf(sql)] ?? 0;
        return { rows: [{ n, bytes: n * 100 }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT count(*) AS n FROM")) {
        return { rows: [{ n: opts.survivors?.[relationOf(sql)] ?? 0 }], rowCount: 1 };
      }
      // A statement this fake does not model would otherwise be answered with an empty result set,
      // which is a plausible answer to every question here and a true one to none — ADR-0333's rule.
      // It is what keeps the census branch above honest: were its SQL to change shape, the census
      // would silently read as empty and every undeclared-table assertion would go vacuous.
      throw new Error(`unmodelled statement: ${sql}`);
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}

/** The two tables a `pg-columns` boot manifest would hand over, join table first. */
const BOOT_TARGETS: readonly BootSchemaErasureTarget[] = [
  { schema: "public", table: "patient_tag" },
  { schema: "public", table: "patient" },
];

/** What a `--store pg` or `--store memory` deployment passes: no entity tables, and an order for them. */
const NO_BOOT_SCHEMA: BootSchemaErasureInput = { targets: [], blockingCycle: [] };

const BOOT_SCHEMA: BootSchemaErasureInput = { targets: BOOT_TARGETS, blockingCycle: [] };

function erase(
  opts: FakeOptions = {},
  over: {
    readonly tenantId?: string;
    readonly approvedBy?: string;
    readonly schema?: string;
    // The whole grouped input, never a bare target list: the two come out of one derivation and a
    // helper letting a test supply targets without a cycle verdict is a helper that would not have
    // caught this change.
    readonly bootSchema?: BootSchemaErasureInput;
  } = {},
): Promise<{ readonly out: SharedTableErasure; readonly calls: Call[] }> {
  // Empty by default, so every pre-ADR-0350 assertion below still pins what it pinned: an empty
  // list is a legitimate value and the two `pg` stores pass it.
  const bootSchema = over.bootSchema ?? NO_BOOT_SCHEMA;
  const h = fake({
    ...opts,
    census: opts.census ?? bootSchema.targets.map((t) => `${t.schema}.${t.table}`),
  });
  return eraseSharedTablesWithin(
    h.conn,
    over.tenantId ?? TENANT,
    { executedBy: ALICE, approvedBy: over.approvedBy ?? BOB },
    {
      catalog: CATALOG,
      clock: () => new Date(AT),
      bootSchema,
      ...(over.schema !== undefined ? { schema: over.schema } : {}),
    },
  ).then((out) => ({ out, calls: h.calls }));
}

/** The reasons an erasure refused for, which is the first thing every refusal test reads. */
async function refusalsOf(
  ...args: Parameters<typeof erase>
): Promise<readonly SharedTableErasureRefusalReason[]> {
  return (await erase(...args)).out.refusals.map((r) => r.reason);
}

describe("the erasable set is derived, the retention set is named", () => {
  it("derives the erasable set from every tenant_id-bearing table in the live catalog", () => {
    const partition = partitionSharedTables();
    const tenantScoped = META_TABLES.filter((t) =>
      t.columns.some((c) => c.name === TENANT_SCOPE_COLUMN),
    );
    expect(partition.tenantScoped).toHaveLength(tenantScoped.length);
    // 115 of the catalog's 146 tables carry a `tenant_id`. The figure moves whenever a
    // tenant-scoped table is added, which is why the assertion above derives it from the live
    // catalog and only this line pins the number — a new table should make *one* line fail here,
    // visibly, rather than let the erasable set drift silently. It did exactly that for ADR-0347's
    // `meta.tenant_data_keys`, which is how that increment learned its crypto-shred needed no new
    // code: a wrapped data key carries a `tenant_id`, so the Article 17 erasure already destroys it.
    expect(tenantScoped).toHaveLength(115);
    expect(partition.erasable).toHaveLength(115 - RETAINED_SHARED_TABLES.length);
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
      "target_collides_with_catalog",
      "boot_schema_target_invalid",
      "boot_schema_order_unrunnable",
      "table_missing",
      "target_lacks_tenant_scope",
      "boot_schema_table_undeclared",
      "rls_would_confine_this_session",
    ]);
  });

  it("names each reason once", () => {
    // A doubled member would make the list above pass while `refusals` carried a reason whose two
    // declarations could drift apart in the doc comments the detail strings are written from.
    expect(new Set(SHARED_TABLE_ERASURE_REFUSAL_REASONS).size).toBe(
      SHARED_TABLE_ERASURE_REFUSAL_REASONS.length,
    );
  });

  it("throws on a schema name that is not an identifier, before any statement", async () => {
    const h = fake();
    await expect(
      eraseSharedTablesWithin(
        h.conn,
        TENANT,
        { executedBy: ALICE, approvedBy: BOB },
        { catalog: CATALOG, schema: 'meta"; DROP SCHEMA meta', bootSchema: NO_BOOT_SCHEMA },
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
      {
        catalog: [tenantTable("operate_entity_records")],
        clock: () => new Date(AT),
        bootSchema: NO_BOOT_SCHEMA,
      },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(
      RETAINED_SHARED_TABLES.map(() => "retention_entry_unresolved"),
    );
    expect(h.calls).toEqual([]);
  });

  it("refuses a table the catalog declares and the database lacks, after deleting nothing", async () => {
    const { out, calls } = await erase({ missing: ["meta.notification_dispatches"] });
    expect(out.refusals.map((r) => r.reason)).toEqual(["table_missing"]);
    expect(out.refusals[0]?.detail).toContain("meta.notification_dispatches");
    expect(calls.some((c) => c.sql.startsWith("WITH deleted AS"))).toBe(false);
  });

  it("refuses when row-level security would confine this session, after deleting nothing", async () => {
    const { out, calls } = await erase({ confined: ["meta.operate_entity_records"] });
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
      missing: ["meta.notification_deliveries"],
      confined: ["meta.operate_entity_records"],
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

/**
 * The boot manifest's own entity tables — the half of this subsystem's declared remit that nothing
 * erased until ADR-0350, while the proof over them verified.
 */
describe("the boot manifest's own entity tables", () => {
  function deletedIn(calls: readonly Call[]): string[] {
    return calls
      .filter((c) => c.sql.startsWith("WITH deleted AS (DELETE FROM"))
      .map((c) => relationOf(c.sql));
  }

  it("empties them, in the order they arrive, before the catalogued ones", async () => {
    const { out, calls } = await erase(
      { rows: { "public.patient": 1 } },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.erased).toBe(true);
    // The tenant's own records first — the order between the groups is free, since neither's
    // foreign keys reach the other — and the boot group's own order is not resorted: `patient_tag`
    // is the join table and its composite keys point at `patient`.
    expect(deletedIn(calls)).toEqual([
      "public.patient_tag",
      "public.patient",
      ...ERASABLE_FIXTURES,
    ]);
  });

  it("names a boot target that lost rows in the scope the proof commits to", async () => {
    const { out } = await erase(
      { rows: { "public.patient": 1 } },
      { bootSchema: BOOT_SCHEMA },
    );
    // Schema-qualified, which is what `SharedTableTarget.qualified` was built for: a bare `patient`
    // in a scope beside `meta.operate_entity_records` would not say whose table it was.
    expect(sharedTableErasureScope(out).tables).toEqual(["public.patient"]);
  });

  it("folds both groups into one row count and one byte figure", async () => {
    // One subsystem, one attestation — `duplicate_attestation` allows `shared_tables` exactly one,
    // so the figures have to fold however the erasure is arranged internally.
    const { out } = await erase(
      { rows: { "public.patient": 2, "meta.operate_entity_records": 7 } },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.rowCount).toBe(9);
    expect(out.storageBytes).toBe(900);
    expect(out.erasedTables).toEqual([
      { table: "public.patient", rowCount: 2, storageBytes: 200 },
      { table: "meta.operate_entity_records", rowCount: 7, storageBytes: 700 },
    ]);
  });

  it("examines every boot target even where the tenant held nothing", async () => {
    const { out } = await erase(
      { rows: { "meta.operate_entity_records": 1 } },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.examinedTables).toEqual([
      "public.patient_tag",
      "public.patient",
      ...ERASABLE_FIXTURES,
    ]);
    // Examined, not destroyed: a scope naming them would claim a destruction that did not happen.
    expect(out.erasedTables.map((t) => t.table)).toEqual(["meta.operate_entity_records"]);
  });

  it("carries both groups in coverage, boot group first, every entry schema-qualified", async () => {
    const { out } = await erase({}, { bootSchema: BOOT_SCHEMA });
    const boot = BOOT_TARGETS.map((t) => `${t.schema}.${t.table}`);
    // The coverage list is read beside a proof whose `tables` is flat, so a bare name in it would
    // not say whose relation it was — and the tenant's own records come first because that is the
    // figure an operator answering an Article 17 request reads first.
    for (const entry of out.examinedTables) expect(entry).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(out.examinedTables.slice(0, boot.length)).toEqual(boot);
    expect(out.examinedTables.slice(boot.length)).toEqual([...ERASABLE_FIXTURES]);
  });

  it("confirms absence in the boot targets too, after the last delete", async () => {
    const { calls } = await erase(
      { rows: { "public.patient": 1 } },
      { bootSchema: BOOT_SCHEMA },
    );
    const confirmed = calls
      .filter((c) => c.sql.startsWith("SELECT count(*) AS n FROM"))
      .map((c) => relationOf(c.sql));
    expect(confirmed).toEqual([
      "public.patient_tag",
      "public.patient",
      ...ERASABLE_FIXTURES,
      ...STATUTORY_FIXTURES,
    ]);
    const lastDelete = calls.reduce(
      (acc, c, i) => (c.sql.startsWith("WITH deleted AS") ? i : acc),
      -1,
    );
    const firstConfirm = calls.findIndex((c) => c.sql.startsWith("SELECT count(*) AS n FROM"));
    expect(firstConfirm).toBeGreaterThan(lastDelete);
  });

  it("throws rather than reporting success when a boot target keeps a row", async () => {
    await expect(
      erase(
        { rows: { "public.patient": 1 }, survivors: { "public.patient": 1 } },
        { bootSchema: BOOT_SCHEMA },
      ),
    ).rejects.toThrow(/left rows behind in public\.patient \(1 row\(s\)\)/);
  });

  it("refuses a target that collides with a retained catalogued table, deleting nothing", async () => {
    // The severe case: this erasure's only predicate is `tenant_id = $1`, so an entity called
    // `AuditLog` served from `meta` would destroy the platform's record of this very deletion with
    // an entirely correct-looking statement.
    const { out, calls } = await erase(
      { rows: { "meta.operate_entity_records": 7 } },
      { bootSchema: { targets: [{ schema: "meta", table: "audit_log" }], blockingCycle: [] } },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["target_collides_with_catalog"]);
    expect(out.refusals[0]?.detail).toContain("meta.audit_log");
    expect(calls).toEqual([]);
  });

  it("refuses a collision with a catalogued table that has no tenant_id at all", async () => {
    // `meta.plans` is platform-wide, so the DELETE would raise `column tenant_id does not exist`
    // mid-transaction — loud, and still better said as a named refusal before anything is destroyed.
    const { out, calls } = await erase(
      {},
      { bootSchema: { targets: [{ schema: "meta", table: "plans" }], blockingCycle: [] } },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["target_collides_with_catalog"]);
    expect(calls).toEqual([]);
  });

  it("does not refuse a boot target whose bare name is catalogued in another schema", async () => {
    // The collision is about the relation, not the name: `public.invoices` is the tenant's own
    // table and is nothing to do with the retained `meta.invoices`.
    const { out } = await erase(
      { rows: { "public.invoices": 4 } },
      { bootSchema: { targets: [{ schema: "public", table: "invoices" }], blockingCycle: [] } },
    );
    expect(out.refusals).toEqual([]);
    expect(out.erasedTables.map((t) => t.table)).toEqual(["public.invoices"]);
  });

  it("refuses the same relation named twice", async () => {
    const { out, calls } = await erase(
      {},
      {
        bootSchema: {
          targets: [...BOOT_TARGETS, { schema: "public", table: "patient" }],
          blockingCycle: [],
        },
      },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["target_collides_with_catalog"]);
    expect(out.refusals[0]?.detail).toContain("named twice");
    expect(calls).toEqual([]);
  });

  it("refuses a confined boot target before any DELETE", async () => {
    // Verified live for the catalogued half: a confined session's DELETE matches 0 rows, reports 0,
    // and the confirm-absence count *also* sees 0 through the same policy. The boot targets enable
    // RLS too (`emitEntityTableDdl`), so the probe is the only place to catch it there either.
    const { out, calls } = await erase(
      { confined: ["public.patient"], rows: { "public.patient": 1 } },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["rls_would_confine_this_session"]);
    expect(out.refusals[0]?.detail).toContain("public.patient");
    expect(calls.some((c) => c.sql.startsWith("WITH deleted AS"))).toBe(false);
    expect(calls.some((c) => c.sql.startsWith("SELECT count(*) AS n FROM"))).toBe(false);
  });

  it("refuses a boot target the database does not have, as table_missing", async () => {
    // Deliberately not a second answer for the same fact: a target that is not there is a target
    // that is not there, whichever group named it.
    const { out, calls } = await erase(
      { missing: ["public.patient_tag"] },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["table_missing"]);
    expect(out.refusals[0]?.detail).toContain("public.patient_tag");
    expect(calls.some((c) => c.sql.startsWith("WITH deleted AS"))).toBe(false);
  });

  it("settles both groups' refusals in one pass, before the first DELETE", async () => {
    // The property the whole design turns on. Two erasures would have needed the second's refusals
    // known before the first wrote anything; one merged list gets it by construction, so ADR-0330's
    // "a returned refusal means nothing was destroyed" holds across both halves.
    const { out, calls } = await erase(
      {
        missing: ["public.patient"],
        confined: ["meta.operate_entity_records"],
        rows: { "public.patient_tag": 3 },
      },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual([
      "table_missing",
      "rls_would_confine_this_session",
    ]);
    // Every statement that ran is one of the two read-only surveys — the per-schema probe or the
    // boot-schema census — so nothing in either group was touched.
    expect(
      calls.every((c) => c.sql.includes("row_security_active") || c.sql.includes("pg_policy")),
    ).toBe(true);
    const firstDelete = calls.findIndex((c) => c.sql.startsWith("WITH deleted AS"));
    expect(firstDelete).toBe(-1);
  });

  it("probes both groups before deleting from either", async () => {
    const { calls } = await erase(
      { rows: { "public.patient": 1, "meta.operate_entity_records": 1 } },
      { bootSchema: BOOT_SCHEMA },
    );
    const lastProbe = calls.reduce(
      (acc, c, i) => (c.sql.includes("row_security_active") ? i : acc),
      -1,
    );
    const firstDelete = calls.findIndex((c) => c.sql.startsWith("WITH deleted AS"));
    expect(lastProbe).toBeGreaterThan(-1);
    expect(firstDelete).toBeGreaterThan(lastProbe);
    expect(calls.filter((c) => c.sql.includes("row_security_active"))).toHaveLength(2);
  });

  it("attests both groups as one erased claim", async () => {
    const { out } = await erase(
      { rows: { "public.patient": 2, "meta.operate_entity_records": 7 } },
      { bootSchema: BOOT_SCHEMA },
    );
    const attestation = sharedTableErasureAttestation(out, "tenant-lifecycle-pg/deletion:alice");
    expect(DeletionAttestationSchema.safeParse(attestation).success).toBe(true);
    expect(attestation.outcome).toBe("erased");
    expect(attestation.scope).toEqual({
      tables: ["public.patient", "meta.operate_entity_records"],
      rowCount: 9,
      storageBytes: 900,
    });
  });

  it("behaves exactly as it did before when the list is empty", async () => {
    // An empty list is a legitimate value and the signed assertion that there were none, so every
    // figure a `--store pg` deployment produces is unchanged.
    const empty = await erase({ rows: { "meta.operate_entity_records": 7 } }, {
      bootSchema: NO_BOOT_SCHEMA,
    });
    const same = await erase({ rows: { "meta.operate_entity_records": 7 } });
    expect(empty.out).toEqual(same.out);
    expect(empty.out.examinedTables).toEqual([...ERASABLE_FIXTURES]);
    expect(empty.calls.map((c) => c.sql)).toEqual(same.calls.map((c) => c.sql));
  });
});

/**
 * The order the boot group arrives in, and the one case where there is none.
 *
 * The targets carry their own order and this module does not resort them; what it must do is refuse
 * a list the database would refuse partway through, because by then the pipeline's transaction has
 * already dropped the tenant's schema and the runner files the throw `aborted`.
 */
describe("a boot-schema order that cannot run", () => {
  const CYCLE: BootSchemaErasureInput = {
    targets: BOOT_TARGETS,
    blockingCycle: ["Patient", "Tag"],
  };

  it("refuses a non-empty blocking cycle without issuing a single statement", async () => {
    const { out, calls } = await erase({ rows: { "public.patient": 3 } }, { bootSchema: CYCLE });
    expect(out.refusals.map((r) => r.reason)).toEqual(["boot_schema_order_unrunnable"]);
    expect(out.erased).toBe(false);
    // Cheap: settled before the probe, so this erasure never even looked at the database — which is
    // what makes "a returned refusal means nothing was destroyed" true without reading the rollback.
    expect(calls).toEqual([]);
  });

  it("names the entities and the remedy, since only a manifest edit can fix it", async () => {
    const { out } = await erase({}, { bootSchema: CYCLE });
    const detail = out.refusals[0]?.detail ?? "";
    expect(detail).toContain("Patient, Tag");
    expect(detail).toContain("2 of the boot manifest's entities");
    // "blocked by" and not "reference each other": `blockingCycle` holds every entity the cycle
    // blocks, including any sitting behind it, so the shorter claim would be false of some names.
    expect(detail).toContain("a cycle of ON DELETE RESTRICT references blocks them");
    expect(detail).toContain("onDelete cascade or set_null");
  });

  it("refuses before probing even when every other check would pass", async () => {
    // The cycle is a property of the manifest, so it cannot be cured by anything the probe learns —
    // and the one thing that must not happen is the first DELETE.
    const { out, calls } = await erase(
      { rows: { "public.patient": 1, "meta.operate_entity_records": 7 } },
      { bootSchema: CYCLE },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["boot_schema_order_unrunnable"]);
    expect(out.rowCount).toBe(0);
    expect(out.erasedTables).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("treats an empty cycle as an order, not as an absent answer", async () => {
    const { out } = await erase({ rows: { "public.patient": 1 } }, { bootSchema: BOOT_SCHEMA });
    expect(out.refusals).toEqual([]);
    expect(out.erased).toBe(true);
  });
});

/**
 * A boot-schema target whose name is not an identifier.
 *
 * The decision under test is that this is a **refusal** and not a throw, and it has nothing to do
 * with whose fault the name is: a throw inside the pipeline's transaction that is not a
 * `DeletionPipelineAborted` is filed `aborted` and leaves the Article 17 request `in_progress` for a
 * human, while a returned refusal is deterministic and the request is `rejected` with the remedy
 * named. Nothing is destroyed either way; the difference is whether the request is stranded.
 */
describe("a boot-schema target that is not an identifier", () => {
  const INVALID: readonly BootSchemaErasureTarget[] = [
    { schema: "public", table: 'patient" CASCADE; --' },
    { schema: 'public"; DROP SCHEMA public', table: "patient" },
  ];

  it("refuses rather than throwing, and issues no statement", async () => {
    for (const target of INVALID) {
      const { out, calls } = await erase(
        {},
        { bootSchema: { targets: [target], blockingCycle: [] } },
      );
      expect(out.refusals.map((r) => r.reason), target.table).toEqual([
        "boot_schema_target_invalid",
      ]);
      expect(out.erased).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it("keeps the unquotable name out of the coverage it reports", async () => {
    // Dropped from the target list rather than carried into it: a name that cannot be quoted cannot
    // be probed either, and `table_missing` for it would name the wrong defect. What makes that safe
    // to do is the refusal beside it, which is why the detail says the list would have been silent.
    const { out } = await erase(
      {},
      { bootSchema: { targets: [...INVALID, ...BOOT_TARGETS], blockingCycle: [] } },
    );
    for (const target of INVALID) {
      expect(out.examinedTables).not.toContain(`${target.schema}.${target.table}`);
    }
    expect(out.examinedTables).toEqual([
      "public.patient_tag",
      "public.patient",
      ...ERASABLE_FIXTURES,
    ]);
    expect(out.refusals.map((r) => r.reason)).toEqual([
      "boot_schema_target_invalid",
      "boot_schema_target_invalid",
    ]);
    expect(out.refusals[0]?.detail).toContain("silent about one of the tenant's own tables");
  });
});

/**
 * A target the database has and that has no column to scope by.
 *
 * Every statement here is `WHERE tenant_id = $1`, so such a table raises mid-transaction, after
 * earlier targets have been emptied — the rollback saves the data and strands the request, exactly
 * as an unquotable name would.
 */
describe("a target with no tenant_id column", () => {
  it("refuses a boot target the probe reports present and unscoped, deleting nothing", async () => {
    const { out, calls } = await erase(
      { unscoped: ["public.patient"], rows: { "public.patient": 4 } },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["target_lacks_tenant_scope"]);
    // Named exactly, because `public.patient` is a prefix of the sibling target: a `toContain` on
    // the bare name alone would pass for a refusal about the wrong relation.
    expect(out.refusals[0]?.detail).toContain(
      `1 target table(s) have no ${TENANT_SCOPE_COLUMN} column: public.patient;`,
    );
    // Probed, not cheap: the probe is the only thing that can answer this, so it has to have run —
    // and nothing after it may.
    expect(calls.some((c) => c.sql.includes("row_security_active"))).toBe(true);
    expect(calls.some((c) => c.sql.startsWith("WITH deleted AS"))).toBe(false);
    expect(calls.some((c) => c.sql.startsWith("SELECT count(*) AS n FROM"))).toBe(false);
  });

  it("refuses a catalogued table the database holds in a shape the catalog moved past", async () => {
    // Reachable from both groups and for different reasons: here it is ADR-0300's drift, in the one
    // statement that must not be aimed by guesswork.
    const { out, calls } = await erase({ unscoped: ["meta.notification_dispatches"] });
    expect(out.refusals.map((r) => r.reason)).toEqual(["target_lacks_tenant_scope"]);
    expect(out.refusals[0]?.detail).toContain("meta.notification_dispatches");
    expect(calls.some((c) => c.sql.startsWith("WITH deleted AS"))).toBe(false);
  });

  it("refuses when the probe could not establish the column at all", async () => {
    // Absence is the finding. A probe that answered nothing must not license a statement that needs
    // the column — the opposite polarity from `confined`, where a silence is left to the confirm
    // pass rather than refusing every deletion.
    const { out } = await erase(
      { scopeUnanswered: ["public.patient_tag"] },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["target_lacks_tenant_scope"]);
    expect(out.refusals[0]?.detail).toContain("public.patient_tag");
  });

  it("refuses a statutory table with no scope, so a retention cannot be read unscoped", async () => {
    // The statutory tables are probed alongside the erasable ones because the census *reads* them to
    // decide whether a retention is claimed at all.
    const { out } = await erase({ unscoped: ["meta.invoices"] });
    expect(out.refusals.map((r) => r.reason)).toEqual(["target_lacks_tenant_scope"]);
    expect(out.refusals[0]?.detail).toContain("meta.invoices");
  });
});

/**
 * The boot schema holding a table the target list does not name — the original defect's own shape,
 * one manifest later.
 *
 * A previous boot manifest's entity table survives a manifest that no longer declares that entity,
 * so the derived target list cannot name it, nothing examines it, and the proof attests `erased`
 * over the tenant's rows in it.
 */
describe("the boot-schema census", () => {
  it("refuses a relation the column store created and this manifest does not declare", async () => {
    const { out, calls } = await erase(
      { census: ["public.patient_tag", "public.patient", "public.old_encounter"] },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.refusals.map((r) => r.reason)).toEqual(["boot_schema_table_undeclared"]);
    expect(out.refusals[0]?.detail).toContain("public.old_encounter");
    // A refusal rather than a report, which is the opposite of how the undeclared-foreign-key case
    // is handled one package over, for the one reason that outranks it: the alternative here is
    // signing a proof over live records.
    expect(out.erased).toBe(false);
    expect(calls.some((c) => c.sql.startsWith("WITH deleted AS"))).toBe(false);
    expect(calls.some((c) => c.sql.startsWith("SELECT count(*) AS n FROM"))).toBe(false);
  });

  it("names the remedy, which is a DROP TABLE an operator runs once", async () => {
    const { out } = await erase(
      { census: ["public.patient_tag", "public.patient", "public.old_encounter"] },
      { bootSchema: BOOT_SCHEMA },
    );
    const detail = out.refusals[0]?.detail ?? "";
    expect(detail).toContain("1 table(s) in public");
    expect(detail).toContain("A previous manifest's entity table is the usual cause");
    expect(detail).toContain("Drop it, or");
  });

  it("refuses nothing when every censused relation is a declared target", async () => {
    const { out } = await erase(
      {
        census: ["public.patient", "public.patient_tag"],
        rows: { "public.patient": 1 },
      },
      { bootSchema: BOOT_SCHEMA },
    );
    expect(out.refusals).toEqual([]);
    expect(out.erased).toBe(true);
  });

  it("censuses only the schemas the boot targets name, never the catalogued one", async () => {
    // Censusing `meta` would report all of META_TABLES as undeclared: the catalogued half's
    // membership is compared against `META_TABLES` by `partitionSharedTables` already.
    const { calls } = await erase({ rows: { "public.patient": 1 } }, { bootSchema: BOOT_SCHEMA });
    const census = calls.filter((c) => c.sql.includes("pg_policy"));
    expect(census).toHaveLength(1);
    expect(census[0]?.params).toEqual([["public"]]);
  });

  it("says nothing about a relation of ours in a schema no boot target names", async () => {
    // The other side of the narrowing, and the limit it buys: a table left over from a deployment
    // that served its entity tables from another schema is outside this detector's reach, because
    // the schemas it looks in come from the target list and nowhere else.
    const { out } = await erase(
      { census: ["public.patient", "legacy.old_encounter"], rows: { "public.patient": 1 } },
      { bootSchema: { targets: [{ schema: "public", table: "patient" }], blockingCycle: [] } },
    );
    expect(out.refusals).toEqual([]);
    expect(out.erased).toBe(true);
  });

  it("issues no census statement when there are no boot targets", async () => {
    // A stated limit rather than an oversight: a deployment that served `--store pg-columns` and now
    // serves `--store pg` has those tables still on disk and names no schema, so this detector
    // cannot see them.
    const { calls } = await erase(
      { census: ["public.old_encounter"], rows: { "meta.operate_entity_records": 7 } },
      { bootSchema: NO_BOOT_SCHEMA },
    );
    expect(calls.some((c) => c.sql.includes("pg_policy"))).toBe(false);
  });

  it("asks once for two targets sharing a schema, and once per schema otherwise", async () => {
    const { calls } = await erase(
      { census: ["public.patient", "legacy.patient_tag"] },
      {
        bootSchema: {
          targets: [
            { schema: "public", table: "patient" },
            { schema: "legacy", table: "patient_tag" },
          ],
          blockingCycle: [],
        },
      },
    );
    const census = calls.filter((c) => c.sql.includes("pg_policy"));
    expect(census).toHaveLength(1);
    expect(census[0]?.params).toEqual([["public", "legacy"]]);
  });
});

describe("probeSharedTableErasability", () => {
  it("asks one read-only statement for all three questions", async () => {
    const h = fake({ missing: ["meta.b"], confined: ["meta.c"], unscoped: ["meta.d"] });
    const probe = await probeSharedTableErasability(h.conn, [
      { schema: "meta", table: "a", qualified: "meta.a" },
      { schema: "meta", table: "b", qualified: "meta.b" },
      { schema: "meta", table: "c", qualified: "meta.c" },
      { schema: "meta", table: "d", qualified: "meta.d" },
    ]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.params).toEqual(["meta", ["a", "b", "c", "d"]]);
    expect(probe.missing).toEqual(["meta.b"]);
    expect(probe.confined).toEqual(["meta.c"]);
    expect(probe.unscoped).toEqual(["meta.d"]);
  });

  it("asks for the scope column through pg_attribute, so a partition answers too", async () => {
    const h = fake();
    await probeSharedTableErasability(h.conn, [
      { schema: "meta", table: "a", qualified: "meta.a" },
    ]);
    const sql = h.calls[0]?.sql ?? "";
    // `information_schema.columns` would not see a partition, which `relkind IN ('r','p')` admits.
    expect(sql).toContain("pg_attribute");
    expect(sql).not.toContain("information_schema");
    expect(sql).toContain(`a.attname = '${TENANT_SCOPE_COLUMN}'`);
    // A dropped column keeps its `pg_attribute` row, and a system column has a negative `attnum`.
    expect(sql).toContain("NOT a.attisdropped");
    expect(sql).toContain("a.attnum > 0");
  });

  it("reports a missing table as missing and never as unscoped", async () => {
    // The two findings have different remedies — reconcile the schema versus point the targets at
    // another one — and a table that is not there has no column to be missing.
    const h = fake({ missing: ["meta.a"] });
    const probe = await probeSharedTableErasability(h.conn, [
      { schema: "meta", table: "a", qualified: "meta.a" },
    ]);
    expect(probe.missing).toEqual(["meta.a"]);
    expect(probe.unscoped).toEqual([]);
  });

  it("reads an unanswered scope column as unscoped, and an unanswered confinement as free", async () => {
    // The asymmetry is deliberate and is the whole of `scoped`'s rule: a probe that could not
    // establish the column must not license a statement that needs it, while uncertainty about RLS
    // is left to the confirm pass rather than refusing every deletion on a silence.
    const h = fake({ scopeUnanswered: ["meta.a"] });
    const probe = await probeSharedTableErasability(h.conn, [
      { schema: "meta", table: "a", qualified: "meta.a" },
    ]);
    expect(probe.unscoped).toEqual(["meta.a"]);
    expect(probe.confined).toEqual([]);
    expect(probe.missing).toEqual([]);
  });

  it("asks one statement per distinct schema, each with its own targets", async () => {
    const h = fake({ missing: ["public.b"], confined: ["meta.a"] });
    const probe = await probeSharedTableErasability(h.conn, [
      { schema: "public", table: "a", qualified: "public.a" },
      { schema: "meta", table: "a", qualified: "meta.a" },
      { schema: "public", table: "b", qualified: "public.b" },
    ]);
    // Grouped in first-appearance order, so the answer does not depend on map iteration luck.
    expect(h.calls.map((c) => c.params)).toEqual([
      ["public", ["a", "b"]],
      ["meta", ["a"]],
    ]);
    // The same bare name in two schemas: `public.a` is present and `meta.a` is confined, and
    // neither answer may leak into the other.
    expect(probe.missing).toEqual(["public.b"]);
    expect(probe.confined).toEqual(["meta.a"]);
    expect(probe.unscoped).toEqual([]);
  });

  it("keeps the scope answer per relation when one bare name spans two schemas", async () => {
    const h = fake({ unscoped: ["public.a"] });
    const probe = await probeSharedTableErasability(h.conn, [
      { schema: "public", table: "a", qualified: "public.a" },
      { schema: "meta", table: "a", qualified: "meta.a" },
    ]);
    expect(probe.unscoped).toEqual(["public.a"]);
  });

  it("asks nothing when there is nothing to erase", async () => {
    const h = fake();
    expect(await probeSharedTableErasability(h.conn, [])).toEqual({
      missing: [],
      confined: [],
      unscoped: [],
    });
    expect(h.calls).toEqual([]);
  });
});

/**
 * The census of the boot schema: the *other* direction, which is what the original defect was made
 * of. A one-way comparison is what made ADR-0288's list wrong three times.
 */
describe("censusBootSchemaTables", () => {
  it("asks for relations carrying the policy this emitter writes, and nothing else", async () => {
    const h = fake({ census: ["public.patient"] });
    expect(await censusBootSchemaTables(h.conn, ["public"])).toEqual(["public.patient"]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.params).toEqual([["public"]]);
    // Narrow on purpose: the default boot schema is `public`, which a deployment may share with
    // tables that are none of our business, so a census keyed on "has a tenant_id column" would
    // refuse every Article 17 deletion in such a deployment.
    expect(h.calls[0]?.sql).toContain("p.polname = c.relname || '_tenant_isolation'");
  });

  it("asks nothing when no schema was named", async () => {
    const h = fake({ census: ["public.patient"] });
    expect(await censusBootSchemaTables(h.conn, [])).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("returns the relations schema-qualified, since one name can sit in two schemas", async () => {
    const h = fake({ census: ["public.patient", "legacy.patient"] });
    expect(await censusBootSchemaTables(h.conn, ["public", "legacy"])).toEqual([
      "public.patient",
      "legacy.patient",
    ]);
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
    const partition = partitionSharedTables(BLOCKING_CATALOG);
    expect(partition.blockedByRetention).toEqual([
      "meta.invoices.issued_by -> operate_entity_records (ON DELETE RESTRICT)",
    ]);
    const h = fake();
    const out = await eraseSharedTablesWithin(
      h.conn,
      TENANT,
      { executedBy: ALICE, approvedBy: BOB },
      { catalog: BLOCKING_CATALOG, clock: () => new Date(AT), bootSchema: NO_BOOT_SCHEMA },
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
    const { out } = await erase({ confined: ["meta.invoices"] });
    expect(out.refusals.map((r) => r.reason)).toEqual(["rls_would_confine_this_session"]);
    expect(out.refusals[0]?.detail).toContain("meta.invoices");
  });

  it("refuses a statutory table the database does not have", async () => {
    const { out } = await erase({ missing: ["meta.tenant_credits"] });
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

/**
 * Every refusal reason, split into the ones a scenario here drives and the ones nothing can.
 *
 * Compared against the enum in **both** directions, which is the only thing that makes the split
 * mean anything (`pg-record-retention.ts`'s rule): a reason added tomorrow has to land on one side
 * or the other, and a reason that becomes reachable stops being declared unreachable the moment a
 * scenario drives it. A one-way list is what made ADR-0288's wrong three times.
 */
describe("the refusal reasons are all reachable, or declared unreachable with the reason", () => {
  /**
   * Refusals computed and refused on anyway, where the construction *is* the guarantee: a later
   * refactor that replaced a derived complement with a second hand-written list would break the
   * guarantee without changing any assertion that only looked at the two sets it was given.
   */
  const STRUCTURALLY_UNREACHABLE: readonly {
    readonly reason: SharedTableErasureRefusalReason;
    readonly because: string;
  }[] = [
    {
      reason: "unclassified_tenant_table",
      because:
        "`erasable` is the complement of `retained` over the tenant-scoped tables, so every" +
        " tenant-scoped table is in one of the two arrays the check is run against",
    },
    {
      reason: "retention_reason_unassigned",
      because: "`retained` is the union of the two reason sets, so one of them always claims it",
    },
    {
      reason: "retention_reason_ambiguous",
      because:
        "it is derived from PLATFORM_RECORD_TABLES and STATUTORY_RETENTION_TABLES, which are module" +
        " constants and deliberately not parameters — a caller-supplied retention list is" +
        " ADR-0328's defect in a new field",
    },
  ];

  const COLLIDING_BOOT: BootSchemaErasureInput = {
    targets: [{ schema: "meta", table: "audit_log" }],
    blockingCycle: [],
  };
  const UNQUOTABLE_BOOT: BootSchemaErasureInput = {
    targets: [{ schema: "public", table: 'patient" CASCADE; --' }],
    blockingCycle: [],
  };
  const CYCLIC_BOOT: BootSchemaErasureInput = { targets: BOOT_TARGETS, blockingCycle: ["Patient"] };

  /** A catalog this fixture set cannot reach through `erase()`, which pins `CATALOG`. */
  async function refusalsForCatalog(
    catalog: readonly TableDefinition[],
  ): Promise<readonly SharedTableErasureRefusalReason[]> {
    const h = fake();
    const out = await eraseSharedTablesWithin(
      h.conn,
      TENANT,
      { executedBy: ALICE, approvedBy: BOB },
      { catalog, clock: () => new Date(AT), bootSchema: NO_BOOT_SCHEMA },
    );
    return out.refusals.map((r) => r.reason);
  }

  const DRIVEN: readonly {
    readonly reason: SharedTableErasureRefusalReason;
    readonly run: () => Promise<readonly SharedTableErasureRefusalReason[]>;
  }[] = [
    { reason: "invalid_tenant_id", run: () => refusalsOf({}, { tenantId: "not-a-uuid" }) },
    { reason: "four_eyes_violated", run: () => refusalsOf({}, { approvedBy: ALICE }) },
    {
      reason: "retention_entry_unresolved",
      run: () => refusalsForCatalog([tenantTable("operate_entity_records")]),
    },
    {
      reason: "retained_table_blocks_erasure",
      run: () => refusalsForCatalog(BLOCKING_CATALOG),
    },
    {
      reason: "target_collides_with_catalog",
      run: () => refusalsOf({}, { bootSchema: COLLIDING_BOOT }),
    },
    {
      reason: "boot_schema_target_invalid",
      run: () => refusalsOf({}, { bootSchema: UNQUOTABLE_BOOT }),
    },
    {
      reason: "boot_schema_order_unrunnable",
      run: () => refusalsOf({}, { bootSchema: CYCLIC_BOOT }),
    },
    {
      reason: "table_missing",
      run: () => refusalsOf({ missing: ["meta.notification_dispatches"] }),
    },
    {
      reason: "target_lacks_tenant_scope",
      run: () => refusalsOf({ unscoped: ["meta.operate_entity_records"] }),
    },
    {
      reason: "boot_schema_table_undeclared",
      run: () =>
        refusalsOf({ census: ["public.patient", "public.patient_tag", "public.gone"] }, {
          bootSchema: BOOT_SCHEMA,
        }),
    },
    {
      reason: "rls_would_confine_this_session",
      run: () => refusalsOf({ confined: ["meta.operate_entity_records"] }),
    },
  ];

  it("drives each reachable reason from a real refusal", async () => {
    for (const scenario of DRIVEN) {
      expect(await scenario.run(), scenario.reason).toContain(scenario.reason);
    }
  });

  it("partitions the enum between driven and structurally unreachable", async () => {
    const driven = new Set<SharedTableErasureRefusalReason>();
    for (const scenario of DRIVEN) {
      for (const reason of await scenario.run()) driven.add(reason);
    }
    const unreachable = STRUCTURALLY_UNREACHABLE.map((u) => u.reason);
    const reachable = SHARED_TABLE_ERASURE_REFUSAL_REASONS.filter((r) => !unreachable.includes(r));
    expect([...driven].sort()).toEqual([...reachable].sort());
    // The other direction: a reason declared unreachable that a scenario in fact produced is a
    // declaration that has stopped being true, which is the half a single-list comparison misses.
    expect(unreachable.filter((r) => driven.has(r))).toEqual([]);
  });

  it("declares a reason for each unreachable member, and no name the enum lacks", () => {
    for (const entry of STRUCTURALLY_UNREACHABLE) {
      expect(SHARED_TABLE_ERASURE_REFUSAL_REASONS, entry.reason).toContain(entry.reason);
      expect(entry.because.length, entry.reason).toBeGreaterThan(40);
      // A "reason" that restates its own key explains nothing — `ABAC_RECORD_AVAILABILITY_REASONS`
      // fails the same shape test for the same reason.
      expect(entry.because, entry.reason).not.toContain(entry.reason);
    }
    expect(new Set(STRUCTURALLY_UNREACHABLE.map((u) => u.reason)).size).toBe(
      STRUCTURALLY_UNREACHABLE.length,
    );
  });
});
