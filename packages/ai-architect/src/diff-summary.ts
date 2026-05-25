import type { ManifestDiff } from "@crossengin/kernel/manifest";
import type { DiffSummary } from "./types.js";

export function diffSummaryFromManifestDiff(diff: ManifestDiff): DiffSummary {
  const added = diff.addedEntities.map(
    (e) => `Added entity '${e.name}' (${e.fields.length} field${e.fields.length === 1 ? "" : "s"})`,
  );

  const removed = diff.removedEntities.map((e) => `Removed entity '${e.name}' (destructive)`);

  const modified = diff.modifiedEntities.map(({ entity, diff: ed }) => {
    const parts: string[] = [];
    if (ed.addedFields.length > 0) {
      parts.push(`+${ed.addedFields.length} field${ed.addedFields.length === 1 ? "" : "s"}`);
    }
    if (ed.removedFields.length > 0) {
      parts.push(`-${ed.removedFields.length} field${ed.removedFields.length === 1 ? "" : "s"}`);
    }
    if (ed.modifiedFields.length > 0) {
      parts.push(`~${ed.modifiedFields.length} field${ed.modifiedFields.length === 1 ? "" : "s"}`);
    }
    if (ed.addedIndexes.length > 0) {
      parts.push(`+${ed.addedIndexes.length} index${ed.addedIndexes.length === 1 ? "" : "es"}`);
    }
    if (ed.removedIndexes.length > 0) {
      parts.push(`-${ed.removedIndexes.length} index${ed.removedIndexes.length === 1 ? "" : "es"}`);
    }
    return `Modified entity '${entity.name}'${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
  });

  const segments: string[] = [];
  if (added.length > 0) {
    segments.push(`${added.length} added`);
  }
  if (removed.length > 0) {
    segments.push(`${removed.length} removed`);
  }
  if (modified.length > 0) {
    segments.push(`${modified.length} modified`);
  }
  const summary = segments.length > 0 ? segments.join(", ") : "no changes";

  return {
    summary,
    added,
    removed,
    modified,
    destructive: diff.destructive,
  };
}
