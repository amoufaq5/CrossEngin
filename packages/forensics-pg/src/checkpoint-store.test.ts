import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_PROVENANCES,
  checkpointAnchorsBoundedProof,
  type ChainCheckpoint,
  type CheckpointProvenance,
} from "@crossengin/forensics";

import {
  CHECKPOINT_SCAN_CEILING,
  CHECKPOINT_SCAN_PAGE_SIZE,
  CheckpointRowUnreadable,
  PostgresChainCheckpointStore,
  rowToCheckpoint,
  type CheckpointScanOptions,
  type CheckpointScanOutcome,
} from "./checkpoint-store.js";
import { fakeChainPg } from "./test-fakes.js";
import type { PgConnection, RowRead } from "@crossengin/kernel-pg";

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
  // mask a later `unverified` and license the very skip the provenance exists to refuse (ADR-0371).
  // Asserted on the recorded SQL, which is the fence rather than a workaround: `fakeChainPg` holds
  // the two rows and models the tiebreaker since ADR-0375 (it used to de-duplicate the platform
  // scope too, which was stricter than the real table), so a round trip through it would pass
  // whether the `ORDER BY` asked for the tiebreaker or the fake supplied it.
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

/** The pages a scan handed over, beside the outcome it ended with. */
interface Scanned {
  readonly outcome: CheckpointScanOutcome;
  readonly pages: readonly RowRead<ChainCheckpoint>[];
}

async function scanned(
  store: PostgresChainCheckpointStore,
  tenantId: string | null,
  opts?: CheckpointScanOptions,
): Promise<Scanned> {
  const pages: RowRead<ChainCheckpoint>[] = [];
  const outcome = await store.scanCheckpoints(tenantId, (page) => pages.push(page), opts);
  return { outcome, pages };
}

function sequencesIn(pages: readonly RowRead<ChainCheckpoint>[]): number[] {
  return pages.flatMap((page) => page.records.map((c) => c.sequenceNumber));
}

/** `sequences` real checkpoints in one scope, written through a clean connection. */
async function seeded(
  tenantId: string | null,
  sequences: readonly number[],
): Promise<PostgresChainCheckpointStore> {
  const store = new PostgresChainCheckpointStore(fakeChainPg());
  for (const s of sequences) await store.record(tenantId, checkpoint(s));
  return store;
}

/**
 * The anchor table read as a **set** rather than one row at a time (ADR-0375).
 *
 * `latest` is the detector a refused checkpoint reaches, and it is one row — so on a scope holding N
 * checkpoints the other N−1 could be edited with no verdict change at all. These cover the aperture
 * and the three properties the paging rests on: the direction, the `id` tiebreaker, and what
 * `complete` claims.
 */
