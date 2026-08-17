import { describe, expect, it } from "vitest";
import { GENESIS_HASH, type ChainedLogEntry } from "@crossengin/forensics";

import { checkpointFromChain, verifyChainSuffix } from "./checkpoint.js";

const AT = "2026-06-01T00:00:00.000Z";

function h(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/** A hash-linked run of entries starting at `from`, linking back to `priorRootHash`. */
function suffix(from: number, count: number, priorRootHash: string): ChainedLogEntry[] {
  const entries: ChainedLogEntry[] = [];
  let prior = priorRootHash;
  for (let i = 0; i < count; i++) {
    const seq = from + i;
    const entryHash = h(seq + 1);
    entries.push({
      sequenceNumber: seq,
      kind: "audit_event",
      recordedAt: AT,
      actorReference: "svc",
      payloadSha256: h(1000 + seq),
      payloadSizeBytes: 10,
      priorEntryHash: prior,
      entryHash,
      signingKeyFingerprint: h(9),
      signature: "sig",
    });
    prior = entryHash;
  }
  return entries;
}

describe("verifyChainSuffix", () => {
  it("accepts a contiguous suffix anchored at the checkpoint root", () => {
    const root = h(3);
    const entries = suffix(3, 3, root);
    expect(verifyChainSuffix(entries, { fromSequence: 3, priorRootHash: root })).toEqual({
      valid: true,
      brokenAt: null,
    });
  });

  it("is vacuously valid for an empty suffix", () => {
    expect(verifyChainSuffix([], { fromSequence: 5, priorRootHash: h(5) })).toEqual({
      valid: true,
      brokenAt: null,
    });
  });

  it("breaks at fromSequence when the first entry does not link to the checkpoint root", () => {
    const entries = suffix(3, 2, h(3));
    const verdict = verifyChainSuffix(entries, { fromSequence: 3, priorRootHash: h(999) });
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAt).toBe(3);
    expect(verdict.reason).toBe("hash chain broken");
  });

  it("breaks at the expected sequence on a gap at the head", () => {
    const entries = suffix(4, 2, h(3));
    const verdict = verifyChainSuffix(entries, { fromSequence: 3, priorRootHash: h(3) });
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAt).toBe(3);
    expect(verdict.reason).toBe("sequence gap");
  });

  it("breaks at the absolute sequence of an internal hash break", () => {
    const entries = suffix(3, 3, h(3));
    entries[1] = { ...entries[1]!, priorEntryHash: h(555) };
    const verdict = verifyChainSuffix(entries, { fromSequence: 3, priorRootHash: h(3) });
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAt).toBe(4);
    expect(verdict.reason).toBe("hash chain broken");
  });

  it("breaks at the absolute sequence of an internal sequence gap", () => {
    const entries = suffix(3, 3, h(3));
    entries[2] = { ...entries[2]!, sequenceNumber: 9 };
    const verdict = verifyChainSuffix(entries, { fromSequence: 3, priorRootHash: h(3) });
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAt).toBe(5);
    expect(verdict.reason).toBe("sequence gap");
  });
});

describe("checkpointFromChain", () => {
  it("anchors at the chain tail with the tail entry hash as the root", () => {
    const entries = suffix(0, 4, GENESIS_HASH);
    const cp = checkpointFromChain(entries, { checkpointedBy: "auditor", checkpointedAt: AT });
    expect(cp.sequenceNumber).toBe(3);
    expect(cp.rootHash).toBe(entries[3]!.entryHash);
    expect(cp.checkpointedBy).toBe("auditor");
    expect(cp.algorithm).toBe("sha256");
    expect(cp.externalAnchorReference).toBeUndefined();
  });

  it("carries an external anchor reference and algorithm when supplied", () => {
    const entries = suffix(0, 1, GENESIS_HASH);
    const cp = checkpointFromChain(entries, {
      checkpointedBy: "auditor",
      checkpointedAt: AT,
      externalAnchorReference: "btc:txid:abc",
      algorithm: "sha512",
    });
    expect(cp.externalAnchorReference).toBe("btc:txid:abc");
    expect(cp.algorithm).toBe("sha512");
  });

  it("throws on an empty chain", () => {
    expect(() => checkpointFromChain([], { checkpointedBy: "auditor", checkpointedAt: AT })).toThrow(
      /empty chain/,
    );
  });
});
