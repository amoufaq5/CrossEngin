import type { Trait } from "@crossengin/types/meta-schema";
import { emitDiff as emitEntityDiff } from "../ddl/diff.js";
import { emitEntity } from "../ddl/emit.js";
import { qualifyTable, toTableName } from "../ddl/identifiers.js";
import { computeManifestDiff, type ManifestDiff } from "./diff.js";
import { topologicalSort } from "./topology.js";
import type { Manifest } from "./types.js";

export interface EmitManifestContext {
  readonly schema: string;
}

export function emitManifestCreate(manifest: Manifest, context: EmitManifestContext): string[] {
  const entities = manifest.entities ?? [];
  const customTraits: readonly Trait[] = manifest.traits ?? [];

  const sorted = topologicalSort(entities);

  const statements: string[] = [];
  for (const entity of sorted) {
    statements.push(...emitEntity(entity, { schema: context.schema, customTraits }));
  }
  return statements;
}

export function emitManifestDiff(
  manifest: Manifest,
  diff: ManifestDiff,
  context: EmitManifestContext,
): string[] {
  const customTraits: readonly Trait[] = manifest.traits ?? [];
  const statements: string[] = [];

  if (diff.removedEntities.length > 0) {
    const sortedRemoved = topologicalSort(diff.removedEntities);
    for (const entity of [...sortedRemoved].reverse()) {
      const tableName = toTableName(entity.name);
      statements.push(`DROP TABLE ${qualifyTable(context.schema, tableName)} CASCADE;`);
    }
  }

  for (const { diff: entityDiff } of diff.modifiedEntities) {
    statements.push(...emitEntityDiff(entityDiff, { schema: context.schema }));
  }

  if (diff.addedEntities.length > 0) {
    const sortedAdded = topologicalSort(diff.addedEntities);
    for (const entity of sortedAdded) {
      statements.push(...emitEntity(entity, { schema: context.schema, customTraits }));
    }
  }

  return statements;
}

export function applyManifest(
  old: Manifest | null,
  next: Manifest,
  context: EmitManifestContext,
): string[] {
  if (old === null) {
    return emitManifestCreate(next, context);
  }
  const diff = computeManifestDiff(old, next);
  return emitManifestDiff(next, diff, context);
}
