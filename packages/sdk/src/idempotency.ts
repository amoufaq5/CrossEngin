import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{8,64}$/;
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const SdkIdempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_REGEX, {
  message: "Idempotency-Key must be 8..64 chars of [A-Za-z0-9_-] (UUID v7 or alphanumeric token)",
});
export type SdkIdempotencyKey = z.infer<typeof SdkIdempotencyKeySchema>;

export const IDEMPOTENCY_TTL_MIN_SECONDS = 1;
export const IDEMPOTENCY_TTL_MAX_SECONDS = 172_800;
export const IDEMPOTENCY_TTL_DEFAULT_SECONDS = 86_400;

export const IDEMPOTENCY_OUTCOMES = ["stored", "replayed", "conflict", "in_progress"] as const;
export type IdempotencyOutcome = (typeof IDEMPOTENCY_OUTCOMES)[number];
export const IdempotencyOutcomeSchema = z.enum(IDEMPOTENCY_OUTCOMES);

export const IdempotencyRecordSchema = z
  .object({
    key: SdkIdempotencyKeySchema,
    tenantId: z.string().min(1),
    method: z.string().min(1),
    path: z.string().regex(/^\/[A-Za-z0-9._\-/:]*$/),
    requestHash: z.string().regex(SHA256_REGEX),
    responseStatus: z.number().int().min(100).max(599).nullable(),
    responseBodyHash: z.string().regex(SHA256_REGEX).nullable(),
    createdAt: Iso8601,
    expiresAt: Iso8601,
    completedAt: Iso8601.nullable().default(null),
    inProgress: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const createdTime = new Date(v.createdAt).getTime();
    const expiresTime = new Date(v.expiresAt).getTime();
    if (expiresTime <= createdTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after createdAt",
      });
    }
    const ttlSeconds = Math.floor((expiresTime - createdTime) / 1000);
    if (ttlSeconds > IDEMPOTENCY_TTL_MAX_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: `idempotency TTL cannot exceed ${IDEMPOTENCY_TTL_MAX_SECONDS} seconds (48h)`,
      });
    }
    if (v.inProgress) {
      if (v.responseStatus !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseStatus"],
          message: "inProgress=true requires responseStatus=null",
        });
      }
      if (v.completedAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "inProgress=true requires completedAt=null",
        });
      }
    } else {
      if (v.responseStatus === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseStatus"],
          message: "completed records (inProgress=false) require responseStatus",
        });
      }
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completed records require completedAt",
        });
      }
      if (v.responseBodyHash === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseBodyHash"],
          message: "completed records require responseBodyHash",
        });
      }
    }
  });
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

export function canonicalRequestString(input: {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
}): string {
  const body = input.body ?? "";
  return `${input.method.toUpperCase()}\n${input.path}\n${body}`;
}

export function isIdempotencyConflict(
  stored: IdempotencyRecord,
  candidate: {
    readonly method: string;
    readonly path: string;
    readonly requestHash: string;
  },
): boolean {
  if (stored.method.toUpperCase() !== candidate.method.toUpperCase()) return true;
  if (stored.path !== candidate.path) return true;
  return stored.requestHash !== candidate.requestHash;
}

export function isIdempotencyExpired(record: IdempotencyRecord, now: Date = new Date()): boolean {
  return now.getTime() >= new Date(record.expiresAt).getTime();
}

export function clampTtlSeconds(seconds: number): number {
  if (seconds < IDEMPOTENCY_TTL_MIN_SECONDS) return IDEMPOTENCY_TTL_MIN_SECONDS;
  if (seconds > IDEMPOTENCY_TTL_MAX_SECONDS) return IDEMPOTENCY_TTL_MAX_SECONDS;
  return Math.floor(seconds);
}

export interface IdempotencyResolveInput {
  readonly existing: IdempotencyRecord | null;
  readonly candidate: {
    readonly method: string;
    readonly path: string;
    readonly requestHash: string;
  };
  readonly now: Date;
}

export interface IdempotencyResolveOutcome {
  readonly outcome: IdempotencyOutcome;
  readonly reason: string;
}

export function resolveIdempotency(input: IdempotencyResolveInput): IdempotencyResolveOutcome {
  if (input.existing === null) {
    return { outcome: "stored", reason: "no prior record; first execution" };
  }
  if (isIdempotencyExpired(input.existing, input.now)) {
    return { outcome: "stored", reason: "prior record expired; new execution" };
  }
  if (input.existing.inProgress) {
    return {
      outcome: "in_progress",
      reason: "prior request is still being processed",
    };
  }
  if (isIdempotencyConflict(input.existing, input.candidate)) {
    return {
      outcome: "conflict",
      reason: "request hash differs from prior request with the same key",
    };
  }
  return { outcome: "replayed", reason: "request matches; replay response" };
}
