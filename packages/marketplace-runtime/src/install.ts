import {
  PackInstallationSchema,
  activeInstallations,
  buildInitialGrantSet,
  canTransitionInstallation,
  checkCompatibility,
  requiresElevatedReview,
  resolvePermissions,
  verifyPackSignature,
  type InstallationStatus,
  type PackInstallation,
  type PermissionGrantSet,
  type PermissionRequest,
  type PermissionResolution,
} from "@crossengin/marketplace";
import type { ScopeKey } from "@crossengin/sdk";

import { REVIEW_CLEARED_STATUSES, type InstallDecision, type InstallRequest } from "./decisions.js";

/** Reconstructs the pack's scope request from an installation's grant set (each grant records `optional`). */
export function requestFromGrants(grants: PermissionGrantSet): PermissionRequest {
  const requiredScopes: ScopeKey[] = [];
  const optionalScopes: ScopeKey[] = [];
  for (const g of grants) {
    (g.optional ? optionalScopes : requiredScopes).push(g.scope);
  }
  return { requiredScopes, optionalScopes };
}

/** Parses `installation` through the schema so every emitted record is valid (and defaults applied). */
function validate(installation: PackInstallation): PackInstallation {
  return PackInstallationSchema.parse(installation);
}

/** A guarded status change — throws if the transition isn't allowed by the lifecycle. */
function transition(installation: PackInstallation, to: InstallationStatus, patch: Partial<PackInstallation>): PackInstallation {
  if (!canTransitionInstallation(installation.status, to)) {
    throw new Error(`illegal installation transition ${installation.status} → ${to}`);
  }
  return validate({ ...installation, ...patch, status: to });
}

/**
 * The admission pipeline. Runs the gates in a fixed order — already-installed →
 * signature → compatibility → elevated review — and the first failure wins.
 * On success it builds the `requested` installation (with its scope grants
 * seeded pending) and advances it: straight to `installing` when the pack asks
 * for no required scopes, else to `permission_pending` awaiting a grant.
 */
export function admitInstallation(
  request: InstallRequest,
  ctx: { readonly now: string; readonly installationId: string },
): InstallDecision {
  // 1. Already installed (an active, non-failed installation of this pack for the tenant).
  if (activeInstallations(request.existing, request.tenantId).some((i) => i.packId === request.pack.id)) {
    return {
      outcome: "rejected",
      reason: "already_installed",
      reasons: [`tenant '${request.tenantId}' already has an active installation of '${request.pack.id}'`],
    };
  }

  // 2. Signature — the manifest must verify against the publisher's key.
  const signed = verifyPackSignature({
    manifest: request.pack,
    signature: request.signature,
    publicKeyBase64: request.publisherPublicKeyBase64,
  });
  if (!signed) {
    return { outcome: "rejected", reason: "signature_invalid", reasons: ["pack signature failed verification"] };
  }

  // 3. Compatibility — platform version / region / plan tier / compliance / dedicated-tenant.
  const compat = checkCompatibility(request.compatibility, request.tenantContext);
  if (!compat.compatible) {
    return { outcome: "rejected", reason: "incompatible", reasons: compat.reasons };
  }

  // 4. Elevated security review — a pack that trips the review triggers must have cleared review.
  if (requiresElevatedReview(request.pack) && !REVIEW_CLEARED_STATUSES.includes(request.securityReviewStatus)) {
    return {
      outcome: "rejected",
      reason: "review_required",
      reasons: [`pack requires elevated security review; status is '${request.securityReviewStatus}'`],
    };
  }

  const scopeRequest: PermissionRequest = {
    requiredScopes: request.pack.requiredScopes,
    optionalScopes: request.pack.optionalScopes,
  };
  const grants = buildInitialGrantSet(scopeRequest);

  const requested = validate({
    id: ctx.installationId,
    tenantId: request.tenantId,
    packId: request.pack.id,
    installedVersion: null,
    pinnedVersion: null,
    status: "requested",
    updatePolicy: "manual",
    config: {},
    permissionGrants: grants,
    requestedAt: ctx.now,
    requestedBy: request.requestedBy,
    installedAt: null,
    installedBy: null,
    lastUpdatedAt: null,
    uninstalledAt: null,
    uninstalledBy: null,
  } as PackInstallation);

  const resolution = resolvePermissions({ request: scopeRequest, grants });
  // No required scopes ⇒ nothing to grant, go straight to installing; else await grants.
  if (resolution.satisfied) {
    return { outcome: "admitted", installation: transition(requested, "installing", {}), resolution };
  }
  return {
    outcome: "permission_pending",
    installation: transition(requested, "permission_pending", {}),
    resolution,
  };
}

/**
 * Grants a set of scopes on a `permission_pending` installation. Flips those
 * pending grants to granted, recomputes the resolution, and — once every
 * required scope is satisfied — advances to `installing`. Idempotent per scope.
 */
export function applyPermissionGrants(
  installation: PackInstallation,
  input: { readonly scopes: readonly ScopeKey[]; readonly grantedBy: string; readonly at: string },
): { readonly installation: PackInstallation; readonly resolution: PermissionResolution } {
  const grantSet = new Set<ScopeKey>(input.scopes);
  const grants: PermissionGrantSet = installation.permissionGrants.map((g) =>
    grantSet.has(g.scope) && g.status === "pending"
      ? { ...g, status: "granted" as const, grantedAt: input.at, grantedBy: input.grantedBy }
      : g,
  );
  const resolution = resolvePermissions({ request: requestFromGrants(grants), grants });
  const withGrants = validate({ ...installation, permissionGrants: grants });
  if (installation.status === "permission_pending" && resolution.satisfied) {
    return { installation: transition(withGrants, "installing", {}), resolution };
  }
  return { installation: withGrants, resolution };
}

/** Completes an install: `installing` → `installed`, recording the version + who/when. */
export function completeInstallation(
  installation: PackInstallation,
  input: { readonly version: string; readonly installedBy: string; readonly at: string },
): PackInstallation {
  return transition(installation, "installed", {
    installedVersion: input.version,
    installedAt: input.at,
    installedBy: input.installedBy,
    lastUpdatedAt: input.at,
  });
}

/** Fails an in-flight install, recording the reason (valid from any pre-installed working state). */
export function failInstallation(installation: PackInstallation, reason: string): PackInstallation {
  return transition(installation, "failed", { failureReason: reason });
}

/** Begins an uninstall: `installed` → `uninstalling`. */
export function beginUninstall(installation: PackInstallation): PackInstallation {
  return transition(installation, "uninstalling", {});
}

/** Completes an uninstall: `uninstalling` → `uninstalled`, recording who/when. */
export function completeUninstall(
  installation: PackInstallation,
  input: { readonly uninstalledBy: string; readonly at: string },
): PackInstallation {
  return transition(installation, "uninstalled", {
    uninstalledAt: input.at,
    uninstalledBy: input.uninstalledBy,
  });
}

/** Begins an update: `installed` → `updating`. */
export function beginUpdate(installation: PackInstallation): PackInstallation {
  return transition(installation, "updating", {});
}

/** Completes an update: `updating` → `installed`, pinning the new version. */
export function completeUpdate(
  installation: PackInstallation,
  input: { readonly version: string; readonly at: string },
): PackInstallation {
  return transition(installation, "installed", {
    installedVersion: input.version,
    lastUpdatedAt: input.at,
  });
}
