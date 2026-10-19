import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_PROVENANCES,
  checkpointAnchorsBoundedProof,
  type ChainCheckpoint,
  type CheckpointProvenance,
} from "@crossengin/forensics";

import { PostgresChainCheckpointStore, rowToCheckpoint } from "./checkpoint-store.js";
import { fakeChainPg } from "./test-fakes.js";
import type { PgConnection } from "@crossengin/kernel-pg";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const AT = "2026-06-01T00:00:00.000Z";

function h(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function checkpoint(sequenceNumber: number, extra: Partial<ChainCheckpoint> = {}): ChainCheckpoint {
  return {
    sequenceNumber,
    rootHash: h(sequenceNumber + 1),
    checkpointedAt: AT,
    checkpointedBy: "auditor",
    algorithm: "sha256",
    ...extra,
  };
}

/** A connection that records every statement and its bound parameters, through transactions. */
function recording(): { conn: PgConnection; seen: { sql: string; params: unknown[] }[] } {
  const inner = fakeChainPg();
  const seen: { sql: string; params: unknown[] }[] = [];
  const wrap = (c: PgConnection): PgConnection => ({
    ...c,
    query: (async (sql: string, params?: readonly unknown[]) => {
      seen.push({ sql, params: [...(params ?? [])] });
      return c.query(sql, params);
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      inner.transaction((tx) => fn(wrap(tx)))) as PgConnection["transaction"],
  });
  return { conn: wrap(inner), seen };
}


describe("PostgresChainCheckpointStore", () => {
  it("records and reads back the latest checkpoint per scope", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    expect(await store.latest(TENANT_A)).toBeNull();

    await store.record(TENANT_A, checkpoint(2));
    await store.record(TENANT_A, checkpoint(5, { externalAnchorReference: "btc:txid:abc" }));

    const latest = await store.latest(TENANT_A);
    expect(latest?.sequenceNumber).toBe(5);
    expect(latest?.externalAnchorReference).toBe("btc:txid:abc");
  });

  it("fetches a checkpoint by sequence and lists recent newest-first", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(1));
    await store.record(TENANT_A, checkpoint(3));
    await store.record(TENANT_A, checkpoint(7));

    const at3 = await store.getBySequence(TENANT_A, 3);
    expect(at3?.sequenceNumber).toBe(3);
    expect(await store.getBySequence(TENANT_A, 99)).toBeNull();

    const recent = await store.listRecent(TENANT_A, 2);
    expect(recent.map((c) => c.sequenceNumber)).toEqual([7, 3]);
  });

  it("is append-only — re-recording the same sequence is a no-op", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(2, { checkpointedBy: "first" }));
    await store.record(TENANT_A, checkpoint(2, { checkpointedBy: "second" }));
    const got = await store.getBySequence(TENANT_A, 2);
    expect(got?.checkpointedBy).toBe("first");
  });

  it("isolates checkpoints per tenant and from the platform chain", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(4));
    await store.record(TENANT_B, checkpoint(9));
    await store.record(null, checkpoint(1));

    expect((await store.latest(TENANT_A))?.sequenceNumber).toBe(4);
    expect((await store.latest(TENANT_B))?.sequenceNumber).toBe(9);
    expect((await store.latest(null))?.sequenceNumber).toBe(1);
    expect(await store.getBySequence(TENANT_A, 9)).toBeNull();
  });

  it("rejects a malformed tenant id and a bad schema", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await expect(store.record("not-a-uuid", checkpoint(0))).rejects.toThrow();
    expect(() => new PostgresChainCheckpointStore(fakeChainPg(), { schema: "Bad-Schema" })).toThrow(
      /schema/,
    );
  });
});

