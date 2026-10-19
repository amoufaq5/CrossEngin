import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_PROVENANCES,
  GENESIS_HASH,
  checkpointAnchorsBoundedProof,
  type ChainedLogEntry,
  type CheckpointProvenance,
} from "@crossengin/forensics";

import { checkpointFromTail, tailOfChain, verifyChainSuffix } from "./checkpoint.js";

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

describe("tailOfChain", () => {
  it("is the last entry's sequence and hash", () => {
    const entries = suffix(0, 4, GENESIS_HASH);
    expect(tailOfChain(entries)).toEqual({ sequenceNumber: 3, entryHash: entries[3]!.entryHash });
  });

  it("is null for an empty chain, which is how an empty chain stops being anchorable", () => {
    // `checkpointFromTail` used to be `checkpointFromChain` and threw on an empty chain. The
    // emptiness is unrepresentable in a `ChainTail` instead, so the refusal moved to the one caller
    // that can meet it (`createCheckpoint`) and the builder has no failure mode left to forget.
    expect(tailOfChain([])).toBeNull();
  });
});

describe("checkpointFromTail", () => {
  it("anchors at the given tail, taking its hash as the root", () => {
    const entries = suffix(0, 4, GENESIS_HASH);
    const cp = checkpointFromTail(tailOfChain(entries)!, {
      checkpointedBy: "auditor",
      checkpointedAt: AT,
      provenance: "verified_full",
    });
    expect(cp.sequenceNumber).toBe(3);
    expect(cp.rootHash).toBe(entries[3]!.entryHash);
    expect(cp.checkpointedBy).toBe("auditor");
    expect(cp.algorithm).toBe("sha256");
    expect(cp.externalAnchorReference).toBeUndefined();
  });

  it("anchors at the tail it was given and not at the chain's", () => {
    // The whole of ADR-0371's critical fix: a caller that verified a chain holds the tail its
    // verification covered, and the anchor must claim that sequence even though the chain has since
    // grown. Handing an earlier tail must produce an earlier anchor rather than being re-derived.
    const entries = suffix(0, 6, GENESIS_HASH);
    const verifiedThrough = { sequenceNumber: 2, entryHash: entries[2]!.entryHash };
    const cp = checkpointFromTail(verifiedThrough, {
      checkpointedBy: "auditor",
      checkpointedAt: AT,
      provenance: "verified_full",
    });
    expect(cp.sequenceNumber).toBe(2);
    expect(cp.rootHash).toBe(entries[2]!.entryHash);
    expect(cp.rootHash).not.toBe(entries[5]!.entryHash);
  });

  it("carries an external anchor reference and algorithm when supplied", () => {
    const cp = checkpointFromTail(tailOfChain(suffix(0, 1, GENESIS_HASH))!, {
      checkpointedBy: "auditor",
      checkpointedAt: AT,
      provenance: "verified_full",
      externalAnchorReference: "btc:txid:abc",
      algorithm: "sha512",
    });
    expect(cp.externalAnchorReference).toBe("btc:txid:abc");
    expect(cp.algorithm).toBe("sha512");
  });

  // Over the constant rather than the three names, so a fourth provenance is covered here by
  // landing rather than by somebody remembering to add a case.
  it.each(CHECKPOINT_PROVENANCES)("carries the provenance %s through", (provenance) => {
    const tail = tailOfChain(suffix(0, 2, GENESIS_HASH))!;
    const cp = checkpointFromTail(tail, { checkpointedBy: "auditor", checkpointedAt: AT, provenance });
    expect(cp.provenance).toBe(provenance);
    expect(checkpointAnchorsBoundedProof(cp.provenance)).toBe(
      checkpointAnchorsBoundedProof(provenance),
    );
  });

  it("defaults the algorithm and never the provenance", () => {
    const tail = tailOfChain(suffix(0, 2, GENESIS_HASH))!;
    // The asymmetry is the point: `algorithm` defaults because one hash function is the house's,
    // while all three provenances are *claims* about a prefix — so there is no safe default and the
    // field is required here. An absent one survives only on the contract, where it means a row an
    // older binary wrote, and `unverified` is what a writer with nothing verified has to say.
    const cp = checkpointFromTail(tail, {
      checkpointedBy: "auditor",
      checkpointedAt: AT,
      provenance: "unverified",
    });
    expect(cp.algorithm).toBe("sha256");
    // And the whole consequence of ADR-0371: an anchor that vouches for no prefix anchors nothing.
    expect(checkpointAnchorsBoundedProof(cp.provenance)).toBe(false);
  });

  it("refuses a provenance outside the enum", () => {
    const tail = tailOfChain(suffix(0, 2, GENESIS_HASH))!;
    expect(() =>
      checkpointFromTail(tail, {
        checkpointedBy: "auditor",
        checkpointedAt: AT,
        // The cast is the test: the runtime refusal exists because the type is defeatable at every
        // boundary this value really crosses — a stored row, a JSON body, a later binary's enum.
        provenance: "verified_sort_of" as CheckpointProvenance,
      }),
    ).toThrow();
  });
});
