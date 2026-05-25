import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SECONDS_PER_DAY = 86_400;

export const API_VERSIONS = ["v1", "v2"] as const;
export type ApiVersion = (typeof API_VERSIONS)[number];
export const ApiVersionSchema = z.enum(API_VERSIONS);

export const API_VERSION_STATUSES = ["preview", "stable", "deprecated", "sunset"] as const;
export type ApiVersionStatus = (typeof API_VERSION_STATUSES)[number];
export const ApiVersionStatusSchema = z.enum(API_VERSION_STATUSES);

export const ApiVersionSpecSchema = z
  .object({
    version: ApiVersionSchema,
    status: ApiVersionStatusSchema,
    releasedAt: Iso8601,
    deprecatedAt: Iso8601.nullable().default(null),
    sunsetAt: Iso8601.nullable().default(null),
    migrationGuideUrl: z.string().url().optional(),
    breakingChangeCount: z.number().int().nonnegative().default(0),
  })
  .superRefine((v, ctx) => {
    if ((v.status === "deprecated" || v.status === "sunset") && v.deprecatedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deprecatedAt"],
        message: `status '${v.status}' requires deprecatedAt`,
      });
    }
    if (v.status === "sunset" && v.sunsetAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sunsetAt"],
        message: "sunset status requires sunsetAt",
      });
    }
    if (v.deprecatedAt !== null && v.sunsetAt !== null) {
      const dep = new Date(v.deprecatedAt).getTime();
      const sun = new Date(v.sunsetAt).getTime();
      if (sun <= dep) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sunsetAt"],
          message: "sunsetAt must be after deprecatedAt",
        });
      }
    }
    if ((v.status === "deprecated" || v.status === "sunset") && v.migrationGuideUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["migrationGuideUrl"],
        message: `status '${v.status}' requires migrationGuideUrl`,
      });
    }
  });
export type ApiVersionSpec = z.infer<typeof ApiVersionSpecSchema>;

export const ApiVersionCatalogSchema = z.array(ApiVersionSpecSchema).superRefine((entries, ctx) => {
  const versions = new Set<ApiVersion>();
  let stableCount = 0;
  entries.forEach((e, i) => {
    if (versions.has(e.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i],
        message: `duplicate version '${e.version}'`,
      });
    }
    versions.add(e.version);
    if (e.status === "stable") stableCount++;
  });
  if (stableCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: `at most one version can be 'stable' (found ${stableCount})`,
    });
  }
});
export type ApiVersionCatalog = z.infer<typeof ApiVersionCatalogSchema>;

export function currentStableVersion(catalog: ApiVersionCatalog): ApiVersionSpec | null {
  return catalog.find((v) => v.status === "stable") ?? null;
}

export function daysUntilSunset(spec: ApiVersionSpec, now: Date = new Date()): number | null {
  if (spec.sunsetAt === null) return null;
  const ms = new Date(spec.sunsetAt).getTime() - now.getTime();
  return Math.floor(ms / 1000 / SECONDS_PER_DAY);
}

export function isSunset(spec: ApiVersionSpec, now: Date = new Date()): boolean {
  if (spec.sunsetAt === null) return false;
  return now.getTime() >= new Date(spec.sunsetAt).getTime();
}

export const VERSION_HEADER_NAME = "X-CrossEngin-Api-Version";
export const SUNSET_HEADER_NAME = "Sunset";
export const DEPRECATION_HEADER_NAME = "Deprecation";

export function versionForRequest(
  catalog: ApiVersionCatalog,
  requested: string | undefined,
): ApiVersionSpec | null {
  if (requested === undefined) {
    return currentStableVersion(catalog);
  }
  const parsed = ApiVersionSchema.safeParse(requested);
  if (!parsed.success) return null;
  return catalog.find((v) => v.version === parsed.data) ?? null;
}