describe("rowToCheckpoint", () => {
  it("trims CHAR(64) padding, coerces a Date, and nulls to undefined", () => {
    const cp = rowToCheckpoint({
      sequence_number: "5",
      root_hash: `${h(6)} `,
      checkpointed_at: new Date(AT),
      checkpointed_by: "auditor",
      external_anchor_reference: null,
      algorithm: "sha256",
    });
    expect(cp.sequenceNumber).toBe(5);
    expect(cp.rootHash).toBe(h(6));
    expect(cp.checkpointedAt).toBe(AT);
    expect(cp.externalAnchorReference).toBeUndefined();
  });

  it("maps a stored provenance, and both a NULL and an absent column to undefined", () => {
    const base = {
      sequence_number: 5,
      root_hash: h(6),
      checkpointed_at: AT,
      checkpointed_by: "auditor",
      algorithm: "sha256",
    };
    expect(rowToCheckpoint({ ...base, provenance: "verified_suffix" }).provenance).toBe(
      "verified_suffix",
    );
    expect(rowToCheckpoint({ ...base, provenance: null }).provenance).toBeUndefined();
    // A row written before the column existed has no key at all — the same fact as NULL.
    expect(rowToCheckpoint(base).provenance).toBeUndefined();
  });

  it("refuses a provenance the enum does not name rather than reading it as absent", () => {
    expect(() =>
      rowToCheckpoint({
        sequence_number: 5,
        root_hash: h(6),
        checkpointed_at: AT,
        checkpointed_by: "auditor",
        algorithm: "sha256",
        provenance: "verified_sort_of",
      }),
    ).toThrow();
  });
});

/**
 * The column exists so that a bounded verification can tell an anchor it may fold from from one it
 * may not, so what matters is that the value survives the write, every read, and nothing else.
 */
describe("PostgresChainCheckpointStore provenance", () => {
  // Both ordered reads, because `UNIQUE (tenant_id, sequence_number)` does not constrain the
  // platform scope — SQL treats NULLs as distinct, so `(NULL, 3)` twice is legal and the
  // `ON CONFLICT` arm never fires there. Measured live: two such rows existed and ten runs of the
  // untiebroken query returned the OLDER one every time, which would let a stale `verified_full`
  // mask a later `unverified` and license the very skip the provenance exists to refuse. Asserted
  // on the recorded SQL because the fake de-duplicates on `(tenant, sequence)` in its INSERT
  // branch, so no round trip through it can hold the two rows this is about (ADR-0371).
  it.each([
    ["latest", async (s: PostgresChainCheckpointStore) => s.latest(null)],
    ["listRecent", async (s: PostgresChainCheckpointStore) => s.listRecent(null)],
  ])("breaks a same-sequence tie newest-first in %s", async (_name, read) => {
    const { conn, seen } = recording();
    await read(new PostgresChainCheckpointStore(conn));

    const select = seen.find((q) => /SELECT/i.test(q.sql));
    expect(select?.sql).toContain("ORDER BY sequence_number DESC, checkpointed_at DESC, id DESC");
  });

  it("names provenance in the INSERT and binds it last", async () => {
    const { conn, seen } = recording();
    const store = new PostgresChainCheckpointStore(conn);
    await store.record(TENANT_A, checkpoint(4, { provenance: "verified_full" }));

    const insert = seen.find((q) => q.sql.includes("INSERT INTO"));
    expect(insert?.sql).toContain("provenance");
    expect(insert?.sql).toContain("VALUES ($1, $2, $3, $4, $5, $6, $7, $8)");
    expect(insert?.params).toHaveLength(8);
    expect(insert?.params[7]).toBe("verified_full");
  });

  it("binds null for an absent provenance, so the column is NULL and not the string", async () => {
    const { conn, seen } = recording();
    const store = new PostgresChainCheckpointStore(conn);
    await store.record(TENANT_A, checkpoint(4));

    const insert = seen.find((q) => q.sql.includes("INSERT INTO"));
    expect(insert?.params).toHaveLength(8);
    expect(insert?.params[7]).toBeNull();
  });

  it("asks for provenance on every read path", async () => {
    const { conn, seen } = recording();
    const store = new PostgresChainCheckpointStore(conn);
    await store.record(TENANT_A, checkpoint(1, { provenance: "verified_suffix" }));

    seen.length = 0;
    await store.latest(TENANT_A);
    await store.getBySequence(TENANT_A, 1);
    await store.listRecent(TENANT_A, 5);

    const reads = seen.filter((q) => q.sql.includes("SELECT sequence_number"));
    expect(reads).toHaveLength(3);
    for (const q of reads) expect(q.sql).toContain("provenance");
  });

  // Over the constant, so a fourth provenance is round-tripped here by landing rather than by
  // somebody remembering to add a case.
  it.each(CHECKPOINT_PROVENANCES)("round-trips %s through every read", async (provenance) => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(6, { provenance }));

    expect((await store.latest(TENANT_A))?.provenance).toBe(provenance);
    expect((await store.getBySequence(TENANT_A, 6))?.provenance).toBe(provenance);
    expect((await store.listRecent(TENANT_A))[0]?.provenance).toBe(provenance);
    expect(checkpointAnchorsBoundedProof((await store.latest(TENANT_A))?.provenance)).toBe(
      checkpointAnchorsBoundedProof(provenance),
    );
  });

  it("round-trips an absent provenance as undefined, which anchors nothing", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(6));

    const got = await store.latest(TENANT_A);
    expect(got).not.toBeNull();
    expect(got?.provenance).toBeUndefined();
    expect(checkpointAnchorsBoundedProof(got?.provenance)).toBe(false);
  });

  it("does not promote a stored provenance on a re-record", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(6, { provenance: "unverified" }));
    await store.record(TENANT_A, checkpoint(6, { provenance: "verified_full" }));

    // The append-only rule is the fence here rather than a limitation: an `unverified` anchor that
    // could be re-recorded as `verified_full` would be trusted without anything having verified it.
    expect((await store.getBySequence(TENANT_A, 6))?.provenance).toBe("unverified");
  });

  it("refuses a provenance outside the enum before issuing any SQL", async () => {
    const { conn, seen } = recording();
    const store = new PostgresChainCheckpointStore(conn);
    await expect(
      store.record(
        TENANT_A,
        // The cast is the test: the refusal is `record`'s own parse, and it is wanted because the
        // type is defeatable wherever this value really comes from.
        checkpoint(6, { provenance: "verified_sort_of" as CheckpointProvenance }),
      ),
    ).rejects.toThrow();
    expect(seen.some((q) => q.sql.includes("INSERT INTO"))).toBe(false);
  });
});

