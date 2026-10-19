import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_PROVENANCES,
  checkpointAnchorsBoundedProof,
  type ChainCheckpoint,
  type CheckpointProvenance,
} from "@crossengin/forensics";

import {
  CheckpointRowUnreadable,
  PostgresChainCheckpointStore,
  rowToCheckpoint,
} from "./checkpoint-store.js";
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
    expect(recent.records.map((c) => c.sequenceNumber)).toEqual([7, 3]);
    expect(recent.unreadable).toEqual([]);
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
    expect((await store.listRecent(TENANT_A)).records[0]?.provenance).toBe(provenance);
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
    expect((await store.listRecent(TENANT_A)).records).toHaveLength(1);
    expect((await store.listRecent(null)).records).toHaveLength(1);
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

/**
 * Rewrites a stored checkpoint row on its way back out, so the store meets a row its contract
 * refuses while `record` still wrote a valid one — which is what makes this a tamper rather than a
 * fixture. Keyed on `checkpointed_by` appearing in the SELECT list, which `READ_COLUMNS` has.
 *
 * This is the **third** copy of `chain-log-store.test.ts`' `patchedReadConn` shape, and ADR-0373's
 * own open question already names the second: it belongs in `test-fakes.ts` for the reason
 * `scopeFilter` was hoisted. Kept local here because that module is not this increment's to move,
 * and the duplication is worth recording rather than hiding.
 */
