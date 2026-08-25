import { sha256 } from "@crossengin/crypto";
import {
  CONTENT_CATEGORIES,
  NON_SUPPRESSIBLE_CATEGORIES,
  NotificationDispatchSchema,
  PRIORITY_LEVELS,
  DigestBatchSchema,
  isCategorySuppressible,
  type ContentCategory,
  type DigestBatch,
  type PriorityLevel,
} from "@crossengin/notifications";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_PRECEDENCE,
  DIGEST_REQUESTING_SYSTEM,
  DIGEST_TEMPLATE_ID,
  DIGEST_TEMPLATE_VERSION,
  PRIORITY_PRECEDENCE,
  buildDigestDispatch,
  digestCategory,
  digestIdempotencyKey,
  digestLocale,
  digestPriority,
  digestVariablesSha256,
  summarizeDigest,
  type DigestMember,
} from "./digest-assembly.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const digest = (overrides: Partial<DigestBatch> = {}): DigestBatch =>
  DigestBatchSchema.parse({
    id: "dgst_abcdefgh1234",
    tenantId: TENANT,
    userId: USER,
    channel: "email",
    frequency: "daily",
    status: "queued_for_assembly",
    openedAt: "2026-08-24T22:00:00.000Z",
    scheduledDispatchAt: "2026-08-25T07:00:00.000Z",
    assembledAt: null,
    dispatchedAt: null,
    itemCount: 3,
    maxItems: 50,
    dedupSha256: null,
    ...overrides,
  });

const member = (n: number, overrides: Partial<DigestMember> = {}): DigestMember => ({
  dispatchId: `disp_${String(n).padStart(12, "0")}`,
  rowId: `3333333${n}-3333-4333-8333-333333333333`,
  templateId: "invoice.overdue",
  category: "system_notice",
  priority: "normal",
  locale: "en",
  correlationId: null,
  queuedAt: `2026-08-24T22:0${n}:00.000Z`,
  ...overrides,
});

const shuffle = <T,>(items: readonly T[], seed: number): readonly T[] => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
};

describe("precedence tables", () => {
  it("orders every content category most to least urgent", () => {
    expect(CATEGORY_PRECEDENCE).toEqual([
      "security_alert",
      "transactional",
      "system_notice",
      "operational_digest",
      "marketing",
    ]);
    expect([...CATEGORY_PRECEDENCE].sort()).toEqual([...CONTENT_CATEGORIES].sort());
  });

  it("orders every priority level most to least urgent", () => {
    expect(PRIORITY_PRECEDENCE).toEqual([
      "critical",
      "high",
      "normal",
      "low",
      "background",
    ]);
    expect([...PRIORITY_PRECEDENCE].sort()).toEqual([...PRIORITY_LEVELS].sort());
  });
});

describe("digestCategory", () => {
  it("returns the least urgent category for an empty pool", () => {
    expect(digestCategory([])).toBe("marketing");
  });

  it("returns the sole category of a single-member pool", () => {
    for (const category of CONTENT_CATEGORIES) {
      expect(digestCategory([member(1, { category })])).toBe(category);
    }
  });

  it("picks security_alert over every other category", () => {
    for (const category of CONTENT_CATEGORIES) {
      const members = [member(1, { category }), member(2, { category: "security_alert" })];
      expect(digestCategory(members)).toBe("security_alert");
    }
  });

  it("walks the precedence table for mixed pools", () => {
    const cases: readonly (readonly [readonly ContentCategory[], ContentCategory])[] = [
      [["marketing", "operational_digest"], "operational_digest"],
      [["marketing", "system_notice", "operational_digest"], "system_notice"],
      [
        ["marketing", "operational_digest", "system_notice", "transactional"],
        "transactional",
      ],
      [["marketing", "marketing"], "marketing"],
    ];
    for (const [categories, expected] of cases) {
      const members = categories.map((category, i) => member(i + 1, { category }));
      expect(digestCategory(members)).toBe(expected);
    }
  });

  it("summarising never makes the notice easier to suppress than its members", () => {
    for (const nonSuppressible of NON_SUPPRESSIBLE_CATEGORIES) {
      for (const other of CONTENT_CATEGORIES) {
        const members = [
          member(1, { category: other }),
          member(2, { category: nonSuppressible }),
          member(3, { category: "marketing" }),
        ];
        expect(isCategorySuppressible(digestCategory(members))).toBe(false);
      }
    }
  });

  it("stays suppressible when every member is suppressible", () => {
    const suppressible = CONTENT_CATEGORIES.filter((c) => isCategorySuppressible(c));
    const members = suppressible.map((category, i) => member(i + 1, { category }));
    expect(isCategorySuppressible(digestCategory(members))).toBe(true);
  });
});

