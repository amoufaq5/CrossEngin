import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity, Field } from "@crossengin/types/meta-schema";

import { listConfigForEntity } from "./list-query.js";
import { entityCamel, resourceSlug } from "./slugs.js";

export type UiInputType =
  | "text"
  | "textarea"
  | "email"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "reference";

export interface UiFieldSchema {
  readonly name: string;
  readonly label: string;
  readonly input: UiInputType;
  readonly required: boolean;
  readonly enumValues?: readonly string[];
  readonly referenceTarget?: string;
  readonly classification?: string;
  readonly unique?: boolean;
  readonly readOnly?: boolean;
}

export interface UiTransitionSchema {
  readonly name: string;
  readonly label: string;
  readonly operationId: string;
  readonly stateField: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly roles: readonly string[];
}

export interface UiEntityAccess {
  readonly list: readonly string[];
  readonly read: readonly string[];
  readonly create: readonly string[];
  readonly update: readonly string[];
  readonly delete: readonly string[];
}

export interface UiEntitySchema {
  readonly name: string;
  readonly slug: string;
  readonly label: string;
  readonly singular: string;
  /** Functional department this entity belongs to (UI grouping). */
  readonly module: string;
  /** Roles permitted per operation (drives role-based navigation + dashboards). */
  readonly access: UiEntityAccess;
  readonly fields: readonly UiFieldSchema[];
  readonly listColumns: readonly string[];
  readonly sortableFields: readonly string[];
  readonly filterableFields: readonly string[];
  readonly stateField: string | null;
  readonly transitions: readonly UiTransitionSchema[];
  readonly operationIds: {
    readonly list: string;
    readonly read: string;
    readonly create: string;
    readonly update: string;
    readonly delete: string;
  };
}

export interface UiRoleSchema {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
}

export interface UiViewer {
  readonly primaryRole: string;
  readonly roles: readonly string[];
}

export interface UiSchema {
  readonly entities: readonly UiEntitySchema[];
  readonly roles: readonly UiRoleSchema[];
  readonly generatedAt: string;
  readonly viewer?: UiViewer;
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function pluralLabel(name: string): string {
  return `${titleCase(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))}s`;
}

function uiInput(field: Field): UiInputType {
  const k = field.type.kind;
  switch (k) {
    case "long_text":
      return "textarea";
    case "email":
      return "email";
    case "integer":
    case "decimal":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "enum":
      return "select";
    case "reference":
      return "reference";
    default:
      return "text";
  }
}

function uiField(field: Field): UiFieldSchema {
  const base: UiFieldSchema = {
    name: field.name,
    label: titleCase(field.name),
    input: uiInput(field),
    required: field.required === true,
    ...(field.classification !== undefined ? { classification: field.classification } : {}),
    ...(field.unique !== undefined && field.unique !== false ? { unique: true } : {}),
    // A sequence-defaulted field is server-generated; surface it read-only.
    ...(field.default?.kind === "sequence" ? { readOnly: true } : {}),
  };
  if (field.type.kind === "enum") {
    return { ...base, enumValues: [...field.type.values] };
  }
  if (field.type.kind === "reference") {
    return { ...base, referenceTarget: field.type.target };
  }
  return base;
}

function pickListColumns(entity: Entity, configColumns: readonly string[]): readonly string[] {
  if (configColumns.length > 0) return configColumns.slice(0, 7);
  const names = entity.fields.map((f) => f.name);
  const preferred = names.filter((n) =>
    /(_number$|^name$|^code$|_code$|^title$|^sku$|status|state|stage|total|amount|^email$|_date$|_id$)/.test(n),
  );
  const chosen = (preferred.length > 0 ? preferred : names).slice(0, 6);
  return chosen.length > 0 ? chosen : names.slice(0, 6);
}

function rolesFor(grant: { roles?: readonly string[] } | undefined): readonly string[] {
  return grant?.roles ? [...grant.roles] : [];
}

function accessFor(manifest: Manifest, entityName: string): UiEntityAccess {
  const perms = (manifest.permissions ?? {})[entityName];
  return {
    list: rolesFor(perms?.list),
    read: rolesFor(perms?.read),
    create: rolesFor(perms?.create),
    update: rolesFor(perms?.update),
    delete: rolesFor(perms?.delete),
  };
}

function transitionsFor(
  manifest: Manifest,
  entityName: string,
): {
  stateField: string | null;
  transitions: UiTransitionSchema[];
} {
  const perms = (manifest.permissions ?? {})[entityName];
  const transitions: UiTransitionSchema[] = [];
  let stateField: string | null = null;
  for (const wf of Object.values(manifest.workflows ?? {})) {
    if (wf.kind !== "entityLifecycle" || wf.entity !== entityName) continue;
    stateField = wf.stateField;
    for (const t of wf.transitions) {
      transitions.push({
        name: t.name,
        label: titleCase(t.name),
        operationId: `${entityCamel(entityName)}.${t.name}`,
        stateField: wf.stateField,
        from: Array.isArray(t.from) ? [...t.from] : [t.from],
        to: t.to,
        roles: rolesFor(perms?.transitions?.[t.name]),
      });
    }
  }
  return { stateField, transitions };
}

/** Derives the manifest-driven UI metadata a front end needs to render every entity. */
export function buildUiSchema(manifest: Manifest, now: Date = new Date()): UiSchema {
  const entities: UiEntitySchema[] = [];
  for (const entity of manifest.entities ?? []) {
    const config = listConfigForEntity(manifest, entity.name);
    const { stateField, transitions } = transitionsFor(manifest, entity.name);
    const camel = entityCamel(entity.name);
    entities.push({
      name: entity.name,
      slug: resourceSlug(entity.name),
      label: pluralLabel(entity.name),
      singular: titleCase(entity.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")),
      module: entity.module ?? "General",
      access: accessFor(manifest, entity.name),
      fields: entity.fields.map(uiField),
      listColumns: pickListColumns(entity, []),
      sortableFields: [...config.sortableFields],
      filterableFields: [...config.filterableFields],
      stateField,
      transitions,
      operationIds: {
        list: `${camel}.list`,
        read: `${camel}.read`,
        create: `${camel}.create`,
        update: `${camel}.update`,
        delete: `${camel}.delete`,
      },
    });
  }
  entities.sort((a, b) => a.label.localeCompare(b.label));
  const roles: UiRoleSchema[] = Object.entries(manifest.roles ?? {})
    .map(([name, def]) => ({
      name,
      label: def.label?.en ?? titleCase(name),
      ...(def.description !== undefined ? { description: def.description } : {}),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { entities, roles, generatedAt: now.toISOString() };
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

export interface UiSchemaContext {
  readonly schema: UiSchema;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
}

/** Read-only schema endpoint: any authenticated principal may read the UI shape. */
export function buildUiSchemaHandler(ctx: UiSchemaContext): Handler {
  return ({ principal }) => {
    if ((principal?.tenantId ?? null) === null) {
      return Promise.resolve(json(401, { error: "tenant_required" }));
    }
    const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
    const all = [primaryRole, ...(secondaryRoles ?? [])].map((r) => String(r)).filter((r) => r.length > 0);
    const viewer: UiViewer = { primaryRole: String(primaryRole), roles: [...new Set(all)] };
    return Promise.resolve(json(200, { ...ctx.schema, viewer }));
  };
}
