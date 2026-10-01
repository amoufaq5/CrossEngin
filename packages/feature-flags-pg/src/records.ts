import { KillSwitchSchema, type KillSwitch } from "@crossengin/feature-flags";

/**
 * The columns of `meta.feature_flag_kill_switches` in the order `killSwitchRowValues` supplies
 * them. Every statement derives its column list, its placeholders and its UPDATE assignments from
 * this one array, so a column added in the middle cannot leave an INSERT and an UPDATE disagreeing
 * about which `$n` means what.
 *
 * `id` is absent on purpose: it is the surrogate key with a `uuid_generate_v7()` default, and
 * `kill_switch_id` is the contract's own id — the one a caller holds and an UPDATE matches on.
 */
export const KILL_SWITCH_COLUMN_NAMES: readonly string[] = Object.freeze([
  "kill_switch_id",
  "tenant_id",
  "flag_id",
  "status",
  "trigger_kind",
  "justification",
  "armed_at",
  "armed_by_user_id",
  "triggered_at",
  "triggered_by_user_id",
  "co_triggered_by_user_id",
  "co_triggered_at",
  "expires_at",
  "released_at",
  "released_by_user_id",
  "released_reason",
  "expired_at",
  "related_incident_id",
  "overridden_value_json",
  "impact_scope_notes",
]);

export const KILL_SWITCH_COLUMNS = KILL_SWITCH_COLUMN_NAMES.join(", ");

/** `$1, $2, …` positionally matching `KILL_SWITCH_COLUMN_NAMES`. No column is JSONB — the flag's
 * overridden value is stored as the TEXT the contract already validated as JSON. */
export function killSwitchPlaceholders(): string {
  return KILL_SWITCH_COLUMN_NAMES.map((_col, i) => `$${i + 1}`).join(", ");
}

/** `col = $n` for every column except the first, which is the key an UPDATE matches on. */
export function killSwitchUpdateAssignments(): string {
  return KILL_SWITCH_COLUMN_NAMES.slice(1)
    .map((col, i) => `${col} = $${i + 2}`)
    .join(", ");
}

/**
 * The row values for a `KillSwitch`, positionally matching `KILL_SWITCH_COLUMNS`.
 *
 * Caveat on `flag_id`: the contract's `flagId` is a `ff_`-prefixed TEXT id, but the column is
 * declared `UUID NOT NULL REFERENCES meta.feature_flags(id)`. The mapping below is the only one
 * that keeps a single source of truth, and it is what the column must be widened to accept
 * (`TEXT` with the `^ff_[a-z0-9]{8,32}$` check, as `meta.feature_flag_evaluations.flag_id`
 * already is). Inventing a surrogate lookup here would mean this package deciding which flag row
 * a contract id names, which is not its decision to make.
 */
export function killSwitchRowValues(record: KillSwitch): readonly unknown[] {
  const valid = KillSwitchSchema.parse(record);
  return [
    valid.id,
    valid.tenantId,
    valid.flagId,
    valid.status,
    valid.triggerKind,
    valid.justification,
    valid.armedAt,
    valid.armedByUserId,
    valid.triggeredAt,
    valid.triggeredByUserId,
    valid.coTriggeredByUserId,
    valid.coTriggeredAt,
    valid.expiresAt,
    valid.releasedAt,
    valid.releasedByUserId,
    valid.releasedReason,
    valid.expiredAt,
    valid.relatedIncidentId,
    valid.overriddenValueJson,
    valid.impactScopeNotes ?? null,
  ];
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : asString(value);
}

function asNullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value);
}

/**
 * Rebuilds the `KillSwitch` from a row, and **re-validates it** on the way out.
 *
 * The row *is* the record — there is no separate stored shape — so the contract's cross-field
 * invariants are the only thing standing between a hand-edited row and a kill switch the rest of
 * the platform will trust. A CHECK constraint can say "status is one of four values"; it cannot
 * say "a triggered manual_admin switch has two distinct triggering users, neither of them the
 * one who armed it" or "released implies releasedAt and releasedByUserId and releasedReason".
 * Parsing back through the schema is where those are caught, so a row in an impossible state
 * fails loudly here rather than being acted on.
 */
export function rowToKillSwitch(row: Record<string, unknown>): KillSwitch {
  return KillSwitchSchema.parse({
    id: asString(row["kill_switch_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    flagId: asString(row["flag_id"]),
    status: asString(row["status"]),
    triggerKind: asString(row["trigger_kind"]),
    justification: asString(row["justification"]),
    armedAt: asIso(row["armed_at"]),
    armedByUserId: asString(row["armed_by_user_id"]),
    triggeredAt: asNullableIso(row["triggered_at"]),
    triggeredByUserId: asNullableString(row["triggered_by_user_id"]),
    coTriggeredByUserId: asNullableString(row["co_triggered_by_user_id"]),
    coTriggeredAt: asNullableIso(row["co_triggered_at"]),
    expiresAt: asNullableIso(row["expires_at"]),
    releasedAt: asNullableIso(row["released_at"]),
    releasedByUserId: asNullableString(row["released_by_user_id"]),
    releasedReason: asNullableString(row["released_reason"]),
    expiredAt: asNullableIso(row["expired_at"]),
    relatedIncidentId: asNullableString(row["related_incident_id"]),
    overriddenValueJson: asString(row["overridden_value_json"]),
    ...maybe("impactScopeNotes", asNullableString(row["impact_scope_notes"])),
  });
}

/**
 * `impactScopeNotes` round-trips through a nullable column, and the schema distinguishes absent
 * from null for it (`.optional()`, not `.nullable()`), so a NULL must come back as an omitted key.
 */
function maybe(key: string, value: string | null): Record<string, string> {
  return value === null ? {} : { [key]: value };
}
