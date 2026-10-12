import type { PgConnection } from "@crossengin/kernel-pg";
import {
  readRecordStorage,
  verifyTombstoneHashes,
  type DeletionAttestation,
  type DeletionCapabilities,
  type TombstoneRecordStorageDeclaration,
} from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  DeletionPipelineAborted,
  PIPELINE_PERFORMED_SUBSYSTEMS,
  PIPELINE_REFUSAL_STAGES,
  deleteTenantAtomically,
  isAnchoredByChain,
  type BootSchemaDeletionInput,
  type SchemaEraserWithin,
} from "./deletion-pipeline.js";
import { PostgresLifecycleEventStore } from "./lifecycle-event-store.js";
import {
  RETAINED_SHARED_TABLES,
  type BootSchemaErasureTarget,
} from "./shared-table-erasure.js";
import { PostgresTombstoneStore, type TombstoneAnchorer } from "./tombstone-store.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const AT = "2026-10-03T13:00:00.000Z";
const ENTRY_HASH = "d".repeat(64);
const ALICE = "alice@example.test";
const BOB = "bob@example.test";

/** Both subsystems this pipeline performs are declared, because `absent` is now refused for them. */
const CAPABILITIES: DeletionCapabilities = {
  tenant_schema: "erases",
  shared_tables: "erases",
  object_storage: "absent",
  backups: "absent",
  search_indexes: "absent",
  caches: "absent",
};

/**
 * What a `--store pg-columns` deployment declares about where it keeps the tenant's own records
 * (ADR-0351) — and **without** `relationCount`, which is the whole shape of the seam: the pipeline
 * derives the figure from the target list, so the number the v4 bytes commit to and the number of
 * relations the erasure was handed cannot disagree.
 *
 * One shared value so the addition reads as one decision, and so a test varying the model is
 * visibly varying it.
 */
const BOOT_RECORD_STORAGE: Omit<TombstoneRecordStorageDeclaration, "relationCount"> = {
  model: "typed_tables",
  schema: "public",
};

const RELATION_RE = /"([a-z_]+)"\."([a-z_]+)"/;

function relationOf(sql: string): string {
  const match = RELATION_RE.exec(sql);
  return match === null ? "" : `${match[1] ?? ""}.${match[2] ?? ""}`;
}

interface Harness {
  readonly conn: PgConnection;
  readonly store: PostgresTombstoneStore;
  readonly erase: SchemaEraserWithin;
  readonly sql: () => string[];
  readonly calls: { sql: string; params: readonly unknown[] }[];
}

