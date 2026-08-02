"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/Badge";
import { FieldInput } from "@/components/FieldInput";
import { ReferenceLabel } from "@/components/ReferenceLabel";
import { Topbar } from "@/components/Topbar";
import { createRecord, listRecords, type ListResult } from "@/lib/api";
import { formatCell } from "@/lib/format";
import { invalidateReferenceCache } from "@/lib/reference-cache";
import { canAccess, entityBySlug, slugForEntityName, useSchema, type UiEntitySchema, type UiFieldSchema } from "@/lib/schema";

function cellKind(field: UiFieldSchema | undefined): string | undefined {
  if (field === undefined) return undefined;
  if (field.input === "select") return "badge";
  if (field.input === "date" || field.input === "datetime") return "date";
  if (field.input === "number" && /(total|amount|price|cost|subtotal|tax|budget|salary)/.test(field.name)) return "money";
  if (field.input === "email") return "email";
  return undefined;
}

export default function EntityListPage({ params }: { params: { slug: string } }) {
  const { schema, loading } = useSchema();
  const entity = entityBySlug(schema, params.slug);

  if (loading) return <Shell title="Loading…" />;
  if (entity === undefined) return <Shell title="Unknown entity" note={`No entity for "/e/${params.slug}".`} />;
  return <EntityList key={entity.slug} entity={entity} />;
}

function Shell({ title, note }: { title: string; note?: string }) {
  return (
    <>
      <Topbar title={title} />
      <div className="px-8 py-6 text-sm text-ink-muted">{note ?? "Loading…"}</div>
    </>
  );
}

type ListSortState = { field: string; order: "asc" | "desc" };
interface ListUrlState {
  q: string;
  sort: ListSortState | null;
  filters: Record<string, string>;
}

/**
 * Reads the shareable list state (search / sort / filters) from the URL, validated against the
 * entity so a stale link can't push a non-sortable/non-filterable field. Filters ride under an
 * `fl_` prefix so they never collide with the create-form prefill params (raw field names).
 */
function readInitialListState(entity: UiEntitySchema): ListUrlState {
  if (typeof window === "undefined") return { q: "", sort: null, filters: {} };
  const p = new URLSearchParams(window.location.search);
  const sortField = p.get("sort");
  const sort: ListSortState | null =
    sortField !== null && entity.sortableFields.includes(sortField)
      ? { field: sortField, order: p.get("order") === "desc" ? "desc" : "asc" }
      : null;
  const filters: Record<string, string> = {};
  for (const [k, v] of p.entries()) {
    if (k.startsWith("fl_") && entity.filterableFields.includes(k.slice(3)) && v !== "") filters[k.slice(3)] = v;
  }
  return { q: p.get("q") ?? "", sort, filters };
}

