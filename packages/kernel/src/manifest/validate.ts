import {
  RoleInheritanceCycleError,
  UnknownRoleError,
  validateRoleGraph,
  type EntityPermissions,
  type FieldPermission,
  type RbacGrant,
  type RoleDefinition,
} from "@crossengin/auth";
import type { DataClassification } from "@crossengin/types/meta-schema";
import { requiresAuditTrail } from "@crossengin/types/meta-schema";
import type { FileTypeDeclaration } from "@crossengin/files";
import type { IntegrationDeclaration } from "@crossengin/integrations";
import type { JobDeclaration } from "@crossengin/jobs";
import type {
  DashboardDeclaration,
  ReportDeclaration,
} from "@crossengin/reporting";
import { widgetReferencedReports } from "@crossengin/reporting";
import type { ViewDeclaration } from "@crossengin/views";
import {
  viewReferencedDashboards,
  viewReferencedFields,
  viewReferencedReports,
  viewReferencedRoles,
  viewReferencedStates,
  viewReferencedViews,
  viewReferencedWorkflows,
} from "@crossengin/views";
import type { SearchManifest } from "@crossengin/search";
import { BUILT_IN_TRAIT_FIELDS } from "../ddl/built-in-traits.js";
import { resolvedFieldNames } from "../ddl/resolution.js";
import { WorkflowValidationError } from "../workflow/errors.js";
import { validateWorkflow } from "../workflow/validate.js";
import { ManifestValidationError } from "./errors.js";
import type { Manifest } from "./types.js";

export function validateManifest(manifest: Manifest): void {
  const { entityNames, fieldsByEntity } = validateEntitiesTraitsRelations(manifest);
  const rolesMap = validateRoles(manifest);
  const { entityTransitions, entityStates } = validateWorkflows(manifest, entityNames);
  validatePermissions(manifest, entityNames, fieldsByEntity, rolesMap, entityTransitions);
  validateIntegrations(manifest);
  validateJobs(manifest, rolesMap);
  validateFiles(manifest);
  const reportIds = validateReports(manifest, entityNames);
  const dashboardIds = validateDashboards(manifest, reportIds);
  validateViews(manifest, {
    entityNames,
    fieldsByEntity,
    rolesMap,
    reportIds,
    dashboardIds,
    entityTransitions,
    entityStates,
  });
  validateSearch(manifest, entityNames, fieldsByEntity);
  validateClassifications(manifest);
}

/** The resolved field names of each entity, keyed by entity name. */
type FieldsByEntity = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * A view field path may be dotted to traverse a reference (`account.name`). Only the first
 * segment names a field of the view's own entity; what lies beyond it belongs to the target
 * entity and is not resolved here.
 */
function rootSegment(path: string): string {
  return path.split(".")[0] ?? path;
}

const AUDITABLE_TRAIT = "auditable";

export interface ClassifiedFieldRef {
  readonly entity: string;
  readonly field: string;
  readonly classification: DataClassification;
}

export function manifestClassifiedFields(manifest: Manifest): readonly ClassifiedFieldRef[] {
  const out: ClassifiedFieldRef[] = [];
  for (const entity of manifest.entities ?? []) {
    for (const field of entity.fields) {
      if (field.classification !== undefined) {
        out.push({
          entity: entity.name,
          field: field.name,
          classification: field.classification,
        });
      }
    }
  }
  return out;
}

function validateClassifications(manifest: Manifest): void {
  for (const [i, entity] of (manifest.entities ?? []).entries()) {
    const isAuditable = (entity.traits ?? []).includes(AUDITABLE_TRAIT);
    for (const [j, field] of entity.fields.entries()) {
      if (field.classification === undefined) continue;
      if (requiresAuditTrail(field.classification) && !isAuditable) {
        throw new ManifestValidationError(
          `entities[${i}].fields[${j}].classification`,
          `field '${entity.name}.${field.name}' is classified '${field.classification}', which requires the entity to carry the 'auditable' trait`,
        );
      }
    }
  }
}

