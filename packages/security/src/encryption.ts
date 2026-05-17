import { z } from "zod";
import { DATA_CLASSES } from "@crossengin/jobs";

export const AT_REST_ALGORITHMS = ["aes-256", "aes-256-gcm", "chacha20-poly1305"] as const;
export type AtRestAlgorithm = (typeof AT_REST_ALGORITHMS)[number];

export const KEY_MANAGEMENT_KINDS = [
  "supabase-vault",
  "aws-kms",
  "azure-key-vault",
  "gcp-kms",
  "hashicorp-vault",
  "customer-managed-byok",
] as const;
export type KeyManagementKind = (typeof KEY_MANAGEMENT_KINDS)[number];

export const TLS_VERSIONS = ["1.2", "1.3"] as const;
export type TlsVersion = (typeof TLS_VERSIONS)[number];

export const EncryptionProfileSchema = z.object({
  appliesTo: z.array(z.enum(DATA_CLASSES)).min(1),
  atRest: z.object({
    algorithm: z.enum(AT_REST_ALGORITHMS),
    keyManagement: z.enum(KEY_MANAGEMENT_KINDS),
    byokRequired: z.boolean().default(false),
  }),
  inTransit: z.object({
    minVersion: z.enum(TLS_VERSIONS).default("1.3"),
    requireHsts: z.boolean().default(true),
    certificatePinning: z.boolean().default(false),
  }),
});
export type EncryptionProfile = z.infer<typeof EncryptionProfileSchema>;

const DURATION_REGEX = /^(\d+)(d|w|m|y)$/;

export const RotationCadenceSchema = z.string().regex(DURATION_REGEX, {
  message: "rotation cadence must be '<n><d|w|m|y>' (e.g., '90d', '12m')",
});
export type RotationCadence = z.infer<typeof RotationCadenceSchema>;

export const SECRET_KINDS = [
  "jwt_signing",
  "nextauth_secret",
  "stripe_key",
  "fireworks_api_key",
  "anthropic_api_key",
  "manifest_signing",
  "tenant_integration",
  "cdn_signing",
  "bge_proxy_token",
] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const KeyRotationPolicyEntrySchema = z
  .object({
    secretKind: z.enum(SECRET_KINDS),
    cadence: RotationCadenceSchema,
    overlapWindow: RotationCadenceSchema.optional(),
    triggerOnPersonnelChange: z.boolean().default(false),
    notes: z.string().optional(),
  })
  .refine(
    (v) => {
      if (v.overlapWindow === undefined) return true;
      return cadenceToDays(v.overlapWindow) <= cadenceToDays(v.cadence);
    },
    { message: "overlapWindow must be <= cadence" },
  );
export type KeyRotationPolicyEntry = z.infer<typeof KeyRotationPolicyEntrySchema>;

export const KeyRotationPolicySchema = z
  .array(KeyRotationPolicyEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<SecretKind>();
    entries.forEach((e, i) => {
      if (seen.has(e.secretKind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "secretKind"],
          message: `duplicate entry for secret '${e.secretKind}'`,
        });
      }
      seen.add(e.secretKind);
    });
  });
export type KeyRotationPolicy = z.infer<typeof KeyRotationPolicySchema>;

export function cadenceToDays(cadence: RotationCadence): number {
  const match = cadence.match(DURATION_REGEX);
  if (!match) throw new Error(`invalid cadence: ${cadence}`);
  const n = Number(match[1]);
  switch (match[2]) {
    case "d":
      return n;
    case "w":
      return n * 7;
    case "m":
      return n * 30;
    case "y":
      return n * 365;
    default:
      throw new Error(`unreachable: ${match[2]}`);
  }
}

export interface RotationReminder {
  readonly secretKind: SecretKind;
  readonly daysSinceLastRotation: number;
  readonly cadenceDays: number;
  readonly daysUntilRotation: number;
  readonly overdue: boolean;
}

export function rotationReminder(
  entry: KeyRotationPolicyEntry,
  lastRotatedAt: Date,
  now: Date = new Date(),
): RotationReminder {
  const elapsedMs = now.getTime() - lastRotatedAt.getTime();
  const daysSinceLastRotation = Math.floor(elapsedMs / 86_400_000);
  const cadenceDays = cadenceToDays(entry.cadence);
  const daysUntilRotation = cadenceDays - daysSinceLastRotation;
  return {
    secretKind: entry.secretKind,
    daysSinceLastRotation,
    cadenceDays,
    daysUntilRotation,
    overdue: daysUntilRotation < 0,
  };
}
