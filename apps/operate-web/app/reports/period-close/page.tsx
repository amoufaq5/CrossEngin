"use client";

import { useEffect, useState } from "react";

import { Topbar } from "@/components/Topbar";
import { formatCell } from "@/lib/format";
import {
  closePeriod,
  fetchPeriods,
  fetchRevaluationEntry,
  OPEN_PERIOD_STATES,
  type FiscalPeriodRow,
  type RevaluationEntry,
} from "@/lib/period-close";

export default function PeriodClosePage() {
  const [periods, setPeriods] = useState<readonly FiscalPeriodRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [selected, setSelected] = useState<FiscalPeriodRow | null>(null);
  const [entry, setEntry] = useState<RevaluationEntry | null>(null);
  const [entryLoading, setEntryLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    setForbidden(false);
    fetchPeriods()
      .then((rows) => {
        setPeriods(rows);
        setLoading(false);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("403")) setForbidden(true);
        else setError(msg);
        setLoading(false);
      });
  }

  useEffect(load, []);

  function view(period: FiscalPeriodRow) {
    setSelected(period);
    setEntry(null);
    setEntryLoading(true);
    fetchRevaluationEntry(period.id)
      .then((e) => {
        setEntry(e);
        setEntryLoading(false);
      })
      .catch(() => setEntryLoading(false));
  }

  async function close(period: FiscalPeriodRow) {
    if (!confirm(`Close ${period.name}? This posts the unrealized FX revaluation entry and cannot be undone here.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await closePeriod(period.id);
      load();
      view({ ...period, status: "closed" });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Topbar title="Period Close" subtitle="Close a fiscal period and review its FX revaluation entry" />
      <div className="px-8 py-6">
        {loading && <p className="text-sm text-ink-muted">Loading periods…</p>}

        {forbidden && (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            You don&apos;t have access to the fiscal calendar. Contact an administrator if you need it.
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {error}
          </div>
        )}

        {periods && !forbidden && (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            <PeriodList
              periods={periods}
              selectedId={selected?.id ?? null}
              busy={busy}
              onView={view}
              onClose={close}
            />
            <EntryPanel period={selected} entry={entry} loading={entryLoading} />
          </div>
        )}
      </div>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "closed" || status === "locked"
      ? "bg-emerald-50 text-emerald-700"
      : status === "closing"
        ? "bg-amber-50 text-amber-700"
        : "bg-surface-soft text-ink-muted";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>;
}

function PeriodList({
  periods,
  selectedId,
  busy,
  onView,
  onClose,
}: {
  periods: readonly FiscalPeriodRow[];
  selectedId: string | null;
  busy: boolean;
  onView: (p: FiscalPeriodRow) => void;
  onClose: (p: FiscalPeriodRow) => void;
}) {
  if (periods.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
        No fiscal periods defined.
      </div>
    );
  }
  return (
    <section>
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink">Fiscal periods</h2>
      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              <th className="px-4 py-2.5">Period</th>
              <th className="px-4 py-2.5">Range</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p, i) => {
              const open = OPEN_PERIOD_STATES.includes(p.status);
              const active = p.id === selectedId;
              return (
                <tr key={p.id} className={`${i > 0 ? "border-t border-line" : ""} ${active ? "bg-brand-50/40" : ""}`}>
                  <td className="px-4 py-2.5">
                    <button className="font-medium text-ink hover:text-brand-700" onClick={() => onView(p)}>
                      {p.name}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">
                    {p.startDate ? formatCell(p.startDate, "date") : "—"} – {p.endDate ? formatCell(p.endDate, "date") : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {open ? (
                      <button
                        disabled={busy}
                        onClick={() => onClose(p)}
                        className="rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                      >
                        Close period
                      </button>
                    ) : (
                      <button onClick={() => onView(p)} className="text-xs text-ink-muted hover:text-ink">
                        View entry
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EntryPanel({
  period,
  entry,
  loading,
}: {
  period: FiscalPeriodRow | null;
  entry: RevaluationEntry | null;
  loading: boolean;
}) {
  if (period === null) {
    return (
      <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
        Select a period to view its FX revaluation entry.
      </div>
    );
  }
  return (
    <section>
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink">
        FX revaluation — {period.name}
      </h2>
      {loading && <p className="text-sm text-ink-muted">Loading entry…</p>}
      {!loading && entry === null && (
        <div className="rounded-xl border border-line bg-surface-soft px-4 py-8 text-center text-sm text-ink-muted">
          No FX revaluation was posted for this period (no open foreign-currency exposure at close).
        </div>
      )}
      {!loading && entry !== null && (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="border-b border-line px-4 py-3">
            <div className="font-semibold text-ink">{entry.entryNumber}</div>
            <div className="text-xs text-ink-muted">
              {entry.entryDate ? formatCell(entry.entryDate, "date") : ""}
              {entry.memo ? ` · ${entry.memo}` : ""}
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                <th className="px-4 py-2.5">Account</th>
                <th className="px-4 py-2.5 text-right">Debit</th>
                <th className="px-4 py-2.5 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map((l, i) => (
                <tr key={l.id} className={i > 0 ? "border-t border-line" : ""}>
                  <td className="px-4 py-2.5">
                    <div className="text-ink">{l.accountName ?? l.ledgerAccountId ?? "—"}</div>
                    {l.description && <div className="text-xs text-ink-faint">{l.description}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-ink">{l.debit ? formatCell(l.debit, "money") : "—"}</td>
                  <td className="px-4 py-2.5 text-right text-ink">{l.credit ? formatCell(l.credit, "money") : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line bg-surface-soft font-semibold text-ink">
                <td className="px-4 py-2.5 text-right">
                  Totals {entry.balanced ? <span className="text-emerald-600">✓ balanced</span> : <span className="text-brand-700">⚠ unbalanced</span>}
                </td>
                <td className="px-4 py-2.5 text-right">{formatCell(entry.totalDebit, "money")}</td>
                <td className="px-4 py-2.5 text-right">{formatCell(entry.totalCredit, "money")}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