describe("digestPriority", () => {
  it("returns the least urgent priority for an empty pool", () => {
    expect(digestPriority([])).toBe("background");
  });

  it("returns the sole priority of a single-member pool", () => {
    for (const priority of PRIORITY_LEVELS) {
      expect(digestPriority([member(1, { priority })])).toBe(priority);
    }
  });

  it("picks critical over every other priority", () => {
    for (const priority of PRIORITY_LEVELS) {
      const members = [member(1, { priority }), member(2, { priority: "critical" })];
      expect(digestPriority(members)).toBe("critical");
    }
  });

  it("walks the precedence table for mixed pools", () => {
    const cases: readonly (readonly [readonly PriorityLevel[], PriorityLevel])[] = [
      [["background", "low"], "low"],
      [["background", "low", "normal"], "normal"],
      [["low", "normal", "high"], "high"],
      [["background", "background"], "background"],
    ];
    for (const [levels, expected] of cases) {
      const members = levels.map((priority, i) => member(i + 1, { priority }));
      expect(digestPriority(members)).toBe(expected);
    }
  });
});

describe("digestLocale", () => {
  it("returns en for an empty pool", () => {
    expect(digestLocale([])).toBe("en");
  });

  it("returns the most common locale", () => {
    const members = [
      member(1, { locale: "en" }),
      member(2, { locale: "de" }),
      member(3, { locale: "de" }),
    ];
    expect(digestLocale(members)).toBe("de");
  });

  it("breaks a tie by first-seen", () => {
    const members = [
      member(1, { locale: "ar" }),
      member(2, { locale: "fr" }),
      member(3, { locale: "fr" }),
      member(4, { locale: "ar" }),
    ];
    expect(digestLocale(members)).toBe("ar");
  });

  it("breaks a tie by first-seen in the other direction", () => {
    const members = [
      member(1, { locale: "fr" }),
      member(2, { locale: "ar" }),
      member(3, { locale: "ar" }),
      member(4, { locale: "fr" }),
    ];
    expect(digestLocale(members)).toBe("fr");
  });

  it("handles region-qualified locales", () => {
    const members = [
      member(1, { locale: "en-US" }),
      member(2, { locale: "en-GB" }),
      member(3, { locale: "en-GB" }),
    ];
    expect(digestLocale(members)).toBe("en-GB");
  });
});

describe("summarizeDigest", () => {
  it("carries the digest id and counts the members", () => {
    const summary = summarizeDigest(digest(), [member(1), member(2), member(3)]);
    expect(summary.digestId).toBe("dgst_abcdefgh1234");
    expect(summary.itemCount).toBe(3);
  });

  it("tallies members per template id", () => {
    const summary = summarizeDigest(digest(), [
      member(1, { templateId: "invoice.overdue" }),
      member(2, { templateId: "invoice.overdue" }),
      member(3, { templateId: "order.shipped" }),
    ]);
    expect(summary.templateCounts).toEqual({
      "invoice.overdue": 2,
      "order.shipped": 1,
    });
  });

  it("bounds the pool by earliest and latest queuedAt", () => {
    const summary = summarizeDigest(digest(), [
      member(3, { queuedAt: "2026-08-24T22:30:00.000Z" }),
      member(1, { queuedAt: "2026-08-24T22:05:00.000Z" }),
      member(2, { queuedAt: "2026-08-24T22:15:00.000Z" }),
    ]);
    expect(summary.earliestQueuedAt).toBe("2026-08-24T22:05:00.000Z");
    expect(summary.latestQueuedAt).toBe("2026-08-24T22:30:00.000Z");

    const single = summarizeDigest(digest(), [
      member(1, { queuedAt: "2026-08-24T22:07:00.000Z" }),
    ]);
    expect(single.earliestQueuedAt).toBe("2026-08-24T22:07:00.000Z");
    expect(single.latestQueuedAt).toBe("2026-08-24T22:07:00.000Z");
  });

  it("falls back to the digest openedAt for an empty pool", () => {
    const batch = digest();
    const summary = summarizeDigest(batch, []);
    expect(summary.itemCount).toBe(0);
    expect(summary.templateCounts).toEqual({});
    expect(summary.earliestQueuedAt).toBe(batch.openedAt);
    expect(summary.latestQueuedAt).toBe(batch.openedAt);
  });

  it("is order-independent", () => {
    const members = [member(1), member(2, { templateId: "order.shipped" }), member(3)];
    expect(summarizeDigest(digest(), members)).toEqual(
      summarizeDigest(digest(), shuffle(members, 3)),
    );
  });
});

