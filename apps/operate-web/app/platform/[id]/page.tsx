"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/Badge";
import { Topbar } from "@/components/Topbar";
import { formatCell } from "@/lib/format";
import {
  getTenant,
  PlatformError,
  setTenantStatus,
  type Tenant,
  type TenantAction,
} from "@/lib/platform";

const FIELDS: ReadonlyArray<{ key: keyof Tenant; label: string; kind?: "date" }> = [
  { key: "slug", label: "Slug" },
  { key: "name", label: "Name" },
  { key: "tier", label: "Tier" },
  { key: "region", label: "Region" },
  { key: "schemaName", label: "Schema name" },
  { key: "searchLocale", label: "Search locale" },
  { key: "id", label: "Tenant ID" },
  { key: "createdAt", label: "Created", kind: "date" },
  { key: "updatedAt", label: "Updated", kind: "date" },
];

export default function TenantDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [acting, setActing] = useState<TenantAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    setNotFound(false);
    getTenant(id)
      .then((t) => setTenant(t))
      .catch((e: unknown) => {
        if (e instanceof PlatformError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  }, [id]);

  useEffect(() => load(), [load]);

  async function runAction(action: TenantAction) {
    if (action === "archive") {
      if (!confirm("Archive this tenant? Its workspace becomes inaccessible until reactivated.")) return;
    }
    setActing(action);
    setError(null);
    setNotice(null);
    try {
      const updated = await setTenantStatus(id, action);
      setTenant(updated);
      setNotice(`Tenant ${action === "reactivate" ? "reactivated" : `${action}d`}.`);
    } catch (e) {
      if (e instanceof PlatformError && e.status === 409) {
        // Illegal transition for the current status — explain rather than fail loudly.
        setError(e.message || `Cannot ${action} a tenant in its current state.`);
      } else if (e instanceof PlatformError && e.status === 404) {
        setError("This tenant no longer exists.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setActing(null);
    }
  }

  const status = tenant?.status;
  const canSuspend = status === "active";
  const canReactivate = status === "suspended";
  const canArchive = status === "active" || status === "suspended";
  const hasActions = canSuspend || canReactivate || canArchive;

  return (
    <>
      <Topbar title="Tenant" subtitle={tenant?.name ?? id} />
      <div className="px-8 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Link href="/platform" className="text-sm text-ink-muted hover:text-ink">
            ← Platform
          </Link>
          {tenant && <Badge value={tenant.status} />}
        </div>

        {notice && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {error}
          </div>
        )}

        {busy && tenant === null ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : notFound ? (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            No tenant found for this id.
          </div>
        ) : tenant === null ? (
          <p className="text-sm text-ink-muted">Not found.</p>
        ) : (
          <>
            {hasActions && (
              <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white p-4">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Actions</span>
                {canSuspend && (
                  <button
                    onClick={() => void runAction("suspend")}
                    disabled={acting !== null}
                    className="rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
                  >
                    {acting === "suspend" ? "Suspending…" : "Suspend"}
                  </button>
                )}
                {canReactivate && (
                  <button
                    onClick={() => void runAction("reactivate")}
                    disabled={acting !== null}
                    className="rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                  >
                    {acting === "reactivate" ? "Reactivating…" : "Reactivate"}
                  </button>
                )}
                {canArchive && (
                  <button
                    onClick={() => void runAction("archive")}
                    disabled={acting !== null}
                    className="ml-auto rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                  >
                    {acting === "archive" ? "Archiving…" : "Archive"}
                  </button>
                )}
              </div>
            )}

            <div className="rounded-xl border border-line bg-white p-6">
              <dl className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
                {FIELDS.map((f) => (
                  <div key={f.key}>
                    <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                      {f.label}
                    </dt>
                    <dd>
                      {f.key === "id" || f.key === "schemaName" ? (
                        <span className="font-mono text-sm text-ink">{String(tenant[f.key])}</span>
                      ) : (
                        <span className="text-ink">{formatCell(tenant[f.key], f.kind)}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </>
        )}
      </div>
    </>
  );
}
