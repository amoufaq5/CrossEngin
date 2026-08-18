"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/Badge";
import { Topbar } from "@/components/Topbar";
import { formatCell } from "@/lib/format";
import {
  listTenants,
  platformStats,
  type Tenant,
  type TenantCounts,
} from "@/lib/platform";

const STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "archived", label: "Archived" },
];

export default function PlatformConsolePage() {
  const [counts, setCounts] = useState<TenantCounts | null>(null);
  const [tenants, setTenants] = useState<ReadonlyArray<Tenant>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("all");
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    listTenants({ status, limit: 50 })
      .then((page) => {
        setTenants(page.data);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [status]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    let alive = true;
    platformStats()
      .then((c) => alive && setCounts(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    listTenants({ status, limit: 50, cursor: nextCursor })
      .then((page) => {
        setTenants((prev) => [...prev, ...page.data]);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMore(false));
  }, [status, nextCursor]);

  return (
    <>
      <Topbar title="Platform" subtitle="Tenant management · super-admin" />
      <div className="px-8 py-6">
        <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Total tenants" value={counts ? counts.total : null} accent />
          <Stat label="Active" value={counts ? counts.active : null} accent />
          <Stat label="Suspended" value={counts ? counts.suspended : null} />
          <Stat label="Archived" value={counts ? counts.archived : null} />
          <Stat label="Deleted" value={counts ? counts.deleted : null} />
        </section>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-line bg-white p-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatus(f.value)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  status === f.value
                    ? "bg-brand text-white"
                    : "text-ink-muted hover:bg-surface-soft hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft"
          >
            Refresh
          </button>
          <Link href="/platform/new" className="btn-primary ml-auto">
            New tenant
          </Link>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Could not load tenants: {error}. Is operate-server running?
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface-soft text-left text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Slug</th>
                <th className="px-4 py-2.5 font-semibold">Name</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">Tier</th>
                <th className="px-4 py-2.5 font-semibold">Region</th>
                <th className="px-4 py-2.5 font-semibold">Created</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {busy && tenants.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-ink-faint">
                    Loading…
                  </td>
                </tr>
              )}
              {!busy && tenants.length === 0 && !error && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-ink-faint">
                    No tenants{status !== "all" ? ` with status "${status}"` : ""}.
                  </td>
                </tr>
              )}
              {tenants.map((t) => (
                <tr key={t.id} className="transition hover:bg-surface-soft/60">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/platform/${encodeURIComponent(t.id)}`}
                      className="font-mono text-sm font-medium text-brand-600 hover:text-brand-700"
                    >
                      {t.slug}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-ink">{t.name}</td>
                  <td className="px-4 py-2.5">
                    <Badge value={t.status} />
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">{t.tier || "—"}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{t.region || "—"}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{formatCell(t.createdAt, "date")}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Link
                      href={`/platform/${encodeURIComponent(t.id)}`}
                      className="text-sm font-medium text-brand-600 hover:text-brand-700"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <p className="text-xs text-ink-faint">
            {tenants.length} shown
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

function Stat({ label, value, accent }: { label: string; value: number | null; accent?: boolean }) {
  return (
    <div className={`card p-4 ${accent ? "ring-1 ring-brand/20" : ""}`}>
      <div className={`text-2xl font-black ${accent ? "text-brand" : "text-ink"}`}>
        {value === null ? "—" : value.toLocaleString()}
      </div>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}
