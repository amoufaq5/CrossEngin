import { z } from "zod";
import { CostCategorySchema, type CostCategory } from "./categories.js";
import { CurrencyCodeSchema } from "./attribution.js";

const Iso8601 = z.string().datetime({ offset: true });

export const REPORT_KINDS = [
  "tenant_invoice_attachment",
  "executive_summary",
  "cost_center_chargeback",
  "anomaly_alert",
  "weekly_review",
  "monthly_close",
  "annual_review",
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const ReportKindSchema = z.enum(REPORT_KINDS);

export const REPORT_FORMATS = ["json", "pdf", "csv", "html"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const CategoryBreakdownSchema = z.object({
  category: CostCategorySchema,
  costCents: z.number().int().nonnegative(),
  percentOfTotal: z.number().min(0).max(100),
  changeVsPriorPeriodPercent: z.number().optional(),
});
export type CategoryBreakdown = z.infer<typeof CategoryBreakdownSchema>;

export const TopSpenderSchema = z.object({
  tenantId: z.string().min(1),
  costCents: z.number().int().nonnegative(),
  rank: z.number().int().positive(),
  percentOfTotal: z.number().min(0).max(100),
});
export type TopSpender = z.infer<typeof TopSpenderSchema>;

export const ANOMALY_KINDS = [
  "category_spike",
  "tenant_spike",
  "budget_breach",
  "thin_margin",
  "negative_margin",
  "provider_outage_cost",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export const AnomalySchema = z
  .object({
    kind: z.enum(ANOMALY_KINDS),
    description: z.string().min(1),
    severity: z.enum(["info", "warning", "critical"]),
    affectedCategory: CostCategorySchema.optional(),
    affectedTenantId: z.string().min(1).optional(),
    impactCents: z.number().int().nonnegative(),
    detectedAt: Iso8601,
  })
  .superRefine((v, ctx) => {
    if (v.kind === "category_spike" && v.affectedCategory === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["affectedCategory"],
        message: "category_spike requires affectedCategory",
      });
    }
    if (
      (v.kind === "tenant_spike" || v.kind === "thin_margin" || v.kind === "negative_margin") &&
      v.affectedTenantId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["affectedTenantId"],
        message: `kind '${v.kind}' requires affectedTenantId`,
      });
    }
  });
export type Anomaly = z.infer<typeof AnomalySchema>;

export const CostReportSchema = z
  .object({
    id: z.string().min(1),
    kind: ReportKindSchema,
    format: z.enum(REPORT_FORMATS),
    periodStart: Iso8601,
    periodEnd: Iso8601,
    currency: CurrencyCodeSchema,
    totalCostCents: z.number().int().nonnegative(),
    priorPeriodTotalCents: z.number().int().nonnegative().nullable().default(null),
    breakdown: z.array(CategoryBreakdownSchema).min(1),
    topSpenders: z.array(TopSpenderSchema).max(50).default([]),
    anomalies: z.array(AnomalySchema).default([]),
    tenantScope: z.string().min(1).nullable().default(null),
    generatedAt: Iso8601,
    generatedBy: z.string().min(1),
    storageUri: z.string().url().optional(),
    storageSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (new Date(v.periodEnd).getTime() <= new Date(v.periodStart).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEnd"],
        message: "periodEnd must be after periodStart",
      });
    }
    const breakdownSum = v.breakdown.reduce((acc, b) => acc + b.costCents, 0);
    if (breakdownSum !== v.totalCostCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalCostCents"],
        message: `breakdown sum ${breakdownSum.toString()} must equal totalCostCents ${v.totalCostCents.toString()}`,
      });
    }
    const categoriesSeen = new Set<CostCategory>();
    v.breakdown.forEach((b, i) => {
      if (categoriesSeen.has(b.category)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["breakdown", i, "category"],
          message: `duplicate category '${b.category}'`,
        });
      }
      categoriesSeen.add(b.category);
    });
    if (v.kind === "tenant_invoice_attachment" && v.tenantScope === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tenantScope"],
        message: "tenant_invoice_attachment requires tenantScope",
      });
    }
    const ranksSeen = new Set<number>();
    v.topSpenders.forEach((s, i) => {
      if (ranksSeen.has(s.rank)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["topSpenders", i, "rank"],
          message: `duplicate rank ${s.rank.toString()}`,
        });
      }
      ranksSeen.add(s.rank);
    });
    for (let i = 1; i < v.topSpenders.length; i++) {
      const prev = v.topSpenders[i - 1]!;
      const curr = v.topSpenders[i]!;
      if (curr.costCents > prev.costCents) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["topSpenders", i],
          message: "topSpenders must be sorted descending by costCents",
        });
      }
    }
  });
export type CostReport = z.infer<typeof CostReportSchema>;

export function spendDeltaPercent(report: CostReport): number | null {
  if (report.priorPeriodTotalCents === null || report.priorPeriodTotalCents === 0) {
    return null;
  }
  const delta = report.totalCostCents - report.priorPeriodTotalCents;
  return Math.round((delta / report.priorPeriodTotalCents) * 1000) / 10;
}

export function criticalAnomalies(report: CostReport): readonly Anomaly[] {
  return report.anomalies.filter((a) => a.severity === "critical");
}

export function reportRequiresStorageRef(kind: ReportKind): boolean {
  return (
    kind === "monthly_close" || kind === "annual_review" || kind === "tenant_invoice_attachment"
  );
}