interface EntityIndex {
  readonly entityNames: ReadonlySet<string>;
  readonly fieldsByEntity: FieldsByEntity;
}

function validateEntitiesTraitsRelations(manifest: Manifest): EntityIndex {
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

  // Only now that every trait an entity names is known to exist can its fields be resolved.
  const fieldsByEntity = new Map<string, ReadonlySet<string>>();
  for (const entity of entities) {
    fieldsByEntity.set(entity.name, resolvedFieldNames(entity, traits));
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
      // Only many_to_one carries a FK-bearing column on `from`; a one_to_many's `field` names
      // the inverse collection and corresponds to no column anywhere. Unchecked, a relation on
      // a field that does not exist survives validation and fails later at FK emit — which is
      // exactly what a pack overriding an inherited entity, or a model inventing a reference,
      // produces.
      if (rel.kind === "many_to_one") {
        const fields = fieldsByEntity.get(rel.from);
        if (fields !== undefined && !fields.has(rel.field)) {
          throw new ManifestValidationError(
            `relations[${i}].field`,
            `many_to_one relation references unknown field '${rel.field}' on entity '${rel.from}'`,
          );
        }
      }
    }
  }

  return { entityNames, fieldsByEntity };
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

interface WorkflowIndex {
  /** Transition names declared on each entity, unioned across its lifecycle workflows. */
  readonly entityTransitions: ReadonlyMap<string, ReadonlySet<string>>;
  /** State names declared on each entity, unioned the same way. */
  readonly entityStates: ReadonlyMap<string, ReadonlySet<string>>;
}

function validateWorkflows(manifest: Manifest, entityNames: ReadonlySet<string>): WorkflowIndex {
  const workflows = manifest.workflows ?? {};
  const entityTransitions = new Map<string, Set<string>>();
  const entityStates = new Map<string, Set<string>>();

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

      const states = entityStates.get(workflow.entity) ?? new Set<string>();
      for (const s of workflow.states) {
        states.add(s.name);
      }
      entityStates.set(workflow.entity, states);
    }
  }

  return { entityTransitions, entityStates };
}