/**
 * The same two rules the chain entries carry, for the same two reasons: an owner-connected read
 * crossed scopes, and a platform write rode inside the tenant isolation policy.
 */
describe("PostgresChainCheckpointStore scope handling", () => {
  it("does not serve a tenant the platform's latest checkpoint", async () => {
    const conn = fakeChainPg();
    const store = new PostgresChainCheckpointStore(conn);
    await store.record(null, checkpoint(900));
    await store.record(TENANT_A, checkpoint(3));
    // The platform's 900 is the higher sequence, so an unscoped `ORDER BY … DESC LIMIT 1` returns
    // it — and a truncation check measures the tenant's tail against whatever `latest` said.
    expect((await store.latest(TENANT_A))?.sequenceNumber).toBe(3);
    expect((await store.latest(null))?.sequenceNumber).toBe(900);
    expect(await store.getBySequence(TENANT_A, 900)).toBeNull();
    expect(await store.listRecent(TENANT_A)).toHaveLength(1);
    expect(await store.listRecent(null)).toHaveLength(1);
  });

  it("binds every read's scope, and sets the write elevation only for a platform write", async () => {
    const { conn, seen } = recording();
    const store = new PostgresChainCheckpointStore(conn);

    await store.record(TENANT_A, checkpoint(1));
    expect(seen.some((q) => q.sql.includes("app.current_tenant_id"))).toBe(true);
    expect(seen.some((q) => q.sql.includes("app.platform_audit_write"))).toBe(false);

    seen.length = 0;
    await store.record(null, checkpoint(1));
    expect(seen.some((q) => q.sql.includes("app.platform_audit_write"))).toBe(true);

    seen.length = 0;
    await store.latest(null);
    await store.listRecent(null, 5);
    await store.getBySequence(null, 1);
    const platformReads = seen.filter((q) => q.sql.includes("SELECT sequence_number"));
    expect(platformReads).toHaveLength(3);
    for (const q of platformReads) expect(q.sql).toContain("tenant_id IS NULL");
    // A read never asks for the write elevation.
    expect(seen.some((q) => q.sql.includes("app.platform_audit_write"))).toBe(false);

    seen.length = 0;
    await store.latest(TENANT_A);
    await store.listRecent(TENANT_A, 5);
    await store.getBySequence(TENANT_A, 1);
    const tenantReads = seen.filter((q) => q.sql.includes("SELECT sequence_number"));
    expect(tenantReads).toHaveLength(3);
    for (const q of tenantReads) {
      expect(q.sql).toMatch(/tenant_id = \$\d/);
      expect(q.params).toContain(TENANT_A);
    }
  });
});
