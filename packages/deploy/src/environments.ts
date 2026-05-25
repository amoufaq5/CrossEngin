import { z } from "zod";
import { RegionSchema, type Region } from "@crossengin/residency";
import { APP_KINDS, type AppKind, type RuntimeProfile } from "./apps.js";

export const ENVIRONMENTS = ["local", "preview", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const EnvironmentSchema = z.enum(ENVIRONMENTS);

export const DEPLOY_TARGETS = [
  "vercel",
  "fly_machines",
  "supabase",
  "cloudflare",
  "typesense_cloud",
  "inngest_cloud",
  "clickhouse_cloud",
  "ghcr",
  "app_store",
  "play_store",
] as const;
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

export const DeployTargetSchema = z.enum(DEPLOY_TARGETS);

export const RUNTIME_TARGET: Readonly<Record<RuntimeProfile, DeployTarget>> = Object.freeze({
  serverless_edge: "vercel",
  serverless_function: "vercel",
  long_running_service: "fly_machines",
  managed_service: "supabase",
  native_wrapper: "app_store",
});

export const DEPLOY_STRATEGIES = ["atomic", "rolling", "blue_green", "canary"] as const;
export type DeployStrategy = (typeof DEPLOY_STRATEGIES)[number];

export const ENVIRONMENT_STRATEGY: Readonly<Record<Environment, readonly DeployStrategy[]>> =
  Object.freeze({
    local: ["atomic"],
    preview: ["atomic", "rolling"],
    staging: ["atomic", "rolling", "blue_green"],
    production: ["atomic", "rolling", "blue_green", "canary"],
  });

export const TargetCredentialsRefSchema = z.object({
  target: DeployTargetSchema,
  vault: z.string().min(1),
  description: z.string().min(1).optional(),
});
export type TargetCredentialsRef = z.infer<typeof TargetCredentialsRefSchema>;

export const EnvironmentConfigSchema = z
  .object({
    environment: EnvironmentSchema,
    region: RegionSchema,
    isPrimary: z.boolean().default(false),
    targets: z.array(DeployTargetSchema).min(1),
    credentials: z.array(TargetCredentialsRefSchema).default([]),
    allowedStrategies: z.array(z.enum(DEPLOY_STRATEGIES)).min(1),
    branchProtection: z.boolean().default(false),
    requiresManualPromotion: z.boolean().default(false),
    syntheticChecks: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const allowed = new Set<string>(ENVIRONMENT_STRATEGY[v.environment]);
    for (const strategy of v.allowedStrategies) {
      if (!allowed.has(strategy)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedStrategies"],
          message: `strategy '${strategy}' is not allowed in environment '${v.environment}'`,
        });
      }
    }
    if (v.environment === "production" && v.branchProtection === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branchProtection"],
        message: "production environments must enable branchProtection",
      });
    }
    if (v.environment === "production" && v.syntheticChecks === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["syntheticChecks"],
        message: "production environments must enable syntheticChecks",
      });
    }
    const seen = new Set<string>();
    v.credentials.forEach((c, i) => {
      if (seen.has(c.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["credentials", i, "target"],
          message: `duplicate credentials for target '${c.target}'`,
        });
      }
      seen.add(c.target);
      if (!v.targets.includes(c.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["credentials", i, "target"],
          message: `credentials for '${c.target}' but it's not in this environment's targets`,
        });
      }
    });
  });
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;

export const EnvironmentSetSchema = z.array(EnvironmentConfigSchema).superRefine((entries, ctx) => {
  const primariesPerEnv = new Map<Environment, number>();
  const byKey = new Set<string>();
  entries.forEach((e, i) => {
    const key = `${e.environment}|${e.region}`;
    if (byKey.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i],
        message: `duplicate environment+region pair '${key}'`,
      });
    }
    byKey.add(key);
    if (e.isPrimary) {
      primariesPerEnv.set(e.environment, (primariesPerEnv.get(e.environment) ?? 0) + 1);
    }
  });
  for (const [env, count] of primariesPerEnv) {
    if (count > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `environment '${env}' has ${count} primaries; exactly one must be primary`,
      });
    }
  }
});
export type EnvironmentSet = z.infer<typeof EnvironmentSetSchema>;

export function targetFor(profile: RuntimeProfile): DeployTarget {
  return RUNTIME_TARGET[profile];
}

export function findEnvironment(
  set: EnvironmentSet,
  environment: Environment,
  region: Region,
): EnvironmentConfig | null {
  return set.find((e) => e.environment === environment && e.region === region) ?? null;
}

export function primaryProductionRegion(set: EnvironmentSet): Region | null {
  const primary = set.find((e) => e.environment === "production" && e.isPrimary);
  return primary?.region ?? null;
}

void APP_KINDS;
export type { AppKind };
