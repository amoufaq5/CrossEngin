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
  })
  .strict();

export type OperationalDefaults = z.infer<typeof OperationalDefaultsSchema>;

export const TenantSettingsSchema = z
  .object({
    company: CompanyProfileSchema.optional(),
    defaults: OperationalDefaultsSchema.optional(),
    /** Keyed by sequence name (matches a field's `default.sequence`). */
    numbering: z.record(z.string().min(1), NumberingOverrideSchema).optional(),
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
