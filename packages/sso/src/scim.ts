import { z } from "zod";

export const SCIM_VERSION = "2.0" as const;

export const SCIM_RESOURCE_TYPES = [
  "User",
  "Group",
  "EnterpriseUser",
  "Role",
  "Entitlement",
] as const;
export type ScimResourceType = (typeof SCIM_RESOURCE_TYPES)[number];

export const SCIM_OPERATIONS = [
  "create",
  "replace",
  "patch",
  "delete",
  "get",
  "list",
  "search",
] as const;
export type ScimOperation = (typeof SCIM_OPERATIONS)[number];

export const SCIM_PATCH_OPS = ["add", "replace", "remove"] as const;
export type ScimPatchOp = (typeof SCIM_PATCH_OPS)[number];

export const SCIM_FILTER_OPERATORS = [
  "eq",
  "ne",
  "co",
  "sw",
  "ew",
  "pr",
  "gt",
  "ge",
  "lt",
  "le",
] as const;
export type ScimFilterOperator = (typeof SCIM_FILTER_OPERATORS)[number];

export const SCIM_OUTCOMES = [
  "success",
  "created",
  "conflict",
  "invalid_filter",
  "invalid_path",
  "invalid_value",
  "not_found",
  "forbidden",
  "rate_limited",
  "schema_violation",
] as const;
export type ScimOutcome = (typeof SCIM_OUTCOMES)[number];

export const SCIM_CORE_SCHEMAS = [
  "urn:ietf:params:scim:schemas:core:2.0:User",
  "urn:ietf:params:scim:schemas:core:2.0:Group",
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
  "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  "urn:ietf:params:scim:api:messages:2.0:BulkRequest",
  "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  "urn:ietf:params:scim:api:messages:2.0:Error",
] as const;
export type ScimCoreSchema = (typeof SCIM_CORE_SCHEMAS)[number];

export const SCIM_BULK_MAX_OPERATIONS = 1000;

export const ScimMetaSchema = z.object({
  resourceType: z.enum(SCIM_RESOURCE_TYPES),
  created: z.string().datetime({ offset: true }),
  lastModified: z.string().datetime({ offset: true }),
  version: z.string().min(1),
  location: z.string().url(),
});
export type ScimMeta = z.infer<typeof ScimMetaSchema>;

export const ScimNameSchema = z.object({
  formatted: z.string().optional(),
  familyName: z.string().optional(),
  givenName: z.string().optional(),
  middleName: z.string().optional(),
  honorificPrefix: z.string().optional(),
  honorificSuffix: z.string().optional(),
});

export const ScimEmailSchema = z.object({
  value: z.string().email(),
  type: z.enum(["work", "home", "other"]).optional(),
  primary: z.boolean().optional(),
});

export const ScimGroupMembershipSchema = z.object({
  value: z.string().min(1),
  display: z.string().optional(),
  type: z.enum(["direct", "indirect"]).optional(),
  $ref: z.string().url().optional(),
});

export const ScimUserSchema = z.object({
  schemas: z.array(z.enum(SCIM_CORE_SCHEMAS)).min(1),
  id: z.string().min(1).optional(),
  externalId: z.string().optional(),
  userName: z.string().min(1),
  name: ScimNameSchema.optional(),
  displayName: z.string().optional(),
  nickName: z.string().optional(),
  emails: z.array(ScimEmailSchema).optional(),
  active: z.boolean(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  groups: z.array(ScimGroupMembershipSchema).optional(),
  meta: ScimMetaSchema.optional(),
});
export type ScimUser = z.infer<typeof ScimUserSchema>;

export const ScimGroupMemberSchema = z.object({
  value: z.string().min(1),
  display: z.string().optional(),
  type: z.enum(["User", "Group"]).optional(),
  $ref: z.string().url().optional(),
});

export const ScimGroupSchema = z.object({
  schemas: z.array(z.enum(SCIM_CORE_SCHEMAS)).min(1),
  id: z.string().min(1).optional(),
  externalId: z.string().optional(),
  displayName: z.string().min(1),
  members: z.array(ScimGroupMemberSchema).default([]),
  meta: ScimMetaSchema.optional(),
});
export type ScimGroup = z.infer<typeof ScimGroupSchema>;

export const ScimPatchOperationSchema = z
  .object({
    op: z.enum(SCIM_PATCH_OPS),
    path: z.string().optional(),
    value: z.unknown().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.op === "remove" && p.path === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "remove operations require a path",
      });
    }
  });
export type ScimPatchOperation = z.infer<typeof ScimPatchOperationSchema>;

export const ScimPatchRequestSchema = z.object({
  schemas: z
    .array(z.literal("urn:ietf:params:scim:api:messages:2.0:PatchOp"))
    .length(1),
  Operations: z.array(ScimPatchOperationSchema).min(1).max(100),
});
export type ScimPatchRequest = z.infer<typeof ScimPatchRequestSchema>;

export const ScimBulkOperationSchema = z.object({
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  bulkId: z.string().min(1).optional(),
  path: z.string().min(1),
  data: z.unknown().optional(),
  version: z.string().optional(),
});

export const ScimBulkRequestSchema = z
  .object({
    schemas: z
      .array(z.literal("urn:ietf:params:scim:api:messages:2.0:BulkRequest"))
      .length(1),
    failOnErrors: z.number().int().min(0).optional(),
    Operations: z
      .array(ScimBulkOperationSchema)
      .min(1)
      .max(SCIM_BULK_MAX_OPERATIONS),
  })
  .superRefine((r, ctx) => {
    const postOps = r.Operations.filter((o) => o.method === "POST");
    const seenBulkIds = new Set<string>();
    for (const op of postOps) {
      if (!op.bulkId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["Operations"],
          message: "POST bulk operations require bulkId",
        });
        return;
      }
      if (seenBulkIds.has(op.bulkId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["Operations"],
          message: `duplicate bulkId: ${op.bulkId}`,
        });
        return;
      }
      seenBulkIds.add(op.bulkId);
    }
  });
export type ScimBulkRequest = z.infer<typeof ScimBulkRequestSchema>;

const FILTER_TOKEN_RE = new RegExp(
  `^([A-Za-z][A-Za-z0-9._:-]*)\\s+(${SCIM_FILTER_OPERATORS.join("|")})(?:\\s+(.*))?$`,
);

export interface ParsedScimFilterClause {
  readonly attribute: string;
  readonly operator: ScimFilterOperator;
  readonly value: string | null;
}

export const parseScimFilter = (
  filter: string,
): ParsedScimFilterClause | null => {
  const trimmed = filter.trim();
  const match = FILTER_TOKEN_RE.exec(trimmed);
  if (!match) return null;
  const attribute = match[1];
  const operatorRaw = match[2];
  if (attribute === undefined || operatorRaw === undefined) return null;
  const operator = operatorRaw as ScimFilterOperator;
  const rawValue = match[3] ?? null;
  if (operator !== "pr" && rawValue === null) return null;
  if (operator === "pr") {
    return { attribute, operator, value: null };
  }
  const unquoted =
    rawValue !== null && rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
  return { attribute, operator, value: unquoted };
};

export const normalizeUserName = (userName: string): string =>
  userName.trim().toLowerCase();

export const isValidPatchPath = (path: string): boolean => {
  if (path.length === 0) return false;
  if (/^[A-Za-z][A-Za-z0-9._:[\]"' =-]*$/.test(path)) return true;
  return false;
};
