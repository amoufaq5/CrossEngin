import { z } from "zod";
import {
  ChainedLogEntrySchema,
  LogKindSchema,
  type ChainedLogEntry,
} from "@crossengin/forensics";

export { ChainedLogEntrySchema };
export type { ChainedLogEntry };

export const ChainAppendInputSchema = z
  .object({
    tenantId: z.string().uuid().nullable(),
    kind: LogKindSchema,
    actorReference: z.string().min(1),
    recordedAt: z.string().datetime({ offset: true }),
    payload: z.union([z.string(), z.instanceof(Uint8Array)]),
  })
  .strict();
export type ChainAppendInput = z.infer<typeof ChainAppendInputSchema>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : asString(value);
}

function asInt(value: unknown): number {
  return Number(value ?? 0);
}

/** Postgres `CHAR(64)` right-pads with spaces; sha256 hex is exactly 64 chars, but trim defensively. */
function asHash(value: unknown): string {
  return asString(value).trim();
}

export function rowToChainEntry(row: Record<string, unknown>): ChainedLogEntry {
  return ChainedLogEntrySchema.parse({
    sequenceNumber: asInt(row["sequence_number"]),
    kind: asString(row["kind"]),
    recordedAt: asIso(row["recorded_at"]),
    actorReference: asString(row["actor_reference"]),
    payloadSha256: asHash(row["payload_sha256"]),
    payloadSizeBytes: asInt(row["payload_size_bytes"]),
    priorEntryHash: asHash(row["prior_entry_hash"]),
    entryHash: asHash(row["entry_hash"]),
    signingKeyFingerprint: asHash(row["signing_key_fingerprint"]),
    signature: asString(row["signature"]),
  });
}
