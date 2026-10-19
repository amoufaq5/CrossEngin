import {
  ChainCheckpointSchema,
  type ChainCheckpoint,
  type ChainedLogEntry,
  type CheckpointProvenance,
} from "@crossengin/forensics";

/**
 * A scope's chain tail: the last entry's sequence and hash, which is exactly what an anchor claims.
 *
 * It lives here rather than beside the query that reads it because it is the *input to a
 * checkpoint*, and the two must agree about what an anchor is made of. Reading it costs one row.
 */
export interface ChainTail {
  readonly sequenceNumber: number;
  readonly entryHash: string;
}

/** The tail of a chain already in memory, or `null` for an empty one. */
export function tailOfChain(entries: readonly ChainedLogEntry[]): ChainTail | null {
  const last = entries[entries.length - 1];
  if (last === undefined) return null;
  return { sequenceNumber: last.sequenceNumber, entryHash: last.entryHash };
}

export interface ChainSuffixVerdict {
  readonly valid: boolean;
  readonly brokenAt: number | null;
  readonly reason?: string;
}

export interface VerifyChainSuffixOptions {
  readonly fromSequence: number;
  readonly priorRootHash: string;
}

/**
 * Verifies a contiguous chain SUFFIX against a checkpoint anchor: the entries must start exactly at
 * `fromSequence`, the first entry must link back to `priorRootHash`, and from there sequence numbers
 * increase by 1 with each `priorEntryHash` matching the previous `entryHash`. `brokenAt` is the absolute
 * sequence number of the failure (the expected sequence on a gap). An empty suffix is vacuously valid.
 */
export function verifyChainSuffix(
  entries: readonly ChainedLogEntry[],
  opts: VerifyChainSuffixOptions,
): ChainSuffixVerdict {
  if (entries.length === 0) return { valid: true, brokenAt: null };
  let expectedSeq = opts.fromSequence;
  let expectedPrior = opts.priorRootHash;
  for (const entry of entries) {
    if (entry.sequenceNumber !== expectedSeq) {
      return { valid: false, brokenAt: expectedSeq, reason: "sequence gap" };
    }
    if (entry.priorEntryHash !== expectedPrior) {
      return { valid: false, brokenAt: entry.sequenceNumber, reason: "hash chain broken" };
    }
    expectedSeq = entry.sequenceNumber + 1;
    expectedPrior = entry.entryHash;
  }
  return { valid: true, brokenAt: null };
}

export interface CheckpointMeta {
  readonly checkpointedBy: string;
  readonly checkpointedAt: string;
  readonly externalAnchorReference?: string;
  readonly algorithm?: string;
  /**
   * How the prefix this anchor stands for came to be trusted. **Required**, though the contract
   * field is optional: there the absence means *an older binary wrote this row*, and a writer
   * permitted to omit it would make a new row indistinguishable from one of those (ADR-0331) — so
   * absent stops meaning "predates the column" the moment a current writer can produce it.
   * A caller holding no verification is not excused from answering; it says `unverified`, which is
   * the one claim `checkpointAnchorsBoundedProof` refuses by name rather than by silence.
   */
  readonly provenance: CheckpointProvenance;
}

/**
 * Builds a `ChainCheckpoint` from a chain tail: `sequenceNumber` is that entry's sequence, `rootHash`
 * its hash. The tail is an argument and no longer read from the whole chain, which is the point:
 * a caller that verified a chain must anchor at the tail **its verification covered**, and one that
 * re-read the chain to find a tail would anchor past it — stamping entries appended in between as
 * verified, which no later bounded pass would ever reach (ADR-0371).
 */
export function checkpointFromTail(tail: ChainTail, meta: CheckpointMeta): ChainCheckpoint {
  return ChainCheckpointSchema.parse({
    sequenceNumber: tail.sequenceNumber,
    rootHash: tail.entryHash,
    checkpointedAt: meta.checkpointedAt,
    checkpointedBy: meta.checkpointedBy,
    externalAnchorReference: meta.externalAnchorReference,
    algorithm: meta.algorithm,
    provenance: meta.provenance,
  });
}
