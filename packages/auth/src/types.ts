import type { TenantId, UserId } from "@crossengin/types";

export type RoleName = string;

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

export interface RoleDefinition {
  readonly name: RoleName;
  readonly label?: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly inherits?: readonly RoleName[];
  readonly isAuditor?: boolean;
  readonly abacAttributes?: Readonly<Record<string, string>>;
}

export type OperationName = "list" | "read" | "create" | "update" | "delete";

export type Operation = OperationName | { readonly kind: "transition"; readonly name: string };

export interface RbacGrant {
  readonly roles: readonly RoleName[];
  readonly abac?: string;
}

export interface FieldPermission {
  readonly read?: RbacGrant;
  readonly update?: RbacGrant;
}

export interface EntityPermissions {
  readonly list?: RbacGrant;
  readonly read?: RbacGrant;
  readonly create?: RbacGrant;
  readonly update?: RbacGrant;
  readonly delete?: RbacGrant;
  readonly transitions?: Readonly<Record<string, RbacGrant>>;
  readonly fields?: Readonly<Record<string, FieldPermission>>;
}

export type EntityName = string;
export type PermissionMap = Readonly<Record<EntityName, EntityPermissions>>;

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