describe("PostgresChainCheckpointStore.scanCheckpoints", () => {
  it("hands over one page for a scope that fits in one", async () => {
    const store = await seeded(TENANT_A, [1, 4, 9]);
    const { outcome, pages } = await scanned(store, TENANT_A);

    expect(sequencesIn(pages)).toEqual([1, 4, 9]);
    expect(outcome).toEqual({ scanned: 3, refusedCount: 0, complete: true });
  });

  it("pages ascending across the whole scope and visits every row once", async () => {
    const store = await seeded(TENANT_A, [1, 2, 3, 4, 5, 6, 7]);
    const { outcome, pages } = await scanned(store, TENANT_A, { pageSize: 3 });

    expect(pages.map((p) => p.records.length)).toEqual([3, 3, 1]);
    expect(sequencesIn(pages)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(outcome.complete).toBe(true);
    expect(outcome.scanned).toBe(7);
  });

  // The row a page ends at is the row the next page's cursor is made of, so it is the one position
  // where a predicate that is not strictly-after would show: either re-read (a duplicate in the
  // concatenation and an over-counted `scanned`) or stepped over. Asserted at every page size, so
  // every row in turn is a boundary row and the claim does not rest on where the boundary falls.
  it("visits the row a page boundary falls on exactly once, at every page size", async () => {
    const sequences = [1, 2, 3, 4, 5];
    for (const pageSize of [1, 2, 3, 4, 5, 6]) {
      const { outcome, pages } = await scanned(await seeded(TENANT_A, sequences), TENANT_A, {
        pageSize,
      });

      expect(sequencesIn(pages)).toEqual(sequences);
      expect(outcome.scanned).toBe(sequences.length);
      expect(outcome.complete).toBe(true);
    }
  });

  // A full last page cannot be read as the end, so the scan costs one more statement to prove it —
  // which is the price of `complete` being a claim about the set rather than about arithmetic.
  it("spends a page proving the end when the scope divides exactly by the page size", async () => {
    const store = await seeded(TENANT_A, [1, 2, 3, 4]);
    const { outcome, pages } = await scanned(store, TENANT_A, { pageSize: 2 });

    expect(pages.map((p) => p.records.length)).toEqual([2, 2, 0]);
    expect(outcome.complete).toBe(true);
    expect(outcome.scanned).toBe(4);
  });

  it("stops at the ceiling and says the scan is incomplete", async () => {
    const store = await seeded(TENANT_A, [1, 2, 3, 4, 5, 6, 7, 8]);
    const { outcome, pages } = await scanned(store, TENANT_A, { pageSize: 2, ceiling: 5 });

    // The last page is trimmed to the remaining budget rather than reading past it, so `scanned` is
    // the ceiling exactly and not the next multiple of the page size.
    expect(pages.map((p) => p.records.length)).toEqual([2, 2, 1]);
    expect(sequencesIn(pages)).toEqual([1, 2, 3, 4, 5]);
    expect(outcome.scanned).toBe(5);
    expect(outcome.complete).toBe(false);
  });

  // The conservative case, and the one documented at the `rows.length < limit` test: proving the end
  // of a scope holding exactly `ceiling` rows needs one more page, and the ceiling is the budget. A
  // consumer reads `complete: false` as *not proven*, which is the safe direction.
  it("reports incomplete for a scope holding exactly the ceiling, having read all of it", async () => {
    const store = await seeded(TENANT_A, [1, 2, 3]);
    const { outcome, pages } = await scanned(store, TENANT_A, { pageSize: 2, ceiling: 3 });

    expect(sequencesIn(pages)).toEqual([1, 2, 3]);
    expect(outcome.scanned).toBe(3);
    expect(outcome.complete).toBe(false);
  });

  // `complete: false` has exactly one cause, which is what lets a consumer read it as "the ceiling
  // stopped me" without a second field naming why. A zero budget is that cause degenerately: it
  // reads nothing and proves nothing, which is the honest answer rather than a vacuous `true`.
  it("answers a non-positive ceiling with an incomplete scan that read nothing", async () => {
    const store = await seeded(TENANT_A, [1, 2, 3]);
    const { outcome, pages } = await scanned(store, TENANT_A, { ceiling: 0 });

    expect(pages).toEqual([]);
    expect(outcome).toEqual({ scanned: 0, refusedCount: 0, complete: false });
  });

  // The floor on the page size is the only thing between a `LIMIT 0` and a loop that reads an empty
  // page for ever, since an empty page is indistinguishable from the end only by comparing against
  // the limit — and `0 < 0` is false.
  it("floors the page size, so a zero one still terminates", async () => {
    const store = await seeded(TENANT_A, [1, 2]);
    const { outcome, pages } = await scanned(store, TENANT_A, { pageSize: 0 });

    expect(sequencesIn(pages)).toEqual([1, 2]);
    expect(outcome.complete).toBe(true);
  });

  it("reads a scope with no checkpoints as a complete scan of nothing", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    const { outcome, pages } = await scanned(store, TENANT_A);

    expect(sequencesIn(pages)).toEqual([]);
    expect(outcome).toEqual({ scanned: 0, refusedCount: 0, complete: true });
  });

  it("scans one scope's checkpoints and neither another tenant's nor the platform's", async () => {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(TENANT_A, checkpoint(4));
    await store.record(TENANT_B, checkpoint(9));
    await store.record(null, checkpoint(900));

    expect(sequencesIn((await scanned(store, TENANT_A)).pages)).toEqual([4]);
    expect(sequencesIn((await scanned(store, TENANT_B)).pages)).toEqual([9]);
    expect(sequencesIn((await scanned(store, null)).pages)).toEqual([900]);
  });
});

