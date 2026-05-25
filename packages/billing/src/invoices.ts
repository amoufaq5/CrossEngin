import { z } from "zod";
import { Iso4217CurrencySchema } from "@crossengin/i18n";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);
const STRIPE_INVOICE_REGEX = /^in_[A-Za-z0-9]+$/;
const INVOICE_NUMBER_REGEX = /^[A-Z0-9][A-Z0-9-]{0,31}$/;

export const InvoiceNumberSchema = z.string().regex(INVOICE_NUMBER_REGEX, {
  message: "invoice number must be uppercase alphanumerics + dashes",
});

export const INVOICE_STATUSES = [
  "draft",
  "open",
  "paid",
  "uncollectible",
  "void",
  "refunded",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_LINE_KINDS = [
  "subscription_base",
  "usage_overage",
  "credit",
  "tax",
  "discount",
  "one_time",
  "proration_credit",
  "proration_charge",
] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export const InvoiceLineItemSchema = z.object({
  id: Uuid,
  kind: z.enum(INVOICE_LINE_KINDS),
  description: z.string().min(1),
  quantity: z.number().nonnegative(),
  unitAmountCents: z.number().int(),
  amountCents: z.number().int(),
  currency: Iso4217CurrencySchema,
  periodStart: Iso8601.optional(),
  periodEnd: Iso8601.optional(),
  meter: z.string().min(1).optional(),
});
export type InvoiceLineItem = z.infer<typeof InvoiceLineItemSchema>;

export const InvoiceSchema = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    subscriptionId: Uuid,
    number: InvoiceNumberSchema,
    stripeInvoiceId: z.string().regex(STRIPE_INVOICE_REGEX).nullable().default(null),
    status: z.enum(INVOICE_STATUSES),
    currency: Iso4217CurrencySchema,
    subtotalCents: z.number().int(),
    taxCents: z.number().int().nonnegative(),
    discountCents: z.number().int().nonnegative().default(0),
    totalCents: z.number().int(),
    amountPaidCents: z.number().int().nonnegative().default(0),
    amountRemainingCents: z.number().int().nonnegative(),
    issuedAt: Iso8601,
    dueAt: Iso8601,
    paidAt: Iso8601.nullable().default(null),
    voidedAt: Iso8601.nullable().default(null),
    periodStart: Iso8601,
    periodEnd: Iso8601,
    lineItems: z.array(InvoiceLineItemSchema).min(1),
    pdfUrl: z.string().url().nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (new Date(v.dueAt) < new Date(v.issuedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dueAt"],
        message: "dueAt must be >= issuedAt",
      });
    }
    if (v.status === "paid" && v.paidAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paidAt"],
        message: "paid invoices must declare paidAt",
      });
    }
    if (v.status === "paid" && v.amountRemainingCents !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountRemainingCents"],
        message: "paid invoices must have amountRemainingCents = 0",
      });
    }
    if (v.status === "void" && v.voidedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["voidedAt"],
        message: "void invoices must declare voidedAt",
      });
    }
    for (const line of v.lineItems) {
      if (line.currency !== v.currency) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lineItems"],
          message: `line item currency '${line.currency}' does not match invoice currency '${v.currency}'`,
        });
        break;
      }
    }
  });
export type Invoice = z.infer<typeof InvoiceSchema>;

export interface InvoiceTotals {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
}

export function computeInvoiceTotals(lineItems: readonly InvoiceLineItem[]): InvoiceTotals {
  let subtotal = 0;
  let tax = 0;
  let discount = 0;
  for (const line of lineItems) {
    if (line.kind === "tax") {
      tax += line.amountCents;
    } else if (line.kind === "discount" || line.kind === "credit") {
      discount += Math.abs(line.amountCents);
    } else {
      subtotal += line.amountCents;
    }
  }
  return {
    subtotalCents: subtotal,
    taxCents: tax,
    discountCents: discount,
    totalCents: subtotal + tax - discount,
  };
}

export function isInvoiceOverdue(invoice: Invoice, now: Date = new Date()): boolean {
  if (invoice.status === "paid" || invoice.status === "void") return false;
  return now.getTime() > new Date(invoice.dueAt).getTime();
}
