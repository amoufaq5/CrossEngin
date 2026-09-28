import { describe, expect, it } from "vitest";
import { canonicalAuditEntryPayload, type AuditLogEntry } from "./audit.js";

const base = (over: Partial<AuditLogEntry> = {}): AuditLogEntry =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    occurredAt: "2026-09-28T08:00:00.000Z",
    actor: { kind: "user", userId: "u1", sessionId: "s1", ip: "10.0.0.1", userAgent: "curl" },
    operation: "notifications.read_tenant_scope",
    entity: "notification_dispatches",
    entityId: null,
    before: null,
    after: { limit: 5, paged: false },
    diff: null,
    ...over,
  }) as AuditLogEntry;

describe("canonicalAuditEntryPayload", () => {
  it("is stable for the same entry", () => {
    expect(canonicalAuditEntryPayload(base())).toBe(canonicalAuditEntryPayload(base()));
  });

  it("sorts object keys, so JSONB losing key order does not look like tampering", () => {
    const a = canonicalAuditEntryPayload(base({ after: { limit: 5, paged: false } }));
    const b = canonicalAuditEntryPayload(base({ after: { paged: false, limit: 5 } }));
    expect(a).toBe(b);
  });

  it("sorts nested object keys too", () => {
    const a = canonicalAuditEntryPayload(base({ after: { o: { z: 1, a: 2 } } }));
    const b = canonicalAuditEntryPayload(base({ after: { o: { a: 2, z: 1 } } }));
    expect(a).toBe(b);
  });

  it("preserves array order, which is semantic", () => {
    const a = canonicalAuditEntryPayload(base({ after: { roles: ["a", "b"] } }));
    const b = canonicalAuditEntryPayload(base({ after: { roles: ["b", "a"] } }));
    expect(a).not.toBe(b);
  });

  it("normalizes an offset timestamp to the same instant as its UTC form", () => {
    // TIMESTAMPTZ reads back as an instant, so the written offset is lost. Without this the
    // pre-insert payload and the post-read payload would differ for every offset timestamp.
    const withOffset = canonicalAuditEntryPayload(base({ occurredAt: "2026-09-28T10:00:00+02:00" }));
    const asUtc = canonicalAuditEntryPayload(base({ occurredAt: "2026-09-28T08:00:00.000Z" }));
    expect(withOffset).toBe(asUtc);
  });

  it("normalizes a timestamp with no milliseconds", () => {
    const a = canonicalAuditEntryPayload(base({ occurredAt: "2026-09-28T08:00:00Z" }));
    const b = canonicalAuditEntryPayload(base({ occurredAt: "2026-09-28T08:00:00.000Z" }));
    expect(a).toBe(b);
  });

  it("normalizes the e-signature's signedAt the same way", () => {
    const sig = (signedAt: string): AuditLogEntry =>
      base({ eSignature: { method: "totp", challengeId: "c1", signedAt } });
    expect(canonicalAuditEntryPayload(sig("2026-09-28T10:00:00+02:00"))).toBe(
      canonicalAuditEntryPayload(sig("2026-09-28T08:00:00.000Z")),
    );
  });

  it("leaves an unparseable timestamp alone rather than inventing one", () => {
    expect(canonicalAuditEntryPayload(base({ occurredAt: "not-a-date" }))).toContain("not-a-date");
  });

  it("treats an absent optional field as null, matching how a NULL column reads back", () => {
    const absent = canonicalAuditEntryPayload(base());
    const explicitUndefined = canonicalAuditEntryPayload(base({ reason: undefined }));
    expect(absent).toBe(explicitUndefined);
    expect(absent).toContain('"reason":null');
  });

  it("distinguishes a present reason from an absent one", () => {
    expect(canonicalAuditEntryPayload(base({ reason: "escalated" }))).not.toBe(
      canonicalAuditEntryPayload(base()),
    );
  });

  for (const field of ["operation", "entity", "entityId"] as const) {
    it(`changes when ${field} changes`, () => {
      expect(canonicalAuditEntryPayload(base({ [field]: "tampered" }))).not.toBe(
        canonicalAuditEntryPayload(base()),
      );
    });
  }

  it("changes when the actor changes", () => {
    const other = base({
      actor: { kind: "user", userId: "u2", sessionId: "s1", ip: "10.0.0.1", userAgent: "curl" },
    });
    expect(canonicalAuditEntryPayload(other)).not.toBe(canonicalAuditEntryPayload(base()));
  });

  it("changes when a before/after/diff value changes", () => {
    expect(canonicalAuditEntryPayload(base({ after: { limit: 6, paged: false } }))).not.toBe(
      canonicalAuditEntryPayload(base()),
    );
  });

  it("changes when the id or tenant is repointed", () => {
    expect(
      canonicalAuditEntryPayload(base({ id: "33333333-3333-4333-8333-333333333333" })),
    ).not.toBe(canonicalAuditEntryPayload(base()));
    expect(
      canonicalAuditEntryPayload(base({ tenantId: "44444444-4444-4444-8444-444444444444" } as Partial<AuditLogEntry>)),
    ).not.toBe(canonicalAuditEntryPayload(base()));
  });

  it("changes when occurredAt moves to a different instant", () => {
    expect(canonicalAuditEntryPayload(base({ occurredAt: "2026-09-28T09:00:00.000Z" }))).not.toBe(
      canonicalAuditEntryPayload(base()),
    );
  });

  it("includes every semantic field of the contract", () => {
    const full = base({
      entityId: "e1",
      before: { a: 1 },
      diff: { a: [1, 2] },
      reason: "why",
      eSignature: { method: "totp", challengeId: "c1", signedAt: "2026-09-28T08:00:00.000Z" },
      regoDecisionTrace: "trace",
    });
    const payload = canonicalAuditEntryPayload(full);
    for (const key of [
      "id",
      "tenantId",
      "occurredAt",
      "actor",
      "operation",
      "entity",
      "entityId",
      "before",
      "after",
      "diff",
      "reason",
      "eSignature",
      "regoDecisionTrace",
    ]) {
      expect(payload).toContain(`"${key}":`);
    }
  });

  it("excludes created_at, the database's own insert clock", () => {
    expect(canonicalAuditEntryPayload(base())).not.toContain("created_at");
  });

  it("renders nulls and booleans without quoting them", () => {
    const payload = canonicalAuditEntryPayload(base({ after: { t: true, n: null } }));
    expect(payload).toContain('"n":null');
    expect(payload).toContain('"t":true');
  });
});