/**
 * The direction, the cursor and the scope, asserted on the statements rather than on the rows.
 *
 * Three of these are properties no round trip through a fake can establish, because the fake answers
 * whatever shape it is handed: that the order is the ascending one the stable-prefix argument rests
 * on, that the cursor's sequence travels as a string through a `::bigint` cast, and that the
 * predicate carries the one conjunct that makes the paging linear rather than quadratic.
 */
describe("the statements scanCheckpoints issues", () => {
  interface Statement {
    readonly sql: string;
    readonly params: readonly unknown[];
  }

  async function scanStatements(
    tenantId: string | null,
    sequences: readonly number[],
    opts?: CheckpointScanOptions,
  ): Promise<{ seen: readonly Statement[]; reads: readonly Statement[] }> {
    const { conn, seen } = recording();
    const store = new PostgresChainCheckpointStore(conn);
    for (const s of sequences) await store.record(tenantId, checkpoint(s));
    seen.length = 0;
    await store.scanCheckpoints(tenantId, () => undefined, opts);
    return { seen, reads: seen.filter((q) => q.sql.includes("ORDER BY sequence_number ASC")) };
  }

  /** The statement as one line, so an assertion about its predicate is not about its indentation. */
  function flat(sql: string | undefined): string {
    return (sql ?? "").replace(/\s+/g, " ").trim();
  }

  // Ascending because this table is append-only in sequence order, so an ascending prefix is stable
  // under appends while a descending one shifts — a descending scan stopped by its ceiling would
  // leave the oldest rows unread and let a later append push a row out of reach, which is
  // ADR-0374's burial at ceiling depth instead of at depth 1.
  it("orders ascending by sequence and then by id", async () => {
    const { reads } = await scanStatements(TENANT_A, [1, 2]);
    expect(reads).not.toHaveLength(0);
    for (const q of reads) expect(q.sql).toContain("ORDER BY sequence_number ASC, id ASC");
  });

  // `id` is in the SELECT list only because the cursor is made of the pair; without it the scan
  // cannot advance, and the symptom would be a loop rather than a wrong answer.
  it("selects the id the cursor is made of beside the contract's own columns", async () => {
    const { reads } = await scanStatements(TENANT_A, [1]);
    expect(flat(reads[0]?.sql)).toContain("provenance, id FROM");
  });

  // Measured on PG 16.13 over a 200k-row scope: without this conjunct the plan is
  // `Index Cond: (tenant_id = $1)` with the disjunction left as a `Filter`, so page 100 removes
  // 100001 rows by filter (2745 buffers, 22.2 ms) and the full 200-page scan takes 4.86 s —
  // quadratic in the page count. With it the plan is
  // `Index Cond: ((tenant_id = $1) AND (sequence_number >= $2))`, 31 buffers, 0.563 ms, 0.13 s for
  // the whole scan. It reads as redundant (the disjunction implies it) and is not, so it is pinned
  // here rather than left to be simplified away.
  it("asks the index for the cursor's lower bound as well as the keyset disjunction", async () => {
    const { reads } = await scanStatements(TENANT_A, [1, 2], { pageSize: 1 });
    expect(reads).not.toHaveLength(0);
    for (const q of reads) {
      expect(flat(q.sql)).toContain("AND sequence_number >= $1::bigint");
      expect(flat(q.sql)).toContain(
        "AND (sequence_number > $1::bigint OR (sequence_number = $1::bigint AND id > $2::uuid))",
      );
    }
  });

  // A `BIGINT` comes back from node-postgres as a string (ADR-0331), and it is bound back as one
  // through the cast rather than passed through `Number`, which stops being the stored value past
  // 2^53 and would then re-read a row or step over one.
  it("binds the cursor's sequence as a string and casts it, starting below every row", async () => {
    const { reads } = await scanStatements(TENANT_A, [1, 2, 3], { pageSize: 1 });

    expect(reads.length).toBeGreaterThan(2);
    // `-1` and not `0`: the column's CHECK is `sequence_number >= 0`, so `-1` is strictly below
    // every row the table can hold and the first page needs no second statement shape.
    expect(reads[0]?.params[0]).toBe("-1");
    for (const q of reads) expect(typeof q.params[0]).toBe("string");
    // Page two starts strictly after page one's last row, as a string rather than a number.
    expect(reads[1]?.params[0]).toBe("1");
    expect(reads[2]?.params[0]).toBe("2");
  });

  it("binds the tenant scope last and asks for IS NULL on the platform scope", async () => {
    const tenant = await scanStatements(TENANT_A, [1]);
    for (const q of tenant.reads) {
      expect(q.sql).toContain("tenant_id = $4");
      expect(q.params).toHaveLength(4);
      expect(q.params[3]).toBe(TENANT_A);
    }

    const platform = await scanStatements(null, [1]);
    for (const q of platform.reads) {
      expect(q.sql).toContain("tenant_id IS NULL");
      expect(q.params).toHaveLength(3);
    }
  });

  // One transaction for the whole scan, so every page is read from one snapshot and the set a
  // verdict is computed over is the set that was on disk at one instant.
  it("reads every page inside one transaction", async () => {
    const { seen, reads } = await scanStatements(TENANT_A, [1, 2, 3, 4], { pageSize: 1 });

    expect(reads.length).toBeGreaterThan(3);
    expect(seen.filter((q) => q.sql.includes("app.current_tenant_id"))).toHaveLength(1);
    // A read never asks for the write elevation.
    expect(seen.some((q) => q.sql.includes("app.platform_audit_write"))).toBe(false);
  });

  it("defaults the two bounds rather than leaving them to a caller", async () => {
    expect(CHECKPOINT_SCAN_PAGE_SIZE).toBe(1_000);
    expect(CHECKPOINT_SCAN_CEILING).toBe(1_000_000);
    const { reads } = await scanStatements(TENANT_A, [1]);
    expect(reads[0]?.params[2]).toBe(CHECKPOINT_SCAN_PAGE_SIZE);
  });
});

