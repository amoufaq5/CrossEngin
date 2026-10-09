import { META_TENANT_TOMBSTONES } from "@crossengin/kernel/bootstrap";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  assembleTombstone,
  verifyTombstoneHashes,
  type DeletionAttestation,
  type TombstoneRecord,
  type TombstoneRecordStorageDeclaration,
} from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  PostgresTombstoneStore,
  TOMBSTONE_COLUMNS,
  TOMBSTONE_LOG_KIND,
  TOMBSTONE_SCAN_MAX_LIMIT,
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

/**
 * The second performed subsystem's report (ADR-0329). `nothing_to_erase` so it composes nothing
 * into the scope — every scope assertion in this file is about `tenant_schema`, and the record has
 * to carry a `shared_tables` attestation now because the contract refuses declaring it absent.
 */
const SHARED_ATTESTATION: DeletionAttestation = {
  subsystem: "shared_tables",
  outcome: "nothing_to_erase",
  attestedBy: "operate-server/shared-table-erasure",
  attestedAt: AT,
};

/**
 * The record-storage declaration the v4 bytes sign (ADR-0351), shared by every fixture here so a
 * test that varies it is visibly varying one decision rather than restating a default.
 *
 * `typed_tables` with a non-zero count, because that is the deployment these fixtures describe: a
 * `--store pg-columns` boot manifest, whose typed relations are the ones ADR-0350's erasure empties
 * by name and whose absence was the thing a v3 proof could not say.
 */
const RECORD_STORAGE: TombstoneRecordStorageDeclaration = {
  model: "typed_tables",
  schema: "public",
  relationCount: 2,
};

/**
 * A record whose proof carries a real statutory retention (ADR-0330, signed by ADR-0331).
 *
 * Assembled rather than patched onto `recordOf`'s output: the retention claim is inside the v3 bytes
 * now, so spreading the three fields over a finished record would produce a proof that does not
 * verify — which is the state every tamper test here is trying to tell apart from an honest one.
 */
function retainingRecordOf(): TombstoneRecord {
  const out = assembleTombstone({
    id: "tomb_store0002abc",
    kind: "tenant_deletion",
    tenantId: TENANT,
    deletedAt: AT,
    executedBy: "alice@example.test",
    approvedBy: "bob@example.test",
    anchors: [{ kind: "rfc3161_timestamp", reference: "caller-chose-this", anchoredAt: AT }],
    capabilities: {
      tenant_schema: "erases",
      shared_tables: "erases",
      object_storage: "absent",
      backups: "retains",
      search_indexes: "absent",
      caches: "absent",
    },
    recordStorage: RECORD_STORAGE,
    attestations: [
      ATTESTATION,
      SHARED_ATTESTATION,
      {
        subsystem: "backups",
        outcome: "retained",
        retentionObligation: "tax_records_7y",
        retainedDataReference: "backup-vault://2026",
        attestedBy: "operate-server/backups",
        attestedAt: AT,
      },
    ],
  });
  if (!out.ok) throw new Error(`fixture failed: ${JSON.stringify(out.refusals)}`);
  return out.record;
}

/**
 * A **v1** record, assembled through the legacy `requiredSubsystems` path.
 *
 * The one shape that carries none of the four version-paired fields, which is what makes it the
 * fixture for "null is a different fact from a declaration": its bytes cover no record storage, so
 * the column must hold SQL NULL rather than any rendering of an absent declaration.
 */
