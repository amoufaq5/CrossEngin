"use client";

import { useEffect, useState } from "react";

import { Topbar } from "@/components/Topbar";
import { boundedReadNotice } from "@/lib/bounded-read";
import { fetchAging } from "@/lib/api";
import {
  AGING_BUCKETS,
  agingAsOfRefusal,
  earliestAgingAsOf,
  type AgingReport,
  type AgingResponse,
} from "@/lib/aging";
import { formatCell } from "@/lib/format";
import { classifyRequestFailure, requestFailureSentence } from "@/lib/request-failure";

export default function AgingPage() {
  const [data, setData] = useState<AgingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Empty string = "today" (server clock); a YYYY-MM-DD value ages today's open documents at a later
  // date. A past date is refused by the server (ADR-0475), so the picker does not offer one.
  const [asOf, setAsOf] = useState("");
  // The server's own date, from an answer to a request without `asOf` — the bound it enforces.
  const [serverToday, setServerToday] = useState<string | null>(null);
  const [asOfRefusal, setAsOfRefusal] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setForbidden(false);
    setAsOfRefusal(null);
    fetchAging(asOf || undefined)
      .then((res) => {
        if (!alive) return;
        setData(res);
        if (asOf === "") setServerToday(res.asOf);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // The role panel only for a role refusal. A 403 from the tenant-status gate ("Workspace
        // unavailable") used to land here too, because this read `message.startsWith("403")`, and
        // told a suspended tenant's finance user they lacked a role (ADR-0418 Q8, closed by ADR-0478).
        const refusal = agingAsOfRefusal(e);
        if (refusal !== null) setAsOfRefusal(refusal);
        else if (classifyRequestFailure(e).kind === "role_refused") setForbidden(true);
        else setError(requestFailureSentence(e));
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
              min={earliestAgingAsOf(serverToday)}
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

        <p className="-mt-4 mb-6 text-xs text-ink-faint">
          Today or a later date: the report ages today&apos;s open documents, so it cannot say what was
          open on a past date.
        </p>

        {loading && <p className="text-sm text-ink-muted">Loading aging report…</p>}

        {asOfRefusal !== null && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {asOfRefusal}
          </div>
        )}

        {forbidden && (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            You don&apos;t have access to finance reports. Contact an administrator if you need it.
          </div>
        )}

        {data && boundedReadNotice(data, "ledger") !== null && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span className="font-semibold">Partial figures. </span>
            {boundedReadNotice(data, "ledger")}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Could not load the aging report: {error}
          </div>
        )}

        {data && !forbidden && !error && asOfRefusal === null && (
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

      {report.currency !== null || report.totalsByCurrency === undefined ? (
        <>
          {report.currency === null && report.documents.length > 0 && (
            <p className="mb-2 text-xs text-amber-700">
              These documents are in more than one currency and this server does not total them per currency,
              so the figures below add amounts in different currencies together.
            </p>
          )}
          <BucketRow totals={report} currency={report.currency} />
        </>
      ) : (
        Object.entries(report.totalsByCurrency).map(([currency, totals]) => (
          <BucketRow key={currency} totals={totals} currency={currency} />
        ))
      )}

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
                  <td className="px-4 py-2.5 text-right font-medium text-ink">{formatCell(row.open, "money", row.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** One currency's bucket totals. Totals in different currencies are never added together. */
function BucketRow({
  totals,
  currency,
}: {
  totals: { readonly totalsByBucket: Record<string, number>; readonly totalOpen: number };
  currency: string | null;
}) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {AGING_BUCKETS.map((bucket) => (
        <BucketStat key={bucket} label={bucket} value={totals.totalsByBucket[bucket] ?? 0} currency={currency} />
      ))}
      <BucketStat label={currency === null ? "Total open" : `Total open · ${currency}`} value={totals.totalOpen} currency={currency} accent />
    </div>
  );
}

function BucketStat({
  label,
  value,
  currency,
  accent,
}: {
  label: string;
  value: number;
  currency: string | null;
  accent?: boolean;
}) {
  return (
    <div className={`card p-3 ${accent ? "ring-1 ring-brand/20" : ""}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</div>
      <div className={`mt-1 text-base font-bold ${accent ? "text-brand" : "text-ink"}`}>
        {formatCell(value, "money", currency)}
      </div>
    </div>
  );
}
