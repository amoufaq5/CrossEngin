import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);

export const SCHEMA_CHANGE_APPROVAL_TIERS = [
  "tiered",
  "always_human",
  "agent_can_do_anything",
] as const;
export type SchemaChangeApprovalTier = (typeof SCHEMA_CHANGE_APPROVAL_TIERS)[number];

export const EXTERNAL_PROVIDERS = ["fireworks", "openai", "anthropic_cloud", "together"] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

export const TenantAiSettingsSchema = z
  .object({
    tenantId: Uuid,
    sharedCatalogOptIn: z.boolean().default(false),
    crossTenantPatternLearningOptIn: z.boolean().default(false),
    allowedExternalProviders: z.array(z.enum(EXTERNAL_PROVIDERS)).default(["fireworks"]),
    schemaChangeApprovalTier: z
      .enum(SCHEMA_CHANGE_APPROVAL_TIERS)
      .default("always_human"),
    perSessionTokenCeiling: z.number().int().positive().default(50_000),
    perTenantMonthlyDollarCeiling: z.number().int().positive().default(200),
    summarizationFrequencyTurns: z.number().int().min(5).max(100).default(20),
    diffPreviewVerbose: z.boolean().default(false),
    supportTranscriptAccessGranted: z.boolean().default(false),
    updatedAt: Iso8601,
    updatedBy: Uuid,
  })
  .superRefine((v, ctx) => {
    if (!v.allowedExternalProviders.includes("fireworks")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedExternalProviders"],
        message: "allowedExternalProviders must include 'fireworks' (the default EU-resident provider)",
      });
    }
    const seen = new Set<string>();
    v.allowedExternalProviders.forEach((p, i) => {
      if (seen.has(p)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedExternalProviders", i],
          message: `duplicate provider '${p}'`,
        });
      }
      seen.add(p);
    });
  });
export type TenantAiSettings = z.infer<typeof TenantAiSettingsSchema>;

export const PACK_FORCED_DEFAULTS: Readonly<
  Record<string, Partial<TenantAiSettings>>
> = Object.freeze({
  hipaa: {
    sharedCatalogOptIn: false,
    crossTenantPatternLearningOptIn: false,
    allowedExternalProviders: ["fireworks"],
  },
  "21-cfr-part-11": {
    sharedCatalogOptIn: false,
    crossTenantPatternLearningOptIn: false,
    allowedExternalProviders: ["fireworks"],
  },
  "uae-moh": {
    sharedCatalogOptIn: false,
    crossTenantPatternLearningOptIn: false,
    allowedExternalProviders: ["fireworks"],
  },
  gdpr: {
    sharedCatalogOptIn: false,
  },
});

export function applyPackForcedDefaults(
  settings: TenantAiSettings,
  activePackIds: readonly string[],
): TenantAiSettings {
  let result = { ...settings };
  for (const packId of activePackIds) {
    const forced = PACK_FORCED_DEFAULTS[packId];
    if (forced === undefined) continue;
    result = { ...result, ...forced };
  }
  return TenantAiSettingsSchema.parse(result);
}

export interface SettingChangeAttempt {
  readonly settings: TenantAiSettings;
  readonly activePackIds: readonly string[];
  readonly proposed: Partial<TenantAiSettings>;
}

export function validateSettingChange(
  attempt: SettingChangeAttempt,
): { readonly allowed: boolean; readonly reason?: string } {
  for (const packId of attempt.activePackIds) {
    const forced = PACK_FORCED_DEFAULTS[packId];
    if (forced === undefined) continue;
    for (const [key, value] of Object.entries(forced)) {
      if (key in attempt.proposed) {
        const proposedValue = attempt.proposed[key as keyof TenantAiSettings];
        if (JSON.stringify(proposedValue) !== JSON.stringify(value)) {
          return {
            allowed: false,
            reason: `'${key}' is pinned to ${JSON.stringify(value)} by pack '${packId}'`,
          };
        }
      }
    }
  }
  return { allowed: true };
}
