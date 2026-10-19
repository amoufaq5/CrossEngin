import { describe, expect, it, vi } from "vitest";
import { InMemoryKeyStore } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  GENESIS_HASH,
  verifyChainEntrySignature,
  verifyChainIntegrity,
} from "@crossengin/forensics";

import {
  ChainAnchorNotVerified,
  PostgresChainLogReader,
  PostgresChainLogStore,
  advisoryKeyFor,
  unreadableEntryVerdict,
} from "./chain-log-store.js";
import { PostgresChainCheckpointStore } from "./checkpoint-store.js";
import { keyStoreChainSigner } from "./signer.js";
import { fakeChainPg } from "./test-fakes.js";
import { SET_PLATFORM_AUDIT_WRITE_SQL, SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const AT = "2026-06-01T00:00:00.000Z";

async function newStore() {
  const keyStore = new InMemoryKeyStore();
  const record = await keyStore.createKey({
    tenantId: null,
    algorithm: "ed25519",
    purpose: "evidence_sealing",
  });
  const publicKeyBase64 = await keyStore.getPublicMaterial(record.handle);
  const signer = keyStoreChainSigner(keyStore, record, null);
  const store = new PostgresChainLogStore(fakeChainPg(), signer);
  return { store, publicKeyBase64 };
}

function append(store: PostgresChainLogStore, tenantId: string | null, n: number) {
  return store.append({
    tenantId,
    kind: "audit_event",
    actorReference: "gateway",
    recordedAt: AT,
    payload: `event-${n.toString()}`,
  });
}

describe("PostgresChainLogStore.append", () => {
  it("produces a genesis-anchored, hash-linked, verifiable chain", async () => {
    const { store, publicKeyBase64 } = await newStore();

    const e0 = await append(store, TENANT_A, 0);
    const e1 = await append(store, TENANT_A, 1);
    const e2 = await append(store, TENANT_A, 2);

    expect([e0.sequenceNumber, e1.sequenceNumber, e2.sequenceNumber]).toEqual([0, 1, 2]);
    expect(e0.priorEntryHash).toBe(GENESIS_HASH);
    expect(e1.priorEntryHash).toBe(e0.entryHash);
    expect(e2.priorEntryHash).toBe(e1.entryHash);

    const { entries, unreadable } = await store.loadChain(TENANT_A);
    // `unreadable` is asserted rather than discarded, because this test's claim is that the chain is
    // VERIFIABLE and a read that refused a row would hand `verifyChainIntegrity` a shorter array it
    // would pronounce valid. The empty list is the claim that there was nothing to refuse.
    expect(unreadable).toEqual([]);
    expect(entries).toHaveLength(3);
    expect(verifyChainIntegrity(entries).valid).toBe(true);
    for (const entry of entries) {
      expect(verifyChainEntrySignature(entry, publicKeyBase64)).toBe(true);
    }
  });

  it("reports the tail and next sequence", async () => {
    const { store } = await newStore();
    expect(await store.tail(TENANT_A)).toBeNull();
    const e0 = await append(store, TENANT_A, 0);
    const tail = await store.tail(TENANT_A);
    expect(tail).toEqual({ sequenceNumber: 0, entryHash: e0.entryHash });
  });

  it("isolates chains per tenant — each starts fresh at genesis", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const b0 = await append(store, TENANT_B, 0);

    expect(b0.sequenceNumber).toBe(0);
    expect(b0.priorEntryHash).toBe(GENESIS_HASH);
    expect((await store.loadChain(TENANT_A)).entries).toHaveLength(2);
    expect((await store.loadChain(TENANT_B)).entries).toHaveLength(1);
    expect(verifyChainIntegrity((await store.loadChain(TENANT_B)).entries).valid).toBe(true);
  });

  it("supports a platform (null-tenant) chain", async () => {
    const { store } = await newStore();
    await append(store, null, 0);
    await append(store, null, 1);
    const { entries, unreadable } = await store.loadChain(null);
    expect(unreadable).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(verifyChainIntegrity(entries).valid).toBe(true);
  });

  it("verify() returns the integrity verdict for a scope", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    expect(await store.verify(TENANT_A)).toEqual({ valid: true, brokenAt: null });
  });

  it("rejects a malformed tenant id and a bad schema", async () => {
    const { store } = await newStore();
    await expect(
      store.append({ tenantId: "not-a-uuid" as string, kind: "audit_event", actorReference: "x", recordedAt: AT, payload: "p" }),
    ).rejects.toThrow();
    const keyStore = new InMemoryKeyStore();
    const rec = await keyStore.createKey({ tenantId: null, algorithm: "ed25519", purpose: "evidence_sealing" });
    expect(
      () => new PostgresChainLogStore(fakeChainPg(), keyStoreChainSigner(keyStore, rec, null), { schema: "Bad-Schema" }),
    ).toThrow(/schema/);
  });
});

