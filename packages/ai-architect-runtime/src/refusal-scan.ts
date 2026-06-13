import type { HardRefusal, RefusalRequest, RequesterPrincipal } from "@crossengin/ai-architect";
import {
  requiresAuditTrail,
  requiresEncryptionAtRest,
  type DataClassification,
} from "@crossengin/types/meta-schema";

/** The minimal entity shape the refusal scan reads (a full kernel `Entity` is assignable). */
export interface ScanField {
  readonly name: string;
  readonly classification?: DataClassification;
}
export interface ScanEntity {
  readonly name: string;
  /** Entity traits, as `"auditable"` strings or `{ name }` objects (both manifest shapes supported). */
  readonly traits?: ReadonlyArray<string | { readonly name: string }>;
  readonly fields: ReadonlyArray<ScanField>;
}
export interface ScanManifest {
  readonly entities: ReadonlyArray<ScanEntity>;
}

/** One hard refusal a proposed manifest edit triggers, with where it was found. */
export interface DetectedRefusal {
  readonly refusal: HardRefusal;
  readonly entity: string;
  readonly field?: string;
  readonly detail: string;
}

function hasAuditableTrait(entity: ScanEntity): boolean {
  return (entity.traits ?? []).some((t) => (typeof t === "string" ? t : t.name) === "auditable");
}

function classificationOf(field: ScanField): DataClassification | undefined {
  return field.classification;
}

/**
 * Scans a proposed manifest edit (`before` → `after`) for entity/field-level **hard
 * refusals** — dangerous edits no principal may make. Covers the two cleanly
 * diff-detectable refusals:
 *
 * - `disable_audit_on_pack_bound_entity` — an entity that carried the `auditable`
 *   trait **and** a `phi`/`regulated` (audit-required) field loses the trait.
 * - `weaken_encryption_below_pack_minimum` — a field whose `before` classification
 *   required at-rest encryption (`phi`/`regulated`) is downgraded in `after` to a
 *   classification that doesn't (or dropped entirely).
 *
 * The other hard refusals (`grant_cross_tenant_access`, `disable_mfa_on_part11_transitions`,
 * `reduce_audit_retention_below_pack_minimum`, `bypass_preview_for_apply`) depend on
 * workflow / apply-flow / pack context not present in an entity diff, and are left to
 * the apply-flow guard.
 */
export function detectHardRefusals(before: ScanManifest, after: ScanManifest): readonly DetectedRefusal[] {
  const detections: DetectedRefusal[] = [];
  const afterByName = new Map(after.entities.map((e) => [e.name, e]));

  for (const beforeEntity of before.entities) {
    const afterEntity = afterByName.get(beforeEntity.name);
    if (afterEntity === undefined) continue; // a removed entity is a deletion, not a weakening

    // disable_audit_on_pack_bound_entity
    const beforeAuditRequired = beforeEntity.fields.some((f) => {
      const c = classificationOf(f);
      return c !== undefined && requiresAuditTrail(c);
    });
    if (beforeAuditRequired && hasAuditableTrait(beforeEntity) && !hasAuditableTrait(afterEntity)) {
      detections.push({
        refusal: "disable_audit_on_pack_bound_entity",
        entity: beforeEntity.name,
        detail: `entity '${beforeEntity.name}' carries audit-required (phi/regulated) data but the 'auditable' trait was removed`,
      });
    }

    // weaken_encryption_below_pack_minimum
    const afterFieldByName = new Map(afterEntity.fields.map((f) => [f.name, f]));
    for (const beforeField of beforeEntity.fields) {
      const beforeClass = classificationOf(beforeField);
      if (beforeClass === undefined || !requiresEncryptionAtRest(beforeClass)) continue;
      const afterField = afterFieldByName.get(beforeField.name);
      if (afterField === undefined) continue; // a removed field is a deletion
      const afterClass = classificationOf(afterField);
      if (afterClass === undefined || !requiresEncryptionAtRest(afterClass)) {
        detections.push({
          refusal: "weaken_encryption_below_pack_minimum",
          entity: beforeEntity.name,
          field: beforeField.name,
          detail: `field '${beforeEntity.name}.${beforeField.name}' was '${beforeClass}' (encryption-at-rest required) but is now '${afterClass ?? "unclassified"}'`,
        });
      }
    }
  }

  return detections;
}

export interface RefusalScanContext {
  readonly requester: RequesterPrincipal;
  readonly tenantId: string;
  readonly attemptedAt: string;
}

/**
 * Scans a proposed edit and, if any hard refusal is found, builds the
 * `RefusalRequest` for the **first** one — ready to feed
 * `evaluateProposalGate({ hardRefusal: { request } })`. Returns `null` when the edit
 * trips no entity/field-level hard refusal.
 */
export function scanProposalRefusalRequest(
  before: ScanManifest,
  after: ScanManifest,
  ctx: RefusalScanContext,
): RefusalRequest | null {
  const first = detectHardRefusals(before, after)[0];
  if (first === undefined) return null;
  return {
    refusal: first.refusal,
    requester: ctx.requester,
    tenantId: ctx.tenantId,
    attemptedAt: ctx.attemptedAt,
    proposedScope: first.field !== undefined ? `${first.entity}.${first.field}` : first.entity,
  };
}
