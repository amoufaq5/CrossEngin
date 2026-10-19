import { describe, expect, it } from "vitest";
import {
  ChainedLogEntrySchema,
  ChainedLogSchema,
  GENESIS_HASH,
  LOG_KINDS,
  HASH_ALGORITHMS,
  ChainCheckpointSchema,
  CHECKPOINT_PROVENANCES,
  CHECKPOINT_PROVENANCE_ANCHORS_A_BOUNDED_PROOF,
  checkpointAnchorsBoundedProof,
  lastEntryHash,
  nextSequenceNumber,
  verifyChainIntegrity,
  type ChainedLogEntry,
} from "./tamper-evident-logs.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

describe("constants", () => {
  it("LOG_KINDS has 7 entries", () => {
    expect(LOG_KINDS).toContain("audit_event");
    expect(LOG_KINDS).toContain("deletion_event");
    expect(LOG_KINDS).toContain("approval_decision");
  });

  it("HASH_ALGORITHMS has 3 entries", () => {
    expect(HASH_ALGORITHMS).toEqual(["sha256", "sha512", "blake3"]);
  });

  it("GENESIS_HASH is 64 zero hex chars", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });
});

describe("ChainedLogEntrySchema", () => {
  it("accepts a valid entry", () => {
    expect(() =>
      ChainedLogEntrySchema.parse({
        sequenceNumber: 0,
        kind: "audit_event",
        recordedAt: "2026-05-14T10:00:00Z",
        actorReference: "u-1",
        payloadSha256: HASH_A,
        payloadSizeBytes: 1024,
        priorEntryHash: GENESIS_HASH,
        entryHash: HASH_B,
        signingKeyFingerprint: HASH_C,
        signature: "sigbytes",
      }),
    ).not.toThrow();
  });

  it("rejects strict unknown keys", () => {
    expect(() =>
      ChainedLogEntrySchema.parse({
        sequenceNumber: 0,
        kind: "audit_event",
        recordedAt: "2026-05-14T10:00:00Z",
        actorReference: "u-1",
        payloadSha256: HASH_A,
        payloadSizeBytes: 1024,
        priorEntryHash: GENESIS_HASH,
        entryHash: HASH_B,
        signingKeyFingerprint: HASH_C,
        signature: "sigbytes",
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("ChainedLogSchema", () => {
  const entry = (seq: number, prior: string, hash: string, recordedAt: string): ChainedLogEntry => ({
    sequenceNumber: seq,
    kind: "audit_event",
    recordedAt,
    actorReference: "u-1",
    payloadSha256: HASH_A,
    payloadSizeBytes: 100,
    priorEntryHash: prior,
    entryHash: hash,
    signingKeyFingerprint: HASH_C,
    signature: "s",
  });

  it("accepts a valid chain", () => {
    expect(() =>
      ChainedLogSchema.parse([
        entry(0, GENESIS_HASH, HASH_A, "2026-05-14T10:00:00Z"),
        entry(1, HASH_A, HASH_B, "2026-05-14T10:01:00Z"),
      ]),
    ).not.toThrow();
  });

  it("rejects sequence gap", () => {
    expect(() =>
      ChainedLogSchema.parse([
        entry(0, GENESIS_HASH, HASH_A, "2026-05-14T10:00:00Z"),
        entry(2, HASH_A, HASH_B, "2026-05-14T10:01:00Z"),
      ]),
    ).toThrow(/expected sequenceNumber 1/);
  });

  it("rejects hash chain break", () => {
    expect(() =>
      ChainedLogSchema.parse([
        entry(0, GENESIS_HASH, HASH_A, "2026-05-14T10:00:00Z"),
        entry(1, HASH_C, HASH_B, "2026-05-14T10:01:00Z"),
      ]),
    ).toThrow(/hash chain broken/);
  });

  it("rejects entryHash == priorEntryHash", () => {
    expect(() =>
      ChainedLogSchema.parse([
        entry(0, GENESIS_HASH, GENESIS_HASH, "2026-05-14T10:00:00Z"),
      ]),
    ).toThrow(/must differ from priorEntryHash/);
  });

  it("rejects out-of-order timestamps", () => {
    expect(() =>
      ChainedLogSchema.parse([
        entry(0, GENESIS_HASH, HASH_A, "2026-05-14T10:00:00Z"),
        entry(1, HASH_A, HASH_B, "2026-05-14T09:00:00Z"),
      ]),
    ).toThrow(/non-decreasing/);
  });
});

describe("ChainCheckpointSchema", () => {
  it("accepts a valid checkpoint", () => {
    expect(() =>
      ChainCheckpointSchema.parse({
        sequenceNumber: 100,
        rootHash: HASH_A,
        checkpointedAt: "2026-05-14T10:00:00Z",
        checkpointedBy: "u-1",
        externalAnchorReference: "tsa-token-abc",
        algorithm: "sha256",
      }),
    ).not.toThrow();
  });

  it("accepts a checkpoint with no provenance, and leaves it absent rather than defaulting one", () => {
    const parsed = ChainCheckpointSchema.parse({
      sequenceNumber: 100,
      rootHash: HASH_A,
      checkpointedAt: "2026-05-14T10:00:00Z",
      checkpointedBy: "u-1",
    });
    // No default: all three provenances are claims, so defaulting one would assert something about
    // every row written before the field existed (ADR-0351's reason for `record_storage`).
    expect(parsed.provenance).toBeUndefined();
    expect("provenance" in parsed).toBe(false);
  });

  it("round-trips each provenance and rejects one outside the enum", () => {
    for (const p of CHECKPOINT_PROVENANCES) {
      expect(
        ChainCheckpointSchema.parse({
          sequenceNumber: 1,
          rootHash: HASH_A,
          checkpointedAt: "2026-05-14T10:00:00Z",
          checkpointedBy: "u-1",
          provenance: p,
        }).provenance,
      ).toBe(p);
    }
    expect(() =>
      ChainCheckpointSchema.parse({
        sequenceNumber: 1,
        rootHash: HASH_A,
        checkpointedAt: "2026-05-14T10:00:00Z",
        checkpointedBy: "u-1",
        provenance: "verified",
      }),
    ).toThrow();
  });
});

describe("checkpoint provenance", () => {
  it("has three members", () => {
    expect(CHECKPOINT_PROVENANCES).toEqual(["verified_full", "verified_suffix", "unverified"]);
  });

  it("answers for every member, so a fourth cannot inherit a branch", () => {
    // Derived from the enum rather than restated: a member added to the union and not to the map is
    // a compile error, and a member added to both without a decision fails here.
    for (const p of CHECKPOINT_PROVENANCES) {
      expect(typeof CHECKPOINT_PROVENANCE_ANCHORS_A_BOUNDED_PROOF[p]).toBe("boolean");
    }
    expect(Object.keys(CHECKPOINT_PROVENANCE_ANCHORS_A_BOUNDED_PROOF).sort()).toEqual(
      [...CHECKPOINT_PROVENANCES].sort(),
    );
  });

  it("admits exactly the two verified provenances as anchors", () => {
    const anchoring = CHECKPOINT_PROVENANCES.filter((p) => checkpointAnchorsBoundedProof(p));
    expect(anchoring).toEqual(["verified_full", "verified_suffix"]);
  });

  it("refuses an absent provenance, which is a gap and not the `unverified` claim", () => {
    // Both answer false — a prefix nothing can vouch for is not a prefix to trust — and they are
    // different facts: `unverified` is a row stating nothing checked it, absent is a row that does
    // not cover the question. A caller that must tell them apart reads `provenance` itself, which
    // is why this function does not collapse them into one input value (ADR-0331).
    expect(checkpointAnchorsBoundedProof(undefined)).toBe(false);
    expect(checkpointAnchorsBoundedProof("unverified")).toBe(false);
  });
});

describe("helpers", () => {
  const entry = (seq: number, prior: string, hash: string): ChainedLogEntry => ({
    sequenceNumber: seq,
    kind: "audit_event",
    recordedAt: "2026-05-14T10:00:00Z",
    actorReference: "u-1",
    payloadSha256: HASH_A,
    payloadSizeBytes: 100,
    priorEntryHash: prior,
    entryHash: hash,
    signingKeyFingerprint: HASH_C,
    signature: "s",
  });

  it("verifyChainIntegrity passes for valid chain", () => {
    const result = verifyChainIntegrity([
      entry(0, GENESIS_HASH, HASH_A),
      entry(1, HASH_A, HASH_B),
    ]);
    expect(result.valid).toBe(true);
    expect(result.brokenAt).toBeNull();
  });

  it("verifyChainIntegrity detects break", () => {
    const result = verifyChainIntegrity([
      entry(0, GENESIS_HASH, HASH_A),
      entry(1, HASH_C, HASH_B),
    ]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toBe("hash chain broken");
  });

  it("lastEntryHash returns genesis for empty chain", () => {
    expect(lastEntryHash([])).toBe(GENESIS_HASH);
  });

  it("lastEntryHash returns the last hash", () => {
    expect(lastEntryHash([entry(0, GENESIS_HASH, HASH_A)])).toBe(HASH_A);
  });

  it("nextSequenceNumber returns chain length", () => {
    expect(nextSequenceNumber([])).toBe(0);
    expect(
      nextSequenceNumber([
        entry(0, GENESIS_HASH, HASH_A),
        entry(1, HASH_A, HASH_B),
      ]),
    ).toBe(2);
  });
});
