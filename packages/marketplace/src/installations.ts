import { z } from "zod";
import { PermissionGrantSetSchema } from "./permissions.js";

const Iso8601 = z.string().datetime({ offset: true });
const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACK_ID_REGEX = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/;

export const INSTALLATION_STATUSES = [
  "requested",
  "permission_pending",
  "installing",
  "installed",
  "updating",
  "failed",
  "uninstalling",
  "uninstalled",
] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];
export const InstallationStatusSchema = z.enum(INSTALLATION_STATUSES);

export const INSTALLATION_TRANSITIONS: Readonly<
  Record<InstallationStatus, readonly InstallationStatus[]>
> = Object.freeze({
  requested: ["permission_pending", "installing", "failed"],
  permission_pending: ["installing", "failed", "uninstalled"],
  installing: ["installed", "failed"],
  installed: ["updating", "uninstalling"],
  updating: ["installed", "failed"],
  failed: ["installing", "uninstalled"],
  uninstalling: ["uninstalled", "failed"],
  uninstalled: ["installing"],
});

export function canTransitionInstallation(
  from: InstallationStatus,
  to: InstallationStatus,
): boolean {
  return INSTALLATION_TRANSITIONS[from].includes(to);
}

export const UPDATE_POLICIES = [
  "manual",
  "patch_auto",
  "minor_auto",
  "track_latest",
] as const;
export type UpdatePolicy = (typeof UPDATE_POLICIES)[number];
export const UpdatePolicySchema = z.enum(UPDATE_POLICIES);

export const PackInstallationSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    packId: z.string().regex(PACK_ID_REGEX),
    installedVersion: z.string().regex(SEMVER_REGEX).nullable(),
    pinnedVersion: z.string().regex(SEMVER_REGEX).nullable().default(null),
    status: InstallationStatusSchema,
    updatePolicy: UpdatePolicySchema.default("manual"),
    config: z.record(z.string(), z.unknown()).default({}),
    permissionGrants: PermissionGrantSetSchema.default([]),
    requestedAt: Iso8601,
    requestedBy: z.string().min(1),
    installedAt: Iso8601.nullable().default(null),
    installedBy: z.string().min(1).nullable().default(null),
    lastUpdatedAt: Iso8601.nullable().default(null),
    uninstalledAt: Iso8601.nullable().default(null),
    uninstalledBy: z.string().min(1).nullable().default(null),
    failureReason: z.string().min(1).optional(),
    isolationSandbox: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "installed" || v.status === "updating" || v.status === "uninstalling") {
      if (v.installedVersion === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["installedVersion"],
          message: `status '${v.status}' requires installedVersion`,
        });
      }
      if (v.installedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["installedAt"],
          message: `status '${v.status}' requires installedAt`,
        });
      }
      if (v.installedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["installedBy"],
          message: `status '${v.status}' requires installedBy`,
        });
      }
    }
    if (v.status === "uninstalled") {
      if (v.uninstalledAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["uninstalledAt"],
          message: "uninstalled status requires uninstalledAt",
        });
      }
      if (v.uninstalledBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["uninstalledBy"],
          message: "uninstalled status requires uninstalledBy",
        });
      }
    }
    if (v.status === "failed" && v.failureReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureReason"],
        message: "failed status requires failureReason",
      });
    }
    if (
      v.pinnedVersion !== null &&
      v.updatePolicy !== "manual"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatePolicy"],
        message: "pinnedVersion implies updatePolicy='manual'",
      });
    }
  });
export type PackInstallation = z.infer<typeof PackInstallationSchema>;

export const PackInstallationSetSchema = z
  .array(PackInstallationSchema)
  .superRefine((entries, ctx) => {
    const seenIds = new Set<string>();
    const seenTenantPack = new Map<string, number>();
    entries.forEach((e, i) => {
      if (seenIds.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate installation id '${e.id}'`,
        });
      }
      seenIds.add(e.id);
      if (e.status !== "uninstalled") {
        const key = `${e.tenantId}|${e.packId}`;
        const prior = seenTenantPack.get(key);
        if (prior !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `tenant '${e.tenantId}' already has an active installation of '${e.packId}' (at index ${prior}); uninstall before reinstalling`,
          });
        }
        seenTenantPack.set(key, i);
      }
    });
  });
export type PackInstallationSet = z.infer<typeof PackInstallationSetSchema>;

export function activeInstallations(
  set: PackInstallationSet,
  tenantId: string,
): readonly PackInstallation[] {
  return set.filter(
    (i) =>
      i.tenantId === tenantId &&
      i.status !== "uninstalled" &&
      i.status !== "failed",
  );
}

export function installationFor(
  set: PackInstallationSet,
  tenantId: string,
  packId: string,
): PackInstallation | null {
  return (
    set.find(
      (i) =>
        i.tenantId === tenantId &&
        i.packId === packId &&
        i.status !== "uninstalled",
    ) ?? null
  );
}

export function shouldAutoUpdate(
  installation: PackInstallation,
  newVersion: string,
): boolean {
  if (installation.updatePolicy === "manual") return false;
  if (installation.pinnedVersion !== null) return false;
  if (installation.installedVersion === null) return false;
  if (installation.updatePolicy === "track_latest") return true;
  const cur = installation.installedVersion.split("-")[0]?.split(".").map((n) => Number.parseInt(n, 10) || 0) ?? [];
  const next = newVersion.split("-")[0]?.split(".").map((n) => Number.parseInt(n, 10) || 0) ?? [];
  if (installation.updatePolicy === "patch_auto") {
    return cur[0] === next[0] && cur[1] === next[1];
  }
  if (installation.updatePolicy === "minor_auto") {
    return cur[0] === next[0];
  }
  return false;
}
