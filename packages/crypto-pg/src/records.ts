import { z } from "zod";
import {
  KEY_ALGORITHMS,
  KEY_PURPOSES,
  type KeyRecord,
} from "@crossengin/crypto";

const KEY_ID_REGEX = /^key_(hmac-sha256|ed25519)_[0-9A-HJKMNP-TV-Z]{26}$/;
const FINGERPRINT_REGEX = /^[0-9a-f]{64}$/;

export const KEY_STATUSES = ["active", "rotating", "revoked"] as const;
export type KeyRegistryStatus = (typeof KEY_STATUSES)[number];

export const KeyRegistryRecordSchema = z
  .object({
    keyId: z.string().regex(KEY_ID_REGEX),
    tenantId: z.string().uuid().nullable(),
    algorithm: z.enum(KEY_ALGORITHMS),
    purpose: z.enum(KEY_PURPOSES),
    publicKeyBase64: z.string().min(1).nullable(),
    fingerprint: z.string().regex(FINGERPRINT_REGEX).nullable(),
    keyVersion: z.number().int().positive(),
    status: z.enum(KEY_STATUSES),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type KeyRegistryRecord = z.infer<typeof KeyRegistryRecordSchema>;

/**
 * Projects the crypto `KeyRecord` down to its persisted public/lifecycle view.
 *
 * `KeyRecord.rotatedFromKeyId` (a crypto `KeyId` string) is intentionally dropped:
 * the table's `rotated_from_key_id` column is a UUID FK to the surrogate `crypto_keys.id`,
 * not the crypto `KeyId`, so the two cannot be reconciled without a surrogate-id lookup.
 */
export function keyRegistryRecordFrom(record: KeyRecord): KeyRegistryRecord {
  return KeyRegistryRecordSchema.parse({
    keyId: record.handle.id,
    tenantId: record.handle.tenantId,
    algorithm: record.handle.algorithm,
    purpose: record.handle.purpose,
    publicKeyBase64: record.publicKeyBase64,
    fingerprint: record.fingerprint,
    keyVersion: record.handle.version,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
  });
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asInt(value: unknown): number {
  return Number(value ?? 0);
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : asString(value);
}

/** Postgres `CHAR(64)` right-pads with spaces; a sha256 fingerprint is exactly 64 chars, but trim defensively. */
function asNullableHash(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).trim();
}

export function rowToKeyRegistryRecord(
  row: Record<string, unknown>,
): KeyRegistryRecord {
  return KeyRegistryRecordSchema.parse({
    keyId: asString(row["key_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    algorithm: asString(row["algorithm"]),
    purpose: asString(row["purpose"]),
    publicKeyBase64: asNullableString(row["public_key_base64"]),
    fingerprint: asNullableHash(row["fingerprint_sha256"]),
    keyVersion: asInt(row["key_version"]),
    status: asString(row["status"]),
    createdAt: asIso(row["created_at"]),
  });
}
