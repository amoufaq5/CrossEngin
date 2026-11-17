import { InMemoryKeyStore, generateEd25519Keypair } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { ed25519PublicKeyFingerprint, signEd25519 } from "@crossengin/crypto";

import {
  ChainCheckpointSchema,
  GENESIS_HASH,
  earliestChainBreak,
  verifyChainIntegrity,
  type ChainCheckpoint,
  type ChainedLogEntry,
} from "./tamper-evident-logs.js";
import {
  CHECKPOINT_SIGNATURE_STANDINGS,
  buildChainEntry,
  buildChainWithKeyStore,
  canonicalCheckpointBytes,
  checkpointSignatureStanding,
  computePayloadSha256,
  recomputeEntryHash,
  sealEvidence,
  sealEvidenceWithStore,
  signCheckpoint,
  trustedChainKeys,
  verifyChainEntryHashes,
  verifyChainEntrySignature,
  verifyEvidenceSeal,
} from "./sealing.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

describe("computePayloadSha256", () => {
  it("returns 64-char hex", () => {
    expect(computePayloadSha256("payload")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(computePayloadSha256("x")).toBe(computePayloadSha256("x"));
  });
});

describe("buildChainEntry", () => {
  it("produces a valid first entry chained from GENESIS_HASH", async () => {
    const sealed = await buildChainEntry({
      sequenceNumber: 0,
      priorEntryHash: GENESIS_HASH,
      entry: {
        kind: "audit_event",
        recordedAt: "2026-05-16T12:00:00.000Z",
        actorReference: "user:alice",
        payloadBytes: "first payload",
      },
      signingKeyFingerprint: "0".repeat(64),
      sign: async () => Buffer.from(new Uint8Array(64).fill(0x01)).toString("base64"),
    });
    expect(sealed.entry.sequenceNumber).toBe(0);
    expect(sealed.entry.priorEntryHash).toBe(GENESIS_HASH);
    expect(sealed.entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.entry.entryHash).not.toBe(GENESIS_HASH);
    expect(sealed.entry.payloadSha256).toBe(computePayloadSha256("first payload"));
  });

  it("chains subsequent entries from the previous entryHash", async () => {
    const sign = async () => Buffer.from(new Uint8Array(64).fill(0x01)).toString("base64");
    const first = await buildChainEntry({
      sequenceNumber: 0,
      priorEntryHash: GENESIS_HASH,
      entry: {
        kind: "audit_event",
        recordedAt: "2026-05-16T12:00:00.000Z",
        actorReference: "user:alice",
        payloadBytes: "p1",
      },
      signingKeyFingerprint: "0".repeat(64),
      sign,
    });
    const second = await buildChainEntry({
      sequenceNumber: 1,
      priorEntryHash: first.entry.entryHash,
      entry: {
        kind: "data_change",
        recordedAt: "2026-05-16T12:01:00.000Z",
        actorReference: "user:bob",
        payloadBytes: "p2",
      },
      signingKeyFingerprint: "0".repeat(64),
      sign,
    });
    expect(second.entry.priorEntryHash).toBe(first.entry.entryHash);
    expect(verifyChainIntegrity([first.entry, second.entry]).valid).toBe(true);
  });
});

describe("buildChainWithKeyStore", () => {
  it("produces a chain whose integrity verifies", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "evidence_sealing",
    });
    const sealed = await buildChainWithKeyStore({
      store,
      handle: record.handle,
      tenantId: TENANT,
      entries: [
        {
          kind: "audit_event",
          recordedAt: "2026-05-16T12:00:00.000Z",
          actorReference: "user:alice",
          payloadBytes: "first",
        },
        {
          kind: "data_change",
          recordedAt: "2026-05-16T12:01:00.000Z",
          actorReference: "user:bob",
          payloadBytes: "second",
        },
        {
          kind: "deletion_event",
          recordedAt: "2026-05-16T12:02:00.000Z",
          actorReference: "user:carol",
          payloadBytes: "third",
        },
      ],
    });
    expect(sealed).toHaveLength(3);
    expect(verifyChainIntegrity(sealed.map((s) => s.entry)).valid).toBe(true);
    for (const s of sealed) {
      expect(s.entry.signingKeyFingerprint).toBe(record.fingerprint);
      expect(verifyChainEntrySignature(s.entry, record.publicKeyBase64!)).toBe(true);
    }
  });

  it("rejects wrong-purpose keys", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await expect(
      buildChainWithKeyStore({
        store,
        handle: record.handle,
        tenantId: TENANT,
        entries: [
          {
            kind: "audit_event",
            recordedAt: "2026-05-16T12:00:00.000Z",
            actorReference: "user:alice",
            payloadBytes: "x",
          },
        ],
      }),
    ).rejects.toThrow(/evidence_sealing/);
  });

  it("rejects wrong-algorithm keys", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "hmac-sha256",
      purpose: "webhook_signing",
    });
    await expect(
      buildChainWithKeyStore({
        store,
        handle: record.handle,
        tenantId: TENANT,
        entries: [
          {
            kind: "audit_event",
            recordedAt: "2026-05-16T12:00:00.000Z",
            actorReference: "user:alice",
            payloadBytes: "x",
          },
        ],
      }),
    ).rejects.toThrow(/ed25519/);
  });
});

