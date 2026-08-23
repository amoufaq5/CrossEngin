export interface FieldView {
  readonly name: string;
  readonly kind: string;
  readonly type: string;
  readonly required: boolean;
  readonly classification: string | null;
  readonly sensitive: boolean;
  readonly referenceTarget: string | null;
}

export interface TransitionView {
  readonly name: string;
  readonly from: readonly string[];
  readonly to: string;
}

export interface StateView {
  readonly name: string;
  readonly label: string;
  readonly category: string | null;
}

export interface LifecycleView {
  readonly stateField: string | null;
  readonly initialState: string | null;
  readonly states: readonly StateView[];
  readonly transitions: readonly TransitionView[];
}

export interface PermissionView {
  readonly operation: string;
  readonly roles: readonly string[];
}

export interface EntityView {
  readonly name: string;
  readonly label: string;
  readonly traits: readonly string[];
  readonly auditable: boolean;
  readonly fields: readonly FieldView[];
  readonly permissions: readonly PermissionView[];
  readonly lifecycle: LifecycleView | null;
}

export interface RelationView {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly field: string | null;
  readonly onDelete: string | null;
}

export interface RoleView {
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
  readonly grantCount: number;
}

export interface ManifestMetaView {
  readonly name: string | null;
  readonly slug: string | null;
  readonly version: string | null;
  readonly description: string | null;
}

export interface ManifestView {
  readonly meta: ManifestMetaView;
  readonly entities: readonly EntityView[];
  readonly relations: readonly RelationView[];
  readonly roles: readonly RoleView[];
  readonly counts: {
    entities: number;
    fields: number;
    roles: number;
    relations: number;
    sensitiveFields: number;
    lifecycles: number;
  };
}

export const SENSITIVE_CLASSIFICATIONS: readonly string[] = [
  "pii",
  "phi",
  "regulated",
  "commercial_sensitive",
];

export const CRUD_OPERATIONS: readonly string[] = ["list", "read", "create", "update", "delete"];

const MAX_ENUM_VALUES = 6;

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function labelOf(value: unknown, fallback: string): string {
  const direct = stringOf(value);
  if (direct !== null) return direct;
  const en = stringOf(recordOf(value)?.["en"]);
  return en ?? fallback;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = stringOf(entry);
    if (text !== null) out.push(text);
  }
  return out;
}

// A collection may arrive as an array of {name,...} or as a record keyed by name; both shapes
// project identically, with the record key acting as the name when the member omits one.
function namedEntries(value: unknown, prefix: string): readonly [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = [];
  if (Array.isArray(value)) {
    value.forEach((member, index) => {
      const record = recordOf(member);
      if (record === null) return;
      out.push([stringOf(record["name"]) ?? `${prefix}_${index.toString()}`, record]);
    });
    return out;
  }
  const asRecord = recordOf(value);
  if (asRecord === null) return out;
  for (const [key, member] of Object.entries(asRecord)) {
    const record = recordOf(member);
    if (record === null) continue;
    out.push([stringOf(record["name"]) ?? key, record]);
  }
  return out;
}

function recordList(value: unknown): readonly Record<string, unknown>[] {
  const source = Array.isArray(value) ? value : Object.values(recordOf(value) ?? {});
  const out: Record<string, unknown>[] = [];
  for (const member of source) {
    const record = recordOf(member);
    if (record !== null) out.push(record);
  }
  return out;
}

function formatEnumValues(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  const rendered: string[] = [];
  for (const value of values) {
    if (typeof value === "string") rendered.push(value);
    else if (typeof value === "number" || typeof value === "boolean") rendered.push(String(value));
  }
  if (rendered.length === 0) return null;
  if (rendered.length <= MAX_ENUM_VALUES) return `enum(${rendered.join(" | ")})`;
  const head = rendered.slice(0, MAX_ENUM_VALUES);
  const remaining = rendered.length - MAX_ENUM_VALUES;
  return `enum(${head.join(" | ")} | +${remaining.toString()} more)`;
}

export function formatFieldType(type: unknown): string {
  const record = recordOf(type);
  if (record === null) return "unknown";
  const kind = stringOf(record["kind"]);
  if (kind === null) return "unknown";

  if (kind === "text") {
    const maxLength = numberOf(record["maxLength"]);
    return maxLength === null ? "text" : `text(${maxLength.toString()})`;
  }
  if (kind === "enum") {
    return formatEnumValues(record["values"]) ?? "enum";
  }
  if (kind === "reference") {
    const target = stringOf(record["target"]);
    return target === null ? "reference" : `reference → ${target}`;
  }
  if (kind === "decimal") {
    const precision = numberOf(record["precision"]);
    const scale = numberOf(record["scale"]);
    if (precision !== null && scale !== null) {
      return `decimal(${precision.toString()},${scale.toString()})`;
    }
    if (precision !== null) return `decimal(${precision.toString()})`;
    return "decimal";
  }
  if (kind === "integer") {
    const min = numberOf(record["min"]);
    const max = numberOf(record["max"]);
    if (min === null && max === null) return "integer";
    return `integer(${min === null ? "" : min.toString()}…${max === null ? "" : max.toString()})`;
  }
  return kind;
}

