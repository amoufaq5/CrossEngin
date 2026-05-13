import type { Manifest } from "@crossengin/kernel/manifest";
import { CollisionError, PackParameterError, UnknownPackError } from "./errors.js";
import type { CompliancePack } from "./types.js";

export interface ComplianceRegistry {
  getPack(packId: string): Promise<CompliancePack | null>;
}

export interface ResolveContext {
  readonly registry: ComplianceRegistry;
}

export async function resolveCompliancePacks(
  manifest: Manifest,
  context: ResolveContext,
): Promise<Manifest> {
  const packIds = manifest.meta.compliancePacks ?? [];
  if (packIds.length === 0) return manifest;

  const packParameters = manifest.meta.compliancePackParameters ?? {};

  let composed: Manifest = manifest;

  for (const packId of packIds) {
    const pack = await context.registry.getPack(packId);
    if (pack === null) {
      throw new UnknownPackError(packId);
    }

    validatePackParameters(pack, packParameters[packId] ?? {});
    composed = mergePackContributions(composed, pack);
  }

  return composed;
}

function validatePackParameters(
  pack: CompliancePack,
  provided: Readonly<Record<string, unknown>>,
): void {
  const schema = pack.meta.parameters ?? {};
  for (const [paramName, paramDef] of Object.entries(schema)) {
    const rawProvided = provided[paramName];
    const value =
      rawProvided !== undefined
        ? rawProvided
        : "default" in paramDef
          ? paramDef.default
          : undefined;

    if (paramDef.required && value === undefined) {
      throw new PackParameterError(pack.meta.id, paramName, "required but not provided");
    }
    if (value === undefined) continue;

    switch (paramDef.type) {
      case "string":
      case "long-text":
        if (typeof value !== "string") {
          throw new PackParameterError(
            pack.meta.id,
            paramName,
            `expected string, got ${typeof value}`,
          );
        }
        break;
      case "localized-string":
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new PackParameterError(
            pack.meta.id,
            paramName,
            `expected an object of locale->string mappings, got ${typeof value}`,
          );
        }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new PackParameterError(
            pack.meta.id,
            paramName,
            `expected integer, got ${typeof value}`,
          );
        }
        if (paramDef.min !== undefined && value < paramDef.min) {
          throw new PackParameterError(
            pack.meta.id,
            paramName,
            `value ${value} below minimum ${paramDef.min}`,
          );
        }
        if (paramDef.max !== undefined && value > paramDef.max) {
          throw new PackParameterError(
            pack.meta.id,
            paramName,
            `value ${value} above maximum ${paramDef.max}`,
          );
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new PackParameterError(
            pack.meta.id,
            paramName,
            `expected boolean, got ${typeof value}`,
          );
        }
        break;
      case "enum":
        if (typeof value !== "string" || !paramDef.values.includes(value)) {
          throw new PackParameterError(
            pack.meta.id,
            paramName,
            `value '${String(value)}' not in allowed enum [${paramDef.values.join(", ")}]`,
          );
        }
        break;
    }
  }
}

function mergePackContributions(manifest: Manifest, pack: CompliancePack): Manifest {
  const contributions = pack.contributions;
  const result: Manifest = { ...manifest, meta: { ...manifest.meta } };

  if (contributions.entities) {
    const existing = new Map((result.entities ?? []).map((e) => [e.name, e]));
    for (const entity of contributions.entities) {
      if (existing.has(entity.name)) {
        throw new CollisionError(pack.meta.id, "entity", entity.name);
      }
      existing.set(entity.name, entity);
    }
    result.entities = Array.from(existing.values());
  }

  if (contributions.traits) {
    const existing = new Map((result.traits ?? []).map((t) => [t.name, t]));
    for (const trait of contributions.traits) {
      if (existing.has(trait.name)) {
        throw new CollisionError(pack.meta.id, "trait", trait.name);
      }
      existing.set(trait.name, trait);
    }
    result.traits = Array.from(existing.values());
  }

  if (contributions.roles) {
    const merged = { ...(result.roles ?? {}) };
    for (const [roleName, role] of Object.entries(contributions.roles)) {
      if (roleName in merged) {
        throw new CollisionError(pack.meta.id, "role", roleName);
      }
      merged[roleName] = role;
    }
    result.roles = merged;
  }

  if (contributions.permissions) {
    const merged = { ...(result.permissions ?? {}) };
    for (const [entityName, perm] of Object.entries(contributions.permissions)) {
      if (entityName in merged) {
        throw new CollisionError(pack.meta.id, "permission", entityName);
      }
      merged[entityName] = perm;
    }
    result.permissions = merged;
  }

  if (contributions.workflows) {
    const merged = { ...(result.workflows ?? {}) };
    for (const [wfName, wf] of Object.entries(contributions.workflows)) {
      if (wfName in merged) {
        throw new CollisionError(pack.meta.id, "workflow", wfName);
      }
      merged[wfName] = wf;
    }
    result.workflows = merged;
  }

  return result;
}