describe("verifyChainEntrySignature", () => {
  it("returns false when the fingerprint does not match the supplied public key", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "evidence_sealing",
    });
    const sealed = await buildChainWithKeyStore({
      store,
      handle: record.handle,
      tenantId: TENANT,
      entries: [
        {
          kind: "audit_event",
          recordedAt: "2026-05-16T12:00:00.000Z",
          actorReference: "user:alice",
          payloadBytes: "x",
        },
      ],
    });
    const other = generateEd25519Keypair();
    expect(verifyChainEntrySignature(sealed[0]!.entry, other.publicKeyBase64)).toBe(false);
  });
});

describe("sealEvidence + verifyEvidenceSeal", () => {
  it("round-trips for a string payload", () => {
    const kp = generateEd25519Keypair();
    const seal = sealEvidence({
      bytes: "important evidence",
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(seal.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(seal.signingKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(seal.signatureBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(
      verifyEvidenceSeal({
        bytes: "important evidence",
        seal,
        publicKeyBase64: kp.publicKeyBase64,
      }),
    ).toBe(true);
  });

  it("round-trips for Uint8Array bytes", () => {
    const kp = generateEd25519Keypair();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const seal = sealEvidence({
      bytes,
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(verifyEvidenceSeal({ bytes, seal, publicKeyBase64: kp.publicKeyBase64 })).toBe(
      true,
    );
  });

  it("rejects a tampered payload", () => {
    const kp = generateEd25519Keypair();
    const seal = sealEvidence({
      bytes: "original",
      privateKeyBase64: kp.privateKeyBase64,
      publicKeyBase64: kp.publicKeyBase64,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(
      verifyEvidenceSeal({ bytes: "tampered", seal, publicKeyBase64: kp.publicKeyBase64 }),
    ).toBe(false);
  });

  it("rejects a different public key", () => {
    const kp1 = generateEd25519Keypair();
    const kp2 = generateEd25519Keypair();
    const seal = sealEvidence({
      bytes: "original",
      privateKeyBase64: kp1.privateKeyBase64,
      publicKeyBase64: kp1.publicKeyBase64,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(
      verifyEvidenceSeal({ bytes: "original", seal, publicKeyBase64: kp2.publicKeyBase64 }),
    ).toBe(false);
  });
});

describe("sealEvidenceWithStore", () => {
  it("round-trips via verifyEvidenceSeal", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "evidence_sealing",
    });
    const seal = await sealEvidenceWithStore({
      bytes: "evidence",
      store,
      handle: record.handle,
      tenantId: TENANT,
      sealedAt: "2026-05-16T12:00:00.000Z",
    });
    expect(
      verifyEvidenceSeal({
        bytes: "evidence",
        seal,
        publicKeyBase64: record.publicKeyBase64!,
      }),
    ).toBe(true);
  });

  it("rejects wrong-purpose keys", async () => {
    const store = new InMemoryKeyStore();
    const record = await store.createKey({
      tenantId: TENANT,
      algorithm: "ed25519",
      purpose: "pack_signing",
    });
    await expect(
      sealEvidenceWithStore({
        bytes: "x",
        store,
        handle: record.handle,
        tenantId: TENANT,
        sealedAt: "2026-05-16T12:00:00.000Z",
      }),
    ).rejects.toThrow(/evidence_sealing/);
  });
});

async function realChain(count: number): Promise<{
  readonly entries: ChainedLogEntry[];
  readonly publicKeyBase64: string;
  readonly privateKeyBase64: string;
}> {
  const kp = generateEd25519Keypair();
  const fingerprint = ed25519PublicKeyFingerprint(kp.publicKeyBase64);
  const entries: ChainedLogEntry[] = [];
  let prior = GENESIS_HASH;
  for (let i = 0; i < count; i += 1) {
    const sealed = await buildChainEntry({
      sequenceNumber: i,
      priorEntryHash: prior,
      entry: {
        kind: "audit_event",
        recordedAt: "2026-05-16T12:00:00.000Z",
        actorReference: "gw",
        payloadBytes: `p${i.toString()}`,
      },
      signingKeyFingerprint: fingerprint,
      sign: async (b) => signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, b),
    });
    entries.push(sealed.entry);
    prior = sealed.entry.entryHash;
  }
  return { entries, ...kp };
}

describe("recomputeEntryHash + verifyChainEntryHashes", () => {
  it("recomputes exactly the hash buildChainEntry stored", async () => {
    const { entries } = await realChain(3);
    for (const e of entries) expect(recomputeEntryHash(e)).toBe(e.entryHash);
    expect(verifyChainEntryHashes(entries)).toEqual({ valid: true, brokenAt: null });
  });

  it("catches a rewritten tail entry_hash that both the link fold and the signature accept", async () => {
    // The tamper this check exists for: the signature covers the canonical bytes and not
    // `entryHash`, and the tail has no later entry whose `priorEntryHash` could disagree.
    const { entries, publicKeyBase64 } = await realChain(4);
    const tampered = entries.map((e, i) => (i === 3 ? { ...e, entryHash: "a".repeat(64) } : e));
    expect(verifyChainIntegrity(tampered).valid).toBe(true);
    expect(tampered.every((e) => verifyChainEntrySignature(e, publicKeyBase64))).toBe(true);
    expect(verifyChainEntryHashes(tampered)).toEqual({
      valid: false,
      brokenAt: 3,
      reason: "entry hash does not match its content",
    });
  });

  it("catches an edited column re-linked by rewriting the next entry's prior hash", async () => {
    const { entries } = await realChain(4);
    const edited = { ...entries[1]!, actorReference: "forger" };
    const relinked = { ...edited, entryHash: recomputeEntryHash(edited) };
    const tampered = [entries[0]!, relinked, { ...entries[2]!, priorEntryHash: relinked.entryHash }, entries[3]!];
    // The link fold breaks only at 3 (entry 2's stored hash no longer follows from its new prior);
    // the content check names entry 2, whose own hash its content no longer produces.
    expect(verifyChainEntryHashes(tampered).brokenAt).toBe(2);
  });

  it("is vacuously valid over no entries", () => {
    expect(verifyChainEntryHashes([])).toEqual({ valid: true, brokenAt: null });
  });
});

describe("earliestChainBreak", () => {
  const ok = { valid: true, brokenAt: null } as const;
  it("answers the earliest broken position, whichever argument it came from", () => {
    expect(earliestChainBreak(ok, ok)).toBe(ok);
    const at5 = { valid: false, brokenAt: 5, reason: "a" };
    const at2 = { valid: false, brokenAt: 2, reason: "b" };
    expect(earliestChainBreak(at5, at2)).toBe(at2);
    expect(earliestChainBreak(at2, at5)).toBe(at2);
    expect(earliestChainBreak(ok, at5)).toBe(at5);
  });

  it("ranks a break that names no row below one that does", () => {
    const nowhere = { valid: false, brokenAt: null, reason: "x" };
    const at7 = { valid: false, brokenAt: 7, reason: "y" };
    expect(earliestChainBreak(nowhere, at7)).toBe(at7);
    expect(earliestChainBreak(at7, nowhere)).toBe(at7);
  });
});

describe("checkpoint signatures", () => {
  const SCOPE = "00000000-0000-4000-8000-0000000000aa";
  const base: ChainCheckpoint = ChainCheckpointSchema.parse({
    sequenceNumber: 7,
    rootHash: "b".repeat(64),
    checkpointedAt: "2026-05-16T12:00:00.000Z",
    checkpointedBy: "system:checkpoint",
    provenance: "verified_full",
  });

  function signerFor(kp: { publicKeyBase64: string; privateKeyBase64: string }) {
    return {
      fingerprint: ed25519PublicKeyFingerprint(kp.publicKeyBase64),
      sign: async (b: Uint8Array) => signEd25519(kp.privateKeyBase64, kp.publicKeyBase64, b),
    };
  }

  it("signs and verifies under a trusted key, and the standings are the declared four", async () => {
    expect(CHECKPOINT_SIGNATURE_STANDINGS).toEqual(["signed", "unsigned", "untrusted_key", "bad_signature"]);
    const kp = generateEd25519Keypair();
    const signed = await signCheckpoint(SCOPE, base, signerFor(kp));
    expect(signed.signingKeyFingerprint).toBe(ed25519PublicKeyFingerprint(kp.publicKeyBase64));
    expect(checkpointSignatureStanding(SCOPE, signed, trustedChainKeys([kp.publicKeyBase64]))).toBe("signed");
  });

  it("reads a row with no signature as unsigned, which is a gap and not a forgery", () => {
    expect(checkpointSignatureStanding(SCOPE, base, trustedChainKeys([]))).toBe("unsigned");
  });

  it("refuses a signature by a key the verifier does not trust, however valid", async () => {
    const tenantKey = generateEd25519Keypair();
    const deployment = generateEd25519Keypair();
    const signed = await signCheckpoint(SCOPE, base, signerFor(tenantKey));
    expect(
      checkpointSignatureStanding(SCOPE, signed, trustedChainKeys([deployment.publicKeyBase64])),
    ).toBe("untrusted_key");
  });

  it("binds every signed field: sequence, root hash, provenance, instant and scope", async () => {
    const kp = generateEd25519Keypair();
    const trusted = trustedChainKeys([kp.publicKeyBase64]);
    const signed = await signCheckpoint(SCOPE, base, signerFor(kp));
    const edits: ChainCheckpoint[] = [
      { ...signed, sequenceNumber: 99 },
      { ...signed, rootHash: "c".repeat(64) },
      { ...signed, provenance: "verified_suffix" },
      { ...signed, checkpointedAt: "2026-05-16T12:00:01.000Z" },
    ];
    for (const e of edits) expect(checkpointSignatureStanding(SCOPE, e, trusted)).toBe("bad_signature");
    expect(checkpointSignatureStanding(null, signed, trusted)).toBe("bad_signature");
    expect(
      checkpointSignatureStanding("00000000-0000-4000-8000-0000000000bb", signed, trusted),
    ).toBe("bad_signature");
    // Outside the bytes on purpose: none decides what a verifier does with the anchor.
    expect(checkpointSignatureStanding(SCOPE, { ...signed, checkpointedBy: "x" }, trusted)).toBe("signed");
  });

  it("treats the scope as the UUID it is, so a case difference is not a forgery", async () => {
    // `verify-chain --tenant` and a static `tenants` list take whatever case was typed, and the
    // database answers the same rows for either; an honest row must not read `bad_signature`.
    const kp = generateEd25519Keypair();
    const trusted = trustedChainKeys([kp.publicKeyBase64]);
    const signed = await signCheckpoint(SCOPE, base, signerFor(kp));
    expect(checkpointSignatureStanding(SCOPE.toUpperCase(), signed, trusted)).toBe("signed");
    const signedUpper = await signCheckpoint(SCOPE.toUpperCase(), base, signerFor(kp));
    expect(checkpointSignatureStanding(SCOPE, signedUpper, trusted)).toBe("signed");
  });

  it("signs an absent provenance as null, so it cannot collide with an omitted key", () => {
    const { provenance: _omitted, ...withoutProvenance } = base;
    const text = new TextDecoder().decode(canonicalCheckpointBytes(null, withoutProvenance));
    expect(text).toContain('"provenance":null');
  });

  it("refuses a checkpoint carrying a signature without its fingerprint, or the reverse", () => {
    expect(() => ChainCheckpointSchema.parse({ ...base, signature: "sig" })).toThrow(/together/);
    expect(() =>
      ChainCheckpointSchema.parse({ ...base, signingKeyFingerprint: "d".repeat(64) }),
    ).toThrow(/together/);
  });

  it("trustedChainKeys derives each fingerprint and names a malformed key by position", () => {
    const kp = generateEd25519Keypair();
    const keys = trustedChainKeys([kp.publicKeyBase64]);
    expect([...keys.keys()]).toEqual([ed25519PublicKeyFingerprint(kp.publicKeyBase64)]);
    expect(() => trustedChainKeys([kp.publicKeyBase64, "not-a-key"])).toThrow(/#2/);
  });
});
