import { describe, expect, it } from "vitest";
import {
  SESSION_BINDINGS,
  SLO_KINDS,
  SSO_SESSION_STATUSES,
  SsoSessionSchema,
  canTransitionSession,
  computeIdleTimeoutReached,
  extendSession,
  isMfaStillFresh,
  isSessionActive,
  shouldRefreshSession,
  terminateSession,
  type SsoSession,
} from "./sessions.js";

const activeSession: SsoSession = {
  id: "sess_abcdefghijkl",
  tenantId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  providerId: "sso_acmeokta1",
  federatedSubjectId: "alice@acme.com",
  binding: "cookie",
  idpSessionIndex: "_session-1",
  idpRefreshTokenSha256: null,
  startedAt: "2026-05-15T10:00:00.000Z",
  lastActivityAt: "2026-05-15T10:00:00.000Z",
  expiresAt: "2026-05-15T11:00:00.000Z",
  absoluteExpiresAt: "2026-05-16T10:00:00.000Z",
  status: "active",
  terminatedAt: null,
  terminationKind: null,
  terminationReason: null,
  mfaSatisfiedAt: "2026-05-15T10:00:00.000Z",
  ipAddress: "203.0.113.10",
  userAgent: "Mozilla/5.0",
};

describe("constants", () => {
  it("has 4 session statuses", () => {
    expect(SSO_SESSION_STATUSES).toHaveLength(4);
  });
  it("has 7 SLO kinds", () => {
    expect(SLO_KINDS).toHaveLength(7);
  });
  it("has 4 session bindings", () => {
    expect(SESSION_BINDINGS).toHaveLength(4);
  });
});

describe("canTransitionSession", () => {
  it("allows active → expired", () => {
    expect(canTransitionSession("active", "expired")).toBe(true);
  });
  it("blocks expired → active (terminal)", () => {
    expect(canTransitionSession("expired", "active")).toBe(false);
  });
  it("blocks active → active (no self-transition)", () => {
    expect(canTransitionSession("active", "active")).toBe(false);
  });
});

describe("SsoSessionSchema", () => {
  it("accepts an active session", () => {
    expect(() => SsoSessionSchema.parse(activeSession)).not.toThrow();
  });

  it("rejects when expiresAt <= startedAt", () => {
    expect(() =>
      SsoSessionSchema.parse({
        ...activeSession,
        expiresAt: activeSession.startedAt,
      }),
    ).toThrow(/expiresAt must be after startedAt/);
  });

  it("rejects when absoluteExpiresAt < expiresAt", () => {
    expect(() =>
      SsoSessionSchema.parse({
        ...activeSession,
        absoluteExpiresAt: "2026-05-15T10:30:00.000Z",
      }),
    ).toThrow(/absoluteExpiresAt must be/);
  });

  it("rejects active session with terminatedAt set", () => {
    expect(() =>
      SsoSessionSchema.parse({
        ...activeSession,
        terminatedAt: "2026-05-15T10:05:00.000Z",
      }),
    ).toThrow(/active session must not have terminatedAt/);
  });

  it("rejects logged_out session without terminatedAt", () => {
    expect(() =>
      SsoSessionSchema.parse({
        ...activeSession,
        status: "logged_out",
        terminationKind: "sp_initiated",
        terminationReason: "user clicked sign out",
      }),
    ).toThrow(/logged_out session must have terminatedAt/);
  });
});

describe("isSessionActive", () => {
  it("returns true within window", () => {
    expect(isSessionActive(activeSession, new Date("2026-05-15T10:30:00Z"))).toBe(true);
  });
  it("returns false past expiresAt", () => {
    expect(isSessionActive(activeSession, new Date("2026-05-15T11:30:00Z"))).toBe(false);
  });
  it("returns false past absoluteExpiresAt", () => {
    expect(isSessionActive(activeSession, new Date("2026-05-17T10:30:00Z"))).toBe(false);
  });
  it("returns false when status is not active", () => {
    expect(
      isSessionActive(
        {
          ...activeSession,
          status: "expired",
          terminatedAt: "2026-05-15T11:00:00.000Z",
          terminationKind: "idle_timeout",
        },
        new Date("2026-05-15T10:30:00Z"),
      ),
    ).toBe(false);
  });
});

describe("shouldRefreshSession", () => {
  it("returns true within refresh window", () => {
    expect(shouldRefreshSession(activeSession, new Date("2026-05-15T10:55:00Z"), 600)).toBe(true);
  });
  it("returns false well before expiry", () => {
    expect(shouldRefreshSession(activeSession, new Date("2026-05-15T10:30:00Z"), 600)).toBe(false);
  });
});

describe("computeIdleTimeoutReached", () => {
  it("returns true when idle gap exceeds threshold", () => {
    expect(computeIdleTimeoutReached(activeSession, new Date("2026-05-15T10:30:00Z"), 600)).toBe(
      true,
    );
  });
  it("returns false when within idle window", () => {
    expect(computeIdleTimeoutReached(activeSession, new Date("2026-05-15T10:05:00Z"), 600)).toBe(
      false,
    );
  });
});

describe("extendSession", () => {
  it("caps at absoluteExpiresAt", () => {
    const extended = extendSession(activeSession, new Date("2026-05-16T09:30:00Z"), 7200);
    expect(Date.parse(extended.expiresAt)).toBeLessThanOrEqual(
      Date.parse(activeSession.absoluteExpiresAt),
    );
  });
  it("updates lastActivityAt", () => {
    const now = new Date("2026-05-15T10:30:00Z");
    const extended = extendSession(activeSession, now, 3600);
    expect(extended.lastActivityAt).toBe(now.toISOString());
  });
});

describe("terminateSession", () => {
  it("idle_timeout produces expired status", () => {
    const t = terminateSession(
      activeSession,
      "idle_timeout",
      "no activity 30m",
      new Date("2026-05-15T10:30:00Z"),
    );
    expect(t.status).toBe("expired");
    expect(t.terminationKind).toBe("idle_timeout");
  });
  it("admin_revoke produces revoked status", () => {
    const t = terminateSession(
      activeSession,
      "admin_revoke",
      "support ticket #1234",
      new Date("2026-05-15T10:30:00Z"),
    );
    expect(t.status).toBe("revoked");
  });
  it("sp_initiated produces logged_out", () => {
    const t = terminateSession(
      activeSession,
      "sp_initiated",
      "user clicked logout",
      new Date("2026-05-15T10:30:00Z"),
    );
    expect(t.status).toBe("logged_out");
  });
  it("throws if session already terminal", () => {
    expect(() =>
      terminateSession(
        {
          ...activeSession,
          status: "expired",
          terminatedAt: "2026-05-15T11:00:00.000Z",
          terminationKind: "idle_timeout",
        },
        "admin_revoke",
        "x",
        new Date("2026-05-15T11:00:00Z"),
      ),
    ).toThrow();
  });
});

describe("isMfaStillFresh", () => {
  it("returns true within TTL", () => {
    expect(isMfaStillFresh(activeSession, new Date("2026-05-15T10:30:00Z"), 3600)).toBe(true);
  });
  it("returns false past TTL", () => {
    expect(isMfaStillFresh(activeSession, new Date("2026-05-15T12:30:00Z"), 3600)).toBe(false);
  });
  it("returns false when MFA never satisfied", () => {
    expect(
      isMfaStillFresh(
        { ...activeSession, mfaSatisfiedAt: null },
        new Date("2026-05-15T10:30:00Z"),
        3600,
      ),
    ).toBe(false);
  });
});
