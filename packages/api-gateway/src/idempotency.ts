import { z } from "zod";

export const IDEMPOTENCY_OUTCOMES = [
  "no_key_required",
  "no_key_provided",
  "first_seen",
  "replay_hit_match",
  "replay_hit_mismatch",
  "replay_in_progress",
  "replay_expired",
  "replay_not_allowed_for_method",
] as const;
export type IdempotencyOutcome = (typeof IDEMPOTENCY_OUTCOMES)[number];

export const IDEMPOTENCY_RECORD_STATUSES = [
  "in_progress",
  "completed_success",
  "completed_error",
  "expired",
] as const;
export type IdempotencyRecordStatus =
  (typeof IDEMPOTENCY_RECORD_STATUSES)[number];

export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86_400;

export const IdempotencyKeyShapeSchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const IdempotencyRecordSchema = z
  .object({
    id: z.string().regex(/^idem_[A-Za-z0-9_-]{8,64}$/),
    tenantId: z.string().uuid(),
    operationId: z.string().max(120),
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    idempotencyKey: IdempotencyKeyShapeSchema,
    requestHashSha256: z.string().regex(/^[0-9a-f]{64}$/),
    principalId: z.string().uuid().nullable(),
    receivedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    status: z.enum(IDEMPOTENCY_RECORD_STATUSES),
    responseStatus: z.number().int().min(100).max(599).nullable(),
    responseSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    responseStorageUri: z.string().min(1).max(500).nullable(),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    errorCode: z.string().max(80).nullable(),
    errorMessage: z.string().max(500).nullable(),
  })
  .superRefine((r, ctx) => {
    if (Date.parse(r.expiresAt) <= Date.parse(r.receivedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after receivedAt",
      });
    }
    if (r.status === "completed_success") {
      if (
        r.responseStatus === null ||
        r.responseSha256 === null ||
        r.completedAt === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message:
            "completed_success requires responseStatus + responseSha256 + completedAt",
        });
      }
    }
    if (r.status === "completed_error") {
      if (
        r.errorCode === null ||
        r.errorMessage === null ||
        r.completedAt === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message:
            "completed_error requires errorCode + errorMessage + completedAt",
        });
      }
    }
  });
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

export interface IdempotencyCheckInput {
  readonly key: string | null;
  readonly method: string;
  readonly operationIdempotencyRequired: boolean;
  readonly existing: IdempotencyRecord | null;
  readonly currentRequestHashSha256: string;
  readonly now: Date;
}

export interface IdempotencyCheckResult {
  readonly outcome: IdempotencyOutcome;
  readonly reason: string;
  readonly replayedRecord: IdempotencyRecord | null;
}

const NON_IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const evaluateIdempotency = (
  input: IdempotencyCheckInput,
): IdempotencyCheckResult => {
  if (!NON_IDEMPOTENT_METHODS.has(input.method)) {
    return {
      outcome: "replay_not_allowed_for_method",
      reason: `method_${input.method}_does_not_use_idempotency`,
      replayedRecord: null,
    };
  }
  if (input.key === null) {
    if (input.operationIdempotencyRequired) {
      return {
        outcome: "no_key_provided",
        reason: "operation_requires_idempotency_key_header",
        replayedRecord: null,
      };
    }
    return {
      outcome: "no_key_required",
      reason: "operation_does_not_require_idempotency",
      replayedRecord: null,
    };
  }
  if (input.existing === null) {
    return {
      outcome: "first_seen",
      reason: "new_idempotency_key",
      replayedRecord: null,
    };
  }
  const expiresMs = Date.parse(input.existing.expiresAt);
  if (input.now.getTime() >= expiresMs) {
    return {
      outcome: "replay_expired",
      reason: "existing_record_past_ttl",
      replayedRecord: null,
    };
  }
  if (
    input.existing.requestHashSha256 !== input.currentRequestHashSha256
  ) {
    return {
      outcome: "replay_hit_mismatch",
      reason: "same_key_different_request_body",
      replayedRecord: input.existing,
    };
  }
  if (input.existing.status === "in_progress") {
    return {
      outcome: "replay_in_progress",
      reason: "previous_request_still_processing",
      replayedRecord: input.existing,
    };
  }
  return {
    outcome: "replay_hit_match",
    reason: "exact_replay_serves_cached_response",
    replayedRecord: input.existing,
  };
};

export const computeRequestHashInputs = (input: {
  readonly method: string;
  readonly path: string;
  readonly principalId: string | null;
  readonly bodySha256: string | null;
}): string => {
  const parts: string[] = [
    input.method,
    input.path,
    input.principalId ?? "anonymous",
    input.bodySha256 ?? "no-body",
  ];
  return parts.join("|");
};

export const isReplayConflict = (
  outcome: IdempotencyOutcome,
): boolean =>
  outcome === "replay_hit_mismatch" || outcome === "replay_in_progress";

export const isReplayServable = (
  outcome: IdempotencyOutcome,
): boolean => outcome === "replay_hit_match";
