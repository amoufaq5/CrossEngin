import type { TableModel } from "@crossengin/operate-web";
import { useState, type JSX } from "react";

import { AppShell, DetailView, FormView, TableView } from "./components.js";
import { buildListQueryUrl } from "./page-state.js";
import type { WebPageState } from "./page-state.js";

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

export interface PageRootProps {
  readonly state: WebPageState;
  /** Test seam threaded to the interactive table. */
  readonly fetcher?: ListPageFetcher;
}

/**
 * The single component the SSR renders AND the client hydrates: it switches on
 * the embedded `WebPageState.kind` and renders the matching tree inside the app
 * shell. The table page is interactive (sort + pagination over the JSON API);
 * detail / form / app are static (row links navigate to SSR pages, which is all
 * a read-only surface needs). Rendering one component on both sides guarantees
 * the markup matches so `hydrateRoot` attaches cleanly.
 */
export function PageRoot({ state, fetcher }: PageRootProps): JSX.Element {
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
          <DetailView model={state.detail} record={state.record} />
        </AppShell>
      );
    case "form":
      return (
        <AppShell app={state.app} basePath={state.basePath}>
          <FormView model={state.form} />
        </AppShell>
      );
  }
}
