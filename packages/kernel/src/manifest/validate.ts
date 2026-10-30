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
import {
  RESERVED_ENTITY_FIELD_NAMES,
  resolvedFieldNames,
  resolvedFields,
} from "../ddl/resolution.js";
import { WorkflowValidationError } from "../workflow/errors.js";
import { validateWorkflow } from "../workflow/validate.js";
import { ManifestValidationError } from "./errors.js";
import type { Manifest } from "./types.js";

export function validateManifest(manifest: Manifest): void {
  const { entityNames, fieldsByEntity, requiredFieldsByEntity } =
    validateEntitiesTraitsRelations(manifest);
  const rolesMap = validateRoles(manifest);
  const { entityTransitions, entityStates } = validateWorkflows(
    manifest,
    entityNames,
    fieldsByEntity,
  );
  validatePermissions(
    manifest,
    entityNames,
    fieldsByEntity,
    requiredFieldsByEntity,
    rolesMap,
    entityTransitions,
  );
  validateIntegrations(manifest);
  validateJobs(manifest, rolesMap);
  validateFiles(manifest);
  const reportIds = validateReports(manifest, entityNames, rolesMap);
  const dashboardIds = validateDashboards(manifest, reportIds, rolesMap);
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

/**
 * The characters a transition name may use, because it becomes a URL path segment.
 *
 * Deliberately a second spelling of `PathSegmentSchema`'s own literal-segment regex rather than an
 * import, and the reason is measured rather than the cycle one would assume: **neither package
 * depends on the other** — `@crossengin/api-gateway`'s whole dependency set is `config`, `testing`,
 * `typescript`, `vitest` and `zod`, and kernel names it nowhere. So importing it would not be
 * cyclic; it would be a *new* edge from the manifest layer to the request edge, which is backwards
 * (the gateway compiles what the manifest declares) and would spend the one property that makes
 * `api-gateway` embeddable. `manifest-event-names.ts` is under a genuinely cyclic version of the
 * same bind and answers it the same way: pin the agreement in a test that reads the other file as
 * text.
 */
const PATH_SAFE_TRANSITION_NAME = /^[a-zA-Z0-9._-]+$/;

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

/**
 * A `phi`/`regulated` field requires its entity to carry the `auditable` trait.
 *
 * Asked over `resolvedFields` and **not** `entity.fields`, because the narrow read made the whole
 * invariant bypassable by moving the declaration one level out: the identical field was *refused*
 * on `entity.fields` and *accepted* on a trait, with the served table carrying the same column
 * either way. A validation rule whose predicate is narrower than the artifact it constrains is not
 * a rule, it is a spelling convention.
 *
 * The path and the remedy differ by where the field is declared, which is why the two loops are
 * written out rather than merged. An own field's path indexes `fields[j]` and its remedy is local.
 * A trait's field has no index in this entity at all, so the path names the trait, and the remedy
 * carries a warning the own-field case does not need: a trait is shared, so dropping the
 * classification there changes every entity that carries it, and adding `auditable` to *this*
 * entity is the change whose blast radius is one entity.
 */
function validateClassifications(manifest: Manifest): void {
  const traits = manifest.traits ?? [];
  for (const [i, entity] of (manifest.entities ?? []).entries()) {
    const isAuditable = (entity.traits ?? []).includes(AUDITABLE_TRAIT);
    if (isAuditable) continue;
    const own = new Set(entity.fields.map((f) => f.name));
    for (const [j, field] of entity.fields.entries()) {
      if (field.classification === undefined) continue;
      if (requiresAuditTrail(field.classification)) {
        throw new ManifestValidationError(
          `entities[${i}].fields[${j}].classification`,
          `field '${entity.name}.${field.name}' is classified '${field.classification}', which requires the entity to carry the 'auditable' trait`,
        );
      }
    }
    for (const field of resolvedFields(entity, traits)) {
      if (field.classification === undefined || own.has(field.name)) continue;
      if (requiresAuditTrail(field.classification)) {
        throw new ManifestValidationError(
          `entities[${i}].traits`,
          `field '${entity.name}.${field.name}' arrives from a trait and is classified ` +
            `'${field.classification}', which requires the entity to carry the 'auditable' trait; ` +
            `add 'auditable' to this entity's traits, or drop the classification from the trait — ` +
            `which changes every entity carrying it`,
        );
      }
    }
  }
}

interface EntityIndex {
  readonly entityNames: ReadonlySet<string>;
  readonly fieldsByEntity: FieldsByEntity;
  /**
   * The resolved fields a create must supply. Separate from `fieldsByEntity` rather than widening
   * it, because only one rule needs it and a map of names is what every other caller wants.
   */
  readonly requiredFieldsByEntity: FieldsByEntity;
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
    for (const [j, field] of entity.fields.entries()) {
      if (RESERVED_ENTITY_FIELD_NAMES.includes(field.name)) {
        throw new ManifestValidationError(
          `entities[${i}].fields[${j}].name`,
          `field '${entity.name}.${field.name}' is reserved: the store emits that column itself, ` +
            `so a declaration of it is a duplicate column in the same CREATE TABLE — rename it`,
        );
      }
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
    for (const [j, field] of trait.fields.entries()) {
      if (RESERVED_ENTITY_FIELD_NAMES.includes(field.name)) {
        throw new ManifestValidationError(
          `traits[${i}].fields[${j}].name`,
          `trait '${trait.name}' supplies field '${field.name}', which is reserved: the store ` +
            `emits that column itself, so every entity carrying this trait emits a duplicate ` +
            `column in the same CREATE TABLE — rename it in the trait, which changes every ` +
            `entity carrying it`,
        );
      }
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
  const requiredFieldsByEntity = new Map<string, ReadonlySet<string>>();
  for (const entity of entities) {
    fieldsByEntity.set(entity.name, resolvedFieldNames(entity, traits));
    // Through `resolvedFields`, so a `required` field contributed by a **trait** is in scope. A
    // classified trait field is exactly what ADR-0338 had to reach for the same reason.
    requiredFieldsByEntity.set(
      entity.name,
      new Set(
        resolvedFields(entity, traits)
          .filter((f) => f.required === true)
          .map((f) => f.name),
      ),
    );
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

  // A `unique: {scope: [...]}` whose scope names a field the entity does not resolve to.
  //
  // Over `resolvedFields` and deliberately **not** over `entity.fields`: a unique field can arrive
  // from a trait, and so can the field a scope names, and a rule reading the raw list while the
  // emitter resolves traits is a divergence this repo keeps finding. The error names the entity
  // because a field name may be declared on several.
  //
  // A validation error and not a boot refusal, on ADR-0348's split: the dischargeability of an ABAC
  // obligation is a property of the *deployment*, while this is a property of the manifest alone —
  // so it is decidable by a pack author, by `crossengin validate`, by the pack's own test suite and
  // by the reviewer approving what the Architect designed, and a rule checkable earlier should be.
  for (const [i, entity] of entities.entries()) {
    for (const field of resolvedFields(entity, traits)) {
      const hint = field.unique;
      if (hint === undefined || typeof hint === "boolean") continue;
      const fields = fieldsByEntity.get(entity.name);
      if (fields === undefined) continue;
      for (const [k, scopeField] of hint.scope.entries()) {
        if (!fields.has(scopeField)) {
          throw new ManifestValidationError(
            `entities[${i}].fields.${field.name}.unique.scope[${k}]`,
            `unique scope on '${entity.name}.${field.name}' names '${scopeField}', which is not a ` +
              `field of '${entity.name}'; a scope naming a field that does not exist is served as ` +
              `a constraint no store can emit`,
          );
        }
        if (scopeField === field.name) {
          // Self-scoping degenerates to the unscoped form, so it is not *wrong* — it is a
          // declaration that does not say what its author thinks, which is the same class the rule
          // above catches and the same remedy (`unique: true`).
          throw new ManifestValidationError(
            `entities[${i}].fields.${field.name}.unique.scope[${k}]`,
            `unique scope on '${entity.name}.${field.name}' names the field itself; that is the ` +
              `unscoped form, which is spelled 'unique: true'`,
          );
        }
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

  return { entityNames, fieldsByEntity, requiredFieldsByEntity };
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

function validateWorkflows(
  manifest: Manifest,
  entityNames: ReadonlySet<string>,
  fieldsByEntity: FieldsByEntity,
): WorkflowIndex {
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

      // The state field has to be a field of the entity, and until now nothing said so: its whole
      // declaration was `z.string().min(1)`, so a lifecycle could name a column that does not
      // exist and the manifest cross-validated. One live member, and the damage was not in the
      // workflow at all but in the **list surface**: `withLifecycleStateFilter` adds the state
      // field to `filterableFields` unconditionally, so a phantom name became a filter the stores
      // answer with *opposite* wrong answers — the column store has no column for it and drops the
      // predicate (every row), the document store compares `document ->> 'state'` and gets NULL
      // (no rows). Measured on resolved `erp-construction`, whose `WorkOrder` replaces core's with
      // one whose field is `status` while core's `work_order_lifecycle` still names `state`.
      //
      // Checked against `fieldsByEntity`, which is `resolvedFields` + `id`, so a state field
      // contributed by a **trait** is accepted — the served table has a column for it.
      const fields = fieldsByEntity.get(workflow.entity);
      if (fields !== undefined && !fields.has(workflow.stateField)) {
        throw new ManifestValidationError(
          `workflows.${name}.stateField`,
          `workflow lifecycle state field '${workflow.stateField}' is not a field of entity ` +
            `'${workflow.entity}'; a state field that does not exist is served as a filterable ` +
            `column no store can answer`,
        );
      }

      const existing = entityTransitions.get(workflow.entity) ?? new Set<string>();
      for (const t of workflow.transitions) {
        // A transition's name becomes a **path segment**, and until now nothing constrained its
        // characters: `TransitionSchema.name` is `z.string().min(1)` and `entityRouteSpecs` puts it
        // straight into a literal segment. `RouteDefinitionSchema` declares the right regex for a
        // literal and is parsed **nowhere** — two hits in the workspace, its own declaration and a
        // `z.infer` — so `PathSegment`'s `value` is a plain `string` and the refinement is one
        // nobody runs (ADR-0362's class: the type annotation standing in for the parse).
        //
        // Measured on a deep copy of the real `erp-core`, four shapes all cross-validated: `a/b`
        // renders `/v1/invoices/{id}/a/b`, a four-component template the **matcher cannot serve**
        // because it matches one literal segment whose value contains the slash; `{id}` renders
        // `/v1/invoices/{id}/{id}`, two template expressions against one Parameter Object, which
        // OAS 3.1 forbids outright; `has space` renders a raw space; and a non-ASCII name renders
        // unencoded. So the two costs are a route a client calls and gets `no_route` for, and a
        // structurally invalid API description — and the second is why this is refused here rather
        // than in the emitter: the broken route exists whether or not anyone emits a document, so
        // the honest place is the one that owns the manifest (ADR-0348's split — a property of the
        // manifest alone is decidable by a pack author, by `crossengin validate` and by the
        // reviewer approving what the Architect designed).
        //
        // The pattern is `RouteDefinitionSchema`'s own literal-segment set, and the cost is
        // measured zero: across the seven source packs, **107 declared transitions over 59 distinct
        // names**, every one matching, with `[a-y_]` the entire character set in use.
        if (!PATH_SAFE_TRANSITION_NAME.test(t.name)) {
          throw new ManifestValidationError(
            `workflows.${name}.transitions`,
            `transition name '${t.name}' is not usable as a URL path segment: it must match ` +
              `${String(PATH_SAFE_TRANSITION_NAME)}. The name becomes a literal segment of the ` +
              `transition's own route, so anything else yields a path the router cannot serve or ` +
              `an API description that cannot be rendered`,
          );
        }
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
  requiredFieldsByEntity: FieldsByEntity,
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
      const requiredFields = requiredFieldsByEntity.get(entityName) ?? new Set<string>();
      const fieldPerms: Record<string, FieldPermission> = entityPerms.fields;
      for (const [fieldName, fieldPerm] of Object.entries(fieldPerms)) {
        if (!allFieldNames.has(fieldName)) {
          throw new ManifestValidationError(
            `permissions.${entityName}.fields.${fieldName}`,
            `field-level permission for unknown field '${fieldName}' on entity '${entityName}'`,
          );
        }
        for (const arm of FIELD_GRANT_ARMS) {
          const grant = fieldPerm[arm];
          if (grant) checkGrant(`permissions.${entityName}.fields.${fieldName}.${arm}.roles`, grant);
        }
        checkFieldGrantCoherence({
          entityName,
          fieldName,
          fieldPerm,
          entityPerms,
          required: requiredFields.has(fieldName),
        });
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

/**
 * A report names an entity that exists and grants roles that exist.
 *
 * The role check is the addition, and the gap it closes is the same shape as `validateViews`': a
 * report's `permissions` is an `RbacGrant` whose role names were checked by nothing, so a manifest
 * granting a report to `ghost_report_role` validated cleanly. A view's were checked; a report's and
 * a dashboard's were not, which made "a declaration is validated" true of one surface and false of
 * two that look identical from the manifest.
 *
 * It is a validation error and not a boot refusal on ADR-0348's split: whether a role exists is a
 * property of the manifest alone, so it is decidable by a pack author, by `crossengin validate`,
 * and by the reviewer approving what the Architect designed. Vacuous today — no pack declares a
 * report at all — which is exactly when it costs nothing to add.
 *
 * The former `reportIds.has(key)` duplicate check is gone rather than kept: `reports` is a
 * `z.record`, so `Object.entries` cannot yield one key twice and the condition was unreachable. A
 * check that cannot fire reads as coverage it does not provide.
 */
function validateReports(
  manifest: Manifest,
  entityNames: ReadonlySet<string>,
  rolesMap: ReadonlyMap<string, RoleDefinition>,
): Set<string> {
  const reports: Record<string, ReportDeclaration> = manifest.reports ?? {};
  const reportIds = new Set<string>();
  for (const [key, report] of Object.entries(reports)) {
    reportIds.add(key);
    if (!entityNames.has(report.entity)) {
      throw new ManifestValidationError(
        `reports.${key}.entity`,
        `report entity '${report.entity}' is not declared in manifest.entities`,
      );
    }
    for (const roleName of report.permissions?.roles ?? []) {
      if (!rolesMap.has(roleName)) {
        throw new ManifestValidationError(
          `reports.${key}.permissions.roles`,
          `report grants role '${roleName}' which is not declared in manifest.roles`,
        );
      }
    }
  }
  return reportIds;
}

/** `validateReports`' rule for the surface beside it; same split, same vacuity, same reason. */
function validateDashboards(
  manifest: Manifest,
  reportIds: ReadonlySet<string>,
  rolesMap: ReadonlyMap<string, RoleDefinition>,
): Set<string> {
  const dashboards: Record<string, DashboardDeclaration> = manifest.dashboards ?? {};
  const ids = new Set<string>();
  for (const [key, dashboard] of Object.entries(dashboards)) {
    ids.add(key);
    for (const roleName of dashboard.permissions?.roles ?? []) {
      if (!rolesMap.has(roleName)) {
        throw new ManifestValidationError(
          `dashboards.${key}.permissions.roles`,
          `dashboard grants role '${roleName}' which is not declared in manifest.roles`,
        );
      }
    }
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

    // A view may declare its own role list instead of inheriting the entity's permissions, and
    // those names are checked here because `manifest.permissions` grants are.
    //
    // This comment used to add "which fails closed at serve time and looks like a missing grant",
    // and that was false in the direction that made the gap look handled: **nothing reads a view's
    // `permissions` at serve time**. `listConfigForEntity` is the only serve-time reader of
    // `manifest.views` and takes `columns`, `sort` and `pageSize` from it; every authorization
    // decision reads `manifest.permissions[entity]`. So an undeclared role does not fail closed —
    // the view is presented per the entity's grants, which is strictly *wider* than what it
    // declares. The check is still worth keeping (a typo'd role is a manifest defect whether or not
    // anything serves it today), but what it buys is a correct declaration and not an enforced one.
    // `surveyViewPermissionOverrides` in `apps/operate-server` reports the inertness at boot.
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

/**
 * The three arms a field grant can carry, in the order a reader meets them. A loop over this rather
 * than three `if`s so a fourth arm is one line here and not three places to remember.
 */
const FIELD_GRANT_ARMS = ["read", "update", "create"] as const;

interface FieldGrantCheck {
  readonly entityName: string;
  readonly fieldName: string;
  readonly fieldPerm: FieldPermission;
  readonly entityPerms: EntityPermissions;
  readonly required: boolean;
}

/**
 * Whether a per-field grant can mean what it says, given the entity grants beside it.
 *
 * Until this existed, a field grant was checked for two things — the field exists, every role is
 * declared — and the three ways it can be *incoherent* were all reachable. Each of the three was a
 * live defect rather than a hypothetical, and the sharpest one shipped: `erp-government` declared
 * `Citizen.national_id` (`required`) with `update: ["gov_admin"]` while the entity's `create` grant
 * named `case_worker` too, so from ADR-0339 — which made an explicit grant authoritative with no
 * flag — `case_worker` could not create a Citizen at all. `POST /v1/citizens` answered 403
 * `explicit_update_grant` for a role the manifest plainly intends to register citizens.
 *
 * These are **validation errors and not boot refusals**, which is the opposite of where ADR-0340
 * put its ABAC obligation check, and for a stated reason: an obligation is refused at boot because
 * whether a deployment can discharge it is a property of the *deployment*, while these three are
 * properties of the manifest alone and so are decidable the moment it is written — by a pack author,
 * by `crossengin validate`, and by the reviewer who approves what the Architect designed. A rule
 * that can be checked earlier should be.
 */
function checkFieldGrantCoherence(input: FieldGrantCheck): void {
  const { entityName, fieldName, fieldPerm, entityPerms, required } = input;
  const at = `permissions.${entityName}.fields.${fieldName}`;

  // R3, first, because the other two read as puzzling when the cause is simply a role that cannot
  // reach the record at all. A field grant wider than its entity grant is not dangerous — it is
  // inert — but it is always a mistake, and it reads as a grant that works.
  for (const arm of FIELD_GRANT_ARMS) {
    const grant = fieldPerm[arm];
    if (grant === undefined) continue;
    const entityGrant = entityPerms[arm];
    if (entityGrant === undefined) continue;
    const entityRoles = new Set(entityGrant.roles);
    const unreachable = grant.roles.filter((r) => !entityRoles.has(r));
    if (unreachable.length > 0) {
      throw new ManifestValidationError(
        `${at}.${arm}.roles`,
        `grants ${arm} on '${fieldName}' to ${unreachable.map((r) => `'${r}'`).join(", ")}, ` +
          `which the entity's own ${arm} grant does not name — so the grant reaches a role that ` +
          `cannot reach the record and silently does nothing`,
      );
    }
  }

  // R2 — and `read` absent is **not** a pass. An absent read grant means the field falls to the
  // classification default, which under `--classified-write-mask` withholds it from every
  // unprivileged role, so an explicit `update` beside it is the same blind overwrite with the
  // withholding expressed one level away.
  const update = fieldPerm.update;
  if (update !== undefined) {
    const readable = new Set(fieldPerm.read?.roles ?? []);
    const blind = update.roles.filter((r) => !readable.has(r));
    if (blind.length > 0) {
      throw new ManifestValidationError(
        `${at}.update.roles`,
        `lets ${blind.map((r) => `'${r}'`).join(", ")} change '${fieldName}' without reading it` +
          (fieldPerm.read === undefined
            ? ", because no read grant is declared beside it"
            : ", which the read grant does not name") +
          ` — a blind overwrite destroys a value the writer cannot see. Declare the same role on ` +
          `read, or move it to the 'create' arm, which is deliberately not constrained this way ` +
          `because a principal supplying a value already knows it`,
      );
    }
  }

  // R1, last, because its remedy ("add a create arm") only makes sense once the first two hold.
  // The *effective* create grant, so a field that omits the arm is judged on the `update` list it
  // falls back to — which is exactly how the shipped `Citizen.national_id` defect arose.
  if (!required) return;
  const entityCreate = entityPerms.create;
  if (entityCreate === undefined) return;
  const effectiveCreate = fieldPerm.create ?? fieldPerm.update;
  if (effectiveCreate === undefined) return;
  const permitted = new Set(effectiveCreate.roles);
  const blocked = entityCreate.roles.filter((r) => !permitted.has(r));
  if (blocked.length > 0) {
    throw new ManifestValidationError(
      `${at}.${fieldPerm.create !== undefined ? "create" : "update"}.roles`,
      `makes '${entityName}' uncreatable by ${blocked.map((r) => `'${r}'`).join(", ")}: ` +
        `'${fieldName}' is required, so a create must supply it, and those roles hold the ` +
        `entity's create grant while this grant refuses them the field. Name them here — the ` +
        `'create' arm can admit them without widening who may change the value afterwards`,
    );
  }
}
