import { randomUUID } from "node:crypto";

import type { AuditLogEntry } from "@crossengin/auth";

import { auditActor, auditEntry } from "./audit-log-store.js";
import type { CountedLoginAttempt, LoginAuditRecorder } from "./auth-token-route.js";

/** The operations a sign-in is recorded under, one spelling each. */
export const LOGIN_AUDIT_OPERATIONS = {
  succeeded: "auth.login",
  failed: "auth.login_failed",
  locked: "auth.account_locked",
} as const;

export interface LoginAuditSink {
  emit(entry: AuditLogEntry): Promise<void>;
}

/**
 * The two kinds of sign-in record, at two different scopes, and the scope is the decision.
 *
 * A **success** is filed against the tenant the session was minted for, by the person who signed in:
 * it is an act inside that tenant, and that tenant's own trail is where an administrator looks for
 * who had a session and when.
 *
 * A **counted wrong password** is filed at **platform** scope (ADR-0331), with no actor and the user
 * as its subject. Not under the claimed tenant, for two reasons: nobody authenticated, so filing it
 * there would let an unauthenticated caller append rows to whichever tenant's trail it names; and the
 * thing the attempt moves — the failure counter and the lock — is on `meta.users`, which carries no
 * tenant, which is ADR-0364's argument for filing an operator's credential write at platform scope.
 * The attempt that *locks* the account is recorded under its own operation, so a lockout is findable
 * without parsing a figure.
 *
 * Attempts refused before a password is compared (unknown tenant, unknown user, a locked account, a
 * malformed body) are not recorded here: they change nothing, they are bounded only by the admission
 * rate, and recording them would hand an unauthenticated caller a write into the platform chain per
 * request. They stay on the operator's log line, which is where they always were.
 */
export function buildLoginAuditRecorder(
  sink: LoginAuditSink,
  opts: { readonly now?: () => Date; readonly newId?: () => string } = {},
): LoginAuditRecorder {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? randomUUID;
  return {
    succeeded: (input) =>
      sink.emit(
        auditEntry({
          id: newId(),
          tenantId: input.tenantId,
          occurredAt: now().toISOString(),
          actor: auditActor({ kind: "user", userId: input.userId }),
          operation: LOGIN_AUDIT_OPERATIONS.succeeded,
          entity: "user",
          entityId: input.userId,
          after: { roles: [...input.roles] },
        }),
      ),
    failed: (input) =>
      sink.emit(
        auditEntry({
          id: newId(),
          tenantId: null,
          occurredAt: now().toISOString(),
          actor: auditActor({ kind: "system", userId: null }),
          operation:
            input.attempt.lockedUntil === null
              ? LOGIN_AUDIT_OPERATIONS.failed
              : LOGIN_AUDIT_OPERATIONS.locked,
          entity: "user",
          entityId: input.userId,
          after: attemptPayload(input.attempt),
        }),
      ),
  };
}

function attemptPayload(attempt: CountedLoginAttempt): Record<string, unknown> {
  return {
    tenantId: attempt.tenantId,
    failedAttempts: attempt.failedAttempts,
    lockedUntil: attempt.lockedUntil,
  };
}
