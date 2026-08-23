"use client";

import { Fragment, useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/Badge";
import { SchemaView } from "@/components/SchemaView";
import { Topbar } from "@/components/Topbar";
import {
  approveReview,
  getReview,
  listReviews,
  rejectReview,
  ReviewConflictError,
  reviewStats,
  type ReviewCounts,
  type ReviewDecision,
  type ReviewDetail,
  type ReviewListItem,
  type RiskFinding,
  type RiskLevel,
} from "@/lib/reviews";

const STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

const NOTES_MAX = 2000;

const RISK_LABEL: Record<RiskLevel, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const RISK_CHIP: Record<RiskLevel, string> = {
  high: "bg-brand text-white ring-1 ring-brand-700",
  medium: "bg-amber-50 text-amber-700 ring-1 ring-amber-600/30",
  low: "bg-surface-sunken text-ink-muted ring-1 ring-line",
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function DesignReviewsPage() {
  const [counts, setCounts] = useState<ReviewCounts | null>(null);
  const [items, setItems] = useState<ReadonlyArray<ReviewListItem>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reviewStatus, setReviewStatus] = useState<string>("pending");
  const [tenantInput, setTenantInput] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [acting, setActing] = useState<ReviewDecision | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    listReviews({ reviewStatus, tenantId, limit: 50 })
      .then((page) => {
        setItems(page.data);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [reviewStatus, tenantId]);

  useEffect(() => load(), [load]);

  const refreshStats = useCallback(() => {
    reviewStats()
      .then((c) => setCounts(c))
      .catch(() => undefined);
  }, []);

  useEffect(() => refreshStats(), [refreshStats]);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    listReviews({ reviewStatus, tenantId, limit: 50, cursor: nextCursor })
      .then((page) => {
        setItems((prev) => [...prev, ...page.data]);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMore(false));
  }, [reviewStatus, tenantId, nextCursor]);

  const openDetail = useCallback((id: string) => {
    setDetail(null);
    setDetailError(null);
    setConflict(null);
    setNotes("");
    setDetailBusy(true);
    getReview(id)
      .then((d) => setDetail(d))
      .catch((e: unknown) => setDetailError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDetailBusy(false));
  }, []);

  function toggleRow(id: string) {
    setNotice(null);
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    openDetail(id);
  }

  async function decide(id: string, decision: ReviewDecision) {
    setActing(decision);
    setConflict(null);
    setNotice(null);
    setDetailError(null);
    try {
      const review = await (decision === "approve"
        ? approveReview(id, notes)
        : rejectReview(id, notes));
      setDetail((prev) => (prev === null ? prev : { ...prev, review: { ...prev.review, ...review } }));
      setNotice(`${decision === "approve" ? "Approved" : "Rejected"} “${review.name}”.`);
      setNotes("");
      load();
      refreshStats();
    } catch (e) {
      if (e instanceof ReviewConflictError) {
        // Another operator decided first — show it inline and pull the fresh row.
        setConflict(e.message);
        openDetail(id);
        load();
        refreshStats();
      } else {
        setDetailError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setActing(null);
    }
  }

  const highCount = items.filter((r) => r.risk.level === "high").length;

  return (
    <>
      <Topbar title="Design Reviews" subtitle="AI-generated systems awaiting platform approval" />
      <div className="px-8 py-6">
        <section className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Pending" value={counts ? counts.pending : null} accent={(counts?.pending ?? 0) > 0} />
          <Stat label="Approved" value={counts ? counts.approved : null} />
          <Stat label="Rejected" value={counts ? counts.rejected : null} />
          <Stat label="Total" value={counts ? counts.total : null} />
        </section>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-line bg-white p-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setReviewStatus(f.value)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  reviewStatus === f.value
                    ? "bg-brand text-white"
                    : "text-ink-muted hover:bg-surface-soft hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTenantId(tenantInput.trim());
            }}
            className="flex items-center gap-2"
          >
            <input
              value={tenantInput}
              onChange={(e) => setTenantInput(e.target.value)}
              placeholder="Filter by tenant id…"
              aria-label="Tenant id"
              className="w-56 rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs text-ink outline-none placeholder:font-sans placeholder:text-ink-faint focus:border-brand"
            />
            {tenantId !== "" && (
              <button
                type="button"
                onClick={() => {
                  setTenantInput("");
                  setTenantId("");
                }}
                className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft"
              >
                Clear
              </button>
            )}
          </form>

          <button
            onClick={() => {
              load();
              refreshStats();
            }}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft"
          >
            Refresh
          </button>

          {highCount > 0 && (
            <span className="ml-auto inline-flex items-center gap-2 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white shadow-tile">
              {highCount} high-risk {highCount === 1 ? "proposal" : "proposals"} in view
            </span>
          )}
        </div>

        {notice && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Could not load design reviews: {error}. Is operate-server running?
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <table className="data-table">
            <thead>
              <tr>
                <th>Proposal</th>
                <th>Tenant</th>
                <th>Risk</th>
                <th>Provider</th>
                <th>Created</th>
                <th>Review</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {busy && items.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-ink-faint">
                    Loading…
                  </td>
                </tr>
              )}
              {!busy && items.length === 0 && !error && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-ink-faint">
                    Nothing awaiting review.
                  </td>
                </tr>
              )}
              {items.map((r) => {
                const high = r.risk.level === "high";
                const open = openId === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td className={high ? "border-l-4 border-l-brand" : "border-l-4 border-l-transparent"}>
                        <div className="max-w-[24rem]">
                          <div className="truncate font-semibold text-ink" title={r.name}>
                            {r.name}
                          </div>
                          <div className="truncate text-xs text-ink-faint" title={r.description}>
                            {r.description || "—"}
                          </div>
                        </div>
                      </td>
                      <td>
                        <span
                          className="block max-w-[10rem] truncate font-mono text-xs text-ink-muted"
                          title={r.tenantId}
                        >
                          {r.tenantId}
                        </span>
                      </td>
                      <td>
                        <RiskChip level={r.risk.level} findings={r.risk.findings.length} />
                      </td>
                      <td className="text-ink-muted">{r.providerLabel ?? "—"}</td>
                      <td className="whitespace-nowrap text-ink-muted">{formatWhen(r.createdAt)}</td>
                      <td>
                        <Badge value={r.reviewStatus} />
                      </td>
                      <td className="text-right">
                        <button
                          onClick={() => toggleRow(r.id)}
                          className="text-sm font-semibold text-brand-600 hover:text-brand-700"
                        >
                          {open ? "Close" : "Review"}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7}>
                          <div className={`-mx-3 -my-2 bg-white px-6 py-5 ${high ? "border-l-4 border-l-brand" : ""}`}>
                            {detailBusy && detail === null && (
                              <p className="text-sm text-ink-muted">Loading risk report…</p>
                            )}
                            {detailError && (
                              <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                                {detailError}
                              </div>
                            )}
                            {conflict && (
                              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
                                {conflict}
                              </div>
                            )}
                            {detail !== null && (
                              <DetailPanel
                                detail={detail}
                                notes={notes}
                                onNotes={setNotes}
                                acting={acting}
                                onDecide={(d) => void decide(r.id, d)}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <p className="text-xs text-ink-faint">
            {items.length} shown
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

function DetailPanel({
  detail,
  notes,
  onNotes,
  acting,
  onDecide,
}: {
  detail: ReviewDetail;
  notes: string;
  onNotes: (v: string) => void;
  acting: ReviewDecision | null;
  onDecide: (d: ReviewDecision) => void;
}) {
  const { review, risk, schema } = detail;
  const decided = review.reviewStatus === "approved" || review.reviewStatus === "rejected";
  const high = risk.level === "high";

  return (
    <div className="space-y-5">
      <div
        className={`flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 ${
          high
            ? "bg-brand-50 ring-1 ring-brand-200"
            : risk.level === "medium"
              ? "bg-amber-50 ring-1 ring-amber-200"
              : "bg-surface-soft ring-1 ring-line"
        }`}
      >
        <RiskChip level={risk.level} findings={risk.findings.length} />
        <span className={`text-sm font-semibold ${high ? "text-brand-700" : "text-ink"}`}>
          {high
            ? "High risk — work through every finding before approving."
            : risk.level === "medium"
              ? "Medium risk — check the findings below."
              : "Low risk — no blocking issues detected."}
        </span>
        <span className="ml-auto font-mono text-[11px] text-ink-faint" title={review.manifestHash}>
          {review.manifestHash.slice(0, 16)}
        </span>
      </div>

      <div>
        <div className="label">Findings</div>
        {risk.findings.length === 0 ? (
          <p className="text-sm text-ink-muted">The automated check raised no findings.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {risk.findings.map((f, i) => (
              <FindingRow key={`${f.code}-${i}`} finding={f} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <CountPill label="Entities" value={risk.counts.entities} />
        <CountPill label="Fields" value={risk.counts.fields} />
        <CountPill label="Roles" value={risk.counts.roles} />
        <CountPill label="Relations" value={risk.counts.relations} />
        <CountPill label="Sensitive fields" value={risk.counts.sensitiveFields} accent={risk.counts.sensitiveFields > 0} />
      </div>

      {schema !== undefined && (
        <div>
          <div className="label">Designed schema</div>
          {/* Keyed by review: collapse state must not leak between proposals. */}
          <SchemaView key={review.id} schema={schema} />
        </div>
      )}

      {decided ? (
        <div className="rounded-xl border border-line bg-surface-soft px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge value={review.reviewStatus} />
            <span className="text-ink-muted">
              by {review.reviewedBy ?? "—"}
              {review.reviewedAt ? ` · ${formatWhen(review.reviewedAt)}` : ""}
            </span>
          </div>
          {review.reviewNotes && <p className="mt-2 text-ink">{review.reviewNotes}</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <label className="label" htmlFor={`notes-${review.id}`}>
            Review notes
          </label>
          <textarea
            id={`notes-${review.id}`}
            value={notes}
            maxLength={NOTES_MAX}
            rows={3}
            onChange={(e) => onNotes(e.target.value.slice(0, NOTES_MAX))}
            placeholder="Why this decision? Recorded with the review."
            className="field font-normal"
          />
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[11px] text-ink-faint">
              {notes.length} / {NOTES_MAX}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => onDecide("reject")}
                disabled={acting !== null}
                className="btn-danger"
              >
                {acting === "reject" ? "Rejecting…" : "Reject"}
              </button>
              <button
                onClick={() => onDecide("approve")}
                disabled={acting !== null}
                className="btn-primary"
              >
                {acting === "approve" ? "Approving…" : "Approve"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FindingRow({ finding }: { finding: RiskFinding }) {
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <span
        className={`mt-0.5 inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${RISK_CHIP[finding.level]}`}
      >
        {RISK_LABEL[finding.level]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{finding.message}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] text-ink-faint">{finding.code}</span>
          {finding.entities.map((e) => (
            <span key={e} className="chip">
              {e}
            </span>
          ))}
        </div>
      </div>
    </li>
  );
}

function RiskChip({ level, findings }: { level: RiskLevel; findings: number }) {
  const suffix = findings === 0 ? "no findings" : `${findings} finding${findings === 1 ? "" : "s"}`;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-bold ${RISK_CHIP[level]}`}
    >
      {RISK_LABEL[level]} risk
      <span className={`font-medium ${level === "high" ? "text-white/80" : "opacity-70"}`}>· {suffix}</span>
    </span>
  );
}

function CountPill({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-1.5 ${
        accent ? "border-brand-200 bg-brand-50" : "border-line bg-surface-soft"
      }`}
    >
      <div className={`text-sm font-black ${accent ? "text-brand-700" : "text-ink"}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
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
