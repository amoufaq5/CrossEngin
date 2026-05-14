import { z } from "zod";
import { ScopeKeySchema, type ScopeKey } from "@crossengin/sdk";

const Iso8601 = z.string().datetime({ offset: true });

export const GRANT_STATUSES = ["pending", "granted", "denied", "revoked"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];
export const GrantStatusSchema = z.enum(GRANT_STATUSES);

export const GRANT_TRANSITIONS: Readonly<
  Record<GrantStatus, readonly GrantStatus[]>
> = Object.freeze({
  pending: ["granted", "denied"],
  granted: ["revoked"],
  denied: ["pending"],
  revoked: ["pending"],
});

export function canTransitionGrant(from: GrantStatus, to: GrantStatus): boolean {
  return GRANT_TRANSITIONS[from].includes(to);
}

export const ScopeGrantSchema = z
  .object({
    scope: ScopeKeySchema,
    status: GrantStatusSchema,
    grantedAt: Iso8601.nullable().default(null),
    grantedBy: z.string().min(1).nullable().default(null),
    deniedAt: Iso8601.nullable().default(null),
    deniedReason: z.string().min(1).optional(),
    revokedAt: Iso8601.nullable().default(null),
    revokedBy: z.string().min(1).nullable().default(null),
    optional: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.status === "granted") {
      if (v.grantedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["grantedAt"],
          message: "granted status requires grantedAt",
        });
      }
      if (v.grantedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["grantedBy"],
          message: "granted status requires grantedBy",
        });
      }
    }
    if (v.status === "denied") {
      if (v.deniedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deniedAt"],
          message: "denied status requires deniedAt",
        });
      }
      if (v.deniedReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deniedReason"],
          message: "denied status requires deniedReason",
        });
      }
    }
    if (v.status === "revoked") {
      if (v.revokedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revokedAt"],
          message: "revoked status requires revokedAt",
        });
      }
      if (v.revokedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revokedBy"],
          message: "revoked status requires revokedBy",
        });
      }
    }
  });
export type ScopeGrant = z.infer<typeof ScopeGrantSchema>;

export const PermissionGrantSetSchema = z
  .array(ScopeGrantSchema)
  .superRefine((entries, ctx) => {
    const scopes = new Set<ScopeKey>();
    entries.forEach((e, i) => {
      if (scopes.has(e.scope)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "scope"],
          message: `duplicate scope '${e.scope}'`,
        });
      }
      scopes.add(e.scope);
    });
  });
export type PermissionGrantSet = z.infer<typeof PermissionGrantSetSchema>;

export interface PermissionRequest {
  readonly requiredScopes: readonly ScopeKey[];
  readonly optionalScopes: readonly ScopeKey[];
}

export interface PermissionResolutionInput {
  readonly request: PermissionRequest;
  readonly grants: PermissionGrantSet;
}

export interface PermissionResolution {
  readonly satisfied: boolean;
  readonly missingRequired: readonly ScopeKey[];
  readonly grantedOptional: readonly ScopeKey[];
  readonly pendingScopes: readonly ScopeKey[];
}

export function resolvePermissions(
  input: PermissionResolutionInput,
): PermissionResolution {
  const grantedSet = new Set<ScopeKey>();
  const pendingSet = new Set<ScopeKey>();
  for (const g of input.grants) {
    if (g.status === "granted") grantedSet.add(g.scope);
    if (g.status === "pending") pendingSet.add(g.scope);
  }
  const missingRequired: ScopeKey[] = [];
  for (const scope of input.request.requiredScopes) {
    if (!grantedSet.has(scope)) missingRequired.push(scope);
  }
  const grantedOptional: ScopeKey[] = [];
  for (const scope of input.request.optionalScopes) {
    if (grantedSet.has(scope)) grantedOptional.push(scope);
  }
  const pendingScopes: ScopeKey[] = [];
  for (const scope of [...input.request.requiredScopes, ...input.request.optionalScopes]) {
    if (pendingSet.has(scope)) pendingScopes.push(scope);
  }
  return {
    satisfied: missingRequired.length === 0,
    missingRequired,
    grantedOptional,
    pendingScopes,
  };
}

export function buildInitialGrantSet(
  request: PermissionRequest,
): PermissionGrantSet {
  const out: ScopeGrant[] = [];
  for (const scope of request.requiredScopes) {
    out.push({
      scope,
      status: "pending",
      grantedAt: null,
      grantedBy: null,
      deniedAt: null,
      revokedAt: null,
      revokedBy: null,
      optional: false,
    });
  }
  for (const scope of request.optionalScopes) {
    out.push({
      scope,
      status: "pending",
      grantedAt: null,
      grantedBy: null,
      deniedAt: null,
      revokedAt: null,
      revokedBy: null,
      optional: true,
    });
  }
  return out;
}
