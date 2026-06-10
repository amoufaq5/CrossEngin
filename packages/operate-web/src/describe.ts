import type { Manifest } from "@crossengin/kernel/manifest";

import { compileWebApp } from "./compile.js";
import type { ViewerContext } from "./viewer.js";

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
  | "pivot";

export interface WebRouteDescriptor {
  readonly kind: WebViewKind;
  readonly method: "GET";
  /** Concrete path; record routes carry a `{id}` placeholder, e.g. `/ui/Product/{id}`. */
  readonly path: string;
  readonly entity?: string;
}

export interface WebEntityDescriptor {
  readonly entity: string;
  readonly label: string;
  readonly views: readonly WebViewKind[];
  readonly routes: readonly WebRouteDescriptor[];
}

export interface WebApiDescriptor {
  readonly title: string;
  /** Entity-independent routes (`/ui/app`, `/ui/_describe`). */
  readonly routes: readonly WebRouteDescriptor[];
  readonly entities: readonly WebEntityDescriptor[];
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

/**
 * Builds the per-caller discovery descriptor: every entity (with its
 * caller-available view kinds → concrete route paths) plus the global routes.
 * Reuses `compileWebApp`, so it can't drift from what the server actually serves.
 */
export function describeWebApi(manifest: Manifest, viewer: ViewerContext): WebApiDescriptor {
  const app = compileWebApp(manifest, viewer);
  const entities: WebEntityDescriptor[] = app.nav.map((nav) => ({
    entity: nav.entity,
    label: nav.label,
    views: [...nav.views],
    routes: nav.views.map((view) => {
      const r = VIEW_ROUTE[view]!(nav.entity);
      return { kind: r.kind, method: "GET", path: r.path, entity: nav.entity };
    }),
  }));
  return {
    title: app.title,
    routes: [
      { kind: "app", method: "GET", path: "/ui/app" },
      { kind: "describe", method: "GET", path: WEB_DESCRIBE_PATH },
    ],
    entities,
  };
}
