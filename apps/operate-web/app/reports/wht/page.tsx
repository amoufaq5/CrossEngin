"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Topbar } from "@/components/Topbar";
import { fetchWhtReconciliation } from "@/lib/api";
import { formatCell } from "@/lib/format";
import { slugForEntityName, useSchema } from "@/lib/schema";
import type { WhtReconciliation, WhtStatus } from "@/lib/wht";

const STATUS_TONE: Record<WhtStatus, string> = {
  certified: "bg-emerald-50 text-emerald-700",
  partial: "bg-amber-50 text-amber-700",
  uncertified: "bg-brand-50 text-brand-700",
};

export default function WhtReportPage() {
  const { schema } = useSchema();
  const invoiceSlug = slugForEntityName(schema, "Invoice");
  const [data, setData] = useState<WhtReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchWhtReconciliation()
      .then((res) => {
        if (!alive) return;
        setData(res);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("403")) setForbidden(true);
        else setError(msg);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <Topbar title="Withholding tax" subtitle="Withheld vs certified — uncertified exposure" />
      <div className="px-8 py-6">
        {loading && <p className="text-sm text-ink-muted">Loading reconciliation…</p>}

        {forbidden && (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            You don&apos;t have access to finance reports. Contact an administrator if you need it.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Could not load the report: {error}. Is operate-server running?
          </div>
        )}

        {data && !forbidden && !error && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="Withheld" value={data.totals.withheld} />
              <Stat label="Certified" value={data.totals.certified} />
              <Stat label="Uncertified" value={data.totals.uncertified} accent />
            </div>

            {data.rows.length === 0 ? (
              <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
                No withholding recorded.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-line bg-white">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      <th className="px-4 py-2.5">Invoice</th>
                      <th className="px-4 py-2.5 text-right">Withheld</th>
                      <th className="px-4 py-2.5 text-right">Certified</th>
                      <th className="px-4 py-2.5 text-right">Gap</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, i) => (
                      <tr key={row.invoiceId} className={i > 0 ? "border-t border-line" : ""}>
                        <td className="px-4 py-2.5 font-medium text-ink">
                          {invoiceSlug ? (
                            <Link href={`/e/${invoiceSlug}/${encodeURIComponent(row.invoiceId)}`} className="text-brand-600 hover:text-brand-700">
                              {row.number}
                            </Link>
                          ) : (
                            row.number
                          )}
                          {row.currency && <span className="ml-2 text-xs text-ink-faint">{row.currency}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right text-ink">{formatCell(row.withheld, "money")}</td>
                        <td className="px-4 py-2.5 text-right text-ink-muted">{formatCell(row.certified, "money")}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-ink">{formatCell(row.gap, "money")}</td>
                        <td className="px-4 py-2.5">
                          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[row.status]}`}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`card p-3 ${accent ? "ring-1 ring-brand/20" : ""}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</div>
      <div className={`mt-1 text-base font-bold ${accent ? "text-brand" : "text-ink"}`}>{formatCell(value, "money")}</div>
    </div>
  );
}
