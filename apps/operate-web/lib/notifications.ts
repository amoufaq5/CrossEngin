// TENANT notification API helpers. Like lib/platform.ts, every request goes to
// this Next app's /api proxy, which turns the caller's session cookie into the
// API's bearer token — so the browser never holds a readable credential and there
// are no CORS concerns. All paths hit /api/v1/meta/notifications...

import { useSyncExternalStore } from "react";

import { handleUnauthorized } from "@/lib/unauthorized";

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

/**
 * The rendered copy of a digest — several pooled notices summarised into one. The server renders
 * it from the pool at read time, so it is present only on a digest notification.
 */
export interface NotificationDigest {
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly itemCount: number;
}

export const DIGEST_TEMPLATE_ID = "notification.digest";

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
  readonly digest?: NotificationDigest | null;
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
  // The single error path of this module's four requests, so one call covers all of them.
  handleUnauthorized(res);
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

function toDigest(raw: unknown): NotificationDigest | null {
  if (raw === null || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const count = d["itemCount"];
  return {
    title: str(d["title"]),
    body: str(d["body"]),
    severity: str(d["severity"], "info"),
    itemCount: typeof count === "number" && Number.isFinite(count) ? count : 0,
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
    digest: toDigest(n["digest"]),
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

// ---------------------------------------------------------------------------
// Per-user read state (ADR-0309's tables, ADR-0330's store, the routes below it)
// ---------------------------------------------------------------------------

/**
 * The server's own answer to "how many of these has this viewer not seen".
 *
 * `truncated` matters: the count examines a page of the inbox rather than the whole table, so a
 * truncated answer is a floor and should render as "N+". `examined` is how many notices the figure
 * was computed over, which is what makes the floor legible.
 */
export interface UnreadCount {
  readonly unread: number;
  readonly examined: number;
  readonly truncated: boolean;
  readonly readThroughAt: string | null;
  /** `self` once the server resolves this credential to a recipient; `tenant` until then. */
  readonly scope: string;
}

/** The viewer is always the credential, so none of these helpers takes a user id. */
function readStatePath(suffix: string): string {
  return `/api/v1/notifications${suffix}`;
}

/**
 * One request and one error path for both shapes of the unread answer, because the partition's
 * body is the count's body plus a `notices` key — two functions building the same URL is how two
 * spellings of one query begin.
 */
async function requestUnread(
  channel: string | undefined,
  detail: "count" | "partition",
): Promise<Record<string, unknown>> {
  const p = new URLSearchParams();
  if (channel !== undefined && channel.trim() !== "") p.set("channel", channel.trim());
  if (detail === "partition") p.set("detail", "partition");
  const qs = p.toString();
  const res = await fetch(readStatePath(`/unread${qs ? `?${qs}` : ""}`), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) await throwProblem(res);
  return (await res.json()) as Record<string, unknown>;
}

function toUnreadCount(json: Record<string, unknown>): UnreadCount {
  const unread = json["unread"];
  const examined = json["examined"];
  return {
    unread: typeof unread === "number" && Number.isFinite(unread) ? unread : 0,
    examined: typeof examined === "number" && Number.isFinite(examined) ? examined : 0,
    truncated: json["truncated"] === true,
    readThroughAt: nullableStr(json["readThroughAt"]),
    scope: str(json["scope"], "tenant"),
  };
}

export async function fetchUnreadCount(channel?: string): Promise<UnreadCount> {
  return toUnreadCount(await requestUnread(channel, "count"));
}

/**
 * The count plus the two id lists behind it — which of the notices the server examined this viewer
 * has read, and which they have not.
 *
 * A page that renders a list beside an unread badge has to be able to say *which* rows the badge is
 * counting, or it reproduces one layer in the defect that badge had: a figure nothing can display.
 * The server already answers it (`?detail=partition`), so this is a second request and not a second
 * derivation — and it must not become one. `isUnread` consults the per-notice rows *and* the
 * watermark and **fails open** on an unparseable `queuedAt`, so a client deriving read-ness from
 * `readThroughAt` would be a second implementation of that rule, disagreeing exactly on the notices
 * it is most important not to hide.
 */
export interface UnreadPartition extends UnreadCount {
  readonly readIds: ReadonlySet<string>;
  readonly unreadIds: ReadonlySet<string>;
}

function idSet(raw: unknown): ReadonlySet<string> {
  if (!Array.isArray(raw)) return new Set<string>();
  const out = new Set<string>();
  for (const v of raw) if (typeof v === "string" && v !== "") out.add(v);
  return out;
}

export async function fetchUnreadPartition(channel?: string): Promise<UnreadPartition> {
  const json = await requestUnread(channel, "partition");
  const notices = json["notices"];
  const split = (notices !== null && typeof notices === "object" ? notices : {}) as Record<
    string,
    unknown
  >;
  return {
    ...toUnreadCount(json),
    readIds: idSet(split["read"]),
    unreadIds: idSet(split["unread"]),
  };
}

/**
 * What this page knows about one notice's read state, which is three things and not two.
 *
 * `unexamined` is the distinction a boolean loses: the partition covers the notices the server
 * examined for this answer, and that is a bounded page — so a notice the lists do not mention is
 * one **nobody looked at**, not one that was looked at and found read. Calling it read would be the
 * reassuring direction and calling it unread would inflate the very figure the page exists to make
 * honest, so it gets its own answer and the page says what it means.
 */
export const NOTICE_READ_STATES = ["read", "unread", "unexamined"] as const;
export type NoticeReadState = (typeof NOTICE_READ_STATES)[number];

export function noticeReadState(dispatchId: string, p: UnreadPartition): NoticeReadState {
  if (p.unreadIds.has(dispatchId)) return "unread";
  if (p.readIds.has(dispatchId)) return "read";
  return "unexamined";
}

export interface MarkReadResult {
  readonly dispatchId: string;
  /** `inserted` on the first read; `already_read` keeps the original `readAt`. */
  readonly outcome: string;
  readonly readAt: string | null;
}

export async function markNoticeRead(dispatchId: string): Promise<MarkReadResult> {
  const res = await fetch(readStatePath(`/${encodeURIComponent(dispatchId)}/read`), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    // No viewer in the body: the route refuses one, because a client that could name a user could
    // mark somebody else's mail read.
    body: "{}",
  });
  if (!res.ok) await throwProblem(res);
  const json = (await res.json()) as Record<string, unknown>;
  const state = json["readState"];
  const readAt =
    state !== null && typeof state === "object"
      ? nullableStr((state as Record<string, unknown>)["readAt"])
      : null;
  return { dispatchId: str(json["dispatchId"], dispatchId), outcome: str(json["outcome"]), readAt };
}

export interface ReadThroughResult {
  readonly outcome: string;
  /** True when the server would not take the requested position literally. */
  readonly clamped: boolean;
  readonly readThroughAt: string | null;
}

/**
 * Advances the viewer's "everything up to here is read" watermark.
 *
 * The position is sent and then *clamped by the server* to its own clock, so a browser whose clock
 * runs fast cannot mark tomorrow's notices read. Sending `new Date()` is the mark-all-read action.
 */
export async function markReadThrough(at: Date = new Date()): Promise<ReadThroughResult> {
  const res = await fetch(readStatePath("/read-through"), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ readThroughAt: at.toISOString() }),
  });
  if (!res.ok) await throwProblem(res);
  const json = (await res.json()) as Record<string, unknown>;
  const mark = json["watermark"];
  return {
    outcome: str(json["outcome"]),
    clamped: json["clamped"] === true,
    readThroughAt:
      mark !== null && typeof mark === "object"
        ? nullableStr((mark as Record<string, unknown>)["readThroughAt"])
        : null,
  };
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

