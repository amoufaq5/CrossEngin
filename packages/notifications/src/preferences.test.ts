import { describe, expect, it } from "vitest";
import {
  OBSERVED_SUPPRESSION_REASONS,
  PERMANENT_SUPPRESSION_REASONS,
  SUPPRESSION_ACTOR_KINDS,
  SUPPRESSION_REASONS,
  SuppressionRecordSchema,
  UserPreferenceMatrixSchema,
  computeDispatchEligibility,
  findActiveSuppression,
  isHumanSuppressionActor,
  isPreferenceOptedIn,
  isSuppressionActive,
  parseSuppressionActor,
  suppressionActorRef,
  type SuppressionRecord,
  type UserPreferenceMatrix,
} from "./preferences.js";
import { NON_SUPPRESSIBLE_CATEGORIES, REQUIRES_EXPLICIT_OPT_IN } from "./templates.js";

const baseMatrix: UserPreferenceMatrix = {
  userId: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
  entries: [
    {
      category: "transactional",
      channel: "email",
      optedIn: true,
      updatedAt: "2026-05-16T10:00:00.000Z",
      source: "default_policy",
    },
    {
      category: "marketing",
      channel: "email",
      optedIn: true,
      updatedAt: "2026-05-16T10:00:00.000Z",
      source: "user_set",
    },
  ],
  updatedAt: "2026-05-16T10:00:00.000Z",
};

const baseSuppression: SuppressionRecord = {
  id: "supp_abc12345",
  tenantId: "22222222-2222-2222-2222-222222222222",
  channel: "email",
  recipientAddress: "alice@acme.com",
  reason: "hard_bounce",
  appliedAt: "2026-05-16T10:00:00.000Z",
  appliedBy: null,
  expiresAt: null,
  sourceDeliveryId: null,
};

describe("constants", () => {
  it("has 7 suppression reasons", () => {
    expect(SUPPRESSION_REASONS).toHaveLength(7);
  });
  it("hard_bounce, spam_complaint, do_not_contact_register, regulatory_block are permanent", () => {
    expect(PERMANENT_SUPPRESSION_REASONS.has("hard_bounce")).toBe(true);
    expect(PERMANENT_SUPPRESSION_REASONS.has("spam_complaint")).toBe(true);
    expect(PERMANENT_SUPPRESSION_REASONS.has("regulatory_block")).toBe(true);
    expect(PERMANENT_SUPPRESSION_REASONS.has("unsubscribe")).toBe(false);
  });
});

describe("UserPreferenceMatrixSchema", () => {
  it("accepts a valid matrix", () => {
    expect(() => UserPreferenceMatrixSchema.parse(baseMatrix)).not.toThrow();
  });

  it("rejects duplicate (category, channel) entries", () => {
    expect(() =>
      UserPreferenceMatrixSchema.parse({
        ...baseMatrix,
        entries: [...baseMatrix.entries, baseMatrix.entries[0]],
      }),
    ).toThrow(/duplicate matrix entry/);
  });

  it("rejects user opting out of transactional category", () => {
    expect(() =>
      UserPreferenceMatrixSchema.parse({
        ...baseMatrix,
        entries: [
          {
            category: "transactional",
            channel: "email",
            optedIn: false,
            updatedAt: "2026-05-16T10:00:00.000Z",
            source: "user_set",
          },
        ],
      }),
    ).toThrow(/cannot be opted out of, by any source/);
  });
});

describe("isPreferenceOptedIn", () => {
  it("returns explicit entry value when present", () => {
    expect(isPreferenceOptedIn(baseMatrix, "marketing", "email")).toBe(true);
  });

  it("defaults transactional to opt-in when no entry", () => {
    expect(isPreferenceOptedIn(baseMatrix, "transactional", "sms")).toBe(true);
  });

  it("defaults marketing to opt-out when no entry", () => {
    expect(isPreferenceOptedIn(baseMatrix, "marketing", "sms")).toBe(false);
  });
});

describe("SuppressionRecordSchema", () => {
  it("accepts a hard_bounce with null expiresAt (permanent)", () => {
    expect(() => SuppressionRecordSchema.parse(baseSuppression)).not.toThrow();
  });

  it("rejects permanent reason with non-null expiresAt", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        expiresAt: "2026-06-16T10:00:00.000Z",
      }),
    ).toThrow(/permanent reason; expiresAt must be null/);
  });

  it("rejects manual_block without appliedBy", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        reason: "manual_block",
      }),
    ).toThrow(/manual_block requires appliedBy/);
  });

  it("rejects expiresAt <= appliedAt", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        reason: "soft_bounce_exceeded",
        expiresAt: baseSuppression.appliedAt,
      }),
    ).toThrow(/expiresAt must be after appliedAt/);
  });
});

