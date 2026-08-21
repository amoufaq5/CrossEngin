"use client";

import { useCallback, useEffect, useState } from "react";

import { Topbar } from "@/components/Topbar";
import {
  activateProposal,
  archiveProposal,
  DesignError,
  designSystem,
  listProposals,
  type DesignResult,
  type Proposal,
  type ProposalStatus,
} from "@/lib/design";

const MAX_DESCRIPTION = 4000;

type Step = "describe" | "review" | "done";

export default function SetupPage() {
  const [step, setStep] = useState<Step>("describe");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [designError, setDesignError] = useState<DesignError | null>(null);
  const [result, setResult] = useState<DesignResult | null>(null);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  const [proposals, setProposals] = useState<ReadonlyArray<Proposal>>([]);
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const refreshList = useCallback(() => {
    setListError(null);
    listProposals()
      .then((page) => setProposals(page.data))
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : String(e)))
      .finally(() => setListBusy(false));
  }, []);

  useEffect(() => refreshList(), [refreshList]);

  async function generate() {
    if (description.trim() === "" || generating) return;
    setGenerating(true);
    setDesignError(null);
    try {
      const res = await designSystem({ description: description.trim(), name });
      setResult(res);
      setActivateError(null);
      setStep("review");
      refreshList();
    } catch (e) {
      setDesignError(
        e instanceof DesignError
          ? e
          : new DesignError("http", 0, e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setGenerating(false);
    }
  }

  async function activate() {
    if (result === null || activating) return;
    setActivating(true);
    setActivateError(null);
    try {
      const proposal = await activateProposal(result.proposal.id);
      setResult({ proposal, summary: result.summary });
      setStep("done");
      refreshList();
    } catch (e) {
      if (e instanceof DesignError && e.status === 409) {
        setActivateError("This proposal can no longer be activated — its status changed. Check the proposals list below.");
      } else {
        setActivateError(e instanceof Error ? e.message : String(e));
      }
      refreshList();
    } finally {
      setActivating(false);
    }
  }

  function startOver() {
    setResult(null);
    setDesignError(null);
    setActivateError(null);
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
    }
  }

  return (
    <>
      <Topbar title="AI Studio" subtitle="Describe your business — AI designs your system" />
      <div className="mx-auto max-w-5xl px-8 py-6">
        <StepIndicator current={step === "describe" ? 1 : step === "review" ? 2 : 3} />

        {step === "describe" && (
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
                  disabled={generating}
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
                  disabled={generating}
                />
                <p className="mt-1 text-right text-xs text-ink-faint">
                  {description.length.toLocaleString()} / {MAX_DESCRIPTION.toLocaleString()}
                </p>
              </div>
            </div>

            {designError?.kind === "design_failed" && (
              <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                <p className="font-semibold">
                  The AI could not produce a valid system from that description
                  {designError.attempts !== undefined ? ` (after ${designError.attempts} attempts)` : ""}.
                </p>
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

            {designError?.kind === "http" && (
              <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                Something went wrong: {designError.message}
              </div>
            )}

            <div className="mt-6 flex items-center gap-4">
              <button
                onClick={() => void generate()}
                disabled={generating || description.trim() === ""}
                className="btn-primary"
              >
                {generating ? "Generating…" : "Generate system"}
              </button>
              {generating && (
                <span className="flex items-center gap-2 text-sm font-medium text-ink-muted">
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                  <span className="animate-pulse">Designing your system… this can take about a minute.</span>
                </span>
              )}
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

        <section className="mt-10">
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
