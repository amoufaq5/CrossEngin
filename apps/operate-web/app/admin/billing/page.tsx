"use client";

import { useEffect, useState } from "react";

import { Topbar } from "@/components/Topbar";
import { createBillingPortalSession, fetchEntitlement, fetchUsage } from "@/lib/api";
import type { EntityUsage, TenantEntitlement, TenantUsage } from "@/lib/entitlement";

type Badge = { label: string; className: string };

function statusBadge(status: string | null): Badge {
  if (status === null) return { label: "No subscription", className: "bg-surface-soft text-ink-muted" };
  switch (status) {
    case "active":
    case "trialing":
      return { label: status, className: "bg-emerald-50 text-emerald-700" };
    case "past_due":
      return { label: status, className: "bg-amber-50 text-amber-700" };
    default:
      return { label: status, className: "bg-red-50 text-red-700" };
  }
}

function usageLabel(u: EntityUsage, cap: number | null): string {
  const used = `${u.overflow ? `${u.used.toLocaleString()}+` : u.used.toLocaleString()}`;
  return cap === null ? `${used} records` : `${used} of ${cap.toLocaleString()}`;
}

function UsageMeter({ usage }: { usage: TenantUsage }) {
  const cap = usage.maxRecordsPerEntity;
  const rows = [...usage.entities].sort((a, b) => b.used - a.used);
  return (
    <div className="rounded-xl border border-line bg-white p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Usage</div>
      {rows.length === 0 ? (
        <div className="mt-2 text-sm text-ink-muted">No entities to report.</div>
      ) : (
        <div className="mt-3 space-y-3">
          {rows.map((u) => {
            const pct = cap !== null && cap > 0 ? Math.min(100, Math.round((u.used / cap) * 100)) : null;
            const barColor = u.atLimit ? "bg-red-500" : pct !== null && pct >= 80 ? "bg-amber-500" : "bg-brand-500";
            return (
              <div key={u.entity}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-ink">{u.entity}</span>
                  <span className={u.atLimit ? "font-medium text-red-600" : "text-ink-muted"}>
                    {usageLabel(u, cap)}
                  </span>
                </div>
                {pct !== null && (
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-soft">
                    <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function BillingPage() {
  const [data, setData] = useState<TenantEntitlement | null>(null);
  const [usage, setUsage] = useState<TenantUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inactive, setInactive] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  const openBillingPortal = () => {
    setPortalBusy(true);
    setPortalError(null);
    createBillingPortalSession()
      .then(({ url }) => {
        window.location.href = url;
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        // 409 = the tenant has no Stripe customer (offline/manual); explain rather than fail loudly.
        setPortalError(
          msg.startsWith("409")
            ? "No billing account is linked to this workspace."
            : "Could not open the billing portal. Try again shortly.",
        );
        setPortalBusy(false);
      });
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setInactive(false);
    setUsage(null);
    fetchEntitlement()
      .then((res) => {
        if (!alive) return;
        setData(res);
        setLoading(false);
        // Usage is best-effort — a failure here must not blank the plan card.
        fetchUsage()
          .then((u) => alive && setUsage(u))
          .catch(() => undefined);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        // The endpoint is ungated, so this shouldn't normally happen — but be defensive.
        if (msg.startsWith("402") || msg.startsWith("403")) setInactive(true);
        else setError(msg);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const badge = data ? statusBadge(data.status) : null;

  return (
    <>
      <Topbar title="Billing & plan" subtitle="Your workspace subscription" />
      <div className="px-8 py-6">
        {loading && <p className="text-sm text-ink-muted">Loading subscription…</p>}

        {inactive && (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            This workspace&apos;s subscription is inactive. Contact an administrator to restore access.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Could not load your subscription: {error}. Is operate-server running?
          </div>
        )}

        {data && !inactive && !error && badge && (
          <div className="max-w-2xl space-y-6">
            <div className="rounded-xl border border-line bg-white p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Status</div>
                  <span
                    className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-sm font-medium capitalize ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={openBillingPortal}
                    disabled={portalBusy}
                    className="rounded-lg border border-line bg-surface-soft px-3 py-1.5 text-sm font-medium text-ink-muted hover:text-ink disabled:opacity-60"
                  >
                    {portalBusy ? "Opening…" : "Manage billing"}
                  </button>
                  {portalError && <span className="text-xs text-red-600">{portalError}</span>}
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-line bg-white p-5">
                <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Plan</div>
                <div className="mt-1 text-base font-bold text-ink">{data.planId ?? "—"}</div>
              </div>
              <div className="rounded-xl border border-line bg-white p-5">
                <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Records per entity</div>
                <div className="mt-1 text-base font-bold text-ink">
                  {data.maxRecordsPerEntity === null ? "Unlimited" : data.maxRecordsPerEntity.toLocaleString()}
                </div>
              </div>
            </div>

            {usage && <UsageMeter usage={usage} />}

            <div className="rounded-xl border border-line bg-white p-5">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">Features</div>
              {data.features.length === 0 ? (
                <div className="mt-2 text-sm text-ink-muted">No plan features listed.</div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {data.features.map((f) => (
                    <span
                      key={f}
                      className="rounded-full bg-surface-soft px-2.5 py-0.5 text-xs font-medium text-ink-muted"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
