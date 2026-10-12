import { TENANT_LIFECYCLE_STATES, TENANT_LIFECYCLE_TRANSITIONS } from "@crossengin/tenant-lifecycle";
import { z } from "zod";

/**
 * Re-exported from the contract rather than restated, since ADR-0334. This file used to declare its
 * own four-value enum while `@crossengin/tenant-lifecycle` declared a seven-value one that nothing
 * read — two vocabularies for one concept, where the authoritative-looking one was unreachable and
 * the real one was here. There is one now, and it lives in the contracts package where the layering
 * convention says a state machine belongs.
 */
export const TENANT_STATUSES = TENANT_LIFECYCLE_STATES;
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
  // Neither is a console destination, and for different reasons. `deleted` is the GDPR Article 17
  // flow's terminus (the comment above). `pending_deletion` is reached by *verifying* a deletion
  // request — four-eyes, a named verifier, an Article 12(3) deadline (ADR-0321) — so a console
  // button that set it would be a second path to the same state under weaker controls.
  pending_deletion: [],
  deleted: [],
};

export function canTransitionTenant(from: TenantStatus, to: TenantStatus): boolean {
  return TENANT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Every console transition is also a lifecycle transition — the console's map is a *restriction* of
 * the contract's, never a widening of it. Checked rather than assumed, because two maps over one
 * state space is how the two vocabularies this file just stopped duplicating came about: a console
 * that permitted `archived -> active` while the lifecycle forbade it would be a path to a state the
 * contract says is unreachable, and nothing would have noticed.
 */
export function consoleTransitionsAreLifecycleTransitions(): readonly string[] {
  const violations: string[] = [];
  for (const from of TENANT_STATUSES) {
    for (const to of TENANT_STATUS_TRANSITIONS[from]) {
      if (!TENANT_LIFECYCLE_TRANSITIONS[from].includes(to)) {
        violations.push(`${from} -> ${to}`);
      }
    }
  }
  return violations;
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
