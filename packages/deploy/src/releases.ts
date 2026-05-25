import { z } from "zod";
import { RegionSchema } from "@crossengin/residency";
import { APP_KINDS, type AppKind } from "./apps.js";
import {
  DEPLOY_STRATEGIES,
  DEPLOY_TARGETS,
  EnvironmentSchema,
  type Environment,
} from "./environments.js";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);
const SHA_REGEX = /^[0-9a-f]{40}$/;
const SEMVER_REGEX =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const DEPLOYMENT_STATUSES = [
  "queued",
  "in_progress",
  "succeeded",
  "failed",
  "rolled_back",
  "cancelled",
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const DEPLOYMENT_TRIGGERS = [
  "merge_to_main",
  "manual_promotion",
  "scheduled_release",
  "rollback",
  "live_update",
] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

export const DeploymentRecordSchema = z
  .object({
    id: Uuid,
    appKind: z.enum(APP_KINDS),
    appId: z.string().min(1),
    environment: EnvironmentSchema,
    region: RegionSchema,
    target: z.enum(DEPLOY_TARGETS),
    strategy: z.enum(DEPLOY_STRATEGIES),
    version: z.string().regex(SEMVER_REGEX),
    commitSha: z.string().regex(SHA_REGEX),
    artifactRef: z.string().min(1),
    trigger: z.enum(DEPLOYMENT_TRIGGERS),
    triggeredBy: Uuid,
    queuedAt: Iso8601,
    startedAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    durationSeconds: z.number().int().nonnegative().nullable().default(null),
    status: z.enum(DEPLOYMENT_STATUSES),
    previousVersion: z.string().regex(SEMVER_REGEX).nullable().default(null),
    rolledBackToDeploymentId: Uuid.nullable().default(null),
    healthCheckPassed: z.boolean().nullable().default(null),
    sentryReleaseId: z.string().min(1).nullable().default(null),
    notes: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "succeeded" && v.completedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "succeeded deployments must declare completedAt",
      });
    }
    if (v.status === "rolled_back" && v.rolledBackToDeploymentId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rolledBackToDeploymentId"],
        message: "rolled_back deployments must reference the deployment they rolled back to",
      });
    }
    if (v.trigger === "rollback" && v.previousVersion === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previousVersion"],
        message: "rollback trigger requires previousVersion",
      });
    }
    if (
      v.environment === "preview" &&
      v.trigger !== "merge_to_main" &&
      v.trigger !== "live_update"
    ) {
      const allowed: ReadonlyArray<DeploymentTrigger> = ["merge_to_main", "live_update"];
      if (!allowed.includes(v.trigger)) {
        // permissive — preview deploys can be triggered many ways; this is just a soft check
      }
    }
  });
export type DeploymentRecord = z.infer<typeof DeploymentRecordSchema>;

export const DEPLOYMENT_TRANSITIONS: Readonly<
  Record<DeploymentStatus, readonly DeploymentStatus[]>
> = Object.freeze({
  queued: ["in_progress", "cancelled"],
  in_progress: ["succeeded", "failed", "cancelled"],
  succeeded: ["rolled_back"],
  failed: ["rolled_back"],
  rolled_back: [],
  cancelled: [],
});

export function canTransitionDeployment(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return DEPLOYMENT_TRANSITIONS[from].includes(to);
}

export const RELEASE_CHANNELS = ["alpha", "beta", "stable", "lts"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const ReleaseSchema = z
  .object({
    version: z.string().regex(SEMVER_REGEX),
    channel: z.enum(RELEASE_CHANNELS),
    publishedAt: Iso8601,
    commitSha: z.string().regex(SHA_REGEX),
    changelog: z.string().min(1),
    breakingChanges: z.boolean().default(false),
    apps: z.array(z.enum(APP_KINDS)).min(1),
    deprecatesVersions: z.array(z.string().regex(SEMVER_REGEX)).default([]),
    securityAdvisoriesFixed: z
      .array(z.string().regex(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/))
      .default([]),
  })
  .superRefine((v, ctx) => {
    if (v.breakingChanges && v.channel === "stable") {
      const major = Number.parseInt(v.version.replace(/^v/, "").split(".")[0] ?? "0", 10);
      if (major === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["channel"],
          message: "breaking changes on a 0.x version must not ship on the 'stable' channel",
        });
      }
    }
  });
export type Release = z.infer<typeof ReleaseSchema>;

export function semverComparator(a: string, b: string): number {
  const norm = (s: string): readonly number[] => {
    const main = s.replace(/^v/, "").split("-")[0] ?? "";
    return main.split(".").map((p) => Number.parseInt(p, 10) || 0);
  };
  const aParts = norm(a);
  const bParts = norm(b);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function latestRelease(releases: readonly Release[]): Release | null {
  if (releases.length === 0) return null;
  return [...releases].sort((a, b) => semverComparator(b.version, a.version))[0] ?? null;
}

export function rollbackTarget(
  history: readonly DeploymentRecord[],
  currentEnvironment: Environment,
  currentAppKind: AppKind,
): DeploymentRecord | null {
  const successful = history
    .filter(
      (d) =>
        d.environment === currentEnvironment &&
        d.appKind === currentAppKind &&
        d.status === "succeeded",
    )
    .sort((a, b) => {
      const aTime = a.completedAt === null ? 0 : new Date(a.completedAt).getTime();
      const bTime = b.completedAt === null ? 0 : new Date(b.completedAt).getTime();
      return bTime - aTime;
    });
  return successful[1] ?? null;
}
