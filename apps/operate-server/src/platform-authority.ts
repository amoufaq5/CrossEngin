import type { ServeOptions } from "./cli.js";

/**
 * Which roles carry a **platform** authority — a grant over the deployment or over every tenant —
 * and the one rule that keeps a membership grant from conferring one (H-04).
 *
 * The roles that authorise a platform route are CLI-supplied role names, and a role name is a
 * string in a membership row. So a principal holding only the user-administration grant
 * (`--platform-user-role`) could write a membership naming `platform_admin` — or the deletion
 * verifier, or the design reviewer — for itself or anyone, and the next login would carry it: an
 * escalation from administering users to deleting tenants, through the one route whose whole
 * subject is granting roles.
 *
 * The rule is **no escalation**: a grant may name a platform-authority role only if the granting
 * principal holds that role itself. It does not stop a `platform_admin` from minting another, which
 * is administration; it stops a role from being acquired by a principal that never held it.
 */

/** Every `ServeOptions` field that is a list of roles, derived from the type rather than listed. */
export type RoleListOption = {
  [K in keyof ServeOptions]: K extends `${string}Roles`
    ? ServeOptions[K] extends readonly string[]
      ? K
      : never
    : never;
}[keyof ServeOptions];

/**
 * Whether each role-list option grants a platform authority (`true`) or a tenant-scoped one
 * (`false`). A total map, so a new `--…-role` flag is a compile error here until somebody says which
 * side it is on — the ADR-0288 maintained list made into an obligation. Tenant-scoped grants act on
 * the caller's own tenant's data, which a tenant's own manifest roles reach anyway.
 */
export const ROLE_OPTION_IS_PLATFORM_AUTHORITY: Readonly<Record<RoleListOption, boolean>> =
  Object.freeze({
    platformUserRoles: true,
    credentialAdminRoles: true,
    platformAdminRoles: true,
    designReviewRoles: true,
    integrityVerdictPlatformRoles: true,
    auditReadPlatformRoles: true,
    tenantErasureRoles: true,
    tenantDeletionRoles: true,
    tenantTombstoneReadRoles: true,
    deletionRequestSubmitRoles: true,
    deletionRequestVerifyRoles: true,
    deletionRequestReadRoles: true,
    deletionRequestReconcileRoles: true,
    notificationAdminRoles: false,
    notificationAuditRoles: false,
    jobInvokeRoles: false,
    jobInvokeActionRoles: false,
    workflowCancelRoles: false,
    preferenceRoles: false,
    preferenceAdminRoles: false,
    adminRoles: false,
    packAdminRoles: false,
    jobActorRoles: false,
    aiDesignRoles: false,
    integrityVerdictTenantRoles: false,
    notificationTemplateAuthorRoles: false,
    notificationTemplateApproverRoles: false,
    notificationTemplateUnconditionalRoles: false,
    auditReadTenantRoles: false,
    auditReadSensitiveRoles: false,
    sensitiveFieldRoles: false,
    readStateRoles: false,
    readStateBackfillRoles: false,
  });

/** The roles this deployment's flags hand a platform authority. */
export function platformAuthorityRoles(
  options: Pick<ServeOptions, RoleListOption>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [key, isPlatform] of Object.entries(ROLE_OPTION_IS_PLATFORM_AUTHORITY) as [
    RoleListOption,
    boolean,
  ][]) {
    if (!isPlatform) continue;
    for (const role of options[key]) out.add(role);
  }
  return out;
}

/**
 * The platform-authority roles a grant names that its granter does not hold — empty when the grant
 * may proceed. Sorted and de-duplicated so a refusal reads the same however the body ordered them.
 */
export function escalatingRoles(input: {
  readonly granterRoles: readonly string[];
  readonly grantedRoles: readonly string[];
  readonly authorityRoles: ReadonlySet<string>;
}): readonly string[] {
  const held = new Set(input.granterRoles);
  return [...new Set(input.grantedRoles)]
    .filter((r) => input.authorityRoles.has(r) && !held.has(r))
    .sort();
}
