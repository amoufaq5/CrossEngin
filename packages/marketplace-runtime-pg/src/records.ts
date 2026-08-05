import { PackInstallationSchema, type PackInstallation } from "@crossengin/marketplace";

/** The `meta.pack_installations` row shape as read back from the driver. */
export interface InstallationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly pack_id: string;
  readonly installed_version: string | null;
  readonly pinned_version: string | null;
  readonly status: string;
  readonly update_policy: string;
  readonly config: unknown;
  readonly permission_grants: unknown;
  readonly requested_at: string | Date;
  readonly requested_by: string;
  readonly installed_at: string | Date | null;
  readonly installed_by: string | null;
  readonly last_updated_at: string | Date | null;
  readonly uninstalled_at: string | Date | null;
  readonly uninstalled_by: string | null;
  readonly failure_reason: string | null;
  readonly isolation_sandbox: string | null;
}

/** Coerces a TIMESTAMPTZ (driver may hand back a `Date`) to an ISO string, preserving null. */
function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Projects a `meta.pack_installations` row back into a `PackInstallation`,
 * validating through the schema so a drifted/corrupt row is rejected rather than
 * silently trusted. Optional columns collapse to the record's null/undefined.
 */
export function rowToInstallation(row: InstallationRow): PackInstallation {
  return PackInstallationSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    packId: row.pack_id,
    installedVersion: row.installed_version,
    pinnedVersion: row.pinned_version,
    status: row.status,
    updatePolicy: row.update_policy,
    config: row.config ?? {},
    permissionGrants: row.permission_grants ?? [],
    requestedAt: toIso(row.requested_at),
    requestedBy: row.requested_by,
    installedAt: toIso(row.installed_at),
    installedBy: row.installed_by,
    lastUpdatedAt: toIso(row.last_updated_at),
    uninstalledAt: toIso(row.uninstalled_at),
    uninstalledBy: row.uninstalled_by,
    ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {}),
    ...(row.isolation_sandbox !== null ? { isolationSandbox: row.isolation_sandbox } : {}),
  });
}

/** The bound parameters for an installation upsert, in column order. */
export function installationParams(installation: PackInstallation): readonly unknown[] {
  return [
    installation.id,
    installation.tenantId,
    installation.packId,
    installation.installedVersion,
    installation.pinnedVersion,
    installation.status,
    installation.updatePolicy,
    JSON.stringify(installation.config),
    JSON.stringify(installation.permissionGrants),
    installation.requestedAt,
    installation.requestedBy,
    installation.installedAt,
    installation.installedBy,
    installation.lastUpdatedAt,
    installation.uninstalledAt,
    installation.uninstalledBy,
    installation.failureReason ?? null,
    installation.isolationSandbox ?? null,
  ];
}
