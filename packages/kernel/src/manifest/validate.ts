import {
  RoleInheritanceCycleError,
  UnknownRoleError,
  validateRoleGraph,
  type RbacGrant,
  type RoleDefinition,
} from "@crossengin/auth";
import { BUILT_IN_TRAIT_FIELDS } from "../ddl/built-in-traits.js";
import { expandTraits } from "../ddl/resolution.js";
import { WorkflowValidationError } from "../workflow/errors.js";
import { validateWorkflow } from "../workflow/validate.js";
import { ManifestValidationError } from "./errors.js";
import type { Manifest } from "./types.js";

export function validateManifest(manifest: Manifest): void {
  const entityNames = validateEntitiesTraitsRelations(manifest);
  const rolesMap = validateRoles(manifest);
  const entityTransitions = validateWorkflows(manifest, entityNames);
  validatePermissions(manifest, entityNames, rolesMap, entityTransitions);
}

function validateEntitiesTraitsRelations(manifest: Manifest): Set<string> {
  const entityNames = new Set<string>();
  const traitNames = new Set<string>();

  const entities = manifest.entities ?? [];
  const traits = manifest.traits ?? [];
  const relations = manifest.relations ?? [];

  for (const [i, entity] of entities.entries()) {
    if (entityNames.has(entity.name)) {
      throw new ManifestValidationError(
        `entities[${i}].name`,
        `duplicate entity name '${entity.name}'`,
      );
    }
    entityNames.add(entity.name);
  }

  for (const [i, trait] of traits.entries()) {
    if (BUILT_IN_TRAIT_FIELDS.has(trait.name)) {
      throw new ManifestValidationError(
        `traits[${i}].name`,
        `trait '${trait.name}' shadows a kernel built-in trait`,
      );
    }
    if (traitNames.has(trait.name)) {
      throw new ManifestValidationError(
        `traits[${i}].name`,
        `duplicate trait name '${trait.name}'`,
      );
    }
    traitNames.add(trait.name);
  }

  for (const [i, entity] of entities.entries()) {
    if (!entity.traits) continue;
    for (const [j, traitName] of entity.traits.entries()) {
      if (BUILT_IN_TRAIT_FIELDS.has(traitName)) continue;
      if (!traitNames.has(traitName)) {
        throw new ManifestValidationError(
          `entities[${i}].traits[${j}]`,
          `unknown trait '${traitName}' (not built-in, not declared in manifest.traits)`,
        );
      }
    }
  }

  for (const [i, entity] of entities.entries()) {
    for (const [j, field] of entity.fields.entries()) {
      if (field.type.kind === "reference" && !entityNames.has(field.type.target)) {
        throw new ManifestValidationError(
          `entities[${i}].fields[${j}].type.target`,
          `reference targets unknown entity '${field.type.target}'`,
        );
      }
    }
  }

  for (const [i, trait] of traits.entries()) {
    for (const [j, field] of trait.fields.entries()) {
      if (field.type.kind === "reference" && !entityNames.has(field.type.target)) {
        throw new ManifestValidationError(
          `traits[${i}].fields[${j}].type.target`,
          `trait field reference targets unknown entity '${field.type.target}'`,
        );
      }
    }
  }

  for (const [i, rel] of relations.entries()) {
    if (rel.kind === "many_to_many") {
      if (!entityNames.has(rel.left)) {
        throw new ManifestValidationError(
          `relations[${i}].left`,
          `relation references unknown entity '${rel.left}'`,
        );
      }
      if (!entityNames.has(rel.right)) {
        throw new ManifestValidationError(
          `relations[${i}].right`,
          `relation references unknown entity '${rel.right}'`,
        );
      }
    } else {
      if (!entityNames.has(rel.from)) {
        throw new ManifestValidationError(
          `relations[${i}].from`,
          `relation references unknown entity '${rel.from}'`,
        );
      }
      if (!entityNames.has(rel.to)) {
        throw new ManifestValidationError(
          `relations[${i}].to`,
          `relation references unknown entity '${rel.to}'`,
        );
      }
    }
  }

  return entityNames;
}

