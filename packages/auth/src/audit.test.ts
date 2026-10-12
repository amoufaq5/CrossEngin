import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";

import { canonicalAuditEntryPayload, type AuditLogEntry } from "./audit.js";

/** The branded ids are opaque by design, so a test has to say so once rather than cast the record. */
const tenantId = "22222222-2222-4222-8222-222222222222" as TenantId;
const userId = (raw: string): UserId => raw as UserId;

const base = (over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
    id: "11111111-1111-4111-8111-111111111111",
    tenantId,
    occurredAt: "2026-09-28T08:00:00.000Z",
    actor: { kind: "user", userId: userId("u1"), sessionId: "s1", ip: "10.0.0.1", userAgent: "curl" },
    operation: "notifications.read_tenant_scope",
    entity: "notification_dispatches",
    entityId: null,
    before: null,
    after: { limit: 5, paged: false },
    diff: null,
    ...over,
  });

/**
 * Two digests computed from the **published `dist/`** before `tenantId` was widened to
 * `TenantId | null`, over the two extremes of the shape: an entry with every optional field absent
 * and one with every optional field present and an offset timestamp.
 *
 * They are here because every `chain_entry_hash` stored in every deployment commits to these exact
 * bytes. If widening the field had moved them — by dropping the key, re-rendering it, or changing
 * its sorted position — every anchor ever written would stop verifying, which is the v1→v2
 * domain-tag situation ADR-0329 had to create for the tombstone content manifest rather than edit
 * bytes in place. These assertions are what establishes that no such migration is needed; they must
 * fail loudly rather than be updated.
 */
const PRE_CHANGE_DIGEST_MINIMAL =
  "6ab3cf498721aae2fae38bdc0de0eaab89c1d1018bdb59da47d3818fa9c16fe2";
const PRE_CHANGE_DIGEST_FULL = "8f698ad62d0bff26a13c539453db78c76dc8015012fb59cc099347cec6108694";

const digest = (payload: string): string =>
  createHash("sha256").update(payload, "utf8").digest("hex");

const pinnedMinimal = (): AuditLogEntry => ({
  id: "11111111-1111-4111-8111-111111111111",
  tenantId,
  occurredAt: "2026-10-05T10:00:00.000Z",
  actor: { kind: "system", userId: null, sessionId: null, ip: null, userAgent: null },
  operation: "platform.page_delivered",
  entity: "incident",
  entityId: "INC-2026-0007",
  before: null,
  after: null,
  diff: null,
});

const pinnedFull = (): AuditLogEntry => ({
  ...pinnedMinimal(),
  occurredAt: "2026-10-05T12:00:00+02:00",
  actor: {
    kind: "user",
    userId: userId("33333333-3333-4333-8333-333333333333"),
    sessionId: "sess_1",
    ip: "198.51.100.7",
    userAgent: "curl/8.5.0",
  },
  before: { b: 1, a: 2 },
  after: { z: [1, 2, { q: null }], y: "é🙂" },
  diff: { changed: ["a", "b"] },
  reason: "because",
  eSignature: { method: "totp", challengeId: "ch_1", signedAt: "2026-10-05T12:00:00+02:00" },
  regoDecisionTrace: "trace",
});

describe("canonicalAuditEntryPayload stored-digest compatibility", () => {
  it("renders a minimal tenant-scoped entry to the pre-change bytes", () => {
    expect(digest(canonicalAuditEntryPayload(pinnedMinimal()))).toBe(PRE_CHANGE_DIGEST_MINIMAL);
  });

  it("renders a fully-populated tenant-scoped entry to the pre-change bytes", () => {
    expect(digest(canonicalAuditEntryPayload(pinnedFull()))).toBe(PRE_CHANGE_DIGEST_FULL);
  });

  it("still renders a tenant id as a quoted string at its sorted position", () => {
    expect(canonicalAuditEntryPayload(pinnedMinimal())).toContain(`"tenantId":"${tenantId}"`);
  });
});

describe("canonicalAuditEntryPayload platform scope", () => {
  it("renders a platform-scope entry's tenantId as null", () => {
    expect(canonicalAuditEntryPayload(base({ tenantId: null }))).toContain('"tenantId":null');
  });

  it("commits to different bytes than the same entry under a tenant", () => {
    expect(canonicalAuditEntryPayload(base({ tenantId: null }))).not.toBe(
      canonicalAuditEntryPayload(base()),
    );
  });

  it("collapses an undefined tenantId to null rather than dropping the key", () => {
    // Dropping it would be a third rendering, and one no stored digest commits to.
    const untyped = base({ tenantId: undefined } as Partial<AuditLogEntry>);
    expect(canonicalAuditEntryPayload(untyped)).toBe(canonicalAuditEntryPayload(base({ tenantId: null })));
  });

  it("keeps the key present for a platform entry, so the payload shape is one shape", () => {
    expect(canonicalAuditEntryPayload(base({ tenantId: null }))).toContain('"tenantId":');
  });
});

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
      actor: { kind: "user", userId: userId("u2"), sessionId: "s1", ip: "10.0.0.1", userAgent: "curl" },
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
