import { describe, expect, it } from "vitest";
import {
  DEDUP_REASONS,
  canonicalDigestDedupPayload,
  canonicalDispatchDedupPayload,
  computeDigestDedupSha256,
  computeDispatchDedupSha256,
  decideDispatchDedup,
  dedupCandidateFrom,
  dispatchDedupInputFrom,
  shouldWithholdDuplicate,
  type DedupCandidate,
  type DigestDedupInput,
  type DispatchDedupInput,
} from "./dedup.js";
import { CONTENT_CATEGORIES } from "./templates.js";
import type { NotificationDispatch } from "./delivery.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";

const dedupInput = (
  overrides: Partial<DispatchDedupInput> = {},
): DispatchDedupInput => ({
  tenantId: TENANT,
  templateId: "invoice_posted",
  locale: "en-US",
  channel: "email",
  category: "transactional",
  audience: { kind: "specific_user", userId: USER },
  variablesSha256: "a".repeat(64),
  ...overrides,
});

const dispatch = (
  overrides: Partial<NotificationDispatch> = {},
): NotificationDispatch => ({
  id: "disp_dedup_000001",
  tenantId: TENANT,
  templateId: "invoice_posted",
  templateVersion: "1.0.0",
  locale: "en-US",
  channel: "email",
  category: "transactional",
  priority: "normal",
  audienceJson: { kind: "specific_user", userId: USER },
  variablesSha256: "a".repeat(64),
  correlationId: "corr-1",
  idempotencyKey: "key-1",
  status: "queued",
  queuedAt: "2026-09-01T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
  recipientCount: 1,
  deliveredCount: 0,
  failedCount: 0,
  suppressedCount: 0,
  cancelledReason: null,
  requestedBy: null,
  requestingSystem: "operate-server",
  ...overrides,
});

// A stand-in hash: deterministic, 64 lowercase hex, and distinct per payload. The real one is
// injected by the caller from `@crossengin/crypto`.
const fakeSha256 = (payload: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < payload.length; i += 1) {
    h1 = (h1 ^ payload.charCodeAt(i)) * 16777619 >>> 0;
    h2 = (h2 + payload.charCodeAt(i) * (i + 7)) >>> 0;
  }
  const part = (n: number): string => n.toString(16).padStart(8, "0");
  return (part(h1) + part(h2)).repeat(4);
};

const digestInput = (
  overrides: Partial<DigestDedupInput> = {},
): DigestDedupInput => ({
  tenantId: TENANT,
  userId: USER,
  channel: "email",
  frequency: "daily",
  memberDedupSha256: ["b".repeat(64), "c".repeat(64)],
  ...overrides,
});

describe("constants", () => {
  it("has 4 dedup reasons", () => {
    expect(DEDUP_REASONS).toHaveLength(4);
  });
  it("names only non-duplicate reasons plus the one duplicate reason", () => {
    expect(DEDUP_REASONS).toContain("duplicate_within_window");
    expect(DEDUP_REASONS).toContain("unique");
  });
});

describe("canonicalDispatchDedupPayload — round-trip stability", () => {
  it("is stable for the same logical input", () => {
    expect(canonicalDispatchDedupPayload(dedupInput())).toBe(
      canonicalDispatchDedupPayload(dedupInput()),
    );
  });
  it("ignores the order the input fields were written in", () => {
    const a: DispatchDedupInput = {
      tenantId: TENANT,
      templateId: "t",
      locale: "en-US",
      channel: "email",
      category: "transactional",
      audience: {},
      variablesSha256: "a".repeat(64),
    };
    const b: DispatchDedupInput = {
      variablesSha256: "a".repeat(64),
      audience: {},
      category: "transactional",
      channel: "email",
      locale: "en-US",
      templateId: "t",
      tenantId: TENANT,
    };
    expect(canonicalDispatchDedupPayload(a)).toBe(canonicalDispatchDedupPayload(b));
  });
  it("ignores audience key order, which JSONB does not preserve", () => {
    expect(
      canonicalDispatchDedupPayload(
        dedupInput({ audience: { kind: "role_in_tenant", roleSlug: "admin", tenantId: TENANT } }),
      ),
    ).toBe(
      canonicalDispatchDedupPayload(
        dedupInput({ audience: { tenantId: TENANT, roleSlug: "admin", kind: "role_in_tenant" } }),
      ),
    );
  });
  it("sorts nested audience keys too", () => {
    expect(
      canonicalDispatchDedupPayload(dedupInput({ audience: { o: { z: 1, a: 2 } } })),
    ).toBe(canonicalDispatchDedupPayload(dedupInput({ audience: { o: { a: 2, z: 1 } } })));
  });
  it("drops an undefined audience member, matching an absent JSONB key", () => {
    expect(
      canonicalDispatchDedupPayload(dedupInput({ audience: { a: 1, b: undefined } })),
    ).toBe(canonicalDispatchDedupPayload(dedupInput({ audience: { a: 1 } })));
  });
  it("keeps audience array order significant, as canonicalAuditEntryPayload does", () => {
    expect(
      canonicalDispatchDedupPayload(dedupInput({ audience: { ids: ["a", "b"] } })),
    ).not.toBe(canonicalDispatchDedupPayload(dedupInput({ audience: { ids: ["b", "a"] } })));
  });
});