function harness(
  erasureOver: Partial<Awaited<ReturnType<SchemaEraserWithin>>> = {},
  opts: {
    readonly insertThrows?: boolean;
    readonly eraseThrows?: boolean;
    /** Qualified shared table → rows the tenant holds there. */
    readonly sharedRows?: Readonly<Record<string, number>>;
    /** Qualified names the shared probe reports `row_security_active` for. */
    readonly confined?: readonly string[];
    /**
     * Qualified names the probe reports **no** `tenant_id` column for. Everything else answers
     * `scoped: true`, because the probe reads anything short of an affirmative yes as absent — so a
     * fake omitting the column refuses every target and asserts nothing about the real statement.
     */
    readonly unscoped?: readonly string[];
    /**
     * Qualified names the boot-schema census finds in the schemas the targets name — i.e. tables
     * this emitter plainly created. Anything here the target list does not claim is undeclared.
     */
    readonly bootSchemaCensus?: readonly string[];
    /**
     * Qualified table → rows a `count(*)` still sees. Drives both passes: the confirm-absence check
     * over the erasable tables (where a non-zero throws) and the statutory census (where a non-zero
     * is the retention being claimed).
     */
    readonly remaining?: Readonly<Record<string, number>>;
    /**
     * What `meta.tenants.status` holds, for the lifecycle event's `fromState`. `null` means the row
     * is absent, which is the refusal rather than a substituted state.
     */
    readonly tenantStatus?: string | null;
    readonly lifecycleInsertThrows?: boolean;
  } = {},
): Harness {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (
        opts.lifecycleInsertThrows === true &&
        sql.startsWith("INSERT INTO") &&
        sql.includes("tenant_lifecycle_events")
      ) {
        throw new Error("lifecycle insert exploded");
      }
      if (opts.insertThrows === true && sql.startsWith("INSERT INTO")) {
        throw new Error("insert exploded");
      }
      if (sql.startsWith("SELECT status FROM")) {
        const status = opts.tenantStatus;
        return status === undefined || status === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ status }], rowCount: 1 };
      }
      if (sql.includes("row_security_active")) {
        // Keyed on `schema.table`, because the target list spans the platform's schema and the one
        // the boot manifest's entity tables are served from.
        const probed = String(params?.[0] ?? "");
        const requested = (params?.[1] ?? []) as readonly string[];
        const rows = requested.map((name) => ({
          table_name: name,
          confined: (opts.confined ?? []).includes(`${probed}.${name}`),
          scoped: !(opts.unscoped ?? []).includes(`${probed}.${name}`),
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("p.polname = c.relname")) {
        const schemas = (params?.[0] ?? []) as readonly string[];
        const rows = (opts.bootSchemaCensus ?? [])
          .filter((q) => schemas.some((s) => q.startsWith(`${s}.`)))
          .map((qualified) => ({ qualified }));
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("WITH deleted AS (DELETE FROM")) {
        const n = opts.sharedRows?.[relationOf(sql)] ?? 0;
        return { rows: [{ n, bytes: n * 100 }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT count(*) AS n FROM")) {
        return { rows: [{ n: opts.remaining?.[relationOf(sql)] ?? 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      calls.push({ sql: "BEGIN", params: [] });
      try {
        const out = await fn(conn);
        calls.push({ sql: "COMMIT", params: [] });
        return out;
      } catch (err) {
        calls.push({ sql: "ROLLBACK", params: [] });
        throw err;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const anchorer: TombstoneAnchorer = {
    appendWithin: async (tx, input) => {
      await tx.query("-- chain append", [input.payload]);
      return { sequenceNumber: 42, entryHash: ENTRY_HASH };
    },
  };
  const erase: SchemaEraserWithin = async (tx) => {
    if (opts.eraseThrows === true) throw new Error("drop exploded");
    await tx.query("DROP SCHEMA \"t_abc\" CASCADE;");
    return {
      schema: "t_abc",
      erased: true,
      alreadyAbsent: false,
      refusals: [],
      erasedRelations: [
        { table: "account", rowCount: 1, storageBytes: 32768 },
        { table: "invoice", rowCount: 25, storageBytes: 32768 },
      ],
      rowCount: 26,
      storageBytes: 65536,
      erasedAt: AT,
      ...erasureOver,
    };
  };
  return {
    conn,
    store: new PostgresTombstoneStore(conn, anchorer),
    erase,
    calls,
    sql: () => calls.map((c) => c.sql),
  };
}

function inputOf(over: Partial<Parameters<typeof deleteTenantAtomically>[3]> = {}): Parameters<
  typeof deleteTenantAtomically
>[3] {
  return {
    tenantId: TENANT,
    tombstoneId: "tomb_pipeline0001",
    kind: "tenant_deletion",
    executedBy: ALICE,
    approvedBy: BOB,
    capabilities: CAPABILITIES,
    clock: () => new Date(AT),
    // Empty by default, so every pre-ADR-0350 assertion below pins exactly what it pinned. Empty is
    // what a `--store pg` deployment passes: its entity records are the catalogued
    // `meta.operate_entity_records`, which the shared erasure already reaches.
    bootSchema: bootSchemaOf([]),
    ...over,
  };
}

/**
 * The seam as one object, so a call site naming targets does not restate the cycle verdict.
 *
 * The three travel together because most of the pairings that can be formed apart are silently
 * wrong, and a helper defaulting the other two is the test-side version of that: no call site below
 * can accidentally omit the verdict and have the pipeline read `undefined` as "an order exists", or
 * omit the declaration and have the assembler refuse for a reason the test was not about.
 */
function bootSchemaOf(
  targets: readonly BootSchemaErasureTarget[],
  blockingCycle: readonly string[] = [],
  recordStorage: Omit<TombstoneRecordStorageDeclaration, "relationCount"> = BOOT_RECORD_STORAGE,
): BootSchemaDeletionInput {
  return { targets, blockingCycle, recordStorage };
}

const SHARED_ROWS = { "meta.operate_entity_records": 7, "meta.operate_sequences": 2 } as const;

/** What a `--store pg-columns` boot manifest hands over, join table first. */
const BOOT_TARGETS = [
  { schema: "public", table: "encounter" },
  { schema: "public", table: "patient" },
] as const;

describe("deleteTenantAtomically", () => {
  it("erases shared rows and the schema, attests, assembles, anchors and stores in ONE transaction", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    const order = h.sql();
    // One BEGIN: every destructive statement, the chain append and the insert share it, so the data
    // and its proof cannot disagree.
    expect(order.filter((s) => s === "BEGIN")).toHaveLength(1);
    const begin = order.indexOf("BEGIN");
    const probe = order.findIndex((s) => s.includes("row_security_active"));
    const sharedDelete = order.findIndex((s) => s.startsWith("WITH deleted AS (DELETE FROM"));
    const drop = order.findIndex((s) => s.startsWith("DROP SCHEMA"));
    const append = order.indexOf("-- chain append");
    const insert = order.findIndex((s) => s.startsWith("INSERT INTO"));
    const commit = order.indexOf("COMMIT");
    expect(begin).toBeLessThan(probe);
    expect(probe).toBeLessThan(sharedDelete);
    // The shared erasure runs first: all of its refusals land before it writes anything, which is
    // what keeps "a returned refusal means nothing was destroyed" true for both erasures.
    expect(sharedDelete).toBeLessThan(drop);
    expect(drop).toBeLessThan(append);
    expect(append).toBeLessThan(insert);
    expect(insert).toBeLessThan(commit);
  });

  it("never deletes from a retained table", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    for (const retained of RETAINED_SHARED_TABLES) {
      expect(h.sql().some((s) => s.includes(`DELETE FROM "meta"."${retained}"`))).toBe(false);
    }
  });

  it("produces a record anchored by the chain, not by the placeholder", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.record.anchors).toEqual([
      { kind: "internal_audit_log", reference: ENTRY_HASH, anchoredAt: AT },
    ]);
    expect(JSON.stringify(out.stored.record.anchors)).not.toContain("pending-chain-append");
    expect(isAnchoredByChain(out.stored)).toBe(true);
    expect(verifyTombstoneHashes(out.stored.record)).toEqual({
      contentManifestOk: true,
      proofOk: true,
    });
  });

  it("declares the subsystems it performs, derived from the attesters it actually has", () => {
    expect([...PIPELINE_PERFORMED_SUBSYSTEMS]).toEqual(["tenant_schema", "shared_tables"]);
  });

  it("refuses a caller's tenant_schema attestation rather than silently dropping it", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const lie: DeletionAttestation = {
      subsystem: "tenant_schema",
      outcome: "erased",
      scope: { schemas: ["t_abc"], tables: ["t_abc.account"], rowCount: 1, storageBytes: 1 },
      attestedBy: "a-caller-who-guessed",
      attestedAt: AT,
    };
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf({ attestations: [lie] }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals).toEqual([
      {
        stage: "input",
        reason: "performed_subsystem_attested",
        detail: expect.stringContaining("tenant_schema") as unknown as string,
      },
    ]);
    // Settled before the transaction opened, so not a single statement ran.
    expect(h.calls).toEqual([]);
  });

  it("refuses a caller's shared_tables attestation — the subsystem that had no protection at all", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const claim: DeletionAttestation = {
      subsystem: "shared_tables",
      outcome: "erased",
      scope: { tables: ["meta.operate_entity_records"], rowCount: 1, storageBytes: 1 },
      attestedBy: "a-caller-who-declared-erases",
      attestedAt: AT,
    };
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf({ attestations: [claim] }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual(["performed_subsystem_attested"]);
    expect(h.calls).toEqual([]);
  });

  it("refuses a declaration that calls a performed subsystem absent", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ capabilities: { ...CAPABILITIES, shared_tables: "absent" } }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The pipeline erases it whatever the declaration says, so a proof silent about it would be
    // ADR-0317's defect with a configuration file in front of it.
    expect(out.refusals).toEqual([
      {
        stage: "input",
        reason: "performed_subsystem_absent",
        detail: expect.stringContaining("shared_tables") as unknown as string,
      },
    ]);
    expect(h.calls).toEqual([]);
  });

  it("measures both scopes from its own erasures", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 26 from the tenant's own schema plus 9 from the shared tables, and the table list carries both
    // provenances without either subsystem naming the other's.
    expect(out.stored.record.scope.rowCount).toBe(35);
    expect(out.stored.record.scope.schemas).toEqual(["t_abc"]);
    expect(out.stored.record.scope.tables).toEqual([
      "meta.operate_entity_records",
      "meta.operate_sequences",
      "t_abc.account",
      "t_abc.invoice",
    ]);
  });

  it("attests shared_tables with the rows it actually deleted", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const shared = out.stored.attestations.find((a) => a.subsystem === "shared_tables");
    expect(shared?.outcome).toBe("erased");
    expect(shared?.scope).toEqual({
      // Deletion order — reverse catalog order — which is the order they were destroyed in. The
      // record's own `scope.tables` is sorted, because `composeDeletionScope` sorts it.
      tables: ["meta.operate_sequences", "meta.operate_entity_records"],
      rowCount: 9,
      storageBytes: 900,
    });
    expect(shared?.attestedBy).toContain(ALICE);
  });

  it("attests shared_tables as nothing to erase when the tenant held no shared rows", async () => {
    const h = harness();
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const shared = out.stored.attestations.find((a) => a.subsystem === "shared_tables");
    expect(shared?.outcome).toBe("nothing_to_erase");
    expect(shared?.scope).toBeUndefined();
  });

  it("completes a deletion whose only data was in the shared tables", async () => {
    const h = harness(
      { erased: false, alreadyAbsent: true, erasedRelations: [], rowCount: 0, storageBytes: 0 },
      { sharedRows: SHARED_ROWS },
    );
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    // Before the shared erasure existed this was a `scope_empty` abort: a tenant that never
    // activated a manifest had nothing erasable at all, while 112 tables held its rows.
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.record.scope.rowCount).toBe(9);
    expect(out.erasedSharedTables.rowCount).toBe(9);
  });

  it("refuses when another required subsystem did not attest, and destroys nothing", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const err = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ capabilities: { ...CAPABILITIES, object_storage: "erases", backups: "erases" } }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeletionPipelineAborted);
    const refusals = (err as DeletionPipelineAborted).refusals;
    expect(refusals.every((r) => r.stage === "assemble")).toBe(true);
    expect(refusals.map((r) => r.reason)).toContain("subsystem_unattested");
    // Destruction happened inside the transaction and must be undone: committing it would leave
    // destroyed data with no record of its destruction.
    expect(h.sql()).toContain("ROLLBACK");
    expect(h.sql().some((s) => s === "COMMIT")).toBe(false);
  });

  it("accepts another subsystem that attested it found nothing", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({
        capabilities: { ...CAPABILITIES, caches: "erases" },
        attestations: [
          { subsystem: "caches", outcome: "nothing_to_erase", attestedBy: "cache-op", attestedAt: AT },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.attestations).toHaveLength(3);
  });

  it("returns a shared-table refusal rather than throwing, since nothing was destroyed", async () => {
    const h = harness({}, { confined: ["meta.operate_entity_records"] });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals).toEqual([
      {
        stage: "erase",
        reason: "rls_would_confine_this_session",
        detail: expect.stringContaining("meta.operate_entity_records") as unknown as string,
      },
    ]);
    // Not one destructive statement, and the tenant's own schema was not even trial-dropped.
    expect(h.sql().some((s) => s.startsWith("WITH deleted AS"))).toBe(false);
    expect(h.sql().some((s) => s.startsWith("DROP SCHEMA"))).toBe(false);
    expect(h.sql().some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  it("aborts on a schema-erase refusal, because the shared deletes already ran", async () => {
    const h = harness(
      {
        erased: false,
        refusals: [{ reason: "external_dependents", detail: "would also drop view public.x" }],
        erasedRelations: [],
        rowCount: 0,
        storageBytes: 0,
      },
      { sharedRows: SHARED_ROWS },
    );
    const err = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeletionPipelineAborted);
    expect((err as DeletionPipelineAborted).refusals).toEqual([
      { stage: "erase", reason: "external_dependents", detail: "would also drop view public.x" },
    ]);
    expect(h.sql()).toContain("ROLLBACK");
    expect(h.sql().some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  it("rolls everything back when the insert fails", async () => {
    const h = harness({}, { insertThrows: true, sharedRows: SHARED_ROWS });
    await expect(deleteTenantAtomically(h.conn, h.store, h.erase, inputOf())).rejects.toThrow(
      /insert exploded/,
    );
    // The guarantee: no outcome destroys data without a stored tombstone describing it.
    expect(h.sql()).toContain("ROLLBACK");
    expect(h.sql().some((s) => s === "COMMIT")).toBe(false);
  });

  it("rolls back when the schema erase itself throws", async () => {
    const h = harness({}, { eraseThrows: true, sharedRows: SHARED_ROWS });
    await expect(deleteTenantAtomically(h.conn, h.store, h.erase, inputOf())).rejects.toThrow(
      /drop exploded/,
    );
    expect(h.sql()).toContain("ROLLBACK");
  });

  it("refuses four-eyes before destroying anything", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ approvedBy: ALICE }),
    );
    // The shared erasure checks it first, so it refuses rather than aborting — and nothing was
    // deleted, which is what makes a return correct here.
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual(["four_eyes_violated"]);
    expect(h.sql().some((s) => s.startsWith("WITH deleted AS"))).toBe(false);
  });

  it("still refuses a deletion with nothing to delete anywhere", async () => {
    const h = harness({
      erased: false,
      alreadyAbsent: true,
      refusals: [],
      erasedRelations: [],
      rowCount: 0,
      storageBytes: 0,
    });
    const err = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf()).catch(
      (e: unknown) => e,
    );
    // Nothing erased and nothing retained is not a deletion, and the assembler says so (ADR-0317).
    expect(err).toBeInstanceOf(DeletionPipelineAborted);
    expect((err as DeletionPipelineAborted).refusals.map((r) => r.reason)).toContain("scope_empty");
  });

  it("stores both performed attestations beside the record", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.attestations.map((a) => a.subsystem)).toEqual([
      "tenant_schema",
      "shared_tables",
    ]);
    expect(out.stored.attestations.every((a) => a.attestedBy.includes(ALICE))).toBe(true);
  });

  it("reports what it destroyed on both sides, schema-qualified", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.erased).toEqual({
      schema: "t_abc",
      tables: ["t_abc.account", "t_abc.invoice"],
      rowCount: 26,
      storageBytes: 65536,
      alreadyAbsent: false,
    });
    expect(out.erasedSharedTables.schema).toBe("meta");
    expect(out.erasedSharedTables.tables).toEqual([
      "meta.operate_sequences",
      "meta.operate_entity_records",
    ]);
    expect(out.erasedSharedTables.rowCount).toBe(9);
    // Coverage, which the scope deliberately does not carry: 97 of the catalog's 115 tenant-scoped
    // tables examined, 18 left — 16 as the platform's record of the deletion and 2 under a statutory
    // obligation. The 97th is ADR-0347's `meta.tenant_data_keys`: the wrapped per-tenant column key
    // is a tenant's row like any other, so the erasure that already walks this set destroys it, and
    // the crypto-shred is a consequence of the existing pipeline rather than a new step in it.
    expect(out.erasedSharedTables.examinedTables).toHaveLength(97);
    expect(out.erasedSharedTables.retainedTables).toHaveLength(RETAINED_SHARED_TABLES.length);
  });

  it("routes the shared erasure at the schema it is told to", async () => {
    const h = harness({}, { sharedRows: { "platform.operate_entity_records": 4 } });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ schema: "platform" }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.erasedSharedTables.tables).toEqual(["platform.operate_entity_records"]);
  });

  /**
   * The combined claim reaching the stored proof: `shared_tables` destroys most of the catalog's
   * tenant-scoped tables and lawfully keeps the statutory ones, and since the fourth outcome exists
   * the tombstone says both in one attestation with one provenance.
   */
  it("attests erased_and_retained when the statutory tables still hold rows", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, remaining: { "meta.invoices": 3 } });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const shared = out.stored.attestations.find((a) => a.subsystem === "shared_tables");
    expect(shared?.outcome).toBe("erased_and_retained");
    expect(shared?.retainedObligations).toEqual(["tax_records_7y"]);
    expect(shared?.retainedDataReference).toBe("meta.invoices");
    // The figures are still only what was destroyed, and the record's scope still verifies.
    expect(shared?.scope?.rowCount).toBe(9);
    expect(verifyTombstoneHashes(out.stored.record)).toEqual({
      contentManifestOk: true,
      proofOk: true,
    });
  });

  it("derives the record's retention prose from that attestation rather than a caller", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, remaining: { "meta.invoices": 3 } });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.record.retainedReason).toBe(
      "retained under legal obligation — shared_tables: tax_records_7y",
    );
    expect(out.stored.record.retainedDataReference).toBe("meta.invoices");
  });

  it("attests plain erased when the tenant held nothing under an obligation", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const shared = out.stored.attestations.find((a) => a.subsystem === "shared_tables");
    expect(shared?.outcome).toBe("erased");
    expect(out.stored.record.retainedReason).toBeUndefined();
  });

  it("reports the lawful retention on the outcome, as obligations and a pointer", async () => {
    const h = harness(
      {},
      { sharedRows: SHARED_ROWS, remaining: { "meta.invoices": 3, "meta.tenant_credits": 1 } },
    );
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.erasedSharedTables.statutoryRetained).toEqual({
      obligations: ["tax_records_7y"],
      dataReference: "meta.invoices, meta.tenant_credits",
    });
    // No count: the figures in a proof describe what was destroyed, and the 200 body obeys the
    // same rule the attestation does.
    expect(Object.keys(out.erasedSharedTables.statutoryRetained ?? {}).sort()).toEqual([
      "dataReference",
      "obligations",
    ]);
  });

  it("reports null rather than an empty retention when nothing is kept", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.erasedSharedTables.statutoryRetained).toBeNull();
  });

  it("declares its four stages", () => {
    expect([...PIPELINE_REFUSAL_STAGES]).toEqual(["input", "erase", "assemble", "store"]);
  });
});

