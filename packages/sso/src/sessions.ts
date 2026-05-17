import { z } from "zod";

export const SSO_SESSION_STATUSES = [
  "active",
  "expired",
  "revoked",
  "logged_out",
] as const;
export type SsoSessionStatus = (typeof SSO_SESSION_STATUSES)[number];

export const SSO_SESSION_TRANSITIONS: Readonly<
  Record<SsoSessionStatus, readonly SsoSessionStatus[]>
> = {
  active: ["expired", "logged_out", "revoked"],
  expired: [],
  logged_out: [],
  revoked: [],
};

export const canTransitionSession = (
  from: SsoSessionStatus,
  to: SsoSessionStatus,
): boolean => SSO_SESSION_TRANSITIONS[from].includes(to);

export const SLO_KINDS = [
  "sp_initiated",
  "idp_initiated",
  "idle_timeout",
  "absolute_timeout",
  "admin_revoke",
  "policy_violation",
  "mfa_step_up_failed",
] as const;
export type SloKind = (typeof SLO_KINDS)[number];

export const SESSION_BINDINGS = [
  "cookie",
  "jwt_bearer",
  "opaque_token",
  "ldap_kerberos",
] as const;
export type SessionBinding = (typeof SESSION_BINDINGS)[number];

export const SsoSessionSchema = z
  .object({
    id: z.string().regex(/^sess_[A-Za-z0-9_-]{12,64}$/),
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    providerId: z.string().regex(/^sso_[a-z0-9]{8,32}$/),
    federatedSubjectId: z.string().min(1).max(512),
    binding: z.enum(SESSION_BINDINGS),
    idpSessionIndex: z.string().min(1).max(512).nullable(),
    idpRefreshTokenSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    startedAt: z.string().datetime({ offset: true }),
    lastActivityAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    absoluteExpiresAt: z.string().datetime({ offset: true }),
    status: z.enum(SSO_SESSION_STATUSES),
    terminatedAt: z.string().datetime({ offset: true }).nullable(),
    terminationKind: z.enum(SLO_KINDS).nullable(),
    terminationReason: z.string().max(500).nullable(),
    mfaSatisfiedAt: z.string().datetime({ offset: true }).nullable(),
    ipAddress: z.string().min(1).max(45),
    userAgent: z.string().max(512),
  })
  .superRefine((s, ctx) => {
    const startedAt = Date.parse(s.startedAt);
    const expiresAt = Date.parse(s.expiresAt);
    const absoluteExpiresAt = Date.parse(s.absoluteExpiresAt);
    if (expiresAt <= startedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after startedAt",
      });
    }
    if (absoluteExpiresAt < expiresAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["absoluteExpiresAt"],
        message: "absoluteExpiresAt must be >= expiresAt",
      });
    }
    if (s.status === "active") {
      if (s.terminatedAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["terminatedAt"],
          message: "active session must not have terminatedAt",
        });
      }
      if (s.terminationKind !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["terminationKind"],
          message: "active session must not have terminationKind",
        });
      }
    } else {
      if (s.terminatedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["terminatedAt"],
          message: `${s.status} session must have terminatedAt`,
        });
      }
      if (s.status !== "expired" && s.terminationKind === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["terminationKind"],
          message: `${s.status} session must have terminationKind`,
        });
      }
    }
  });
export type SsoSession = z.infer<typeof SsoSessionSchema>;

export const isSessionActive = (session: SsoSession, now: Date): boolean => {
  if (session.status !== "active") return false;
  const nowMs = now.getTime();
  if (nowMs >= Date.parse(session.absoluteExpiresAt)) return false;
  if (nowMs >= Date.parse(session.expiresAt)) return false;
  return true;
};

export const shouldRefreshSession = (
  session: SsoSession,
  now: Date,
  refreshWindowSeconds: number,
): boolean => {
  if (session.status !== "active") return false;
  const expiresMs = Date.parse(session.expiresAt);
  const nowMs = now.getTime();
  return nowMs >= expiresMs - refreshWindowSeconds * 1000;
};

export const computeIdleTimeoutReached = (
  session: SsoSession,
  now: Date,
  idleTimeoutSeconds: number,
): boolean => {
  const lastActivityMs = Date.parse(session.lastActivityAt);
  const nowMs = now.getTime();
  return nowMs - lastActivityMs >= idleTimeoutSeconds * 1000;
};

export const extendSession = (
  session: SsoSession,
  now: Date,
  ttlSeconds: number,
): SsoSession => {
  const nowIso = now.toISOString();
  const newExpiresMs = now.getTime() + ttlSeconds * 1000;
  const absoluteMs = Date.parse(session.absoluteExpiresAt);
  const cappedExpiresMs = Math.min(newExpiresMs, absoluteMs);
  return {
    ...session,
    lastActivityAt: nowIso,
    expiresAt: new Date(cappedExpiresMs).toISOString(),
  };
};

export const terminateSession = (
  session: SsoSession,
  kind: SloKind,
  reason: string,
  now: Date,
): SsoSession => {
  const newStatus: SsoSessionStatus =
    kind === "idle_timeout" || kind === "absolute_timeout"
      ? "expired"
      : kind === "admin_revoke" || kind === "policy_violation" || kind === "mfa_step_up_failed"
        ? "revoked"
        : "logged_out";
  if (!canTransitionSession(session.status, newStatus)) {
    throw new Error(
      `cannot transition session from ${session.status} to ${newStatus}`,
    );
  }
  return {
    ...session,
    status: newStatus,
    terminatedAt: now.toISOString(),
    terminationKind: kind,
    terminationReason: reason,
  };
};

export const isMfaStillFresh = (
  session: SsoSession,
  now: Date,
  mfaTtlSeconds: number,
): boolean => {
  if (session.mfaSatisfiedAt === null) return false;
  const mfaMs = Date.parse(session.mfaSatisfiedAt);
  const nowMs = now.getTime();
  return nowMs - mfaMs < mfaTtlSeconds * 1000;
};
