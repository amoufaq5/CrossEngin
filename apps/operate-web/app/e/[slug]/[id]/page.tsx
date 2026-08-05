"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/Badge";
import { FieldInput } from "@/components/FieldInput";
import { ReferenceLabel } from "@/components/ReferenceLabel";
import { Topbar } from "@/components/Topbar";
import {
  countAssociation,
  deleteRecord,
  getRecord,
  linkAssociation,
  listAssociations,
  listRecords,
  runTransition,
  unlinkAssociation,
  updateRecord,
} from "@/lib/api";
import { ReferencePicker } from "@/components/ReferencePicker";
import { formatCell } from "@/lib/format";
import { invalidateReferenceCache } from "@/lib/reference-cache";
import {
  canAccess,
  entityByName,
  entityBySlug,
  fieldErrorMap,
  parseValidationErrors,
  reverseReferences,
  slugForEntityName,
  useSchema,
  type ReverseReference,
  type UiAssociationSchema,
  type UiEntitySchema,
  type UiFieldSchema,
} from "@/lib/schema";

/** Moves keyboard focus to the first invalid input inside a container, scrolling it into view. */
function focusFirstInvalid(container: HTMLElement | null): void {
  if (container === null || typeof window === "undefined") return;
  requestAnimationFrame(() => {
    const el = container.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (el !== null) {
      el.focus();
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
}

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const fieldsRef = useRef<HTMLDListElement>(null);
  const errId = (name: string) => `edit-${entity.slug}-err-${name}`;

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
    setFieldErrors({});
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
        // Optimistic concurrency: send the version we loaded; the server 409s if it moved.
        const expected = record["updated_at"];
        if (typeof expected === "string") patch["expectedUpdatedAt"] = expected;
        const updated = await updateRecord(entity.slug, id, patch);
        setRecord(updated);
        invalidateReferenceCache(entity.slug);
      }
      setEditing(false);
      setNotice("Saved.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const fields = parseValidationErrors(msg);
      if (fields !== null) {
        // Stay in edit mode so the user can fix the flagged fields (highlighted inline).
        setError("Please fix the highlighted fields.");
        setFieldErrors(fieldErrorMap(fields));
        focusFirstInvalid(fieldsRef.current);
      } else if (msg.startsWith("409")) {
        // Someone else changed this record since we loaded it — reload the latest so the
        // user re-applies their edits against current data rather than clobbering it.
        setError("This record was changed by someone else. Reloaded the latest — please re-apply your edits.");
        setEditing(false);
        load();
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete this ${entity.singular}?`)) return;
    setBusy(true);
    try {
      await deleteRecord(entity.slug, id);
      invalidateReferenceCache(entity.slug);
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
      invalidateReferenceCache(entity.slug);
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

  // One-click WHT certificate from an issued invoice: prefill the certificate's create
  // form (invoice / customer / currency) from this invoice. Amount is entered from the
  // physical certificate. Shown only when the manifest models WhtCertificate.
  const whtSlug = entity.name === "Invoice" ? slugForEntityName(schema, "WhtCertificate") : undefined;
  const whtAmount = record !== null ? String(record["withholding_total"] ?? "") : "";
  const whtHref =
    whtSlug !== undefined && record !== null
      ? `/e/${whtSlug}?new=1&invoice_id=${encodeURIComponent(id)}` +
        `&account_id=${encodeURIComponent(String(record["account_id"] ?? ""))}` +
        `&currency=${encodeURIComponent(String(record["currency"] ?? ""))}` +
        (whtAmount !== "" && whtAmount !== "0" ? `&amount=${encodeURIComponent(whtAmount)}` : "")
      : undefined;

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
            {!editing && whtHref !== undefined && (
              <Link href={whtHref} className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-soft">
                Raise WHT certificate
              </Link>
            )}
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
            <dl ref={fieldsRef} className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
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
                      <>
                        <FieldInput
                          field={f}
                          value={draft[f.name] ?? ""}
                          schema={schema}
                          invalid={fieldErrors[f.name] !== undefined}
                          describedById={errId(f.name)}
                          onChange={(v) => {
                            setDraft((p) => ({ ...p, [f.name]: v }));
                            setFieldErrors((prev) => {
                              if (prev[f.name] === undefined) return prev;
                              const next = { ...prev };
                              delete next[f.name];
                              return next;
                            });
                          }}
                        />
                        {fieldErrors[f.name] && (
                          <span id={errId(f.name)} className="mt-1 block text-xs text-red-600">
                            {fieldErrors[f.name]}
                          </span>
                        )}
                      </>
                    ) : (
                      <ReadValue field={f} value={record[f.name]} schema={schema} />
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {record !== null && !editing && reverseReferences(schema, entity.name).map((rel) => (
          <RelatedRecords key={`${rel.entity.name}.${rel.field.name}`} rel={rel} parentId={id} schema={schema} />
        ))}

        {record !== null && !editing && (entity.associations ?? []).map((assoc) => (
          <AssociatedRecords key={assoc.relatedEntity} owner={entity} assoc={assoc} parentId={id} schema={schema} />
        ))}
      </div>
    </>
  );
}

/** A small pill showing a relation's row count next to a panel heading. */
function CountBadge({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-surface-soft px-2 py-0.5 text-xs font-medium tabular-nums text-ink-muted">
      {label}
    </span>
  );
}

/**
 * A related-records panel: the child rows whose reference `<field>` points at this record. Fetches
 * `?<field>=<id>` (server-side filtered — reference fields are always filterable), shows a compact
 * table over the child's list columns, and deep-links each row + a "View all" pre-filtered list.
 */
function RelatedRecords({
  rel,
  parentId,
  schema,
}: {
  rel: ReverseReference;
  parentId: string;
  schema: ReturnType<typeof useSchema>["schema"];
}) {
  const { entity: child, field } = rel;
  const [rows, setRows] = useState<ReadonlyArray<Record<string, unknown>>>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const PAGE = 6;
  const columns = child.listColumns.filter((c) => c !== field.name).slice(0, 4);
  const columnLabel = (name: string): string => child.fields.find((f) => f.name === name)?.label ?? name;

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    const query = `?${encodeURIComponent(field.name)}=${encodeURIComponent(parentId)}&limit=${PAGE}`;
    listRecords(child.slug, query)
      .then((res) => {
        if (!cancelled) {
          setRows(res.data);
          // A next cursor means more rows exist than the page shows → render "N+".
          setHasMore(res.nextCursor !== null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [child.slug, field.name, parentId]);

  if (!busy && error === null && rows.length === 0) return null;

  const countLabel = rows.length === 0 ? "" : hasMore ? `${rows.length}+` : String(rows.length);

  return (
    <section className="mt-6 rounded-xl border border-line bg-white p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span>
            {child.label} <span className="font-normal text-ink-faint">via {field.label}</span>
          </span>
          {countLabel !== "" && <CountBadge label={countLabel} />}
        </h2>
        <Link
          href={`/e/${child.slug}?fl_${encodeURIComponent(field.name)}=${encodeURIComponent(parentId)}`}
          className="text-xs text-brand-600 hover:text-brand-700"
        >
          View all →
        </Link>
      </div>
      {busy ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : error !== null ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                {columns.map((c) => (
                  <th key={c} className="py-2 pr-4 font-medium">
                    {columnLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const rowId = String(row["id"] ?? "");
                return (
                  <tr key={rowId} className="border-b border-line/60 last:border-0 hover:bg-surface">
                    {columns.map((c, idx) => (
                      <td key={c} className="py-2 pr-4">
                        {idx === 0 ? (
                          <Link
                            href={`/e/${child.slug}/${encodeURIComponent(rowId)}`}
                            className="text-brand-600 hover:text-brand-700"
                          >
                            {formatCell(row[c]) || rowId}
                          </Link>
                        ) : (
                          <span className="text-ink">{formatCell(row[c])}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * A many-to-many associations panel: the records linked to this one across a `many_to_many` relation.
 * Fetches `GET /v1/<owner>/<id>/<related>` (the manifest-derived association route) and renders a
 * compact table over the related entity's list columns, each deep-linked. Empty / unsupported (501)
 * associations render nothing.
 */
function AssociatedRecords({
  owner,
  assoc,
  parentId,
  schema,
}: {
  owner: UiEntitySchema;
  assoc: UiAssociationSchema;
  parentId: string;
  schema: ReturnType<typeof useSchema>["schema"];
}) {
  const related = entityByName(schema, assoc.relatedEntity);
  const [rows, setRows] = useState<ReadonlyArray<Record<string, unknown>>>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState("");
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  // Managing a record's associations is part of updating it → gate on owner-update access.
  const canWrite = canAccess(schema, owner, "update");

  const PREVIEW = 8;
  const columns = (related?.listColumns ?? ["id"]).slice(0, 4);
  const columnLabel = (name: string): string => related?.fields.find((f) => f.name === name)?.label ?? name;

  const reload = useCallback(async () => {
    try {
      // Preview the first page of records; the count route gives the true total (server caps the list).
      const [data, count] = await Promise.all([
        listAssociations(owner.slug, parentId, assoc.relatedSlug, PREVIEW),
        countAssociation(owner.slug, parentId, assoc.relatedSlug),
      ]);
      setRows(data);
      setTotal(count);
      setFailed(false);
    } catch {
      // A store without association support (501) or any error → hide the panel entirely.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [owner.slug, parentId, assoc.relatedSlug]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void (async () => {
      if (!cancelled) await reload();
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function link(): Promise<void> {
    if (picked === "" || writing) return;
    setWriting(true);
    setWriteError(null);
    try {
      await linkAssociation(owner.slug, parentId, assoc.relatedSlug, picked);
      setPicked("");
      await reload();
    } catch (e) {
      setWriteError(e instanceof Error ? e.message : String(e));
    } finally {
      setWriting(false);
    }
  }

  async function unlink(relatedId: string): Promise<void> {
    if (writing) return;
    setWriting(true);
    setWriteError(null);
    // Optimistic: drop the row + decrement the total immediately, restore both if the server rejects.
    const prevRows = rows;
    const prevTotal = total;
    setRows((rs) => rs.filter((r) => String(r["id"] ?? "") !== relatedId));
    setTotal((t) => Math.max(0, t - 1));
    try {
      await unlinkAssociation(owner.slug, parentId, assoc.relatedSlug, relatedId);
      await reload();
    } catch (e) {
      setRows(prevRows);
      setTotal(prevTotal);
      setWriteError(e instanceof Error ? e.message : String(e));
    } finally {
      setWriting(false);
    }
  }

  if (failed) return null;
  if (!busy && total === 0 && !canWrite) return null;

  return (
    <section className="mt-6 rounded-xl border border-line bg-white p-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
        <span>
          {assoc.relatedLabel} <span className="font-normal text-ink-faint">linked</span>
        </span>
        {!busy && total > 0 && <CountBadge label={String(total)} />}
      </h2>
      {busy ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                {columns.map((c) => (
                  <th key={c} className="py-2 pr-4 font-medium">
                    {columnLabel(c)}
                  </th>
                ))}
                {canWrite && <th className="py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (canWrite ? 1 : 0)} className="py-2 text-ink-faint">
                    No links yet.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const rowId = String(row["id"] ?? "");
                return (
                  <tr key={rowId} className="border-b border-line/60 last:border-0 hover:bg-surface">
                    {columns.map((c, idx) => (
                      <td key={c} className="py-2 pr-4">
                        {idx === 0 && related !== undefined ? (
                          <Link
                            href={`/e/${related.slug}/${encodeURIComponent(rowId)}`}
                            className="text-brand-600 hover:text-brand-700"
                          >
                            {formatCell(row[c]) || rowId}
                          </Link>
                        ) : (
                          <span className="text-ink">{formatCell(row[c])}</span>
                        )}
                      </td>
                    ))}
                    {canWrite && (
                      <td className="py-2 text-right">
                        <button
                          onClick={() => void unlink(rowId)}
                          disabled={writing}
                          className="text-xs text-ink-muted hover:text-red-600 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!busy && total > rows.length && (
        <p className="mt-2 text-xs text-ink-faint">
          Showing {rows.length} of {total}.
        </p>
      )}
      {canWrite && !busy && (
        <div className="mt-4 flex items-end gap-2">
          <div className="w-72">
            <ReferencePicker target={assoc.relatedEntity} value={picked} onChange={setPicked} schema={schema} />
          </div>
          <button
            onClick={() => void link()}
            disabled={picked === "" || writing}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Link
          </button>
        </div>
      )}
      {writeError !== null && <p className="mt-2 text-xs text-red-600">{writeError}</p>}
    </section>
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
          <ReferenceLabel schema={schema} target={field.referenceTarget} id={String(value)} />
        </Link>
      );
    }
  }
  const kind = field.input === "date" || field.input === "datetime" ? "date" : undefined;
  return <span className="text-ink">{formatCell(value, kind)}</span>;
}
