import type { Entity, Trait } from "@crossengin/types/meta-schema";
import { computeEntityDiff, type EntityDiff } from "../ddl/diff.js";
import { checkEntityFieldNames, expandTraits } from "../ddl/resolution.js";
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
  const oldCustomTraits: readonly Trait[] = old?.traits ?? [];

  const addedEntities: Entity[] = [];
  const modifiedEntities: ModifiedEntity[] = [];

  for (const [name, entity] of nextByName) {
    const oldEntity = oldByName.get(name);
    if (oldEntity === undefined) {
      addedEntities.push(entity);
      continue;
    }
    const diff = computeEntityDiff(resolvedAgainstOwnTraits(oldEntity, oldCustomTraits), entity, {
      customTraits,
    });
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

/**
 * The old entity with its traits already expanded, against **its own** manifest's trait set.
 *
 * `computeEntityDiff` takes one `customTraits` list and applies it to both sides, so handing it
 * `next.traits` resolved the *old* entity against the *new* trait definitions: a trait field
 * whose type changed, or that the new manifest's trait no longer declares, came back identical on
 * both sides and the diff reported nothing — while the served table genuinely gains, loses or
 * retypes that column, since `columnPlanForEntity` reads `manifest.traits`. Measured on the
 * committed tree before this, through the reviewer's own diff view: a trait field retyped, a
 * trait field removed and a trait field's classification weakened `phi` → `internal` each
 * answered `impact: none` with every count zero. The first two are what this closes; a
 * classification moves no column, so `computeFieldModification` does not compare it and
 * `diffManifestSections` is the half that reports it.
 *
 * Pre-resolving is what keeps the fix inside this function: with `traits: []` the diff's own
 * `expandTraits` call contributes nothing and `fields` already holds the old resolution, so index
 * resolution and the removed-column map read exactly what they would have for the real pair.
 * `checkEntityFieldNames` is called here because the diff's copy of it then has an empty trait
 * list and could no longer catch an own-field/trait-field collision on the old side.
 */
function resolvedAgainstOwnTraits(entity: Entity, customTraits: readonly Trait[]): Entity {
  if (entity.traits === undefined || entity.traits.length === 0) return entity;
  const traitFields = expandTraits(entity, customTraits);
  checkEntityFieldNames(entity, traitFields);
  return { ...entity, traits: [], fields: [...entity.fields, ...traitFields] };
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
