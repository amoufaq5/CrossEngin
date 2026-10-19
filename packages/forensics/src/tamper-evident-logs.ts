import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const HASH_ALGORITHMS = ["sha256", "sha512", "blake3"] as const;
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

export const LOG_KINDS = [
  "audit_event",
  "access_event",
  "data_change",
  "config_change",
  "security_event",
  "deletion_event",
  "approval_decision",
] as const;
export type LogKind = (typeof LOG_KINDS)[number];
export const LogKindSchema = z.enum(LOG_KINDS);

export const GENESIS_HASH = "0".repeat(64);

export const ChainedLogEntrySchema = z
  .object({
    sequenceNumber: z.number().int().nonnegative(),
    kind: LogKindSchema,
    recordedAt: Iso8601,
    actorReference: z.string().min(1),
    payloadSha256: z.string().regex(SHA256_REGEX),
    payloadSizeBytes: z.number().int().nonnegative(),
    priorEntryHash: z.string().regex(SHA256_REGEX),
    entryHash: z.string().regex(SHA256_REGEX),
    signingKeyFingerprint: z.string().regex(SHA256_REGEX),
    signature: z.string().min(1),
  })
  .strict();
export type ChainedLogEntry = z.infer<typeof ChainedLogEntrySchema>;

export const ChainedLogSchema = z
  .array(ChainedLogEntrySchema)
  .superRefine((entries, ctx) => {
    if (entries.length === 0) return;
    let expectedSeq = 0;
    let expectedPrior = GENESIS_HASH;
    entries.forEach((e, i) => {
      if (e.sequenceNumber !== expectedSeq) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "sequenceNumber"],
          message: `expected sequenceNumber ${expectedSeq.toString()}, got ${e.sequenceNumber.toString()}`,
        });
      }
      if (e.priorEntryHash !== expectedPrior) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "priorEntryHash"],
          message: `hash chain broken: expected priorEntryHash ${expectedPrior}, got ${e.priorEntryHash}`,
        });
      }
      if (e.entryHash === e.priorEntryHash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "entryHash"],
          message: "entryHash must differ from priorEntryHash",
        });
      }
      expectedSeq = e.sequenceNumber + 1;
      expectedPrior = e.entryHash;
    });
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const curr = entries[i]!;
      if (new Date(curr.recordedAt).getTime() < new Date(prev.recordedAt).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "recordedAt"],
          message: "recordedAt must be non-decreasing along the chain",
        });
      }
    }
  });
export type ChainedLog = z.infer<typeof ChainedLogSchema>;

/**
 * How a checkpoint came to be trusted — the fact a bounded verification rests on and that no
 * checkpoint used to carry.
 *
 * A checkpoint-anchored verify folds only the entries *after* the anchor and takes the prefix on
 * trust, which is sound exactly when something verified that prefix. `verified_full` is a fold from
 * genesis; `verified_suffix` is a fold from the previous checkpoint, which is sound inductively
 * because that one carried a provenance too. `unverified` is an anchor placed at a tail nobody
 * checked: it may be perfectly honest, and nothing about it can be relied on, so it cannot anchor
 * anything.
 */
export const CHECKPOINT_PROVENANCES = ["verified_full", "verified_suffix", "unverified"] as const;
export type CheckpointProvenance = (typeof CHECKPOINT_PROVENANCES)[number];

/**
 * Whether a bounded verification may take this anchor's prefix on trust. A total map so a fourth
 * provenance is a compile error here rather than a value that inherits whichever answer an
 * `if`-chain happened to end on — and this is the one place that decides, which is why it is not
 * spelled at the two call sites.
 */
export const CHECKPOINT_PROVENANCE_ANCHORS_A_BOUNDED_PROOF: Record<CheckpointProvenance, boolean> =
  {
    verified_full: true,
    verified_suffix: true,
    unverified: false,
  };

/**
 * `false` for an absent provenance, which is **not** the same fact as `unverified` and is kept
 * distinct for ADR-0331's reason: `unverified` is a record *stating* that nothing checked the
 * prefix, while absent means this row's columns do not cover the question — every checkpoint
 * written before the column existed. Both answer `false`, because a prefix nothing can vouch for is
 * not a prefix to trust; the difference is what an operator is told, and a caller that needs to say
 * which reads `provenance` itself.
 */
export function checkpointAnchorsBoundedProof(
  provenance: CheckpointProvenance | undefined,
): boolean {
  if (provenance === undefined) return false;
  return CHECKPOINT_PROVENANCE_ANCHORS_A_BOUNDED_PROOF[provenance];
}

export const ChainCheckpointSchema = z
  .object({
    sequenceNumber: z.number().int().nonnegative(),
    rootHash: z.string().regex(SHA256_REGEX),
    checkpointedAt: Iso8601,
    checkpointedBy: z.string().min(1),
    externalAnchorReference: z.string().min(1).optional(),
    algorithm: z.enum(HASH_ALGORITHMS).default("sha256"),
    /**
     * Optional, with **no default**, for `TombstoneRecordStorageDeclaration`'s reason (ADR-0351):
     * every checkpoint on disk predates the column, and all three values are *claims*, so
     * defaulting one would assert something about rows whose writer asserted nothing. Absent is a
     * gap, and `checkpointAnchorsBoundedProof` answers `false` for it.
     */
    provenance: z.enum(CHECKPOINT_PROVENANCES).optional(),
  })
  .strict();
export type ChainCheckpoint = z.infer<typeof ChainCheckpointSchema>;

export function verifyChainIntegrity(
  entries: readonly ChainedLogEntry[],
): { readonly valid: boolean; readonly brokenAt: number | null; readonly reason?: string } {
  let priorHash = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e === undefined) continue;
    if (e.sequenceNumber !== i) {
      return { valid: false, brokenAt: i, reason: "sequence gap" };
    }
    if (e.priorEntryHash !== priorHash) {
      return { valid: false, brokenAt: i, reason: "hash chain broken" };
    }
    priorHash = e.entryHash;
  }
  return { valid: true, brokenAt: null };
}

export function lastEntryHash(entries: readonly ChainedLogEntry[]): string {
  if (entries.length === 0) return GENESIS_HASH;
  return entries[entries.length - 1]?.entryHash ?? GENESIS_HASH;
}

export function nextSequenceNumber(entries: readonly ChainedLogEntry[]): number {
  return entries.length;
}