/** Wraps a connection so every `loadFrom` (`WHERE sequence_number >=`) read corrupts the tail row's link. */
function tamperingConn(inner: PgConnection): PgConnection {
  const wrap = (c: PgConnection): PgConnection => ({
    query: (async (sql: string, params?: readonly unknown[]) => {
      const res = await c.query(sql, params);
      if (sql.includes("sequence_number >=") && res.rows.length > 0) {
        const rows = res.rows.map((r) => ({ ...r }) as Record<string, unknown>);
        rows[rows.length - 1]!["prior_entry_hash"] = "f".repeat(64);
        return { rows, rowCount: rows.length };
      }
      return res;
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
      inner.transaction((tx) => fn(wrap(tx)))) as PgConnection["transaction"],
    withAdvisoryLock: c.withAdvisoryLock,
    close: c.close,
  });
  return wrap(inner);
}

describe("PostgresChainLogStore checkpoint anchoring", () => {
  it("createCheckpoint anchors at the tail, and a bounded verify refuses the hand-placed anchor", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const e2 = await append(store, TENANT_A, 2);

    const cp = await store.createCheckpoint(TENANT_A, {
      checkpointedBy: "auditor",
      checkpointedAt: AT,
      // A hand-placed anchor has no verification behind it, and `provenance` is required so it has
      // to say so rather than leaving the field absent — which on a stored row means an older
      // binary wrote it (ADR-0331). This is `unverified`'s producer.
      provenance: "unverified",
    });
    expect(cp.sequenceNumber).toBe(2);
    expect(cp.rootHash).toBe(e2.entryHash);

    await append(store, TENANT_A, 3);
    await append(store, TENANT_A, 4);

    // The pair this test used to assert as one fact: it anchored, and then it VERIFIED from that
    // anchor and reported the suffix clear. The second half was the defect — `unverified` says
    // nothing vouched for the prefix, so a verdict bounded on it describes a chain nobody folded.
    await expect(store.verifyFromCheckpoint(TENANT_A, cp)).rejects.toThrow(/provenance is unverified/);
  });

  it("verifyFromCheckpoint clears the suffix from an anchor something verified", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const e2 = await append(store, TENANT_A, 2);

    const cp = await store.createCheckpoint(TENANT_A, {
      checkpointedBy: "scheduler",
      checkpointedAt: AT,
      provenance: "verified_full",
    });
    expect(cp.rootHash).toBe(e2.entryHash);

    await append(store, TENANT_A, 3);
    await append(store, TENANT_A, 4);

    expect(await store.verifyFromCheckpoint(TENANT_A, cp)).toEqual({ valid: true, brokenAt: null });
  });

  it("verifyFromCheckpoint refuses an anchor whose provenance is absent", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    const e1 = await append(store, TENANT_A, 1);

    // The state every checkpoint written before ADR-0371 is in, and the one a `.nullable()` column
    // hands back. Distinct from `unverified` — that row states nothing checked it, this one does not
    // cover the question at all — so the message must name which, and both must refuse.
    await expect(
      store.verifyFromCheckpoint(TENANT_A, {
        sequenceNumber: 1,
        rootHash: e1.entryHash,
        checkpointedAt: AT,
        checkpointedBy: "an older binary",
        algorithm: "sha256",
      }),
    ).rejects.toThrow(/provenance is absent/);
  });

  it("loadFrom returns only the entries at or after the given sequence", async () => {
    const { store } = await newStore();
    for (let i = 0; i < 4; i++) await append(store, TENANT_A, i);
    const from2 = await store.loadFrom(TENANT_A, 2);
    expect(from2.entries.map((e) => e.sequenceNumber)).toEqual([2, 3]);
    expect(from2.unreadable).toEqual([]);
  });

  it("createCheckpoint throws on an empty chain", async () => {
    const { store } = await newStore();
    await expect(
      store.createCheckpoint(TENANT_A, { checkpointedBy: "auditor", provenance: "unverified" }),
    ).rejects.toThrow(/empty chain/);
  });

  it("createCheckpoint reads the tail and not the whole chain", async () => {
    // ADR-0371: it used to `loadChain`, so a checkpoint pass cost a third full read of the chain
    // beside the verification's two — and worse, that read is what chose the anchored sequence,
    // which is why the scheduler builds from `checkpointFromTail` over a tail it holds itself.
    // Pinned on which read it makes, because the answer is identical either way:
    // `lastEntryHash(entries)` on a non-empty chain IS the tail row's `entry_hash`, so no assertion
    // on the resulting checkpoint can tell the two apart.
    const { store } = await newStore();
    for (let i = 0; i < 4; i++) await append(store, TENANT_A, i);
    const loadChain = vi.spyOn(store, "loadChain");
    const tail = vi.spyOn(store, "tail");

    const cp = await store.createCheckpoint(TENANT_A, {
      checkpointedBy: "auditor",
      provenance: "unverified",
    });

    expect(tail).toHaveBeenCalledTimes(1);
    expect(tail).toHaveBeenCalledWith(TENANT_A);
    expect(loadChain).not.toHaveBeenCalled();
    expect(cp.sequenceNumber).toBe(3);
  });

  it("carries a provenance from createCheckpoint all the way to what latest() answers", async () => {
    // The one-line thread `createCheckpoint` -> `checkpointFromTail` -> `record` -> `latest` is
    // what a bounded verification's whole soundness rests on (ADR-0371), and before this it was
    // covered by nothing: each half had its own test and no test crossed the seam. It is also what
    // makes `fakeChainPg`'s modelling of the column load-bearing — the fake used to read seven
    // parameters of this statement and the eighth was dropped on the floor, which `assertBindArity`
    // cannot see because the statement and the array agree on eight.
    const keyStore = new InMemoryKeyStore();
    const record = await keyStore.createKey({
      tenantId: null,
      algorithm: "ed25519",
      purpose: "evidence_sealing",
    });
    const conn = fakeChainPg();
    const store = new PostgresChainLogStore(conn, keyStoreChainSigner(keyStore, record, null));
    const checkpoints = new PostgresChainCheckpointStore(conn);

    await append(store, TENANT_A, 0);
    const tail = await append(store, TENANT_A, 1);

    const cp = await store.createCheckpoint(TENANT_A, {
      checkpointedBy: "auditor",
      checkpointedAt: AT,
      provenance: "verified_full",
    });
    expect(cp.provenance).toBe("verified_full");
    await checkpoints.record(TENANT_A, cp);

    const stored = await checkpoints.latest(TENANT_A);
    expect(stored?.provenance).toBe("verified_full");
    expect(stored?.rootHash).toBe(tail.entryHash);
  });

  it("verifyFromCheckpoint reports a break when an after-checkpoint entry is tampered", async () => {
    const keyStore = new InMemoryKeyStore();
    const record = await keyStore.createKey({
      tenantId: null,
      algorithm: "ed25519",
      purpose: "evidence_sealing",
    });
    const signer = keyStoreChainSigner(keyStore, record, null);
    const store = new PostgresChainLogStore(tamperingConn(fakeChainPg()), signer);

    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const cp = await store.createCheckpoint(TENANT_A, {
      checkpointedBy: "auditor",
      checkpointedAt: AT,
      // A hand-placed anchor has no verification behind it, and `provenance` is required so it has
      // to say so rather than leaving the field absent — which on a stored row means an older
      // binary wrote it (ADR-0331). This is `unverified`'s producer.
      //
      // `verified_full` here and not `unverified`: this test's subject is the FOLD, and a bounded
      // verify now refuses an unvouched anchor before it reads a row, so under `unverified` the
      // assertion below would never be reached.
      provenance: "verified_full",
    });
    await append(store, TENANT_A, 2);
    await append(store, TENANT_A, 3);

    const verdict = await store.verifyFromCheckpoint(TENANT_A, cp);
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAt).toBe(3);
  });
});

