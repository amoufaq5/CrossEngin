"use client";

import { useEffect, useState } from "react";

import { Topbar } from "@/components/Topbar";
import { fetchAging } from "@/lib/api";
import { AGING_BUCKETS, type AgingReport, type AgingResponse } from "@/lib/aging";
import { formatCell } from "@/lib/format";

export default function AgingPage() {
  const [data, setData] = useState<AgingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Empty string = "today" (server clock); a YYYY-MM-DD value pulls a back-dated snapshot.
  const [asOf, setAsOf] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setForbidden(false);
    fetchAging(asOf || undefined)
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
  }, [asOf]);

  const sections: ReadonlyArray<{ key: "ar" | "ap"; label: string; report: AgingReport }> = data
    ? ([
        data.sections.ar ? { key: "ar" as const, label: "Accounts Receivable", report: data.sections.ar } : null,
        data.sections.ap ? { key: "ap" as const, label: "Accounts Payable", report: data.sections.ap } : null,
      ].filter((s): s is { key: "ar" | "ap"; label: string; report: AgingReport } => s !== null))
    : [];

  return (
    <>
      <Topbar
        title="Aging"
        subtitle={data ? `Receivables & payables as of ${formatCell(data.asOf, "date")}` : "Receivables & payables aging"}
      />
      <div className="px-8 py-6">
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
            As of
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-normal normal-case text-ink"
            />
          </label>
          {asOf && (
            <button
              type="button"
              onClick={() => setAsOf("")}
              className="rounded-lg border border-line bg-surface-soft px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
            >
              Today
            </button>
          )}
        </div>

        {loading && <p className="text-sm text-ink-muted">Loading aging report…</p>}

        {forbidden && (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            You don&apos;t have access to finance reports. Contact an administrator if you need it.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Could not load the aging report: {error}. Is operate-server running?
          </div>
        )}

        {data && !forbidden && !error && (
          <div className="space-y-10">
            {sections.map(({ key, label, report }) => (
              <AgingSection key={key} label={label} report={report} />
            ))}
            {sections.length === 0 && (
              <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
                Nothing outstanding.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function AgingSection({ label, report }: { label: string; report: AgingReport }) {
  const empty = report.documents.length === 0;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-brand" />
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink">{label}</h2>
        <span className="text-xs text-ink-faint">{report.documents.length}</span>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {AGING_BUCKETS.map((bucket) => (
          <BucketStat key={bucket} label={bucket} value={report.totalsByBucket[bucket] ?? 0} />
        ))}
        <BucketStat label="Total open" value={report.totalOpen} accent />
      </div>

      {empty ? (
        <div className="rounded-xl border border-line bg-surface-soft px-4 py-8 text-center text-sm text-ink-muted">
          Nothing outstanding.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                <th className="px-4 py-2.5">Document</th>
                <th className="px-4 py-2.5">Due date</th>
                <th className="px-4 py-2.5 text-right">Days overdue</th>
                <th className="px-4 py-2.5">Bucket</th>
                <th className="px-4 py-2.5 text-right">Open</th>
              </tr>
            </thead>
            <tbody>
              {report.documents.map((row, i) => (
                <tr key={row.id} className={i > 0 ? "border-t border-line" : ""}>
                  <td className="px-4 py-2.5 font-medium text-ink">{row.number}</td>
                  <td className="px-4 py-2.5 text-ink-muted">{formatCell(row.dueDate, "date")}</td>
                  <td className="px-4 py-2.5 text-right text-ink-muted">
                    {row.daysOverdue > 0 ? row.daysOverdue : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="rounded bg-surface-soft px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
                      {row.bucket}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-medium text-ink">{formatCell(row.open, "money")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BucketStat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`card p-3 ${accent ? "ring-1 ring-brand/20" : ""}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</div>
      <div className={`mt-1 text-base font-bold ${accent ? "text-brand" : "text-ink"}`}>
        {formatCell(value, "money")}
      </div>
    </div>
  );
}