function validateRoles(manifest: Manifest): Map<string, RoleDefinition> {
  const roles = manifest.roles ?? {};
  const rolesMap = new Map<string, RoleDefinition>();
  for (const [key, role] of Object.entries(roles)) {
    if (role.name !== key) {
      throw new ManifestValidationError(
        `roles.${key}.name`,
        `role name '${role.name}' does not match record key '${key}'`,
      );
    }
    rolesMap.set(key, role);
  }

  try {
    validateRoleGraph(rolesMap);
  } catch (err) {
    if (err instanceof RoleInheritanceCycleError) {
      throw new ManifestValidationError(
        `roles.${err.cycle[0] ?? "*"}.inherits`,
        `inheritance cycle: ${err.cycle.join(" -> ")}`,
      );
    }
    if (err instanceof UnknownRoleError) {
      throw new ManifestValidationError(
        `roles.*.inherits`,
        `inherits unknown role '${err.roleName}'`,
      );
    }
    throw err;
  }

  return rolesMap;
}

function validateWorkflows(
  manifest: Manifest,
  entityNames: ReadonlySet<string>,
): Map<string, Set<string>> {
  const workflows = manifest.workflows ?? {};
  const entityTransitions = new Map<string, Set<string>>();

  for (const [name, workflow] of Object.entries(workflows)) {
    try {
      validateWorkflow(name, workflow);
    } catch (err) {
      if (err instanceof WorkflowValidationError) {
        throw new ManifestValidationError(err.path, err.message);
      }
      throw err;
    }

    if (workflow.kind === "entityLifecycle") {
      if (!entityNames.has(workflow.entity)) {
        throw new ManifestValidationError(
          `workflows.${name}.entity`,
          `workflow references unknown entity '${workflow.entity}'`,
        );
      }

      const existing = entityTransitions.get(workflow.entity) ?? new Set<string>();
      for (const t of workflow.transitions) {
        existing.add(t.name);
      }
      entityTransitions.set(workflow.entity, existing);
    }
  }

  return entityTransitions;
}

function validatePermissions(
  manifest: Manifest,
  entityNames: ReadonlySet<string>,
  rolesMap: ReadonlyMap<string, RoleDefinition>,
  entityTransitions: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const permissions = manifest.permissions ?? {};
  const customTraits = manifest.traits ?? [];
  const entities = manifest.entities ?? [];

  const checkGrant = (path: string, grant: RbacGrant): void => {
    for (const roleName of grant.roles) {
      if (!rolesMap.has(roleName)) {
        throw new ManifestValidationError(
          path,
          `grants role '${roleName}' which is not declared in manifest.roles`,
        );
      }
    }
  };

  for (const [entityName, entityPerms] of Object.entries(permissions)) {
    if (!entityNames.has(entityName)) {
      throw new ManifestValidationError(
        `permissions.${entityName}`,
        `permission entry for unknown entity '${entityName}'`,
      );
    }

    for (const op of ["list", "read", "create", "update", "delete"] as const) {
      const grant = entityPerms[op];
      if (grant) checkGrant(`permissions.${entityName}.${op}.roles`, grant);
    }

    if (entityPerms.transitions) {
      const declaredTransitions = entityTransitions.get(entityName) ?? new Set<string>();
      for (const [tName, grant] of Object.entries(entityPerms.transitions)) {
        if (!declaredTransitions.has(tName)) {
          throw new ManifestValidationError(
            `permissions.${entityName}.transitions.${tName}`,
            `transition '${tName}' is not declared in any workflow for entity '${entityName}'`,
          );
        }
        checkGrant(`permissions.${entityName}.transitions.${tName}.roles`, grant);
      }
    }

    if (entityPerms.fields) {
      const entity = entities.find((e) => e.name === entityName);
      if (entity !== undefined) {
        const traitFields = expandTraits(entity, customTraits);
        const allFieldNames = new Set<string>([
          ...entity.fields.map((f) => f.name),
          ...traitFields.map((f) => f.name),
        ]);

        for (const [fieldName, fieldPerm] of Object.entries(entityPerms.fields)) {
          if (!allFieldNames.has(fieldName)) {
            throw new ManifestValidationError(
              `permissions.${entityName}.fields.${fieldName}`,
              `field-level permission for unknown field '${fieldName}' on entity '${entityName}'`,
            );
          }
          if (fieldPerm.read) {
            checkGrant(
              `permissions.${entityName}.fields.${fieldName}.read.roles`,
              fieldPerm.read,
            );
          }
          if (fieldPerm.update) {
            checkGrant(
              `permissions.${entityName}.fields.${fieldName}.update.roles`,
              fieldPerm.update,
            );
          }
        }
      }
    }
  }
}