describe("isSuppressionActive", () => {
  it("returns true for permanent suppression", () => {
    expect(
      isSuppressionActive(baseSuppression, new Date("2050-01-01T00:00:00Z")),
    ).toBe(true);
  });

  it("returns true within expiry window", () => {
    expect(
      isSuppressionActive(
        {
          ...baseSuppression,
          reason: "soft_bounce_exceeded",
          expiresAt: "2026-06-16T10:00:00.000Z",
        },
        new Date("2026-05-20T10:00:00Z"),
      ),
    ).toBe(true);
  });

  it("returns false past expiry", () => {
    expect(
      isSuppressionActive(
        {
          ...baseSuppression,
          reason: "soft_bounce_exceeded",
          expiresAt: "2026-06-16T10:00:00.000Z",
        },
        new Date("2026-07-01T10:00:00Z"),
      ),
    ).toBe(false);
  });
});

describe("findActiveSuppression", () => {
  it("matches by channel + address", () => {
    expect(
      findActiveSuppression(
        [baseSuppression],
        "email",
        "alice@acme.com",
        new Date("2026-05-20T10:00:00Z"),
      ),
    ).toBeTruthy();
  });

  it("does not match different channel", () => {
    expect(
      findActiveSuppression(
        [baseSuppression],
        "sms",
        "alice@acme.com",
        new Date("2026-05-20T10:00:00Z"),
      ),
    ).toBeNull();
  });
});

