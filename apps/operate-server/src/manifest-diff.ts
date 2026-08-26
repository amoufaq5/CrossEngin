import { columnNameForField } from "@crossengin/kernel/ddl";
import { ManifestSchema, computeManifestDiff, type Manifest } from "@crossengin/kernel/manifest";

import { CRUD_OPERATIONS, SENSITIVE_CLASSIFICATIONS, formatFieldType } from "./manifest-view.js";

export const DIFF_IMPACTS = ["none", "additive", "breaking"] as const;
export type DiffImpact = (typeof DIFF_IMPACTS)[number];

export type DiffWarningCode =
  | "entity_removed"
  | "field_removed"
  | "field_type_changed"
  | "field_required_added"
  | "permission_granted"
  | "permission_revoked"
  | "classification_removed"
  | "classification_raised"
  | "relation_removed"
  | "relation_cascade_added"
  | "role_removed"
  | "lifecycle_changed";

export interface DiffWarning {
  readonly code: DiffWarningCode;
  readonly impact: "additive" | "breaking";
  readonly message: string;
  readonly entities: readonly string[];
}

export interface FieldChange {
  readonly entity: string;
  readonly field: string;
  readonly change:
    | "added"
    | "removed"
    | "type_changed"
    | "required_added"
    | "required_removed"
    | "classification_changed";
  readonly from: string | null;
  readonly to: string | null;
}

export interface PermissionChange {
  readonly entity: string;
  readonly operation: string;
  readonly granted: readonly string[];
  readonly revoked: readonly string[];
}

export interface RelationChange {
  readonly change: "added" | "removed" | "modified";
  readonly label: string;
  readonly detail: string | null;
}

export interface LifecycleChange {
  readonly entity: string;
  readonly detail: string;
}

export interface ManifestDiffView {
  readonly comparable: boolean;
  readonly impact: DiffImpact;
  readonly warnings: readonly DiffWarning[];
  readonly entitiesAdded: readonly string[];
  readonly entitiesRemoved: readonly string[];
  readonly entitiesModified: readonly string[];
  readonly fieldChanges: readonly FieldChange[];
  readonly permissionChanges: readonly PermissionChange[];
  readonly relationChanges: readonly RelationChange[];
  readonly rolesAdded: readonly string[];
  readonly rolesRemoved: readonly string[];
  readonly lifecycleChanges: readonly LifecycleChange[];
  readonly counts: { added: number; removed: number; modified: number; warnings: number };
}

type ManifestEntity = NonNullable<Manifest["entities"]>[number];
type ManifestField = ManifestEntity["fields"][number];
type ManifestRelation = NonNullable<Manifest["relations"]>[number];
type EntityPermissionSet = NonNullable<NonNullable<Manifest["permissions"]>[string]>;
type RoleGrant = NonNullable<EntityPermissionSet["list"]>;
type LifecycleWorkflow = Extract<
  NonNullable<NonNullable<Manifest["workflows"]>[string]>,
  { kind: "entityLifecycle" }
>;

const DEFAULT_ON_DELETE = "restrict";

// Callers own the value they are handed: every incomparable answer is a fresh object so a
// mutation of `counts` can never corrupt the shared EMPTY_DIFF_VIEW constant.
function emptyView(): ManifestDiffView {
  return {
    comparable: false,
    impact: "none",
    warnings: [],
    entitiesAdded: [],
    entitiesRemoved: [],
    entitiesModified: [],
    fieldChanges: [],
    permissionChanges: [],
    relationChanges: [],
    rolesAdded: [],
    rolesRemoved: [],
    lifecycleChanges: [],
    counts: { added: 0, removed: 0, modified: 0, warnings: 0 },
  };
}

export const EMPTY_DIFF_VIEW: ManifestDiffView = emptyView();

