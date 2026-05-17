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

export function computeManifestDiff(old: Manifest | null, next: Manifest): ManifestDiff {
  const oldEntities = old?.entities ?? [];
  const nextEntities = next.entities ?? [];
  const oldByName = new Map(oldEntities.map((e) => [e.name, e]));
  const nextByName = new Map(nextEntities.map((e) => [e.name, e]));

  const customTraits: readonly Trait[] = next.traits ?? [];

  const addedEntities: Entity[] = [];
  const modifiedEntities: ModifiedEntity[] = [];

  for (const [name, entity] of nextByName) {
    const oldEntity = oldByName.get(name);
    if (oldEntity === undefined) {
      addedEntities.push(entity);
      continue;
    }
    const diff = computeEntityDiff(oldEntity, entity, { customTraits });
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
