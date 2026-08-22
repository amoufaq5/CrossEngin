export const REVIEW_STATUSES = ["not_required", "pending", "approved", "rejected"] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const REVIEW_TRANSITIONS: Readonly<Record<ReviewStatus, readonly ReviewStatus[]>> = {
  not_required: ["pending"],
  pending: ["approved", "rejected"],
  approved: ["rejected"],
  rejected: ["pending"],
};

export function canTransitionReview(from: ReviewStatus, to: ReviewStatus): boolean {
  return (REVIEW_TRANSITIONS[from] ?? []).includes(to);
}

export const RISK_LEVELS = ["low", "medium", "high"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export type RiskCode =
  | "regulated_data"
  | "phi_data"
  | "pii_data"
  | "unaudited_sensitive"
  | "broad_delete_grant"
  | "broad_write_grant"
  | "large_surface"
  | "no_permissions"
  | "unreferenced_role"
  | "empty_manifest";

export interface RiskFinding {
  readonly code: RiskCode;
  readonly level: RiskLevel;
  readonly message: string;
  readonly entities: readonly string[];
}

export interface ManifestRiskReport {
  readonly level: RiskLevel;
  readonly findings: readonly RiskFinding[];
  readonly counts: {
    entities: number;
    fields: number;
    roles: number;
    relations: number;
    sensitiveFields: number;
  };
}

const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = { high: 0, medium: 1, low: 2 };

const SENSITIVE_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "pii",
  "phi",
  "regulated",
  "commercial_sensitive",
]);

const AUDITABLE_TRAIT = "auditable";
const BROAD_DELETE_ROLE_COUNT = 3;
const MAX_REASONABLE_ENTITIES = 25;
const MAX_REASONABLE_FIELDS = 300;
const WRITE_OPERATIONS = ["create", "update", "delete"] as const;

interface NormalizedField {
  readonly name: string;
  readonly classification: string | null;
}

interface NormalizedEntity {
  readonly name: string;
  readonly fields: readonly NormalizedField[];
  readonly auditable: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = nonEmptyString(item);
    if (s !== null) out.push(s);
  }
  return out;
}

function keyedEntries(value: unknown, fallbackPrefix: string): readonly [string, unknown][] {
  // The kernel manifest carries entities/relations as arrays and roles/permissions as records;
  // a generated or hand-written doc may key any of them by name. Normalize either shape.
  if (Array.isArray(value)) {
    return value.map((item, index): [string, unknown] => {
      const name = nonEmptyString(recordOf(item)?.["name"]);
      return [name ?? `${fallbackPrefix}_${index.toString()}`, item];
    });
  }
  const rec = recordOf(value);
  if (rec === null) return [];
  return Object.entries(rec);
}

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const rec = recordOf(value);
  return rec === null ? 0 : Object.keys(rec).length;
}

function normalizeFields(value: unknown): readonly NormalizedField[] {
  return keyedEntries(value, "field").map(([name, raw]) => {
    const field = recordOf(raw);
    return {
      name,
      classification: field === null ? null : nonEmptyString(field["classification"]),
    };
  });
}

function normalizeEntities(value: unknown): readonly NormalizedEntity[] {
  return keyedEntries(value, "entity").map(([name, raw]) => {
    const entity = recordOf(raw);
    return {
      name,
      fields: entity === null ? [] : normalizeFields(entity["fields"]),
      auditable: entity !== null && stringArray(entity["traits"]).includes(AUDITABLE_TRAIT),
    };
  });
}

function grantedRoles(permissions: Record<string, unknown> | null, operation: string): readonly string[] {
  if (permissions === null) return [];
  return stringArray(recordOf(permissions[operation])?.["roles"]);
}

function allGrantedRoles(permissions: Record<string, unknown> | null): readonly string[] {
  if (permissions === null) return [];
  const out: string[] = [];
  for (const operation of ["list", "read", "create", "update", "delete"]) {
    out.push(...grantedRoles(permissions, operation));
  }
  for (const [, grant] of keyedEntries(permissions["transitions"], "transition")) {
    out.push(...stringArray(recordOf(grant)?.["roles"]));
  }
  for (const [, fieldGrant] of keyedEntries(permissions["fields"], "field")) {
    const field = recordOf(fieldGrant);
    if (field === null) continue;
    out.push(...stringArray(recordOf(field["read"])?.["roles"]));
    out.push(...stringArray(recordOf(field["update"])?.["roles"]));
  }
  return out;
}

function list(names: readonly string[]): string {
  return names.join(", ");
}