function parseManifest(doc: Record<string, unknown> | null): Manifest | null {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  try {
    const parsed = ManifestSchema.safeParse(doc);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function entityIndex(manifest: Manifest): ReadonlyMap<string, ManifestEntity> {
  const index = new Map<string, ManifestEntity>();
  for (const entity of manifest.entities ?? []) {
    if (!index.has(entity.name)) index.set(entity.name, entity);
  }
  return index;
}

function fieldIndex(entity: ManifestEntity | undefined): ReadonlyMap<string, ManifestField> {
  const index = new Map<string, ManifestField>();
  for (const field of entity?.fields ?? []) {
    if (!index.has(field.name)) index.set(field.name, field);
  }
  return index;
}

// The kernel reports removed fields by *column* name (a reference field's column is
// `<name>_id`); reviewers read field names, so map back through the same emitter rule.
function fieldNameByColumn(entity: ManifestEntity | undefined): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const field of entity?.fields ?? []) {
    index.set(columnNameForField(field), field.name);
  }
  return index;
}

interface EntityLayer {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly modified: readonly string[];
  readonly fieldChanges: readonly FieldChange[];
}

function kernelEntityLayer(active: Manifest, next: Manifest): EntityLayer {
  const diff = computeManifestDiff(active, next);
  const activeEntities = entityIndex(active);
  const fieldChanges: FieldChange[] = [];

  for (const modified of diff.modifiedEntities) {
    const entity = modified.entity.name;
    const activeEntity = activeEntities.get(entity);
    const activeFields = fieldIndex(activeEntity);
    const namesByColumn = fieldNameByColumn(activeEntity);

    for (const field of modified.diff.addedFields) {
      fieldChanges.push({
        entity,
        field: field.name,
        change: "added",
        from: null,
        to: formatFieldType(field.type),
      });
    }

    for (const column of modified.diff.removedFields) {
      const name = namesByColumn.get(column) ?? column;
      const previous = activeFields.get(name);
      fieldChanges.push({
        entity,
        field: name,
        change: "removed",
        from: previous === undefined ? null : formatFieldType(previous.type),
        to: null,
      });
    }

    for (const change of modified.diff.modifiedFields) {
      if (change.typeChange !== undefined) {
        fieldChanges.push({
          entity,
          field: change.name,
          change: "type_changed",
          from: change.typeChange.from,
          to: change.typeChange.to,
        });
      }
      if (change.nullabilityChange !== undefined) {
        // The kernel tracks *required*, not nullability: `to === true` means the field
        // became required, which the store emits as a NOT NULL column.
        fieldChanges.push({
          entity,
          field: change.name,
          change: change.nullabilityChange.to ? "required_added" : "required_removed",
          from: change.nullabilityChange.from ? "required" : "optional",
          to: change.nullabilityChange.to ? "required" : "optional",
        });
      }
    }
  }

  return {
    added: diff.addedEntities.map((entity) => entity.name),
    removed: diff.removedEntities.map((entity) => entity.name),
    modified: diff.modifiedEntities.map((modified) => modified.entity.name),
    fieldChanges,
  };
}

// computeManifestDiff refuses changes it deems unsupported (a changed type kind, altered
// enum values, a flipped unique). A reviewer still has to see those, so degrade to a
// name-level comparison rather than reporting that nothing changed.
function fallbackEntityLayer(active: Manifest, next: Manifest): EntityLayer {
  const activeEntities = entityIndex(active);
  const nextEntities = entityIndex(next);
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const fieldChanges: FieldChange[] = [];

  for (const [name, entity] of nextEntities) {
    const previous = activeEntities.get(name);
    if (previous === undefined) {
      added.push(name);
      continue;
    }
    const previousFields = fieldIndex(previous);
    const nextFields = fieldIndex(entity);
    const before = fieldChanges.length;

    for (const [fieldName, field] of nextFields) {
      const priorField = previousFields.get(fieldName);
      if (priorField === undefined) {
        fieldChanges.push({
          entity: name,
          field: fieldName,
          change: "added",
          from: null,
          to: formatFieldType(field.type),
        });
        continue;
      }
      const fromType = formatFieldType(priorField.type);
      const toType = formatFieldType(field.type);
      if (fromType !== toType) {
        fieldChanges.push({
          entity: name,
          field: fieldName,
          change: "type_changed",
          from: fromType,
          to: toType,
        });
      }
      const wasRequired = priorField.required === true;
      const isRequired = field.required === true;
      if (wasRequired !== isRequired) {
        fieldChanges.push({
          entity: name,
          field: fieldName,
          change: isRequired ? "required_added" : "required_removed",
          from: wasRequired ? "required" : "optional",
          to: isRequired ? "required" : "optional",
        });
      }
    }

    for (const [fieldName, field] of previousFields) {
      if (nextFields.has(fieldName)) continue;
      fieldChanges.push({
        entity: name,
        field: fieldName,
        change: "removed",
        from: formatFieldType(field.type),
        to: null,
      });
    }

    if (fieldChanges.length > before) modified.push(name);
  }

  for (const name of activeEntities.keys()) {
    if (!nextEntities.has(name)) removed.push(name);
  }

  return { added, removed, modified, fieldChanges };
}