function legacyRecordOf(): TombstoneRecord {
  const out = assembleTombstone({
    id: "tomb_store0003abc",
    kind: "tenant_deletion",
    tenantId: TENANT,
    deletedAt: AT,
    executedBy: "alice@example.test",
    approvedBy: "bob@example.test",
    anchors: [{ kind: "rfc3161_timestamp", reference: "caller-chose-this", anchoredAt: AT }],
    requiredSubsystems: ["tenant_schema", "shared_tables"],
    attestations: [ATTESTATION, SHARED_ATTESTATION],
  });
  if (!out.ok) throw new Error(`fixture failed: ${JSON.stringify(out.refusals)}`);
  return out.record;
}

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
    // `shared_tables` erases and attests (ADR-0329); the contract refuses declaring it absent.
    capabilities: { tenant_schema: "erases", shared_tables: "erases", object_storage: "absent", backups: "absent", search_indexes: "absent", caches: "absent" },
    recordStorage: RECORD_STORAGE,
    attestations: [ATTESTATION, SHARED_ATTESTATION],
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
    // Derived rather than hardcoded null, because the retention prose is inside the v3 signed bytes
    // (ADR-0331): a row that dropped it would make an honest retaining proof read as tampered.
    retained_reason: record.retainedReason ?? null,
    retained_data_reference: record.retainedDataReference ?? null,
    invalidation_of_prior_tombstone_id: null,
    attestations: JSON.stringify([ATTESTATION]),
    // ADR-0329. Omitting these two is not a shortcut: the version selects the domain tag the digest
    // was computed under, so a v2 record round-tripped through a row that drops them reads back as
    // v1, recomputes the v1 digest, and `verify` reports `contentManifestOk: false` on a proof that
    // is in fact correct. That is a forgery introduced by the *read*, and it is the one alarm the
    // forensic chain structurally cannot raise (ADR-0323) — so the fake row carries them.
    proof_version: record.proofVersion,
    capability_declaration:
      record.capabilityDeclaration === undefined
        ? null
        : JSON.stringify(record.capabilityDeclaration),
    // ADR-0331, for the same reason one version further on: a v3 row read back without its
    // obligations is a v3 label with nothing to hash, so it gets no manifest subject at all and
    // `verify` reports a tamper on an honest proof. `null` and `'[]'` are different facts here.
    retained_obligations:
      record.retainedObligations === undefined
        ? null
        : JSON.stringify(record.retainedObligations),
    // ADR-0351, and the sharpest member of the four: the other three columns have a default that is
    // the honest reading of a row written before them, and a record-storage declaration has none —
    // every value of it is a claim. So a fake that dropped this column would report a tamper on
    // every honest v4 proof and there is no column default to rescue it.
    record_storage:
      record.recordStorage === undefined ? null : JSON.stringify(record.recordStorage),
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
    // ADR-0329: the proof version and the declaration it signs.
    expect(TOMBSTONE_COLUMNS).toContain("proof_version");
    expect(TOMBSTONE_COLUMNS).toContain("capability_declaration");
    // ADR-0331: the structured half of the retention claim the v3 bytes sign.
    expect(TOMBSTONE_COLUMNS).toContain("retained_obligations");
    // ADR-0351: the record-storage declaration the v4 bytes sign.
    expect(TOMBSTONE_COLUMNS).toContain("record_storage");
    expect(TOMBSTONE_COLUMNS).toHaveLength(22);
  });

  it("names a column the catalog declares, once each", () => {
    // Against `META_TENANT_TOMBSTONES` rather than a second literal list, which is the sibling
    // idiom (`shared-table-erasure.test.ts` reads `META_TABLES` the same way): a column the store
    // names and the catalog lacks is the ADR-0332 defect, and a fake connection answers every
    // statement by shape so nothing else here can see it. One direction only — a catalogued column
    // this store deliberately does not read is `invalidation_of_prior_tombstone_id`'s business, not
    // a finding — and `pg-column-coverage.ts` is where the workspace-wide version lives.
    expect(new Set(TOMBSTONE_COLUMNS).size).toBe(TOMBSTONE_COLUMNS.length);
    const declared = new Set(META_TENANT_TOMBSTONES.columns.map((c) => c.name));
    for (const column of TOMBSTONE_COLUMNS) expect(declared).toContain(column);
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

  it("writes the signed retention claim's three fields", async () => {
    const { conn, anchorer, calls } = fakePg();
    const record = retainingRecordOf();
    await new PostgresTombstoneStore(conn, anchorer).write(record);
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO"));
    const obligations = TOMBSTONE_COLUMNS.indexOf("retained_obligations");
    const reason = TOMBSTONE_COLUMNS.indexOf("retained_reason");
    const reference = TOMBSTONE_COLUMNS.indexOf("retained_data_reference");
    expect(JSON.parse(String(insert?.params[obligations]))).toEqual(["tax_records_7y"]);
    expect(insert?.params[reason]).toBe(record.retainedReason);
    expect(insert?.params[reference]).toBe("backup-vault://2026");
    // JSONB, so a round trip cannot reorder the array into a different digest's worth of bytes.
    expect(insert?.sql).toContain(`$${(obligations + 1).toString()}::jsonb`);
  });

  it("writes an empty obligations array rather than NULL for a v4 proof that kept nothing", async () => {
    const { conn, anchorer, calls } = fakePg();
    await new PostgresTombstoneStore(conn, anchorer).write(recordOf());
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO"));
    const index = TOMBSTONE_COLUMNS.indexOf("retained_obligations");
    // NULL would say "this record's bytes do not cover a retention claim", which is false of a v4
    // record and would make it unreadable: the contract pairs the field with the version.
    expect(insert?.params[index]).not.toBeNull();
    expect(JSON.parse(String(insert?.params[index]))).toEqual([]);
  });

  it("writes the signed record-storage declaration as jsonb", async () => {
    const { conn, anchorer, calls } = fakePg();
    const record = recordOf();
    await new PostgresTombstoneStore(conn, anchorer).write(record);
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO"));
    const index = TOMBSTONE_COLUMNS.indexOf("record_storage");
    expect(insert?.sql).toContain("record_storage");
    // JSONB, so a round trip cannot reorder the object's keys into a different digest's worth of
    // bytes — the same reason the obligations array is cast.
    expect(insert?.sql).toContain(`$${(index + 1).toString()}::jsonb`);
    expect(JSON.parse(String(insert?.params[index]))).toEqual(RECORD_STORAGE);
    expect(record.recordStorage).toEqual(RECORD_STORAGE);
  });

  it("binds SQL NULL, not a rendering of absence, for a v1 record that declares none", async () => {
    const { conn, anchorer, calls } = fakePg();
    const legacy = legacyRecordOf();
    expect(legacy.proofVersion).toBe("v1");
    await new PostgresTombstoneStore(conn, anchorer).write(legacy);
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO"));
    const index = TOMBSTONE_COLUMNS.indexOf("record_storage");
    // NULL is a different fact from a declaration: it says this record's bytes do not cover the
    // question. `"null"` would be the JSONB scalar null and `"{}"` a claim with no model, and both
    // would read back as a declaration the parse then refuses on a row that is perfectly honest.
    expect(insert?.params[index]).toBeNull();
    expect(insert?.params[index]).not.toBe("null");
    expect(insert?.params[index]).not.toBe("{}");
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

describe("findForRequest", () => {
  it("queries by the deletion request the tombstone names", async () => {
    const record = recordOf();
    const { conn, anchorer, calls } = fakePg([rowOf(record)]);
    const found = await new PostgresTombstoneStore(conn, anchorer).findForRequest("dreq_abcdefgh1234");
    const select = calls.find((c) => c.sql.includes("related_deletion_request_id"));
    expect(select?.sql).toContain("WHERE related_deletion_request_id = $1");
    expect(select?.params).toEqual(["dreq_abcdefgh1234"]);
    expect(found).toHaveLength(1);
  });

  it("elevates with app.platform_audit, since the evidence outlives its tenant", async () => {
    const { conn, anchorer, sql } = fakePg([]);
    await new PostgresTombstoneStore(conn, anchorer).findForRequest("dreq_abcdefgh1234");
    expect(sql().some((s) => s.includes("set_config('app.platform_audit', 'on', true)"))).toBe(true);
  });

  it("does not LIMIT, so two tombstones for one request are visible", async () => {
    const record = recordOf();
    const { conn, anchorer, calls } = fakePg([rowOf(record)]);
    await new PostgresTombstoneStore(conn, anchorer).findForRequest("dreq_abcdefgh1234");
    // A LIMIT 1 would hide the one case that means the premise is broken (ADR-0322).
    const select = calls.find((c) => c.sql.includes("related_deletion_request_id"));
    expect(select?.sql).not.toContain("LIMIT");
  });
});

describe("scanAll", () => {
  /** The SELECT that actually reads the table, as opposed to the elevation. */
  function scanSelect(calls: { sql: string; params: readonly unknown[] }[]):
    | { sql: string; params: readonly unknown[] }
    | undefined {
    return calls.find((c) => c.sql.includes("FROM meta.tenant_tombstones"));
  }

  it("orders on a key that cannot tie, and never on a timestamp or an OFFSET", async () => {
    const { conn, anchorer, calls } = fakePg([rowOf(recordOf())]);
    await new PostgresTombstoneStore(conn, anchorer).scanAll({ limit: 10 });
    const select = scanSelect(calls);
    // `deleted_at` can be shared by two rows, and a sweep on a key with ties steps over a row at
    // every page boundary — which here is a row no other audit will ever verify.
    expect(select?.sql).toContain("ORDER BY tombstone_id LIMIT");
    expect(select?.sql).not.toContain("deleted_at DESC");
    expect(select?.sql).not.toContain("OFFSET");
  });

  it("omits the cursor predicate on the first page", async () => {
    const { conn, anchorer, calls } = fakePg([]);
    await new PostgresTombstoneStore(conn, anchorer).scanAll({ limit: 25 });
    const select = scanSelect(calls);
    // Not `($1 IS NULL OR tombstone_id > $1)`: that form makes the planner choose one path for both
    // shapes and gives up the unique index.
    expect(select?.sql).not.toContain("WHERE");
    expect(select?.sql).toContain("LIMIT $1");
    expect(select?.params).toEqual([25]);
  });

  it("binds the cursor with a strict > so a later page re-reads nothing", async () => {
    const { conn, anchorer, calls } = fakePg([]);
    await new PostgresTombstoneStore(conn, anchorer).scanAll({
      limit: 25,
      afterTombstoneId: "tomb_store0001abc",
    });
    const select = scanSelect(calls);
    expect(select?.sql).toContain("WHERE tombstone_id > $1");
    expect(select?.sql).toContain("LIMIT $2");
    expect(select?.params).toEqual(["tomb_store0001abc", 25]);
  });

  it("treats an explicit null cursor as the first page", async () => {
    const { conn, anchorer, calls } = fakePg([]);
    await new PostgresTombstoneStore(conn, anchorer).scanAll({ limit: 5, afterTombstoneId: null });
    expect(scanSelect(calls)?.params).toEqual([5]);
  });

  it("elevates with app.platform_audit, because this is a cross-tenant sweep", async () => {
    const { conn, anchorer, sql } = fakePg([]);
    await new PostgresTombstoneStore(conn, anchorer).scanAll({ limit: 10 });
    // Under the isolation policy it would see only whichever tenant's context the connection held,
    // which for a tombstone is usually none — a sweep that silently covers one tenant is worse than
    // no sweep.
    expect(sql().some((s) => s.includes("set_config('app.platform_audit', 'on', true)"))).toBe(true);
  });

  it("clamps the page size to the exported cap and to a floor of one", async () => {
    const { conn, anchorer, calls } = fakePg([]);
    const store = new PostgresTombstoneStore(conn, anchorer);
    await store.scanAll({ limit: 5000 });
    expect(scanSelect(calls)?.params).toEqual([TOMBSTONE_SCAN_MAX_LIMIT]);
    const second = fakePg([]);
    await new PostgresTombstoneStore(second.conn, anchorer).scanAll({ limit: 0 });
    expect(scanSelect(second.calls)?.params).toEqual([1]);
  });

  it("publishes the cap, because a caller reading a short page as the end needs to know it", () => {
    expect(TOMBSTONE_SCAN_MAX_LIMIT).toBe(500);
  });

  it("returns an empty page for an empty table", async () => {
    const { conn, anchorer } = fakePg([]);
    expect(await new PostgresTombstoneStore(conn, anchorer).scanAll({ limit: 10 })).toEqual([]);
  });

  it("re-parses every row, so a corrupted one is a finding rather than data", async () => {
    const record = recordOf();
    const { conn, anchorer } = fakePg([rowOf(record, { approved_by: record.executedBy })]);
    await expect(new PostgresTombstoneStore(conn, anchorer).scanAll({ limit: 10 })).rejects.toThrow();
  });

  it("hands back the full record, evidence and anchor for each row", async () => {
    const record = recordOf();
    const { conn, anchorer } = fakePg([rowOf(record)]);
    const page = await new PostgresTombstoneStore(conn, anchorer).scanAll({ limit: 10 });
    expect(page).toHaveLength(1);
    expect(page[0]?.record.id).toBe(record.id);
    expect(page[0]?.attestations).toEqual([ATTESTATION]);
    expect(page[0]?.chainEntryHash).toBe(ENTRY_HASH);
  });

  it("selects every column the verification needs", async () => {
    const { conn, anchorer, calls } = fakePg([]);
    await new PostgresTombstoneStore(conn, anchorer).scanAll({ limit: 10 });
    const select = scanSelect(calls);
    for (const column of TOMBSTONE_COLUMNS) expect(select?.sql).toContain(column);
  });

  it("honours a schema override", async () => {
    const { conn, anchorer, calls } = fakePg([]);
    await new PostgresTombstoneStore(conn, anchorer, { schema: "other" }).scanAll({ limit: 10 });
    expect(calls.some((c) => c.sql.includes("other.tenant_tombstones"))).toBe(true);
  });

  it("writes nothing", async () => {
    const { conn, anchorer, sql } = fakePg([rowOf(recordOf())]);
    await new PostgresTombstoneStore(conn, anchorer).scanAll({ limit: 10 });
    expect(sql().some((s) => /^\s*(UPDATE|INSERT|DELETE)/.test(s))).toBe(false);
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

  it("throws on an incoherent record_storage rather than dropping it", () => {
    // `document_rows` has no typed per-entity relations, so it can name neither a schema for them
    // nor a count of them. The mapper hands the column to the schema **unexamined** on purpose: a
    // second shape check here could disagree with the one the digest was computed over, and then a
    // row would be read under rules nothing signed. So an incoherent declaration is a finding
    // (ADR-0289), not a field quietly left off the record.
    const row = rowOf(recordOf(), {
      record_storage: JSON.stringify({ model: "document_rows", schema: "public", relationCount: 3 }),
    });
    expect(() => rowToStoredTombstone(row)).toThrow(/no typed per-entity relations/);
  });

  it("throws on a v4 row whose record_storage is NULL, naming the version pairing", () => {
    // The detectable form of the hazard the column exists to prevent. A v4 label with nothing to
    // hash gets no manifest subject at all, so a verifier would report `scope_tampered` on an
    // honest proof and escalate it at `sev1` (ADR-0324) — and the contract's pairing turns that
    // into a refusal naming the field instead.
    const row = rowOf(recordOf(), { record_storage: null });
    expect(() => rowToStoredTombstone(row)).toThrow(/commits to a record-storage declaration/);
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

  it("throws rather than downgrading a v2 row relabelled v1 with its declaration intact", async () => {
    // ADR-0329. The contract pairs the two fields in both directions, so this row describes no
    // coherent version at all — and `rowToStoredTombstone` throws rather than answering, which is
    // ADR-0289's rule: a row the contract cannot represent is a finding, not a shorter answer.
    const record = recordOf();
    expect(record.proofVersion).toBe("v4");
    const { conn, anchorer } = fakePg([rowOf(record, { proof_version: "v1" })]);
    await expect(new PostgresTombstoneStore(conn, anchorer).verify(record.id)).rejects.toThrow(
      /outside the signed bytes/,
    );
  });

  it("reports a v4 proof tampered if the new columns are dropped on the way back", async () => {
    // The real shape of the hazard, and a regression guard rather than a hypothetical: this is what
    // every read did before the two columns existed. A v2 record whose row carries neither field
    // parses cleanly as a v1 record, the verifier recomputes the digest under the v1 domain tag,
    // and an **honest** proof is reported tampered — which escalates a `sev1` about a falsified
    // Article 17 proof that was never falsified, the one alarm the forensic chain structurally
    // cannot raise or refute (ADR-0323). The assertion is on the failure deliberately: a test that
    // only walks the happy path goes green again the moment a column leaves the SELECT list.
    const record = recordOf();
    const { conn, anchorer } = fakePg([
      rowOf(record, {
        proof_version: "v1",
        capability_declaration: null,
        retained_obligations: null,
        record_storage: null,
      }),
    ]);
    const out = await new PostgresTombstoneStore(conn, anchorer).verify(record.id);
    expect(out.contentManifestOk).toBe(false);
    // And `proofSha256` still checks out, which is why nothing upstream catches it: the proof
    // commits to the content-manifest digest, not to the version that produced it.
    expect(out.proofOk).toBe(true);
  });

  it("round-trips a v4 proof through the row and verifies clean", async () => {
    const record = recordOf();
    const { conn, anchorer } = fakePg([rowOf(record)]);
    const stored = await new PostgresTombstoneStore(conn, anchorer).read(record.id);
    // Field-for-field equality rather than a tour of the interesting ones, because what the read
    // has to preserve is the *whole* record: anything dropped on the way back relabels the proof,
    // and the version-paired fields are the ones with no column default to rescue them.
    expect(stored?.record).toEqual(record);
    expect(stored?.record.proofVersion).toBe("v4");
    expect(stored?.record.recordStorage).toEqual(RECORD_STORAGE);
    expect(verifyTombstoneHashes(stored!.record)).toEqual({
      contentManifestOk: true,
      proofOk: true,
    });
  });

  it("throws rather than reading a v4 row whose obligations column was dropped", async () => {
    // ADR-0331's version of the hazard above, and the narrower half of it: `proof_version` still
    // says v4, so the row describes no coherent version at all and `rowToStoredTombstone` throws
    // instead of answering. ADR-0289's rule — a row the contract cannot represent is a finding.
    const record = recordOf();
    const { conn, anchorer } = fakePg([rowOf(record, { retained_obligations: null })]);
    await expect(new PostgresTombstoneStore(conn, anchorer).verify(record.id)).rejects.toThrow(
      /commits to a retention claim/,
    );
  });

  it("keeps an empty obligations array distinct from a NULL column", async () => {
    // `[]` is the v4 claim that nothing was lawfully kept; NULL is a record whose bytes do not cover
    // the question at all. A truthiness test on the parsed JSON would have collapsed the two.
    const record = recordOf();
    const { conn, anchorer } = fakePg([rowOf(record)]);
    const stored = await new PostgresTombstoneStore(conn, anchorer).read(record.id);
    expect(stored?.record.retainedObligations).toEqual([]);
    expect(stored?.record.retainedObligations).not.toBeUndefined();
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

  it("catches a retention claim edited after signing — the v3 deliverable", async () => {
    // What ADR-0330 left open and this closes. The retention claim was on the record and in neither
    // digest, so rewriting *why* a tenant's data survived left `content_manifest_sha256`,
    // `proof_sha256` and the chain entry byte-identical — and `contentManifestOk` is the only thing
    // in the system that can see an edit the chain cannot (ADR-0323). This row is the edit.
    const record = retainingRecordOf();
    const { conn, anchorer } = fakePg([
      rowOf(record, { retained_reason: "retained under legal obligation — backups: audit_logs_3y" }),
    ]);
    const out = await new PostgresTombstoneStore(conn, anchorer).verify(record.id);
    expect(out.contentManifestOk).toBe(false);
    // The proof commits to the stored manifest digest, which the editor did not touch, so nothing
    // upstream of `contentManifestOk` notices.
    expect(out.proofOk).toBe(true);
  });

  it("catches a retained data reference moved after signing", async () => {
    const record = retainingRecordOf();
    const { conn, anchorer } = fakePg([
      rowOf(record, { retained_data_reference: "backup-vault://elsewhere" }),
    ]);
    const out = await new PostgresTombstoneStore(conn, anchorer).verify(record.id);
    expect(out.contentManifestOk).toBe(false);
    expect(out.proofOk).toBe(true);
  });

  it("catches an obligation swapped after signing", async () => {
    const record = retainingRecordOf();
    const { conn, anchorer } = fakePg([
      rowOf(record, { retained_obligations: JSON.stringify(["audit_logs_3y"]) }),
    ]);
    expect((await new PostgresTombstoneStore(conn, anchorer).verify(record.id)).contentManifestOk).toBe(
      false,
    );
  });

  it("catches a record-storage declaration edited after signing — the v4 deliverable", async () => {
    // The tamper v4 exists to detect, and the one a reader of a stored proof could not otherwise
    // tell from the truth: before the declaration was inside the bytes, rewriting it to
    // `document_rows` — the claim that this deployment held no typed relations, and so that the
    // scope's silence about them was honest — left both digests and the chain entry untouched.
    const record = recordOf();
    const { conn, anchorer } = fakePg([
      rowOf(record, {
        record_storage: JSON.stringify({ model: "document_rows", schema: null, relationCount: 0 }),
      }),
    ]);
    const out = await new PostgresTombstoneStore(conn, anchorer).verify(record.id);
    expect(out.contentManifestOk).toBe(false);
    expect(out.proofOk).toBe(true);
  });

  it("catches a relation count edited after signing, with the model left alone", async () => {
    // The narrower half, and the reason `relationCount` is what earns the version: a `typed_tables`
    // declaration counting zero is a claim of its own, so an editor that only moves the figure is
    // rewriting how much the deployment had without touching what kind of store it was.
    const record = recordOf();
    const { conn, anchorer } = fakePg([
      rowOf(record, { record_storage: JSON.stringify({ ...RECORD_STORAGE, relationCount: 0 }) }),
    ]);
    expect(
      (await new PostgresTombstoneStore(conn, anchorer).verify(record.id)).contentManifestOk,
    ).toBe(false);
  });

  it("verifies an honest retaining proof clean", async () => {
    // The other half of the pair: the detector must not fire on a record nobody touched.
    const record = retainingRecordOf();
    const { conn, anchorer } = fakePg([rowOf(record)]);
    const out = await new PostgresTombstoneStore(conn, anchorer).verify(record.id);
    expect(out.contentManifestOk).toBe(true);
    expect(out.proofOk).toBe(true);
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
