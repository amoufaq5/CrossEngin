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

/**
 * The four answers an obligation can get.
 *
 * `deferred` is the one that is not about the principal at all: **the obligation needs the record
 * the act is about and the call site had none.** It is not a statement about this principal's
 * attributes, and it is not an allow — a caller that cannot supply a record refuses, and one that
 * can re-asks with it. `ABAC_OUTCOME_ALLOWS` maps it to `false`, so a caller that never re-asks
 * refuses rather than grants.
 */
export const ABAC_OUTCOMES = ["satisfied", "denied", "undischargeable", "deferred"] as const;

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
  /**
   * `null` means **not resolved** — no attribute directory was consulted — and is not the same fact
   * as `{}`, which asserts this principal has no attributes. `dischargeAbac` refuses an obligation
   * on `null` without calling the evaluator, because an evaluator cannot tell the two apart and the
   * mistake is in the allowing direction.
   */
  readonly abacAttributes: Readonly<Record<string, unknown>> | null;
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
  /**
   * The redacted fields whose refusal **a record could still change** — a strict subset of
   * `redacted`, since a deferred field is redacted right now.
   *
   * A field is here **iff** the role check passed and the only thing refusing it is an obligation
   * that answered `deferred`: the policy needs the record the act is about and the caller had none.
   * A field refused on **roles**, or whose obligation answered `denied` or `undischargeable`, is
   * **not** here, because re-asking with a record cannot change any of those — `denied` is a
   * statement about this principal, `undischargeable` says nothing could answer, and a role refusal
   * is not an obligation at all. The classification default carries no obligation, so it can never
   * contribute.
   *
   * So it answers exactly one question: *would supplying the record possibly change this answer?*
   * That is what lets a caller holding several records compute the field set once with no record and
   * stop when this is empty — which is every deployment that declared no record-bearing field
   * policy — and recompute per record only when it is not.
   *
   * **Required, not optional.** A caller that could omit it would compute an empty set, conclude
   * nothing defers, and serve the record-free answer — which is total redaction — for ever. That is
   * the silent total denial ADR-0339 found and ADR-0340 closed, and an optional field can be
   * forgotten with the type still valid (ADR-0330).
   */
  readonly deferred: readonly string[];
}

export interface WriteMaskResult {
  readonly ok: boolean;
  readonly rejectedField?: string;
  readonly abac?: AbacDischarge;
}
