import {
  PackInstallationSchema,
  canTransitionInstallation,
  type InstallationStatus,
  type PackInstallation,
  type PermissionGrantSet,
  type UpdatePolicy,
} from "@crossengin/marketplace";

/**
 * The pure marketplace install-lifecycle engine (Phase 3 P5). It produces the
 * next `PackInstallation` for an action, guarded by the contract's
 * `canTransitionInstallation` state machine and re-validated through
 * `PackInstallationSchema` (so the per-status required-field invariants —
 * installed ⇒ installedVersion/At/By, failed ⇒ failureReason, uninstalled ⇒
 * uninstalledAt/By — always hold). No DB; the store persists what this returns.
 */
export class IllegalInstallationTransitionError extends Error {}

export interface NewInstallRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly packId: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly updatePolicy?: UpdatePolicy;
  readonly config?: Record<string, unknown>;
  readonly pinnedVersion?: string | null;
  /** When set, the install starts in `permission_pending` awaiting grants. */
  readonly requiresPermissions?: boolean;
}

/** A fresh install request — `requested` (or `permission_pending` if grants are needed). */
export function newInstallationRequest(req: NewInstallRequest): PackInstallation {
  return PackInstallationSchema.parse({
    id: req.id,
    tenantId: req.tenantId,
    packId: req.packId,
    installedVersion: null,
    pinnedVersion: req.pinnedVersion ?? null,
    status: req.requiresPermissions === true ? "permission_pending" : "requested",
    updatePolicy: req.updatePolicy ?? "manual",
    config: req.config ?? {},
    requestedAt: req.requestedAt,
    requestedBy: req.requestedBy,
  });
}

/**
 * Applies a guarded status transition to an installation, merging `patch` and
 * re-validating. Throws `IllegalInstallationTransitionError` if the state machine
 * forbids `from → to`.
 */
export function transitionInstallation(
  installation: PackInstallation,
  to: InstallationStatus,
  patch: Partial<PackInstallation> = {},
): PackInstallation {
  if (!canTransitionInstallation(installation.status, to)) {
    throw new IllegalInstallationTransitionError(
      `cannot transition installation ${installation.id} from '${installation.status}' to '${to}'`,
    );
  }
  return PackInstallationSchema.parse({ ...installation, ...patch, status: to });
}

/** Grant the pending permissions and move into `installing`. */
export function grantAndInstall(installation: PackInstallation, grants: PermissionGrantSet): PackInstallation {
  return transitionInstallation(installation, "installing", { permissionGrants: grants });
}

/** Move a requested/uninstalled install into `installing` (no permission gate). */
export function beginInstall(installation: PackInstallation): PackInstallation {
  return transitionInstallation(installation, "installing");
}

/** Complete an install — stamps the installed version + actor + time. */
export function completeInstall(
  installation: PackInstallation,
  details: { readonly version: string; readonly installedBy: string; readonly at: string },
): PackInstallation {
  return transitionInstallation(installation, "installed", {
    installedVersion: details.version,
    installedAt: details.at,
    installedBy: details.installedBy,
    lastUpdatedAt: details.at,
  });
}

/** Begin an update of an installed pack. */
export function beginUpdate(installation: PackInstallation): PackInstallation {
  return transitionInstallation(installation, "updating");
}

/** Complete an update — bumps the installed version + lastUpdatedAt. */
export function completeUpdate(
  installation: PackInstallation,
  details: { readonly version: string; readonly at: string },
): PackInstallation {
  return transitionInstallation(installation, "installed", {
    installedVersion: details.version,
    lastUpdatedAt: details.at,
  });
}

/** Mark an in-flight install/update as failed with a reason. */
export function failInstallation(installation: PackInstallation, reason: string): PackInstallation {
  return transitionInstallation(installation, "failed", { failureReason: reason });
}

/** Begin uninstalling an installed pack. */
export function requestUninstall(installation: PackInstallation): PackInstallation {
  return transitionInstallation(installation, "uninstalling");
}

/** Complete an uninstall — stamps the actor + time. */
export function completeUninstall(
  installation: PackInstallation,
  details: { readonly uninstalledBy: string; readonly at: string },
): PackInstallation {
  return transitionInstallation(installation, "uninstalled", {
    uninstalledAt: details.at,
    uninstalledBy: details.uninstalledBy,
  });
}
