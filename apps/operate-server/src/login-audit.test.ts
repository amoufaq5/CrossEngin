import type { AuditLogEntry } from "@crossengin/auth";
import { describe, expect, it } from "vitest";

import { auditEntryFromRow } from "./audit-log-store.js";
import { LOGIN_AUDIT_OPERATIONS, buildLoginAuditRecorder } from "./login-audit.js";

/** The read path's own parse, so an entry this writes is one the trail's readers accept. */
function readsBack(e: AuditLogEntry): boolean {
  const back = auditEntryFromRow({
    id: e.id,
    tenant_id: e.tenantId,
    occurred_at: e.occurredAt,
    actor: e.actor,
    operation: e.operation,
    entity: e.entity,
    entity_id: e.entityId,
    before: e.before,
    after: e.after,
    diff: e.diff,
    reason: e.reason ?? null,
  });
  return JSON.stringify(back) === JSON.stringify(e);
}

const USER = "22222222-2222-4222-8222-222222222222";
const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";

function recorder(): { entries: AuditLogEntry[]; rec: ReturnType<typeof buildLoginAuditRecorder> } {
  const entries: AuditLogEntry[] = [];
  const rec = buildLoginAuditRecorder(
    { emit: async (e) => void entries.push(e) },
    { now: () => new Date("2026-11-17T10:00:00.000Z"), newId: () => ID },
  );
  return { entries, rec };
}

describe("buildLoginAuditRecorder", () => {
  it("files a success against the session's tenant, by the person who signed in", async () => {
    const { entries, rec } = recorder();
    await rec.succeeded({ userId: USER, tenantId: TENANT, roles: ["erp_admin", "hr_manager"] });
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(readsBack(e)).toBe(true);
    expect(e).toMatchObject({
      tenantId: TENANT,
      operation: LOGIN_AUDIT_OPERATIONS.succeeded,
      entity: "user",
      entityId: USER,
      actor: { kind: "user", userId: USER },
      after: { roles: ["erp_admin", "hr_manager"] },
    });
  });

  it("files a counted wrong password at PLATFORM scope with no actor, the user as its subject", async () => {
    const { entries, rec } = recorder();
    await rec.failed({ userId: USER, attempt: { tenantId: TENANT, failedAttempts: 2, lockedUntil: null } });
    const e = entries[0]!;
    expect(readsBack(e)).toBe(true);
    // Not the claimed tenant: nobody authenticated, so filing it there would let an
    // unauthenticated caller append to any tenant's trail it names.
    expect(e.tenantId).toBeNull();
    expect(e.actor.userId).toBeNull();
    expect(e.entityId).toBe(USER);
    expect(e.operation).toBe(LOGIN_AUDIT_OPERATIONS.failed);
    expect(e.after).toEqual({ tenantId: TENANT, failedAttempts: 2, lockedUntil: null });
  });

  it("files the attempt that locks the account under its own operation", async () => {
    const { entries, rec } = recorder();
    const lockedUntil = "2026-11-17T10:15:00.000Z";
    await rec.failed({ userId: USER, attempt: { tenantId: TENANT, failedAttempts: 5, lockedUntil } });
    expect(entries[0]!.operation).toBe(LOGIN_AUDIT_OPERATIONS.locked);
    expect(entries[0]!.after).toMatchObject({ lockedUntil });
  });

  it("carries no field that could hold a credential", async () => {
    const { entries, rec } = recorder();
    await rec.succeeded({ userId: USER, tenantId: TENANT, roles: ["erp_admin"] });
    await rec.failed({ userId: USER, attempt: { tenantId: TENANT, failedAttempts: 1, lockedUntil: null } });
    for (const e of entries) {
      expect(JSON.stringify(e)).not.toMatch(/password|credential|scrypt|token/i);
    }
  });
});