function validatePermissions(
  manifest: Manifest,
  entityNames: ReadonlySet<string>,
  fieldsByEntity: FieldsByEntity,
  rolesMap: ReadonlyMap<string, RoleDefinition>,
  entityTransitions: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const permissions: Record<string, EntityPermissions> = manifest.permissions ?? {};

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
      const allFieldNames = fieldsByEntity.get(entityName) ?? new Set<string>();
      const fieldPerms: Record<string, FieldPermission> = entityPerms.fields;
      for (const [fieldName, fieldPerm] of Object.entries(fieldPerms)) {
        if (!allFieldNames.has(fieldName)) {
          throw new ManifestValidationError(
            `permissions.${entityName}.fields.${fieldName}`,
            `field-level permission for unknown field '${fieldName}' on entity '${entityName}'`,
          );
        }
        if (fieldPerm.read) {
          checkGrant(`permissions.${entityName}.fields.${fieldName}.read.roles`, fieldPerm.read);
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

function validateIntegrations(manifest: Manifest): void {
  const integrations: Record<string, IntegrationDeclaration> = manifest.integrations ?? {};
  for (const [id, integration] of Object.entries(integrations)) {
    if (integration.kind === "outbound.http" || integration.kind === "outbound.graphql") {
      const opNames = new Set<string>();
      for (const [i, op] of integration.operations.entries()) {
        if (opNames.has(op.name)) {
          throw new ManifestValidationError(
            `integrations.${id}.operations[${i}].name`,
            `duplicate operation name '${op.name}'`,
          );
        }
        opNames.add(op.name);
      }
    }
  }
}

function validateJobs(manifest: Manifest, rolesMap: ReadonlyMap<string, RoleDefinition>): void {
  const jobs: Record<string, JobDeclaration> = manifest.jobs ?? {};
  const seenJobIds = new Set<string>();
  const workflowNames = new Set<string>(Object.keys(manifest.workflows ?? {}));

  for (const [key, job] of Object.entries(jobs)) {
    if (job.id !== key) {
      throw new ManifestValidationError(
        `jobs.${key}.id`,
        `job id '${job.id}' does not match its record key '${key}'`,
      );
    }
    if (seenJobIds.has(job.id)) {
      throw new ManifestValidationError(`jobs.${key}.id`, `duplicate job id '${job.id}'`);
    }
    seenJobIds.add(job.id);

    if (job.trigger.kind === "workflow" && !workflowNames.has(job.trigger.workflow)) {
      throw new ManifestValidationError(
        `jobs.${key}.trigger.workflow`,
        `workflow trigger references unknown workflow '${job.trigger.workflow}'`,
      );
    }

    if (job.invokeRoles !== undefined) {
      if (job.trigger.kind !== "userInvoked") {
        throw new ManifestValidationError(
          `jobs.${key}.invokeRoles`,
          `invokeRoles is only meaningful on a 'userInvoked'-trigger job (job '${job.id}' has a '${job.trigger.kind}' trigger)`,
        );
      }
      for (const roleName of job.invokeRoles) {
        if (!rolesMap.has(roleName)) {
          throw new ManifestValidationError(
            `jobs.${key}.invokeRoles`,
            `invokeRoles references role '${roleName}' which is not declared in manifest.roles`,
          );
        }
      }
    }
  }
}

function validateFiles(manifest: Manifest): void {
  const files: Record<string, FileTypeDeclaration> = manifest.files ?? {};
  const seen = new Set<string>();
  for (const key of Object.keys(files)) {
    if (seen.has(key)) {
      throw new ManifestValidationError(`files.${key}`, `duplicate file type id '${key}'`);
    }
    seen.add(key);
  }
}

function validateReports(
  manifest: Manifest,
  entityNames: ReadonlySet<string>,
): Set<string> {
  const reports: Record<string, ReportDeclaration> = manifest.reports ?? {};
  const reportIds = new Set<string>();
  for (const [key, report] of Object.entries(reports)) {
    if (reportIds.has(key)) {
      throw new ManifestValidationError(`reports.${key}`, `duplicate report id '${key}'`);
    }
    reportIds.add(key);
    if (!entityNames.has(report.entity)) {
      throw new ManifestValidationError(
        `reports.${key}.entity`,
        `report entity '${report.entity}' is not declared in manifest.entities`,
      );
    }
  }
  return reportIds;
}

function validateDashboards(
  manifest: Manifest,
  reportIds: ReadonlySet<string>,
): Set<string> {
  const dashboards: Record<string, DashboardDeclaration> = manifest.dashboards ?? {};
  const ids = new Set<string>();
  for (const [key, dashboard] of Object.entries(dashboards)) {
    if (ids.has(key)) {
      throw new ManifestValidationError(
        `dashboards.${key}`,
        `duplicate dashboard id '${key}'`,
      );
    }
    ids.add(key);
    for (const referenced of widgetReferencedReports(dashboard)) {
      if (!reportIds.has(referenced)) {
        throw new ManifestValidationError(
          `dashboards.${key}`,
          `dashboard widget references unknown report '${referenced}'`,
        );
      }
    }
  }
  return ids;
}

interface ViewContext {
  readonly entityNames: ReadonlySet<string>;
  readonly fieldsByEntity: FieldsByEntity;
  readonly rolesMap: ReadonlyMap<string, RoleDefinition>;
  readonly reportIds: ReadonlySet<string>;
  readonly dashboardIds: ReadonlySet<string>;
  readonly entityTransitions: ReadonlyMap<string, ReadonlySet<string>>;
  readonly entityStates: ReadonlyMap<string, ReadonlySet<string>>;
}

function validateViews(manifest: Manifest, ctx: ViewContext): void {
  const { entityNames, fieldsByEntity, rolesMap, reportIds, dashboardIds, entityTransitions } = ctx;
  const views: Record<string, ViewDeclaration> = manifest.views ?? {};
  const viewIds = new Set<string>(Object.keys(views));

  for (const [key, view] of Object.entries(views)) {
    if (!entityNames.has(view.entity)) {
      throw new ManifestValidationError(
        `views.${key}.entity`,
        `view entity '${view.entity}' is not declared in manifest.entities`,
      );
    }

    for (const reportRef of viewReferencedReports(view)) {
      if (!reportIds.has(reportRef)) {
        throw new ManifestValidationError(
          `views.${key}`,
          `view references unknown report '${reportRef}'`,
        );
      }
    }
    for (const dashRef of viewReferencedDashboards(view)) {
      if (!dashboardIds.has(dashRef)) {
        throw new ManifestValidationError(
          `views.${key}`,
          `view references unknown dashboard '${dashRef}'`,
        );
      }
    }
    for (const viewRef of viewReferencedViews(view)) {
      if (!viewIds.has(viewRef)) {
        throw new ManifestValidationError(
          `views.${key}`,
          `view references unknown view '${viewRef}'`,
        );
      }
    }
    const declared = entityTransitions.get(view.entity) ?? new Set<string>();
    for (const transition of viewReferencedWorkflows(view)) {
      if (!declared.has(transition)) {
        throw new ManifestValidationError(
          `views.${key}`,
          `view references transition '${transition}' not declared on entity '${view.entity}'`,
        );
      }
    }

    // A view that names a column, filter, sort key or form input the entity does not have
    // renders an empty cell or silently drops the filter — the view still "works", which is
    // why this went unnoticed. Checked here rather than in the view schema because only the
    // manifest knows what fields the entity resolves to.
    const entityFields = fieldsByEntity.get(view.entity) ?? new Set<string>();
    for (const ref of viewReferencedFields(view)) {
      if (!entityFields.has(rootSegment(ref.path))) {
        throw new ManifestValidationError(
          `views.${key}.${ref.where}`,
          `view references unknown field '${ref.path}' on entity '${view.entity}'`,
        );
      }
    }

    const declaredStates = ctx.entityStates.get(view.entity) ?? new Set<string>();
    for (const state of viewReferencedStates(view)) {
      if (!declaredStates.has(state)) {
        throw new ManifestValidationError(
          `views.${key}`,
          `view references state '${state}' not declared in any workflow for entity '${view.entity}'`,
        );
      }
    }

    // A view may override the entity's permissions with its own role list; `manifest.permissions`
    // grants are checked against manifest.roles and these were not, so a view could grant a role
    // that does not exist — which fails closed at serve time and looks like a missing grant.
    for (const roleName of viewReferencedRoles(view)) {
      if (!rolesMap.has(roleName)) {
        throw new ManifestValidationError(
          `views.${key}.permissions.roles`,
          `view grants role '${roleName}' which is not declared in manifest.roles`,
        );
      }
    }
  }
}

function validateSearch(
  manifest: Manifest,
  entityNames: ReadonlySet<string>,
  fieldsByEntity: FieldsByEntity,
): void {
  const search: SearchManifest | undefined = manifest.search;
  if (search === undefined) return;
  for (const [entityName, idx] of Object.entries(search.entities)) {
    if (!entityNames.has(entityName)) {
      throw new ManifestValidationError(
        `search.entities.${entityName}`,
        `search entry references unknown entity '${entityName}'`,
      );
    }
    const declaredFields = fieldsByEntity.get(entityName) ?? new Set<string>();
    for (const indexed of idx.indexedFields) {
      if (!declaredFields.has(rootSegment(indexed.field))) {
        throw new ManifestValidationError(
          `search.entities.${entityName}.indexedFields`,
          `indexed field '${indexed.field}' has no matching root field on entity '${entityName}'`,
        );
      }
    }
    for (const facet of idx.facets) {
      if (!declaredFields.has(rootSegment(facet))) {
        throw new ManifestValidationError(
          `search.entities.${entityName}.facets`,
          `facet '${facet}' has no matching root field on entity '${entityName}'`,
        );
      }
    }
  }
}
