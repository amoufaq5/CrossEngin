// PLATFORM design-review API helpers. Like lib/platform.ts, every request goes
// to this Next app's /api proxy, which forwards to operate-server with the
// server's x-api-key — so the browser never holds a platform credential and
// there are no CORS concerns. All paths hit /api/v1/platform/design-reviews...

export type ReviewStatus = "not_required" | "pending" | "approved" | "rejected";

export type RiskLevel = "low" | "medium" | "high";

export interface Review {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string;
  readonly manifestHash: string;
  readonly status: string;
  readonly reviewStatus: ReviewStatus;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNotes: string | null;
  readonly providerLabel: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The detail endpoint is the only one that ships the manifest document. */
export interface ReviewWithManifest extends Review {
  readonly manifest: unknown;
}

export interface RiskFinding {
  readonly code: string;
  readonly level: RiskLevel;
  readonly message: string;
  readonly entities: ReadonlyArray<string>;
}

export interface RiskCounts {
  readonly entities: number;
  readonly fields: number;
  readonly roles: number;
  readonly relations: number;
  readonly sensitiveFields: number;
}

export interface RiskReport {
  readonly level: RiskLevel;
  readonly findings: ReadonlyArray<RiskFinding>;
  readonly counts: RiskCounts;
}

/** List rows carry the risk assessment but never the manifest itself. */
export interface ReviewListItem extends Review {
  readonly risk: RiskReport;
}

export interface ReviewPage {
  readonly data: ReadonlyArray<ReviewListItem>;
  readonly nextCursor: string | null;
}

export interface ReviewDetail {
  readonly review: ReviewWithManifest;
  readonly risk: RiskReport;
}

export interface ReviewCounts {
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
  readonly notRequired: number;
  readonly total: number;
}

export interface ReviewQuery {
  readonly reviewStatus?: string;
  readonly tenantId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export type ReviewDecision = "approve" | "reject";

/**
 * An error carrying the HTTP status + the parsed problem detail, so pages can
 * both branch on the status and surface a human message inline.
 */
export class ReviewError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ReviewError";
    this.status = status;
    this.code = code;
  }
}

/**
 * A 409 from approve/reject: someone else already decided this proposal, so the
 * transition is illegal. Distinct type because the page must recover from it
 * (refresh the row) rather than treat it as a transport failure.
 */
export class ReviewConflictError extends ReviewError {
  constructor(message: string, code: string | null = null) {
    super(409, message, code);
    this.name = "ReviewConflictError";
  }
}

const CODE_MESSAGES: Record<string, string> = {
  illegal_transition:
    "This proposal has already been reviewed — its current decision is shown below.",
  not_found: "This proposal no longer exists.",
};

function apiPath(suffix = ""): string {
  return `/api/v1/platform/design-reviews${suffix}`;
}

/**
 * Reads a non-2xx response body and extracts the best human message from an
 * RFC 9457 problem document ({ detail | title | message }) or a bare
 * { error: "code" } envelope. Throws a ReviewConflictError for 409, otherwise a
 * ReviewError carrying the status.
 */
async function throwProblem(res: Response): Promise<never> {
  let message = res.statusText || `Request failed (${res.status})`;
  let code: string | null = null;
  try {
    const text = await res.text();
    if (text !== "") {
      try {
        const body = JSON.parse(text) as {
          detail?: unknown;
          title?: unknown;
          message?: unknown;
          error?: unknown;
        };
        if (typeof body.error === "string" && body.error.trim() !== "") code = body.error;
        const picked = body.detail ?? body.title ?? body.message;
        if (typeof picked === "string" && picked.trim() !== "") {
          message = picked;
        } else if (code !== null) {
          message = CODE_MESSAGES[code] ?? code;
        } else {
          message = text;
        }
      } catch {
        message = text;
      }
    }
  } catch {
    // keep the status-line fallback
  }
  if (res.status === 409) throw new ReviewConflictError(message, code);
  throw new ReviewError(res.status, message, code);
}

async function getJson<T>(suffix: string): Promise<T> {
  const res = await fetch(apiPath(suffix), { headers: { accept: "application/json" } });
  if (!res.ok) await throwProblem(res);
  return (await res.json()) as T;
}

export async function listReviews(query: ReviewQuery = {}): Promise<ReviewPage> {
  const p = new URLSearchParams();
  if (query.reviewStatus && query.reviewStatus !== "all") p.set("reviewStatus", query.reviewStatus);
  if (query.tenantId && query.tenantId.trim() !== "") p.set("tenantId", query.tenantId.trim());
  if (query.limit !== undefined) p.set("limit", String(query.limit));
  if (query.cursor) p.set("cursor", query.cursor);
  const qs = p.toString();
  const json = await getJson<{
    data?: ReviewListItem[];
    page?: { nextCursor?: string | null };
  }>(qs ? `?${qs}` : "");
  return { data: json.data ?? [], nextCursor: json.page?.nextCursor ?? null };
}

export async function reviewStats(): Promise<ReviewCounts> {
  const json = await getJson<{ counts: ReviewCounts }>("/stats");
  return json.counts;
}

export async function getReview(id: string): Promise<ReviewDetail> {
  return getJson<ReviewDetail>(`/${encodeURIComponent(id)}`);
}

async function postDecision(
  id: string,
  decision: ReviewDecision,
  notes?: string,
): Promise<Review> {
  const trimmed = notes?.trim() ?? "";
  const res = await fetch(apiPath(`/${encodeURIComponent(id)}/${decision}`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(trimmed === "" ? {} : { notes: trimmed }),
  });
  if (!res.ok) await throwProblem(res);
  const json = (await res.json()) as { review: Review };
  return json.review;
}

export async function approveReview(id: string, notes?: string): Promise<Review> {
  return postDecision(id, "approve", notes);
}

export async function rejectReview(id: string, notes?: string): Promise<Review> {
  return postDecision(id, "reject", notes);
}
