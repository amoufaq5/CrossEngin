import { z } from "zod";

export const CLAIM_SOURCE_FIELDS = [
  "saml_attribute",
  "saml_nameid",
  "oidc_id_token",
  "oidc_userinfo",
  "scim_user",
  "scim_group",
  "http_header",
  "static_value",
] as const;
export type ClaimSourceField = (typeof CLAIM_SOURCE_FIELDS)[number];

export const TARGET_FIELDS = [
  "user.email",
  "user.userName",
  "user.fullName",
  "user.givenName",
  "user.familyName",
  "user.locale",
  "user.timezone",
  "user.role",
  "user.tenantMembership",
  "user.department",
  "user.title",
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

export const TRANSFORM_KINDS = [
  "identity",
  "lowercase",
  "uppercase",
  "trim",
  "regex_extract",
  "regex_replace",
  "split_first",
  "split_last",
  "lookup_map",
  "prefix_strip",
  "suffix_strip",
  "join",
] as const;
export type TransformKind = (typeof TRANSFORM_KINDS)[number];

export const JIT_USER_POLICIES = [
  "disabled",
  "create_only_known_idp",
  "create_with_group_lookup",
  "update_existing_only",
] as const;
export type JitUserPolicy = (typeof JIT_USER_POLICIES)[number];

export const GROUP_SYNC_MODES = ["replace_all", "merge_add_only", "ignore"] as const;
export type GroupSyncMode = (typeof GROUP_SYNC_MODES)[number];

export const AttributeTransformSchema = z
  .object({
    kind: z.enum(TRANSFORM_KINDS),
    parameters: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  })
  .superRefine((t, ctx) => {
    if (t.kind === "regex_extract" || t.kind === "regex_replace") {
      if (!t.parameters?.pattern) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", "pattern"],
          message: `${t.kind} requires a 'pattern' parameter`,
        });
      }
    }
    if (t.kind === "lookup_map" && !t.parameters?.entries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters", "entries"],
        message: "lookup_map requires 'entries' parameter",
      });
    }
    if ((t.kind === "prefix_strip" || t.kind === "suffix_strip") && !t.parameters?.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters", "value"],
        message: `${t.kind} requires a 'value' parameter`,
      });
    }
  });
export type AttributeTransform = z.infer<typeof AttributeTransformSchema>;

export const ClaimMappingSchema = z
  .object({
    id: z.string().regex(/^cm_[a-z0-9-]{4,40}$/),
    source: z.enum(CLAIM_SOURCE_FIELDS),
    sourceKey: z.string().min(1),
    target: z.enum(TARGET_FIELDS),
    transforms: z.array(AttributeTransformSchema).default([]),
    required: z.boolean().default(false),
    defaultValue: z.string().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.source === "static_value" && m.defaultValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "static_value source requires a defaultValue",
      });
    }
  });
export type ClaimMapping = z.infer<typeof ClaimMappingSchema>;

export const GroupSyncRuleSchema = z.object({
  id: z.string().regex(/^gs_[a-z0-9-]{4,40}$/),
  idpGroupClaim: z.string().min(1),
  targetRoleSlug: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  conditionExpression: z.string().optional(),
});
export type GroupSyncRule = z.infer<typeof GroupSyncRuleSchema>;

export const JitPolicySchema = z
  .object({
    mode: z.enum(JIT_USER_POLICIES),
    allowedEmailDomains: z.array(z.string().min(1)).default([]),
    defaultRoles: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).default([]),
    requireMatchingGroupRule: z.boolean().default(false),
    autoCreateTenantMembership: z.boolean().default(true),
    groupSyncMode: z.enum(GROUP_SYNC_MODES),
  })
  .superRefine((p, ctx) => {
    if (p.mode === "create_with_group_lookup" && !p.requireMatchingGroupRule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requireMatchingGroupRule"],
        message: "create_with_group_lookup mode requires requireMatchingGroupRule=true",
      });
    }
  });
export type JitPolicy = z.infer<typeof JitPolicySchema>;

export const MappingSetSchema = z
  .object({
    claimMappings: z.array(ClaimMappingSchema),
    groupSyncRules: z.array(GroupSyncRuleSchema).default([]),
    jitPolicy: JitPolicySchema,
  })
  .superRefine((s, ctx) => {
    const seenIds = new Set<string>();
    for (const m of s.claimMappings) {
      if (seenIds.has(m.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["claimMappings"],
          message: `duplicate claim mapping id: ${m.id}`,
        });
        return;
      }
      seenIds.add(m.id);
    }
    const seenTargets = new Set<string>();
    for (const m of s.claimMappings) {
      if (seenTargets.has(m.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["claimMappings"],
          message: `duplicate target field: ${m.target}`,
        });
        return;
      }
      seenTargets.add(m.target);
    }
    if (s.jitPolicy.mode !== "disabled") {
      const hasEmail = s.claimMappings.some((m) => m.target === "user.email" && m.required);
      if (!hasEmail) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["claimMappings"],
          message: "JIT-enabled mapping requires a required claim mapping for user.email",
        });
      }
    }
  });
