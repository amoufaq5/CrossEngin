// AI design (setup wizard) API helpers. Like lib/platform.ts, every request
// goes to this Next app's /api proxy, which forwards to operate-server with the
// server's credentials — same-origin, so no CORS. All paths hit /api/v1/ai/...

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

export interface DesignResult {
  readonly proposal: Proposal;
  readonly summary: ProposalSummary;
}

export interface DesignInput {
  readonly description: string;
  readonly name?: string;
}

export interface ProposalPage {
  readonly data: ReadonlyArray<Proposal>;
  readonly nextCursor: string | null;
}

export type DesignErrorKind = "design_failed" | "ai_unavailable" | "http";

export class DesignError extends Error {
  readonly kind: DesignErrorKind;
  readonly status: number;
  readonly issues: ReadonlyArray<string>;
  readonly attempts: number | undefined;

  constructor(
    kind: DesignErrorKind,
    status: number,
    message: string,
    issues: ReadonlyArray<string> = [],
    attempts?: number,
  ) {
    super(message);
    this.name = "DesignError";
    this.kind = kind;
    this.status = status;
    this.issues = issues;
    this.attempts = attempts;
  }
}

function apiPath(suffix = ""): string {
  return `/api/v1/ai${suffix}`;
}

async function throwDesignError(res: Response): Promise<never> {
  let message = res.statusText || `Request failed (${res.status})`;
  let kind: DesignErrorKind = res.status === 503 ? "ai_unavailable" : "http";
  let issues: string[] = [];
  let attempts: number | undefined;
  try {
    const text = await res.text();
    if (text !== "") {
      try {
        const body = JSON.parse(text) as {
          error?: unknown;
          issues?: unknown;
          attempts?: unknown;
          detail?: unknown;
          title?: unknown;
          message?: unknown;
        };
        if (res.status === 422 && body.error === "design_failed") {
          kind = "design_failed";
          if (Array.isArray(body.issues)) {
            issues = body.issues.filter((i): i is string => typeof i === "string");
          }
          if (typeof body.attempts === "number") attempts = body.attempts;
          message = "The AI could not produce a valid system from that description.";
        } else if (kind === "ai_unavailable") {
          message = "No AI provider is configured on the server.";
        } else {
          const picked = body.detail ?? body.title ?? body.message ?? body.error;
          message = typeof picked === "string" && picked.trim() !== "" ? picked : text;
        }
      } catch {
        if (kind === "ai_unavailable") {
          message = "No AI provider is configured on the server.";
        } else {
          message = text;
        }
      }
    } else if (kind === "ai_unavailable") {
      message = "No AI provider is configured on the server.";
    }
  } catch {
    // keep the status-line fallback
  }
  throw new DesignError(kind, res.status, message, issues, attempts);
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
