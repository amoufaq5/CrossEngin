import { describe, expect, it } from "vitest";
import { InMemoryKeyStore, generateEd25519Keypair } from "@crossengin/crypto";
import type { ChainedLogEntry } from "@crossengin/forensics";
import type { PgConnection, UnreadableRow } from "@crossengin/kernel-pg";

import { PostgresChainLogReader, PostgresChainLogStore } from "./chain-log-store.js";
import { keyStoreChainSigner } from "./signer.js";
import { fakeChainPg } from "./test-fakes.js";
import {
  verifyChainSignatures,
  verifyStoredChainSignatures,
  type PublicKeyResolver,
} from "./chain-signature-verify.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const AT = "2026-06-01T00:00:00.000Z";

/** No unreadable row: the premise of every test that loads a chain this fake wrote itself. */
const EVERY_ROW_READ: readonly UnreadableRow[] = [];

async function newStore(): Promise<{
  store: PostgresChainLogStore;
  conn: PgConnection;
  publicKeyBase64: string;
  fingerprint: string;
}> {
  const keyStore = new InMemoryKeyStore();
  const record = await keyStore.createKey({
    tenantId: null,
    algorithm: "ed25519",
    purpose: "evidence_sealing",
  });
  const publicKeyBase64 = await keyStore.getPublicMaterial(record.handle);
  const signer = keyStoreChainSigner(keyStore, record, null);
  const conn = fakeChainPg();
  const store = new PostgresChainLogStore(conn, signer);
  return { store, conn, publicKeyBase64, fingerprint: record.fingerprint as string };
}

/**
 * Serves every full chain-entry read with `patch` applied to the row at `sequenceNumber` — the
 * offline stand-in for the `UPDATE meta.forensic_chain_entries SET actor_reference = …` ADR-0373 ran
 * live as the non-owner `serving` role. It patches the **read** and never the stored row, so the
 * append path still writes a genuinely signed chain; keyed on `actor_reference` being in the SELECT
 * list, which `READ_COLUMNS` has and the one-row tail read does not.
 */
