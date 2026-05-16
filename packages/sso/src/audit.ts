import { z } from "zod";
import { SCIM_OPERATIONS, SCIM_OUTCOMES, SCIM_RESOURCE_TYPES } from "./scim.js";

export const LOGIN_OUTCOMES = [
  "success",
  "mfa_required",
  "mfa_failed",
  "password_expired",
  "account_locked",
  "idp_unreachable",
  "attribute_invalid",
  "denied_by_policy",
] as const;
export type LoginOutcome = (typeof LOGIN_OUTCOMES)[number];

export const LOGIN_INITIATIONS = [
  "sp_initiated",
  "idp_initiated",
  "scim_invoked",
] as const;
export type LoginInitiation = (typeof LOGIN_INITIATIONS)[number];

export const MFA_FACTORS = [
  "totp",
  "webauthn",
  "push_notification",
  "sms",
  "security_question",
] as const;
export type MfaFactor = (typeof MFA_FACTORS)[number];

export const WEAK_MFA_FACTORS: ReadonlySet<MfaFactor> = new Set([
  "sms",
  "security_question",
]);

export const FAILURE_CATEGORIES = [
  "network",
  "credential",
  "mfa",
  "policy",
  "attribute",
  "account",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_BY_OUTCOME: Readonly<
  Record<LoginOutcome, FailureCategory | null>
> = {
  success: null,
  mfa_required: null,
  mfa_failed: "mfa",
  password_expired: "credential",
  account_locked: "account",
  idp_unreachable: "network",
  attribute_invalid: "attribute",
  denied_by_policy: "policy",
};

export const classifyFailure = (
  outcome: LoginOutcome,
): FailureCategory | null => FAILURE_BY_OUTCOME[outcome];

export const isWeakMfaFactor = (factor: MfaFactor): boolean =>
  WEAK_MFA_FACTORS.has(factor);

export const LoginRecordSchema = z
  .object({
    id: z.string().regex(/^login_[A-Za-z0-9_-]{8,64}$/),
    tenantId: z.string().uuid(),
    providerId: z.string().regex(/^sso_[a-z0-9]{8,32}$/),
    requestId: z.string().min(1).max(128),
    initiatedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    latencyMs: z.number().int().min(0).max(600_000).nullable(),
    outcome: z.enum(LOGIN_OUTCOMES),
    initiation: z.enum(LOGIN_INITIATIONS),
    federatedSubjectId: z.string().max(512).nullable(),
    requestedNameIdFormat: z.string().max(256).nullable(),
    principalId: z.string().uuid().nullable(),
    mfaFactor: z.enum(MFA_FACTORS).nullable(),
    mfaCompletedAt: z.string().datetime({ offset: true }).nullable(),
    failureCategory: z.enum(FAILURE_CATEGORIES).nullable(),
    failureReason: z.string().max(500).nullable(),
    ipAddress: z.string().min(1).max(45),
    userAgent: z.string().max(512),
    asNumber: z.number().int().min(0).max(4_294_967_295).nullable(),
    geoCountry: z.string().regex(/^[A-Z]{2}$/).nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.outcome === "success" && r.principalId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["principalId"],
        message: "success outcome requires principalId",
      });
    }
    if (r.outcome === "success" && r.failureCategory !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureCategory"],
        message: "success outcome must not have failureCategory",
      });
    }
    const expectedCategory = FAILURE_BY_OUTCOME[r.outcome];
    if (
      expectedCategory !== null &&
      r.outcome !== "mfa_required" &&
      r.failureCategory !== expectedCategory
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureCategory"],
        message: `outcome ${r.outcome} requires failureCategory ${expectedCategory}`,
      });
    }
    if (r.completedAt !== null) {
      const initiated = Date.parse(r.initiatedAt);
      const completed = Date.parse(r.completedAt);
      if (completed < initiated) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "completedAt cannot precede initiatedAt",
        });
      }
      if (r.latencyMs !== null) {
        const expected = completed - initiated;
        if (Math.abs(expected - r.latencyMs) > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["latencyMs"],
            message: `latencyMs (${r.latencyMs}) does not match completedAt - initiatedAt (${expected})`,
          });
        }
      }
    }
    if (r.outcome === "mfa_failed" && r.mfaFactor === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mfaFactor"],
        message: "mfa_failed outcome requires mfaFactor",
      });
    }
  });
export type LoginRecord = z.infer<typeof LoginRecordSchema>;

