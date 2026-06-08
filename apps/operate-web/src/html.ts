import { renderHydratablePage } from "@crossengin/operate-web-react";
import type { WebPageState } from "@crossengin/operate-web-react";
import type {
  DetailModel,
  FormModel,
  TableModel,
  WebAppModel,
} from "@crossengin/operate-web";

import type { RawWebResponse } from "./http.js";

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

/** Renders a `WebPageState` to a hydratable HTML page (`#root` + state + client). */
function pageFor(state: WebPageState, title: string): RawWebResponse {
  return htmlResponse(200, renderHydratablePage(state, { title }));
}

/** Renders the app shell (chrome + per-entity nav) to a hydratable HTML page. */
export function renderAppPage(app: WebAppModel): RawWebResponse {
  return pageFor({ kind: "app", app, basePath: APP_BASE_PATH }, app.title);
}

/** Renders an entity table (model + a redacted data page) to a hydratable HTML page. */
export function renderTablePage(
  app: WebAppModel,
  table: TableModel,
  rows: readonly Readonly<Record<string, unknown>>[],
  nextCursor: string | null = null,
): RawWebResponse {
  return pageFor(
    { kind: "table", app, table, rows, nextCursor, basePath: APP_BASE_PATH },
    `${table.title} — ${app.title}`,
  );
}

/** Renders a record detail (model + the redacted record) to a hydratable HTML page. */
export function renderDetailPage(
  app: WebAppModel,
  detail: DetailModel,
  record: Readonly<Record<string, unknown>>,
): RawWebResponse {
  return pageFor(
    { kind: "detail", app, detail, record, basePath: APP_BASE_PATH },
    `${detail.title} — ${app.title}`,
  );
}

/** Renders a create form to a hydratable HTML page. */
export function renderFormPage(app: WebAppModel, form: FormModel): RawWebResponse {
  return pageFor(
    { kind: "form", app, form, basePath: APP_BASE_PATH },
    `${form.title} — ${app.title}`,
  );
}
