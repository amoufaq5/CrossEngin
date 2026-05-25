import { InMemoryKeyStore, generateEd25519Keypair } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import { GENESIS_HASH, verifyChainIntegrity } from "./tamper-evident-logs.js";
import {
  buildChainEntry,
  buildChainWithKeyStore,
  computePayloadSha256,
  sealEvidence,
  sealEvidenceWithStore,
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
    expect(verifyEvidenceSeal({ bytes, seal, publicKeyBase64: kp.publicKeyBase64 })).toBe(true);
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