export const ScimProvisioningRecordSchema = z
  .object({
    id: z.string().regex(/^scim_[A-Za-z0-9_-]{8,64}$/),
    tenantId: z.string().uuid(),
    scimClientId: z.string().uuid(),
    providerId: z.string().regex(/^sso_[a-z0-9]{8,32}$/),
    requestId: z.string().min(1).max(128),
    resourceType: z.enum(SCIM_RESOURCE_TYPES),
    operation: z.enum(SCIM_OPERATIONS),
    targetResourceId: z.string().max(256).nullable(),
    requestedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    latencyMs: z.number().int().min(0).max(600_000),
    outcome: z.enum(SCIM_OUTCOMES),
    bytesRequest: z.number().int().min(0),
    bytesResponse: z.number().int().min(0),
    errorMessage: z.string().max(500).nullable(),
  })
  .superRefine((r, ctx) => {
    const requested = Date.parse(r.requestedAt);
    const completed = Date.parse(r.completedAt);
    if (completed < requested) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt cannot precede requestedAt",
      });
    }
    const expected = completed - requested;
    if (Math.abs(expected - r.latencyMs) > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["latencyMs"],
        message: `latencyMs (${r.latencyMs}) does not match completedAt - requestedAt (${expected})`,
      });
    }
    const failureOutcomes: ReadonlySet<string> = new Set([
      "conflict",
      "invalid_filter",
      "invalid_path",
      "invalid_value",
      "not_found",
      "forbidden",
      "rate_limited",
      "schema_violation",
    ]);
    if (failureOutcomes.has(r.outcome) && r.errorMessage === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: `failure outcome ${r.outcome} requires errorMessage`,
      });
    }
  });
export type ScimProvisioningRecord = z.infer<typeof ScimProvisioningRecordSchema>;

export interface LoginAggregateStats {
  readonly totalLogins: number;
  readonly successfulLogins: number;
  readonly mfaChallengedLogins: number;
  readonly failedLogins: number;
  readonly successRate: number;
  readonly failuresByCategory: Readonly<Record<FailureCategory, number>>;
  readonly p50LatencyMs: number;
  readonly p99LatencyMs: number;
}

const computePercentile = (
  sortedValues: readonly number[],
  percentile: number,
): number => {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.floor((percentile / 100) * sortedValues.length),
  );
  return sortedValues[idx] ?? 0;
};

export const aggregateLogins = (
  records: readonly LoginRecord[],
): LoginAggregateStats => {
  if (records.length === 0) {
    return {
      totalLogins: 0,
      successfulLogins: 0,
      mfaChallengedLogins: 0,
      failedLogins: 0,
      successRate: 0,
      failuresByCategory: {
        network: 0,
        credential: 0,
        mfa: 0,
        policy: 0,
        attribute: 0,
        account: 0,
      },
      p50LatencyMs: 0,
      p99LatencyMs: 0,
    };
  }
  let successful = 0;
  let mfaChallenged = 0;
  let failed = 0;
  const failuresByCategory: Record<FailureCategory, number> = {
    network: 0,
    credential: 0,
    mfa: 0,
    policy: 0,
    attribute: 0,
    account: 0,
  };
  const latencies: number[] = [];
  for (const r of records) {
    if (r.outcome === "success") successful++;
    else if (r.outcome === "mfa_required") mfaChallenged++;
    else {
      failed++;
      if (r.failureCategory !== null) failuresByCategory[r.failureCategory]++;
    }
    if (r.latencyMs !== null) latencies.push(r.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  return {
    totalLogins: records.length,
    successfulLogins: successful,
    mfaChallengedLogins: mfaChallenged,
    failedLogins: failed,
    successRate: successful / records.length,
    failuresByCategory,
    p50LatencyMs: computePercentile(latencies, 50),
    p99LatencyMs: computePercentile(latencies, 99),
  };
};

export interface SuspiciousLoginInput {
  readonly record: LoginRecord;
  readonly priorRecords: readonly LoginRecord[];
  readonly failureWindowSeconds: number;
  readonly failureThreshold: number;
  readonly geoVelocityKmPerHourThreshold: number;
}

export interface GeoPoint {
  readonly country: string;
  readonly latitude: number;
  readonly longitude: number;
}

export const isLoginBurstFailure = (
  record: LoginRecord,
  priorRecords: readonly LoginRecord[],
  windowSeconds: number,
  threshold: number,
): boolean => {
  const recordMs = Date.parse(record.initiatedAt);
  const windowStart = recordMs - windowSeconds * 1000;
  const recentFailures = priorRecords.filter((r) => {
    const t = Date.parse(r.initiatedAt);
    return (
      r.federatedSubjectId === record.federatedSubjectId &&
      t >= windowStart &&
      t < recordMs &&
      r.outcome !== "success" &&
      r.outcome !== "mfa_required"
    );
  });
  return recentFailures.length >= threshold;
};
