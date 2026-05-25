import { z } from "zod";
import { TargetLanguageSchema } from "./languages.js";

const Iso8601 = z.string().datetime({ offset: true });
const SEMVER_REGEX =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const COMPATIBILITY_LEVELS = [
  "fully_compatible",
  "compatible_with_warnings",
  "deprecated_supported",
  "unsupported",
  "blocked",
] as const;
export type CompatibilityLevel = (typeof COMPATIBILITY_LEVELS)[number];
export const CompatibilityLevelSchema = z.enum(COMPATIBILITY_LEVELS);

export const COMPATIBILITY_RANK: Readonly<Record<CompatibilityLevel, number>> = Object.freeze({
  fully_compatible: 4,
  compatible_with_warnings: 3,
  deprecated_supported: 2,
  unsupported: 1,
  blocked: 0,
});

export const CompatibilityEntrySchema = z
  .object({
    language: TargetLanguageSchema,
    clientVersion: z.string().regex(SEMVER_REGEX),
    apiVersion: z.string().min(1),
    level: CompatibilityLevelSchema,
    warningCount: z.number().int().nonnegative().default(0),
    notes: z.string().min(1).optional(),
    determinedAt: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (v.level === "compatible_with_warnings" && v.warningCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["warningCount"],
        message: "compatible_with_warnings requires warningCount >= 1",
      });
    }
    if (
      (v.level === "deprecated_supported" || v.level === "unsupported" || v.level === "blocked") &&
      v.notes === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notes"],
        message: `level '${v.level}' requires notes explaining the gap`,
      });
    }
    if (v.level === "fully_compatible" && v.warningCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["level"],
        message: "fully_compatible cannot have warnings",
      });
    }
  });
export type CompatibilityEntry = z.infer<typeof CompatibilityEntrySchema>;

export const CompatibilityMatrixSchema = z
  .array(CompatibilityEntrySchema)
  .superRefine((entries, ctx) => {
    const keys = new Map<string, number>();
    entries.forEach((e, i) => {
      const key = `${e.language}|${e.clientVersion}|${e.apiVersion}`;
      const prior = keys.get(key);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `duplicate (language, clientVersion, apiVersion) '${key}' (already at index ${prior})`,
        });
      }
      keys.set(key, i);
    });
  });
export type CompatibilityMatrix = z.infer<typeof CompatibilityMatrixSchema>;

export interface ResolutionRequest {
  readonly language: string;
  readonly clientVersion: string;
  readonly apiVersion: string;
}

export interface ResolutionResult {
  readonly level: CompatibilityLevel;
  readonly allowed: boolean;
  readonly reason: string;
}

export function resolveCompatibility(
  matrix: CompatibilityMatrix,
  request: ResolutionRequest,
): ResolutionResult {
  const exact = matrix.find(
    (e) =>
      e.language === request.language &&
      e.clientVersion === request.clientVersion &&
      e.apiVersion === request.apiVersion,
  );
  if (exact === undefined) {
    return {
      level: "unsupported",
      allowed: false,
      reason: `no compatibility entry for ${request.language} ${request.clientVersion} against API ${request.apiVersion}`,
    };
  }
  const allowed = exact.level !== "blocked";
  let reason: string;
  switch (exact.level) {
    case "fully_compatible":
      reason = "compatible";
      break;
    case "compatible_with_warnings":
      reason = `compatible with ${exact.warningCount.toString()} warning(s); upgrade soon`;
      break;
    case "deprecated_supported":
      reason = "deprecated but still supported; plan upgrade";
      break;
    case "unsupported":
      reason = exact.notes ?? "unsupported";
      break;
    case "blocked":
      reason = exact.notes ?? "blocked";
      break;
  }
  return { level: exact.level, allowed, reason };
}

export function clientsAffectedByApiVersion(
  matrix: CompatibilityMatrix,
  apiVersion: string,
  minLevel: CompatibilityLevel = "unsupported",
): readonly CompatibilityEntry[] {
  const min = COMPATIBILITY_RANK[minLevel];
  return matrix.filter((e) => e.apiVersion === apiVersion && COMPATIBILITY_RANK[e.level] <= min);
}

export function meetsLevel(actual: CompatibilityLevel, required: CompatibilityLevel): boolean {
  return COMPATIBILITY_RANK[actual] >= COMPATIBILITY_RANK[required];
}
