import { z } from "zod";
import { SEQUENCE_RESET_PERIODS, type SequenceDefault } from "@crossengin/types/meta-schema";

/** A per-sequence override an admin can set without redeploying the manifest. */
export const NumberingOverrideSchema = z
  .object({
    format: z.string().min(1).max(120).optional(),
    start: z.number().int().min(0).optional(),
    resetPeriod: z.enum(SEQUENCE_RESET_PERIODS).optional(),
  })
  .strict();

export type NumberingOverride = z.infer<typeof NumberingOverrideSchema>;

export const CompanyProfileSchema = z
  .object({
    name: z.string().max(200).optional(),
    legalName: z.string().max(200).optional(),
    taxId: z.string().max(60).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(40).optional(),
    addressLine1: z.string().max(200).optional(),
    addressLine2: z.string().max(200).optional(),
    city: z.string().max(120).optional(),
    region: z.string().max(120).optional(),
    postalCode: z.string().max(40).optional(),
    country: z.string().max(2).optional(),
  })
  .strict();

export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

export const OperationalDefaultsSchema = z
  .object({
    currency: z.string().length(3).optional(),
    locale: z.string().max(35).optional(),
    timezone: z.string().max(60).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD.MM.YYYY"]).optional(),
    numberFormat: z.enum(["1,234.56", "1.234,56", "1 234,56", "1234.56"]).optional(),
    weekStartDay: z.number().int().min(0).max(6).optional(),
  })
  .strict();

export type OperationalDefaults = z.infer<typeof OperationalDefaultsSchema>;

export const ACCOUNTING_STANDARDS = ["ifrs", "us_gaap", "local_gaap"] as const;
export const ROUNDING_MODES = ["half_up", "half_even", "down", "up"] as const;

/** Finance & tax posture an admin sets per tenant (drives accounting + tax behavior). */
export const FinanceSettingsSchema = z
  .object({
    accountingStandard: z.enum(ACCOUNTING_STANDARDS).optional(),
    multiCurrencyEnabled: z.boolean().optional(),
    pricesIncludeTax: z.boolean().optional(),
    defaultTaxJurisdiction: z.string().max(32).optional(),
    defaultPaymentTermsDays: z.number().int().min(0).max(365).optional(),
    rounding: z.enum(ROUNDING_MODES).optional(),
    /** LedgerAccount.account_code mapped to accounts-receivable (drives the AR↔GL bridge). */
    arAccountCode: z.string().max(32).optional(),
    /** LedgerAccount.account_code mapped to sales revenue (drives the AR↔GL bridge). */
    revenueAccountCode: z.string().max(32).optional(),
    /** LedgerAccount.account_code mapped to accounts-payable (drives the AP↔GL bridge). */
    apAccountCode: z.string().max(32).optional(),
    /** LedgerAccount.account_code mapped to expense (drives the AP↔GL bridge). */
    expenseAccountCode: z.string().max(32).optional(),
    /** LedgerAccount.account_code mapped to cash/bank (drives payment-time GL postings). */
    cashAccountCode: z.string().max(32).optional(),
    /** LedgerAccount.account_code for output (sales) tax payable — the tax line on invoice recognition. */
    taxPayableAccountCode: z.string().max(32).optional(),
    /** LedgerAccount.account_code for input (purchase) tax — the tax line on bill recognition. */
    taxInputAccountCode: z.string().max(32).optional(),
    /** LedgerAccount.account_code for realized FX gain/loss on payment settlement. */
    fxGainLossAccountCode: z.string().max(32).optional(),
    /** LedgerAccount.account_code for unrealized FX gain/loss booked at period close (revaluation). */
    unrealizedFxGainLossAccountCode: z.string().max(32).optional(),
  })
  .strict();

export type FinanceSettings = z.infer<typeof FinanceSettingsSchema>;

export const TenantSettingsSchema = z
  .object({
    company: CompanyProfileSchema.optional(),
    defaults: OperationalDefaultsSchema.optional(),
    finance: FinanceSettingsSchema.optional(),
    /** Keyed by sequence name (matches a field's `default.sequence`). */
    numbering: z.record(z.string().min(1), NumberingOverrideSchema).optional(),
    /** Per-tenant feature toggles, keyed by a stable feature id. */
    features: z.record(z.string().min(1).max(80), z.boolean()).optional(),
  })
  .strict();

export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

export const EMPTY_TENANT_SETTINGS: TenantSettings = {};

/** Persists per-tenant operational settings (singleton document per tenant). */
export interface SettingsStore {
  get(tenantId: string): Promise<TenantSettings>;
  put(tenantId: string, settings: TenantSettings, updatedBy?: string | null): Promise<TenantSettings>;
}

export class InMemorySettingsStore implements SettingsStore {
  private readonly byTenant = new Map<string, TenantSettings>();

  get(tenantId: string): Promise<TenantSettings> {
    return Promise.resolve(this.byTenant.get(tenantId) ?? EMPTY_TENANT_SETTINGS);
  }

  put(tenantId: string, settings: TenantSettings): Promise<TenantSettings> {
    const parsed = TenantSettingsSchema.parse(settings);
    this.byTenant.set(tenantId, parsed);
    return Promise.resolve(parsed);
  }
}

/**
 * Builds the `resolveSpec` callback `applySequenceDefaults` consumes: a sequence's
 * manifest spec, overlaid by any matching `numbering` override from tenant settings.
 */
export function sequenceSpecResolver(
  settings: TenantSettings,
): (spec: SequenceDefault) => SequenceDefault {
  const numbering = settings.numbering ?? {};
  return (spec) => {
    const override = numbering[spec.sequence];
    if (override === undefined) return spec;
    return {
      ...spec,
      ...(override.format !== undefined ? { format: override.format } : {}),
      ...(override.start !== undefined ? { start: override.start } : {}),
      ...(override.resetPeriod !== undefined ? { resetPeriod: override.resetPeriod } : {}),
    };
  };
}
