import { z } from "zod";
import type { TenantId, UserId } from "@crossengin/types";

export type RoleName = string;

export const RoleNameSchema = z.string().min(1);

export const RoleDefinitionSchema = z.object({
  name: RoleNameSchema,
  label: z.record(z.string(), z.string()).optional(),
  description: z.string().optional(),
  inherits: z.array(RoleNameSchema).optional(),
  isAuditor: z.boolean().optional(),
  abacAttributes: z.record(z.string(), z.string()).optional(),
});

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export const ABAC_OUTCOMES = ["satisfied", "denied", "undischargeable"] as const;

export type AbacOutcome = (typeof ABAC_OUTCOMES)[number];

export const MAX_ABAC_POLICY_KEY_LENGTH = 200;

export interface AbacDischarge {
  readonly policyKey: string;
  readonly outcome: AbacOutcome;
}

export const RbacGrantSchema = z.object({
  roles: z.array(RoleNameSchema),
  /**
   * An opaque **policy key** resolved by the deployment's `AbacEvaluator` — converging with
   * `@crossengin/workflow-engine`'s `ABAC_CHECK_GUARD.policyKey`, which made this decision first.
   * This repo never parses it as an expression; an empty key is an obligation naming nothing, and
   * `"" !== undefined` made it a *live* obligation, so the minimum length is load-bearing.
   */
  abac: z.string().min(1).max(MAX_ABAC_POLICY_KEY_LENGTH).optional(),
});

export type RbacGrant = z.infer<typeof RbacGrantSchema>;

export const FieldPermissionSchema = z.object({
  read: RbacGrantSchema.optional(),
  update: RbacGrantSchema.optional(),
});

export type FieldPermission = z.infer<typeof FieldPermissionSchema>;

export const EntityPermissionsSchema = z.object({
  list: RbacGrantSchema.optional(),
  read: RbacGrantSchema.optional(),
  create: RbacGrantSchema.optional(),
  update: RbacGrantSchema.optional(),
  delete: RbacGrantSchema.optional(),
  transitions: z.record(z.string(), RbacGrantSchema).optional(),
  fields: z.record(z.string(), FieldPermissionSchema).optional(),
});

export type EntityPermissions = z.infer<typeof EntityPermissionsSchema>;

export type EntityName = string;

export const PermissionMapSchema = z.record(z.string(), EntityPermissionsSchema);

export type PermissionMap = z.infer<typeof PermissionMapSchema>;

export type PrincipalKind = "user" | "ai_architect" | "system";

export interface Principal {
  readonly kind: PrincipalKind;
  readonly tenantId: TenantId;
  readonly userId: UserId | null;
  readonly primaryRole: RoleName;
  readonly secondaryRoles: readonly RoleName[];
  readonly abacAttributes: Readonly<Record<string, unknown>>;
  readonly mfaProofAgeSeconds: number | null;
}

export const OPERATION_NAMES = ["list", "read", "create", "update", "delete"] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];

export type Operation = OperationName | { readonly kind: "transition"; readonly name: string };

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  /** Absent when the grant carried no policy key: no obligation existed, so none was discharged. */
  readonly abac?: AbacDischarge;
}

export interface FieldRedactionResult {
  readonly readable: readonly string[];
  readonly redacted: readonly string[];
}

export interface WriteMaskResult {
  readonly ok: boolean;
  readonly rejectedField?: string;
  readonly abac?: AbacDischarge;
}