function EntityList({ entity }: { entity: UiEntitySchema }) {
  const { schema } = useSchema();
  const initialState = useMemo(() => readInitialListState(entity), [entity]);
  const [data, setData] = useState<ReadonlyArray<Record<string, unknown>>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState(initialState.q);
  const [debouncedQ, setDebouncedQ] = useState(initialState.q);
  // Server-side search when the entity has searchable (text) fields; else fall back to a
  // client-side filter over the loaded rows.
  const serverSearch = entity.searchableFields.length > 0;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const [sort, setSort] = useState<ListSortState | null>(initialState.sort);
  const [filters, setFilters] = useState<Record<string, string>>(initialState.filters);

  // Mirror the list state into the URL (replace, not push — no history spam) so the view is
  // shareable and survives a refresh. Preserves any unrelated params (e.g. ?new=1 + prefill).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    for (const k of ["q", "sort", "order"]) p.delete(k);
    for (const k of [...p.keys()]) if (k.startsWith("fl_")) p.delete(k);
    if (debouncedQ.trim() !== "") p.set("q", debouncedQ.trim());
    if (sort !== null) {
      p.set("sort", sort.field);
      p.set("order", sort.order);
    }
    for (const [k, v] of Object.entries(filters)) if (v.trim() !== "") p.set(`fl_${k}`, v.trim());
    const qs = p.toString();
    window.history.replaceState(null, "", qs === "" ? window.location.pathname : `${window.location.pathname}?${qs}`);
  }, [debouncedQ, sort, filters]);
  const canCreate = canAccess(schema, entity, "create");
  const [showNew, setShowNew] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("new") === "1",
  );
  // Seed the create form from query params matching field names (e.g. a "Raise WHT
  // certificate" link prefills invoice_id/account_id/currency). Generic across entities.
  const initialValues = useMemo(() => {
    if (typeof window === "undefined") return {};
    const params = new URLSearchParams(window.location.search);
    const out: Record<string, string> = {};
    for (const f of entity.fields) {
      const v = params.get(f.name);
      if (v !== null && v !== "") out[f.name] = v;
    }
    return out;
  }, [entity]);

  const fieldByName = useMemo(() => {
    const m = new Map<string, UiFieldSchema>();
    for (const f of entity.fields) m.set(f.name, f);
    return m;
  }, [entity]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "50");
    if (sort) {
      p.set("sort", sort.field);
      p.set("order", sort.order);
    }
    for (const [k, v] of Object.entries(filters)) if (v.trim() !== "") p.set(k, v.trim());
    if (serverSearch && debouncedQ.trim() !== "") p.set("q", debouncedQ.trim());
    return `?${p.toString()}`;
  }, [sort, filters, serverSearch, debouncedQ]);

  // First page (and reload on query change): replaces the accumulated rows.
  const load = useCallback(() => {
    setBusy(true);
    listRecords(entity.slug, query)
      .then((r: ListResult) => {
        setData(r.data);
        setNextCursor(r.nextCursor);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [entity.slug, query]);

  useEffect(() => load(), [load]);

  // Next page: keyset cursor from the last response, appended to the loaded rows.
  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    listRecords(entity.slug, `${query}&cursor=${encodeURIComponent(nextCursor)}`)
      .then((r: ListResult) => {
        setData((prev) => [...prev, ...r.data]);
        setNextCursor(r.nextCursor);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMore(false));
  }, [entity.slug, query, nextCursor]);

  const rows = useMemo(() => {
    if (serverSearch) return data; // the server already applied ?q across searchable fields
    const needle = q.trim().toLowerCase();
    if (needle === "") return data;
    return data.filter((row) =>
      entity.listColumns.some((c) => String(row[c] ?? "").toLowerCase().includes(needle)),
    );
  }, [data, q, entity.listColumns, serverSearch]);

  function toggleSort(field: string) {
    if (!entity.sortableFields.includes(field)) return;
    setSort((prev) =>
      prev?.field === field ? { field, order: prev.order === "asc" ? "desc" : "asc" } : { field, order: "asc" },
    );
  }

  return (
    <>
      <Topbar title={entity.label} subtitle={`${entity.module} · ${entity.fields.length} fields`} />
      <div className="px-8 py-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${entity.label.toLowerCase()}…`}
            className="w-64 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />
          {entity.filterableFields.slice(0, 3).map((f) => (
            <FilterControl
              key={f}
              field={fieldByName.get(f)}
              value={filters[f] ?? ""}
              onChange={(v) => setFilters((prev) => ({ ...prev, [f]: v }))}
            />
          ))}
          <button onClick={load} className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft">
            Refresh
          </button>
          {canCreate && (
            <button
              onClick={() => setShowNew((s) => !s)}
              className="ml-auto rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
            >
              {showNew ? "Close" : `New ${entity.singular}`}
            </button>
          )}
        </div>

        {showNew && canCreate && (
          <CreateForm
            entity={entity}
            schema={schema}
            initialValues={initialValues}
            onDone={() => {
              setShowNew(false);
              load();
            }}
          />
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">{error}</div>
        )}

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface-soft text-left text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                {entity.listColumns.map((c) => {
                  const sortable = entity.sortableFields.includes(c);
                  const arrow = sort?.field === c ? (sort.order === "asc" ? " ↑" : " ↓") : "";
                  return (
                    <th
                      key={c}
                      onClick={() => toggleSort(c)}
                      className={`px-4 py-2.5 font-semibold ${sortable ? "cursor-pointer hover:text-ink" : ""}`}
                    >
                      {fieldByName.get(c)?.label ?? c}
                      {arrow}
                    </th>
                  );
                })}
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {busy && rows.length === 0 && (
                <tr>
                  <td colSpan={entity.listColumns.length + 1} className="px-4 py-8 text-center text-ink-faint">
                    Loading…
                  </td>
                </tr>
              )}
              {!busy && rows.length === 0 && (
                <tr>
                  <td colSpan={entity.listColumns.length + 1} className="px-4 py-8 text-center text-ink-faint">
                    No records.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const id = String(row["id"] ?? "");
                return (
                  <tr key={id} className="transition hover:bg-surface-soft/60">
                    {entity.listColumns.map((c) => (
                      <td key={c} className="px-4 py-2.5 text-ink">
                        <Cell field={fieldByName.get(c)} value={row[c]} schema={schema} />
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/e/${entity.slug}/${encodeURIComponent(id)}`} className="text-sm font-medium text-brand-600 hover:text-brand-700">
                        Open →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <p className="text-xs text-ink-faint">
            {rows.length} shown
            {q.trim() !== "" && data.length !== rows.length ? ` (of ${data.length} loaded)` : ""}
            {nextCursor !== null ? " · more available" : ""}
          </p>
          {nextCursor !== null && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function Cell({
  field,
  value,
  schema,
}: {
  field: UiFieldSchema | undefined;
  value: unknown;
  schema: ReturnType<typeof useSchema>["schema"];
}) {
  if (value === null || value === undefined || value === "") return <span className="text-ink-faint">—</span>;
  const kind = cellKind(field);
  if (kind === "badge") return <Badge value={String(value)} />;
  if (field?.input === "reference" && field.referenceTarget) {
    const slug = slugForEntityName(schema, field.referenceTarget);
    if (slug) {
      return (
        <Link href={`/e/${slug}/${encodeURIComponent(String(value))}`} className="text-brand-600 hover:text-brand-700">
          <ReferenceLabel schema={schema} target={field.referenceTarget} id={String(value)} />
        </Link>
      );
    }
  }
  return <span>{formatCell(value, kind)}</span>;
}

function FilterControl({
  field,
  value,
  onChange,
}: {
  field: UiFieldSchema | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  if (field === undefined) return null;
  if (field.input === "select") {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
      >
        <option value="">{field.label}: all</option>
        {(field.enumValues ?? []).map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={`${field.label}…`}
      className="w-40 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
    />
  );
}

function CreateForm({
  entity,
  schema,
  initialValues,
  onDone,
}: {
  entity: UiEntitySchema;
  schema: ReturnType<typeof useSchema>["schema"];
  initialValues?: Record<string, string>;
  onDone: () => void;
}) {
  const editable = entity.fields.filter((f) => f.readOnly !== true);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => ({ ...initialValues }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const f of editable) {
        const v = values[f.name];
        if (v === undefined || v === "") continue;
        payload[f.name] = f.input === "number" ? Number(v) : v;
      }
      await createRecord(entity.slug, payload);
      invalidateReferenceCache(entity.slug);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 rounded-xl border border-line bg-white p-5">
      <h3 className="mb-4 text-sm font-semibold text-ink">New {entity.singular}</h3>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {editable.map((f) => (
          <label key={f.name} className="block">
            <span className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-muted">
              {f.label}
              {f.required && <span className="text-brand-600">*</span>}
              {f.classification && (
                <span className="rounded bg-amber-50 px-1 text-[10px] font-semibold text-amber-700">{f.classification}</span>
              )}
            </span>
            <FieldInput field={f} value={values[f.name] ?? (f.input === "boolean" ? false : "")} schema={schema} onChange={(v) => setValues((p) => ({ ...p, [f.name]: v }))} />
          </label>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-brand-600">{error}</p>}
      <div className="mt-4 flex gap-3">
        <button onClick={() => void submit()} disabled={busy} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-60">
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
}