async function newSignerAndKey() {
  const keyStore = new InMemoryKeyStore();
  const record = await keyStore.createKey({ tenantId: null, algorithm: "ed25519", purpose: "evidence_sealing" });
  const publicKeyBase64 = await keyStore.getPublicMaterial(record.handle);
  return { signer: keyStoreChainSigner(keyStore, record, null), publicKeyBase64 };
}

describe("PostgresChainLogReader (signer-free)", () => {
  it("reads + integrity-verifies a chain a store wrote, without a signing key", async () => {
    const { signer, publicKeyBase64 } = await newSignerAndKey();
    const conn = fakeChainPg();
    const store = new PostgresChainLogStore(conn, signer);
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);

    // A reader over the SAME connection — constructed with NO signer.
    const reader = new PostgresChainLogReader(conn);
    const { entries, unreadable } = await reader.loadChain(TENANT_A);
    expect(unreadable).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(verifyChainIntegrity(entries).valid).toBe(true);
    for (const entry of entries) {
      expect(verifyChainEntrySignature(entry, publicKeyBase64)).toBe(true);
    }
    expect(await reader.verify(TENANT_A)).toEqual({ valid: true, brokenAt: null });
  });

  it("the store is a reader (checkpoint + suffix verify work through the base type)", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const reader: PostgresChainLogReader = store;
    const cp = await reader.createCheckpoint(TENANT_A, {
      checkpointedBy: "auditor",
      checkpointedAt: AT,
      provenance: "unverified",
    });
    expect(cp.sequenceNumber).toBe(1);
    // This assertion used to read `{valid: true, brokenAt: null}` — an EMPTY suffix over an anchor
    // nothing vouched for, which is exactly the vacuous claim ADR-0371 closed in
    // `verifyChainFromCheckpoint`, pinned here as a feature. `verifyChainSuffix([])` is valid by
    // construction, so the whole verdict rested on the provenance this path never read.
    await expect(reader.verifyFromCheckpoint(TENANT_A, cp)).rejects.toThrow(ChainAnchorNotVerified);
    expect(
      await reader.verifyFromCheckpoint(TENANT_A, { ...cp, provenance: "verified_suffix" }),
    ).toEqual({ valid: true, brokenAt: null });
  });

  it("rejects a bad schema on the reader too", () => {
    expect(() => new PostgresChainLogReader(fakeChainPg(), { schema: "Bad-Schema" })).toThrow(/schema/);
  });
});

