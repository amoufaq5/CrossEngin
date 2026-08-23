// TENANT notification API helpers. Like lib/platform.ts, every request goes to
// this Next app's /api proxy, which forwards to operate-server with the server's
// x-api-key — so the browser never holds a credential and there are no CORS
// concerns. All paths hit /api/v1/meta/notifications...

export type ReviewDecision = "approved" | "rejected";

/**
 * The readable half of a decision notice. The dispatch row stores only a hash of
 * its message variables by design, so the server joins the proposal record to
 * supply the human content — which it can only do while that record still
 * exists. Absent, null, and populated are all normal.
 */
export interface NotificationProposal {
  readonly name: string;
  readonly reviewStatus: string;
  readonly reviewNotes: string | null;
  readonly reviewedAt: string | null;
}

export interface TenantNotification {
  readonly dispatchId: string;
  readonly templateId: string;
  readonly channel: string;
  readonly category: string;
  readonly priority: string;
  /** The proposal id this notice is about, when the dispatch carries one. */
  readonly correlationId: string | null;
  readonly status: string;
  readonly queuedAt: string;
  readonly requestingSystem: string;
  readonly proposal?: NotificationProposal | null;
}

export interface NotificationPage {
  readonly data: ReadonlyArray<TenantNotification>;
  readonly nextCursor: string | null;
}

export interface NotificationQuery {
  readonly channel?: string;
  readonly templateId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * An error carrying the HTTP status + the parsed problem detail, so pages can
 * both branch on the status and surface a human message inline.
 */
export class NotificationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NotificationError";
    this.status = status;
  }
}

function apiPath(suffix = ""): string {
  return `/api/v1/meta/notifications${suffix}`;
}

/**
 * Reads a non-2xx response body and extracts the best human message from an
 * RFC 9457 problem document ({ detail | title | message }), falling back to the
 * raw text or status line. Throws a NotificationError carrying the status.
 */
async function throwProblem(res: Response): Promise<never> {
  let message = res.statusText || `Request failed (${res.status})`;
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
        const picked = body.detail ?? body.title ?? body.message ?? body.error;
        message = typeof picked === "string" && picked.trim() !== "" ? picked : text;
      } catch {
        message = text;
      }
    }
  } catch {
    // keep the status-line fallback
  }
  throw new NotificationError(res.status, message);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Every field beyond the identity pair may be missing on the wire, so each row is
 * coerced rather than cast: a partial dispatch renders as an incomplete notice
 * instead of throwing on a property access deep inside the tree.
 */
function toProposal(raw: unknown): NotificationProposal | null {
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  return {
    name: str(p["name"]),
    reviewStatus: str(p["reviewStatus"]),
    reviewNotes: nullableStr(p["reviewNotes"]),
    reviewedAt: nullableStr(p["reviewedAt"]),
  };
}

function toNotification(raw: unknown): TenantNotification | null {
  if (raw === null || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  const dispatchId = str(n["dispatchId"]);
  if (dispatchId === "") return null;
  return {
    dispatchId,
    templateId: str(n["templateId"]),
    channel: str(n["channel"]),
    category: str(n["category"]),
    priority: str(n["priority"]),
    correlationId: nullableStr(n["correlationId"]),
    status: str(n["status"]),
    queuedAt: str(n["queuedAt"]),
    requestingSystem: str(n["requestingSystem"]),
    proposal: toProposal(n["proposal"]),
  };
}

export async function listNotifications(query: NotificationQuery = {}): Promise<NotificationPage> {
  const p = new URLSearchParams();
  if (query.channel && query.channel.trim() !== "") p.set("channel", query.channel.trim());
  if (query.templateId && query.templateId.trim() !== "") p.set("templateId", query.templateId.trim());
  if (query.limit !== undefined) p.set("limit", String(query.limit));
  if (query.cursor) p.set("cursor", query.cursor);
  const qs = p.toString();

  const res = await fetch(apiPath(qs ? `?${qs}` : ""), { headers: { accept: "application/json" } });
  if (!res.ok) await throwProblem(res);
  const json = (await res.json()) as { data?: unknown; page?: { nextCursor?: string | null } };

  const rows = Array.isArray(json.data) ? json.data : [];
  const data: TenantNotification[] = [];
  for (const row of rows) {
    const parsed = toNotification(row);
    if (parsed !== null) data.push(parsed);
  }
  return { data, nextCursor: json.page?.nextCursor ?? null };
}

const TEMPLATE_DECISIONS: Readonly<Record<string, ReviewDecision>> = {
  "design_review.approved": "approved",
  "design_review.rejected": "rejected",
};

/**
 * The single place notification strings are matched: the templateId is the
 * authoritative signal, and the joined proposal's reviewStatus is the fallback
 * for a template this build does not know. Null means "not a review decision".
 */
export function decisionOf(n: TenantNotification): ReviewDecision | null {
  const byTemplate = TEMPLATE_DECISIONS[n.templateId];
  if (byTemplate !== undefined) return byTemplate;
  const status = n.proposal?.reviewStatus;
  if (status === "approved" || status === "rejected") return status;
  return null;
}

/** When the decision was made — the review timestamp, or when it was queued. */
export function decidedAtOf(n: TenantNotification): string {
  const reviewedAt = n.proposal?.reviewedAt;
  return reviewedAt !== undefined && reviewedAt !== null && reviewedAt !== ""
    ? reviewedAt
    : n.queuedAt;
}

/** Newest decision first; an unparseable timestamp sorts last. */
export function byDecidedAtDesc(a: TenantNotification, b: TenantNotification): number {
  const ta = Date.parse(decidedAtOf(a));
  const tb = Date.parse(decidedAtOf(b));
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return tb - ta;
}

export function reviewDecisions(
  list: ReadonlyArray<TenantNotification>,
): ReadonlyArray<TenantNotification> {
  return list.filter((n) => decisionOf(n) !== null).sort(byDecidedAtDesc);
}

export const RECENT_DECISION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * "Unread" has no server-side read state in this contract, so recency is the
 * honest stand-in: a review decision counts while it is under 7 days old. A
 * future-dated decision (clock skew) still counts — it is certainly not stale.
 */
export function recentDecisionCount(
  list: ReadonlyArray<TenantNotification>,
  now: number = Date.now(),
): number {
  let count = 0;
  for (const n of list) {
    if (decisionOf(n) === null) continue;
    const at = Date.parse(decidedAtOf(n));
    if (Number.isNaN(at)) continue;
    if (now - at <= RECENT_DECISION_WINDOW_MS) count += 1;
  }
  return count;
}
