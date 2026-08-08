import { evaluateRefusal, type HardRefusal } from "@crossengin/ai-architect";
import type { Manifest } from "@crossengin/kernel/manifest";

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

function detectEncryptionWeakening(current: Manifest, proposed: Manifest): boolean {
  const after = entitiesByName(proposed);
  for (const before of current.entities ?? []) {
    const now = after.get(before.name);
    if (now === undefined) continue;
    const nowFields = new Map(now.fields.map((f) => [f.name, f]));
    for (const bf of before.fields) {
      const cls = bf.classification;
      if (cls === undefined || !ENCRYPTION_REQUIRED_CLASSES.has(cls)) continue;
      const af = nowFields.get(bf.name);
      if (af === undefined) continue;
      const afterCls = af.classification;
      if (afterCls === undefined || !ENCRYPTION_REQUIRED_CLASSES.has(afterCls)) return true;
    }
  }
  return false;
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
