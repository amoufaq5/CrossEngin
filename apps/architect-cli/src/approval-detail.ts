import {
  abacObligationChanges,
  diffManifestSections,
  fieldClassificationChanges,
  fieldDefaultChanges,
  roleInheritanceChanges,
  type Manifest,
  type ManifestDiff,
} from "@crossengin/kernel/manifest";

/**
 * The lines the write-approval prompt prints under its counts (H-28). The prompt used to print
 * `entities: +a -r ~m` and nothing else, so a person typing `y` approved a classification moving
 * from pii to phi, a role inheriting another, or an obligation removed from a grant without any of
 * them having been named. Each line here is one fact a reviewer acts on, from the same kernel
 * readers the operate-server design review uses, so the two approval surfaces cannot describe one
 * change two ways.
 *
 * Bounded, because a terminal prompt is read in full or not at all: past the cap the remainder is
 * counted rather than dropped, so a long list never reads as a short one.
 */
export const MAX_APPROVAL_DETAIL_LINES = 40;

function fieldLabel(entity: string, field: string, source: "own" | "trait"): string {
  return source === "trait" ? `${entity}.${field} (from a trait)` : `${entity}.${field}`;
}

export function approvalDetailLines(
  existing: Manifest | null,
  proposed: Manifest,
  diff: ManifestDiff | null,
): readonly string[] {
  const lines: string[] = [];
  if (diff !== null) {
    for (const e of diff.addedEntities) lines.push(`+ entity ${e.name}`);
    for (const e of diff.removedEntities) lines.push(`- entity ${e.name} (its table and rows go away)`);
    for (const m of diff.modifiedEntities) {
      const entity = m.entity.name;
      for (const f of m.diff.addedFields) lines.push(`+ field ${entity}.${f.name}`);
      for (const f of m.diff.removedFields) lines.push(`- field ${entity}.${f} (stored values are dropped)`);
      for (const f of m.diff.modifiedFields) {
        if (f.typeChange !== undefined) {
          lines.push(`~ field ${entity}.${f.name} type ${f.typeChange.from} → ${f.typeChange.to}`);
        }
        if (f.nullabilityChange !== undefined) {
          lines.push(
            `~ field ${entity}.${f.name} ${f.nullabilityChange.to ? "becomes required" : "becomes optional"}`,
          );
        }
      }
    }
  }
  if (existing !== null) {
    for (const c of fieldClassificationChanges(existing, proposed)) {
      const storage = c.encryptionChanged ? "; storage moves between ciphertext and plaintext" : "";
      lines.push(
        `! classification ${fieldLabel(c.entity, c.field, c.source)} ${c.from ?? "none"} → ${c.to ?? "none"} (${c.move.replace("_", " ")}${storage})`,
      );
    }
    for (const c of fieldDefaultChanges(existing, proposed)) {
      const loses = c.requiredLosesDefault ? "; required, so a create omitting it is refused" : "";
      lines.push(
        `~ default ${fieldLabel(c.entity, c.field, c.source)} ${c.from ?? "none"} → ${c.to ?? "none"}${loses}`,
      );
    }
    for (const c of roleInheritanceChanges(existing, proposed)) {
      if (c.gained.length > 0) lines.push(`! role ${c.role} now inherits ${c.gained.join(", ")}`);
      if (c.lost.length > 0) lines.push(`! role ${c.role} no longer inherits ${c.lost.join(", ")}`);
    }
    for (const c of abacObligationChanges(existing, proposed)) {
      lines.push(
        `! abac ${c.entity} ${c.operation}: ${c.from ?? "none"} → ${c.to ?? "none (the grant becomes unconditional)"}`,
      );
    }
  }
  // Every section that differs, named, so a change no line above describes is still on the page —
  // the census is what makes the lines a detail rather than the answer.
  for (const s of diffManifestSections(existing, proposed)) {
    const members = [
      ...s.added.map((m) => `+${m}`),
      ...s.removed.map((m) => `-${m}`),
      ...s.changed.map((m) => `~${m}`),
    ];
    lines.push(`  section ${s.section}${members.length > 0 ? `: ${members.join(" ")}` : " changed"}`);
  }
  if (lines.length <= MAX_APPROVAL_DETAIL_LINES) return lines;
  const shown = lines.slice(0, MAX_APPROVAL_DETAIL_LINES - 1);
  shown.push(`  … ${(lines.length - shown.length).toString()} more`);
  return shown;
}