/**
 * The boot manifest's own entity tables, which until ADR-0350 nothing erased on
 * `--store pg-columns` — `shared_tables` reached `meta.*` alone and the schema erasure only ever
 * drops a `t_<hex>` schema a boot-manifest tenant does not have, so both subsystems attested
 * truthfully and the proof was signed over records still on disk.
 */
describe("the boot-schema target seam", () => {
  it("erases them and names them in the stored proof's scope", async () => {
    const h = harness({}, { sharedRows: { ...SHARED_ROWS, "public.patient": 1 } });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.record.scope.tables).toContain("public.patient");
    expect(out.stored.record.scope.rowCount).toBe(36);
    // And the proof still verifies over the widened scope, which is the whole point: the figures
    // the digest commits to are now figures about data that is actually gone.
    expect(verifyTombstoneHashes(out.stored.record)).toEqual({
      contentManifestOk: true,
      proofOk: true,
    });
  });

  it("keeps one shared_tables attestation, folding both groups' figures into it", async () => {
    const h = harness({}, { sharedRows: { ...SHARED_ROWS, "public.patient": 1 } });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // One subsystem doing what its vocabulary always said, so `duplicate_attestation` is never in
    // play and `ATTESTERS` stays at two keys.
    const shared = out.stored.attestations.filter((a) => a.subsystem === "shared_tables");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.outcome).toBe("erased");
    expect(shared[0]?.scope).toEqual({
      tables: ["public.patient", "meta.operate_sequences", "meta.operate_entity_records"],
      rowCount: 10,
      storageBytes: 1000,
    });
    expect([...PIPELINE_PERFORMED_SUBSYSTEMS]).toEqual(["tenant_schema", "shared_tables"]);
  });

  it("deletes the tenant's own records before the catalogued rows and before the DROP", async () => {
    const h = harness({}, { sharedRows: { "public.patient": 1, ...SHARED_ROWS } });
    await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    const deleted = h.calls
      .filter((c) => c.sql.startsWith("WITH deleted AS (DELETE FROM"))
      .map((c) => relationOf(c.sql));
    expect(deleted.slice(0, 2)).toEqual(["public.encounter", "public.patient"]);
    const drop = h.sql().findIndex((s) => s.startsWith("DROP SCHEMA"));
    const lastSharedDelete = h
      .sql()
      .reduce((acc, s, i) => (s.startsWith("WITH deleted AS") ? i : acc), -1);
    expect(drop).toBeGreaterThan(lastSharedDelete);
  });

  it("completes a deletion whose only data was in the boot manifest's own tables", async () => {
    // The reproduced defect, from the other side: a `pg-columns` boot-manifest tenant has no
    // `t_<hex>` schema, so `tenant_schema` attests `nothing_to_erase` and these tables are the only
    // place the tenant's records ever were.
    const h = harness(
      { erased: false, alreadyAbsent: true, erasedRelations: [], rowCount: 0, storageBytes: 0 },
      { sharedRows: { "public.patient": 42 } },
    );
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.record.scope).toMatchObject({ tables: ["public.patient"], rowCount: 42 });
    const tenantSchema = out.stored.attestations.find((a) => a.subsystem === "tenant_schema");
    expect(tenantSchema?.outcome).toBe("nothing_to_erase");
  });

  it("returns a refusal — destroying nothing — when a boot target is confined by RLS", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, confined: ["public.patient"] });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual(["rls_would_confine_this_session"]);
    expect(out.refusals[0]?.detail).toContain("public.patient");
    // One refusal pass over the merged list, so the catalogued half was not touched either.
    expect(h.sql().some((s) => s.startsWith("WITH deleted AS"))).toBe(false);
    expect(h.sql().some((s) => s.startsWith("DROP SCHEMA"))).toBe(false);
    expect(h.sql().some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  it("returns a refusal when a boot target collides with a catalogued table", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf([{ schema: "meta", table: "audit_log" }]) }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual(["target_collides_with_catalog"]);
    // Settled before the probe, so not one statement of either erasure ran.
    expect(h.sql().some((s) => s.includes("row_security_active"))).toBe(false);
    expect(h.sql().some((s) => s.startsWith("WITH deleted AS"))).toBe(false);
  });

  it("reports the boot targets as coverage beside the catalogued ones", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 97 catalogued plus the two handed over, in deletion order — the only list in which a boot
    // target this tenant had no rows in is visible at all.
    expect(out.erasedSharedTables.examinedTables).toHaveLength(99);
    expect(out.erasedSharedTables.examinedTables.slice(0, 2)).toEqual([
      "public.encounter",
      "public.patient",
    ]);
  });

  it("threads the target list through verbatim, in the order the caller handed it over", async () => {
    // Deliberately neither sorted nor reverse-sorted: the group arrives in the order its own
    // delete-blocking references require, and nothing between the caller and the DELETE may resort
    // it — the catalogued half's reverse-catalog order is not a rule this group shares.
    const targets: readonly BootSchemaErasureTarget[] = [
      { schema: "public", table: "visit_participant" },
      { schema: "public", table: "encounter" },
      { schema: "public", table: "patient" },
    ];
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(targets) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const deleted = h.calls
      .filter((c) => c.sql.startsWith("WITH deleted AS (DELETE FROM"))
      .map((c) => relationOf(c.sql));
    expect(deleted.slice(0, 3)).toEqual([
      "public.visit_participant",
      "public.encounter",
      "public.patient",
    ]);
    // The one statement that sees the whole group before anything is destroyed saw the same list:
    // a probe over a different set than the DELETEs would be a refusal pass about other rows.
    const probe = h.calls.find(
      (c) => c.sql.includes("row_security_active") && c.params[0] === "public",
    );
    expect(probe?.params[1]).toEqual(["visit_participant", "encounter", "patient"]);
    expect(out.erasedSharedTables.examinedTables.slice(0, 3)).toEqual([
      "public.visit_participant",
      "public.encounter",
      "public.patient",
    ]);
  });

  it("refuses an unrunnable order without reaching the schema eraser at all", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    let eraserCalls = 0;
    const erase: SchemaEraserWithin = async (tx, tenantId, authority) => {
      eraserCalls += 1;
      return h.erase(tx, tenantId, authority);
    };
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS, ["Encounter", "Patient"]) }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals).toEqual([
      {
        // `erase` and not `input`: the verdict is the erasure's own, about its own target list.
        stage: "erase",
        reason: "boot_schema_order_unrunnable",
        detail: expect.stringContaining("Encounter, Patient") as unknown as string,
      },
    ]);
    // The load-bearing part. The shared erasure runs first and this is one of its cheap refusals,
    // so the tenant's schema is not dropped even provisionally inside the rollback — the seam was
    // never called, which is a stronger claim than a `DROP SCHEMA` that was undone.
    expect(eraserCalls).toBe(0);
    // And not one statement of either erasure ran: a cheap refusal needs no database, so the
    // transaction opens, decides, and commits having destroyed nothing. It is a *return* and not a
    // throw — an exception here would be indistinguishable from an unknown failure, which ADR-0321's
    // runner files `aborted` and leaves `in_progress`, where a deterministic refusal is `rejected`
    // with the remedy named.
    expect(h.sql()).toEqual(["BEGIN", "COMMIT"]);
  });

  it("returns a refusal — destroying nothing — when a boot target has no tenant_id column", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, unscoped: ["public.patient"] });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual(["target_lacks_tenant_scope"]);
    expect(out.refusals[0]?.detail).toContain("public.patient");
    // Every statement this erasure issues scopes by that column, so the DELETE would have raised
    // partway through — rolling the data back and stranding the request. Established by the probe
    // instead, which is why the catalogued half was not touched either.
    expect(h.sql().some((s) => s.startsWith("WITH deleted AS"))).toBe(false);
    expect(h.sql().some((s) => s.startsWith("DROP SCHEMA"))).toBe(false);
    expect(h.sql().some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  it("returns a refusal when the boot schema holds a table the manifest no longer declares", async () => {
    // The original defect's own shape, one manifest later: a previous manifest's entity table
    // survives, the derived target list cannot name it, and nothing would examine it. Refused
    // rather than reported, because the alternative here is signing a proof over live records.
    const h = harness(
      {},
      {
        sharedRows: SHARED_ROWS,
        bootSchemaCensus: ["public.encounter", "public.legacy_appointment", "public.patient"],
      },
    );
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual(["boot_schema_table_undeclared"]);
    expect(out.refusals[0]?.detail).toContain("public.legacy_appointment");
    // The two tables the list does claim are not findings.
    expect(out.refusals[0]?.detail).not.toContain("public.patient");
    expect(h.sql().some((s) => s.startsWith("WITH deleted AS"))).toBe(false);
    expect(h.sql().some((s) => s.startsWith("DROP SCHEMA"))).toBe(false);
  });

  it("changes no outcome when the group is empty, and censuses no schema for it", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf([]) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Identical to what a deployment with no entity tables of its own always got: 97 catalogued
    // tables examined and a scope naming only the catalogued rows and the dropped schema's.
    expect(out.erasedSharedTables.examinedTables).toHaveLength(97);
    expect(out.stored.record.scope.tables).toEqual([
      "meta.operate_entity_records",
      "meta.operate_sequences",
      "t_abc.account",
      "t_abc.invoice",
    ]);
    expect(verifyTombstoneHashes(out.stored.record)).toEqual({
      contentManifestOk: true,
      proofOk: true,
    });
    // An empty group names no schema, so the undeclared-table census is not asked rather than
    // asked and empty — the detector's stated limit: a deployment that moved off `--store
    // pg-columns` passes `[]` and still has those tables on disk.
    expect(h.sql().some((s) => s.includes("pg_policy"))).toBe(false);
    // The negative control, so the assertion above cannot pass because nothing ever censuses.
    const named = harness({}, { sharedRows: SHARED_ROWS });
    await deleteTenantAtomically(
      named.conn,
      named.store,
      named.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    expect(named.sql().some((s) => s.includes("pg_policy"))).toBe(true);
  });
});