export function isDigest(n: TenantNotification): boolean {
  return n.templateId === DIGEST_TEMPLATE_ID;
}

/** Digest notices, newest first. A digest with no rendered copy is dropped — there is nothing to show. */
export function digestNotices(
  list: ReadonlyArray<TenantNotification>,
): ReadonlyArray<TenantNotification> {
  return list.filter((n) => isDigest(n) && n.digest != null).sort(byDecidedAtDesc);
}

export function reviewDecisions(
  list: ReadonlyArray<TenantNotification>,
): ReadonlyArray<TenantNotification> {
  return list.filter((n) => decisionOf(n) !== null).sort(byDecidedAtDesc);
}

export const RECENT_NOTICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The badge's figure when the read-state routes answer nothing: a notice counts while it is under
 * 7 days old. A future-dated notice (clock skew) still counts — it is certainly not stale.
 *
 * It counts **every** notice and not only review decisions, and that widening is the point rather
 * than a convenience. While the badge hung off "AI Studio" the narrow count happened to equal what
 * that page showed, so the two agreed; a badge on a page that lists every in-app notice must
 * approximate *that* subject, or a tenant holding five fresh notices and no decisions sees no badge
 * while the page it would have pointed at has five. The figure is still a floor — it cannot know
 * what has been read — and a floor over the right subject beats an equality over the wrong one.
 */
