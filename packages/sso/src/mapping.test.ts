import { describe, expect, it } from "vitest";
import {
  CLAIM_SOURCE_FIELDS,
  ClaimMappingSchema,
  GROUP_SYNC_MODES,
  JIT_USER_POLICIES,
  JitPolicySchema,
  MappingSetSchema,
  TARGET_FIELDS,
  TRANSFORM_KINDS,
  applyTransform,
  applyTransforms,
  decideJitOutcome,
  type JitPolicy,
} from "./mapping.js";

const validJitPolicy: JitPolicy = {
  mode: "create_only_known_idp",
  allowedEmailDomains: ["acme.com"],
  defaultRoles: ["member"],
  requireMatchingGroupRule: false,
  autoCreateTenantMembership: true,
  groupSyncMode: "merge_add_only",
};

describe("constants", () => {
  it("has 8 claim sources", () => {
    expect(CLAIM_SOURCE_FIELDS).toHaveLength(8);
  });
  it("has 11 target fields", () => {
    expect(TARGET_FIELDS).toHaveLength(11);
  });
  it("has 12 transform kinds", () => {
    expect(TRANSFORM_KINDS).toHaveLength(12);
  });
  it("has 4 JIT policies", () => {
    expect(JIT_USER_POLICIES).toHaveLength(4);
  });
  it("has 3 group sync modes", () => {
    expect(GROUP_SYNC_MODES).toEqual(["replace_all", "merge_add_only", "ignore"]);
  });
});

describe("applyTransform", () => {
  it("identity returns the value unchanged", () => {
    expect(applyTransform("Hello", { kind: "identity" })).toBe("Hello");
  });
  it("lowercase", () => {
    expect(applyTransform("HELLO", { kind: "lowercase" })).toBe("hello");
  });
  it("trim removes whitespace", () => {
    expect(applyTransform("  x  ", { kind: "trim" })).toBe("x");
  });
  it("regex_extract pulls the first capture group", () => {
    expect(
      applyTransform("alice@acme.com", {
        kind: "regex_extract",
        parameters: { pattern: "^([^@]+)@" },
      }),
    ).toBe("alice");
  });
  it("regex_replace replaces all matches", () => {
    expect(
      applyTransform("a-b-c", {
        kind: "regex_replace",
        parameters: { pattern: "-", replacement: "_" },
      }),
    ).toBe("a_b_c");
  });
  it("split_first returns the first part", () => {
    expect(
      applyTransform("alice@acme.com", {
        kind: "split_first",
        parameters: { separator: "@" },
      }),
    ).toBe("alice");
  });
  it("split_last returns the last part", () => {
    expect(
      applyTransform("alice@acme.com", {
        kind: "split_last",
        parameters: { separator: "@" },
      }),
    ).toBe("acme.com");
  });
  it("prefix_strip removes leading prefix", () => {
    expect(
      applyTransform("user:alice", {
        kind: "prefix_strip",
        parameters: { value: "user:" },
      }),
    ).toBe("alice");
  });
  it("suffix_strip removes trailing suffix", () => {
    expect(
      applyTransform("alice@example.com", {
        kind: "suffix_strip",
        parameters: { value: "@example.com" },
      }),
    ).toBe("alice");
  });
});

describe("applyTransforms", () => {
  it("chains transforms left-to-right", () => {
    expect(
      applyTransforms("  Alice@ACME.com  ", [
        { kind: "trim" },
        { kind: "lowercase" },
        { kind: "split_first", parameters: { separator: "@" } },
      ]),
    ).toBe("alice");
  });
});

describe("ClaimMappingSchema", () => {
  it("accepts a basic email mapping", () => {
    expect(() =>
      ClaimMappingSchema.parse({
        id: "cm_email-1",
        source: "saml_attribute",
        sourceKey: "email",
        target: "user.email",
        transforms: [{ kind: "lowercase" }],
        required: true,
      }),
    ).not.toThrow();
  });

  it("rejects static_value source without defaultValue", () => {
    expect(() =>
      ClaimMappingSchema.parse({
        id: "cm_static-1",
        source: "static_value",
        sourceKey: "n/a",
        target: "user.locale",
        required: true,
      }),
    ).toThrow(/static_value source requires a defaultValue/);
  });

  it("rejects regex_extract transform missing pattern", () => {
    expect(() =>
      ClaimMappingSchema.parse({
        id: "cm_regex-1",
        source: "saml_attribute",
        sourceKey: "fullName",
        target: "user.givenName",
        transforms: [{ kind: "regex_extract" }],
        required: false,
      }),
    ).toThrow(/regex_extract requires a 'pattern'/);
  });
});