export type MappingSet = z.infer<typeof MappingSetSchema>;

export const applyTransform = (value: string, transform: AttributeTransform): string => {
  switch (transform.kind) {
    case "identity":
      return value;
    case "lowercase":
      return value.toLowerCase();
    case "uppercase":
      return value.toUpperCase();
    case "trim":
      return value.trim();
    case "regex_extract": {
      const pattern = transform.parameters?.pattern as string;
      const re = new RegExp(pattern);
      const match = re.exec(value);
      return match?.[1] ?? match?.[0] ?? "";
    }
    case "regex_replace": {
      const pattern = transform.parameters?.pattern as string;
      const replacement = (transform.parameters?.replacement as string) ?? "";
      return value.replace(new RegExp(pattern, "g"), replacement);
    }
    case "split_first": {
      const sep = (transform.parameters?.separator as string) ?? " ";
      return value.split(sep)[0] ?? "";
    }
    case "split_last": {
      const sep = (transform.parameters?.separator as string) ?? " ";
      const parts = value.split(sep);
      return parts[parts.length - 1] ?? "";
    }
    case "lookup_map": {
      const entries = transform.parameters?.entries as unknown as
        | Record<string, string>
        | undefined;
      if (!entries) return value;
      return entries[value] ?? value;
    }
    case "prefix_strip": {
      const prefix = transform.parameters?.value as string;
      return value.startsWith(prefix) ? value.slice(prefix.length) : value;
    }
    case "suffix_strip": {
      const suffix = transform.parameters?.value as string;
      return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
    }
    case "join": {
      const separator = (transform.parameters?.separator as string) ?? " ";
      return value
        .split(/\s+/)
        .filter((p) => p.length > 0)
        .join(separator);
    }
  }
};

export const applyTransforms = (value: string, transforms: readonly AttributeTransform[]): string =>
  transforms.reduce<string>((v, t) => applyTransform(v, t), value);

export interface JitDecisionInput {
  readonly resolvedClaims: Readonly<Record<string, string>>;
  readonly idpGroupClaims: readonly string[];
  readonly userExists: boolean;
  readonly policy: JitPolicy;
  readonly groupSyncRules: readonly GroupSyncRule[];
}

export type JitDecisionOutcome =
  | "create_user"
  | "update_existing"
  | "no_op_existing"
  | "denied_unknown_user"
  | "denied_no_group_match"
  | "denied_email_domain";

export interface JitDecision {
  readonly outcome: JitDecisionOutcome;
  readonly resolvedRoles: readonly string[];
  readonly reason: string;
}

export const decideJitOutcome = (input: JitDecisionInput): JitDecision => {
  if (input.policy.mode === "disabled") {
    if (input.userExists) {
      return {
        outcome: "no_op_existing",
        resolvedRoles: [],
        reason: "jit_disabled_user_exists",
      };
    }
    return {
      outcome: "denied_unknown_user",
      resolvedRoles: [],
      reason: "jit_disabled",
    };
  }
  const email = input.resolvedClaims["user.email"];
  if (email && input.policy.allowedEmailDomains.length > 0) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || !input.policy.allowedEmailDomains.map((d) => d.toLowerCase()).includes(domain)) {
      return {
        outcome: "denied_email_domain",
        resolvedRoles: [],
        reason: "email_domain_not_allowed",
      };
    }
  }
  const matchedRules = input.groupSyncRules.filter((rule) =>
    input.idpGroupClaims.includes(rule.idpGroupClaim),
  );
  const resolvedRoles = Array.from(
    new Set([...input.policy.defaultRoles, ...matchedRules.map((r) => r.targetRoleSlug)]),
  );
  if (input.policy.mode === "create_with_group_lookup" && matchedRules.length === 0) {
    return {
      outcome: "denied_no_group_match",
      resolvedRoles: [],
      reason: "no_idp_group_matched_any_sync_rule",
    };
  }
  if (input.policy.mode === "update_existing_only" && !input.userExists) {
    return {
      outcome: "denied_unknown_user",
      resolvedRoles: [],
      reason: "update_existing_only",
    };
  }
  if (input.userExists) {
    return {
      outcome: "update_existing",
      resolvedRoles,
      reason: "existing_user_updated",
    };
  }
  return {
    outcome: "create_user",
    resolvedRoles,
    reason: "new_user_created",
  };
};