export function recentNoticeCount(
  list: ReadonlyArray<TenantNotification>,
  now: number = Date.now(),
): number {
  let count = 0;
  for (const n of list) {
    const at = Date.parse(decidedAtOf(n));
    if (Number.isNaN(at)) continue;
    if (now - at <= RECENT_NOTICE_WINDOW_MS) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Whether this deployment serves read state at all
// ---------------------------------------------------------------------------

/**
 * Why marking a notice read is or is not available here.
 *
 * `unmounted` is read off the **status alone** and that is sound rather than convenient:
 * `buildUnreadHandler` has no 404 arm at all — its answers are 401 and 403 from `resolveViewer`,
 * 503 when the store or the notice source throws, and 200 — so a 404 on `/v1/notifications/unread`
 * is the gateway's `no_route`, which means the route family was never mounted. That is a structural
 * property of the handler and not a sentence this module matches, which matters because the
 * *mark-read* route does have a 404 (`no such notice in this inbox`) and discriminating those two
 * on their prose would break the first time either is reworded.
 */
export const READ_STATE_KINDS = ["available", "unmounted", "ungranted", "unavailable"] as const;
export type ReadStateKind = (typeof READ_STATE_KINDS)[number];

/**
 * Whether a viewer in this state may be offered a mark-read control. A map rather than
 * `kind === "available"` so a fifth state has to say which side it falls on, instead of inheriting
 * the permissive branch of a comparison.
 */
export const READ_STATE_MAY_MARK: Readonly<Record<ReadStateKind, boolean>> = Object.freeze({
  available: true,
  unmounted: false,
  ungranted: false,
  unavailable: false,
});

/**
 * The heading a page shows above the detail, as a total map over the failure kinds rather than a
 * ternary in the renderer — which would let a fifth kind inherit whichever arm the chain ended on,
 * and that arm would be the vaguest of the three.
 */
export const READ_STATE_FAILURE_HEADING: Readonly<
  Record<Exclude<ReadStateKind, "available">, string>
> = Object.freeze({
  unmounted: "Read state is not served here.",
  ungranted: "Read state is not granted to you.",
  unavailable: "Read state could not be read.",
});

export interface ReadStateFailure {
  readonly kind: Exclude<ReadStateKind, "available">;
  /** The server's own sentence where it had one, so the page reports a cause rather than guessing. */
  readonly detail: string;
}

export function readStateFailureHeading(f: ReadStateFailure): string {
  return READ_STATE_FAILURE_HEADING[f.kind];
}

/**
 * What a row says about its own read state, for the two states that mean the same thing however the
 * answer was obtained. These live beside the failure maps rather than next to `noticeReadState`
 * because the third state's sentence is keyed on the failure kind, and one producer of a row's title
 * is what keeps the three from drifting into three spellings.
 */
export const NOTICE_READ_STATE_TITLE: Readonly<
  Record<Exclude<NoticeReadState, "unexamined">, string>
> = Object.freeze({
  unread: "You have not opened this notice",
  read: "You have opened this notice",
});

/**
 * Why a row's read state is unknown, keyed on **why there is no answer** — and that key is the whole
 * point. One sentence served all four, and it ended *"Refresh to re-ask"*, which is true only of the
 * kind that has an answer to re-ask for: with the routes unmounted or the role ungranted, refreshing
 * re-asks nothing and the reader is sent to do something that cannot work (ADR-0334, cited twice by
 * the increment that shipped the sentence). `unavailable` keeps the invitation because a 503 really
 * may be transient — which is why this is a map over the kind and not a boolean.
 *
 * Total over `ReadStateKind`, so a fifth kind must say which of those two things it is rather than
 * inherit whichever arm a ternary ended on — the argument `READ_STATE_MAY_MARK` and
 * `READ_STATE_FAILURE_HEADING` already make.
 */
export const UNEXAMINED_TITLE_BY_KIND: Readonly<Record<ReadStateKind, string>> = Object.freeze({
  available:
    "Read state unknown for this notice: it is past the window the server examined, or it arrived " +
    "after this page read that answer. Refresh to re-ask.",
  unmounted:
    "Read state unknown for this notice: this deployment does not serve notification read state " +
    "(`--read-state-routes`), so nothing has an answer and refreshing cannot produce one.",
  ungranted:
    "Read state unknown for this notice: read state is not granted to your role " +
    "(`--read-state-role`), so nothing will answer for you and refreshing cannot change it.",
  unavailable:
    "Read state unknown for this notice: the server could not answer just now. That may be " +
    "transient, so a refresh may get an answer.",
});

/** The one producer of a row's read-state title, over both maps above. */
export function noticeReadStateTitle(state: NoticeReadState, kind: ReadStateKind): string {
  return state === "unexamined"
    ? UNEXAMINED_TITLE_BY_KIND[kind]
    : NOTICE_READ_STATE_TITLE[state];
}

// ---------------------------------------------------------------------------
// The badge's figure, shared between the page that can change it and the nav that shows it
// ---------------------------------------------------------------------------

/**
 * One number, read by the nav badge and written by whoever last learned it.
 *
 * `Sidebar` is mounted by `AppChrome` in the root layout, so it does **not** remount on client
 * navigation and its fetch effect runs once per document load. With the count in component state
 * that made the badge monotonic within a session: marking everything read advanced the server's
 * watermark, the page showed 0, and the badge kept its old number until a full reload — a badge
 * disagreeing with the page it points at, which is the defect this whole increment exists to close,
 * reintroduced from the other side. ADR-0376's *"a number that only goes up is not information"*
 * applied to the session rather than to the deployment.
 *
 * A module-level store with `useSyncExternalStore` rather than a `pathname` dependency or an
 * interval, for two reasons: navigation is not the event (the count changes **while** the reader
 * sits on `/notifications`, with the path unchanged), and a refetch on navigation would still leave
 * a window where the badge is stale. This is `lib/subscription.ts`'s shape — module `let` plus a
 * listener set plus a `use*` hook — which is how this app already crosses a 402 from the API layer
 * to a banner in the chrome.
 *
 * It holds the figure and not a staleness signal, so the badge and the page cannot disagree about
 * the number: there is one.
 */
let badgeUnread: number | null = null;
const badgeListeners = new Set<() => void>();

/**
 * Publishes the unread figure. A repeat is a no-op, which is what makes it safe to call from an
 * effect that runs on every render of a partition and under React's double-invocation in dev.
 */
export function reportUnreadBadgeCount(n: number): void {
  const next = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  if (badgeUnread === next) return;
  badgeUnread = next;
  for (const cb of badgeListeners) cb();
}

/** `null` until something has an answer, which is not the same fact as zero unread. */
export function getUnreadBadgeCount(): number | null {
  return badgeUnread;
}

export function subscribeUnreadBadge(cb: () => void): () => void {
  badgeListeners.add(cb);
  return () => {
    badgeListeners.delete(cb);
  };
}

export function useUnreadBadgeCount(): number | null {
  // The server snapshot is `null` and so is the module's initial value, so a prerendered badge and
  // its first client render agree — which is what keeps every page's static prerendering intact.
  return useSyncExternalStore(subscribeUnreadBadge, getUnreadBadgeCount, () => null);
}

/**
 * Terminates a sentence that may already be terminated. The server's 403 details are written as
 * clauses with no full stop, and appending a second sentence to one produced
 * "…not granted to this role This surface is governed by…" — measured live against the real route.
 */
function sentence(s: string): string {
  const t = s.trim();
  if (t === "") return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function describeReadStateFailure(e: unknown): ReadStateFailure {
  if (e instanceof NotificationError) {
    if (e.status === 404) {
      return {
        kind: "unmounted",
        detail:
          "This deployment does not serve notification read state, so nothing can record that you " +
          "have seen a notice. It is mounted with `--read-state-routes` on operate-server.",
      };
    }
    if (e.status === 403) {
      // The server's three 403s name three different causes (`not granted to this role`, `no tenant
      // resolves`, `no viewer resolves … read state is per user`) and the remedies differ, so its
      // sentence is carried rather than paraphrased. Both governing flags are named and NEITHER is
      // claimed as the cause: enumerating causes is how an error arm comes to rule the real one out.
      return {
        kind: "ungranted",
        detail:
          `${sentence(e.message)} This surface is governed by \`--read-state-routes\`, which ` +
          "mounts it, and `--read-state-role`, which grants it per role.",
      };
    }
  }
  return { kind: "unavailable", detail: sentence(e instanceof Error ? e.message : String(e)) };
}

/**
 * The sentence to show when a *write* fails, and deliberately **not**
 * `describeReadStateFailure`. That function reads a 404 as "the route family is not mounted", which
 * is sound for `/unread` because its handler has no 404 arm — and `POST /{id}/read` does have one
 * (`no such notice in this inbox`). Classifying a write's 404 with it would answer "add
 * `--read-state-routes`" to an operator whose routes are mounted and whose notice is simply not
 * theirs: an error arm enumerating causes and thereby ruling out the real one, which is the class
 * this app has already been bitten by twice.
 *
 * So the server's own sentence is carried through. Every refusal on these two routes names its
 * cause — a missing notice, an ungranted role, a principal that is not a person, an unrecordable
 * write — and none of them is a sentence this module could improve on.
 */
export function readStateWriteFailure(e: unknown): string {
  return sentence(e instanceof Error ? e.message : String(e));
}
