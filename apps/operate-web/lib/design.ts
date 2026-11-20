// AI design (setup wizard) API helpers. Like lib/platform.ts, every request
// goes to this Next app's /api proxy, which turns the caller's session cookie into
// the API's bearer token — same-origin, so no CORS. All paths hit /api/v1/ai/...

import type { ManifestDiffView } from "@/components/DiffView";
import type { ManifestView } from "@/components/SchemaView";
import { handleUnauthorized } from "@/lib/unauthorized";

export type { ManifestDiffView, ManifestView };

export type ProposalStatus = "draft" | "active" | "archived";

export interface Proposal {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: ProposalStatus;
  readonly source: string;
  readonly providerLabel: string | null;
  readonly manifestHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
}

export interface ProposalEntitySummary {
  readonly name: string;
  readonly label: string;
  readonly fieldCount: number;
}

export interface ProposalSummary {
  readonly entityCount: number;
  readonly roleCount: number;
  readonly relationCount: number;
  readonly workflowCount: number;
  readonly entities: ReadonlyArray<ProposalEntitySummary>;
}

export type DesignSummary = ProposalSummary;

export interface DesignResult {
  readonly proposal: Proposal;
  readonly summary: ProposalSummary;
  /** Absent when the server has no manifest projector wired — render nothing. */
  readonly schema?: ManifestView;
  /** Absent when the server has no differ wired — render nothing. */
  readonly diff?: ManifestDiffView;
}

export type DesignJobStatus = "queued" | "running" | "succeeded" | "failed";

export type DesignJobPhase =
  | "queued"
  | "generating"
  | "validating"
  | "retrying"
  | "done"
  | "error";

export interface DesignJob {
  readonly id: string;
  readonly status: DesignJobStatus;
  readonly phase: DesignJobPhase;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly name: string;
  readonly description: string;
  readonly outputChars: number;
  readonly issues: ReadonlyArray<string>;
  readonly proposalId: string | null;
  readonly providerLabel: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DesignJobPoll {
  readonly job: DesignJob;
  readonly proposal?: Proposal | null;
  readonly summary?: DesignSummary | null;
  readonly schema?: ManifestView | null;
  readonly diff?: ManifestDiffView | null;
}

export interface DesignInput {
  readonly description: string;
  readonly name?: string;
}

export interface ProposalPage {
  readonly data: ReadonlyArray<Proposal>;
  readonly nextCursor: string | null;
}

export type DesignErrorKind =
  | "design_failed"
  | "ai_unavailable"
  | "async_unavailable"
  | "ai_budget_exceeded"
  | "http";

export interface DesignErrorDetails {
  readonly spentUsd?: number;
  readonly limitUsd?: number;
}

export class DesignError extends Error {
  readonly kind: DesignErrorKind;
  readonly status: number;
  readonly issues: ReadonlyArray<string>;
  readonly attempts: number | undefined;
  readonly spentUsd: number | undefined;
  readonly limitUsd: number | undefined;
  /** The body's `error` code, when it carried one — what tells a role refusal from another 403. */
  readonly code: string | null;

