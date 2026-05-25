import { z } from "zod";
import { Iso4217CurrencySchema } from "@crossengin/i18n";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);
const STRIPE_PM_REGEX = /^pm_[A-Za-z0-9]+$/;

export const PAYMENT_METHOD_KINDS = [
  "card",
  "ach",
  "sepa_debit",
  "apple_pay",
  "google_pay",
  "bank_transfer",
  "wire",
  "mada",
  "knet",
] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export const CARD_BRANDS = [
  "visa",
  "mastercard",
  "amex",
  "discover",
  "jcb",
  "diners",
  "unionpay",
  "unknown",
] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

export const PaymentMethodSchema = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    kind: z.enum(PAYMENT_METHOD_KINDS),
    stripePaymentMethodId: z.string().regex(STRIPE_PM_REGEX),
    isDefault: z.boolean().default(false),
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    brand: z.enum(CARD_BRANDS).optional(),
    expMonth: z.number().int().min(1).max(12).optional(),
    expYear: z.number().int().min(2024).max(2100).optional(),
    billingAddressCountry: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    createdAt: Iso8601,
    deletedAt: Iso8601.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "card") {
      if (
        v.last4 === undefined ||
        v.brand === undefined ||
        v.expMonth === undefined ||
        v.expYear === undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kind"],
          message: "card payment methods must declare last4, brand, expMonth, expYear",
        });
      }
    }
  });
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export function isCardExpired(method: PaymentMethod, now: Date = new Date()): boolean {
  if (method.kind !== "card") return false;
  if (method.expMonth === undefined || method.expYear === undefined) return false;
  const expiryEnd = new Date(Date.UTC(method.expYear, method.expMonth, 1));
  return now >= expiryEnd;
}

export const REFUND_REASONS = [
  "duplicate",
  "fraudulent",
  "requested_by_customer",
  "service_disruption",
  "sla_breach",
  "billing_error",
  "other",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_STATUSES = ["pending", "succeeded", "failed", "canceled"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const RefundSchema = z.object({
  id: Uuid,
  tenantId: Uuid,
  invoiceId: Uuid,
  amountCents: z.number().int().positive(),
  currency: Iso4217CurrencySchema,
  reason: z.enum(REFUND_REASONS),
  notes: z.string().optional(),
  status: z.enum(REFUND_STATUSES),
  issuedBy: Uuid,
  issuedAt: Iso8601,
  succeededAt: Iso8601.nullable().default(null),
  stripeRefundId: z
    .string()
    .regex(/^re_[A-Za-z0-9]+$/)
    .nullable()
    .default(null),
});
export type Refund = z.infer<typeof RefundSchema>;

export const CREDIT_KINDS = [
  "sla_credit",
  "goodwill",
  "promotional",
  "migration_assist",
  "manual_adjustment",
] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

export const TenantCreditSchema = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    amountCents: z.number().int().positive(),
    remainingCents: z.number().int().nonnegative(),
    currency: Iso4217CurrencySchema,
    kind: z.enum(CREDIT_KINDS),
    reason: z.string().min(1),
    expiresAt: Iso8601.nullable().default(null),
    issuedBy: Uuid,
    issuedAt: Iso8601,
    appliedToInvoiceIds: z.array(Uuid).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.remainingCents > v.amountCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remainingCents"],
        message: "remainingCents cannot exceed amountCents",
      });
    }
  });
export type TenantCredit = z.infer<typeof TenantCreditSchema>;

export function applyCredit(
  credit: TenantCredit,
  invoiceAmountCents: number,
): { readonly applyCents: number; readonly remainingAfter: number } {
  if (invoiceAmountCents <= 0) {
    return { applyCents: 0, remainingAfter: credit.remainingCents };
  }
  const applyCents = Math.min(credit.remainingCents, invoiceAmountCents);
  return { applyCents, remainingAfter: credit.remainingCents - applyCents };
}
