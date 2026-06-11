import {
  fieldTypeToSchema,
  manifestRouteSpecs,
  nullableSchema,
  type OpenApiSchema,
  type TransitionSpec,
} from "@crossengin/operate-runtime";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity, Field } from "@crossengin/types/meta-schema";

import { compileWebApp } from "./compile.js";
import { webModelSchemas } from "./model-schema.js";
import { EntityFieldResolver, entityFields, type CompileOptions, type ViewerContext } from "./viewer.js";

/**
 * Discovery descriptor for the operate-web view-model API (the parity sibling of
 * operate-server's `GET /v1/openapi.json`). It is **per-caller**: built over
 * `compileWebApp`, so an entity's `kanban` / `calendar` / `map` / `dashboard` /
 * `pivot` routes appear only when that view compiles non-null for the viewer
 * (an authored axis field the caller can read). `table` / `detail` / `form` are
 * always present. Pure data — no DOM/handler references.
 */
export type WebViewKind =
  | "app"
  | "describe"
  | "table"
  | "detail"
  | "form"
  | "kanban"
  | "calendar"
  | "map"
  | "dashboard"
  | "pivot"
  | "create"
  | "update"
  | "delete"
  | "transition";

export type WebHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface WebRouteDescriptor {
  readonly kind: WebViewKind;
  readonly method: WebHttpMethod;
  /** Concrete path; record routes carry a `{id}` placeholder, e.g. `/ui/Product/{id}`. */
  readonly path: string;
  readonly entity?: string;
  /** For a `transition` route: the lifecycle transition name (the request body's `transition`). */
  readonly transition?: string;
  /**
   * The response envelope schema (P3.36) — the shape the route returns, with the
   * view model referenced via a `$ref` into the descriptor's `models` map (e.g. a
   * table route → `{ table: $ref TableModel, page }`). Absent for routes with no
   * body (`delete` → 204, `describe`).
   */
  readonly responseSchema?: OpenApiSchema;
}

export interface WebEntityDescriptor {
  readonly entity: string;
  readonly label: string;
  readonly views: readonly WebViewKind[];
  readonly routes: readonly WebRouteDescriptor[];
  /**
   * The OpenAPI object schema of the fields the caller can **read** (P3.34) — the
   * redaction-aware, per-caller parity of operate-server's component schema. A
   * field the viewer can't read is dropped, so a cashier's `Product` schema omits
   * `unit_cost` while a manager's includes it. Optional fields are nullable.
   */
  readonly schema: OpenApiSchema;
}

export interface WebApiDescriptor {
  readonly title: string;
  /** Entity-independent routes (`/ui/app`, `/ui/_describe`). */
  readonly routes: readonly WebRouteDescriptor[];
  readonly entities: readonly WebEntityDescriptor[];
  /**
   * The view-model *shapes* (`TableModel` / `DetailModel` / `FormModel` / …) as
   * OpenAPI schemas (P3.35), so a UI client can type the `/ui` route envelopes.
   * Caller-independent — the model shape is the same for every viewer (the data
   * + which fields appear are redacted per-caller).
   */
  readonly models: Readonly<Record<string, OpenApiSchema>>;
}

/** Maps a view kind → its concrete route path for an entity. */
const VIEW_ROUTE: Readonly<Record<string, (entity: string) => { readonly kind: WebViewKind; readonly path: string }>> = {
  table: (e) => ({ kind: "table", path: `/ui/${e}` }),
  detail: (e) => ({ kind: "detail", path: `/ui/${e}/{id}` }),
  form: (e) => ({ kind: "form", path: `/ui/${e}/new` }),
  kanban: (e) => ({ kind: "kanban", path: `/ui/${e}/kanban` }),
  calendar: (e) => ({ kind: "calendar", path: `/ui/${e}/calendar` }),
  map: (e) => ({ kind: "map", path: `/ui/${e}/map` }),
  dashboard: (e) => ({ kind: "dashboard", path: `/ui/${e}/dashboard` }),
  pivot: (e) => ({ kind: "pivot", path: `/ui/${e}/pivot` }),
};