function patchedReadConn(
  inner: PgConnection,
  sequenceNumber: number,
  patch: Record<string, unknown>,
): PgConnection {
  const wrap = (c: PgConnection): PgConnection => ({
    query: (async (sql: string, params?: readonly unknown[]) => {
      const res = await c.query(sql, params);
      if (!sql.includes("SELECT") || !sql.includes("actor_reference")) return res;
      const rows = res.rows.map((r) => {
        const row = { ...r } as Record<string, unknown>;
        return Number(row["sequence_number"]) === sequenceNumber ? { ...row, ...patch } : row;
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

function append(store: PostgresChainLogStore, tenantId: string | null, n: number) {
  return store.append({
    tenantId,
    kind: "audit_event",
    actorReference: "gateway",
    recordedAt: AT,
    payload: `event-${n.toString()}`,
  });
}

function mapResolver(map: Map<string, string>): PublicKeyResolver {
  return {
    resolveByFingerprint: async (fp) => map.get(fp) ?? null,
  };
}

function countingResolver(map: Map<string, string>): {
  resolver: PublicKeyResolver;
  calls: () => string[];
} {
  const calls: string[] = [];
  return {
    resolver: {
      resolveByFingerprint: async (fp) => {
        calls.push(fp);
        return map.get(fp) ?? null;
      },
    },
    calls: () => calls,
  };
}

describe("verifyChainSignatures", () => {
  it("verifies every entry against a resolver that knows the key", async () => {
    const { store, publicKeyBase64, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    await append(store, TENANT_A, 2);
    const read = await store.loadChain(TENANT_A);
    // The premise, asserted rather than assumed: nothing on the page was refused. `valid` is now
    // `allOk && unreadable.length === 0`, so threading the read's own pair tests the store's answer
    // where passing a bare `[]` would only restate what this test takes for granted.
    expect(read.unreadable).toEqual([]);

    const verdict = await verifyChainSignatures(
      read.entries,
      mapResolver(new Map([[fingerprint, publicKeyBase64]])),
      read.unreadable,
    );

    expect(verdict.valid).toBe(true);
    expect(verdict.checked).toBe(3);
    expect(verdict.results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(verdict.results.map((r) => r.sequenceNumber)).toEqual([0, 1, 2]);
    expect(verdict.unresolvedFingerprints).toEqual([]);
    expect(verdict.results.every((r) => r.reason === undefined)).toBe(true);
    expect(verdict.unreadable).toEqual([]);
  });

  it("flags an entry whose fingerprint is unknown as unresolved_key", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    const read = await store.loadChain(TENANT_A);

    const verdict = await verifyChainSignatures(read.entries, mapResolver(new Map()), read.unreadable);

    expect(verdict.valid).toBe(false);
    expect(verdict.checked).toBe(1);
    expect(verdict.results[0]!.ok).toBe(false);
    expect(verdict.results[0]!.reason).toBe("unresolved_key");
    expect(verdict.unresolvedFingerprints).toEqual([read.entries[0]!.signingKeyFingerprint]);
    // An unresolvable KEY and an unreadable ROW are different findings and this verdict keeps them
    // apart: the key is a fact about the registry, the row a fact about the table.
    expect(verdict.unreadable).toEqual([]);
  });

  it("dedupes a repeated unknown fingerprint in unresolvedFingerprints", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const read = await store.loadChain(TENANT_A);

    const verdict = await verifyChainSignatures(read.entries, mapResolver(new Map()), read.unreadable);

    expect(verdict.valid).toBe(false);
    expect(verdict.results).toHaveLength(2);
    expect(verdict.unresolvedFingerprints).toHaveLength(1);
    expect(verdict.unresolvedFingerprints[0]).toBe(read.entries[0]!.signingKeyFingerprint);
  });

  it("flags a tampered signature as bad_signature", async () => {
    const { store, publicKeyBase64, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    const { entries } = await store.loadChain(TENANT_A);

    const flipped = entries[0]!.signature.endsWith("AAAA")
      ? entries[0]!.signature.slice(0, -4) + "BBBB"
      : entries[0]!.signature.slice(0, -4) + "AAAA";
    const tampered: ChainedLogEntry = { ...entries[0]!, signature: flipped };
    expect(tampered.signature).not.toBe(entries[0]!.signature);

    const verdict = await verifyChainSignatures(
      [tampered],
      mapResolver(new Map([[fingerprint, publicKeyBase64]])),
      // The entry list is hand-built from one row that read perfectly well, so `EVERY_ROW_READ` is
      // the claim and not a default: the failure here is the signature, which is the other half of
      // what this verdict now has to keep apart.
      EVERY_ROW_READ,
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.results[0]!.ok).toBe(false);
    expect(verdict.results[0]!.reason).toBe("bad_signature");
    expect(verdict.unresolvedFingerprints).toEqual([]);
    expect(verdict.unreadable).toEqual([]);
  });

  it("flags a wrong public key registered for the fingerprint as bad_signature", async () => {
    const { store, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    const read = await store.loadChain(TENANT_A);

    const wrong = generateEd25519Keypair();
    const verdict = await verifyChainSignatures(
      read.entries,
      mapResolver(new Map([[fingerprint, wrong.publicKeyBase64]])),
      read.unreadable,
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.results[0]!.reason).toBe("bad_signature");
  });

  it("treats an empty chain as vacuously valid when nothing was refused", async () => {
    // The claim narrowed by the new contract: an empty entry list is vacuously valid only together
    // with an empty refusal list, because `allOk` is vacuously true over no entries, so under
    // `valid: allOk` alone the whole verdict rested on nothing at all. The two premises are now
    // separable and the test names both — see the sibling below for the other combination.
    const verdict = await verifyChainSignatures([], mapResolver(new Map()), EVERY_ROW_READ);
    expect(verdict.valid).toBe(true);
    expect(verdict.checked).toBe(0);
    expect(verdict.results).toEqual([]);
    expect(verdict.unresolvedFingerprints).toEqual([]);
    expect(verdict.unreadable).toEqual([]);
  });

  it("is invalid over an empty entry list when the page's only row was refused", async () => {
    // Reachable rather than hypothetical: a one-row page whose row the contract refuses reads as
    // zero entries and one refusal. `allOk` is vacuously true there, so this is precisely the input
    // on which `valid: allOk` answered `true` for a chain nobody could examine.
    const verdict = await verifyChainSignatures([], mapResolver(new Map()), [
      { identity: "0", detail: "kind: invalid_enum_value" },
    ]);
    expect(verdict.valid).toBe(false);
    expect(verdict.checked).toBe(0);
    expect(verdict.results).toEqual([]);
    expect(verdict.unreadable).toHaveLength(1);
  });

  it("fails the verdict for a refused row while reporting how many it examined", async () => {
    const { store, publicKeyBase64, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const { entries } = await store.loadChain(TENANT_A);

    const refused: UnreadableRow = { identity: "2", detail: "actorReference: too_small" };
    const verdict = await verifyChainSignatures(
      entries,
      mapResolver(new Map([[fingerprint, publicKeyBase64]])),
      [refused],
    );

    expect(verdict.valid).toBe(false);
    // `checked` is what was examined and not what was on the page: `2` beside one refused row says
    // what happened, where `3` would claim an examination that did not occur.
    expect(verdict.checked).toBe(entries.length);
    expect(verdict.checked).toBe(2);
    // Every entry it COULD examine passed, so the invalidity is attributable to the row it could
    // not — which is the shape that lets a reader tell a bad signature from an unreadable row.
    expect(verdict.results.every((r) => r.ok)).toBe(true);
    expect(verdict.results.every((r) => r.reason === undefined)).toBe(true);
    expect(verdict.unresolvedFingerprints).toEqual([]);
    expect(verdict.unreadable).toEqual([refused]);
  });

  it("mixes resolved and unresolved entries — valid false, per-entry reasons", async () => {
    const { store: storeA, publicKeyBase64, fingerprint: fpA } = await newStore();
    await append(storeA, TENANT_A, 0);
    const chainA = (await storeA.loadChain(TENANT_A)).entries;

    const { store: storeB } = await newStore();
    await append(storeB, TENANT_A, 0);
    const chainB = (await storeB.loadChain(TENANT_A)).entries;

    const verdict = await verifyChainSignatures(
      [chainA[0]!, chainB[0]!],
      mapResolver(new Map([[fpA, publicKeyBase64]])),
      // Hand-built from two reads that each refused nothing.
      EVERY_ROW_READ,
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.results[0]!.ok).toBe(true);
    expect(verdict.results[1]!.ok).toBe(false);
    expect(verdict.results[1]!.reason).toBe("unresolved_key");
    expect(verdict.unresolvedFingerprints).toEqual([chainB[0]!.signingKeyFingerprint]);
  });

  it("resolves each distinct fingerprint at most once (single key)", async () => {
    const { store, publicKeyBase64, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    await append(store, TENANT_A, 2);
    const read = await store.loadChain(TENANT_A);

    const { resolver, calls } = countingResolver(new Map([[fingerprint, publicKeyBase64]]));
    const verdict = await verifyChainSignatures(read.entries, resolver, read.unreadable);

    expect(verdict.valid).toBe(true);
    expect(calls()).toEqual([fingerprint]);
  });

  it("resolves once per distinct fingerprint across two keys", async () => {
    const { store: storeA, publicKeyBase64: pkA, fingerprint: fpA } = await newStore();
    await append(storeA, TENANT_A, 0);
    const a0 = (await storeA.loadChain(TENANT_A)).entries[0]!;

    const { store: storeB, publicKeyBase64: pkB, fingerprint: fpB } = await newStore();
    await append(storeB, TENANT_A, 0);
    await append(storeB, TENANT_A, 1);
    const chainB = (await storeB.loadChain(TENANT_A)).entries;

    const { resolver, calls } = countingResolver(
      new Map([
        [fpA, pkA],
        [fpB, pkB],
      ]),
    );
    const verdict = await verifyChainSignatures([a0, ...chainB], resolver, EVERY_ROW_READ);

    expect(verdict.valid).toBe(true);
    expect(verdict.checked).toBe(3);
    expect(calls().sort()).toEqual([fpA, fpB].sort());
    expect(calls()).toHaveLength(2);
  });
});

describe("verifyStoredChainSignatures", () => {
  it("round-trips over the store for a fully verifiable chain", async () => {
    const { store, publicKeyBase64, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);

    const verdict = await verifyStoredChainSignatures(
      store,
      TENANT_A,
      mapResolver(new Map([[fingerprint, publicKeyBase64]])),
    );

    expect(verdict.valid).toBe(true);
    expect(verdict.checked).toBe(2);
    // The CONTROL for the two refusal tests below: a clean chain is valid with nothing refused, so
    // `valid: false` there is attributable to the fixture and not to the new axis always firing.
    expect(verdict.unreadable).toEqual([]);
  });

  it("returns vacuously valid for a tenant with no entries", async () => {
    const { store, publicKeyBase64, fingerprint } = await newStore();
    const verdict = await verifyStoredChainSignatures(
      store,
      TENANT_A,
      mapResolver(new Map([[fingerprint, publicKeyBase64]])),
    );
    expect(verdict.valid).toBe(true);
    expect(verdict.checked).toBe(0);
    expect(verdict.unreadable).toEqual([]);
  });

  it("answers valid: false rather than throwing for a stored row the contract refuses", async () => {
    // THE defect, and the one assertion that is it. `loadChain` was `rows.map(rowToChainEntry)` and
    // that mapper ends in `ChainedLogEntrySchema.parse`, so one refused row threw out of the whole
    // array — and this function is the only check in the stack that binds an entry's stored columns
    // to its content (ADR-0371: both folds compare a stored `priorEntryHash` against a stored
    // `entryHash` and recompute neither). Blanking `actor_reference` is a tamper inside
    // `canonicalEntryBytes` that no CHECK refuses, so it stopped its own detector from running:
    // live, the hourly integrity proof filed `outcome: "error"` — no verdict row, no finding, no
    // paging sev1, one `console.error` an hour.
    const { store, conn, publicKeyBase64, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    await append(store, TENANT_A, 2);

    const reader = new PostgresChainLogReader(patchedReadConn(conn, 1, { actor_reference: "" }));
    const verdict = await verifyStoredChainSignatures(
      reader,
      TENANT_A,
      mapResolver(new Map([[fingerprint, publicKeyBase64]])),
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.unreadable).toEqual([{ identity: "1", detail: "actorReference: too_small" }]);
    // Two of three examined, and both of those verified: the chain's only finding is the row the
    // contract refused, named and countable rather than thrown.
    expect(verdict.checked).toBe(2);
    expect(verdict.results.every((r) => r.ok)).toBe(true);
  });

  it("CONTROL: the same tamper left readable is still caught, at the right sequence", async () => {
    // ADR-0373's live control, and the reason the fix belongs in the READ rather than in the
    // detector: `actor_reference` set to another principal instead of to `''` reads perfectly well
    // and was always caught, because the field is inside `canonicalEntryBytes`. So nothing about the
    // verification became impossible when the row was blanked — only the read refused, and the
    // tamper thereby disabled the one check that could see it.
    const { store, conn, publicKeyBase64, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    await append(store, TENANT_A, 2);

    const reader = new PostgresChainLogReader(
      patchedReadConn(conn, 1, { actor_reference: "user:someone-else" }),
    );
    const verdict = await verifyStoredChainSignatures(
      reader,
      TENANT_A,
      mapResolver(new Map([[fingerprint, publicKeyBase64]])),
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.checked).toBe(3);
    expect(verdict.unreadable).toEqual([]);
    expect(verdict.results.filter((r) => !r.ok).map((r) => r.sequenceNumber)).toEqual([1]);
    expect(verdict.results[1]!.reason).toBe("bad_signature");
  });
});
