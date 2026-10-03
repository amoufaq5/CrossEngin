import type { PgConnection } from "@crossengin/kernel-pg";
import {
  assembleTombstone,
  verifyTombstoneHashes,
  type DeletionAttestation,
  type TombstoneRecord,
} from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  PostgresTombstoneStore,
  TOMBSTONE_COLUMNS,
  TOMBSTONE_LOG_KIND,
  TOMBSTONE_WRITE_REFUSALS,
  TombstoneWriteRefused,
  rowToStoredTombstone,
  tombstoneChainPayload,
  type TombstoneAnchorer,
} from "./tombstone-store.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const AT = "2026-10-03T12:00:00.000Z";
const ENTRY_HASH = "a".repeat(64);

const ATTESTATION: DeletionAttestation = {
  subsystem: "tenant_schema",
  outcome: "erased",
  scope: { schemas: ["t_abc"], tables: ["t_abc.invoice"], rowCount: 26, storageBytes: 65536 },
  attestedBy: "operate-server/tenant-erasure",
  attestedAt: AT,
};

/** A real record, assembled the way production does, so the hashes are genuine. */
function recordOf(over: Partial<TombstoneRecord> = {}): TombstoneRecord {
  const out = assembleTombstone({
    id: "tomb_store0001abc",
    kind: "tenant_deletion",
    tenantId: TENANT,
    deletedAt: AT,
    executedBy: "alice@example.test",
    approvedBy: "bob@example.test",
    anchors: [{ kind: "rfc3161_timestamp", reference: "caller-chose-this", anchoredAt: AT }],
    requiredSubsystems: ["tenant_schema"],
    attestations: [ATTESTATION],
  });
  if (!out.ok) throw new Error(`fixture failed: ${JSON.stringify(out.refusals)}`);
  return { ...out.record, ...over };
}

interface Fake {
  readonly conn: PgConnection;
  readonly calls: { sql: string; params: readonly unknown[] }[];
  readonly anchorer: TombstoneAnchorer;
  readonly appended: Array<{ tenantId: string | null; kind: string; payload: string }>;
  readonly sql: () => string[];
}

function fakePg(rows: readonly Record<string, unknown>[] = []): Fake {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const appended: Array<{ tenantId: string | null; kind: string; payload: string }> = [];
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.startsWith("SELECT")) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      calls.push({ sql: "BEGIN", params: [] });
      const out = await fn(conn);
      calls.push({ sql: "COMMIT", params: [] });
      return out;
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const anchorer: TombstoneAnchorer = {
    appendWithin: async (tx, input) => {
      // Recorded through the same connection so ordering against the INSERT is observable.
      await tx.query("-- chain append", [input.payload]);
      appended.push({ tenantId: input.tenantId, kind: input.kind, payload: input.payload });
      return { sequenceNumber: 7, entryHash: ENTRY_HASH };
    },
  };
  return { conn, calls, anchorer, appended, sql: () => calls.map((c) => c.sql) };
}

function rowOf(record: TombstoneRecord, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tombstone_id: record.id,
    kind: record.kind,
    tenant_id: record.tenantId,
    subject_identifier: null,
    related_deletion_request_id: null,
    deleted_at: record.deletedAt,
    executed_by: record.executedBy,
    approved_by: record.approvedBy,
    scope: JSON.stringify(record.scope),
    content_manifest_sha256: record.contentManifestSha256,
    proof_sha256: record.proofSha256,
    anchors: JSON.stringify(record.anchors),
    retained_reason: null,
    retained_data_reference: null,
    invalidation_of_prior_tombstone_id: null,
    attestations: JSON.stringify([ATTESTATION]),
    chain_entry_hash: ENTRY_HASH,
    chain_sequence_number: 7,
    ...over,
  };
}

describe("the column list", () => {
  it("covers every contract field plus the evidence and the anchor", () => {
    expect(TOMBSTONE_COLUMNS).toContain("attestations");
    expect(TOMBSTONE_COLUMNS).toContain("chain_entry_hash");
    expect(TOMBSTONE_COLUMNS).toContain("chain_sequence_number");
    expect(TOMBSTONE_COLUMNS).toHaveLength(18);
  });

  it("anchors as a deletion_event", () => {
    expect(TOMBSTONE_LOG_KIND).toBe("deletion_event");
  });
});