describe("computeDispatchEligibility", () => {
  it("returns eligible when no suppression + opted in", () => {
    const r = computeDispatchEligibility({
      category: "marketing",
      channel: "email",
      preferences: baseMatrix,
      suppressions: [],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(true);
  });

  it("blocks marketing when hard_bounce suppression exists", () => {
    const r = computeDispatchEligibility({
      category: "marketing",
      channel: "email",
      preferences: baseMatrix,
      suppressions: [baseSuppression],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("suppressed");
    expect(r.suppressionId).toBe("supp_abc12345");
  });

  it("allows transactional over a consent-based suppression", () => {
    // Nobody gets to unsubscribe from a receipt, so a non-suppressible category outranks consent.
    const r = computeDispatchEligibility({
      category: "transactional",
      channel: "email",
      preferences: baseMatrix,
      suppressions: [{ ...baseSuppression, reason: "unsubscribe" }],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(true);
    expect(r.suppressionId).toBeNull();
  });

  it("refuses transactional over a hard bounce, which is not consent", () => {
    // The mailbox does not exist, so the mail cannot arrive however entitled the category is — and
    // the bounce rate it feeds is what gets a whole sending domain throttled.
    const r = computeDispatchEligibility({
      category: "transactional",
      channel: "email",
      preferences: baseMatrix,
      suppressions: [baseSuppression],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("suppressed");
    expect(r.suppressionId).toBe("supp_abc12345");
  });

  it("refuses a security alert over a complaint and a regulatory block too", () => {
    for (const reason of ["spam_complaint", "regulatory_block", "do_not_contact_register"] as const) {
      const r = computeDispatchEligibility({
        category: "security_alert",
        channel: "email",
        preferences: baseMatrix,
        suppressions: [{ ...baseSuppression, reason }],
        recipientAddress: "alice@acme.com",
        now: new Date("2026-05-20T10:00:00Z"),
      });
      expect(r.eligible, reason).toBe(false);
    }
  });

  it("lets an unconditional reason decide whatever order the rows arrive in", () => {
    // The resolver orders by applied_at DESC, so an older hard bounce can sit behind a newer
    // unsubscribe; whichever is listed first, the address is undeliverable.
    const unsubscribe: SuppressionRecord = {
      ...baseSuppression,
      id: "supp_unsub123",
      reason: "unsubscribe",
    };
    for (const rows of [
      [unsubscribe, baseSuppression],
      [baseSuppression, unsubscribe],
    ]) {
      const r = computeDispatchEligibility({
        category: "transactional",
        channel: "email",
        preferences: baseMatrix,
        suppressions: rows,
        recipientAddress: "alice@acme.com",
        now: new Date("2026-05-20T10:00:00Z"),
      });
      expect(r.eligible).toBe(false);
      expect(r.suppressionId).toBe("supp_abc12345");
    }
  });

  it("still allows transactional when an expired hard bounce is all there is", () => {
    const r = computeDispatchEligibility({
      category: "transactional",
      channel: "email",
      preferences: baseMatrix,
      suppressions: [{ ...baseSuppression, expiresAt: "2026-05-18T10:00:00.000Z" }],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(true);
  });

  it("blocks marketing when not opted in", () => {
    const noOptIn: UserPreferenceMatrix = {
      ...baseMatrix,
      entries: [
        {
          category: "marketing",
          channel: "email",
          optedIn: false,
          updatedAt: "2026-05-16T10:00:00.000Z",
          source: "user_set",
        },
      ],
    };
    const r = computeDispatchEligibility({
      category: "marketing",
      channel: "email",
      preferences: noOptIn,
      suppressions: [],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("not_opted_in");
  });
});

describe("suppression actor refs", () => {
  const USER_ID = "44444444-4444-4444-8444-444444444444";

  it("has 3 actor kinds", () => {
    expect(SUPPRESSION_ACTOR_KINDS).toHaveLength(3);
  });

  it("accepts a user ref", () => {
    expect(parseSuppressionActor(`user:${USER_ID}`)).toEqual({
      kind: "user",
      id: USER_ID,
    });
  });

  it("accepts a provider ref, which is the whole point of widening the field", () => {
    expect(parseSuppressionActor("provider:ses")).toEqual({
      kind: "provider",
      id: "ses",
    });
  });

  it("accepts a system ref with dashes and underscores", () => {
    expect(parseSuppressionActor("system:soft-bounce_threshold")?.kind).toBe("system");
  });

  it("rejects a bare uuid — the kind is not optional", () => {
    expect(parseSuppressionActor(USER_ID)).toBeNull();
  });

  it("rejects free text, which a plain min(1) string would have accepted", () => {
    for (const bad of ["nope", "ses", "", "SES", "user:", "user:not-a-uuid"]) {
      expect(parseSuppressionActor(bad)).toBeNull();
    }
  });

  it("rejects an unknown kind", () => {
    expect(parseSuppressionActor("robot:ses")).toBeNull();
  });

  it("rejects an uppercase user uuid, so one id has one spelling", () => {
    const mixed = "4a4a4a4a-4b4b-4c4c-8d4d-4e4e4e4e4e4e";
    expect(parseSuppressionActor(`user:${mixed}`)?.kind).toBe("user");
    expect(parseSuppressionActor(`user:${mixed.toUpperCase()}`)).toBeNull();
  });

  it("builds a ref through suppressionActorRef", () => {
    expect(suppressionActorRef("provider", "twilio")).toBe("provider:twilio");
  });

  it("refuses to build an invalid ref", () => {
    expect(() => suppressionActorRef("provider", "Twilio!")).toThrow(RangeError);
    expect(() => suppressionActorRef("user", "nope")).toThrow(RangeError);
  });

  it("identifies only a user ref as human", () => {
    expect(isHumanSuppressionActor(`user:${USER_ID}`)).toBe(true);
    expect(isHumanSuppressionActor("provider:ses")).toBe(false);
    expect(isHumanSuppressionActor("system:drain")).toBe(false);
    expect(isHumanSuppressionActor(null)).toBe(false);
  });

  it("names the three observed reasons no person decides", () => {
    expect([...OBSERVED_SUPPRESSION_REASONS].sort()).toEqual([
      "hard_bounce",
      "soft_bounce_exceeded",
      "spam_complaint",
    ]);
  });
});

describe("SuppressionRecordSchema — appliedBy", () => {
  const USER_ID = "44444444-4444-4444-8444-444444444444";

  it("accepts a provider-applied bounce suppression", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        appliedBy: "provider:ses",
        sourceDeliveryId: "55555555-5555-4555-8555-555555555555",
      }),
    ).not.toThrow();
  });

  it("still accepts a null appliedBy on a bounce, so existing rows keep parsing", () => {
    expect(() => SuppressionRecordSchema.parse(baseSuppression)).not.toThrow();
  });

  it("rejects a bare uuid, which the old UUID field required", () => {
    expect(() =>
      SuppressionRecordSchema.parse({ ...baseSuppression, appliedBy: USER_ID }),
    ).toThrow();
  });

  it("rejects free text", () => {
    expect(() =>
      SuppressionRecordSchema.parse({ ...baseSuppression, appliedBy: "nope" }),
    ).toThrow();
  });

  it("accepts a manual_block naming the human who placed it", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        reason: "manual_block",
        appliedBy: `user:${USER_ID}`,
      }),
    ).not.toThrow();
  });

  it("rejects a manual_block attributed to a system", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        reason: "manual_block",
        appliedBy: "system:drain",
      }),
    ).toThrow(/manual_block requires a user: actor/);
  });

  it("rejects a manual_block attributed to a provider", () => {
    expect(() =>
      SuppressionRecordSchema.parse({
        ...baseSuppression,
        reason: "manual_block",
        appliedBy: "provider:ses",
      }),
    ).toThrow(/manual_block requires a user: actor/);
  });

  it("rejects attributing an observed bounce to a person", () => {
    for (const reason of OBSERVED_SUPPRESSION_REASONS) {
      expect(() =>
        SuppressionRecordSchema.parse({
          ...baseSuppression,
          reason,
          expiresAt: null,
          appliedBy: `user:${USER_ID}`,
        }),
      ).toThrow(/observed, not decided/);
    }
  });

  it("lets a person apply a regulatory block or a DNC entry", () => {
    for (const reason of ["regulatory_block", "do_not_contact_register"] as const) {
      expect(() =>
        SuppressionRecordSchema.parse({
          ...baseSuppression,
          reason,
          appliedBy: `user:${USER_ID}`,
        }),
      ).not.toThrow();
    }
  });

  it("leaves the consent-vs-deliverability split untouched", () => {
    // A provider-applied hard bounce still refuses a transactional send; widening who applied it
    // changes nothing about what it overrides.
    const r = computeDispatchEligibility({
      category: "transactional",
      channel: "email",
      preferences: baseMatrix,
      suppressions: [{ ...baseSuppression, appliedBy: "provider:ses" }],
      recipientAddress: "alice@acme.com",
      now: new Date("2026-05-20T10:00:00Z"),
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("suppressed");
  });
});

describe("a non-suppressible category cannot be opted out of, by anyone", () => {
  const USER = "00000000-0000-4000-8000-000000000001";
  const TENANT = "00000000-0000-4000-8000-000000000002";
  const AT = "2026-01-01T00:00:00.000Z";

  const matrix = (source: string): unknown => ({
    userId: USER,
    tenantId: TENANT,
    updatedAt: AT,
    entries: [
      { category: "security_alert", channel: "email", optedIn: false, source, updatedAt: AT },
    ],
  });

  it("refuses the opt-out from every source, not only user_set", () => {
    // The defect: the guard was `source === "user_set"`, so an `admin_set`, `regulatory_requirement`
    // or `default_policy` entry parsed — and `computeDispatchEligibility` then answered
    // `not_opted_in`, silently withholding a security alert. Non-suppressibility is a property of
    // the message, not of who is asking.
    for (const source of ["user_set", "admin_set", "regulatory_requirement", "default_policy"]) {
      const result = UserPreferenceMatrixSchema.safeParse(matrix(source));
      expect(result.success, source).toBe(false);
    }
  });

  it("accepts an opt-IN from every source, which is the direction that is allowed", () => {
    for (const source of ["user_set", "admin_set", "regulatory_requirement", "default_policy"]) {
      const m = matrix(source) as { entries: { optedIn: boolean }[] };
      m.entries[0]!.optedIn = true;
      expect(UserPreferenceMatrixSchema.safeParse(m).success, source).toBe(true);
    }
  });

  it("delivers anyway when a matrix built in code says otherwise", () => {
    // The second layer. `computeDispatchEligibility`'s own comment says a non-suppressible category
    // "overrides consent", and that override existed only on the suppression branch — so a matrix
    // assembled without parsing could still withhold the alert.
    const unparsed = {
      userId: USER,
      tenantId: TENANT,
      updatedAt: AT,
      entries: [
        { category: "security_alert", channel: "email", optedIn: false, source: "admin_set", updatedAt: AT },
      ],
    } as never;
    expect(
      computeDispatchEligibility({
        preferences: unparsed,
        category: "security_alert",
        channel: "email",
        suppressions: [],
        recipientAddress: "alice@acme.com",
        now: new Date("2026-05-20T10:00:00Z"),
      }),
    ).toEqual({ eligible: true, reason: "ok", suppressionId: null });
  });

  it("still withholds a suppressible category the user opted out of", () => {
    // The override must not swallow a real opt-out: marketing consent is exactly what it protects.
    const m = UserPreferenceMatrixSchema.parse({
      userId: USER,
      tenantId: TENANT,
      updatedAt: AT,
      entries: [
        { category: "marketing", channel: "email", optedIn: false, source: "user_set", updatedAt: AT },
      ],
    });
    expect(
      computeDispatchEligibility({
        preferences: m,
        category: "marketing",
        channel: "email",
        suppressions: [],
        recipientAddress: "alice@acme.com",
        now: new Date("2026-05-20T10:00:00Z"),
      }).reason,
    ).toBe("not_opted_in");
  });

  it("keeps the two category sets disjoint, which is what makes the override safe", () => {
    // If a category were both non-suppressible and explicit-opt-in, the override above would send
    // it without the consent it requires. Asserted rather than assumed, because the overlap is an
    // edit somebody could make in `templates.ts` without ever reading this file.
    for (const category of NON_SUPPRESSIBLE_CATEGORIES) {
      expect(REQUIRES_EXPLICIT_OPT_IN.has(category), category).toBe(false);
    }
    expect([...NON_SUPPRESSIBLE_CATEGORIES].sort()).toEqual(["security_alert", "transactional"]);
    expect([...REQUIRES_EXPLICIT_OPT_IN]).toEqual(["marketing"]);
  });
});
