import { z } from "zod";

export const SIGNAL_DELIVERY_GUARANTEES = [
  "at_most_once",
  "at_least_once",
  "exactly_once_idempotent",
] as const;
export type SignalDeliveryGuarantee =
  (typeof SIGNAL_DELIVERY_GUARANTEES)[number];

export const SIGNAL_STATUSES = [
  "received",
  "matched_to_instance",
  "consumed",
  "expired",
  "rejected",
] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const SIGNAL_TRANSITIONS: Readonly<
  Record<SignalStatus, readonly SignalStatus[]>
> = {
  received: ["matched_to_instance", "expired", "rejected"],
  matched_to_instance: ["consumed", "expired"],
  consumed: [],
  expired: [],
  rejected: [],
};

export const canTransitionSignal = (
  from: SignalStatus,
  to: SignalStatus,
): boolean => SIGNAL_TRANSITIONS[from].includes(to);

export const SIGNAL_REJECTION_REASONS = [
  "no_matching_instance",
  "instance_terminal",
  "signal_not_declared",
  "duplicate_idempotency_key",
  "payload_schema_mismatch",
  "expired_before_match",
  "tenant_mismatch",
] as const;
export type SignalRejectionReason = (typeof SIGNAL_REJECTION_REASONS)[number];

export const WorkflowSignalSchema = z
  .object({
    id: z.string().regex(/^wfs_[a-z0-9]{8,40}$/),
    tenantId: z.string().uuid(),
    instanceId: z.string().regex(/^wfi_[a-z0-9]{8,40}$/).nullable(),
    signalName: z.string().regex(/^[a-z][a-z0-9_.-]*$/).max(120),
    correlationKey: z.string().min(1).max(200),
    deliveryGuarantee: z.enum(SIGNAL_DELIVERY_GUARANTEES),
    idempotencyKey: z.string().max(120).nullable(),
    payloadSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    payloadStorageUri: z.string().min(1).max(500).nullable(),
    payloadSizeBytes: z.number().int().min(0).max(10_000_000),
    sourceSystem: z.string().min(1).max(120),
    sourcePrincipalId: z.string().uuid().nullable(),
    status: z.enum(SIGNAL_STATUSES),
    receivedAt: z.string().datetime({ offset: true }),
    matchedAt: z.string().datetime({ offset: true }).nullable(),
    consumedAt: z.string().datetime({ offset: true }).nullable(),
    consumedByActivityId: z.string().regex(/^wfa_[a-z0-9]{8,40}$/).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    expiredAt: z.string().datetime({ offset: true }).nullable(),
    rejectedAt: z.string().datetime({ offset: true }).nullable(),
    rejectedReason: z.enum(SIGNAL_REJECTION_REASONS).nullable(),
  })
  .superRefine((s, ctx) => {
    if (
      s.deliveryGuarantee === "exactly_once_idempotent" &&
      s.idempotencyKey === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idempotencyKey"],
        message:
          "exactly_once_idempotent delivery requires idempotencyKey",
      });
    }
    if (s.payloadSha256 !== null && s.payloadSizeBytes === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloadSizeBytes"],
        message: "payload sha256 set but size is zero",
      });
    }
    if (s.payloadSha256 === null && s.payloadStorageUri !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloadSha256"],
        message: "payloadStorageUri set requires payloadSha256",
      });
    }
    if (s.status === "matched_to_instance") {
      if (s.instanceId === null || s.matchedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matchedAt"],
          message:
            "matched_to_instance status requires instanceId + matchedAt",
        });
      }
    }
    if (s.status === "consumed") {
      if (s.instanceId === null || s.matchedAt === null || s.consumedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["consumedAt"],
          message:
            "consumed status requires instanceId + matchedAt + consumedAt",
        });
      }
    }
    if (s.status === "rejected") {
      if (s.rejectedAt === null || s.rejectedReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rejectedReason"],
          message: "rejected status requires rejectedAt + rejectedReason",
        });
      }
    }
    if (s.status === "expired" && s.expiredAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiredAt"],
        message: "expired status requires expiredAt",
      });
    }
    if (
      s.expiresAt !== null &&
      Date.parse(s.expiresAt) <= Date.parse(s.receivedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after receivedAt",
      });
    }
    if (
      s.matchedAt !== null &&
      Date.parse(s.matchedAt) < Date.parse(s.receivedAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matchedAt"],
        message: "matchedAt cannot precede receivedAt",
      });
    }
  });
export type WorkflowSignal = z.infer<typeof WorkflowSignalSchema>;

export const isSignalExpired = (
  signal: WorkflowSignal,
  now: Date,
): boolean => {
  if (signal.expiresAt === null) return false;
  if (signal.status === "consumed") return false;
  if (signal.status === "expired") return true;
  if (signal.status === "rejected") return false;
  return now.getTime() >= Date.parse(signal.expiresAt);
};

export const findDuplicateSignal = (
  signals: readonly WorkflowSignal[],
  candidate: { signalName: string; idempotencyKey: string | null },
): WorkflowSignal | null => {
  if (candidate.idempotencyKey === null) return null;
  return (
    signals.find(
      (s) =>
        s.signalName === candidate.signalName &&
        s.idempotencyKey === candidate.idempotencyKey,
    ) ?? null
  );
};

export const matchSignalToInstance = (
  signal: WorkflowSignal,
  instances: readonly { id: string; correlationKey: string | null; awaitingSignalNames: readonly string[]; tenantId: string }[],
): string | null => {
  for (const instance of instances) {
    if (instance.tenantId !== signal.tenantId) continue;
    if (instance.correlationKey !== signal.correlationKey) continue;
    if (!instance.awaitingSignalNames.includes(signal.signalName)) continue;
    return instance.id;
  }
  return null;
};
