import { evaluateRefusal, type HardRefusal } from "@crossengin/ai-architect";
import { fieldClassificationChanges, type Manifest } from "@crossengin/kernel/manifest";

const AUDITABLE_TRAIT = "auditable";
const ENCRYPTION_REQUIRED_CLASSES: ReadonlySet<string> = new Set(["phi", "regulated"]);

type ManifestEntity = NonNullable<Manifest["entities"]>[number];

export function classifyManifestEditRefusal(
  current: Manifest | null,
  proposed: Manifest,
): HardRefusal | null {
  if (current === null) return null;
  if (detectAuditDisable(current, proposed)) {
    return "disable_audit_on_pack_bound_entity";
  }
  if (detectEncryptionWeakening(current, proposed)) {
    return "weaken_encryption_below_pack_minimum";
  }
  return null;
}

function isPackBound(manifest: Manifest): boolean {
  const meta = manifest.meta;
  return (meta.compliancePacks?.length ?? 0) > 0 || (meta.extends?.length ?? 0) > 0;
}

/**
 * Whether the entity carries the audit trail. `auditable` is a **built-in** trait, and the kernel's
 * resolution consults its built-in fields before any custom trait of the same name, so naming the
 * trait is the whole of what makes an entity auditable — no custom trait can confer or withdraw it.
 * Checked again here rather than assumed (ADR-0484 re-measured it): this is the trait-resolved
 * answer already, not a raw read.
 */
function isAuditable(entity: ManifestEntity): boolean {
  return entity.traits?.includes(AUDITABLE_TRAIT) ?? false;
}

function entitiesByName(manifest: Manifest): Map<string, ManifestEntity> {
  return new Map((manifest.entities ?? []).map((e) => [e.name, e]));
}

function detectAuditDisable(current: Manifest, proposed: Manifest): boolean {
  if (!isPackBound(proposed)) return false;
  const after = entitiesByName(proposed);
  for (const before of current.entities ?? []) {
    if (!isAuditable(before)) continue;
    const now = after.get(before.name);
    if (now === undefined) continue;
    if (!isAuditable(now)) return true;
  }
  return false;
}

/**
 * A field that was stored as ciphertext (`phi`, `regulated`) and would no longer be.
 *
 * Read through `fieldClassificationChanges`, which resolves **each side against its own traits** —
 * this used to compare `before.fields` with `now.fields`, so a `phi` field contributed by a trait
 * and moved to `internal` was not refused, while the identical change on an own field was (register
 * P2.14, ADR-0484). The kernel already says whether the change moves the column's storage between
 * ciphertext and plaintext; the weakening is the direction whose target is not an encrypt-at-rest
 * class. A field present on only one side is not a classification change — dropping a column is the
 * diff's business, and a trait removed takes its fields with it.
 */
function detectEncryptionWeakening(current: Manifest, proposed: Manifest): boolean {
  return fieldClassificationChanges(current, proposed).some(
    (c) => c.encryptionChanged && (c.to === null || !ENCRYPTION_REQUIRED_CLASSES.has(c.to)),
  );
}

export interface ManifestEditRefusalResult {
  readonly applied: false;
  readonly reason: "refused";
  readonly refusal: HardRefusal;
  readonly message: string;
  readonly citation: string;
  readonly auditSeverity: "P0";
}

const REFUSAL_ATTEMPTED_AT = "1970-01-01T00:00:00.000Z";

export function manifestEditRefusalResult(refusal: HardRefusal): ManifestEditRefusalResult {
  const decision = evaluateRefusal({
    refusal,
    requester: "ai_architect",
    tenantId: "cli",
    attemptedAt: REFUSAL_ATTEMPTED_AT,
  });
  return {
    applied: false,
    reason: "refused",
    refusal: decision.refusal,
    message: decision.message,
    citation: decision.citation,
    auditSeverity: decision.auditSeverity,
  };
}
