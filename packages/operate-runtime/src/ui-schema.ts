import { principalUserId, type ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity, Field } from "@crossengin/types/meta-schema";

import { listConfigForEntity } from "./list-query.js";
import { manifestAssociationRoutes } from "./association.js";
import type { SettingsStore, TenantSettings } from "./settings.js";
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
  /** The server fills this field on create when absent (a default) — so a client form need not
   * demand it even if it is `required`. */
  readonly defaulted?: boolean;
  /**
   * A `decimal` field's declaration. Its presence is how a client knows the field travels as a
   * **canonical decimal string** rather than a JSON number: `input` stays `"number"` because the
   * right control is still a numeric one (and `scale` gives it a `step`), but a form that coerces
   * with `Number()` before posting would throw away the precision the wire type exists to keep.
   */
  readonly decimal?: { readonly precision: number; readonly scale: number };
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
  /** Text-like fields the `?q` free-text search matches against (server-side). */
  readonly searchableFields: readonly string[];
  readonly stateField: string | null;
  readonly transitions: readonly UiTransitionSchema[];
  readonly operationIds: {
    readonly list: string;
    readonly read: string;
    readonly create: string;
    readonly update: string;
    readonly delete: string;
  };
  /** Many-to-many associations owned by this entity — the related entity + its resource slug. */
  readonly associations: readonly UiAssociationSchema[];
}

/** A `many_to_many` association surfaced on the entity's detail view (`/v1/<slug>/{id}/<relatedSlug>`). */
export interface UiAssociationSchema {
  readonly relatedEntity: string;
  readonly relatedSlug: string;
  readonly relatedLabel: string;
}

export interface UiRoleSchema {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
}

export interface UiViewer {
  readonly primaryRole: string;
  readonly roles: readonly string[];
  /**
   * The signed-in person's `meta.users` id, or `null` when this credential names no person.
   *
   * `null` is a **claim** and not an absence: it is always knowable from the principal alone, with
   * no store read, so a client can rely on it. An api-key is a `service_account` sharing one
   * placeholder principal id across the whole deployment, so emitting that id would hand every
   * service credential the same "identity" — which is why this goes through `principalUserId`
   * rather than reading `principalId` directly.
   */
  readonly userId: string | null;
  /** Which kind of credential is being served, so a client can say *you are an api-key, not a person*. */
  readonly principalKind: PrincipalKind | null;
  /**
   * The person's name and email, **absent** when nothing resolved them — either because the
   * deployment wired no identity resolver (`--store memory` has no user store at all) or because
   * no row answered for this id. Absent and `null` are kept apart deliberately: `displayName` is
   * nullable in `meta.users`, so `null` means *the row carries no name*, while the key being
   * missing means *nobody looked*. A client with neither falls back to the role, which is what it
   * showed before these fields existed.
   */
  readonly displayName?: string | null;
  readonly email?: string;
}

/** The principal kinds a viewer can be served for, as the gateway resolves them. */
export type PrincipalKind = ResolvedPrincipal["principalKind"];

/** A person's own identity, as a UI needs it. `email` is NOT NULL in `meta.users`; the name is not. */
export interface UiUserIdentity {
  readonly displayName: string | null;
  readonly email: string;
}

/**
 * Resolves the signed-in person's own name and email.
 *
 * A seam rather than a store call, for the reason `settingsStore` is one on the same interface:
 * `@crossengin/operate-runtime` has **no** Postgres dependency, so the read is forced to live in
 * the app. Optional on `UiSchemaContext` following that same precedent — ADR-0338's
 * required-ness rule is for a default that *cannot be correct*, and here an absent resolver is a
 * coherent deployment (no user store), with the only cost being a name the client cannot show.
 *
 * Called **only** for a non-null `UiViewer.userId`, so it is never asked about a placeholder.
 */
export type UiUserIdentityResolver = (userId: string) => Promise<UiUserIdentity | null>;

/** Tenant display preferences safe to share with every authenticated caller. */
export interface UiFormatting {
  readonly currency?: string;
  readonly locale?: string;
  readonly dateFormat?: string;
  readonly numberFormat?: string;
  readonly weekStartDay?: number;
}

