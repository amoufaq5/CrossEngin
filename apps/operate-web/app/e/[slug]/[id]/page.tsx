"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/Badge";
import { FieldInput } from "@/components/FieldInput";
import { Topbar } from "@/components/Topbar";
import { deleteRecord, getRecord, runTransition, updateRecord } from "@/lib/api";
import { formatCell } from "@/lib/format";
import { entityBySlug, slugForEntityName, useSchema, type UiEntitySchema, type UiFieldSchema } from "@/lib/schema";

export default function RecordPage({ params }: { params: { slug: string; id: string } }) {
  const { schema, loading } = useSchema();
  const entity = entityBySlug(schema, params.slug);

  if (loading) {
    return (
      <>
        <Topbar title="Loading…" />
        <div className="px-8 py-6 text-sm text-ink-muted">Loading…</div>
      </>
    );
  }
  if (entity === undefined) {
    return (
      <>
        <Topbar title="Unknown entity" />
        <div className="px-8 py-6 text-sm text-ink-muted">No entity for &quot;/e/{params.slug}&quot;.</div>
      </>
    );
  }
  return <RecordDetail entity={entity} id={params.id} />;
}

function RecordDetail({ entity, id }: { entity: UiEntitySchema; id: string }) {
  const { schema } = useSchema();
  const router = useRouter();
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    getRecord(entity.slug, id)
      .then((r) => {
        setRecord(r);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [entity.slug, id]);

  useEffect(() => load(), [load]);

  function startEdit() {
    if (record === null) return;
    const d: Record<string, string | boolean> = {};
    for (const f of entity.fields) {
      const v = record[f.name];
      d[f.name] = f.input === "boolean" ? v === true : v === null || v === undefined ? "" : String(v);
    }
    setDraft(d);
    setEditing(true);
  }

  async function save() {
    if (record === null) return;
    setBusy(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const f of entity.fields) {
        if (f.readOnly === true) continue;
        const next = draft[f.name];
        const prev = record[f.name];
        const prevStr = prev === null || prev === undefined ? "" : String(prev);
        if (f.input === "boolean") {
          if ((next === true) !== (prev === true)) patch[f.name] = next === true;
        } else if (String(next ?? "") !== prevStr) {
          patch[f.name] = next === "" ? null : f.input === "number" ? Number(next) : next;
        }
      }
      if (Object.keys(patch).length > 0) {
        const updated = await updateRecord(entity.slug, id, patch);
        setRecord(updated);
      }
      setEditing(false);
      setNotice("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete this ${entity.singular}?`)) return;
    setBusy(true);
    try {
      await deleteRecord(entity.slug, id);
      router.push(`/e/${entity.slug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function transition(name: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await runTransition(entity.slug, id, name);
      setRecord(updated);
      setNotice(`Transition "${name}" applied.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const currentState = entity.stateField && record ? String(record[entity.stateField] ?? "") : "";
  const available = entity.transitions.filter((t) => t.from.includes(currentState));
  const titleField = record?.["name"] ?? record?.[entity.listColumns[0] ?? "id"] ?? id;

  return (
    <>
      <Topbar title={`${entity.singular}`} subtitle={String(titleField)} />
      <div className="px-8 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Link href={`/e/${entity.slug}`} className="text-sm text-ink-muted hover:text-ink">
            ← {entity.label}
          </Link>
          {entity.stateField && currentState && <Badge value={currentState} />}
          <div className="ml-auto flex gap-2">
            {!editing && (
              <button onClick={startEdit} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-soft">
                Edit
              </button>
            )}
            {editing && (
              <>
                <button onClick={() => setEditing(false)} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-soft">
                  Cancel
                </button>
                <button onClick={() => void save()} disabled={busy} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-60">
                  Save
                </button>
              </>
            )}
            <button onClick={() => void remove()} className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50">
              Delete
            </button>
          </div>
        </div>

        {notice && <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</div>}
        {error && <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">{error}</div>}

        {available.length > 0 && !editing && (
          <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white p-4">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Actions</span>
            {available.map((t) => (
              <button
                key={t.name}
                onClick={() => void transition(t.name)}
                disabled={busy}
                className="rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
              >
                {t.label} → {t.to}
              </button>
            ))}
          </div>
        )}

        {busy && record === null ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : record === null ? (
          <p className="text-sm text-ink-muted">Not found.</p>
        ) : (
          <div className="rounded-xl border border-line bg-white p-6">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
              {entity.fields.map((f) => (
                <div key={f.name}>
                  <dt className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                    {f.label}
                    {f.classification && (
                      <span className="rounded bg-amber-50 px-1 text-[10px] font-semibold text-amber-700">{f.classification}</span>
                    )}
                  </dt>
                  <dd>
                    {editing && f.readOnly !== true ? (
                      <FieldInput field={f} value={draft[f.name] ?? ""} schema={schema} onChange={(v) => setDraft((p) => ({ ...p, [f.name]: v }))} />
                    ) : (
                      <ReadValue field={f} value={record[f.name]} schema={schema} />
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </>
  );
}

function ReadValue({
  field,
  value,
  schema,
}: {
  field: UiFieldSchema;
  value: unknown;
  schema: ReturnType<typeof useSchema>["schema"];
}) {
  if (value === null || value === undefined || value === "") return <span className="text-ink-faint">—</span>;
  if (field.input === "select") return <Badge value={String(value)} />;
  if (field.input === "boolean") return <span className="text-ink">{value === true ? "Yes" : "No"}</span>;
  if (field.input === "reference" && field.referenceTarget) {
    const slug = slugForEntityName(schema, field.referenceTarget);
    if (slug) {
      return (
        <Link href={`/e/${slug}/${encodeURIComponent(String(value))}`} className="text-brand-600 hover:text-brand-700">
          {String(value)}
        </Link>
      );
    }
  }
  const kind = field.input === "date" || field.input === "datetime" ? "date" : undefined;
  return <span className="text-ink">{formatCell(value, kind)}</span>;
}