function patchedCheckpointConn(
  inner: PgConnection,
  ...patches: readonly [number, Record<string, unknown>][]
): PgConnection {
  const bySequence = new Map(patches);
  const wrap = (c: PgConnection): PgConnection => ({
    query: (async (sql: string, params?: readonly unknown[]) => {
      const res = await c.query(sql, params);
      if (!sql.includes("SELECT") || !sql.includes("checkpointed_by")) return res;
      const rows = res.rows.map((r) => {
        const row = { ...r } as Record<string, unknown>;
        const patch = bySequence.get(Number(row["sequence_number"]));
        return patch === undefined ? row : { ...row, ...patch };
      });
      return { rows, rowCount: rows.length };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      inner.transaction((tx) => fn(wrap(tx)))) as PgConnection["transaction"],
    withAdvisoryLock: c.withAdvisoryLock,
    close: c.close,
  });
  return wrap(inner);
}

/** `sequences` real checkpoints written through a clean connection, read back through a patched one. */
async function checkpointsReadThrough(
  sequences: readonly number[],
  ...patches: readonly [number, Record<string, unknown>][]
): Promise<PostgresChainCheckpointStore> {
  const conn = fakeChainPg();
  const store = new PostgresChainCheckpointStore(conn);
  for (const s of sequences) await store.record(TENANT_A, checkpoint(s));
  return new PostgresChainCheckpointStore(patchedCheckpointConn(conn, ...patches));
}

/**
 * A stored anchor the contract refuses — ADR-0374.
 *
 * The two single-row reads throw and the page read does not, which is ADR-0373's rule rather than
 * this store's taste: a caller asking about one row must not be served past it, while a page that
 * throws takes every other row's finding with it.
 */
describe("a stored checkpoint row the contract refuses", () => {
  // Both columns, because `external_anchor_reference` was the sibling in the same state rather than
  // the one anybody was pointed at: it is `z.string().min(1).optional()`, so `''` is refused exactly
  // as a blanked `checkpointed_by` is while NULL is the legitimate absent-anchor claim.
  it.each([
    ["checkpointed_by", { checkpointed_by: "" }, "checkpointedBy"],
    ["external_anchor_reference", { external_anchor_reference: "" }, "externalAnchorReference"],
  ])("makes latest() throw CheckpointRowUnreadable naming %s", async (_col, patch, field) => {
    const store = await checkpointsReadThrough([5], [5, patch]);

    const err = await store.latest(TENANT_A).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CheckpointRowUnreadable);
    const unreadable = err as CheckpointRowUnreadable;
    // The identity is the row's business key within its scope, and the scope is on the error — so
    // between them a remedy has the `WHERE` clause it needs.
    expect(unreadable.row.identity).toBe("5");
    expect(unreadable.scope).toBe(TENANT_A);
    // `unreadableDetail`'s shape: the field path and the issue code, and no value from the row.
    expect(unreadable.row.detail).toBe(`${field}: too_small`);
  });

  // The whole reason this is a typed throw rather than `null`: `null` means *no checkpoint for this
  // scope*, which `CHAIN_FULL_REASONS` describes as healing on the next scheduler pass — and this
  // cannot heal, because `record` is `ON CONFLICT … DO NOTHING`, so a pass anchoring at the same
  // tail is a no-op and the refused row stays (verified live, `INSERT 0 0`).
  it("does not collapse a refused row into the absent-checkpoint answer", async () => {
    const empty = new PostgresChainCheckpointStore(fakeChainPg());
    expect(await empty.latest(TENANT_A)).toBeNull();

    const refused = await checkpointsReadThrough([5], [5, { checkpointed_by: "" }]);
    await expect(refused.latest(TENANT_A)).rejects.toBeInstanceOf(CheckpointRowUnreadable);
  });

  it("makes getBySequence() throw the same refusal, so the two single-row reads agree", async () => {
    const store = await checkpointsReadThrough([5], [5, { checkpointed_by: "" }]);
    await expect(store.getBySequence(TENANT_A, 5)).rejects.toBeInstanceOf(CheckpointRowUnreadable);
    // A sequence no row holds is still the absent answer, not a refusal.
    expect(await store.getBySequence(TENANT_A, 99)).toBeNull();
  });

  // The message reaches an `onError` log line, so it is held to the same rule as the detail: it may
  // name the identity and the issue, and no other column's value. Before this it was a bare
  // `ZodError`, whose `message` is the JSON of its issues — and an `invalid_enum_value` issue
  // carries `received`, i.e. the stored value (ADR-0367's disclosure, ADR-0373's correction).
  it("names the sequence and the issue in its message and no other stored value", async () => {
    const store = await checkpointsReadThrough([5], [5, { checkpointed_by: "" }]);
    const err = (await store.latest(TENANT_A).then(
      () => null,
      (e: unknown) => e,
    )) as CheckpointRowUnreadable;

    expect(err.message).toContain("sequence 5");
    expect(err.message).toContain(TENANT_A);
    expect(err.message).toContain("Fold from genesis");
    // `checkpoint()`'s rootHash for sequence 5 — a column of the refused row, which must not travel.
    expect(err.message).not.toContain(h(6));
    expect(err.message).not.toContain("auditor");
  });

  it("returns the readable checkpoints and reports the refused one from listRecent", async () => {
    const store = await checkpointsReadThrough([1, 3, 7], [3, { checkpointed_by: "" }]);

    const read = await store.listRecent(TENANT_A);
    expect(read.records.map((c) => c.sequenceNumber)).toEqual([7, 1]);
    expect(read.unreadable).toEqual([{ identity: "3", detail: "checkpointedBy: too_small" }]);
  });

  // The sharpest case, and the one a `.map` can never answer: the refused row is the newest, so a
  // caller reading only `.records` sees a history whose head is the row *before* the tamper and
  // nothing says so. `latest()` is the read that refuses there; this one reports.
  it("reports a refused row at the head of the history rather than shortening it silently", async () => {
    const store = await checkpointsReadThrough([1, 3, 7], [7, { checkpointed_by: "" }]);

    const read = await store.listRecent(TENANT_A);
    expect(read.records.map((c) => c.sequenceNumber)).toEqual([3, 1]);
    expect(read.unreadable.map((u) => u.identity)).toEqual(["7"]);
  });

  it("reports every refused row, not only the first", async () => {
    const store = await checkpointsReadThrough(
      [1, 3, 7],
      [1, { checkpointed_by: "" }],
      [7, { external_anchor_reference: "" }],
    );

    const read = await store.listRecent(TENANT_A);
    expect(read.records.map((c) => c.sequenceNumber)).toEqual([3]);
    expect(read.unreadable.map((u) => u.identity)).toEqual(["7", "1"]);
  });
});
