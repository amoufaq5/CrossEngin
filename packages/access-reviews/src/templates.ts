import { z } from "zod";
import { CampaignScopeSchema } from "./scope.js";
import {
  AUTO_REVOKE_POLICIES,
  CAMPAIGN_FREQUENCIES,
  COMPLIANCE_FRAMEWORKS,
  ReviewerAssignmentSchema,
} from "./campaigns.js";

export const TEMPLATE_LIFECYCLE_STATUSES = ["draft", "published", "deprecated", "retired"] as const;
export type TemplateLifecycleStatus = (typeof TEMPLATE_LIFECYCLE_STATUSES)[number];

export const TEMPLATE_TRANSITIONS: Readonly<
  Record<TemplateLifecycleStatus, readonly TemplateLifecycleStatus[]>
> = {
  draft: ["published", "retired"],
  published: ["deprecated", "retired"],
  deprecated: ["retired"],
  retired: [],
};

export const canTransitionTemplate = (
  from: TemplateLifecycleStatus,
  to: TemplateLifecycleStatus,
): boolean => TEMPLATE_TRANSITIONS[from].includes(to);

export const AccessReviewTemplateSchema = z
  .object({
    id: z.string().regex(/^art_[a-z0-9]{8,32}$/),
    tenantId: z.string().uuid().nullable(),
    templateKey: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .max(120),
    label: z.string().min(1).max(200),
    description: z.string().max(2000),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    status: z.enum(TEMPLATE_LIFECYCLE_STATUSES),
    framework: z.enum(COMPLIANCE_FRAMEWORKS),
    defaultFrequency: z.enum(CAMPAIGN_FREQUENCIES),
    defaultScope: CampaignScopeSchema,
    defaultReviewerAssignment: ReviewerAssignmentSchema,
    defaultAutoRevokePolicy: z.enum(AUTO_REVOKE_POLICIES),
    defaultDeadlineDaysFromStart: z.number().int().min(1).max(180),
    defaultGracePeriodHours: z.number().int().min(0).max(720),
    defaultRemediationDaysFromCompletion: z.number().int().min(0).max(180).nullable(),
    documentationUrl: z.string().url().nullable(),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    publishedBy: z.string().uuid().nullable(),
    deprecatedAt: z.string().datetime({ offset: true }).nullable(),
    supersededByTemplateKey: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z.string().uuid(),
  })
  .superRefine((t, ctx) => {
    if (t.status === "published") {
      if (t.publishedAt === null || t.publishedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedAt"],
          message: "published template requires publishedAt + publishedBy",
        });
      }
      if (t.publishedBy === t.createdBy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["publishedBy"],
          message: "four-eyes: publishedBy must differ from createdBy",
        });
      }
    }
    if (t.status === "deprecated" && t.deprecatedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deprecatedAt"],
        message: "deprecated template requires deprecatedAt",
      });
    }
    if (t.framework === ("sox_quarterly" as never) && t.defaultFrequency !== "sox_quarterly") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultFrequency"],
        message: "SOX framework template requires sox_quarterly frequency",
      });
    }
    if (
      t.framework === "soc2_type2" &&
      t.defaultFrequency !== "quarterly" &&
      t.defaultFrequency !== "annual"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultFrequency"],
        message: "SOC 2 Type 2 framework defaults to quarterly or annual cadence",
      });
    }
    if (
      t.framework === "hipaa_security_rule" &&
      t.defaultFrequency !== "semi_annual" &&
      t.defaultFrequency !== "annual"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultFrequency"],
        message: "HIPAA Security Rule framework requires semi_annual or annual workforce reviews",
      });
    }
  });
export type AccessReviewTemplate = z.infer<typeof AccessReviewTemplateSchema>;

export interface BuiltinTemplateSeed {
  readonly templateKey: string;
  readonly label: string;
  readonly framework:
    | "soc2_type2"
    | "iso27001"
    | "hipaa_security_rule"
    | "pci_dss_v4"
    | "gdpr_article_32"
    | "cfr_21_part_11";
  readonly defaultFrequency: "monthly" | "quarterly" | "semi_annual" | "annual" | "sox_quarterly";
  readonly defaultDeadlineDaysFromStart: number;
}

export const BUILTIN_TEMPLATE_SEEDS: readonly BuiltinTemplateSeed[] = [
  {
    templateKey: "soc2.quarterly.privileged_access",
    label: "SOC 2 Quarterly Privileged Access Review",
    framework: "soc2_type2",
    defaultFrequency: "quarterly",
    defaultDeadlineDaysFromStart: 30,
  },
  {
    templateKey: "soc2.annual.full_workforce",
    label: "SOC 2 Annual Workforce Access Review",
    framework: "soc2_type2",
    defaultFrequency: "annual",
    defaultDeadlineDaysFromStart: 60,
  },
  {
    templateKey: "iso27001.a9.2.5.annual",
    label: "ISO 27001 A.9.2.5 Annual Access Rights Review",
    framework: "iso27001",
    defaultFrequency: "annual",
    defaultDeadlineDaysFromStart: 60,
  },
  {
    templateKey: "hipaa.workforce.semi_annual",
    label: "HIPAA §164.308(a)(4) Semi-Annual Workforce Access Review",
    framework: "hipaa_security_rule",
    defaultFrequency: "semi_annual",
    defaultDeadlineDaysFromStart: 45,
  },
  {
    templateKey: "pci.dss.v4.req7.quarterly",
    label: "PCI DSS v4 Req 7 Quarterly Access Review",
    framework: "pci_dss_v4",
    defaultFrequency: "quarterly",
    defaultDeadlineDaysFromStart: 30,
  },
  {
    templateKey: "cfr21_part11.quarterly.signature_holders",
    label: "21 CFR Part 11 Quarterly E-Signature Holder Review",
    framework: "cfr_21_part_11",
    defaultFrequency: "quarterly",
    defaultDeadlineDaysFromStart: 30,
  },
  {
    templateKey: "gdpr.article32.annual.data_access",
    label: "GDPR Article 32 Annual Data Access Review",
    framework: "gdpr_article_32",
    defaultFrequency: "annual",
    defaultDeadlineDaysFromStart: 60,
  },
] as const;

export const findBuiltinSeed = (templateKey: string): BuiltinTemplateSeed | null =>
  BUILTIN_TEMPLATE_SEEDS.find((s) => s.templateKey === templateKey) ?? null;

export const isTemplateUsable = (template: AccessReviewTemplate, now: Date): boolean => {
  if (template.status === "retired") return false;
  if (template.status === "draft") return false;
  if (template.status === "deprecated") {
    if (template.deprecatedAt === null) return true;
    const elapsedDays = (now.getTime() - Date.parse(template.deprecatedAt)) / 86_400_000;
    return elapsedDays < 180;
  }
  return true;
};