describe("canonicalDispatchDedupPayload — what is in", () => {
  const base = canonicalDispatchDedupPayload(dedupInput());

  it("separates tenants", () => {
    expect(canonicalDispatchDedupPayload(dedupInput({ tenantId: OTHER_TENANT }))).not.toBe(base);
  });
  it("separates templates", () => {
    expect(canonicalDispatchDedupPayload(dedupInput({ templateId: "bill_posted" }))).not.toBe(base);
  });
  it("separates locales", () => {
    expect(canonicalDispatchDedupPayload(dedupInput({ locale: "fr-FR" }))).not.toBe(base);
  });
  it("separates channels", () => {
    expect(canonicalDispatchDedupPayload(dedupInput({ channel: "sms" }))).not.toBe(base);
  });
  it("separates categories", () => {
    expect(canonicalDispatchDedupPayload(dedupInput({ category: "marketing" }))).not.toBe(base);
  });
  it("separates variable content", () => {
    expect(
      canonicalDispatchDedupPayload(dedupInput({ variablesSha256: "b".repeat(64) })),
    ).not.toBe(base);
  });
  it("separates audiences", () => {
    expect(canonicalDispatchDedupPayload(dedupInput({ audience: {} }))).not.toBe(base);
  });
});

describe("canonicalDispatchDedupPayload — what is out", () => {
  const base = canonicalDispatchDedupPayload(dispatchDedupInputFrom(dispatch()));

  it("ignores every timestamp, which would otherwise defeat the whole mechanism", () => {
    for (const overrides of [
      { queuedAt: "2027-01-01T00:00:00.000Z" },
      { status: "completed" as const, completedAt: "2026-09-01T10:00:09.000Z" },
      { startedAt: "2026-09-01T10:00:01.000Z" },
    ]) {
      expect(canonicalDispatchDedupPayload(dispatchDedupInputFrom(dispatch(overrides)))).toBe(base);
    }
  });
  it("ignores the idempotency key, which is unique per call by construction", () => {
    expect(
      canonicalDispatchDedupPayload(dispatchDedupInputFrom(dispatch({ idempotencyKey: "key-2" }))),
    ).toBe(base);
  });
  it("ignores a template version bump, so a typo fix does not resend", () => {
    expect(
      canonicalDispatchDedupPayload(dispatchDedupInputFrom(dispatch({ templateVersion: "1.0.1" }))),
    ).toBe(base);
  });
  it("ignores priority", () => {
    expect(
      canonicalDispatchDedupPayload(dispatchDedupInputFrom(dispatch({ priority: "critical" }))),
    ).toBe(base);
  });
  it("ignores provenance — two schedulers raising one notice is one notice", () => {
    expect(
      canonicalDispatchDedupPayload(
        dispatchDedupInputFrom(
          dispatch({ requestingSystem: "cron", correlationId: "corr-9", requestedBy: null }),
        ),
      ),
    ).toBe(base);
  });
  it("ignores the dispatch id and the counters", () => {
    expect(
      canonicalDispatchDedupPayload(
        dispatchDedupInputFrom(dispatch({ id: "disp_other_00001", recipientCount: 400 })),
      ),
    ).toBe(base);
  });
});

describe("computeDispatchDedupSha256", () => {
  it("returns the injected hasher's digest", () => {
    const digest = computeDispatchDedupSha256(dedupInput(), fakeSha256);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable for the same logical dispatch", () => {
    expect(computeDispatchDedupSha256(dedupInput(), fakeSha256)).toBe(
      computeDispatchDedupSha256(dedupInput(), fakeSha256),
    );
  });
  it("differs for a different tenant", () => {
    expect(computeDispatchDedupSha256(dedupInput(), fakeSha256)).not.toBe(
      computeDispatchDedupSha256(dedupInput({ tenantId: OTHER_TENANT }), fakeSha256),
    );
  });
  it("refuses an uppercase digest, which would never match a stored one", () => {
    expect(() =>
      computeDispatchDedupSha256(dedupInput(), () => "A".repeat(64)),
    ).toThrow(/lowercase 64-hex/);
  });
  it("refuses a short digest", () => {
    expect(() => computeDispatchDedupSha256(dedupInput(), () => "abc")).toThrow(RangeError);
  });
  it("refuses a base64 digest", () => {
    expect(() =>
      computeDispatchDedupSha256(dedupInput(), () => "Zm9vYmFyYmF6".repeat(5)),
    ).toThrow(/lowercase 64-hex/);
  });
});