function entityLayer(active: Manifest, next: Manifest): EntityLayer {
  try {
    return kernelEntityLayer(active, next);
  } catch {
    return fallbackEntityLayer(active, next);
  }
}

function isSensitive(classification: string | null): boolean {
  return classification !== null && SENSITIVE_CLASSIFICATIONS.includes(classification);
}

function classificationLayer(active: Manifest, next: Manifest): readonly FieldChange[] {
  const activeEntities = entityIndex(active);
  const changes: FieldChange[] = [];

  for (const entity of next.entities ?? []) {
    const previous = activeEntities.get(entity.name);
    if (previous === undefined) continue;
    const previousFields = fieldIndex(previous);
    for (const field of entity.fields) {
      const priorField = previousFields.get(field.name);
      if (priorField === undefined) continue;
      const from = priorField.classification ?? null;
      const to = field.classification ?? null;
      if (from === to) continue;
      changes.push({
        entity: entity.name,
        field: field.name,
        change: "classification_changed",
        from,
        to,
      });
    }
  }

  return changes;
}

function grantRoles(grant: RoleGrant | undefined): readonly string[] {
  return grant?.roles ?? [];
}

function grantMap(permissions: EntityPermissionSet | undefined): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  if (permissions === undefined) return map;

  const crud: readonly (readonly [string, RoleGrant | undefined])[] = [
    ["list", permissions.list],
    ["read", permissions.read],
    ["create", permissions.create],
    ["update", permissions.update],
    ["delete", permissions.delete],
  ];
  for (const [operation, grant] of crud) {
    if (grant !== undefined) map.set(operation, grantRoles(grant));
  }
  for (const [name, grant] of Object.entries(permissions.transitions ?? {})) {
    map.set(`transitions.${name}`, grantRoles(grant));
  }
  for (const [fieldName, field] of Object.entries(permissions.fields ?? {})) {
    if (field.read !== undefined) map.set(`fields.${fieldName}.read`, grantRoles(field.read));
    if (field.update !== undefined) map.set(`fields.${fieldName}.update`, grantRoles(field.update));
  }
  return map;
}

// A widened grant on a destructive operation deserves a reviewer's attention; the terminal
// segment covers plain `update`/`delete` and field-level `fields.<f>.update` alike.
function isDestructiveOperation(operation: string): boolean {
  const segments = operation.split(".");
  const terminal = segments[segments.length - 1] ?? operation;
  return terminal === "update" || terminal === "delete";
}

function operationOrder(operation: string): number {
  const index = CRUD_OPERATIONS.indexOf(operation);
  return index === -1 ? CRUD_OPERATIONS.length : index;
}

function missingFrom(source: readonly string[], target: readonly string[]): readonly string[] {
  return source.filter((value) => !target.includes(value));
}