/**
 * A refused anchor in the middle of a set, which is the whole reason this read exists: `latest`
 * reaches only the newest row, so every other refused checkpoint was a finding nothing could see.
 */
describe("scanCheckpoints over a scope holding a refused checkpoint", () => {
  it("returns the readable rows of a page beside the refused one", async () => {
    const store = await checkpointsReadThrough([1, 3, 7], [3, { checkpointed_by: "" }]);
    const { outcome, pages } = await scanned(store, TENANT_A);

    expect(sequencesIn(pages)).toEqual([1, 7]);
    expect(pages[0]?.unreadable).toEqual([{ identity: "3", detail: "checkpointedBy: too_small" }]);
    expect(outcome.refusedCount).toBe(1);
    expect(outcome.scanned).toBe(3);
    expect(outcome.complete).toBe(true);
  });

  // The case `latest` cannot answer at all, and the one the aperture was about: the refusal is
  // neither the newest row nor on the first page, so nothing before this read would have reported
  // it. The cursor comes off the **raw** row, so a refused row at a page boundary does not stall.
  it("counts a refused row in a middle page and keeps paging past it", async () => {
    const store = await checkpointsReadThrough(
      [1, 2, 3, 4, 5, 6],
      [3, { checkpointed_by: "" }],
      [4, { external_anchor_reference: "" }],
    );
    const { outcome, pages } = await scanned(store, TENANT_A, { pageSize: 2 });

    expect(sequencesIn(pages)).toEqual([1, 2, 5, 6]);
    expect(pages[1]?.records).toEqual([]);
    expect(pages[1]?.unreadable.map((u) => u.identity)).toEqual(["3", "4"]);
    expect(outcome.refusedCount).toBe(2);
    // Refused rows are scanned rows: the ceiling bounds the work, not the readable answer.
    expect(outcome.scanned).toBe(6);
    expect(outcome.complete).toBe(true);
  });

  // A scope every one of whose rows is refused is still a scope that was *read*, and it has to
  // report so on the two fields that carry it: `scanned` counts rows and not records, and the scan
  // runs to the end. Paged so the refused-only case also pins the cursor advancing, which is the one
  // way an unreadable page could stall a sweep rather than merely empty it — the whole point of
  // taking the cursor off the raw row.
  it("reads a scope whose every row is refused to the end, counting the rows", async () => {
    const store = await checkpointsReadThrough(
      [1, 2, 3, 4],
      [1, { checkpointed_by: "" }],
      [2, { checkpointed_by: "" }],
      [3, { checkpointed_by: "" }],
      [4, { checkpointed_by: "" }],
    );
    const { outcome, pages } = await scanned(store, TENANT_A, { pageSize: 2 });

    expect(sequencesIn(pages)).toEqual([]);
    expect(pages.map((p) => p.unreadable.map((u) => u.identity))).toEqual([
      ["1", "2"],
      ["3", "4"],
      [],
    ]);
    expect(outcome).toEqual({ scanned: 4, refusedCount: 4, complete: true });
  });

  // The narrowest form of the same invariant: at `pageSize: 1` a refused row is a *full* page, so
  // the loop does not take the short-page exit and `cursorFrom` is handed the refused row itself.
  // If it read the mapped record instead there would be none, and the scan would stall on the first
  // tampered anchor — reporting a clean short history rather than a finding.
  it("advances the cursor off a refused row that fills its own page", async () => {
    const store = await checkpointsReadThrough([1, 3, 7], [3, { checkpointed_by: "" }]);
    const { outcome, pages } = await scanned(store, TENANT_A, { pageSize: 1 });

    expect(sequencesIn(pages)).toEqual([1, 7]);
    expect(outcome).toEqual({ scanned: 3, refusedCount: 1, complete: true });
  });

  // The termination argument rests on the cursor coming off the pair, so a SELECT list that lost
  // `id` must fail by name rather than loop. Patched to `undefined` on the way out, which is what a
  // dropped column looks like from here.
  it("refuses by name rather than looping when a page carries no id", async () => {
    const store = await checkpointsReadThrough([1, 2], [1, { id: undefined }]);
    await expect(
      store.scanCheckpoints(TENANT_A, () => undefined, { pageSize: 1 }),
    ).rejects.toThrow(/sequence_number and id/);
  });
});

