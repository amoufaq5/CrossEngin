import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });

export const TRAINING_PURPOSES = [
  "global_model_improvement",
  "tenant_specific_finetune",
  "shared_catalog_patterns",
  "redteam_evaluation",
  "benchmarking_only",
] as const;
export type TrainingPurpose = (typeof TRAINING_PURPOSES)[number];
export const TrainingPurposeSchema = z.enum(TRAINING_PURPOSES);

export const DATA_CLASSES = [
  "public",
  "internal",
  "commercial_sensitive",
  "pii",
  "phi",
  "regulated",
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export const DataClassSchema = z.enum(DATA_CLASSES);

export const FORBIDDEN_TRAINING_DATA_CLASSES: ReadonlySet<DataClass> = new Set([
  "phi",
  "regulated",
]);

export const CONSENT_STATUSES = ["active", "withdrawn", "expired", "superseded"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const TrainingConsentSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    purpose: TrainingPurposeSchema,
    allowedDataClasses: z.array(DataClassSchema).min(1),
    redactPii: z.boolean().default(true),
    minimumKAnonymity: z.number().int().min(1).max(1000).default(5),
    status: z.enum(CONSENT_STATUSES),
    grantedAt: Iso8601,
    grantedBy: z.string().min(1),
    grantedByRole: z.string().min(1),
    expiresAt: Iso8601.nullable().default(null),
    withdrawnAt: Iso8601.nullable().default(null),
    withdrawnBy: z.string().min(1).nullable().default(null),
    withdrawnReason: z.string().min(1).optional(),
    supersedingConsentId: z.string().min(1).nullable().default(null),
    termsVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    legalBasis: z.enum(["consent", "contract", "legitimate_interest"]),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<DataClass>();
    v.allowedDataClasses.forEach((d, i) => {
      if (seen.has(d)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedDataClasses", i],
          message: `duplicate data class '${d}'`,
        });
      }
      seen.add(d);
      if (FORBIDDEN_TRAINING_DATA_CLASSES.has(d)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedDataClasses", i],
          message: `data class '${d}' can never be used for training (forbidden regardless of consent)`,
        });
      }
    });
    if (v.allowedDataClasses.includes("pii") && !v.redactPii) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redactPii"],
        message: "consent that includes 'pii' must set redactPii=true",
      });
    }
    if (v.status === "withdrawn") {
      if (v.withdrawnAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["withdrawnAt"],
          message: "withdrawn status requires withdrawnAt",
        });
      }
      if (v.withdrawnBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["withdrawnBy"],
          message: "withdrawn status requires withdrawnBy",
        });
      }
      if (v.withdrawnReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["withdrawnReason"],
          message: "withdrawn status requires withdrawnReason",
        });
      }
    }
    if (v.status === "superseded" && v.supersedingConsentId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supersedingConsentId"],
        message: "superseded status requires supersedingConsentId",
      });
    }
    if (
      v.expiresAt !== null &&
      new Date(v.expiresAt).getTime() <= new Date(v.grantedAt).getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after grantedAt",
      });
    }
    if (v.purpose === "tenant_specific_finetune" && v.legalBasis !== "contract") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["legalBasis"],
        message:
          "tenant_specific_finetune requires legalBasis='contract' (signed Master Service Agreement)",
      });
    }
  });
export type TrainingConsent = z.infer<typeof TrainingConsentSchema>;

export function isConsentActive(consent: TrainingConsent, now: Date = new Date()): boolean {
  if (consent.status !== "active") return false;
  if (consent.expiresAt !== null) {
    if (now.getTime() >= new Date(consent.expiresAt).getTime()) return false;
  }
  return true;
}

export function permitsDataClass(consent: TrainingConsent, dataClass: DataClass): boolean {
  if (FORBIDDEN_TRAINING_DATA_CLASSES.has(dataClass)) return false;
  if (!isConsentActive(consent)) return false;
  return consent.allowedDataClasses.includes(dataClass);
}

export function activeConsentsFor(
  consents: readonly TrainingConsent[],
  tenantId: string,
  purpose: TrainingPurpose,
  now: Date = new Date(),
): readonly TrainingConsent[] {
  return consents.filter(
    (c) => c.tenantId === tenantId && c.purpose === purpose && isConsentActive(c, now),
  );
}