describe("digest dedup payload", () => {
  it("treats membership as a set, not a sequence", () => {
    expect(
      canonicalDigestDedupPayload(
        digestInput({ memberDedupSha256: ["c".repeat(64), "b".repeat(64)] }),
      ),
    ).toBe(canonicalDigestDedupPayload(digestInput()));
  });
  it("collapses a repeated member", () => {
    expect(
      canonicalDigestDedupPayload(
        digestInput({ memberDedupSha256: ["b".repeat(64), "b".repeat(64), "c".repeat(64)] }),
      ),
    ).toBe(canonicalDigestDedupPayload(digestInput()));
  });
  it("changes when the membership changes", () => {
    expect(
      canonicalDigestDedupPayload(digestInput({ memberDedupSha256: ["b".repeat(64)] })),
    ).not.toBe(canonicalDigestDedupPayload(digestInput()));
  });
  it("separates users, so two people's identical pools are two digests", () => {
    expect(
      canonicalDigestDedupPayload(
        digestInput({ userId: "33333333-3333-4333-8333-333333333333" }),
      ),
    ).not.toBe(canonicalDigestDedupPayload(digestInput()));
  });
  it("separates frequencies", () => {
    expect(canonicalDigestDedupPayload(digestInput({ frequency: "weekly" }))).not.toBe(
      canonicalDigestDedupPayload(digestInput()),
    );
  });
  it("hashes through the injected hasher", () => {
    expect(computeDigestDedupSha256(digestInput(), fakeSha256)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("refuses a malformed digest from the hasher", () => {
    expect(() => computeDigestDedupSha256(digestInput(), () => "zz")).toThrow(RangeError);
  });
  it("gives an empty pool its own stable key", () => {
    expect(canonicalDigestDedupPayload(digestInput({ memberDedupSha256: [] }))).toBe(
      canonicalDigestDedupPayload(digestInput({ memberDedupSha256: [] })),
    );
  });
});

describe("dedupCandidateFrom", () => {
  it("carries the dispatch id, hash and queue position", () => {
    const candidate = dedupCandidateFrom(dispatch(), "d".repeat(64));
    expect(candidate).toEqual({
      dispatchId: "disp_dedup_000001",
      dedupSha256: "d".repeat(64),
      queuedAt: "2026-09-01T10:00:00.000Z",
    });
  });
});

describe("decideDispatchDedup", () => {
  const HASH = "d".repeat(64);
  const now = new Date("2026-09-01T12:00:00.000Z");
  const candidate = (overrides: Partial<DedupCandidate> = {}): DedupCandidate => ({
    dispatchId: "disp_prior_00001",
    dedupSha256: HASH,
    queuedAt: "2026-09-01T11:50:00.000Z",
    ...overrides,
  });

  it("reports a duplicate inside the window", () => {
    const decision = decideDispatchDedup({
      dedupSha256: HASH,
      recent: [candidate()],
      windowSeconds: 3600,
      now,
    });
    expect(decision.duplicate).toBe(true);
    expect(decision.reason).toBe("duplicate_within_window");
    expect(decision.ofDispatchId).toBe("disp_prior_00001");
    expect(decision.ageSeconds).toBe(600);
  });
  it("reports unique when the prior has fallen out of the window", () => {
    const decision = decideDispatchDedup({
      dedupSha256: HASH,
      recent: [candidate({ queuedAt: "2026-09-01T10:00:00.000Z" })],
      windowSeconds: 3600,
      now,
    });
    expect(decision.duplicate).toBe(false);
    expect(decision.reason).toBe("unique");
    expect(decision.ofDispatchId).toBeNull();
  });
  it("includes a prior exactly on the window floor", () => {
    expect(
      decideDispatchDedup({
        dedupSha256: HASH,
        recent: [candidate({ queuedAt: "2026-09-01T11:00:00.000Z" })],
        windowSeconds: 3600,
        now,
      }).duplicate,
    ).toBe(true);
  });
  it("reports unique for a different hash", () => {
    expect(
      decideDispatchDedup({
        dedupSha256: HASH,
        recent: [candidate({ dedupSha256: "e".repeat(64) })],
        windowSeconds: 3600,
        now,
      }).reason,
    ).toBe("unique");
  });
  it("picks the most recent of several matches", () => {
    const decision = decideDispatchDedup({
      dedupSha256: HASH,
      recent: [
        candidate({ dispatchId: "disp_old_0000001", queuedAt: "2026-09-01T11:10:00.000Z" }),
        candidate({ dispatchId: "disp_new_0000001", queuedAt: "2026-09-01T11:55:00.000Z" }),
        candidate({ dispatchId: "disp_mid_0000001", queuedAt: "2026-09-01T11:30:00.000Z" }),
      ],
      windowSeconds: 3600,
      now,
    });
    expect(decision.ofDispatchId).toBe("disp_new_0000001");
    expect(decision.ageSeconds).toBe(300);
  });
  it("counts a prior ahead of now as a duplicate, not as a notice from the future", () => {
    const decision = decideDispatchDedup({
      dedupSha256: HASH,
      recent: [candidate({ queuedAt: "2026-09-01T12:00:02.000Z" })],
      windowSeconds: 3600,
      now,
    });
    expect(decision.duplicate).toBe(true);
    expect(decision.ageSeconds).toBe(0);
  });
  it("reports no_prior_dispatches on an empty list", () => {
    expect(
      decideDispatchDedup({ dedupSha256: HASH, recent: [], windowSeconds: 3600, now }).reason,
    ).toBe("no_prior_dispatches");
  });
  it("reports window_not_configured for a zero or negative window", () => {
    for (const windowSeconds of [0, -1]) {
      const decision = decideDispatchDedup({
        dedupSha256: HASH,
        recent: [candidate()],
        windowSeconds,
        now,
      });
      expect(decision.duplicate).toBe(false);
      expect(decision.reason).toBe("window_not_configured");
    }
  });
  it("reports window_not_configured for a non-finite window", () => {
    expect(
      decideDispatchDedup({
        dedupSha256: HASH,
        recent: [candidate()],
        windowSeconds: Number.NaN,
        now,
      }).reason,
    ).toBe("window_not_configured");
  });
  it("skips a prior with an unparseable queuedAt", () => {
    expect(
      decideDispatchDedup({
        dedupSha256: HASH,
        recent: [candidate({ queuedAt: "whenever" })],
        windowSeconds: 3600,
        now,
      }).reason,
    ).toBe("unique");
  });
  it("is deterministic regardless of the order priors are listed in", () => {
    const priors = [
      candidate({ dispatchId: "disp_a_00000001", queuedAt: "2026-09-01T11:10:00.000Z" }),
      candidate({ dispatchId: "disp_b_00000001", queuedAt: "2026-09-01T11:55:00.000Z" }),
    ];
    const forwards = decideDispatchDedup({
      dedupSha256: HASH,
      recent: priors,
      windowSeconds: 3600,
      now,
    });
    const backwards = decideDispatchDedup({
      dedupSha256: HASH,
      recent: [...priors].reverse(),
      windowSeconds: 3600,
      now,
    });
    expect(forwards).toEqual(backwards);
  });
});

describe("shouldWithholdDuplicate", () => {
  const duplicate = {
    duplicate: true,
    reason: "duplicate_within_window" as const,
    ofDispatchId: "disp_prior_00001",
    ageSeconds: 60,
  };
  const unique = {
    duplicate: false,
    reason: "unique" as const,
    ofDispatchId: null,
    ageSeconds: null,
  };

  it("withholds a duplicate marketing send", () => {
    expect(shouldWithholdDuplicate(duplicate, "marketing")).toBe(true);
  });
  it("withholds a duplicate digest", () => {
    expect(shouldWithholdDuplicate(duplicate, "operational_digest")).toBe(true);
  });
  it("never withholds a duplicate security alert", () => {
    expect(shouldWithholdDuplicate(duplicate, "security_alert")).toBe(false);
  });
  it("never withholds a duplicate transactional notice", () => {
    expect(shouldWithholdDuplicate(duplicate, "transactional")).toBe(false);
  });
  it("withholds nothing when the decision is not a duplicate", () => {
    for (const category of CONTENT_CATEGORIES) {
      expect(shouldWithholdDuplicate(unique, category)).toBe(false);
    }
  });
  it("draws the line in exactly the same place suppression does", () => {
    const withheld = CONTENT_CATEGORIES.filter((c) => shouldWithholdDuplicate(duplicate, c));
    expect(withheld).toEqual(["system_notice", "operational_digest", "marketing"]);
  });
});
