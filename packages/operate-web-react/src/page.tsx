import type { FormModel, KanbanModel, TableModel } from "@crossengin/operate-web";
import { useState, type DragEvent, type FormEvent, type JSX } from "react";

import { AppShell, CalendarView, DashboardView, DetailView, FormView, MapView, PivotView, TableView, displayValue } from "./components.js";
import {
  buildListQueryUrl,
  coerceFormValues,
  defaultWriteFetcher,
  planCardTransition,
  submitDelete,
  submitFormWrite,
  submitTransition,
  type WriteFetcher,
} from "./page-state.js";
import type { WebPageState } from "./page-state.js";

/** Navigates the browser to a URL; the default `onNavigate` for the write sections. */
const defaultNavigate = (url: string): void => {
  if (typeof window !== "undefined") window.location.assign(url);
};

/** The shape of a `/ui/:entity` JSON page the client refetches on sort/paginate. */
interface ListJsonPage {
  readonly table: TableModel;
  readonly page: {
    readonly data: readonly Readonly<Record<string, unknown>>[];
    readonly nextCursor: string | null;
  };
}

/** Injectable fetcher so the interactive table is testable without a real network. */
export type ListPageFetcher = (url: string) => Promise<ListJsonPage>;

const defaultFetcher: ListPageFetcher = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`list fetch failed: ${res.status.toString()}`);
  return (await res.json()) as ListJsonPage;
};

interface TableSectionProps {
  readonly table: TableModel;
  readonly initialRows: readonly Readonly<Record<string, unknown>>[];
  readonly initialCursor: string | null;
  readonly basePath: string;
  /** Test seam: defaults to the global `fetch`-backed fetcher. */
  readonly fetcher?: ListPageFetcher;
}

/**
 * A stateful table: it renders the same `TableView` markup the SSR produced (so
 * hydration matches), plus sort-toggle column buttons and Prev/Next pagination.
 * Interactions refetch the existing `/ui/:entity` JSON endpoint and swap the
 * rows + cursor in local state — no full page reload, no new server route.
 *
 * Pagination is forward-only (the JSON API exposes a keyset `nextCursor`); a
 * cursor stack records visited pages so Prev walks back. Sort toggles asc/desc
 * on a sortable column and resets to the first page.
 */
function TableSection({
  table,
  initialRows,
  initialCursor,
  basePath,
  fetcher = defaultFetcher,
}: TableSectionProps): JSX.Element {
  const [rows, setRows] = useState<readonly Readonly<Record<string, unknown>>[]>(initialRows);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [cursorStack, setCursorStack] = useState<readonly (string | null)[]>([null]);
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [busy, setBusy] = useState(false);

  async function load(
    nextCursor: string | null,
    field: string | null,
    order: "asc" | "desc",
    stack: readonly (string | null)[],
  ): Promise<void> {
    setBusy(true);
    try {
      const url = buildListQueryUrl(table.entity, {
        cursor: nextCursor,
        ...(field !== null ? { sort: field, order } : {}),
      });
      const json = await fetcher(url);
      setRows(json.page.data);
      setCursor(json.page.nextCursor);
      setCursorStack(stack);
    } finally {
      setBusy(false);
    }
  }

  function toggleSort(field: string): void {
    const order: "asc" | "desc" = sortField === field && sortOrder === "asc" ? "desc" : "asc";
    setSortField(field);
    setSortOrder(order);
    void load(null, field, order, [null]);
  }

  function next(): void {
    if (cursor === null) return;
    void load(cursor, sortField, sortOrder, [...cursorStack, cursor]);
  }

  function prev(): void {
    if (cursorStack.length <= 1) return;
    const newStack = cursorStack.slice(0, -1);
    const target = newStack[newStack.length - 1] ?? null;
    void load(target, sortField, sortOrder, newStack);
  }

  return (
    <div className="ce-table-interactive">
      <div className="ce-table-controls" role="group" aria-label="Sort">
        {table.columns
          .filter((c) => c.sortable)
          .map((c) => (
            <button
              key={c.field}
              type="button"
              data-sort-field={c.field}
              disabled={busy}
              onClick={() => {
                toggleSort(c.field);
              }}
            >
              {`Sort ${c.label}${sortField === c.field ? (sortOrder === "asc" ? " ↑" : " ↓") : ""}`}
            </button>
          ))}
      </div>
      <TableView model={table} rows={rows} basePath={basePath} />
      <div className="ce-table-pagination" role="group" aria-label="Pagination">
        <button
          type="button"
          data-action="prev"
          disabled={busy || cursorStack.length <= 1}
          onClick={prev}
        >
          Prev
        </button>
        <button type="button" data-action="next" disabled={busy || cursor === null} onClick={next}>
          Next
        </button>
      </div>
    </div>
  );
}