export function assessManifestRisk(manifest: Record<string, unknown>): ManifestRiskReport {
  const doc = recordOf(manifest) ?? {};
  const entities = normalizeEntities(doc["entities"]);
  const permissionEntries = new Map<string, Record<string, unknown> | null>(
    keyedEntries(doc["permissions"], "permission").map(([name, raw]) => [name, recordOf(raw)]),
  );
  const roleNames = keyedEntries(doc["roles"], "role").map(([name]) => name);

  let fieldCount = 0;
  let sensitiveFieldCount = 0;
  const regulated: string[] = [];
  const phi: string[] = [];
  const pii: string[] = [];
  const unaudited: string[] = [];
  for (const entity of entities) {
    fieldCount += entity.fields.length;
    let hasRegulated = false;
    let hasPhi = false;
    let hasPii = false;
    let hasAuditRequired = false;
    for (const field of entity.fields) {
      const c = field.classification;
      if (c === null) continue;
      if (SENSITIVE_CLASSIFICATIONS.has(c)) sensitiveFieldCount += 1;
      if (c === "regulated") {
        hasRegulated = true;
        hasAuditRequired = true;
      } else if (c === "phi") {
        hasPhi = true;
        hasAuditRequired = true;
      } else if (c === "pii") {
        hasPii = true;
      }
    }
    if (hasRegulated) regulated.push(entity.name);
    if (hasPhi) phi.push(entity.name);
    if (hasPii) pii.push(entity.name);
    // The kernel rejects phi/regulated on a non-auditable entity at validation time, so this
    // should be unreachable for a validated manifest — assessed defensively for hand-edited docs.
    if (hasAuditRequired && !entity.auditable) unaudited.push(entity.name);
  }

  const ungoverned = entities
    .filter((entity) => !permissionEntries.has(entity.name))
    .map((entity) => entity.name);

  const broadDelete: string[] = [];
  const broadWrite: string[] = [];
  for (const entity of entities) {
    const permissions = permissionEntries.get(entity.name) ?? null;
    if (permissions === null) continue;
    if (grantedRoles(permissions, "delete").length >= BROAD_DELETE_ROLE_COUNT) {
      broadDelete.push(entity.name);
    }
    if (
      roleNames.length > 0 &&
      WRITE_OPERATIONS.every((operation) => {
        const granted = new Set(grantedRoles(permissions, operation));
        return roleNames.every((role) => granted.has(role));
      })
    ) {
      broadWrite.push(entity.name);
    }
  }

  const usedRoles = new Set<string>();
  for (const [, permissions] of permissionEntries) {
    for (const role of allGrantedRoles(permissions)) usedRoles.add(role);
  }
  const unusedRoles = roleNames.filter((role) => !usedRoles.has(role));

  const findings: RiskFinding[] = [];
  const add = (
    code: RiskCode,
    level: RiskLevel,
    message: string,
    affected: readonly string[],
  ): void => {
    findings.push({ code, level, message, entities: affected });
  };

  if (entities.length === 0) {
    add(
      "empty_manifest",
      "high",
      "This manifest declares no entities, so activating it would produce an application with nothing in it.",
      [],
    );
  }
  if (regulated.length > 0) {
    add(
      "regulated_data",
      "high",
      `Regulated data is stored on ${list(regulated)} — confirm the tenant is licensed to hold it and that retention rules are in place.`,
      regulated,
    );
  }
  if (phi.length > 0) {
    add(
      "phi_data",
      "high",
      `Protected health information is stored on ${list(phi)} — confirm a HIPAA-grade agreement covers this tenant before approving.`,
      phi,
    );
  }
  if (unaudited.length > 0) {
    add(
      "unaudited_sensitive",
      "high",
      `${list(unaudited)} holds phi or regulated fields without the auditable trait, so access to it would not be logged.`,
      unaudited,
    );
  }
  if (ungoverned.length > 0) {
    add(
      "no_permissions",
      "high",
      `${list(ungoverned)} has no permissions block, so no role can reach it and its access is ungoverned.`,
      ungoverned,
    );
  }
  if (pii.length > 0) {
    add(
      "pii_data",
      "medium",
      `Personally identifiable information is stored on ${list(pii)} — check that the tenant's privacy notice covers these fields.`,
      pii,
    );
  }
  if (broadDelete.length > 0) {
    add(
      "broad_delete_grant",
      "medium",
      `${list(broadDelete)} grants delete to ${BROAD_DELETE_ROLE_COUNT.toString()} or more roles — narrow it unless every one of them should be able to destroy records.`,
      broadDelete,
    );
  }
  if (broadWrite.length > 0) {
    add(
      "broad_write_grant",
      "medium",
      `${list(broadWrite)} grants create, update and delete to every declared role, so the manifest draws no distinction between them.`,
      broadWrite,
    );
  }
  if (entities.length > MAX_REASONABLE_ENTITIES || fieldCount > MAX_REASONABLE_FIELDS) {
    add(
      "large_surface",
      "medium",
      `This manifest is large (${entities.length.toString()} entities, ${fieldCount.toString()} fields) — review it in sections rather than in one pass.`,
      [],
    );
  }
  if (unusedRoles.length > 0) {
    add(
      "unreferenced_role",
      "low",
      `Role${unusedRoles.length === 1 ? "" : "s"} ${list(unusedRoles)} ${unusedRoles.length === 1 ? "is" : "are"} declared but granted nothing, so assigning ${unusedRoles.length === 1 ? "it" : "them"} would give a user no access.`,
      [],
    );
  }

  const ordered = findings
    .map((finding, index): { finding: RiskFinding; index: number } => ({ finding, index }))
    .sort((a, b) => {
      const byLevel = LEVEL_RANK[a.finding.level] - LEVEL_RANK[b.finding.level];
      return byLevel !== 0 ? byLevel : a.index - b.index;
    })
    .map((entry) => entry.finding);

  let level: RiskLevel = "low";
  for (const finding of ordered) {
    if (LEVEL_RANK[finding.level] < LEVEL_RANK[level]) level = finding.level;
  }

  return {
    level,
    findings: ordered,
    counts: {
      entities: entities.length,
      fields: fieldCount,
      roles: roleNames.length,
      relations: countOf(doc["relations"]),
      sensitiveFields: sensitiveFieldCount,
    },
  };
}