/**
 * The record-storage declaration the v4 bytes sign (ADR-0351).
 *
 * ADR-0350 made the target list a required parameter, so "nobody looked" became unrepresentable in
 * the code — and a stored proof still could not tell a deployment with no typed relations from one
 * whose list came out empty, because both compose byte-identical bytes. `relationCount` is what
 * separates them, which is why the pipeline derives it rather than accepting it.
 */
describe("the record-storage declaration", () => {
  it("derives a relation count of zero from an empty target list", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf([]) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // `typed_tables` counting zero is the third case the version exists to express — a column store
    // serving a manifest that declares no entity — and a claim rather than a placeholder.
    expect(out.stored.record.recordStorage).toEqual({
      model: "typed_tables",
      schema: "public",
      relationCount: 0,
    });
    expect(verifyTombstoneHashes(out.stored.record)).toEqual({
      contentManifestOk: true,
      proofOk: true,
    });
  });

  it("derives the count from the list the erasure was handed, for a group of three", async () => {
    // The figure the digest commits to is the number of relations this deletion actually targeted.
    // A caller-supplied count could disagree with it — and a proof whose count is larger than the
    // list says the erasure left relations alone, which is exactly the claim ADR-0350's gap made.
    const targets: readonly BootSchemaErasureTarget[] = [
      { schema: "public", table: "visit_participant" },
      { schema: "public", table: "encounter" },
      { schema: "public", table: "patient" },
    ];
    const h = harness({}, { sharedRows: { ...SHARED_ROWS, "public.patient": 1 } });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(targets) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.record.recordStorage?.relationCount).toBe(3);
    expect(out.stored.record.recordStorage?.relationCount).toBe(targets.length);
  });

  it("signs it as v4, and the proof reads back as covering it", async () => {
    const h = harness({}, { sharedRows: { ...SHARED_ROWS, "public.patient": 1 } });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ bootSchema: bootSchemaOf(BOOT_TARGETS) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.record.proofVersion).toBe("v4");
    expect(readRecordStorage(out.stored.record)).toEqual({
      declarationState: "covered_by_proof",
      recordStorage: { model: "typed_tables", schema: "public", relationCount: 2 },
    });
  });

  it("hands the erasure only the targets and the order verdict, not the storage model", async () => {
    // The erasure has no use for what the proof *says* about a group and must not start reading it:
    // which relations to empty is a different question from how to describe them. A declaration
    // naming a schema no target is in makes the separation observable — if the value reached the
    // erasure and it probed or censused by it, a statement before the proof would name it.
    const h = harness({}, { sharedRows: { ...SHARED_ROWS, "public.patient": 1 } });
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({
        bootSchema: bootSchemaOf(BOOT_TARGETS, [], {
          model: "typed_tables",
          schema: "declared_in_the_proof_only",
        }),
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const insertAt = h.sql().findIndex((s) => s.includes("tenant_tombstones"));
    expect(insertAt).toBeGreaterThan(0);
    const beforeTheProof = h.calls
      .slice(0, insertAt)
      .map((c) => `${c.sql} ${JSON.stringify(c.params)}`)
      .join("\n");
    expect(beforeTheProof).not.toContain("declared_in_the_proof_only");
    expect(beforeTheProof).not.toContain("typed_tables");
    // The positive control, so the two assertions above cannot pass because the value went nowhere.
    expect(out.stored.record.recordStorage?.schema).toBe("declared_in_the_proof_only");
  });

  it("aborts when the declared model cannot hold the derived count", async () => {
    // The one incoherence deriving the figure cannot prevent: `document_rows` asserts there are no
    // typed per-entity relations, and a non-empty target list is 54 relations this deletion is
    // about to empty. The declaration schema refuses it, the assembler reports
    // `record_storage_invalid`, and because the erasure has already run it throws rather than
    // returning — so nothing is committed.
    const h = harness({}, { sharedRows: { ...SHARED_ROWS, "public.patient": 1 } });
    const err = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({
        bootSchema: bootSchemaOf(BOOT_TARGETS, [], { model: "document_rows", schema: null }),
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeletionPipelineAborted);
    const refusals = (err as DeletionPipelineAborted).refusals;
    expect(refusals.map((r) => r.reason)).toEqual(["record_storage_invalid"]);
    expect(refusals[0]?.stage).toBe("assemble");
    expect(refusals[0]?.detail).toContain("relationCount");
    expect(h.sql()).toContain("ROLLBACK");
    expect(h.sql().some((s) => s === "COMMIT")).toBe(false);
    // And the erasure got on with its job regardless, which is the separation the test above pins
    // read from the other side: an incoherent declaration did not stop it emptying a single row.
    expect(h.sql().some((s) => s.startsWith("WITH deleted AS (DELETE FROM"))).toBe(true);
  });
});

describe("isAnchoredByChain", () => {
  it("is false for a record whose anchors do not name its chain entry", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(isAnchoredByChain({ ...out.stored, chainEntryHash: null })).toBe(false);
    expect(isAnchoredByChain({ ...out.stored, chainEntryHash: "e".repeat(64) })).toBe(false);
  });
});