interface FormSectionProps {
  readonly form: FormModel;
  /** Present for an edit form (PATCH target); absent → create (POST). */
  readonly entityId?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly basePath: string;
  /** Test seams: default to the global fetch + browser navigation. */
  readonly writeFetcher?: WriteFetcher;
  readonly onNavigate?: (url: string) => void;
}

/**
 * A stateful form: renders the same `FormView` markup the SSR produced, but on
 * submit collects the field values (`FormData` → typed payload via
 * `coerceFormValues`), POSTs (create) / PATCHes (edit) the P3.8 `/ui/:entity`
 * write route, and on success navigates to the record's detail page. A 4xx
 * surfaces the server's problem `detail` (e.g. a write-mask 422) inline; the
 * server stays the source of truth for RBAC + the write mask.
 */
function FormSection({
  form,
  entityId,
  values,
  basePath,
  writeFetcher = defaultWriteFetcher,
  onNavigate = defaultNavigate,
}: FormSectionProps): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const raw: Record<string, string | boolean> = {};
    const data = new FormData(event.currentTarget);
    for (const [key, value] of data.entries()) {
      raw[key] = typeof value === "string" ? value : "";
    }
    // Unchecked checkboxes are absent from FormData; coerceFormValues defaults them to false.
    setSubmitting(true);
    setStatus(null);
    try {
      const result = await submitFormWrite({
        entity: form.entity,
        ...(entityId !== undefined ? { entityId } : {}),
        payload: coerceFormValues(form, raw),
        fetcher: writeFetcher,
      });
      if (result.ok) {
        const id = entityId ?? (typeof result.record?.["id"] === "string" ? (result.record["id"] as string) : null);
        onNavigate(id !== null ? `${basePath}/${form.entity}/${id}` : `${basePath}/${form.entity}`);
        return;
      }
      setStatus(result.detail ?? `write failed (${result.status.toString()})`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormView
      model={form}
      {...(values !== undefined ? { values } : {})}
      submitting={submitting}
      onSubmit={(e) => void handleSubmit(e)}
      {...(status !== null ? { statusNode: status } : {})}
    />
  );
}

interface DetailWriteProps {
  readonly state: Extract<WebPageState, { kind: "detail" }>;
  readonly writeFetcher?: WriteFetcher;
  readonly onNavigate?: (url: string) => void;
}

/**
 * A `DetailView` plus write affordances: an Edit link (when the caller may
 * PATCH) and a Delete button (when the caller may DELETE) — both gated by the
 * server-computed `canEdit`/`canDelete` flags, so an unauthorized caller never
 * even sees the control (the server still enforces RBAC on the request). Delete
 * navigates back to the entity table on success.
 */