/**
 * Serves every full chain-entry read with `patch` applied to the row at that sequence — the offline
 * stand-in for the `UPDATE meta.forensic_chain_entries SET actor_reference = ''` ADR-0373 ran live
 * as the non-owner `serving` role, which was `UPDATE 1` because that column is `TEXT NOT NULL` with
 * no CHECK while the contract declares `z.string().min(1)`.
 *
 * It patches the **read** and never the stored row, so one helper covers `loadChain` and `loadFrom`
 * alike and the append path still writes a genuinely signed chain — which is what makes the tamper a
 * tamper rather than a fixture. Keyed on `actor_reference` appearing in the SELECT list, which
 * `READ_COLUMNS` has and the one-row tail read does not, so an append still reads an untouched tail
 * and chains onto it.
 */
function patchedReadConn(
  inner: PgConnection,
  ...patches: readonly [number, Record<string, unknown>][]
): PgConnection {
  const bySequence = new Map(patches);
  const wrap = (c: PgConnection): PgConnection => ({
    query: (async (sql: string, params?: readonly unknown[]) => {
      const res = await c.query(sql, params);
      if (!sql.includes("SELECT") || !sql.includes("actor_reference")) return res;
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

/** `entryCount` real signed entries written through a clean connection, read back through a patched one. */
async function chainReadThrough(
  entryCount: number,
  ...patches: readonly [number, Record<string, unknown>][]
): Promise<PostgresChainLogReader> {
  const { signer } = await newSignerAndKey();
  const conn = fakeChainPg();
  const store = new PostgresChainLogStore(conn, signer);
  for (let i = 0; i < entryCount; i++) await append(store, TENANT_A, i);
  return new PostgresChainLogReader(patchedReadConn(conn, ...patches));
}

describe("a stored row the contract refuses", () => {
  it("returns the readable entries and reports the refused row by its sequence", async () => {
    const reader = await chainReadThrough(3, [1, { actor_reference: "" }]);

    const read = await reader.loadChain(TENANT_A);

    expect(read.entries.map((e) => e.sequenceNumber)).toEqual([0, 2]);
    // Two fields and no more: the business key, which is what a `WHERE` clause needs, and the cause.
    expect(read.unreadable).toEqual([{ identity: "1", detail: "actorReference: too_small" }]);
  });

  it("names the field path and the issue code, and no value from the row", async () => {
    // `kind` rather than `actor_reference` because `invalid_enum_value` is the one zod issue that
    // carries `received` — the stored value — which is exactly what `unreadableDetail` exists to
    // drop. A tamper can put anything in that column, and `detail` travels into a verdict, a log
    // line and a stored record.
    const forged = "user:alice@example.test";
    const reader = await chainReadThrough(2, [0, { kind: forged }]);

    const read = await reader.loadChain(TENANT_A);

    expect(read.unreadable).toHaveLength(1);
    expect(read.unreadable[0]!.detail).toBe("kind: invalid_enum_value");
    expect(read.unreadable[0]!.detail).not.toContain(forged);
    expect(read.unreadable[0]!.detail).not.toContain("alice");
    // The one thing it does name is the row to go and look at, which is the whole of what a remedy
    // needs — and the sequence is a column the caller supplied the predicate for, not a value the
    // refusal was about.
    expect(read.unreadable[0]!.identity).toBe("0");
    expect(read.entries.map((e) => e.sequenceNumber)).toEqual([1]);
  });

  it("reports identity null when the sequence itself does not read, and keeps the other rows", async () => {
    const reader = await chainReadThrough(3, [1, { sequence_number: "not-a-sequence" }]);

    const read = await reader.loadChain(TENANT_A);

    expect(read.entries.map((e) => e.sequenceNumber)).toEqual([0, 2]);
    expect(read.unreadable).toEqual([{ identity: null, detail: "sequenceNumber: invalid_type" }]);
    // `null` says the row does not name a handle rather than inventing one, and the verdict declines
    // to guess a position from it.
    expect(unreadableEntryVerdict(read.unreadable)?.brokenAt).toBeNull();
  });

  it("loadFrom answers the same way, since the two entry points share one read", async () => {
    const reader = await chainReadThrough(4, [2, { actor_reference: "" }]);

    const read = await reader.loadFrom(TENANT_A, 1);

    expect(read.entries.map((e) => e.sequenceNumber)).toEqual([1, 3]);
    expect(read.unreadable).toEqual([{ identity: "2", detail: "actorReference: too_small" }]);
  });

  it("verify() refuses a chain whose refused row the fold would have called clean", async () => {
    // The precedence as a measurement rather than an ordering preference. The refused row is the
    // TAIL, so what read is [0, 1] — a contiguous genesis-anchored chain the fold pronounces valid.
    // Without `unreadableEntryVerdict` in front of it, `verify()` calls a chain carrying a
    // signature-breaking tamper healthy.
    const reader = await chainReadThrough(3, [2, { actor_reference: "" }]);

    const read = await reader.loadChain(TENANT_A);
    expect(verifyChainIntegrity(read.entries)).toEqual({ valid: true, brokenAt: null });

    const verdict = await reader.verify(TENANT_A);
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAt).toBe(2);
    expect(verdict.reason).toContain("the contract refuses");
  });

  it("verify() names the row that is there, and never a sequence gap", async () => {
    // A refused row in the MIDDLE is where the two answers diverge in kind rather than in value:
    // `verifyChainIntegrity` walks the array it was handed, so the hole reads to it as a deleted
    // entry — a true statement about the array and a false one about the table, which sends an
    // operator looking for a row that is present and malformed. The two answers are asserted side
    // by side because that is the whole content of the decision.
    const reader = await chainReadThrough(3, [1, { actor_reference: "" }]);

    const read = await reader.loadChain(TENANT_A);
    expect(verifyChainIntegrity(read.entries).reason).toBe("sequence gap");

    const verdict = await reader.verify(TENANT_A);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).not.toBe("sequence gap");
    expect(verdict.reason).toBe("1 entry the contract refuses (first: actorReference: too_small)");
  });

  it("counts every refused row and points at the first", async () => {
    // Two refusals of different causes, so `detail` is the FIRST row's cause and not a merge: the
    // verdict is a handle onto one row to go and read, and a merged cause names none of them.
    const reader = await chainReadThrough(
      4,
      [1, { actor_reference: "" }],
      [3, { kind: "not-a-log-kind" }],
    );

    const verdict = await reader.verify(TENANT_A);

    expect(verdict.brokenAt).toBe(1);
    expect(verdict.reason).toBe("2 entries the contract refuses (first: actorReference: too_small)");
  });

  it("unreadableEntryVerdict answers null when every row read, so the fold decides", () => {
    expect(unreadableEntryVerdict([])).toBeNull();
  });
});

describe("advisoryKeyFor", () => {
  it("is deterministic, scope-specific, and 64-bit", () => {
    expect(advisoryKeyFor(TENANT_A)).toBe(advisoryKeyFor(TENANT_A));
    expect(advisoryKeyFor(TENANT_A)).not.toBe(advisoryKeyFor(TENANT_B));
    expect(advisoryKeyFor(null)).not.toBe(advisoryKeyFor(TENANT_A));
    const k = advisoryKeyFor(TENANT_A);
    expect(k >= -(2n ** 63n) && k < 2n ** 63n).toBe(true);
  });
});

describe("PostgresChainLogStore.appendWithin", () => {
  it("links onto the caller's transaction and produces the same chain as append", async () => {
    const keyStore = new InMemoryKeyStore();
    const record = await keyStore.createKey({
      tenantId: null,
      algorithm: "ed25519",
      purpose: "evidence_sealing",
    });
    const conn = fakeChainPg();
    const store = new PostgresChainLogStore(conn, keyStoreChainSigner(keyStore, record, null));

    const e0 = await conn.transaction(async (tx) => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [TENANT_A]);
      return store.appendWithin(tx, {
        tenantId: TENANT_A,
        kind: "audit_event",
        actorReference: "emitter",
        recordedAt: AT,
        payload: "anchored-0",
      });
    });
    const e1 = await conn.transaction(async (tx) => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [TENANT_A]);
      return store.appendWithin(tx, {
        tenantId: TENANT_A,
        kind: "audit_event",
        actorReference: "emitter",
        recordedAt: AT,
        payload: "anchored-1",
      });
    });

    expect([e0.sequenceNumber, e1.sequenceNumber]).toEqual([0, 1]);
    expect(e0.priorEntryHash).toBe(GENESIS_HASH);
    expect(e1.priorEntryHash).toBe(e0.entryHash);
    expect(await store.verify(TENANT_A)).toMatchObject({ valid: true });
  });

  it("continues a chain started by append, so both paths share one chain per scope", async () => {
    const { store } = await newStore();
    const viaAppend = await append(store, TENANT_A, 0);
    const conn = (store as unknown as { conn: PgConnection }).conn;
    const viaWithin = await conn.transaction(async (tx) => {
      await tx.query(SET_TENANT_CONTEXT_SQL, [TENANT_A]);
      return store.appendWithin(tx, {
        tenantId: TENANT_A,
        kind: "audit_event",
        actorReference: "emitter",
        recordedAt: AT,
        payload: "anchored",
      });
    });
    expect(viaWithin.sequenceNumber).toBe(1);
    expect(viaWithin.priorEntryHash).toBe(viaAppend.entryHash);
  });

  it("takes the per-scope advisory lock itself, since chain linearity depends on it", async () => {
    const { store } = await newStore();
    const conn = (store as unknown as { conn: PgConnection }).conn;
    const seen: string[] = [];
    const spy: PgConnection = {
      ...conn,
      query: (async (sql: string, params?: readonly unknown[]) => {
        seen.push(sql);
        return conn.query(sql, params);
      }) as PgConnection["query"],
    };
    // The context is the caller's to set, and without it the insert is refused — by the fake and by
    // the real policy alike, since a tenant row only ever passes the isolation policy.
    await spy.query(SET_TENANT_CONTEXT_SQL, [TENANT_A]);
    await store.appendWithin(spy, {
      tenantId: TENANT_A,
      kind: "audit_event",
      actorReference: "emitter",
      recordedAt: AT,
      payload: "x",
    });
    expect(seen.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
  });

  it("rejects an invalid tenant id before touching the transaction", async () => {
    const { store } = await newStore();
    const conn = (store as unknown as { conn: PgConnection }).conn;
    await expect(
      conn.transaction((tx) =>
        store.appendWithin(tx, {
          tenantId: "not a uuid; DROP TABLE x",
          kind: "audit_event",
          actorReference: "emitter",
          recordedAt: AT,
          payload: "x",
        }),
      ),
    ).rejects.toThrow();
  });
});

