import type { Entity, Trait } from "@crossengin/types/meta-schema";
import { computeEntityDiff, type EntityDiff } from "../ddl/diff.js";
import type { Manifest } from "./types.js";

export interface ModifiedEntity {
  readonly entity: Entity;
  readonly diff: EntityDiff;
}

export interface ManifestDiff {
  readonly addedEntities: readonly Entity[];
  readonly removedEntities: readonly Entity[];
  readonly modifiedEntities: readonly ModifiedEntity[];
  readonly destructive: boolean;
}

/**
 * Which entities the next manifest adds, removes and modifies, **each side resolved against its
 * own manifest's traits**.
 *
 * `computeEntityDiff` used to be handed one `customTraits` list, so the *old* entity resolved
 * against the *new* trait definitions and a trait whose field moved came back identical on both
 * sides. `oldCustomTraits` is the fix; what it buys, and what it does not, is worth stating
 * exactly, because this function's own comment previously claimed more than it delivers.
 *
 * **A trait field the new definition no longer declares is closed here**: measured, that pair now
 * answers `removedFields: ["stamp"]` with `destructive: true`, where it answered nothing before.
 *
 * **A trait field whose *type kind* changed is not closed here.** `computeFieldModification`
 * refuses a changed type kind outright, so correct resolution turns a silent agreement into an
 * `UnsupportedDiffChangeError` — which is honest, and is not a report. The consumer degrades past
 * it: `apps/operate-server`'s `entityLayer` catches it locally and falls back to a name-level
 * comparison over `entity.fields`, which is trait-blind, so the retyped trait field is still
 * absent from `entitiesModified` and `fieldChanges`. What reports it is `diffManifestSections`,
 * whose `traits` section change is `served` and `mayWithhold`. Worth being precise about the
 * blast radius too, since the obvious fear is worse than the truth: the throw does **not** reach
 * `diffManifests`' outer catch, so a reviewer is not shown "this is the first system for this
 * tenant" — only the entity layer is degraded.
 *
 * **A classification change is reported by neither side of this function**, by design: it moves no
 * column, so `computeFieldModification` does not compare it, and `diffManifestSections` is the
 * half that carries it.
 */
export function computeManifestDiff(old: Manifest | null, next: Manifest): ManifestDiff {
  const oldEntities = old?.entities ?? [];
  const nextEntities = next.entities ?? [];
  const oldByName = new Map(oldEntities.map((e) => [e.name, e]));
  const nextByName = new Map(nextEntities.map((e) => [e.name, e]));

  const customTraits: readonly Trait[] = next.traits ?? [];
  const oldCustomTraits: readonly Trait[] = old?.traits ?? [];

  const addedEntities: Entity[] = [];
  const modifiedEntities: ModifiedEntity[] = [];

  for (const [name, entity] of nextByName) {
    const oldEntity = oldByName.get(name);
    if (oldEntity === undefined) {
      addedEntities.push(entity);
      continue;
    }
    const diff = computeEntityDiff(oldEntity, entity, { customTraits, oldCustomTraits });
    if (entityDiffHasChanges(diff)) {
      modifiedEntities.push({ entity, diff });
    }
  }

  const removedEntities: Entity[] = [];
  for (const [name, oldEntity] of oldByName) {
    if (!nextByName.has(name)) {
      removedEntities.push(oldEntity);
    }
  }

  const destructive =
    removedEntities.length > 0 || modifiedEntities.some((m) => m.diff.destructive);

  return {
    addedEntities,
    removedEntities,
    modifiedEntities,
    destructive,
  };
}

function entityDiffHasChanges(diff: EntityDiff): boolean {
  return (
    diff.addedFields.length > 0 ||
    diff.removedFields.length > 0 ||
    diff.modifiedFields.length > 0 ||
    diff.addedIndexes.length > 0 ||
    diff.removedIndexes.length > 0
  );
}