/** The path the discovery descriptor is served at. */
export const WEB_DESCRIBE_PATH = "/ui/_describe";

/** Groups each entity's `entityLifecycle` transition specs by entity name. */
function transitionsByEntity(manifest: Manifest): ReadonlyMap<string, readonly TransitionSpec[]> {
  const out = new Map<string, TransitionSpec[]>();
  for (const spec of manifestRouteSpecs(manifest)) {
    if (spec.action === "transition" && spec.transition !== undefined) {
      const list = out.get(spec.entity) ?? [];
      list.push(spec.transition);
      out.set(spec.entity, list);
    }
  }
  return out;
}

/** A `$ref` into the descriptor's own `models` map (P3.36). */
function modelRef(name: string): OpenApiSchema {
  return { $ref: `#/models/${name}` };
}

/** The keyset `page` wrapper shared by the list-bearing view routes. */
const PAGE_SCHEMA: OpenApiSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: { type: "object", additionalProperties: true } },
    nextCursor: { type: ["string", "null"] },
  },
};

/** A redacted record (the precise field shape is the per-caller entity `schema`). */
const RECORD_SCHEMA: OpenApiSchema = { type: "object", additionalProperties: true };

function withModelAndPage(key: string, model: string): OpenApiSchema {
  return { type: "object", properties: { [key]: modelRef(model), page: PAGE_SCHEMA }, required: [key, "page"] };
}

/**
 * The response envelope a route returns (P3.36), with the view model referenced
 * via a `$ref` into the descriptor's `models` map — so a client can resolve the
 * full model shape. Mirrors exactly what `apps/operate-web`'s server returns.
 * `delete` (204) and `describe` (self) have no body schema.
 */
function envelopeSchemaFor(kind: WebViewKind): OpenApiSchema | undefined {
  switch (kind) {
    case "app":
      return modelRef("WebAppModel");
    case "table":
      return withModelAndPage("table", "TableModel");
    case "kanban":
      return withModelAndPage("kanban", "KanbanModel");
    case "calendar":
      return withModelAndPage("calendar", "CalendarModel");
    case "map":
      return withModelAndPage("map", "MapModel");
    case "dashboard":
      return {
        type: "object",
        properties: { dashboard: modelRef("DashboardModel"), widgetData: { type: "object", additionalProperties: true } },
        required: ["dashboard", "widgetData"],
      };
    case "pivot":
      return {
        type: "object",
        properties: { pivot: modelRef("PivotModel"), data: { type: "object", additionalProperties: true } },
        required: ["pivot", "data"],
      };
    case "detail":
      return { type: "object", properties: { detail: modelRef("DetailModel"), record: RECORD_SCHEMA }, required: ["detail", "record"] };
    case "form":
      return { type: "object", properties: { form: modelRef("FormModel") }, required: ["form"] };
    case "create":
    case "update":
    case "transition":
      return { type: "object", properties: { record: RECORD_SCHEMA }, required: ["record"] };
    case "delete":
    case "describe":
      return undefined;
  }
}

/**
 * The RBAC-gated mutation routes the caller may invoke on an entity (P3.28):
 * `create` (POST), `update` (PATCH), `delete` (DELETE) per
 * `EntityFieldResolver.canPerform`, plus one `transition` route per
 * `entityLifecycle` transition the caller may fire (`canTransition`). A route the
 * caller can't perform is omitted — the descriptor reflects what they can write.
 */