/**
 * The `… -> deleted` transition, written inside the same transaction as the erasure and the proof.
 *
 * What these pin is the *ordering*, which is the load-bearing part: the state is read before the
 * first destructive statement (so an unresolvable one is a returned refusal), and the event is
 * appended after the tombstone (so a trail never points at a proof the assembler refused).
 */
describe("the lifecycle event", () => {
  const LIFECYCLE_EVENT_ID = "0193a0f1-9999-7888-8777-666655554444";

  function lifecycleOf(
    store: PostgresLifecycleEventStore,
    over: Record<string, unknown> = {},
  ): NonNullable<Parameters<typeof deleteTenantAtomically>[3]["lifecycle"]> {
    return {
      store,
      eventId: LIFECYCLE_EVENT_ID,
      trigger: "customer_request",
      reason: "article 17 right to erasure",
      ...over,
    } as NonNullable<Parameters<typeof deleteTenantAtomically>[3]["lifecycle"]>;
  }

  it("is not written when no lifecycle block is supplied, and says so", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Reported rather than assumed: a trail that is silently not written is indistinguishable from
    // a tenant that never existed, which is this table's whole purpose.
    expect(out.lifecycleEvent).toBeNull();
    expect(h.sql().some((s) => s.includes("tenant_lifecycle_events"))).toBe(false);
  });

  it("records the transition with fromState read from meta.tenants", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, tenantStatus: "pending_deletion" });
    const events = new PostgresLifecycleEventStore(h.conn);
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ lifecycle: lifecycleOf(events) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lifecycleEvent).toEqual({
      id: LIFECYCLE_EVENT_ID,
      fromState: "pending_deletion",
      toState: "deleted",
      transitionLegal: true,
    });
  });

  it("reads the tenant state before the first destructive statement", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, tenantStatus: "pending_deletion" });
    const events = new PostgresLifecycleEventStore(h.conn);
    await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ lifecycle: lifecycleOf(events) }),
    );
    const statusAt = h.sql().findIndex((s) => s.startsWith("SELECT status FROM"));
    const firstDelete = h.sql().findIndex((s) => s.startsWith("WITH deleted AS (DELETE FROM"));
    expect(statusAt).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeGreaterThan(statusAt);
  });

  it("appends the event after the tombstone, in the same transaction", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, tenantStatus: "pending_deletion" });
    const events = new PostgresLifecycleEventStore(h.conn);
    await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ lifecycle: lifecycleOf(events) }),
    );
    const sql = h.sql();
    const tombstoneAt = sql.findIndex((s) => s.includes("tenant_tombstones"));
    const eventAt = sql.findIndex((s) => s.includes("tenant_lifecycle_events"));
    expect(tombstoneAt).toBeGreaterThanOrEqual(0);
    expect(eventAt).toBeGreaterThan(tombstoneAt);
    // One transaction, and it committed.
    expect(sql.filter((s) => s === "BEGIN")).toHaveLength(1);
    expect(sql[sql.length - 1]).toBe("COMMIT");
  });

  it("returns a refusal — destroying nothing — when the tenant row is absent", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, tenantStatus: null });
    const events = new PostgresLifecycleEventStore(h.conn);
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ lifecycle: lifecycleOf(events) }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals[0]?.stage).toBe("input");
    expect(out.refusals[0]?.reason).toBe("tenant_state_unresolvable");
    // The refusal is a *return*, so nothing was deleted and nothing was dropped.
    expect(h.sql().some((s) => s.startsWith("WITH deleted AS (DELETE FROM"))).toBe(false);
    expect(h.sql().some((s) => s.startsWith("DROP SCHEMA"))).toBe(false);
  });

  it("flags active -> deleted as an illegal transition and records it anyway", async () => {
    // The synchronous deletion route still deletes straight from `active`: ADR-0334 moved the
    // tenant to `pending_deletion` on the asynchronous route's verify only. Recording it silently
    // would hide the gap; refusing it would drop the only record of a deletion that happened.
    const h = harness({}, { sharedRows: SHARED_ROWS, tenantStatus: "active" });
    const events = new PostgresLifecycleEventStore(h.conn);
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ lifecycle: lifecycleOf(events) }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lifecycleEvent?.fromState).toBe("active");
    expect(out.lifecycleEvent?.transitionLegal).toBe(false);
    expect(h.sql().some((s) => s.includes("tenant_lifecycle_events"))).toBe(true);
  });

  it("rolls the whole deletion back when the event cannot be written", async () => {
    // The opposite of ADR-0320's `tenantRetired: false`: nothing has committed yet, so a failed
    // append must not leave a destruction whose trail the caller was told would exist.
    const h = harness(
      {},
      { sharedRows: SHARED_ROWS, tenantStatus: "pending_deletion", lifecycleInsertThrows: true },
    );
    const events = new PostgresLifecycleEventStore(h.conn);
    await expect(
      deleteTenantAtomically(h.conn, h.store, h.erase, inputOf({ lifecycle: lifecycleOf(events) })),
    ).rejects.toThrow(/lifecycle insert exploded/);
    expect(h.sql()).toContain("ROLLBACK");
    expect(h.sql()).not.toContain("COMMIT");
  });

  it("carries the executor and the approver, which the tombstone store already forced to differ", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, tenantStatus: "pending_deletion" });
    const events = new PostgresLifecycleEventStore(h.conn);
    await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ lifecycle: lifecycleOf(events) }),
    );
    const insert = h.calls.find(
      (c) => c.sql.startsWith("INSERT INTO") && c.sql.includes("tenant_lifecycle_events"),
    );
    expect(insert?.params).toContain(ALICE);
    expect(insert?.params).toContain(BOB);
    // `execute_deletion` always requires four-eyes approval, by contract.
    expect(insert?.params).toContain(true);
  });

  it("refuses the whole deletion when the event id is not a uuid", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, tenantStatus: "pending_deletion" });
    const events = new PostgresLifecycleEventStore(h.conn);
    await expect(
      deleteTenantAtomically(
        h.conn,
        h.store,
        h.erase,
        inputOf({ lifecycle: lifecycleOf(events, { eventId: "evt_1" }) }),
      ),
    ).rejects.toThrow(/must be a uuid/);
    expect(h.sql()).toContain("ROLLBACK");
  });

  it("requires an incident id for a protected trigger, and refuses without one", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, tenantStatus: "pending_deletion" });
    const events = new PostgresLifecycleEventStore(h.conn);
    await expect(
      deleteTenantAtomically(
        h.conn,
        h.store,
        h.erase,
        inputOf({ lifecycle: lifecycleOf(events, { trigger: "compliance_directive" }) }),
      ),
    ).rejects.toThrow(/relatedIncidentId/);
  });

  it("accepts a protected trigger that names its incident", async () => {
    const h = harness({}, { sharedRows: SHARED_ROWS, tenantStatus: "pending_deletion" });
    const events = new PostgresLifecycleEventStore(h.conn);
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({
        lifecycle: lifecycleOf(events, {
          trigger: "compliance_directive",
          relatedIncidentId: "INC-2026-0042",
        }),
      }),
    );
    expect(out.ok).toBe(true);
  });
});
