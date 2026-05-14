import { z } from "zod";

export const FIXTURE_KINDS = [
  "tenant_manifest",
  "synthetic_records",
  "ai_architect_conversation",
  "compliance_pack_compliant",
  "compliance_pack_violation",
  "integration_payload",
  "ocr_document",
  "redteam_attack",
] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export const FIXTURE_VERTICALS = [
  "pharmacy",
  "hospital",
  "procurement",
  "construction",
  "education",
  "ngo",
  "generic",
] as const;
export type FixtureVertical = (typeof FIXTURE_VERTICALS)[number];

export const FixtureDeclarationSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    kind: z.enum(FIXTURE_KINDS),
    vertical: z.enum(FIXTURE_VERTICALS),
    description: z.string().min(1),
    path: z.string().min(1),
    generator: z.string().min(1).optional(),
    phiFree: z.boolean(),
    citationsRequired: z.array(z.string().min(1)).default([]),
    appliesToPackId: z.string().min(1).optional(),
    consentBound: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (!v.phiFree) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phiFree"],
        message: "fixtures must be PHI-free (no real production data)",
      });
    }
    if (v.kind === "compliance_pack_compliant" || v.kind === "compliance_pack_violation") {
      if (v.appliesToPackId === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appliesToPackId"],
          message: `kind '${v.kind}' requires appliesToPackId`,
        });
      }
    }
  });
export type FixtureDeclaration = z.infer<typeof FixtureDeclarationSchema>;

export const FixtureRegistrySchema = z
  .array(FixtureDeclarationSchema)
  .superRefine((entries, ctx) => {
    const ids = new Set<string>();
    entries.forEach((e, i) => {
      if (ids.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate fixture id '${e.id}'`,
        });
      }
      ids.add(e.id);
    });
  });
export type FixtureRegistry = z.infer<typeof FixtureRegistrySchema>;

export function fixturesByKind(
  registry: FixtureRegistry,
  kind: FixtureKind,
): readonly FixtureDeclaration[] {
  return registry.filter((f) => f.kind === kind);
}

export function fixturesByVertical(
  registry: FixtureRegistry,
  vertical: FixtureVertical,
): readonly FixtureDeclaration[] {
  return registry.filter((f) => f.vertical === vertical);
}

export function fixturesForPack(
  registry: FixtureRegistry,
  packId: string,
): readonly FixtureDeclaration[] {
  return registry.filter((f) => f.appliesToPackId === packId);
}

export const PHI_HEURISTIC_REGEX = /\b(\d{3}-\d{2}-\d{4}|[A-Z][a-z]+ [A-Z]\.? [A-Z][a-z]+ DOB)\b/;

export function containsLikelyPhi(text: string): boolean {
  return PHI_HEURISTIC_REGEX.test(text);
}
