import type { PgConnection } from "@crossengin/kernel-pg";
import { verifyTombstoneHashes, type DeletionAttestation } from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  DeletionPipelineAborted,
  PIPELINE_REFUSAL_STAGES,
  deleteTenantAtomically,
  isAnchoredByChain,
  type SchemaEraserWithin,
} from "./deletion-pipeline.js";
import { PostgresTombstoneStore, type TombstoneAnchorer } from "./tombstone-store.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const AT = "2026-10-03T13:00:00.000Z";
const ENTRY_HASH = "d".repeat(64);
const ALICE = "alice@example.test";
const BOB = "bob@example.test";

interface Harness {
  readonly conn: PgConnection;
  readonly store: PostgresTombstoneStore;
  readonly erase: SchemaEraserWithin;
  readonly sql: () => string[];
  readonly calls: { sql: string; params: readonly unknown[] }[];
}

function harness(
  erasureOver: Partial<Awaited<ReturnType<SchemaEraserWithin>>> = {},
  opts: { readonly insertThrows?: boolean; readonly eraseThrows?: boolean } = {},
): Harness {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (opts.insertThrows === true && sql.startsWith("INSERT INTO")) {
        throw new Error("insert exploded");
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
    requiredSubsystems: [],
    clock: () => new Date(AT),
    ...over,
  };
}

describe("deleteTenantAtomically", () => {
  it("erases, attests, assembles, anchors and stores in ONE transaction", async () => {
    const h = harness();
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    const order = h.sql();
    // One BEGIN: the drop, the chain append and the insert share it, so the data and its proof
    // cannot disagree.
    expect(order.filter((s) => s === "BEGIN")).toHaveLength(1);
    const begin = order.indexOf("BEGIN");
    const drop = order.findIndex((s) => s.startsWith("DROP SCHEMA"));
    const append = order.indexOf("-- chain append");
    const insert = order.findIndex((s) => s.startsWith("INSERT INTO"));
    const commit = order.indexOf("COMMIT");
    expect(begin).toBeLessThan(drop);
    expect(drop).toBeLessThan(append);
    expect(append).toBeLessThan(insert);
    expect(insert).toBeLessThan(commit);
  });

  it("produces a record anchored by the chain, not by the placeholder", async () => {
    const h = harness();
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

  it("measures the scope from its own erasure, not from a caller's claim", async () => {
    const h = harness();
    const lie: DeletionAttestation = {
      subsystem: "tenant_schema",
      outcome: "erased",
      scope: { schemas: ["t_abc"], tables: ["t_abc.account"], rowCount: 1, storageBytes: 1 },
      attestedBy: "a-caller-who-guessed",
      attestedAt: AT,
    };
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ attestations: [lie] }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // An attestation about work this transaction is about to do is a prediction, not evidence.
    expect(out.stored.record.scope.rowCount).toBe(26);
    expect(out.stored.record.scope.tables).toEqual(["t_abc.account", "t_abc.invoice"]);
    expect(out.stored.attestations.some((a) => a.attestedBy === "a-caller-who-guessed")).toBe(false);
  });

  it("always covers tenant_schema, even when the caller leaves it out", async () => {
    const h = harness();
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf({ requiredSubsystems: [] }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.record.scope.schemas).toEqual(["t_abc"]);
  });

  it("refuses when another required subsystem did not attest, and drops nothing", async () => {
    const h = harness();
    const err = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ requiredSubsystems: ["object_storage", "backups"] }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeletionPipelineAborted);
    const refusals = (err as DeletionPipelineAborted).refusals;
    expect(refusals.every((r) => r.stage === "assemble")).toBe(true);
    expect(refusals.map((r) => r.reason)).toContain("subsystem_unattested");
    // The drop happened inside the transaction and must be undone: committing it would leave a
    // destroyed schema with no record of its destruction.
    expect(h.sql()).toContain("ROLLBACK");
    expect(h.sql().some((s) => s === "COMMIT")).toBe(false);
  });

  it("accepts another subsystem that attested it found nothing", async () => {
    const h = harness();
    const out = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({
        requiredSubsystems: ["caches"],
        attestations: [
          { subsystem: "caches", outcome: "nothing_to_erase", attestedBy: "cache-op", attestedAt: AT },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.attestations).toHaveLength(2);
  });

  it("returns an erase refusal rather than throwing, since nothing was dropped", async () => {
    const h = harness({
      erased: false,
      refusals: [{ reason: "external_dependents", detail: "would also drop view public.x" }],
      erasedRelations: [],
      rowCount: 0,
      storageBytes: 0,
    });
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals).toEqual([
      { stage: "erase", reason: "external_dependents", detail: "would also drop view public.x" },
    ]);
    expect(h.sql().some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });

  it("rolls the drop back when the insert fails", async () => {
    const h = harness({}, { insertThrows: true });
    await expect(deleteTenantAtomically(h.conn, h.store, h.erase, inputOf())).rejects.toThrow(
      /insert exploded/,
    );
    // The guarantee: no outcome destroys data without a stored tombstone describing it.
    expect(h.sql()).toContain("ROLLBACK");
    expect(h.sql().some((s) => s === "COMMIT")).toBe(false);
  });

  it("rolls back when the erase itself throws", async () => {
    const h = harness({}, { eraseThrows: true });
    await expect(deleteTenantAtomically(h.conn, h.store, h.erase, inputOf())).rejects.toThrow(
      /drop exploded/,
    );
    expect(h.sql()).toContain("ROLLBACK");
  });

  it("refuses four-eyes before dropping anything", async () => {
    const h = harness();
    const err = await deleteTenantAtomically(
      h.conn,
      h.store,
      h.erase,
      inputOf({ approvedBy: ALICE }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeletionPipelineAborted);
    expect((err as DeletionPipelineAborted).refusals.map((r) => r.reason)).toContain(
      "four_eyes_violated",
    );
  });

  it("reports an already-absent schema as nothing erased, and still refuses an empty deletion", async () => {
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

  it("stores the attestations beside the record", async () => {
    const h = harness();
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stored.attestations).toHaveLength(1);
    expect(out.stored.attestations[0]?.subsystem).toBe("tenant_schema");
    expect(out.stored.attestations[0]?.attestedBy).toContain(ALICE);
  });

  it("reports what it destroyed, schema-qualified", async () => {
    const h = harness();
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
  });

  it("declares its three stages", () => {
    expect([...PIPELINE_REFUSAL_STAGES]).toEqual(["erase", "assemble", "store"]);
  });
});

describe("isAnchoredByChain", () => {
  it("is false for a record whose anchors do not name its chain entry", async () => {
    const h = harness();
    const out = await deleteTenantAtomically(h.conn, h.store, h.erase, inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(isAnchoredByChain({ ...out.stored, chainEntryHash: null })).toBe(false);
    expect(isAnchoredByChain({ ...out.stored, chainEntryHash: "e".repeat(64) })).toBe(false);
  });
});
