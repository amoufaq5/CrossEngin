import { z } from "zod";

import {
  KEY_ALGORITHMS,
  KEY_PURPOSES,
  type KeyAlgorithm,
  type KeyPurpose,
} from "./algorithms.js";

export const CRYPTO_OPERATIONS = [
  "sign",
  "verify",
  "hmac",
  "verify_hmac",
  "hash",
  "create_key",
  "rotate_key",
  "destroy_key",
  "get_public",
] as const;
export type CryptoOperation = (typeof CRYPTO_OPERATIONS)[number];

export const AUTO_AUDITED_OPERATIONS: ReadonlySet<CryptoOperation> = new Set([
  "create_key",
  "rotate_key",
  "destroy_key",
]);

export function isCryptoOperation(value: unknown): value is CryptoOperation {
  return typeof value === "string" && (CRYPTO_OPERATIONS as readonly string[]).includes(value);
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID_REGEX = /^key_(hmac-sha256|ed25519)_[0-9A-HJKMNP-TV-Z]{26}$/;

export const CryptoAuditRecordSchema = z
  .object({
    id: z.string().regex(UUID_REGEX),
    tenantId: z.string().regex(UUID_REGEX).nullable(),
    keyId: z.string().regex(KEY_ID_REGEX).nullable(),
    algorithm: z.enum(KEY_ALGORITHMS as readonly [KeyAlgorithm, ...KeyAlgorithm[]]).nullable(),
    purpose: z.enum(KEY_PURPOSES as readonly [KeyPurpose, ...KeyPurpose[]]).nullable(),
    operation: z.enum(CRYPTO_OPERATIONS),
    principalId: z.string().regex(UUID_REGEX).nullable(),
    succeeded: z.boolean(),
    errorMessage: z.string().min(1).max(2_000).nullable(),
    durationMs: z.number().int().nonnegative(),
    performedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((rec, ctx) => {
    if (!rec.succeeded && rec.errorMessage === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: "errorMessage is required when succeeded is false",
      });
    }
    if (rec.succeeded && rec.errorMessage !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: "errorMessage must be null when succeeded is true",
      });
    }
  });

export type CryptoAuditRecord = z.infer<typeof CryptoAuditRecordSchema>;

export interface CryptoAuditSink {
  record(entry: CryptoAuditRecord): void;
}

export class InMemoryAuditSink implements CryptoAuditSink {
  private readonly entries: CryptoAuditRecord[] = [];

  record(entry: CryptoAuditRecord): void {
    CryptoAuditRecordSchema.parse(entry);
    this.entries.push(entry);
  }

  list(): readonly CryptoAuditRecord[] {
    return this.entries;
  }

  count(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export function isAutoAudited(operation: CryptoOperation): boolean {
  return AUTO_AUDITED_OPERATIONS.has(operation);
}
