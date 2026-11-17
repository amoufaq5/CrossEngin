import {
  isSensitiveDataClass,
  requiresEncryptionAtRest,
  type DataClassification,
  type DefaultValue,
  type Entity,
  type Field,
  type Trait,
} from "@crossengin/types/meta-schema";
import { resolvedFields } from "../ddl/resolution.js";
import type { Manifest } from "./types.js";

/*
 * The four facts a reviewer approving a manifest change could not see (H-28), each derived once
 * here so the two readers that show a reviewer a change — the operate-server diff view behind
 * Platform → Design Reviews, and the Architect CLI's write approval — cannot come to describe one
 * change two ways. Every function compares **each side resolved against its own manifest's
 * traits**, which is `computeManifestDiff`'s rule (ADR-0388): a classification or a default a
 * trait contributes is a column the served table has, so a reader over `entity.fields` alone is
 * on the narrow side of ADR-0361's split.
 */

type ManifestEntity = Entity;
type ManifestPermissions = NonNullable<Manifest["permissions"]>;
type EntityPermissionSet = NonNullable<ManifestPermissions[string]>;

function entitiesByName(manifest: Manifest): ReadonlyMap<string, ManifestEntity> {
  const index = new Map<string, ManifestEntity>();
  for (const entity of manifest.entities ?? []) {
    if (!index.has(entity.name)) index.set(entity.name, entity);
  }
  return index;
}

/** Where a resolved field comes from: declared on the entity, or contributed by one of its traits. */
export type FieldSource = "own" | "trait";

/** The fields the served table has, each with its provenance — own fields are read only to label. */
function fieldsByName(
  entity: ManifestEntity,
  traits: readonly Trait[],
): ReadonlyMap<string, { readonly field: Field; readonly source: FieldSource }> {
  const own = new Set(entity.fields.map((f) => f.name));
  const index = new Map<string, { readonly field: Field; readonly source: FieldSource }>();
  for (const field of resolvedFields(entity, traits)) {
    index.set(field.name, { field, source: own.has(field.name) ? "own" : "trait" });
  }
  return index;
}

interface CommonField {
  readonly entity: string;
  readonly before: Field;
  readonly after: Field;
  readonly source: FieldSource;
}

function commonFields(old: Manifest, next: Manifest): readonly CommonField[] {
  const oldEntities = entitiesByName(old);
  const oldTraits = old.traits ?? [];
  const nextTraits = next.traits ?? [];
  const out: CommonField[] = [];
  for (const entity of next.entities ?? []) {
    const previous = oldEntities.get(entity.name);
    if (previous === undefined) continue;
    const before = fieldsByName(previous, oldTraits);
    for (const [name, after] of fieldsByName(entity, nextTraits)) {
      const prior = before.get(name);
      if (prior === undefined) continue;
      out.push({ entity: entity.name, before: prior.field, after: after.field, source: after.source });
    }
  }
  return out;
}

const MAX_RENDERED_LITERAL = 80;

/**
 * A default as one line a reviewer reads. A literal is JSON-rendered and truncated, because a
 * literal is any JSON value and a reviewer needs to recognise it, not to read a kilobyte of it.
 */
export function renderFieldDefault(value: DefaultValue | undefined): string | null {
  if (value === undefined) return null;
  switch (value.kind) {
    case "literal": {
      const json = JSON.stringify(value.value) ?? "null";
      const shown =
        json.length > MAX_RENDERED_LITERAL ? `${json.slice(0, MAX_RENDERED_LITERAL - 1)}…` : json;
      return `literal ${shown}`;
    }
    case "expression":
      return `expression ${value.expression}`;
    case "sequence":
      return `sequence ${value.sequence}${value.format === undefined ? "" : ` (${value.format})`}`;
  }
}

/**
 * Object keys sorted, array order kept. Deliberately not `canonicalizeForHash`, which also sorts an
 * array of named objects: a literal default whose value is such an array, reordered, stores a
 * different value on every create, and the hash's ordering is a statement about manifest identity
 * rather than about what a column receives.
 */
function orderedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = orderedKeys((value as Record<string, unknown>)[key]);
  return out;
}

function sameDefault(a: DefaultValue | undefined, b: DefaultValue | undefined): boolean {
  return JSON.stringify(orderedKeys(a ?? null)) === JSON.stringify(orderedKeys(b ?? null));
}

export interface FieldDefaultChange {
  readonly entity: string;
  readonly field: string;
  readonly source: FieldSource;
  readonly from: string | null;
  readonly to: string | null;
  /** A required field that loses its default: a create that used to omit it is now refused. */
  readonly requiredLosesDefault: boolean;
}

/**
 * A default that was added, removed or changed on a field both manifests resolve to.
 *
 * Compared on key-sorted JSON rather than on the rendered line, so two literals that render alike
 * after truncation still read as changed. `computeManifestDiff` does carry a `defaultChange` on a
 * modified field, and nothing that showed a reviewer a change read it: the operate-server field
 * layer mapped type and nullability and dropped it, and the CLI approval printed entity counts.
 * This is a separate reader rather than that field for two reasons: `computeManifestDiff` throws on
 * a change it refuses (a flipped `unique`, an altered enum), so the view's fallback layer has no
 * field detail at all, and a reviewer needs the source, the rendering and whether a required field
 * lost its only default, none of which a `FieldModification` carries.
 */
export function fieldDefaultChanges(old: Manifest, next: Manifest): readonly FieldDefaultChange[] {
  const out: FieldDefaultChange[] = [];
  for (const { entity, before, after, source } of commonFields(old, next)) {
    if (sameDefault(before.default, after.default)) continue;
    out.push({
      entity,
      field: after.name,
      source,
      from: renderFieldDefault(before.default),
      to: renderFieldDefault(after.default),
      requiredLosesDefault: after.required === true && after.default === undefined,
    });
  }
  return out;
}

/**
 * How a field's classification moved, as the axis a reviewer acts on.
 *
 * `between_sensitive` is the member the old view had no warning for at all: `pii` → `phi` and
 * `phi` → `commercial_sensitive` both stay sensitive, so neither "newly classified" nor "loses its
 * classification" was true and the change read as nothing. It is not nothing — sensitive grants
 * are **per class** (ADR-0329), so the roles that may read or write the field change, and between
 * an encrypt-at-rest class and any other the column's storage changes too.
 */
export const CLASSIFICATION_MOVES = [
  "raised",
  "lowered",
  "between_sensitive",
  "between_insensitive",
] as const;
export type ClassificationMove = (typeof CLASSIFICATION_MOVES)[number];

export interface FieldClassificationChange {
  readonly entity: string;
  readonly field: string;
  readonly source: FieldSource;
  readonly from: DataClassification | null;
  readonly to: DataClassification | null;
  readonly move: ClassificationMove;
  /** One side requires encryption at rest and the other does not, so the column's storage moves. */
  readonly encryptionChanged: boolean;
}

function sensitive(c: DataClassification | null): boolean {
  return c !== null && isSensitiveDataClass(c);
}

function encrypted(c: DataClassification | null): boolean {
  return c !== null && requiresEncryptionAtRest(c);
}

export function classificationMove(
  from: DataClassification | null,
  to: DataClassification | null,
): ClassificationMove {
  const was = sensitive(from);
  const is = sensitive(to);
  if (!was && is) return "raised";
  if (was && !is) return "lowered";
  return was ? "between_sensitive" : "between_insensitive";
}

/** A classification change on a field both manifests resolve to, a trait's fields included. */
export function fieldClassificationChanges(
  old: Manifest,
  next: Manifest,
): readonly FieldClassificationChange[] {
  const out: FieldClassificationChange[] = [];
  for (const { entity, before, after, source } of commonFields(old, next)) {
    const from = before.classification ?? null;
    const to = after.classification ?? null;
    if (from === to) continue;
    out.push({
      entity,
      field: after.name,
      source,
      from,
      to,
      move: classificationMove(from, to),
      encryptionChanged: encrypted(from) !== encrypted(to),
    });
  }
  return out;
}

