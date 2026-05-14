import { z } from "zod";

export const APP_KINDS = [
  "web",
  "marketing",
  "docs-site",
  "ops",
  "cdc-shipper",
  "hl7-listener",
  "virus-scanner",
  "gpu-inference",
  "mobile-shell",
] as const;
export type AppKind = (typeof APP_KINDS)[number];

export const RUNTIME_PROFILES = [
  "serverless_edge",
  "serverless_function",
  "long_running_service",
  "managed_service",
  "native_wrapper",
] as const;
export type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];

export const APP_RUNTIME_PROFILE: Readonly<Record<AppKind, RuntimeProfile>> = Object.freeze({
  web: "serverless_edge",
  marketing: "serverless_edge",
  "docs-site": "serverless_edge",
  ops: "serverless_edge",
  "cdc-shipper": "long_running_service",
  "hl7-listener": "long_running_service",
  "virus-scanner": "long_running_service",
  "gpu-inference": "long_running_service",
  "mobile-shell": "native_wrapper",
});

export const HEALTH_CHECK_KINDS = ["http", "tcp", "command"] as const;
export type HealthCheckKind = (typeof HEALTH_CHECK_KINDS)[number];

export const HealthCheckSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http"),
    path: z.string().regex(/^\/[A-Za-z0-9._\-/]*$/),
    expectStatus: z.number().int().min(100).max(599).default(200),
    intervalSeconds: z.number().int().min(1).max(300).default(15),
    timeoutSeconds: z.number().int().min(1).max(60).default(5),
    failureThreshold: z.number().int().min(1).max(10).default(3),
  }),
  z.object({
    kind: z.literal("tcp"),
    port: z.number().int().min(1).max(65_535),
    intervalSeconds: z.number().int().min(1).max(300).default(15),
    timeoutSeconds: z.number().int().min(1).max(60).default(5),
    failureThreshold: z.number().int().min(1).max(10).default(3),
  }),
  z.object({
    kind: z.literal("command"),
    command: z.string().min(1),
    intervalSeconds: z.number().int().min(1).max(300).default(30),
    timeoutSeconds: z.number().int().min(1).max(120).default(10),
    failureThreshold: z.number().int().min(1).max(10).default(3),
  }),
]);
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const ResourceLimitsSchema = z.object({
  cpuMillicores: z.number().int().min(100).max(64_000).optional(),
  memoryMb: z.number().int().min(64).max(131_072).optional(),
  gpuCount: z.number().int().min(0).max(16).optional(),
  minInstances: z.number().int().min(0).max(1_000).default(1),
  maxInstances: z.number().int().min(1).max(10_000).default(10),
});
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

const APP_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const AppDeployConfigSchema = z
  .object({
    appId: z.string().regex(APP_ID_REGEX),
    kind: z.enum(APP_KINDS),
    runtimeProfile: z.enum(RUNTIME_PROFILES),
    healthCheck: HealthCheckSchema.optional(),
    resources: ResourceLimitsSchema.optional(),
    dependsOnApps: z.array(z.string().regex(APP_ID_REGEX)).default([]),
    publicEntrypoint: z.boolean().default(false),
    requiresGpu: z.boolean().default(false),
    rolloutStrategy: z.enum(["atomic", "rolling", "blue_green"]).default("atomic"),
  })
  .superRefine((v, ctx) => {
    const expected = APP_RUNTIME_PROFILE[v.kind];
    if (expected !== v.runtimeProfile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtimeProfile"],
        message: `app '${v.kind}' has runtime profile '${expected}', not '${v.runtimeProfile}'`,
      });
    }
    if (v.runtimeProfile === "serverless_edge" && v.rolloutStrategy !== "atomic") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rolloutStrategy"],
        message: "serverless_edge (Vercel) deploys are always atomic; use 'atomic'",
      });
    }
    if (v.runtimeProfile === "long_running_service" && v.healthCheck === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["healthCheck"],
        message: "long_running_service apps must declare a healthCheck (rolling deploys gate on it)",
      });
    }
    if (v.kind === "gpu-inference" && v.requiresGpu === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresGpu"],
        message: "gpu-inference app must set requiresGpu=true",
      });
    }
    if (v.dependsOnApps.includes(v.appId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dependsOnApps"],
        message: "an app cannot depend on itself",
      });
    }
    if (v.resources?.maxInstances !== undefined && v.resources.minInstances > v.resources.maxInstances) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resources", "minInstances"],
        message: "minInstances cannot exceed maxInstances",
      });
    }
  });
export type AppDeployConfig = z.infer<typeof AppDeployConfigSchema>;

export function appsByRuntimeProfile(
  apps: readonly AppDeployConfig[],
  profile: RuntimeProfile,
): readonly AppDeployConfig[] {
  return apps.filter((a) => a.runtimeProfile === profile);
}

export function gpuApps(apps: readonly AppDeployConfig[]): readonly AppDeployConfig[] {
  return apps.filter((a) => a.requiresGpu);
}
