import { describe, expect, it } from "vitest";
import { InMemoryKeyStore, generateEd25519Keypair } from "@crossengin/crypto";
import type { ChainedLogEntry } from "@crossengin/forensics";

import { PostgresChainLogStore } from "./chain-log-store.js";
import { keyStoreChainSigner } from "./signer.js";
import { fakeChainPg } from "./test-fakes.js";
import {
  verifyChainSignatures,
  verifyStoredChainSignatures,
  type PublicKeyResolver,
} from "./chain-signature-verify.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const AT = "2026-06-01T00:00:00.000Z";

async function newStore(): Promise<{
  store: PostgresChainLogStore;
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
  const store = new PostgresChainLogStore(fakeChainPg(), signer);
  return { store, publicKeyBase64, fingerprint: record.fingerprint as string };
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
    const chain = await store.loadChain(TENANT_A);

    const verdict = await verifyChainSignatures(
      chain,
      mapResolver(new Map([[fingerprint, publicKeyBase64]])),
    );

    expect(verdict.valid).toBe(true);
    expect(verdict.checked).toBe(3);
    expect(verdict.results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(verdict.results.map((r) => r.sequenceNumber)).toEqual([0, 1, 2]);
    expect(verdict.unresolvedFingerprints).toEqual([]);
    expect(verdict.results.every((r) => r.reason === undefined)).toBe(true);
  });

  it("flags an entry whose fingerprint is unknown as unresolved_key", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    const chain = await store.loadChain(TENANT_A);

    const verdict = await verifyChainSignatures(chain, mapResolver(new Map()));

    expect(verdict.valid).toBe(false);
    expect(verdict.checked).toBe(1);
    expect(verdict.results[0]!.ok).toBe(false);
    expect(verdict.results[0]!.reason).toBe("unresolved_key");
    expect(verdict.unresolvedFingerprints).toEqual([chain[0]!.signingKeyFingerprint]);
  });

  it("dedupes a repeated unknown fingerprint in unresolvedFingerprints", async () => {
    const { store } = await newStore();
    await append(store, TENANT_A, 0);
    await append(store, TENANT_A, 1);
    const chain = await store.loadChain(TENANT_A);

    const verdict = await verifyChainSignatures(chain, mapResolver(new Map()));

    expect(verdict.valid).toBe(false);
    expect(verdict.results).toHaveLength(2);
    expect(verdict.unresolvedFingerprints).toHaveLength(1);
    expect(verdict.unresolvedFingerprints[0]).toBe(chain[0]!.signingKeyFingerprint);
  });

  it("flags a tampered signature as bad_signature", async () => {
    const { store, publicKeyBase64, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    const chain = await store.loadChain(TENANT_A);

    const flipped = chain[0]!.signature.endsWith("AAAA")
      ? chain[0]!.signature.slice(0, -4) + "BBBB"
      : chain[0]!.signature.slice(0, -4) + "AAAA";
    const tampered: ChainedLogEntry = { ...chain[0]!, signature: flipped };
    expect(tampered.signature).not.toBe(chain[0]!.signature);

    const verdict = await verifyChainSignatures(
      [tampered],
      mapResolver(new Map([[fingerprint, publicKeyBase64]])),
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.results[0]!.ok).toBe(false);
    expect(verdict.results[0]!.reason).toBe("bad_signature");
    expect(verdict.unresolvedFingerprints).toEqual([]);
  });

  it("flags a wrong public key registered for the fingerprint as bad_signature", async () => {
    const { store, fingerprint } = await newStore();
    await append(store, TENANT_A, 0);
    const chain = await store.loadChain(TENANT_A);

    const wrong = generateEd25519Keypair();
    const verdict = await verifyChainSignatures(
      chain,
      mapResolver(new Map([[fingerprint, wrong.publicKeyBase64]])),
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.results[0]!.reason).toBe("bad_signature");
  });

  it("treats an empty chain as vacuously valid", async () => {
    const verdict = await verifyChainSignatures([], mapResolver(new Map()));
    expect(verdict.valid).toBe(true);
    expect(verdict.checked).toBe(0);
    expect(verdict.results).toEqual([]);
    expect(verdict.unresolvedFingerprints).toEqual([]);
  });

  it("mixes resolved and unresolved entries — valid false, per-entry reasons", async () => {
    const { store: storeA, publicKeyBase64, fingerprint: fpA } = await newStore();
    await append(storeA, TENANT_A, 0);
    const chainA = await storeA.loadChain(TENANT_A);

    const { store: storeB } = await newStore();
    await append(storeB, TENANT_A, 0);
    const chainB = await storeB.loadChain(TENANT_A);

    const verdict = await verifyChainSignatures(
      [chainA[0]!, chainB[0]!],
      mapResolver(new Map([[fpA, publicKeyBase64]])),
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
    const chain = await store.loadChain(TENANT_A);

    const { resolver, calls } = countingResolver(new Map([[fingerprint, publicKeyBase64]]));
    const verdict = await verifyChainSignatures(chain, resolver);

    expect(verdict.valid).toBe(true);
    expect(calls()).toEqual([fingerprint]);
  });

  it("resolves once per distinct fingerprint across two keys", async () => {
    const { store: storeA, publicKeyBase64: pkA, fingerprint: fpA } = await newStore();
    await append(storeA, TENANT_A, 0);
    const a0 = (await storeA.loadChain(TENANT_A))[0]!;

    const { store: storeB, publicKeyBase64: pkB, fingerprint: fpB } = await newStore();
    await append(storeB, TENANT_A, 0);
    await append(storeB, TENANT_A, 1);
    const chainB = await storeB.loadChain(TENANT_A);

    const { resolver, calls } = countingResolver(
      new Map([
        [fpA, pkA],
        [fpB, pkB],
      ]),
    );
    const verdict = await verifyChainSignatures([a0, ...chainB], resolver);

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
  });
});
