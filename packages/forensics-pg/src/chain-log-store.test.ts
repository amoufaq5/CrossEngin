import { describe, expect, it } from "vitest";
import { InMemoryKeyStore } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  GENESIS_HASH,
  verifyChainEntrySignature,
  verifyChainIntegrity,
} from "@crossengin/forensics";

import { PostgresChainLogReader, PostgresChainLogStore, advisoryKeyFor } from "./chain-log-store.js";
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

    const chain = await store.loadChain(TENANT_A);
    expect(chain).toHaveLength(3);
    expect(verifyChainIntegrity(chain).valid).toBe(true);
    for (const entry of chain) {
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
    expect(await store.loadChain(TENANT_A)).toHaveLength(2);
    expect(await store.loadChain(TENANT_B)).toHaveLength(1);
    expect(verifyChainIntegrity(await store.loadChain(TENANT_B)).valid).toBe(true);
  });

  it("supports a platform (null-tenant) chain", async () => {
    const { store } = await newStore();
    await append(store, null, 0);
    await append(store, null, 1);
    const chain = await store.loadChain(null);
    expect(chain).toHaveLength(2);
    expect(verifyChainIntegrity(chain).valid).toBe(true);
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
  it("createCheckpoint anchors at the tail and verifyFromCheckpoint clears the suffix", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const e2 = await append(store, TENANT_A, 2);

    const cp = await store.createCheckpoint(TENANT_A, { checkpointedBy: "auditor", checkpointedAt: AT });
    expect(cp.sequenceNumber).toBe(2);
    expect(cp.rootHash).toBe(e2.entryHash);

    await append(store, TENANT_A, 3);
    await append(store, TENANT_A, 4);

    expect(await store.verifyFromCheckpoint(TENANT_A, cp)).toEqual({ valid: true, brokenAt: null });
  });

  it("loadFrom returns only the entries at or after the given sequence", async () => {
    const { store } = await newStore();
    for (let i = 0; i < 4; i++) await append(store, TENANT_A, i);
    const from2 = await store.loadFrom(TENANT_A, 2);
    expect(from2.map((e) => e.sequenceNumber)).toEqual([2, 3]);
  });

  it("createCheckpoint throws on an empty chain", async () => {
    const { store } = await newStore();
    await expect(store.createCheckpoint(TENANT_A, { checkpointedBy: "auditor" })).rejects.toThrow(
      /empty chain/,
    );
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
    const cp = await store.createCheckpoint(TENANT_A, { checkpointedBy: "auditor", checkpointedAt: AT });
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
    const chain = await reader.loadChain(TENANT_A);
    expect(chain).toHaveLength(2);
    expect(verifyChainIntegrity(chain).valid).toBe(true);
    for (const entry of chain) {
      expect(verifyChainEntrySignature(entry, publicKeyBase64)).toBe(true);
    }
    expect(await reader.verify(TENANT_A)).toEqual({ valid: true, brokenAt: null });
  });

  it("the store is a reader (checkpoint + suffix verify work through the base type)", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const reader: PostgresChainLogReader = store;
    const cp = await reader.createCheckpoint(TENANT_A, { checkpointedBy: "auditor", checkpointedAt: AT });
    expect(cp.sequenceNumber).toBe(1);
    expect(await reader.verifyFromCheckpoint(TENANT_A, cp)).toEqual({ valid: true, brokenAt: null });
  });

  it("rejects a bad schema on the reader too", () => {
    expect(() => new PostgresChainLogReader(fakeChainPg(), { schema: "Bad-Schema" })).toThrow(/schema/);
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
    expect(await reader.loadChain(null)).toHaveLength(1);
    expect(await reader.loadChain(TENANT_A)).toHaveLength(1);
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