describe("tombstoneChainPayload", () => {
  it("commits to the digests and the identity, not the whole scope", () => {
    const payload = JSON.parse(tombstoneChainPayload(recordOf())) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "contentManifestSha256",
      "deletedAt",
      "kind",
      "proofSha256",
      "tenantId",
      "tombstoneId",
    ]);
    // A scope can name every table a tenant held, and the chain is read by every verification pass,
    // so committing the payload twice would make verification scale with deleted data. The digests
    // are what make the record tamper-evident.
    expect(JSON.stringify(payload)).not.toContain("t_abc.invoice");
  });
});

describe("write", () => {
  it("appends the chain entry BEFORE the insert, in one transaction", async () => {
    const { conn, anchorer, sql } = fakePg();
    await new PostgresTombstoneStore(conn, anchorer).write(recordOf());
    const order = sql();
    const begin = order.indexOf("BEGIN");
    const append = order.indexOf("-- chain append");
    const insert = order.findIndex((s) => s.startsWith("INSERT INTO"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(append).toBeGreaterThan(begin);
    // Appended first so the row carries its coordinates without an UPDATE, which would give an
    // append-only table a rewrite path.
    expect(insert).toBeGreaterThan(append);
    expect(order).toContain("COMMIT");
    expect(order.some((s) => s.startsWith("UPDATE"))).toBe(false);
  });

  it("replaces the caller's anchors with the chain entry it appended", async () => {
    const { conn, anchorer } = fakePg();
    const stored = await new PostgresTombstoneStore(conn, anchorer).write(recordOf());
    // The fixture passed an rfc3161 anchor naming "caller-chose-this"; a tombstone's witness is the
    // chain, and accepting a caller's would make the anchor a claim about a claim.
    expect(stored.record.anchors).toEqual([
      { kind: "internal_audit_log", reference: ENTRY_HASH, anchoredAt: AT },
    ]);
    expect(JSON.stringify(stored.record.anchors)).not.toContain("caller-chose-this");
    expect(stored.chainEntryHash).toBe(ENTRY_HASH);
    expect(stored.chainSequenceNumber).toBe(7);
  });

  it("anchors under the tenant's own chain, actored by the executor", async () => {
    const { conn, anchorer, appended } = fakePg();
    await new PostgresTombstoneStore(conn, anchorer).write(recordOf());
    expect(appended).toHaveLength(1);
    expect(appended[0]?.tenantId).toBe(TENANT);
    expect(appended[0]?.kind).toBe("deletion_event");
  });

  it("binds every column, casting the non-text ones", async () => {
    const { conn, anchorer, calls } = fakePg();
    await new PostgresTombstoneStore(conn, anchorer).write(recordOf(), [ATTESTATION]);
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("meta.tenant_tombstones");
    expect(insert?.params).toHaveLength(TOMBSTONE_COLUMNS.length);
    expect(insert?.sql).toContain("::uuid");
    expect(insert?.sql).toContain("::jsonb");
    expect(insert?.sql).toContain("::timestamptz");
    // `executed_by` and `approved_by` are TEXT now, so they carry no cast — the whole point of
    // ADR-0318's widening.
    const executedIndex = TOMBSTONE_COLUMNS.indexOf("executed_by") + 1;
    expect(insert?.sql).not.toContain(`$${executedIndex.toString()}::`);
    expect(insert?.params[executedIndex - 1]).toBe("alice@example.test");
  });

  it("stores the attestations beside the claim", async () => {
    const { conn, anchorer, calls } = fakePg();
    await new PostgresTombstoneStore(conn, anchorer).write(recordOf(), [ATTESTATION]);
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO"));
    const index = TOMBSTONE_COLUMNS.indexOf("attestations");
    expect(JSON.parse(String(insert?.params[index]))).toEqual([ATTESTATION]);
  });

  it("stores an empty evidence array when none is supplied", async () => {
    const { conn, anchorer, calls } = fakePg();
    await new PostgresTombstoneStore(conn, anchorer).write(recordOf());
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO"));
    const index = TOMBSTONE_COLUMNS.indexOf("attestations");
    expect(JSON.parse(String(insert?.params[index]))).toEqual([]);
  });

  it("refuses a record whose own hashes do not verify, before writing anything", async () => {
    const { conn, anchorer, sql } = fakePg();
    const tampered = recordOf({ proofSha256: "b".repeat(64) });
    await expect(new PostgresTombstoneStore(conn, anchorer).write(tampered)).rejects.toThrow(
      TombstoneWriteRefused,
    );
    expect(sql()).toEqual([]);
  });

  it("refuses when the scope is not what the attestations compose to", async () => {
    const { conn, anchorer, sql } = fakePg();
    const other: DeletionAttestation = {
      ...ATTESTATION,
      scope: { schemas: ["t_abc"], tables: ["t_abc.invoice"], rowCount: 1, storageBytes: 1 },
    };
    const err = await new PostgresTombstoneStore(conn, anchorer)
      .write(recordOf(), [other])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TombstoneWriteRefused);
    expect((err as TombstoneWriteRefused).refusal).toBe("attestations_mismatch");
    expect(sql()).toEqual([]);
  });

  it("refuses an executor who approved their own deletion", async () => {
    const { conn, anchorer, sql } = fakePg();
    const err = await new PostgresTombstoneStore(conn, anchorer)
      .write({ ...recordOf(), approvedBy: "alice@example.test" })
      .catch((e: unknown) => e);
    expect((err as TombstoneWriteRefused).refusal).toBe("four_eyes_violated");
    expect(sql()).toEqual([]);
  });

  it("refuses a non-uuid tenant id with a message about the tenant", async () => {
    const { conn, anchorer } = fakePg();
    const err = await new PostgresTombstoneStore(conn, anchorer)
      .write(recordOf({ tenantId: "not-a-uuid" }))
      .catch((e: unknown) => e);
    expect((err as TombstoneWriteRefused).refusal).toBe("invalid_tenant_id");
    expect((err as Error).message).toContain("tenantId must be a uuid");
  });

  it("declares every refusal it can raise", () => {
    expect([...TOMBSTONE_WRITE_REFUSALS].sort()).toEqual([
      "attestations_mismatch",
      "four_eyes_violated",
      "invalid_tenant_id",
      "proof_unverifiable",
    ]);
  });

  it("sets no tenant context, because the tenant's data is already gone", async () => {
    const { conn, anchorer, sql } = fakePg();
    await new PostgresTombstoneStore(conn, anchorer).write(recordOf());
    // Writing the record of a deletion under the deleted tenant's context would be a dependency on
    // the thing being deleted.
    expect(sql().some((s) => s.includes("app.current_tenant_id"))).toBe(false);
  });

  it("honours a schema override and refuses an invalid identifier", () => {
    const { conn, anchorer } = fakePg();
    expect(() => new PostgresTombstoneStore(conn, anchorer, { schema: 'x"; DROP TABLE y; --' })).toThrow(
      /invalid schema identifier/,
    );
    expect(() => new PostgresTombstoneStore(conn, anchorer, { schema: "other" })).not.toThrow();
  });
});

describe("read and listForTenant", () => {
  it("elevates with app.platform_audit, because no tenant session survives the deletion", async () => {
    const record = recordOf();
    const { conn, anchorer, sql } = fakePg([rowOf(record)]);
    await new PostgresTombstoneStore(conn, anchorer).read(record.id);
    expect(sql().some((s) => s.includes("set_config('app.platform_audit', 'on', true)"))).toBe(true);
  });

  it("returns null for a tombstone that is not there", async () => {
    const { conn, anchorer } = fakePg([]);
    expect(await new PostgresTombstoneStore(conn, anchorer).read("tomb_missing00001")).toBeNull();
  });

  it("round-trips a stored record through the contract", async () => {
    const record = recordOf();
    const { conn, anchorer } = fakePg([rowOf(record)]);
    const stored = await new PostgresTombstoneStore(conn, anchorer).read(record.id);
    expect(stored?.record.id).toBe(record.id);
    expect(stored?.record.scope).toEqual(record.scope);
    expect(stored?.attestations).toEqual([ATTESTATION]);
    expect(verifyTombstoneHashes(stored!.record)).toEqual({ contentManifestOk: true, proofOk: true });
  });

  it("orders a tenant's tombstones newest first and casts the tenant id", async () => {
    const record = recordOf();
    const { conn, anchorer, calls } = fakePg([rowOf(record)]);
    await new PostgresTombstoneStore(conn, anchorer).listForTenant(TENANT);
    const select = calls.find((c) => c.sql.includes("ORDER BY"));
    expect(select?.sql).toContain("tenant_id = $1::uuid");
    expect(select?.sql).toContain("ORDER BY deleted_at DESC, tombstone_id");
  });

  it("refuses a non-uuid tenant id before querying", async () => {
    const { conn, anchorer, sql } = fakePg();
    await expect(new PostgresTombstoneStore(conn, anchorer).listForTenant("nope")).rejects.toThrow(
      /invalid tenant id/,
    );
    expect(sql()).toEqual([]);
  });
});

describe("rowToStoredTombstone", () => {
  it("throws on a row the contract cannot represent", () => {
    const record = recordOf();
    // A row edited into a four-eyes violation: the column CHECK would stop an INSERT, and a row
    // altered around it is exactly what re-parsing on read catches (ADR-0289).
    expect(() => rowToStoredTombstone(rowOf(record, { approved_by: record.executedBy }))).toThrow();
  });

  it("trims the CHAR(64) padding Postgres adds", () => {
    const record = recordOf();
    const stored = rowToStoredTombstone(
      rowOf(record, {
        content_manifest_sha256: `${record.contentManifestSha256}  `,
        proof_sha256: `${record.proofSha256} `,
      }),
    );
    expect(stored.record.contentManifestSha256).toBe(record.contentManifestSha256);
    expect(verifyTombstoneHashes(stored.record).proofOk).toBe(true);
  });

  it("reads an unanchored legacy row as unanchored rather than failing", () => {
    const stored = rowToStoredTombstone(
      rowOf(recordOf(), { chain_entry_hash: null, chain_sequence_number: null, attestations: null }),
    );
    expect(stored.chainEntryHash).toBeNull();
    expect(stored.attestations).toEqual([]);
  });

  it("accepts a Date for deleted_at, as node-postgres returns", () => {
    const record = recordOf();
    const stored = rowToStoredTombstone(rowOf(record, { deleted_at: new Date(AT) }));
    expect(stored.record.deletedAt).toBe(AT);
  });
});

describe("verify", () => {
  it("reports found, both hashes, the anchor and the evidence match", async () => {
    const record = recordOf();
    const { conn, anchorer } = fakePg([rowOf(record)]);
    expect(await new PostgresTombstoneStore(conn, anchorer).verify(record.id)).toEqual({
      found: true,
      contentManifestOk: true,
      proofOk: true,
      anchored: true,
      matchesAttestations: true,
    });
  });

  it("says null rather than false when there is no evidence to check against", async () => {
    const record = recordOf();
    const { conn, anchorer } = fakePg([rowOf(record, { attestations: JSON.stringify([]) })]);
    const out = await new PostgresTombstoneStore(conn, anchorer).verify(record.id);
    // "Cannot say" and "disagrees" are different answers and an auditor must not read one as the
    // other.
    expect(out.matchesAttestations).toBeNull();
    expect(out.proofOk).toBe(true);
  });

  it("catches a scope tampered after signing, where the proof alone would not", async () => {
    const record = recordOf();
    const tamperedScope = { ...record.scope, rowCount: 1 };
    const { conn, anchorer } = fakePg([rowOf(record, { scope: JSON.stringify(tamperedScope) })]);
    const out = await new PostgresTombstoneStore(conn, anchorer).verify(record.id);
    expect(out.contentManifestOk).toBe(false);
    // The proof commits to the stored digest, which the tamper did not touch — two hashes catching
    // two classes of tamper.
    expect(out.proofOk).toBe(true);
    expect(out.matchesAttestations).toBe(false);
  });

  it("reports not found without claiming anything verified", async () => {
    const { conn, anchorer } = fakePg([]);
    expect(await new PostgresTombstoneStore(conn, anchorer).verify("tomb_absent000001")).toEqual({
      found: false,
      contentManifestOk: false,
      proofOk: false,
      anchored: false,
      matchesAttestations: null,
    });
  });
});
