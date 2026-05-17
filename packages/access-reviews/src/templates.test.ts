import { describe, expect, it } from "vitest";
import {
  AccessReviewTemplateSchema,
  BUILTIN_TEMPLATE_SEEDS,
  TEMPLATE_LIFECYCLE_STATUSES,
  TEMPLATE_TRANSITIONS,
  canTransitionTemplate,
  findBuiltinSeed,
  isTemplateUsable,
  type AccessReviewTemplate,
} from "./templates.js";

const baseTemplate: AccessReviewTemplate = {
  id: "art_soc2q001",
  tenantId: null,
  templateKey: "soc2.quarterly.privileged_access",
  label: "SOC 2 Quarterly Privileged Access Review",
  description: "Reviews all admin-level grants on a quarterly cadence.",
  version: "1.0.0",
  status: "published",
  framework: "soc2_type2",
  defaultFrequency: "quarterly",
  defaultScope: {
    kind: "all_users_with_role",
    roleSlug: "admin",
    includeInherited: true,
  },
  defaultReviewerAssignment: {
    policy: "principal_manager",
    fallbackReviewerUserId: null,
    reviewerPoolUserIds: [],
    specificReviewerUserId: null,
    roleBasedReviewerRoleSlug: null,
    escalationChainUserIds: [],
    escalationTimeoutHours: 72,
  },
  defaultAutoRevokePolicy: "escalate_to_manager",
  defaultDeadlineDaysFromStart: 30,
  defaultGracePeriodHours: 24,
  defaultRemediationDaysFromCompletion: 15,
  documentationUrl: "https://crossengin.io/docs/access-reviews/soc2",
  publishedAt: "2026-01-15T10:00:00.000Z",
  publishedBy: "22222222-2222-2222-2222-222222222222",
  deprecatedAt: null,
  supersededByTemplateKey: null,
  createdAt: "2026-01-01T10:00:00.000Z",
  createdBy: "33333333-3333-3333-3333-333333333333",
};

describe("constants", () => {
  it("has 4 lifecycle statuses", () => {
    expect(TEMPLATE_LIFECYCLE_STATUSES).toHaveLength(4);
  });
  it("has 7 built-in template seeds", () => {
    expect(BUILTIN_TEMPLATE_SEEDS).toHaveLength(7);
  });
  it("retired is terminal", () => {
    expect(TEMPLATE_TRANSITIONS.retired).toEqual([]);
  });
});

describe("canTransitionTemplate", () => {
  it("allows draft → published", () => {
    expect(canTransitionTemplate("draft", "published")).toBe(true);
  });
  it("blocks draft → deprecated", () => {
    expect(canTransitionTemplate("draft", "deprecated")).toBe(false);
  });
});

describe("AccessReviewTemplateSchema", () => {
  it("accepts a valid SOC 2 quarterly template", () => {
    expect(() => AccessReviewTemplateSchema.parse(baseTemplate)).not.toThrow();
  });

  it("rejects published template without publishedAt", () => {
    expect(() =>
      AccessReviewTemplateSchema.parse({
        ...baseTemplate,
        publishedAt: null,
      }),
    ).toThrow(/published template requires publishedAt/);
  });

  it("rejects four-eyes violation (publishedBy === createdBy)", () => {
    expect(() =>
      AccessReviewTemplateSchema.parse({
        ...baseTemplate,
        publishedBy: baseTemplate.createdBy,
      }),
    ).toThrow(/four-eyes/);
  });

  it("rejects deprecated template without deprecatedAt", () => {
    expect(() =>
      AccessReviewTemplateSchema.parse({
        ...baseTemplate,
        status: "deprecated",
      }),
    ).toThrow(/deprecated template requires deprecatedAt/);
  });

  it("rejects SOC 2 framework with monthly frequency", () => {
    expect(() =>
      AccessReviewTemplateSchema.parse({
        ...baseTemplate,
        defaultFrequency: "monthly",
      }),
    ).toThrow(/SOC 2 Type 2/);
  });

  it("rejects HIPAA framework with quarterly frequency", () => {
    expect(() =>
      AccessReviewTemplateSchema.parse({
        ...baseTemplate,
        framework: "hipaa_security_rule",
        defaultFrequency: "quarterly",
      }),
    ).toThrow(/HIPAA Security Rule/);
  });
});

describe("findBuiltinSeed", () => {
  it("finds the SOC 2 quarterly seed by key", () => {
    const seed = findBuiltinSeed("soc2.quarterly.privileged_access");
    expect(seed).not.toBeNull();
    expect(seed?.framework).toBe("soc2_type2");
    expect(seed?.defaultFrequency).toBe("quarterly");
  });

  it("returns null for unknown key", () => {
    expect(findBuiltinSeed("non.existent.template")).toBeNull();
  });
});

describe("isTemplateUsable", () => {
  const now = new Date("2026-05-16T10:00:00Z");

  it("returns true for published template", () => {
    expect(isTemplateUsable(baseTemplate, now)).toBe(true);
  });

  it("returns false for retired template", () => {
    expect(
      isTemplateUsable({ ...baseTemplate, status: "retired" }, now),
    ).toBe(false);
  });

  it("returns false for draft template", () => {
    expect(
      isTemplateUsable(
        { ...baseTemplate, status: "draft", publishedAt: null, publishedBy: null },
        now,
      ),
    ).toBe(false);
  });

  it("returns true for recently-deprecated template (within 180 day grace)", () => {
    expect(
      isTemplateUsable(
        {
          ...baseTemplate,
          status: "deprecated",
          deprecatedAt: "2026-04-01T00:00:00.000Z",
        },
        now,
      ),
    ).toBe(true);
  });

  it("returns false for long-deprecated template (past 180 day grace)", () => {
    expect(
      isTemplateUsable(
        {
          ...baseTemplate,
          status: "deprecated",
          deprecatedAt: "2025-09-01T00:00:00.000Z",
        },
        now,
      ),
    ).toBe(false);
  });
});
