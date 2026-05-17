import { z } from "zod";

export const CERTIFICATION_STANDARDS = [
  "soc2_type_i",
  "soc2_type_ii",
  "iso_27001",
  "iso_27017",
  "iso_27018",
  "hitrust_csf_v11",
  "hitrust_r2",
  "pci_dss",
  "uae_pdpl",
] as const;
export type CertificationStandard = (typeof CERTIFICATION_STANDARDS)[number];

export const CERTIFICATION_STATUSES = [
  "not_started",
  "readiness_assessment",
  "evidence_collection",
  "audit_in_progress",
  "certified",
  "maintenance",
  "lapsed",
] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];

export const CertificationTargetSchema = z.object({
  standard: z.enum(CERTIFICATION_STANDARDS),
  status: z.enum(CERTIFICATION_STATUSES),
  targetCertificationDate: z.string().datetime({ offset: true }).optional(),
  certifiedAt: z.string().datetime({ offset: true }).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  auditor: z.string().min(1).optional(),
  scopeNotes: z.string().optional(),
});
export type CertificationTarget = z.infer<typeof CertificationTargetSchema>;

export const CertificationRoadmapSchema = z
  .array(CertificationTargetSchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<CertificationStandard>();
    entries.forEach((e, i) => {
      if (seen.has(e.standard)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "standard"],
          message: `duplicate roadmap entry for '${e.standard}'`,
        });
      }
      seen.add(e.standard);
      if (e.status === "certified" && e.certifiedAt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "certifiedAt"],
          message: `entry with status 'certified' must declare certifiedAt`,
        });
      }
    });
  });
export type CertificationRoadmap = z.infer<typeof CertificationRoadmapSchema>;
