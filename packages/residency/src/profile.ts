import { z } from "zod";
import { RegionSchema, REGIONS } from "./regions.js";

export const RESIDENCY_PROFILE_TEMPLATES = [
  "eu-only",
  "us-only",
  "me-only",
  "unrestricted",
  "custom",
] as const;
export type ResidencyProfileTemplate = (typeof RESIDENCY_PROFILE_TEMPLATES)[number];

export const ResidencyProfileTemplateSchema = z.enum(RESIDENCY_PROFILE_TEMPLATES);

export const RESIDENCY_DATA_CLASSES = [
  "public",
  "commercial_sensitive",
  "pii_basic",
  "pii_strict",
  "phi",
  "gxp_record",
] as const;
export type ResidencyDataClass = (typeof RESIDENCY_DATA_CLASSES)[number];

const Iso8601 = z.string().datetime({ offset: true });

const LlmProviderRef = z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/, {
  message: "llm provider must be '<provider>:<region|qualifier>' (e.g., 'fireworks:eu')",
});

export const ResidencyProfileSchema = z
  .object({
    profile: ResidencyProfileTemplateSchema,
    primaryRegion: RegionSchema,
    allowedRegions: z.array(RegionSchema).min(1),
    forbiddenRegions: z.array(RegionSchema).default([]),
    allowedLlmProviders: z.array(LlmProviderRef).min(1),
    dataClass: z.enum(RESIDENCY_DATA_CLASSES),
    establishedAt: Iso8601,
    validatedBy: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.allowedRegions.includes(v.primaryRegion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primaryRegion"],
        message: `primaryRegion '${v.primaryRegion}' must be in allowedRegions`,
      });
    }
    for (const forbidden of v.forbiddenRegions) {
      if (v.allowedRegions.includes(forbidden)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forbiddenRegions"],
          message: `region '${forbidden}' appears in both allowedRegions and forbiddenRegions`,
        });
      }
    }
    if (v.allowedRegions.includes(v.primaryRegion) === false) return;
    const allowedSet = new Set(v.allowedRegions);
    if (allowedSet.size !== v.allowedRegions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedRegions"],
        message: "allowedRegions must not contain duplicates",
      });
    }
  });
export type ResidencyProfile = z.infer<typeof ResidencyProfileSchema>;

const baseTimestamp = "1970-01-01T00:00:00.000Z";

export interface ProfileTemplateInput {
  readonly establishedAt: string;
  readonly validatedBy?: string;
}

export const PROFILE_TEMPLATES: Readonly<
  Record<
    Exclude<ResidencyProfileTemplate, "custom">,
    Omit<ResidencyProfile, "establishedAt" | "validatedBy">
  >
> = Object.freeze({
  "eu-only": {
    profile: "eu-only",
    primaryRegion: "eu-central",
    allowedRegions: ["eu-central", "eu-west"],
    forbiddenRegions: ["us-east", "us-west", "me-uae", "gcc-ksa", "apac-sg", "ap-south"],
    allowedLlmProviders: ["fireworks:eu", "anthropic:eu", "self-hosted-bge:eu"],
    dataClass: "pii_strict",
  },
  "us-only": {
    profile: "us-only",
    primaryRegion: "us-east",
    allowedRegions: ["us-east", "us-west"],
    forbiddenRegions: ["eu-central", "eu-west", "me-uae", "gcc-ksa", "apac-sg", "ap-south"],
    allowedLlmProviders: ["fireworks:us", "anthropic:us", "self-hosted-bge:us"],
    dataClass: "phi",
  },
  "me-only": {
    profile: "me-only",
    primaryRegion: "me-uae",
    allowedRegions: ["me-uae", "gcc-ksa"],
    forbiddenRegions: ["eu-central", "eu-west", "us-east", "us-west", "apac-sg", "ap-south"],
    allowedLlmProviders: ["self-hosted-bge:uae"],
    dataClass: "pii_strict",
  },
  unrestricted: {
    profile: "unrestricted",
    primaryRegion: "eu-central",
    allowedRegions: [...REGIONS],
    forbiddenRegions: [],
    allowedLlmProviders: ["fireworks:eu", "anthropic:eu", "self-hosted-bge:eu"],
    dataClass: "commercial_sensitive",
  },
} as const);

export function buildProfileFromTemplate(
  template: Exclude<ResidencyProfileTemplate, "custom">,
  input: ProfileTemplateInput,
): ResidencyProfile {
  const base = PROFILE_TEMPLATES[template];
  const result: ResidencyProfile = {
    ...base,
    establishedAt: input.establishedAt ?? baseTimestamp,
    ...(input.validatedBy !== undefined ? { validatedBy: input.validatedBy } : {}),
  };
  return ResidencyProfileSchema.parse(result);
}

export const PACK_MIN_PROFILE: Readonly<
  Record<string, Exclude<ResidencyProfileTemplate, "custom">>
> = Object.freeze({
  "21-cfr-part-11": "us-only",
  hipaa: "us-only",
  gdpr: "eu-only",
  "eu-gmp": "eu-only",
  "uae-moh": "me-only",
  "uae-pdpl": "me-only",
});

export function minimumProfileForPacks(
  packIds: readonly string[],
): Exclude<ResidencyProfileTemplate, "custom"> | null {
  let strictest: Exclude<ResidencyProfileTemplate, "custom"> | null = null;
  for (const id of packIds) {
    const min = PACK_MIN_PROFILE[id];
    if (min === undefined) continue;
    if (strictest === null || strictness(min) > strictness(strictest)) {
      strictest = min;
    }
  }
  return strictest;
}

function strictness(t: Exclude<ResidencyProfileTemplate, "custom">): number {
  switch (t) {
    case "unrestricted":
      return 0;
    case "eu-only":
      return 1;
    case "us-only":
      return 2;
    case "me-only":
      return 3;
  }
}
