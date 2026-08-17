import { describe, expect, it } from "vitest";
import { InMemoryKeyStore } from "@crossengin/crypto";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  GENESIS_HASH,
  verifyChainEntrySignature,
  verifyChainIntegrity,
} from "@crossengin/forensics";

import { PostgresChainLogStore, advisoryKeyFor } from "./chain-log-store.js";
import { keyStoreChainSigner } from "./signer.js";
import { fakeChainPg } from "./test-fakes.js";

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

describe("advisoryKeyFor", () => {
  it("is deterministic, scope-specific, and 64-bit", () => {
    expect(advisoryKeyFor(TENANT_A)).toBe(advisoryKeyFor(TENANT_A));
    expect(advisoryKeyFor(TENANT_A)).not.toBe(advisoryKeyFor(TENANT_B));
    expect(advisoryKeyFor(null)).not.toBe(advisoryKeyFor(TENANT_A));
    const k = advisoryKeyFor(TENANT_A);
    expect(k >= -(2n ** 63n) && k < 2n ** 63n).toBe(true);
  });
});