function permissionLayer(
  active: Manifest,
  next: Manifest,
  removedEntities: readonly string[],
): readonly PermissionChange[] {
  const activePermissions = active.permissions ?? {};
  const nextPermissions = next.permissions ?? {};
  const entityNames: string[] = [];
  for (const name of Object.keys(nextPermissions)) entityNames.push(name);
  for (const name of Object.keys(activePermissions)) {
    if (!entityNames.includes(name)) entityNames.push(name);
  }

  const changes: PermissionChange[] = [];
  for (const entity of entityNames) {
    // A removed entity takes its whole permission block with it; `entity_removed` already says so.
    if (removedEntities.includes(entity)) continue;
    const before = grantMap(activePermissions[entity]);
    const after = grantMap(nextPermissions[entity]);
    const operations = [...new Set([...after.keys(), ...before.keys()])].sort((a, b) => {
      const byOrder = operationOrder(a) - operationOrder(b);
      return byOrder !== 0 ? byOrder : a.localeCompare(b);
    });

    for (const operation of operations) {
      const previousRoles = before.get(operation) ?? [];
      const nextRoles = after.get(operation) ?? [];
      const granted = missingFrom(nextRoles, previousRoles);
      const revoked = missingFrom(previousRoles, nextRoles);
      if (granted.length === 0 && revoked.length === 0) continue;
      changes.push({ entity, operation, granted, revoked });
    }
  }
  return changes;
}

export function relationLabel(relation: ManifestRelation): string {
  if (relation.kind === "many_to_many") return `${relation.left} ↔ ${relation.right}`;
  return `${relation.from}.${relation.field} → ${relation.to}`;
}

function relationEntities(relation: ManifestRelation): readonly string[] {
  if (relation.kind === "many_to_many") return [relation.left, relation.right];
  return [relation.from, relation.to];
}

function relationOnDelete(relation: ManifestRelation): string | null {
  if (relation.kind === "many_to_many") return null;
  return relation.onDelete ?? DEFAULT_ON_DELETE;
}

function relationIndex(manifest: Manifest): ReadonlyMap<string, ManifestRelation> {
  const index = new Map<string, ManifestRelation>();
  for (const relation of manifest.relations ?? []) {
    const label = relationLabel(relation);
    if (!index.has(label)) index.set(label, relation);
  }
  return index;
}

function lifecycleIndex(manifest: Manifest): ReadonlyMap<string, LifecycleWorkflow> {
  const index = new Map<string, LifecycleWorkflow>();
  for (const workflow of Object.values(manifest.workflows ?? {})) {
    if (workflow.kind !== "entityLifecycle") continue;
    if (!index.has(workflow.entity)) index.set(workflow.entity, workflow);
  }
  return index;
}

function stateNames(lifecycle: LifecycleWorkflow): readonly string[] {
  return lifecycle.states.map((state) => state.name);
}

function transitionNames(lifecycle: LifecycleWorkflow): readonly string[] {
  return lifecycle.transitions.map((transition) => transition.name);
}

interface LifecycleDelta {
  readonly entity: string;
  readonly detail: string;
  readonly breaking: boolean;
}

function lifecycleLayer(
  active: Manifest,
  next: Manifest,
  common: ReadonlySet<string>,
): readonly LifecycleDelta[] {
  const before = lifecycleIndex(active);
  const after = lifecycleIndex(next);
  const entities: string[] = [];
  for (const name of after.keys()) if (common.has(name)) entities.push(name);
  for (const name of before.keys()) {
    if (common.has(name) && !entities.includes(name)) entities.push(name);
  }

  const deltas: LifecycleDelta[] = [];
  for (const entity of entities) {
    const previous = before.get(entity);
    const current = after.get(entity);
    if (previous === undefined && current !== undefined) {
      deltas.push({
        entity,
        detail: `lifecycle added with ${current.states.length.toString()} states`,
        breaking: false,
      });
      continue;
    }
    if (previous !== undefined && current === undefined) {
      deltas.push({ entity, detail: "lifecycle removed", breaking: true });
      continue;
    }
    if (previous === undefined || current === undefined) continue;

    const removedStates = missingFrom(stateNames(previous), stateNames(current));
    const addedStates = missingFrom(stateNames(current), stateNames(previous));
    const removedTransitions = missingFrom(transitionNames(previous), transitionNames(current));
    const addedTransitions = missingFrom(transitionNames(current), transitionNames(previous));
    const parts: string[] = [];
    if (removedStates.length > 0) parts.push(`states removed: ${removedStates.join(", ")}`);
    if (addedStates.length > 0) parts.push(`states added: ${addedStates.join(", ")}`);
    if (removedTransitions.length > 0) {
      parts.push(`transitions removed: ${removedTransitions.join(", ")}`);
    }
    if (addedTransitions.length > 0) parts.push(`transitions added: ${addedTransitions.join(", ")}`);
    if (previous.initialState !== current.initialState) {
      parts.push(`initial state ${previous.initialState} → ${current.initialState}`);
    }
    if (previous.stateField !== current.stateField) {
      parts.push(`state field ${previous.stateField} → ${current.stateField}`);
    }
    if (parts.length === 0) continue;
    deltas.push({ entity, detail: parts.join("; "), breaking: removedStates.length > 0 });
  }
  return deltas;
}