/**
 * Two rows at **one** sequence, which `UNIQUE (tenant_id, sequence_number)` does not prevent for the
 * platform scope: `tenant_id` is nullable, NULL means platform, and SQL treats NULLs as distinct, so
 * `(NULL, 3)` twice is two legal rows and `ON CONFLICT … DO NOTHING` never fires there (ADR-0371).
 * Verified live on PG 16.13 — the same two statements leave 2 rows at one platform sequence and 1 at
 * one tenant sequence, and a `pageSize: 1` ascending scan from `(777776, nil)` answers
 * `(777777,first)` then `(777777,second)` then nothing.
 *
 * It is why the cursor is the **pair**: a sequence-only cursor would either loop on the first of
 * them for ever or step over the second, and both are wrong in a scan whose job is to examine every
 * anchor.
 */
describe("scanCheckpoints over two checkpoints at one platform sequence", () => {
  async function doubledPlatformSequence(): Promise<PostgresChainCheckpointStore> {
    const store = new PostgresChainCheckpointStore(fakeChainPg());
    await store.record(null, checkpoint(3, { checkpointedBy: "first" }));
    await store.record(null, checkpoint(3, { checkpointedBy: "second" }));
    await store.record(null, checkpoint(4));
    return store;
  }

  it("visits each of them exactly once, in id order, however the page boundary falls", async () => {
    for (const pageSize of [1, 2, 3, 4]) {
      const { outcome, pages } = await scanned(await doubledPlatformSequence(), null, { pageSize });

      expect(sequencesIn(pages)).toEqual([3, 3, 4]);
      expect(pages.flatMap((p) => p.records.map((c) => c.checkpointedBy))).toEqual([
        "first",
        "second",
        "auditor",
      ]);
      expect(outcome.scanned).toBe(3);
      expect(outcome.complete).toBe(true);
    }
  });

  /**
   * The non-termination case, and the reason the `id` arm is strictly `>` rather than `>=`.
   *
   * Both arms of the disjunction have to be strict for the predicate to be strictly-after on the
   * **pair**. With `id >= $2` the sequence arm is still strict and the `id` arm re-admits the row
   * the cursor was taken from, so a page boundary inside a run of one sequence re-reads its own last
   * row: progress becomes `pageSize - 1` rows a page, `scanned` over-counts, and `onPage` hands a
   * refused row at a boundary to the consumer **twice**. Where a single sequence holds at least
   * `pageSize` rows it does not progress at all — the page comes back full and identical for ever,
   * bounded only by the ceiling, which would then report `complete: false` for a scope nothing read
   * past its first page.
   *
   * That is reachable on the platform scope and nowhere else, which is what makes it worth a fixture
   * rather than a comment: the duplicate sequences are the very thing the tiebreaker exists for.
   * Measured by mutating the store to `id >= $2::uuid`: 17 of these 23 tests fail, and this
   * describe's cases are among them.
   */
  it("terminates and visits each row once where one sequence fills a whole page", async () => {
    for (const pageSize of [1, 2, 3, 4]) {
      const store = new PostgresChainCheckpointStore(fakeChainPg());
      for (const by of ["first", "second", "third"]) {
        await store.record(null, checkpoint(3, { checkpointedBy: by }));
      }
      const { outcome, pages } = await scanned(store, null, { pageSize });

      expect(pages.flatMap((p) => p.records.map((c) => c.checkpointedBy))).toEqual([
        "first",
        "second",
        "third",
      ]);
      // `scanned` is the row count and not a page-boundary tally, which is what over-counting the
      // boundary row would break first.
      expect(outcome.scanned).toBe(3);
      expect(outcome.complete).toBe(true);
    }
  });

  // The boundary that a sequence-only cursor gets wrong: page one ends *between* the two, so page
  // two has to resolve the `id` arm of the disjunction rather than the sequence arm.
  it("resumes after the first of the pair rather than re-reading or skipping it", async () => {
    const { conn, seen } = recording();
    const store = new PostgresChainCheckpointStore(conn);
    await store.record(null, checkpoint(3, { checkpointedBy: "first" }));
    await store.record(null, checkpoint(3, { checkpointedBy: "second" }));
    seen.length = 0;

    const pages: RowRead<ChainCheckpoint>[] = [];
    await store.scanCheckpoints(null, (page) => pages.push(page), { pageSize: 1 });

    expect(pages.flatMap((p) => p.records.map((c) => c.checkpointedBy))).toEqual([
      "first",
      "second",
    ]);
    const reads = seen.filter((q) => q.sql.includes("ORDER BY sequence_number ASC"));
    // Page two's cursor is the same sequence and a greater id — the pair, not the sequence.
    expect(reads[1]?.params[0]).toBe("3");
    expect(reads[2]?.params[0]).toBe("3");
    expect(String(reads[2]?.params[1])).not.toBe(String(reads[1]?.params[1]));
  });
});
