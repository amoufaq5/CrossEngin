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

export const RbacGrantSchema = z.object({
  roles: z.array(RoleNameSchema),
  abac: z.string().optional(),
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

export type OperationName = "list" | "read" | "create" | "update" | "delete";

export type Operation = OperationName | { readonly kind: "transition"; readonly name: string };

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly requiresAbac?: string;
}

export interface FieldRedactionResult {
  readonly readable: readonly string[];
  readonly redacted: readonly string[];
}

export interface WriteMaskResult {
  readonly ok: boolean;
  readonly rejectedField?: string;
}