function mutationRoutes(
  manifest: Manifest,
  entity: string,
  viewer: ViewerContext,
  options: CompileOptions,
  transitions: readonly TransitionSpec[],
): readonly WebRouteDescriptor[] {
  const resolver = new EntityFieldResolver(manifest, entity, viewer, options);
  const routes: WebRouteDescriptor[] = [];
  if (resolver.canPerform("create").allowed) {
    routes.push({ kind: "create", method: "POST", path: `/ui/${entity}`, entity, responseSchema: envelopeSchemaFor("create") });
  }
  if (resolver.canPerform("update").allowed) {
    routes.push({ kind: "update", method: "PATCH", path: `/ui/${entity}/{id}`, entity, responseSchema: envelopeSchemaFor("update") });
  }
  if (resolver.canPerform("delete").allowed) {
    routes.push({ kind: "delete", method: "DELETE", path: `/ui/${entity}/{id}`, entity });
  }
  for (const t of transitions) {
    if (resolver.canTransition(t.name).allowed) {
      routes.push({
        kind: "transition",
        method: "POST",
        path: `/ui/${entity}/{id}/transition`,
        entity,
        transition: t.name,
        responseSchema: envelopeSchemaFor("transition"),
      });
    }
  }
  return routes;
}

/**
 * Builds the redaction-aware OpenAPI object schema for an entity (P3.34): a typed
 * property per field the viewer can **read** (via `EntityFieldResolver`), plus a
 * string `id`. A field the caller can't read is dropped (parity with the
 * model/data redaction); optional fields are nullable. Reuses operate-runtime's
 * `fieldTypeToSchema` so the field→schema mapping is identical to operate-server.
 */
function entitySchemaForViewer(
  manifest: Manifest,
  entity: Entity,
  viewer: ViewerContext,
  options: CompileOptions,
): OpenApiSchema {
  const access = new EntityFieldResolver(manifest, entity.name, viewer, options).resolve(entityFields(entity));
  const properties: Record<string, OpenApiSchema> = { id: { type: "string" } };
  const required: string[] = [];
  for (const field of entity.fields as readonly Field[]) {
    if (access.get(field.name)?.read === false) continue;
    const base = fieldTypeToSchema(field.type);
    if (field.required === true) {
      properties[field.name] = base;
      required.push(field.name);
    } else {
      properties[field.name] = nullableSchema(base);
    }
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * Builds the per-caller discovery descriptor: every entity (with its
 * caller-available view-model routes + the RBAC-gated mutation routes it may
 * invoke + the redaction-aware field schema) plus the global routes. Read routes
 * reuse `compileWebApp` (so they can't drift); write routes are gated by
 * `EntityFieldResolver` — the same RBAC the server enforces, so the descriptor
 * reflects exactly what the caller can do + see.
 */
export function describeWebApi(
  manifest: Manifest,
  viewer: ViewerContext,
  options: CompileOptions = {},
): WebApiDescriptor {
  const app = compileWebApp(manifest, viewer);
  const transitions = transitionsByEntity(manifest);
  const entitiesByName = new Map((manifest.entities ?? []).map((e) => [e.name, e]));
  const entities: WebEntityDescriptor[] = app.nav.map((nav) => {
    const entity = entitiesByName.get(nav.entity);
    return {
      entity: nav.entity,
      label: nav.label,
      views: [...nav.views],
      routes: [
        ...nav.views.map((view): WebRouteDescriptor => {
          const r = VIEW_ROUTE[view]!(nav.entity);
          const responseSchema = envelopeSchemaFor(r.kind);
          return { kind: r.kind, method: "GET", path: r.path, entity: nav.entity, ...(responseSchema !== undefined ? { responseSchema } : {}) };
        }),
        ...mutationRoutes(manifest, nav.entity, viewer, options, transitions.get(nav.entity) ?? []),
      ],
      schema:
        entity !== undefined
          ? entitySchemaForViewer(manifest, entity, viewer, options)
          : { type: "object", properties: { id: { type: "string" } } },
    };
  });
  return {
    title: app.title,
    routes: [
      { kind: "app", method: "GET", path: "/ui/app", responseSchema: envelopeSchemaFor("app") },
      { kind: "describe", method: "GET", path: WEB_DESCRIBE_PATH },
    ],
    entities,
    models: webModelSchemas(),
  };
}