function compare(active: Manifest, next: Manifest): ManifestDiffView {
  const breaking: DiffWarning[] = [];
  const additive: DiffWarning[] = [];

  const entities = entityLayer(active, next);
  const classificationChanges = classificationLayer(active, next);

  const modified: string[] = [...entities.modified];
  for (const change of classificationChanges) {
    if (!modified.includes(change.entity)) modified.push(change.entity);
  }

  for (const entity of entities.removed) {
    breaking.push({
      code: "entity_removed",
      impact: "breaking",
      message: `Entity ${entity} is removed — its table and every row in it go away on activation.`,
      entities: [entity],
    });
  }

  for (const change of entities.fieldChanges) {
    if (change.change === "removed") {
      breaking.push({
        code: "field_removed",
        impact: "breaking",
        message: `Field ${change.entity}.${change.field} is removed — stored values are dropped.`,
        entities: [change.entity],
      });
    } else if (change.change === "type_changed") {
      breaking.push({
        code: "field_type_changed",
        impact: "breaking",
        message: `Field ${change.entity}.${change.field} changes type from ${change.from ?? "unknown"} to ${change.to ?? "unknown"}.`,
        entities: [change.entity],
      });
    } else if (change.change === "required_added") {
      breaking.push({
        code: "field_required_added",
        impact: "breaking",
        message: `Field ${change.entity}.${change.field} becomes required — existing rows without a value are invalid.`,
        entities: [change.entity],
      });
    }
  }

  for (const change of classificationChanges) {
    const from = change.from;
    const to = change.to;
    if (isSensitive(to) && !isSensitive(from)) {
      additive.push({
        code: "classification_raised",
        impact: "additive",
        message: `Field ${change.entity}.${change.field} is newly classified ${to ?? ""} — it becomes redacted for callers without an explicit grant.`,
        entities: [change.entity],
      });
    } else if (isSensitive(from) && !isSensitive(to)) {
      breaking.push({
        code: "classification_removed",
        impact: "breaking",
        message: `Field ${change.entity}.${change.field} loses its ${from ?? ""} classification — data that was governed no longer is.`,
        entities: [change.entity],
      });
    }
  }

  const permissionChanges = permissionLayer(active, next, entities.removed);
  for (const change of permissionChanges) {
    if (change.granted.length > 0) {
      const destructive = isDestructiveOperation(change.operation);
      const warning: DiffWarning = {
        code: "permission_granted",
        impact: destructive ? "breaking" : "additive",
        message: `${change.granted.join(", ")} gains ${change.operation} on ${change.entity}.`,
        entities: [change.entity],
      };
      if (destructive) breaking.push(warning);
      else additive.push(warning);
    }
    if (change.revoked.length > 0) {
      breaking.push({
        code: "permission_revoked",
        impact: "breaking",
        message: `${change.revoked.join(", ")} loses ${change.operation} on ${change.entity}.`,
        entities: [change.entity],
      });
    }
  }

  const beforeRelations = relationIndex(active);
  const afterRelations = relationIndex(next);
  const relationChanges: RelationChange[] = [];
  for (const [label, relation] of afterRelations) {
    const previous = beforeRelations.get(label);
    if (previous === undefined) {
      const onDelete = relationOnDelete(relation);
      relationChanges.push({
        change: "added",
        label,
        detail: onDelete === null ? null : `onDelete: ${onDelete}`,
      });
      continue;
    }
    const from = relationOnDelete(previous);
    const to = relationOnDelete(relation);
    if (from === to) continue;
    relationChanges.push({
      change: "modified",
      label,
      detail: `onDelete ${from ?? "none"} → ${to ?? "none"}`,
    });
    if (to === "cascade") {
      breaking.push({
        code: "relation_cascade_added",
        impact: "breaking",
        message: `Relation ${label} now cascades deletes — removing the parent deletes its children.`,
        entities: relationEntities(relation),
      });
    }
  }
  for (const [label, relation] of beforeRelations) {
    if (afterRelations.has(label)) continue;
    const onDelete = relationOnDelete(relation);
    relationChanges.push({
      change: "removed",
      label,
      detail: onDelete === null ? null : `onDelete: ${onDelete}`,
    });
    breaking.push({
      code: "relation_removed",
      impact: "breaking",
      message: `Relation ${label} is removed — the link between those records is dropped.`,
      entities: relationEntities(relation),
    });
  }

  const activeRoles = Object.keys(active.roles ?? {});
  const nextRoles = Object.keys(next.roles ?? {});
  const rolesAdded = missingFrom(nextRoles, activeRoles);
  const rolesRemoved = missingFrom(activeRoles, nextRoles);
  for (const role of rolesRemoved) {
    breaking.push({
      code: "role_removed",
      impact: "breaking",
      message: `Role ${role} is removed — everyone holding it loses access.`,
      entities: [],
    });
  }

  const common = new Set<string>();
  for (const name of entityIndex(next).keys()) {
    if (entityIndex(active).has(name)) common.add(name);
  }
  const lifecycleDeltas = lifecycleLayer(active, next, common);
  for (const delta of lifecycleDeltas) {
    const warning: DiffWarning = {
      code: "lifecycle_changed",
      impact: delta.breaking ? "breaking" : "additive",
      message: `Lifecycle of ${delta.entity} changes (${delta.detail}).`,
      entities: [delta.entity],
    };
    if (delta.breaking) breaking.push(warning);
    else additive.push(warning);
  }

  const warnings: readonly DiffWarning[] = [...breaking, ...additive];
  const fieldChanges: readonly FieldChange[] = [...entities.fieldChanges, ...classificationChanges];
  const lifecycleChanges: readonly LifecycleChange[] = lifecycleDeltas.map((delta) => ({
    entity: delta.entity,
    detail: delta.detail,
  }));

  const changed =
    warnings.length > 0 ||
    entities.added.length > 0 ||
    entities.removed.length > 0 ||
    modified.length > 0 ||
    fieldChanges.length > 0 ||
    permissionChanges.length > 0 ||
    relationChanges.length > 0 ||
    rolesAdded.length > 0 ||
    rolesRemoved.length > 0 ||
    lifecycleChanges.length > 0;

  return {
    comparable: true,
    impact: breaking.length > 0 ? "breaking" : changed ? "additive" : "none",
    warnings,
    entitiesAdded: entities.added,
    entitiesRemoved: entities.removed,
    entitiesModified: modified,
    fieldChanges,
    permissionChanges,
    relationChanges,
    rolesAdded,
    rolesRemoved,
    lifecycleChanges,
    counts: {
      added: entities.added.length,
      removed: entities.removed.length,
      modified: modified.length,
      warnings: warnings.length,
    },
  };
}

export function diffManifests(
  active: Record<string, unknown> | null,
  next: Record<string, unknown>,
): ManifestDiffView {
  if (active === null) return emptyView();
  const activeManifest = parseManifest(active);
  const nextManifest = parseManifest(next);
  if (activeManifest === null || nextManifest === null) return emptyView();
  try {
    return compare(activeManifest, nextManifest);
  } catch {
    // Activation review must never fail closed on a diff: an unexpected shape reads as
    // "nothing to compare" rather than a thrown request.
    return emptyView();
  }
}
