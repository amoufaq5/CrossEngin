import { renderHydratablePage } from "@crossengin/operate-web-react";
import type { WebPageState } from "@crossengin/operate-web-react";
import type {
  CalendarModel,
  DashboardModel,
  DetailModel,
  FormModel,
  KanbanModel,
  MapModel,
  PivotModel,
  ReportData,
  TableModel,
  WebAppModel,
} from "@crossengin/operate-web";

import { jsonResponse, type RawWebResponse } from "./http.js";

/** The base path the SSR'd pages + the hydrated client build their links under. */
const APP_BASE_PATH = "/app";

/** Wraps a server-rendered HTML string into a `text/html` `RawWebResponse`. */
export function htmlResponse(status: number, html: string): RawWebResponse {
  const bytes = new TextEncoder().encode(html);
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": bytes.byteLength.toString(),
    },
    body: bytes,
  };
}

/**
 * Renders a `WebPageState` for an `/app/*` route. By default it's a hydratable
 * HTML page (`#root` + embedded state + the client script); when `stateOnly` is
 * set (the `?__state=1` SPA-navigation request) it returns the *same*
 * already-compiled + redacted `WebPageState` as JSON, so the client router can
 * swap pages without a full reload — reusing the exact server compile/redaction.
 */
function pageFor(state: WebPageState, title: string, stateOnly: boolean): RawWebResponse {
  return stateOnly ? jsonResponse(200, state) : htmlResponse(200, renderHydratablePage(state, { title }));
}

/** Renders the app shell (chrome + per-entity nav) to a hydratable HTML page. */
export function renderAppPage(app: WebAppModel, stateOnly = false): RawWebResponse {
  return pageFor({ kind: "app", app, basePath: APP_BASE_PATH }, app.title, stateOnly);
}

/** Renders an entity table (model + a redacted data page) to a hydratable HTML page. */
export function renderTablePage(
  app: WebAppModel,
  table: TableModel,
  rows: readonly Readonly<Record<string, unknown>>[],
  nextCursor: string | null = null,
  stateOnly = false,
): RawWebResponse {
  return pageFor(
    { kind: "table", app, table, rows, nextCursor, basePath: APP_BASE_PATH },
    `${table.title} — ${app.title}`,
    stateOnly,
  );
}

/** Renders a kanban board (model + a redacted data page) to a hydratable HTML page. */
export function renderKanbanPage(
  app: WebAppModel,
  kanban: KanbanModel,
  rows: readonly Readonly<Record<string, unknown>>[],
  stateOnly = false,
): RawWebResponse {
  return pageFor(
    { kind: "kanban", app, kanban, rows, basePath: APP_BASE_PATH },
    `${kanban.title} — ${app.title}`,
    stateOnly,
  );
}

/** Renders a calendar (model + a redacted data page) to a hydratable HTML page. */
export function renderCalendarPage(
  app: WebAppModel,
  calendar: CalendarModel,
  rows: readonly Readonly<Record<string, unknown>>[],
  stateOnly = false,
): RawWebResponse {
  return pageFor(
    { kind: "calendar", app, calendar, rows, basePath: APP_BASE_PATH },
    `${calendar.title} — ${app.title}`,
    stateOnly,
  );
}

/** Renders a map (model + a redacted marker data page) to a hydratable HTML page. */
export function renderMapPage(
  app: WebAppModel,
  map: MapModel,
  rows: readonly Readonly<Record<string, unknown>>[],
  stateOnly = false,
): RawWebResponse {
  return pageFor(
    { kind: "map", app, map, rows, basePath: APP_BASE_PATH },
    `${map.title} — ${app.title}`,
    stateOnly,
  );
}

/** Renders a dashboard (layout + executed report data per cell) to a hydratable HTML page. */
export function renderDashboardPage(
  app: WebAppModel,
  dashboard: DashboardModel,
  widgetData: readonly (ReportData | null)[],
  stateOnly = false,
): RawWebResponse {
  return pageFor(
    { kind: "dashboard", app, dashboard, widgetData, basePath: APP_BASE_PATH },
    `${dashboard.title} — ${app.title}`,
    stateOnly,
  );
}

/** Renders a pivot (the report reference + reshape flag + executed pivot data) to a hydratable HTML page. */
export function renderPivotPage(
  app: WebAppModel,
  pivot: PivotModel,
  data: ReportData | null,
  stateOnly = false,
): RawWebResponse {
  return pageFor(
    { kind: "pivot", app, pivot, data, basePath: APP_BASE_PATH },
    `${pivot.title} — ${app.title}`,
    stateOnly,
  );
}

/** Renders a record detail (model + the redacted record) to a hydratable HTML page. */
export function renderDetailPage(
  app: WebAppModel,
  detail: DetailModel,
  record: Readonly<Record<string, unknown>>,
  permissions: { canEdit: boolean; canDelete: boolean } = { canEdit: false, canDelete: false },
  stateOnly = false,
): RawWebResponse {
  return pageFor(
    {
      kind: "detail",
      app,
      detail,
      record,
      basePath: APP_BASE_PATH,
      canEdit: permissions.canEdit,
      canDelete: permissions.canDelete,
    },
    `${detail.title} — ${app.title}`,
    stateOnly,
  );
}

/**
 * Renders a form to a hydratable HTML page. With an `edit` argument (the record
 * id + prefill values) it's an edit form the hydrated client PATCHes; without,
 * a create form (POST).
 */
export function renderFormPage(
  app: WebAppModel,
  form: FormModel,
  edit?: { entityId: string; values: Readonly<Record<string, unknown>> },
  stateOnly = false,
): RawWebResponse {
  return pageFor(
    {
      kind: "form",
      app,
      form,
      basePath: APP_BASE_PATH,
      ...(edit !== undefined ? { entityId: edit.entityId, values: edit.values } : {}),
    },
    `${form.title} — ${app.title}`,
    stateOnly,
  );
}