export interface UiSchema {
  readonly entities: readonly UiEntitySchema[];
  readonly roles: readonly UiRoleSchema[];
  readonly generatedAt: string;
  readonly viewer?: UiViewer;
  readonly formatting?: UiFormatting;
  readonly features?: Readonly<Record<string, boolean>>;
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

/** Whether the create path fills this field when the client omits it (default → no client input needed). */
function isServerDefaulted(field: Field): boolean {
  return field.default !== undefined || field.name === "currency" || field.type.kind === "currency_amount";
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
    // The server auto-fills this on create (a literal/sequence default, or a settings-driven
    // currency default), so a client form needn't demand it even when required.
    ...(isServerDefaulted(field) ? { defaulted: true } : {}),
  };
  if (field.type.kind === "enum") {
    return { ...base, enumValues: [...field.type.values] };
  }
  if (field.type.kind === "reference") {
    return { ...base, referenceTarget: field.type.target };
  }
  if (field.type.kind === "decimal") {
    return { ...base, decimal: { precision: field.type.precision, scale: field.type.scale } };
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
  const associationsByOwner = new Map<string, UiAssociationSchema[]>();
  for (const route of manifestAssociationRoutes(manifest)) {
    const list = associationsByOwner.get(route.ownerEntity) ?? [];
    list.push({
      relatedEntity: route.relatedEntity,
      relatedSlug: resourceSlug(route.relatedEntity),
      relatedLabel: pluralLabel(route.relatedEntity),
    });
    associationsByOwner.set(route.ownerEntity, list);
  }
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
      searchableFields: [...config.searchableFields],
      stateField,
      transitions,
      operationIds: {
        list: `${camel}.list`,
        read: `${camel}.read`,
        create: `${camel}.create`,
        update: `${camel}.update`,
        delete: `${camel}.delete`,
      },
      associations: associationsByOwner.get(entity.name) ?? [],
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
  /** Optional: surfaces per-tenant formatting + feature flags so the UI can adapt. */
  readonly settingsStore?: SettingsStore;
  /** Optional: surfaces the signed-in person's own name and email. See {@link UiUserIdentityResolver}. */
  readonly userIdentity?: UiUserIdentityResolver;
}

function formattingFromSettings(settings: TenantSettings): UiFormatting {
  const d = settings.defaults ?? {};
  return {
    ...(d.currency !== undefined ? { currency: d.currency } : {}),
    ...(d.locale !== undefined ? { locale: d.locale } : {}),
    ...(d.dateFormat !== undefined ? { dateFormat: d.dateFormat } : {}),
    ...(d.numberFormat !== undefined ? { numberFormat: d.numberFormat } : {}),
    ...(d.weekStartDay !== undefined ? { weekStartDay: d.weekStartDay } : {}),
  };
}

/** Read-only schema endpoint: any authenticated principal may read the UI shape. */
export function buildUiSchemaHandler(ctx: UiSchemaContext): Handler {
  return async ({ principal }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) {
      return json(401, { error: "tenant_required" });
    }
    const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
    const all = [primaryRole, ...(secondaryRoles ?? [])].map((r) => String(r)).filter((r) => r.length > 0);
    // The id was in scope at this handler all along and discarded here, which is why a console
    // could name the role you signed in with and not the person holding it — and why a person
    // could not be shown their own record, the detail route being reached by an id the client
    // never had. One property access, no store read.
    const userId = principalUserId(principal);
    const identity =
      userId !== null && ctx.userIdentity !== undefined ? await ctx.userIdentity(userId) : null;
    const viewer: UiViewer = {
      primaryRole: String(primaryRole),
      roles: [...new Set(all)],
      userId,
      principalKind: principal?.principalKind ?? null,
      // Spread, so an unresolved identity leaves the keys **absent** rather than null — the
      // distinction `UiViewer` draws between "the row carries no name" and "nobody looked".
      ...(identity !== null ? { displayName: identity.displayName, email: identity.email } : {}),
    };
    let extra: { formatting?: UiFormatting; features?: Readonly<Record<string, boolean>> } = {};
    if (ctx.settingsStore !== undefined) {
      const settings = await ctx.settingsStore.get(tenantId);
      extra = {
        formatting: formattingFromSettings(settings),
        ...(settings.features !== undefined ? { features: settings.features } : {}),
      };
    }
    return json(200, { ...ctx.schema, viewer, ...extra });
  };
}
