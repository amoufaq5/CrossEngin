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

export const ChainCheckpointSchema = z
  .object({
    sequenceNumber: z.number().int().nonnegative(),
    rootHash: z.string().regex(SHA256_REGEX),
    checkpointedAt: Iso8601,
    checkpointedBy: z.string().min(1),
    externalAnchorReference: z.string().min(1).optional(),
    algorithm: z.enum(HASH_ALGORITHMS).default("sha256"),
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