describe("digestVariablesSha256", () => {
  it("returns 64 lowercase hex", () => {
    const hash = digestVariablesSha256(summarizeDigest(digest(), [member(1)]));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unchanged when the member array is shuffled", () => {
    const members = [
      member(1, { templateId: "a.one" }),
      member(2, { templateId: "b.two" }),
      member(3, { templateId: "a.one" }),
      member(4, { templateId: "c.three" }),
      member(5, { templateId: "b.two" }),
    ];
    const base = digestVariablesSha256(summarizeDigest(digest(), members));
    for (const seed of [1, 2, 5, 9, 42]) {
      const shuffled = digestVariablesSha256(
        summarizeDigest(digest(), shuffle(members, seed)),
      );
      expect(shuffled).toBe(base);
    }
  });

  it("differs when the template tally differs", () => {
    const a = digestVariablesSha256(
      summarizeDigest(digest(), [member(1, { templateId: "a.one" })]),
    );
    const b = digestVariablesSha256(
      summarizeDigest(digest(), [member(1, { templateId: "b.two" })]),
    );
    expect(a).not.toBe(b);
  });

  it("differs across digests", () => {
    const a = digestVariablesSha256(summarizeDigest(digest(), [member(1)]));
    const b = digestVariablesSha256(
      summarizeDigest(digest({ id: "dgst_zzzzzzzz9999" }), [member(1)]),
    );
    expect(a).not.toBe(b);
  });
});

describe("digestIdempotencyKey", () => {
  it("prefixes the digest id", () => {
    expect(digestIdempotencyKey("dgst_abcdefgh1234")).toBe("digest:dgst_abcdefgh1234");
  });

  it("is distinct per digest", () => {
    expect(digestIdempotencyKey("dgst_a")).not.toBe(digestIdempotencyKey("dgst_b"));
  });
});