  constructor(
    kind: DesignErrorKind,
    status: number,
    message: string,
    issues: ReadonlyArray<string> = [],
    attempts?: number,
    details: DesignErrorDetails = {},
    code: string | null = null,
  ) {
    super(message);
    this.name = "DesignError";
    this.kind = kind;
    this.status = status;
    this.issues = issues;
    this.attempts = attempts;
    this.spentUsd = details.spentUsd;
    this.limitUsd = details.limitUsd;
    this.code = code;
  }
}

function apiPath(suffix = ""): string {
  return `/api/v1/ai${suffix}`;
}

const NO_PROVIDER = "No AI provider is configured on the server.";
const NO_ASYNC = "Background design is not enabled on this server.";

async function throwDesignError(res: Response): Promise<never> {
  // The single error path of this module's six requests, so one call covers all of them.
  handleUnauthorized(res);
  let message = res.statusText || `Request failed (${res.status})`;
  let kind: DesignErrorKind = res.status === 503 ? "ai_unavailable" : "http";
  let issues: string[] = [];
  let attempts: number | undefined;
  let details: DesignErrorDetails = {};
  let code: string | null = null;
  try {
    const text = await res.text();
    if (text !== "") {
      try {
        const body = JSON.parse(text) as {
          error?: unknown;
          type?: unknown;
          reason?: unknown;
          extensions?: unknown;
          issues?: unknown;
          attempts?: unknown;
          spentUsd?: unknown;
          limitUsd?: unknown;
          detail?: unknown;
          title?: unknown;
          message?: unknown;
        };
        // A residency refusal is an RFC 9457 problem whose code is `extensions.error` (ADR-0462);
        // every other refusal on these routes carries it at the top level.
        const extensionCode =
          typeof body.extensions === "object" && body.extensions !== null && "error" in body.extensions
            ? body.extensions.error
            : undefined;
        const rawCode = typeof body.error === "string" ? body.error : extensionCode;
        if (typeof rawCode === "string" && rawCode.trim() !== "") code = rawCode;
        // A 503 is "no AI provider" only when the body says so. Three other producers answer 503
        // on these routes ahead of or beside the AI gate — the region gate (a problem whose code is
        // `extensions.reason`, with no `error` at all), the tenant-status gate (top-level `reason`)
        // and the AI provider's residency check (`extensions.error`) — and reading any of them as a
        // missing provider names a cause that is false and a remedy that cannot work. So a problem
        // document, or any body carrying a reason, keeps the server's own sentence; only a body
        // naming nothing at all falls back to the missing-provider reading, as before.
        const extensions =
          typeof body.extensions === "object" && body.extensions !== null
            ? (body.extensions as { reason?: unknown })
            : undefined;
        const namesACause =
          code !== null ||
          typeof body.type === "string" ||
          typeof body.reason === "string" ||
          typeof extensions?.reason === "string";
        if (kind === "ai_unavailable" && namesACause && code !== "ai_unavailable") kind = "http";
        if (res.status === 422 && body.error === "design_failed") {
          kind = "design_failed";
          if (Array.isArray(body.issues)) {
            issues = body.issues.filter((i): i is string => typeof i === "string");
          }
          if (typeof body.attempts === "number") attempts = body.attempts;
          message = "The AI could not produce a valid system from that description.";
        } else if (res.status === 402 && body.error === "ai_budget_exceeded") {
          kind = "ai_budget_exceeded";
          details = {
            spentUsd: typeof body.spentUsd === "number" ? body.spentUsd : undefined,
            limitUsd: typeof body.limitUsd === "number" ? body.limitUsd : undefined,
          };
          message = "The monthly AI budget for this workspace is exhausted.";
        } else if (res.status === 503 && body.error === "async_unavailable") {
          kind = "async_unavailable";
          message = NO_ASYNC;
        } else if (res.status === 404 && body.error === "job_not_found") {
          message = "That design job is no longer available on the server.";
        } else if (kind === "ai_unavailable") {
          message = NO_PROVIDER;
        } else {
          const picked = body.detail ?? body.title ?? body.message ?? body.error;
          message = typeof picked === "string" && picked.trim() !== "" ? picked : text;
        }
      } catch {
        if (kind === "ai_unavailable") {
          message = NO_PROVIDER;
        } else {
          message = text;
        }
      }
    } else if (kind === "ai_unavailable") {
      message = NO_PROVIDER;
    }
  } catch {
    // keep the status-line fallback
  }
  throw new DesignError(kind, res.status, message, issues, attempts, details, code);
}

export async function designSystem(input: DesignInput): Promise<DesignResult> {
  const body: { description: string; name?: string } = { description: input.description };
  if (input.name !== undefined && input.name.trim() !== "") body.name = input.name.trim();
  const res = await fetch(apiPath("/design"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwDesignError(res);
  return (await res.json()) as DesignResult;
}

export async function startDesignJob(input: DesignInput): Promise<DesignJob> {
  const body: { description: string; name?: string } = { description: input.description };
  if (input.name !== undefined && input.name.trim() !== "") body.name = input.name.trim();
  const res = await fetch(apiPath("/design/jobs"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwDesignError(res);
  const json = (await res.json()) as { job: DesignJob };
  return json.job;
}

export async function getDesignJob(id: string): Promise<DesignJobPoll> {
  const res = await fetch(apiPath(`/design/jobs/${encodeURIComponent(id)}`), {
    headers: { accept: "application/json" },
    // A poll must never be served from the bfcache/HTTP cache: a stale 200
    // would freeze the progress panel on an old phase forever.
    cache: "no-store",
  });
  if (!res.ok) await throwDesignError(res);
  return (await res.json()) as DesignJobPoll;
}

export async function listProposals(): Promise<ProposalPage> {
  const res = await fetch(apiPath("/manifests"), { headers: { accept: "application/json" } });
  if (!res.ok) await throwDesignError(res);
  const json = (await res.json()) as { data?: Proposal[]; page?: { nextCursor?: string | null } };
  return { data: json.data ?? [], nextCursor: json.page?.nextCursor ?? null };
}

export async function getProposal(id: string): Promise<DesignResult> {
  const res = await fetch(apiPath(`/manifests/${encodeURIComponent(id)}`), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) await throwDesignError(res);
  return (await res.json()) as DesignResult;
}

async function postAction(id: string, action: "activate" | "archive"): Promise<Proposal> {
  const res = await fetch(apiPath(`/manifests/${encodeURIComponent(id)}/${action}`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  if (!res.ok) await throwDesignError(res);
  const json = (await res.json()) as { proposal: Proposal };
  return json.proposal;
}

export async function activateProposal(id: string): Promise<Proposal> {
  return postAction(id, "activate");
}

export async function archiveProposal(id: string): Promise<Proposal> {
  return postAction(id, "archive");
}
