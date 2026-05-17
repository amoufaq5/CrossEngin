import { z } from "zod";
import { CurrencyCodeSchema } from "./attribution.js";

const Iso8601 = z.string().datetime({ offset: true });
const COST_CENTER_REGEX = /^cc-\d{4}$/;
const BU_REGEX = /^[a-z][a-z0-9-]*$/;

export const COST_CENTER_KINDS = [
  "engineering",
  "product",
  "sales_revenue",
  "shared_infrastructure",
  "customer_support",
  "compliance",
  "research",
] as const;
export type CostCenterKind = (typeof COST_CENTER_KINDS)[number];
export const CostCenterKindSchema = z.enum(COST_CENTER_KINDS);

export const CostCenterSchema = z
  .object({
    id: z.string().regex(COST_CENTER_REGEX, {
      message: "cost center id must be 'cc-NNNN'",
    }),
    label: z.string().min(1),
    kind: CostCenterKindSchema,
    parentCostCenterId: z.string().regex(COST_CENTER_REGEX).nullable().default(null),
    businessUnit: z.string().regex(BU_REGEX),
    owner: z.string().min(1),
    createdAt: Iso8601,
    archivedAt: Iso8601.nullable().default(null),
    archivedReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.parentCostCenterId === v.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentCostCenterId"],
        message: "cost center cannot parent itself",
      });
    }
    if (v.archivedAt !== null && v.archivedReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archivedReason"],
        message: "archivedAt requires archivedReason",
      });
    }
  });
export type CostCenter = z.infer<typeof CostCenterSchema>;

export const ChargebackLineSchema = z
  .object({
    costCenterId: z.string().regex(COST_CENTER_REGEX),
    amountCents: z.number().int().nonnegative(),
    percentOfTotal: z.number().min(0).max(100),
    description: z.string().min(1),
  })
  .strict();
export type ChargebackLine = z.infer<typeof ChargebackLineSchema>;

export const ChargebackStatementSchema = z
  .object({
    id: z.string().min(1),
    periodStart: Iso8601,
    periodEnd: Iso8601,
    currency: CurrencyCodeSchema,
    totalAmountCents: z.number().int().nonnegative(),
    lines: z.array(ChargebackLineSchema).min(1),
    generatedAt: Iso8601,
    generatedBy: z.string().min(1),
    approvedAt: Iso8601.nullable().default(null),
    approvedBy: z.string().min(1).nullable().default(null),
    status: z.enum(["draft", "pending_approval", "approved", "posted", "voided"]),
    voidedReason: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (new Date(v.periodEnd).getTime() <= new Date(v.periodStart).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEnd"],
        message: "periodEnd must be after periodStart",
      });
    }
    const lineSum = v.lines.reduce((acc, l) => acc + l.amountCents, 0);
    if (lineSum !== v.totalAmountCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalAmountCents"],
        message: `lines sum ${lineSum.toString()} must equal totalAmountCents ${v.totalAmountCents.toString()}`,
      });
    }
    const percentSum = v.lines.reduce((acc, l) => acc + l.percentOfTotal, 0);
    if (Math.abs(percentSum - 100) > 0.5 && v.totalAmountCents > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lines"],
        message: `percentOfTotal sum ${percentSum.toString()} must be ~100 (got ${Math.abs(percentSum - 100).toString()} delta)`,
      });
    }
    const ccs = new Set<string>();
    v.lines.forEach((l, i) => {
      if (ccs.has(l.costCenterId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines", i, "costCenterId"],
          message: `duplicate cost center '${l.costCenterId}'`,
        });
      }
      ccs.add(l.costCenterId);
    });
    if (
      (v.status === "approved" || v.status === "posted") &&
      (v.approvedAt === null || v.approvedBy === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedBy"],
        message: `status '${v.status}' requires approvedAt + approvedBy`,
      });
    }
    if (v.status === "voided" && v.voidedReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["voidedReason"],
        message: "voided status requires voidedReason",
      });
    }
  });
export type ChargebackStatement = z.infer<typeof ChargebackStatementSchema>;

export function linesByCostCenter(
  statement: ChargebackStatement,
): Readonly<Record<string, ChargebackLine>> {
  const out: Record<string, ChargebackLine> = {};
  for (const line of statement.lines) out[line.costCenterId] = line;
  return out;
}

export function isStatementPosted(statement: ChargebackStatement): boolean {
  return statement.status === "posted";
}

export function isCostCenterActive(center: CostCenter): boolean {
  return center.archivedAt === null;
}