/**
 * Every read binds its scope, so a deployment connected as the table owner — for whom RLS is
 * bypassed — cannot be served another scope's chain. Asserted on the recorded SQL and parameters as
 * well as on the rows, because the rows are only right while the fake is right.
 */
describe("scope predicates on reads", () => {
  function recordingConn(): { conn: PgConnection; seen: { sql: string; params: unknown[] }[] } {
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

  function selects(seen: { sql: string; params: unknown[] }[]) {
    return seen.filter((q) => q.sql.includes("SELECT") && q.sql.includes("forensic_chain_entries"));
  }

  it("keeps a tenant's chain out of the platform's, and the platform's out of a tenant's", async () => {
    const { signer } = await newSignerAndKey();
    const conn = fakeChainPg();
    const store = new PostgresChainLogStore(conn, signer);
    const platform0 = await append(store, null, 0);
    const tenant0 = await append(store, TENANT_A, 0);

    // The defect this pins: the tenant's FIRST entry took sequence 1 and chained onto the
    // platform tail, because `tailWithin` read the global maximum.
    expect(platform0.sequenceNumber).toBe(0);
    expect(tenant0.sequenceNumber).toBe(0);
    expect(tenant0.priorEntryHash).toBe(GENESIS_HASH);

    const reader = new PostgresChainLogReader(conn);
    expect((await reader.loadChain(null)).entries).toHaveLength(1);
    expect((await reader.loadChain(TENANT_A)).entries).toHaveLength(1);
    expect(await reader.tail(null)).toEqual({ sequenceNumber: 0, entryHash: platform0.entryHash });
    expect(await reader.tail(TENANT_A)).toEqual({ sequenceNumber: 0, entryHash: tenant0.entryHash });
    // Two independent single-entry chains, each valid — where one interleaved chain of
    // [0, 0] reports a sequence gap.
    expect(await reader.verify(null)).toEqual({ valid: true, brokenAt: null });
    expect(await reader.verify(TENANT_A)).toEqual({ valid: true, brokenAt: null });
  });

  it("binds the tenant as an equality parameter, which is the indexable form", async () => {
    const { conn, seen } = recordingConn();
    const reader = new PostgresChainLogReader(conn);
    await reader.loadChain(TENANT_A);
    await reader.loadFrom(TENANT_A, 7);
    await reader.tail(TENANT_A);
    const reads = selects(seen);
    expect(reads).toHaveLength(3);
    for (const q of reads) {
      expect(q.sql).toMatch(/tenant_id = \$\d/);
      expect(q.params).toContain(TENANT_A);
    }
    expect(reads[1]?.params).toEqual([7, TENANT_A]);
  });

  it("asks for the platform scope as IS NULL, since `tenant_id = NULL` is never true", async () => {
    const { conn, seen } = recordingConn();
    const reader = new PostgresChainLogReader(conn);
    await reader.loadChain(null);
    await reader.loadFrom(null, 7);
    await reader.tail(null);
    const reads = selects(seen);
    expect(reads).toHaveLength(3);
    for (const q of reads) {
      expect(q.sql).toContain("tenant_id IS NULL");
      expect(q.params).not.toContain(null);
    }
    expect(reads[1]?.params).toEqual([7]);
  });
});

describe("the platform write elevation", () => {
  it("is set for a platform append and never for a tenant one", async () => {
    const { signer } = await newSignerAndKey();
    const inner = fakeChainPg();
    const seen: string[] = [];
    const conn: PgConnection = {
      ...inner,
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        inner.transaction((tx) =>
          fn({
            ...tx,
            query: (async (sql: string, params?: readonly unknown[]) => {
              seen.push(sql);
              return tx.query(sql, params);
            }) as PgConnection["query"],
          }),
        )) as PgConnection["transaction"],
    };
    const store = new PostgresChainLogStore(conn, signer);

    await append(store, null, 0);
    expect(seen.some((s) => s.includes("app.platform_audit_write"))).toBe(true);
    expect(seen.some((s) => s.includes("app.current_tenant_id"))).toBe(false);

    seen.length = 0;
    await append(store, TENANT_A, 0);
    expect(seen.some((s) => s.includes("app.current_tenant_id"))).toBe(true);
    // The narrower elevation is never widened: a tenant append cannot reach the platform chain.
    expect(seen.some((s) => s.includes("app.platform_audit_write"))).toBe(false);
  });

  it("is the caller's to set on appendWithin, and the insert is refused without it", async () => {
    const { signer } = await newSignerAndKey();
    const conn = fakeChainPg();
    const store = new PostgresChainLogStore(conn, signer);
    const input = {
      tenantId: null,
      kind: "security_event" as const,
      actorReference: "system:integrity",
      recordedAt: AT,
      payload: "platform",
    };
    await expect(conn.transaction((tx) => store.appendWithin(tx, input))).rejects.toThrow(
      /row-level security/,
    );
    const entry = await conn.transaction(async (tx) => {
      await tx.query(SET_PLATFORM_AUDIT_WRITE_SQL);
      return store.appendWithin(tx, input);
    });
    expect(entry.sequenceNumber).toBe(0);
  });
});
