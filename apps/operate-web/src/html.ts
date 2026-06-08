import {
  AppShell,
  DetailView,
  FormView,
  TableView,
  renderPage,
} from "@crossengin/operate-web-react";
import type {
  DetailModel,
  FormModel,
  TableModel,
  WebAppModel,
} from "@crossengin/operate-web";

import type { RawWebResponse } from "./http.js";

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

/** Renders the app shell (chrome + per-entity nav) to a full HTML page. */
export function renderAppPage(app: WebAppModel): RawWebResponse {
  const html = renderPage(AppShell({ app }), { title: app.title });
  return htmlResponse(200, html);
}

/** Renders an entity table (model + a redacted data page) to a full HTML page. */
export function renderTablePage(
  app: WebAppModel,
  table: TableModel,
  rows: readonly Readonly<Record<string, unknown>>[],
): RawWebResponse {
  const html = renderPage(
    AppShell({ app, children: TableView({ model: table, rows }) }),
    { title: `${table.title} — ${app.title}` },
  );
  return htmlResponse(200, html);
}

/** Renders a record detail (model + the redacted record) to a full HTML page. */
export function renderDetailPage(
  app: WebAppModel,
  detail: DetailModel,
  record: Readonly<Record<string, unknown>>,
): RawWebResponse {
  const html = renderPage(
    AppShell({ app, children: DetailView({ model: detail, record }) }),
    { title: `${detail.title} — ${app.title}` },
  );
  return htmlResponse(200, html);
}

/** Renders a create form to a full HTML page. */
export function renderFormPage(app: WebAppModel, form: FormModel): RawWebResponse {
  const html = renderPage(
    AppShell({ app, children: FormView({ model: form }) }),
    { title: `${form.title} — ${app.title}` },
  );
  return htmlResponse(200, html);
}
