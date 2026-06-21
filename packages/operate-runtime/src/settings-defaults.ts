import type { Entity } from "@crossengin/types/meta-schema";

import type { TenantSettings } from "./settings.js";

/**
 * Per-entity plan for the settings-driven defaults applied on create:
 * which fields take the tenant default currency, and how a due date is derived
 * from a base date plus the configured payment terms.
 */
export interface SettingsDefaultPlan {
  readonly currencyFields: readonly string[];
  readonly dueDateField: string | null;
  readonly baseDateField: string | null;
}

const BASE_DATE_PREFERENCE = ["issue_date", "invoice_date", "bill_date", "order_date", "entry_date", "date"];

export function settingsDefaultPlan(entity: Entity): SettingsDefaultPlan {
  const names = new Set(entity.fields.map((f) => f.name));
  const currencyFields = entity.fields
    .filter((f) => f.name === "currency" || f.type.kind === "currency_amount")
    .map((f) => f.name);
  const dueDateField = names.has("due_date") ? "due_date" : null;
  const baseDateField = BASE_DATE_PREFERENCE.find((n) => names.has(n)) ?? null;
  return { currencyFields, dueDateField, baseDateField };
}

/** True when this plan can contribute anything (so callers can skip empty plans). */
export function planHasSettingsDefaults(plan: SettingsDefaultPlan): boolean {
  return plan.currencyFields.length > 0 || plan.dueDateField !== null;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
}

/** Adds whole days to a `YYYY-MM-DD` date, returning the same format (UTC-safe). */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Overlays tenant-settings-derived defaults onto a create payload: the default
 * currency for omitted currency fields, and a due date computed from the base
 * date (or today) plus `finance.defaultPaymentTermsDays`. Only fills fields the
 * caller omitted — caller values, including explicit `null`, always win. Runs
 * before literal defaults, so a configured currency beats the manifest's literal.
 */
export function applySettingsDefaults(
  record: Record<string, unknown>,
  plan: SettingsDefaultPlan,
  settings: TenantSettings,
  now: Date = new Date(),
): Record<string, unknown> {
  if (!planHasSettingsDefaults(plan)) return record;
  const out = { ...record };

  const currency = settings.defaults?.currency;
  if (currency !== undefined) {
    for (const field of plan.currencyFields) {
      if (!(field in out)) out[field] = currency;
    }
  }

  const terms = settings.finance?.defaultPaymentTermsDays;
  if (terms !== undefined && plan.dueDateField !== null && !(plan.dueDateField in out)) {
    const baseRaw = plan.baseDateField !== null ? out[plan.baseDateField] : undefined;
    const base = isIsoDate(baseRaw) ? baseRaw.slice(0, 10) : now.toISOString().slice(0, 10);
    out[plan.dueDateField] = addDaysIso(base, terms);
  }

  return out;
}