export interface RoleInheritanceChange {
  readonly role: string;
  /** Roles this one now inherits: it gains every grant they hold. */
  readonly gained: readonly string[];
  /** Roles this one no longer inherits: it loses every grant it held only through them. */
  readonly lost: readonly string[];
}

/** `inherits` changes on a role both manifests declare. An added or removed role is not one. */
export function roleInheritanceChanges(
  old: Manifest,
  next: Manifest,
): readonly RoleInheritanceChange[] {
  const before = old.roles ?? {};
  const out: RoleInheritanceChange[] = [];
  for (const [role, definition] of Object.entries(next.roles ?? {})) {
    const prior = before[role];
    if (prior === undefined) continue;
    const was = prior.inherits ?? [];
    const is = definition.inherits ?? [];
    const gained = is.filter((r) => !was.includes(r));
    const lost = was.filter((r) => !is.includes(r));
    if (gained.length === 0 && lost.length === 0) continue;
    out.push({ role, gained, lost });
  }
  return out;
}

/**
 * Every grant position an entity's permission block declares, keyed the way the operate-server
 * diff keys a role change (`list`, `transitions.<name>`, `fields.<field>.<arm>`), so an obligation
 * change and a role change on one grant name the same operation. Each arm is read directly and
 * never through `fieldWriteGrant`'s `create ?? update` fallback: an inherited `update` grant's
 * obligation is already reported under `update`.
 */
function obligationsOf(permissions: EntityPermissionSet | undefined): ReadonlyMap<string, string | null> {
  const map = new Map<string, string | null>();
  if (permissions === undefined) return map;
  const crud = [
    ["list", permissions.list],
    ["read", permissions.read],
    ["create", permissions.create],
    ["update", permissions.update],
    ["delete", permissions.delete],
  ] as const;
  for (const [operation, grant] of crud) {
    if (grant !== undefined) map.set(operation, grant.abac ?? null);
  }
  for (const [name, grant] of Object.entries(permissions.transitions ?? {})) {
    map.set(`transitions.${name}`, grant.abac ?? null);
  }
  for (const [field, perm] of Object.entries(permissions.fields ?? {})) {
    if (perm.read !== undefined) map.set(`fields.${field}.read`, perm.read.abac ?? null);
    if (perm.update !== undefined) map.set(`fields.${field}.update`, perm.update.abac ?? null);
    if (perm.create !== undefined) map.set(`fields.${field}.create`, perm.create.abac ?? null);
  }
  return map;
}

export interface AbacObligationChange {
  readonly entity: string;
  readonly operation: string;
  /** The policy key before, `null` when the grant carried none or did not exist. */
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * An ABAC obligation added to, removed from or re-keyed on a grant.
 *
 * Each direction matters and none is cosmetic: an added obligation withholds — and a deployment
 * that declares no policy for the key refuses to boot the manifest at all (ADR-0340) — while a
 * removed one makes the grant unconditional, i.e. widens it to every holder of the role. A grant
 * that appears or disappears with no obligation on either side is a role change, which the
 * caller's own permission comparison already reports; it is not repeated here.
 */
export function abacObligationChanges(old: Manifest, next: Manifest): readonly AbacObligationChange[] {
  const before = old.permissions ?? {};
  const after = next.permissions ?? {};
  const entities = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  const out: AbacObligationChange[] = [];
  for (const entity of entities) {
    const was = obligationsOf(before[entity]);
    const is = obligationsOf(after[entity]);
    for (const operation of [...new Set([...is.keys(), ...was.keys()])]) {
      const from = was.get(operation) ?? null;
      const to = is.get(operation) ?? null;
      if (from === to) continue;
      out.push({ entity, operation, from, to });
    }
  }
  return out;
}