describe("buildDigestDispatch", () => {
  const assembledAt = "2026-08-25T07:00:00.000Z";

  it("throws when the pool is empty", () => {
    expect(() =>
      buildDigestDispatch({ digest: digest(), members: [], assembledAt }),
    ).toThrow(/no members/);
  });

  it("passes NotificationDispatchSchema for a plain pool", () => {
    const dispatch = buildDigestDispatch({
      digest: digest(),
      members: [member(1), member(2)],
      assembledAt,
    });
    expect(() => NotificationDispatchSchema.parse(dispatch)).not.toThrow();
  });

  it("passes NotificationDispatchSchema across category and priority mixes", () => {
    for (const category of CONTENT_CATEGORIES) {
      for (const priority of PRIORITY_LEVELS) {
        const dispatch = buildDigestDispatch({
          digest: digest({ channel: "in_app" }),
          members: [
            member(1, { category, priority, locale: "fr" }),
            member(2, { category: "marketing", priority: "background" }),
          ],
          assembledAt,
        });
        expect(() => NotificationDispatchSchema.parse(dispatch)).not.toThrow();
      }
    }
  });

  it("derives a deterministic id from the idempotency key", () => {
    const batch = digest();
    const dispatch = buildDigestDispatch({
      digest: batch,
      members: [member(1)],
      assembledAt,
    });
    expect(dispatch.id).toBe(
      `disp_${sha256(digestIdempotencyKey(batch.id)).slice(0, 32)}`,
    );
  });

  it("names the same dispatch on a repeat assembly of the same digest", () => {
    const batch = digest();
    const first = buildDigestDispatch({
      digest: batch,
      members: [member(1), member(2)],
      assembledAt,
    });
    const second = buildDigestDispatch({
      digest: batch,
      members: [member(2), member(1)],
      assembledAt: "2026-08-25T09:30:00.000Z",
    });
    expect(second.id).toBe(first.id);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.variablesSha256).toBe(first.variablesSha256);
  });

  it("carries the digest tenant, channel, audience and template constants", () => {
    const dispatch = buildDigestDispatch({
      digest: digest({ channel: "sms" }),
      members: [member(1)],
      assembledAt,
    });
    expect(dispatch.tenantId).toBe(TENANT);
    expect(dispatch.channel).toBe("sms");
    expect(dispatch.audienceJson).toEqual({ kind: "specific_user", userId: USER });
    expect(dispatch.templateId).toBe(DIGEST_TEMPLATE_ID);
    expect(dispatch.templateVersion).toBe(DIGEST_TEMPLATE_VERSION);
    expect(dispatch.requestingSystem).toBe(DIGEST_REQUESTING_SYSTEM);
  });

  it("summarises category, priority and locale from the pool", () => {
    const members = [
      member(1, { category: "marketing", priority: "low", locale: "de" }),
      member(2, { category: "security_alert", priority: "high", locale: "de" }),
      member(3, { category: "system_notice", priority: "normal", locale: "en" }),
    ];
    const dispatch = buildDigestDispatch({ digest: digest(), members, assembledAt });
    expect(dispatch.category).toBe("security_alert");
    expect(dispatch.priority).toBe("high");
    expect(dispatch.locale).toBe("de");
  });

  it("falls back to en for a locale the schema would reject", () => {
    const dispatch = buildDigestDispatch({
      digest: digest(),
      members: [member(1, { locale: "not-a-locale" })],
      assembledAt,
    });
    expect(dispatch.locale).toBe("en");
    expect(() => NotificationDispatchSchema.parse(dispatch)).not.toThrow();
  });

  it("points its correlationId back at the pool it stands for", () => {
    const batch = digest();
    const dispatch = buildDigestDispatch({
      digest: batch,
      members: [member(1)],
      assembledAt,
    });
    expect(dispatch.correlationId).toBe(batch.id);
  });

  it("queues one recipient at the assembly time with no outcomes yet", () => {
    const dispatch = buildDigestDispatch({
      digest: digest(),
      members: [member(1), member(2), member(3)],
      assembledAt,
    });
    expect(dispatch.status).toBe("queued");
    expect(dispatch.queuedAt).toBe(assembledAt);
    expect(dispatch.startedAt).toBeNull();
    expect(dispatch.completedAt).toBeNull();
    expect(dispatch.cancelledReason).toBeNull();
    expect(dispatch.recipientCount).toBe(1);
    expect(dispatch.deliveredCount).toBe(0);
    expect(dispatch.failedCount).toBe(0);
    expect(dispatch.suppressedCount).toBe(0);
    expect(dispatch.requestedBy).toBeNull();
  });

  it("hashes the same summary digestVariablesSha256 computes", () => {
    const batch = digest();
    const members = [member(1), member(2, { templateId: "order.shipped" })];
    const dispatch = buildDigestDispatch({ digest: batch, members, assembledAt });
    expect(dispatch.variablesSha256).toBe(
      digestVariablesSha256(summarizeDigest(batch, members)),
    );
  });

  it("remains non-suppressible when a transactional notice was pooled", () => {
    const dispatch = buildDigestDispatch({
      digest: digest(),
      members: [
        member(1, { category: "marketing" }),
        member(2, { category: "transactional" }),
      ],
      assembledAt,
    });
    expect(isCategorySuppressible(dispatch.category as ContentCategory)).toBe(false);
  });
});