describe("MappingSetSchema", () => {
  const goodEmail = {
    id: "cm_email-1",
    source: "saml_attribute" as const,
    sourceKey: "email",
    target: "user.email" as const,
    transforms: [{ kind: "lowercase" as const }],
    required: true,
  };

  it("accepts a mapping set with required email when JIT enabled", () => {
    expect(() =>
      MappingSetSchema.parse({
        claimMappings: [goodEmail],
        groupSyncRules: [],
        jitPolicy: validJitPolicy,
      }),
    ).not.toThrow();
  });

  it("rejects duplicate target fields", () => {
    expect(() =>
      MappingSetSchema.parse({
        claimMappings: [goodEmail, { ...goodEmail, id: "cm_email-2", sourceKey: "alternateEmail" }],
        groupSyncRules: [],
        jitPolicy: validJitPolicy,
      }),
    ).toThrow(/duplicate target field/);
  });

  it("rejects JIT-enabled set without required email mapping", () => {
    expect(() =>
      MappingSetSchema.parse({
        claimMappings: [{ ...goodEmail, required: false }],
        groupSyncRules: [],
        jitPolicy: validJitPolicy,
      }),
    ).toThrow(/required claim mapping for user.email/);
  });
});

describe("JitPolicySchema", () => {
  it("rejects create_with_group_lookup mode without requireMatchingGroupRule", () => {
    expect(() =>
      JitPolicySchema.parse({
        ...validJitPolicy,
        mode: "create_with_group_lookup",
        requireMatchingGroupRule: false,
      }),
    ).toThrow(/requireMatchingGroupRule=true/);
  });
});

describe("decideJitOutcome", () => {
  it("creates new user when policy allows + email domain ok", () => {
    const r = decideJitOutcome({
      resolvedClaims: { "user.email": "alice@acme.com" },
      idpGroupClaims: [],
      userExists: false,
      policy: validJitPolicy,
      groupSyncRules: [],
    });
    expect(r.outcome).toBe("create_user");
  });

  it("denies new user when policy is disabled", () => {
    const r = decideJitOutcome({
      resolvedClaims: { "user.email": "alice@acme.com" },
      idpGroupClaims: [],
      userExists: false,
      policy: { ...validJitPolicy, mode: "disabled" },
      groupSyncRules: [],
    });
    expect(r.outcome).toBe("denied_unknown_user");
  });

  it("denies when email domain not allowed", () => {
    const r = decideJitOutcome({
      resolvedClaims: { "user.email": "alice@other.com" },
      idpGroupClaims: [],
      userExists: false,
      policy: validJitPolicy,
      groupSyncRules: [],
    });
    expect(r.outcome).toBe("denied_email_domain");
  });

  it("denies when create_with_group_lookup has no matching group", () => {
    const r = decideJitOutcome({
      resolvedClaims: { "user.email": "alice@acme.com" },
      idpGroupClaims: ["Random"],
      userExists: false,
      policy: {
        ...validJitPolicy,
        mode: "create_with_group_lookup",
        requireMatchingGroupRule: true,
      },
      groupSyncRules: [
        {
          id: "gs_eng",
          idpGroupClaim: "Engineering",
          targetRoleSlug: "engineer",
        },
      ],
    });
    expect(r.outcome).toBe("denied_no_group_match");
  });

  it("resolves roles from matching group sync rules", () => {
    const r = decideJitOutcome({
      resolvedClaims: { "user.email": "alice@acme.com" },
      idpGroupClaims: ["Engineering"],
      userExists: false,
      policy: validJitPolicy,
      groupSyncRules: [
        {
          id: "gs_eng",
          idpGroupClaim: "Engineering",
          targetRoleSlug: "engineer",
        },
      ],
    });
    expect(r.resolvedRoles).toContain("member");
    expect(r.resolvedRoles).toContain("engineer");
  });

  it("update_existing_only denies for non-existing user", () => {
    const r = decideJitOutcome({
      resolvedClaims: { "user.email": "alice@acme.com" },
      idpGroupClaims: [],
      userExists: false,
      policy: { ...validJitPolicy, mode: "update_existing_only" },
      groupSyncRules: [],
    });
    expect(r.outcome).toBe("denied_unknown_user");
  });

  it("update_existing_only updates existing user", () => {
    const r = decideJitOutcome({
      resolvedClaims: { "user.email": "alice@acme.com" },
      idpGroupClaims: [],
      userExists: true,
      policy: { ...validJitPolicy, mode: "update_existing_only" },
      groupSyncRules: [],
    });
    expect(r.outcome).toBe("update_existing");
  });
});
