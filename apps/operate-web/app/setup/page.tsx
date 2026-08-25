"use client";

import { useCallback, useEffect, useState } from "react";

import { DiffView } from "@/components/DiffView";
import { SchemaView } from "@/components/SchemaView";
import { Topbar } from "@/components/Topbar";
import {
  activateProposal,
  archiveProposal,
  DesignError,
  getDesignJob,
  listProposals,
  startDesignJob,
  type DesignJob,
  type DesignResult,
  type Proposal,
  type ProposalStatus,
} from "@/lib/design";
import {
  decidedAtOf,
  decisionOf,
  listNotifications,
  reviewDecisions,
  type ReviewDecision,
  type TenantNotification,
  digestNotices,
} from "@/lib/notifications";

const MAX_DESCRIPTION = 4000;
const POLL_INTERVAL_MS = 1200;
const DECISION_LIMIT = 50;
const PROPOSALS_ANCHOR = "previous-proposals";

type Step = "describe" | "review" | "done";

function toDesignError(e: unknown): DesignError {
  return e instanceof DesignError
    ? e
    : new DesignError("http", 0, e instanceof Error ? e.message : String(e));
}

export default function SetupPage() {
  const [step, setStep] = useState<Step>("describe");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<DesignJob | null>(null);
  const [designError, setDesignError] = useState<DesignError | null>(null);
  const [result, setResult] = useState<DesignResult | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  const [proposals, setProposals] = useState<ReadonlyArray<Proposal>>([]);
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const [decisions, setDecisions] = useState<ReadonlyArray<TenantNotification>>([]);
  const [digests, setDigests] = useState<ReadonlyArray<TenantNotification>>([]);
  const [decisionsBusy, setDecisionsBusy] = useState(true);
  const [decisionsError, setDecisionsError] = useState<string | null>(null);

  const refreshList = useCallback(() => {
    setListError(null);
    listProposals()
      .then((page) => setProposals(page.data))
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : String(e)))
      .finally(() => setListBusy(false));
  }, []);

  // Never allowed to throw into the wizard: a notification failure degrades to a
  // muted line under the heading and leaves every other section working.
  const refreshDecisions = useCallback(() => {
    listNotifications({ channel: "in_app", limit: DECISION_LIMIT })
      .then((page) => {
        setDecisions(reviewDecisions(page.data));
        setDigests(digestNotices(page.data));
        setDecisionsError(null);
      })
      .catch((e: unknown) => setDecisionsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDecisionsBusy(false));
  }, []);

  useEffect(() => refreshList(), [refreshList]);

  useEffect(() => refreshDecisions(), [refreshDecisions]);

  const inFlight = submitting || jobId !== null;

  async function generate() {
    if (description.trim() === "" || inFlight) return;
    setSubmitting(true);
    setDesignError(null);
    setJob(null);
    try {
      const started = await startDesignJob({ description: description.trim(), name });
      setJob(started);
      setJobId(started.id);
    } catch (e) {
      setDesignError(toDesignError(e));
    } finally {
      setSubmitting(false);
    }
  }

  // The poll timer lives ONLY inside this effect's closure, so React's cleanup
  // is the single owner: it fires on unmount, and on every jobId change —
  // including the setJobId(null) that a terminal status, an error, or Cancel
  // performs. `cancelled` additionally stops an in-flight fetch that resolves
  // after teardown from scheduling another tick.
  useEffect(() => {
    const id = jobId;
    if (id === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(pollId: string): Promise<void> {
      try {
        const poll = await getDesignJob(pollId);
        if (cancelled) return;
        setJob(poll.job);

        if (poll.job.status === "succeeded") {
          setJobId(null);
          if (poll.proposal != null && poll.summary != null) {
            setResult({
              proposal: poll.proposal,
              summary: poll.summary,
              schema: poll.schema ?? undefined,
              diff: poll.diff ?? undefined,
            });
            setActivateError(null);
            setStep("review");
            refreshList();
          } else {
            setDesignError(
              new DesignError(
                "design_failed",
                200,
                "The design finished but the server returned no proposal.",
                poll.job.issues,
                poll.job.attempt,
              ),
            );
          }
          return;
        }

        if (poll.job.status === "failed") {
          setJobId(null);
          setDesignError(
            new DesignError(
              "design_failed",
              200,
              poll.job.error ?? "The AI could not produce a valid system from that description.",
              poll.job.issues,
              poll.job.attempt,
            ),
          );
          return;
        }

        timer = setTimeout(() => void tick(pollId), POLL_INTERVAL_MS);
      } catch (e) {
        if (cancelled) return;
        setJobId(null);
        setDesignError(toDesignError(e));
      }
    }

    void tick(id);

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [jobId, refreshList]);

  function cancelJob() {
    // Client-side only: this abandons this browser's view of the job. The
    // server keeps generating, and the finished proposal still shows up in
    // "Previous proposals" below.
    setJobId(null);
    setJob(null);
    setDesignError(null);
  }

  async function activate() {
    if (result === null || activating) return;
    setActivating(true);
    setActivateError(null);
    try {
      const proposal = await activateProposal(result.proposal.id);
      setResult({ proposal, summary: result.summary, schema: result.schema, diff: result.diff });
      setStep("done");
      refreshList();
      refreshDecisions();
    } catch (e) {
      if (e instanceof DesignError && e.status === 409) {
        setActivateError("This proposal can no longer be activated — its status changed. Check the proposals list below.");
      } else {
        setActivateError(e instanceof Error ? e.message : String(e));
      }
      refreshList();
      refreshDecisions();
    } finally {
      setActivating(false);
    }
  }

  function startOver() {
    setResult(null);
    setDesignError(null);
    setActivateError(null);
    setJobId(null);
    setJob(null);
    setStep("describe");
  }

  async function rowAction(id: string, action: "activate" | "archive") {
    setRowBusy(id);
    setRowError(null);
    try {
      if (action === "activate") await activateProposal(id);
      else await archiveProposal(id);
    } catch (e) {
      if (e instanceof DesignError && e.status === 409) {
        setRowError(`Could not ${action} that proposal — its status changed. The list has been refreshed.`);
      } else {
        setRowError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRowBusy(null);
      refreshList();
      refreshDecisions();
    }
  }

  // Mirrors the Activate affordance in the proposals table below, so an approved
  // decision only points there while that button actually exists.
  const activatableIds = new Set(
    proposals.filter((p) => p.status === "draft" || p.status === "archived").map((p) => p.id),
  );

  return (
    <>
      <Topbar title="AI Studio" subtitle="Describe your business — AI designs your system" />
      <div className="mx-auto max-w-5xl px-8 py-6">
        <StepIndicator current={step === "describe" ? 1 : step === "review" ? 2 : 3} />

        {step === "describe" && inFlight && (
          <DesignProgress job={job} onCancel={cancelJob} />
        )}

        {step === "describe" && !inFlight && (
          <section className="tile mt-6 p-8">
            <h2 className="text-2xl font-black tracking-tight text-ink">
              Describe your company — AI builds your system
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-muted">
              Explain what your business does and what you need to manage. The AI Architect
              designs the entities, roles, and workflows, and you review everything before
              anything goes live.
            </p>

            <div className="mt-6 space-y-5">
              <div className="max-w-md">
                <label htmlFor="system-name" className="label">
                  System name <span className="font-normal normal-case text-ink-faint">(optional)</span>
                </label>
                <input
                  id="system-name"
                  className="field"
                  placeholder="Acme Operations"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={submitting}
                />
              </div>

              <div>
                <label htmlFor="system-description" className="label">
                  What does your company do?
                </label>
                <textarea
                  id="system-description"
                  className="field resize-y"
                  rows={6}
                  maxLength={MAX_DESCRIPTION}
                  placeholder="We are a wholesale coffee distributor: we manage suppliers, purchase orders, roasting batches and deliveries. Warehouse staff receive shipments, account managers own customer orders, and finance approves invoices…"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={submitting}
                />
                <p className="mt-1 text-right text-xs text-ink-faint">
                  {description.length.toLocaleString()} / {MAX_DESCRIPTION.toLocaleString()}
                </p>
              </div>
            </div>

            {designError?.kind === "design_failed" && (
              <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                <p className="font-semibold">{designError.message}</p>
                {designError.attempts !== undefined && designError.attempts > 0 && (
                  <p className="mt-1 text-xs font-medium">
                    Stopped after {designError.attempts}{" "}
                    {designError.attempts === 1 ? "attempt" : "attempts"}.
                  </p>
                )}
                {designError.issues.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {designError.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 font-medium">Refine your description and retry.</p>
              </div>
            )}

            {designError?.kind === "ai_budget_exceeded" && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-semibold">Monthly AI budget exhausted.</p>
                <p className="mt-1">
                  {designError.spentUsd !== undefined && designError.limitUsd !== undefined ? (
                    <>
                      <span className="font-semibold tabular-nums">
                        ${designError.spentUsd.toFixed(2)}
                      </span>{" "}
                      of{" "}
                      <span className="font-semibold tabular-nums">
                        ${designError.limitUsd.toFixed(2)}
                      </span>{" "}
                      used this month. Ask your administrator to raise the AI budget, or try again
                      after it resets.
                    </>
                  ) : (
                    <>
                      Ask your administrator to raise the AI budget, or try again after it resets.
                    </>
                  )}
                </p>
              </div>
            )}

            {designError?.kind === "ai_unavailable" && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-semibold">No AI provider is configured on the server.</p>
                <p className="mt-1">
                  Ask your administrator to set the operate-server AI environment keys
                  (e.g. <code className="font-mono">ANTHROPIC_API_KEY</code> or{" "}
                  <code className="font-mono">OPENAI_API_KEY</code>) and restart, then try again.
                </p>
              </div>
            )}

            {designError?.kind === "async_unavailable" && (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-semibold">Background design is not enabled on this server.</p>
                <p className="mt-1">
                  This build of operate-server has an AI provider but no design job queue. Ask your
                  administrator to enable async design, then try again.
                </p>
              </div>
            )}

            {designError?.kind === "http" && (
              <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                Something went wrong: {designError.message}
              </div>
            )}

            <div className="mt-6 flex items-center gap-4">
              <button
                onClick={() => void generate()}
                disabled={inFlight || description.trim() === ""}
                className="btn-primary"
              >
                Generate system
              </button>
              <span className="text-sm text-ink-faint">
                This usually takes 30–60 seconds — you can watch it work.
              </span>
            </div>
          </section>
        )}

        {step === "review" && result !== null && (
          <section className="mt-6">
            <div className="card p-6">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl font-extrabold tracking-tight text-ink">{result.proposal.name}</h2>
                <span className="chip">draft</span>
                {result.proposal.providerLabel && (
                  <span className="chip">via {result.proposal.providerLabel}</span>
                )}
                <span className="chip font-mono">#{result.proposal.manifestHash.slice(0, 12)}</span>
              </div>
              <p className="mt-1 text-sm text-ink-muted">
                Review what the AI designed. Nothing is live until you activate it.
              </p>

              <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Entities" value={result.summary.entityCount} accent />
                <Stat label="Roles" value={result.summary.roleCount} />
                <Stat label="Relations" value={result.summary.relationCount} />
                <Stat label="Workflows" value={result.summary.workflowCount} />
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {result.summary.entities.map((e) => (
                  <div key={e.name} className="tile">
                    <div className="text-sm font-bold text-ink">{e.label}</div>
                    <div className="font-mono text-xs text-ink-faint">{e.name}</div>
                    <div className="mt-2">
                      <span className="chip">
                        {e.fieldCount} {e.fieldCount === 1 ? "field" : "fields"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {result.diff !== undefined && (
                <div className="mt-6 border-t border-line pt-5">
                  <div className="label">Changes on activation</div>
                  <p className="mb-3 text-sm text-ink-muted">
                    What activating this system will do to your live system.
                  </p>
                  <DiffView diff={result.diff} />
                </div>
              )}

              {result.schema !== undefined && (
                <div className="mt-6 border-t border-line pt-5">
                  <div className="label">Designed schema</div>
                  <p className="mb-3 text-sm text-ink-muted">
                    Exactly what activating this system will create — every field, permission and
                    workflow state.
                  </p>
                  {/* Keyed by proposal: collapse state must not leak between designs. */}
                  <SchemaView key={result.proposal.id} schema={result.schema} />
                </div>
              )}

              {activateError && (
                <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                  {activateError}
                </div>
              )}

              <div className="mt-6 flex gap-3">
                <button onClick={() => void activate()} disabled={activating} className="btn-primary">
                  {activating ? "Activating…" : "Activate this system"}
                </button>
                <button onClick={startOver} disabled={activating} className="btn-ghost">
                  Start over
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "done" && result !== null && (
          <section className="tile mt-6 p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-2xl">
              ✓
            </div>
            <h2 className="mt-4 text-2xl font-black tracking-tight text-ink">Your system is live</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-ink-muted">
              <span className="font-semibold text-ink">{result.proposal.name}</span> is now active
              and its schema is served immediately — every screen, table, and workflow is ready to use.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              {/* Full page navigation on purpose: the schema module cache has no
                  invalidate export, so a hard load refetches the new schema. */}
              <a href="/" className="btn-primary">
                Open Dashboard
              </a>
              <button onClick={startOver} className="btn-ghost">
                Design another system
              </button>
            </div>
          </section>
        )}

        {digests.length > 0 && (
          <section className="mt-10">
            <h3 className="text-sm font-bold uppercase tracking-wide text-ink-muted">Summaries</h3>
            <p className="mt-1 text-sm text-ink-muted">
              Notices grouped into one message because of your quiet-hours settings.
            </p>
            <div className="card mt-3 divide-y divide-line">
              {digests.map((n) => (
                <DigestRow key={n.dispatchId} notification={n} />
              ))}
            </div>
          </section>
        )}

        {(decisionsBusy || decisionsError !== null || decisions.length > 0) && (
          <section className="mt-10">
            <h3 className="text-sm font-bold uppercase tracking-wide text-ink-muted">Review decisions</h3>
            <p className="mt-1 text-sm text-ink-muted">
              What the platform reviewers decided about the systems you submitted.
            </p>

            {decisionsBusy && decisions.length === 0 && decisionsError === null && (
              <p className="mt-3 text-sm text-ink-faint">Loading decisions…</p>
            )}
            {decisionsError !== null && decisions.length === 0 && (
              <p className="mt-3 text-sm text-ink-faint">
                Could not load review decisions: {decisionsError}
              </p>
            )}

            {decisions.length > 0 && (
              <div className="card mt-3 divide-y divide-line">
                {decisions.map((n) => (
                  <DecisionRow
                    key={n.dispatchId}
                    notification={n}
                    activatable={
                      n.correlationId !== null && activatableIds.has(n.correlationId)
                    }
                  />
                ))}
              </div>
            )}
          </section>
        )}

        <section className="mt-10" id={PROPOSALS_ANCHOR}>
          <h3 className="text-sm font-bold uppercase tracking-wide text-ink-muted">Previous proposals</h3>

          {rowError && (
            <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
              {rowError}
            </div>
          )}
          {listError && (
            <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
              Could not load proposals: {listError}. Is operate-server running?
            </div>
          )}

          <div className="card mt-3 overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Created</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {listBusy && proposals.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-ink-faint">
                      Loading…
                    </td>
                  </tr>
                )}
                {!listBusy && proposals.length === 0 && listError === null && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-ink-faint">
                      No proposals yet — describe your company above.
                    </td>
                  </tr>
                )}
                {proposals.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="font-semibold text-ink">{p.name}</span>
                      {p.description.trim() !== "" && (
                        <span className="mt-0.5 block max-w-md truncate text-xs text-ink-faint">
                          {p.description}
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusChip status={p.status} />
                    </td>
                    <td className="text-ink-muted">{p.providerLabel ?? "—"}</td>
                    <td className="text-ink-muted">{new Date(p.createdAt).toLocaleString()}</td>
                    <td className="text-right">
                      <div className="flex justify-end gap-2">
                        {(p.status === "draft" || p.status === "archived") && (
                          <button
                            onClick={() => void rowAction(p.id, "activate")}
                            disabled={rowBusy !== null}
                            className="text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
                          >
                            {rowBusy === p.id ? "Working…" : "Activate"}
                          </button>
                        )}
                        {(p.status === "draft" || p.status === "active") && (
                          <button
                            onClick={() => void rowAction(p.id, "archive")}
                            disabled={rowBusy !== null}
                            className="text-sm font-medium text-ink-muted hover:text-ink disabled:opacity-50"
                          >
                            {rowBusy === p.id ? "Working…" : "Archive"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}

const PHASE_LINES: Readonly<Record<DesignJob["phase"], string>> = {
  queued: "Queued…",
  generating: "Designing your system…",
  validating: "Checking the design…",
  retrying: "Refining the design…",
  done: "Finishing up…",
  error: "Something went wrong…",
};

const PHASE_HINTS: Readonly<Record<DesignJob["phase"], string>> = {
  queued: "Waiting for a design worker to pick this up.",
  generating: "Writing your entities, fields, roles, relations and workflows.",
  validating: "Cross-checking every reference, permission and workflow transition.",
  retrying: "The first draft did not validate cleanly — the AI is correcting it.",
  done: "Assembling the proposal for review.",
  error: "The design could not be completed.",
};

function phaseLine(job: DesignJob | null): string {
  if (job === null) return "Starting…";
  if (job.phase === "retrying") {
    return `Refining (attempt ${job.attempt} of ${job.maxAttempts})…`;
  }
  return PHASE_LINES[job.phase];
}

/**
 * Width is a monotone function of phase, and inside `generating` it tracks
 * outputChars — so the bar advancing IS the liveness signal, never a fake timer.
 */
function progressPct(job: DesignJob | null): number {
  if (job === null) return 4;
  switch (job.phase) {
    case "queued":
      return 6;
    case "generating":
      return 12 + Math.min(62, (job.outputChars / 9000) * 62);
    case "validating":
      return 84;
    case "retrying":
      return 72;
    case "done":
    case "error":
      return 100;
  }
}

function DesignProgress({ job, onCancel }: { job: DesignJob | null; onCancel: () => void }) {
  const pct = progressPct(job);
  const chars = job?.outputChars ?? 0;
  const issues = job?.issues ?? [];
  const showIssues = job !== null && job.phase === "retrying" && issues.length > 0;

  return (
    <section className="card mt-6 p-8">
      {/* The design system defines no keyframes; this one moves the stripe. */}
      <style>{"@keyframes ce-stripe{from{background-position:0 0}to{background-position:1.4142rem 0}}"}</style>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-brand" />
          </span>
          <h2 className="text-xl font-black tracking-tight text-ink">{phaseLine(job)}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job !== null && job.attempt >= 1 && (
            <span className="chip">
              attempt {job.attempt} of {job.maxAttempts}
            </span>
          )}
          {job?.providerLabel && <span className="chip">via {job.providerLabel}</span>}
        </div>
      </div>

      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        {job === null ? PHASE_HINTS.queued : PHASE_HINTS[job.phase]}
      </p>

      <div className="mt-6">
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-700 ease-out"
            style={{
              width: `${pct}%`,
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(255,255,255,0.28) 0 0.5rem, rgba(255,255,255,0) 0.5rem 1rem)",
              animation: "ce-stripe 900ms linear infinite",
            }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            aria-label={phaseLine(job)}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-bold tabular-nums text-ink">
            {chars.toLocaleString()}{" "}
            <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              characters generated
            </span>
          </span>
          <span className="text-xs text-ink-faint">This usually takes 30–60 seconds.</span>
        </div>
      </div>

      {showIssues && (
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-900">
            Fixing {issues.length} validation {issues.length === 1 ? "issue" : "issues"}
          </p>
          <ul className="mt-2 space-y-1">
            {issues.slice(0, 3).map((issue, i) => (
              <li key={i} className="flex gap-2 text-xs text-amber-800">
                <span aria-hidden className="text-amber-500">
                  •
                </span>
                <span className="min-w-0 flex-1">{issue}</span>
              </li>
            ))}
          </ul>
          {issues.length > 3 && (
            <p className="mt-1.5 text-xs font-medium text-amber-700">
              +{issues.length - 3} more being corrected
            </p>
          )}
        </div>
      )}

      <div className="mt-6 flex items-center gap-4">
        <button onClick={onCancel} className="btn-ghost">
          Cancel
        </button>
        <span className="text-xs text-ink-faint">
          Cancelling stops watching here — the design keeps running on the server and will appear
          under “Previous proposals”.
        </span>
      </div>
    </section>
  );
}

const STEPS: ReadonlyArray<string> = ["Describe", "Review", "Go live"];

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const reached = n <= current;
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-8 bg-line" />}
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                reached ? "bg-brand text-white" : "bg-surface-sunken text-ink-faint"
              }`}
            >
              {n}
            </span>
            <span className={`text-sm font-semibold ${reached ? "text-ink" : "text-ink-faint"}`}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`card p-4 ${accent ? "ring-1 ring-brand/20" : ""}`}>
      <div className={`text-2xl font-black ${accent ? "text-brand" : "text-ink"}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}

function DecisionChip({ decision }: { decision: ReviewDecision }) {
  if (decision === "approved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 ring-1 ring-brand-200">
        <span aria-hidden>✓</span>
        approved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-muted ring-1 ring-line">
      <span aria-hidden>✕</span>
      rejected
    </span>
  );
}

function DigestRow({ notification }: { notification: TenantNotification }) {
  const digest = notification.digest;
  if (digest == null) return null;
  const at = decidedAtOf(notification);
  const label = Number.isNaN(Date.parse(at)) ? at : new Date(at).toLocaleString();

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center rounded-md bg-surface-soft px-2 py-0.5 text-[11px] font-semibold text-ink-muted">
          {digest.itemCount} grouped
        </span>
        <span className="font-semibold text-ink">{digest.title}</span>
        <span className="ml-auto text-xs tabular-nums text-ink-faint">{label}</span>
      </div>
      {/* The body is rendered server-side from the digest's own pool, with every substituted
          value HTML-escaped by the template renderer before it reaches this component. */}
      <div
        className="prose-digest mt-2 text-sm text-ink-muted"
        dangerouslySetInnerHTML={{ __html: digest.body }}
      />
    </div>
  );
}

function DecisionRow({
  notification,
  activatable,
}: {
  notification: TenantNotification;
  activatable: boolean;
}) {
  const decision = decisionOf(notification);
  if (decision === null) return null;

  const proposal = notification.proposal ?? null;
  const name = proposal !== null && proposal.name.trim() !== "" ? proposal.name : null;
  const notes = proposal?.reviewNotes?.trim() ?? "";
  const decidedAt = decidedAtOf(notification);
  const decidedLabel = Number.isNaN(Date.parse(decidedAt))
    ? decidedAt
    : new Date(decidedAt).toLocaleString();

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <DecisionChip decision={decision} />
        {name !== null ? (
          <span className="font-semibold text-ink">{name}</span>
        ) : (
          <span className="font-mono text-xs text-ink-muted">
            {notification.correlationId ?? "unknown proposal"}
          </span>
        )}
        <span className="ml-auto text-xs tabular-nums text-ink-faint">{decidedLabel}</span>
      </div>

      {notes !== "" && (
        <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-sm text-ink-muted">
          {notes}
        </blockquote>
      )}

      {decision === "approved" && activatable && (
        <a
          href={`#${PROPOSALS_ANCHOR}`}
          className="mt-2 inline-block text-sm font-medium text-brand-600 hover:text-brand-700"
        >
          Ready to activate — find it under Previous proposals ↓
        </a>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: ProposalStatus }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
        active
      </span>
    );
  }
  if (status === "archived") {
    return (
      <span className="inline-flex items-center rounded-md bg-surface-soft px-2 py-0.5 text-[11px] font-semibold text-ink-faint">
        archived
      </span>
    );
  }
  return <span className="chip">draft</span>;
}
