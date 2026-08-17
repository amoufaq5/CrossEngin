import {
  ChainCheckpointSchema,
  lastEntryHash,
  type ChainCheckpoint,
  type ChainedLogEntry,
} from "@crossengin/forensics";

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
}

/**
 * Builds a `ChainCheckpoint` anchored at the chain tail: `sequenceNumber` is the last entry's sequence,
 * `rootHash` is that entry's hash. An empty chain has no tail to anchor, so this throws — a genesis-only
 * checkpoint carries no verification value.
 */
export function checkpointFromChain(
  entries: readonly ChainedLogEntry[],
  meta: CheckpointMeta,
): ChainCheckpoint {
  if (entries.length === 0) {
    throw new Error("cannot checkpoint an empty chain");
  }
  const tail = entries[entries.length - 1]!;
  return ChainCheckpointSchema.parse({
    sequenceNumber: tail.sequenceNumber,
    rootHash: lastEntryHash(entries),
    checkpointedAt: meta.checkpointedAt,
    checkpointedBy: meta.checkpointedBy,
    externalAnchorReference: meta.externalAnchorReference,
    algorithm: meta.algorithm,
  });
}