function DetailSection({ state, writeFetcher = defaultWriteFetcher, onNavigate = defaultNavigate }: DetailWriteProps): JSX.Element {
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const entity = state.detail.entity;
  const id = typeof state.record["id"] === "string" ? (state.record["id"] as string) : "";

  async function handleDelete(): Promise<void> {
    if (id.length === 0) return;
    setDeleting(true);
    setStatus(null);
    try {
      const result = await submitDelete(entity, id, writeFetcher);
      if (result.ok) {
        onNavigate(`${state.basePath}/${entity}`);
        return;
      }
      setStatus(result.detail ?? `delete failed (${result.status.toString()})`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="ce-detail-interactive">
      <DetailView model={state.detail} record={state.record} />
      <div className="ce-detail-actions" role="group" aria-label="Record actions">
        {state.canEdit && id.length > 0 ? (
          <a className="ce-action-edit" data-action="edit" href={`${state.basePath}/${entity}/${id}/edit`}>
            Edit
          </a>
        ) : null}
        {state.canDelete && id.length > 0 ? (
          <button type="button" data-action="delete" disabled={deleting} onClick={() => void handleDelete()}>
            Delete
          </button>
        ) : null}
      </div>
      {status !== null ? <div className="ce-detail-status" role="status">{status}</div> : null}
    </div>
  );
}

interface KanbanSectionProps {
  readonly model: KanbanModel;
  readonly initialRows: readonly Readonly<Record<string, unknown>>[];
  readonly basePath: string;
  readonly writeFetcher?: WriteFetcher;
}

/**
 * A stateful kanban board: renders one column per declared state with the cards
 * whose `stateField` matches, and — when the model carries RBAC-gated
 * `transitions` — makes the cards draggable. Dropping a card on a column resolves
 * the bridging transition (`planCardTransition`), POSTs it
 * (`/ui/:entity/:id/transition`), and on success moves the card into the target
 * column in local state (no reload). A drop with no valid transition, or a server
 * 4xx (RBAC 403 / from-state 409), surfaces inline and leaves the card put. The
 * SSR renders the same markup so hydration matches; live drag is a manual smoke.
 */
function KanbanSection({ model, initialRows, basePath, writeFetcher = defaultWriteFetcher }: KanbanSectionProps): JSX.Element {
  const [rows, setRows] = useState<readonly Readonly<Record<string, unknown>>[]>(initialRows);
  const [dragId, setDragId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const draggable = model.transitions.length > 0;

  function onDragStart(id: string): void {
    setDragId(id);
  }

  async function onDropColumn(toState: string): Promise<void> {
    const id = dragId;
    setDragId(null);
    if (id === null || busy) return;
    const card = rows.find((r) => displayValue(r["id"]) === id);
    if (card === undefined) return;
    const fromState = displayValue(card[model.stateField]);
    const name = planCardTransition(model.transitions, fromState, toState);
    if (name === null) {
      setStatus(`no transition from ${fromState} to ${toState}`);
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const result = await submitTransition(model.entity, id, name, writeFetcher);
      if (result.ok) {
        setRows((rs) => rs.map((r) => (displayValue(r["id"]) === id ? { ...r, [model.stateField]: toState } : r)));
        return;
      }
      setStatus(result.detail ?? `transition failed (${result.status.toString()})`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ce-kanban" data-entity={model.entity} data-state-field={model.stateField} data-interactive={draggable ? "true" : "false"}>
      <h2 className="ce-kanban-title">{model.title}</h2>
      <div className="ce-kanban-board">
        {model.columns.map((col) => {
          const cards = rows.filter((r) => displayValue(r[model.stateField]) === col.state);
          return (
            <div
              key={col.state}
              className="ce-kanban-column"
              data-state={col.state}
              onDragOver={draggable ? (e: DragEvent) => e.preventDefault() : undefined}
              onDrop={draggable ? () => void onDropColumn(col.state) : undefined}
            >
              <h3 className="ce-kanban-column-title">
                {col.label}
                <span className="ce-kanban-count"> ({String(cards.length)}{col.wipLimit !== undefined ? `/${String(col.wipLimit)}` : ""})</span>
              </h3>
              <ul className="ce-kanban-cards">
                {cards.map((row, index) => {
                  const id = displayValue(row["id"]);
                  return (
                    <li
                      key={id.length > 0 ? id : `card-${String(index)}`}
                      className="ce-kanban-card"
                      data-id={id}
                      draggable={draggable && id.length > 0}
                      onDragStart={draggable ? () => onDragStart(id) : undefined}
                    >
                      <dl className="ce-kanban-card-fields">
                        {model.cardFields.map((field) => (
                          <div key={field.field} className="ce-kanban-card-field" data-field={field.field}>
                            <dt>{field.label}</dt>
                            <dd>{displayValue(row[field.field])}</dd>
                          </div>
                        ))}
                      </dl>
                      {id.length > 0 ? <a className="ce-kanban-card-link" href={`${basePath}/${model.entity}/${id}`}>Open</a> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {status !== null ? <div className="ce-kanban-status" role="status">{status}</div> : null}
    </section>
  );
}

export interface PageRootProps {
  readonly state: WebPageState;
  /** Test seam threaded to the interactive table. */
  readonly fetcher?: ListPageFetcher;
  /** Test seam threaded to the write sections (form submit / detail delete). */
  readonly writeFetcher?: WriteFetcher;
  /** Test seam for navigation after a successful write. */
  readonly onNavigate?: (url: string) => void;
}

/**
 * The single component the SSR renders AND the client hydrates: it switches on
 * the embedded `WebPageState.kind` and renders the matching tree inside the app
 * shell. The table page is interactive (sort + pagination over the JSON API);
 * detail / form / app are static (row links navigate to SSR pages, which is all
 * a read-only surface needs). Rendering one component on both sides guarantees
 * the markup matches so `hydrateRoot` attaches cleanly.
 */
export function PageRoot({ state, fetcher, writeFetcher, onNavigate }: PageRootProps): JSX.Element {
  switch (state.kind) {
    case "app":
      return <AppShell app={state.app} basePath={state.basePath} />;
    case "table":
      return (
        <AppShell app={state.app} basePath={state.basePath}>
          <TableSection
            table={state.table}
            initialRows={state.rows}
            initialCursor={state.nextCursor}
            basePath={state.basePath}
            {...(fetcher !== undefined ? { fetcher } : {})}
          />
        </AppShell>
      );
    case "detail":
      return (
        <AppShell app={state.app} basePath={state.basePath}>
          <DetailSection
            state={state}
            {...(writeFetcher !== undefined ? { writeFetcher } : {})}
            {...(onNavigate !== undefined ? { onNavigate } : {})}
          />
        </AppShell>
      );
    case "form":
      return (
        <AppShell app={state.app} basePath={state.basePath}>
          <FormSection
            form={state.form}
            {...(state.entityId !== undefined ? { entityId: state.entityId } : {})}
            {...(state.values !== undefined ? { values: state.values } : {})}
            basePath={state.basePath}
            {...(writeFetcher !== undefined ? { writeFetcher } : {})}
            {...(onNavigate !== undefined ? { onNavigate } : {})}
          />
        </AppShell>
      );
    case "kanban":
      return (
        <AppShell app={state.app} basePath={state.basePath}>
          <KanbanSection
            model={state.kanban}
            initialRows={state.rows}
            basePath={state.basePath}
            {...(writeFetcher !== undefined ? { writeFetcher } : {})}
          />
        </AppShell>
      );
    case "calendar":
      return (
        <AppShell app={state.app} basePath={state.basePath}>
          <CalendarView model={state.calendar} rows={state.rows} basePath={state.basePath} />
        </AppShell>
      );
    case "map":
      return (
        <AppShell app={state.app} basePath={state.basePath}>
          <MapView model={state.map} rows={state.rows} basePath={state.basePath} />
        </AppShell>
      );
    case "dashboard":
      return (
        <AppShell app={state.app} basePath={state.basePath}>
          <DashboardView model={state.dashboard} widgetData={state.widgetData} />
        </AppShell>
      );
    case "pivot":
      return (
        <AppShell app={state.app} basePath={state.basePath}>
          <PivotView model={state.pivot} data={state.data} />
        </AppShell>
      );
  }
}
