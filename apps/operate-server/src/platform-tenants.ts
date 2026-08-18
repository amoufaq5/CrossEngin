import { z } from "zod";

export const TENANT_STATUSES = ["active", "suspended", "archived", "deleted"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const TENANT_TIERS = ["small", "enterprise", "regulated", "on-prem"] as const;
export type TenantTier = (typeof TENANT_TIERS)[number];

export const TENANT_REGIONS = ["eu", "us", "me", "ap", "sa"] as const;
export type TenantRegion = (typeof TENANT_REGIONS)[number];

export const TENANT_SEARCH_LOCALES = [
  "simple",
  "english",
  "french",
  "spanish",
  "arabic",
  "german",
  "portuguese",
] as const;
export type TenantSearchLocale = (typeof TENANT_SEARCH_LOCALES)[number];

export const TenantRecordSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(TENANT_STATUSES),
    tier: z.enum(TENANT_TIERS),
    region: z.enum(TENANT_REGIONS),
    schemaName: z.string().min(1),
    searchLocale: z.enum(TENANT_SEARCH_LOCALES),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type TenantRecord = z.infer<typeof TenantRecordSchema>;

/**
 * Console-driven status transitions. `deleted` is deliberately unreachable here —
 * tenant deletion is the GDPR Article 17 flow in `tenant-lifecycle`, not a console
 * button — so every set excludes it and no set targets it.
 */
export const TENANT_STATUS_TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantStatus[]>> = {
  active: ["suspended", "archived"],
  suspended: ["active", "archived"],
  archived: [],
  deleted: [],
};

export function canTransitionTenant(from: TenantStatus, to: TenantStatus): boolean {
  return TENANT_STATUS_TRANSITIONS[from].includes(to);
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;

export const CreateTenantInputSchema = z
  .object({
    slug: z.string().regex(SLUG_RE),
    name: z.string().min(1),
    tier: z.enum(TENANT_TIERS).default("small"),
    region: z.enum(TENANT_REGIONS).default("eu"),
    searchLocale: z.enum(TENANT_SEARCH_LOCALES).default("simple"),
    schemaName: z.string().min(1).optional(),
  })
  .strict();

export type CreateTenantInput = z.infer<typeof CreateTenantInputSchema>;

const SCHEMA_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Derives a valid Postgres identifier from a slug when `schemaName` is omitted:
 * lowercase, every non-`[a-z0-9_]` char folded to `_`, then a `t_` prefix so the
 * result always starts with a letter and matches `SCHEMA_IDENTIFIER_RE`.
 */
export function deriveSchemaName(slug: string): string {
  const cleaned = slug.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const name = `t_${cleaned}`;
  if (!SCHEMA_IDENTIFIER_RE.test(name)) {
    throw new Error(`cannot derive a valid schema name from slug: ${JSON.stringify(slug)}`);
  }
  return name;
}