function projectField(name: string, field: Record<string, unknown>): FieldView {
  const type = recordOf(field["type"]);
  const classification = stringOf(field["classification"]);
  return {
    name,
    kind: stringOf(type?.["kind"]) ?? "unknown",
    type: formatFieldType(field["type"]),
    required: field["required"] === true,
    classification,
    sensitive: classification !== null && SENSITIVE_CLASSIFICATIONS.includes(classification),
    referenceTarget:
      stringOf(type?.["kind"]) === "reference" ? stringOf(type?.["target"]) : null,
  };
}

function projectStates(value: unknown): readonly StateView[] {
  return namedEntries(value, "state").map(([name, state]) => ({
    name,
    label: labelOf(state["label"], name),
    category: stringOf(state["category"]),
  }));
}

function projectTransitions(value: unknown): readonly TransitionView[] {
  return namedEntries(value, "transition").map(([name, transition]) => {
    const rawFrom = transition["from"];
    const from = typeof rawFrom === "string" ? [rawFrom] : stringList(rawFrom);
    return { name, from, to: stringOf(transition["to"]) ?? "" };
  });
}

function lifecycleIndex(value: unknown): ReadonlyMap<string, LifecycleView> {
  const index = new Map<string, LifecycleView>();
  for (const workflow of recordList(value)) {
    if (stringOf(workflow["kind"]) !== "entityLifecycle") continue;
    const entity = stringOf(workflow["entity"]);
    if (entity === null || index.has(entity)) continue;
    index.set(entity, {
      stateField: stringOf(workflow["stateField"]),
      initialState: stringOf(workflow["initialState"]),
      states: projectStates(workflow["states"]),
      transitions: projectTransitions(workflow["transitions"]),
    });
  }
  return index;
}

function rolesOfGrant(value: unknown): readonly string[] {
  return stringList(recordOf(value)?.["roles"]);
}

function projectPermissions(entityPermissions: unknown): readonly PermissionView[] {
  const record = recordOf(entityPermissions);
  return CRUD_OPERATIONS.map((operation) => ({
    operation,
    roles: rolesOfGrant(record?.[operation]),
  }));
}

// Every grant block that names the role counts once: the five CRUD operations, each declared
// transition, and each per-field operation grant.
function countGrantsForRole(permissions: unknown, roleName: string): number {
  const byEntity = recordOf(permissions);
  if (byEntity === null) return 0;
  let count = 0;
  const tally = (grant: unknown): void => {
    if (rolesOfGrant(grant).includes(roleName)) count += 1;
  };
  for (const value of Object.values(byEntity)) {
    const entityPermissions = recordOf(value);
    if (entityPermissions === null) continue;
    for (const operation of CRUD_OPERATIONS) tally(entityPermissions[operation]);
    for (const transition of Object.values(recordOf(entityPermissions["transitions"]) ?? {})) {
      tally(transition);
    }
    for (const field of Object.values(recordOf(entityPermissions["fields"]) ?? {})) {
      for (const grant of Object.values(recordOf(field) ?? {})) tally(grant);
    }
  }
  return count;
}

function projectRelations(value: unknown): readonly RelationView[] {
  return recordList(value).map((relation) => ({
    kind: stringOf(relation["kind"]) ?? "",
    from: stringOf(relation["from"]) ?? stringOf(relation["left"]) ?? "",
    to: stringOf(relation["to"]) ?? stringOf(relation["right"]) ?? "",
    field: stringOf(relation["field"]),
    onDelete: stringOf(relation["onDelete"]),
  }));
}

function projectMeta(value: unknown): ManifestMetaView {
  const meta = recordOf(value);
  return {
    name: stringOf(meta?.["name"]),
    slug: stringOf(meta?.["slug"]),
    version: stringOf(meta?.["version"]),
    description: stringOf(meta?.["description"]),
  };
}

export function projectManifestView(manifest: Record<string, unknown>): ManifestView {
  const source = recordOf(manifest) ?? {};
  const lifecycles = lifecycleIndex(source["workflows"]);
  const permissions = source["permissions"];

  const entities: EntityView[] = namedEntries(source["entities"], "entity").map(
    ([name, entity]) => {
      const traits = stringList(entity["traits"]);
      return {
        name,
        label: labelOf(entity["label"], name),
        traits,
        auditable: traits.includes("auditable"),
        fields: namedEntries(entity["fields"], "field").map(([fieldName, field]) =>
          projectField(fieldName, field),
        ),
        permissions: projectPermissions(recordOf(permissions)?.[name]),
        lifecycle: lifecycles.get(name) ?? null,
      };
    },
  );

  const relations = projectRelations(source["relations"]);
  const roles: RoleView[] = namedEntries(source["roles"], "role").map(([name, role]) => ({
    name,
    label: labelOf(role["label"], name),
    description: stringOf(role["description"]),
    grantCount: countGrantsForRole(permissions, name),
  }));

  let fieldCount = 0;
  let sensitiveFields = 0;
  let lifecycleCount = 0;
  for (const entity of entities) {
    fieldCount += entity.fields.length;
    for (const field of entity.fields) if (field.sensitive) sensitiveFields += 1;
    if (entity.lifecycle !== null) lifecycleCount += 1;
  }

  return {
    meta: projectMeta(source["meta"]),
    entities,
    relations,
    roles,
    counts: {
      entities: entities.length,
      fields: fieldCount,
      roles: roles.length,
      relations: relations.length,
      sensitiveFields,
      lifecycles: lifecycleCount,
    },
  };
}
