import {
  IncidentRecordSchema,
  parseIncidentId,
  type IncidentRecord,
} from "@crossengin/incident-response";

/**
 * The columns of `meta.incidents` in the order `incidentRowValues` supplies them. Every statement
 * derives its column list and its placeholders from this one array, so a column added in the
 * middle cannot leave an INSERT and an UPDATE disagreeing about which `$n` means what.
 */
export const INCIDENT_COLUMN_NAMES: readonly string[] = Object.freeze([
  "incident_id",
  "year",
  "sequence_number",
  "title",
  "severity",
  "category",
  "status",
  "affected_tenant_ids",
  "affected_regions",
  "publicly_visible",
  "declared_at",
  "declared_by",
  "acked_at",
  "mitigated_at",
  "resolved_at",
  "closed_at",
  "cancelled_at",
  "cancelled_reason",
  "root_cause",
  "customer_impact_summary",
  "role_assignments",
  "timeline",
  "runbook_execution_ids",
  "related_deployment_ids",
  "security_incident",
  "breach_data_classes",
  "postmortem_id",
  "auto_declared_for",
  "revision",
  "updated_at",
]);

/** The JSONB columns, named rather than numbered, so their `::jsonb` casts follow the array. */
export const INCIDENT_JSONB_COLUMNS: ReadonlySet<string> = new Set([
  "affected_tenant_ids",
  "affected_regions",
  "role_assignments",
  "timeline",
  "runbook_execution_ids",
  "related_deployment_ids",
  "breach_data_classes",
]);

export const INCIDENT_COLUMNS = INCIDENT_COLUMN_NAMES.join(", ");

/** `$1, $2::jsonb, …` positionally matching `INCIDENT_COLUMN_NAMES`. */
export function incidentPlaceholders(): string {
  return INCIDENT_COLUMN_NAMES.map(
    (col, i) => `$${i + 1}${INCIDENT_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
  ).join(", ");
}

/** `col = $n` for every column except the first, which is the key an UPDATE matches on. */
export function incidentUpdateAssignments(): string {
  return INCIDENT_COLUMN_NAMES.slice(1)
    .map((col, i) => `${col} = $${i + 2}${INCIDENT_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`)
    .join(", ");
}

export interface StoredIncident {
  readonly record: IncidentRecord;
  /** The revision that was read; pass it back to write, or the update is refused. */
  readonly revision: number;
  readonly updatedAt: string;
}

/**
 * The row values for an `IncidentRecord`, positionally matching `INCIDENT_COLUMNS`.
 *
 * `year` and `sequence_number` come from `parseIncidentId`, the same rule `formatIncidentId`
 * produced the id with, so a row's columns cannot disagree with its own id.
 */
export function incidentRowValues(
  record: IncidentRecord,
  revision: number,
  updatedAt: string,
): readonly unknown[] {
  const valid = IncidentRecordSchema.parse(record);
  const { year, sequence } = parseIncidentId(valid.id);
  return [
    valid.id,
    year,
    sequence,
    valid.title,
    valid.severity,
    valid.category,
    valid.status,
    JSON.stringify(valid.affectedTenantIds),
    JSON.stringify(valid.affectedRegions),
    valid.publiclyVisible,
    valid.declaredAt,
    valid.declaredBy,
    valid.ackedAt,
    valid.mitigatedAt,
    valid.resolvedAt,
    valid.closedAt,
    valid.cancelledAt,
    valid.cancelledReason ?? null,
    valid.rootCause ?? null,
    valid.customerImpactSummary ?? null,
    JSON.stringify(valid.roleAssignments),
    JSON.stringify(valid.timeline),
    JSON.stringify(valid.runbookExecutionIds),
    JSON.stringify(valid.relatedDeploymentIds),
    valid.securityIncident,
    JSON.stringify(valid.breachDataClasses),
    valid.postmortemId,
    valid.autoDeclaredFor,
    revision,
    updatedAt,
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

function asJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * Rebuilds the `IncidentRecord` from a row, and **re-validates it** on the way out.
 *
 * SQL check constraints can express "status is one of eight values" but not "a triaged sev1 has
 * five active role holders" or "resolvedAt implies mitigatedAt" — the contract's cross-field
 * invariants are beyond what the database can hold. So a row edited by hand into an impossible
 * state is only detectable by parsing it back through the schema, and this is where that happens.
 */
export function rowToIncident(row: Record<string, unknown>): StoredIncident {
  const record = IncidentRecordSchema.parse({
    id: asString(row["incident_id"]),
    title: asString(row["title"]),
    severity: asString(row["severity"]),
    category: asString(row["category"]),
    status: asString(row["status"]),
    affectedTenantIds: asJson(row["affected_tenant_ids"]),
    affectedRegions: asJson(row["affected_regions"]),
    publiclyVisible: row["publicly_visible"] === true,
    declaredAt: asIso(row["declared_at"]),
    declaredBy: asString(row["declared_by"]),
    ackedAt: asNullableIso(row["acked_at"]),
    mitigatedAt: asNullableIso(row["mitigated_at"]),
    resolvedAt: asNullableIso(row["resolved_at"]),
    closedAt: asNullableIso(row["closed_at"]),
    cancelledAt: asNullableIso(row["cancelled_at"]),
    ...maybe("cancelledReason", asNullableString(row["cancelled_reason"])),
    ...maybe("rootCause", asNullableString(row["root_cause"])),
    ...maybe("customerImpactSummary", asNullableString(row["customer_impact_summary"])),
    roleAssignments: asJson(row["role_assignments"]),
    timeline: asJson(row["timeline"]),
    runbookExecutionIds: asJson(row["runbook_execution_ids"]),
    relatedDeploymentIds: asJson(row["related_deployment_ids"]),
    securityIncident: row["security_incident"] === true,
    breachDataClasses: asJson(row["breach_data_classes"]),
    postmortemId: asNullableString(row["postmortem_id"]),
    autoDeclaredFor: asNullableString(row["auto_declared_for"]),
  });
  return {
    record,
    revision: Number(row["revision"] ?? 1),
    updatedAt: asIso(row["updated_at"]),
  };
}

/**
 * The three optional-not-nullable fields round-trip through a nullable column, and the schema
 * distinguishes absent from null for them (`.optional()`, not `.nullable()`), so a NULL must come
 * back as an omitted key rather than an explicit null.
 */
function maybe(key: string, value: string | null): Record<string, string> {
  return value === null ? {} : { [key]: value };
}
