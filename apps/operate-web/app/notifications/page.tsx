"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { Topbar } from "@/components/Topbar";
import { titleCase } from "@/lib/format";
import {
  decidedAtOf,
  decisionOf,
  describeReadStateFailure,
  fetchUnreadPartition,
  isDigest,
  listNotifications,
  markNoticeRead,
  markReadThrough,
  noticeReadState,
  noticeReadStateTitle,
  readStateFailureHeading,
  readStateWriteFailure,
  reportUnreadBadgeCount,
  READ_STATE_MAY_MARK,
  type NoticeReadState,
  type ReadStateFailure,
  type ReadStateKind,
  type TenantNotification,
  type UnreadPartition,
} from "@/lib/notifications";

/**
 * The page the unread badge points at, and the reason it exists.
 *
 * The badge used to hang off "AI Studio". Its accurate figure — the server's per-viewer unread
 * count over every in-app notice — was a *superset* of what `/setup` shows, which is review
 * decisions and digests; its degraded figure happened to be exactly that union, so while the
 * read-state routes were unmounted the badge equalled the items behind the link and nobody noticed.
 * Measured live on three delivered notices — a review decision, a digest with no rendered copy and
 * an `invoice.overdue` — mounting them made the badge read 3 where `/setup` renders 1, with no
 * surface anywhere for the other two. So the deployment default was withheld on the absence of this
 * page, and the page's one job is that its subject **is** the badge's subject: every `in_app`
 * notice, read state shown, read state clearable.
 */

/**
 * The store clamps a list to 200 (`MAX_LIMIT`, notification-store.ts) and the unread answer examines
 * `DEFAULT_UNREAD_SCAN_LIMIT` = 200 of the same ordering (`ORDER BY queued_at DESC, dispatch_id`,
 * a total order since `dispatch_id` is unique). So a page of 50 is a prefix of the examined window
 * and every row on the first four pages has an answer; past that `noticeReadState` says
 * `unexamined` rather than guessing.
 */
const PAGE_LIMIT = 50;

const CHANNEL = "in_app";

/** Where a digest's rendered body and a decision's notes are shown. */
const STUDIO_PATH = "/setup";

/**
 * How each read state *draws*. A total map so a fourth state cannot inherit whichever branch an
 * `if`-chain happened to end on — and the three are deliberately not two shades of one thing:
 * `unexamined` is "nobody looked", which must not be drawn as the reassuring one.
 *
 * The dot and the label only. The row's **sentence** comes from `noticeReadStateTitle`, because for
 * `unexamined` it depends on *why* there is no answer and that is not a property of the row: one
 * sentence here used to serve all four causes and it ended "Refresh to re-ask", which is a remedy
 * that cannot work when the routes are unmounted or the role is ungranted.
 */
const READ_STATE_STYLE: Readonly<
  Record<NoticeReadState, { readonly dot: string; readonly label: string }>
> = Object.freeze({
  unread: { dot: "bg-brand", label: "Unread" },
  read: { dot: "bg-transparent ring-1 ring-line", label: "Read" },
  unexamined: { dot: "bg-ink-faint/40", label: "Unknown" },
});

/** A one-line description of a notice, from whichever of its three sources is populated. */
function summarise(n: TenantNotification): string {
  const digestTitle = n.digest?.title?.trim() ?? "";
  if (digestTitle !== "") return digestTitle;
  const name = n.proposal?.name?.trim() ?? "";
  if (name !== "") return name;
  // The template id is the only thing every dispatch carries. Rendered rather than hidden: a notice
  // this build has no copy for is still a notice the viewer received.
  return n.templateId === "" ? "Notice" : titleCase(n.templateId.replace(/[._]/g, " "));
}

function timeLabel(at: string): string {
  return Number.isNaN(Date.parse(at)) ? at : new Date(at).toLocaleString();
}

export default function NotificationsPage(): ReactElement {
  const [notices, setNotices] = useState<ReadonlyArray<TenantNotification>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [partition, setPartition] = useState<UnreadPartition | null>(null);
  const [readStateFailure, setReadStateFailure] = useState<ReadStateFailure | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  /**
   * The same guard the user registry carries, for the same reason: "Mark all read" refreshes, so two
   * loads can overlap, and a superseded one resolving last would append its rows and overwrite the
   * cursor with a position in a set this caller was never shown.
   */
  const generation = useRef(0);

  const loadPartition = useCallback(() => {
    fetchUnreadPartition(CHANNEL)
      .then((p) => {
        setPartition(p);
        setReadStateFailure(null);
      })
      .catch((e: unknown) => {
        setPartition(null);
        setReadStateFailure(describeReadStateFailure(e));
      });
  }, []);

  const load = useCallback(() => {
    const mine = ++generation.current;
    setBusy(true);
    setError(null);
    setNextCursor(null);
    listNotifications({ channel: CHANNEL, limit: PAGE_LIMIT })
      .then((page) => {
        if (generation.current !== mine) return;
        setNotices(page.data);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (generation.current !== mine) return;
        setBusy(false);
      });
  }, []);

  // Two requests and two independent outcomes, which is the whole shape of this page: the list needs
  // no read-state route, so a deployment that mounts none still gets its notifications. Only the
  // affordances degrade, and the banner below names what is missing.
  useEffect(() => load(), [load]);
  useEffect(() => loadPartition(), [loadPartition]);

  // The nav badge reads one number and this is where it is written: whenever this page holds the
  // server's unread figure, the badge is told. One rule and one call site rather than a report
  // beside each of the three writers (the initial load, a per-notice mark, a mark-all re-read),
  // which is how two of them come to disagree — and `reportUnreadBadgeCount` is a no-op on a
  // repeat, so an effect over the partition costs nothing when the figure has not moved.
  //
  // `partition === null` publishes NOTHING, deliberately: on the degraded arm this page has no
  // authoritative figure, and the badge's own fallback is a better answer than a zero that would
  // read as "you are up to date".
  useEffect(() => {
    if (partition !== null) reportUnreadBadgeCount(partition.unread);
  }, [partition]);

  // Both conjuncts are load-bearing and neither implies the other. The map answers *may a viewer in
  // this state be offered a control*, which is what a fifth failure kind has to declare rather than
  // inherit; `partition !== null` answers *is there an answer yet*, which covers the first render,
  // where there is no failure and no partition either.
  const readState: ReadStateKind = readStateFailure === null ? "available" : readStateFailure.kind;
  const mayMark = READ_STATE_MAY_MARK[readState] && partition !== null;

  function loadMore(): void {
    const cursor = nextCursor;
    if (cursor === null || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    listNotifications({ channel: CHANNEL, limit: PAGE_LIMIT, cursor })
      .then((page) => {
        if (generation.current !== mine) return;
        setNotices((prev) => [...prev, ...page.data]);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoadingMore(false));
  }

  async function markOne(n: TenantNotification): Promise<void> {
    setBusyId(n.dispatchId);
    setActionError(null);
    setNotice(null);
    try {
      const result = await markNoticeRead(n.dispatchId);
      // The server's own answer about this one notice, so moving the id is not a guess: `inserted`
      // and `already_read` both mean it is read, and the second is how an `unexamined` row reveals
      // that it already was. Deriving the WHOLE partition from a watermark would be a second
      // implementation of `isUnread` — see `UnreadPartition` — so a mark-all re-reads instead.
      //
      // One consequence worth knowing before reading it as a defect: an `unexamined` row moved here
      // renders **Read** immediately and goes back to **Unknown** on the next Refresh. Both answers
      // are honest and neither is the other's bug — this one is the server's reply about this
      // notice, and that one is the server's partition, which can only speak about ids inside the
      // examined window. The row is written either way; only what the page can be told differs.
      setPartition((p) =>
        p === null
          ? p
          : {
              ...p,
              readIds: new Set([...p.readIds, n.dispatchId]),
              unreadIds: new Set([...p.unreadIds].filter((id) => id !== n.dispatchId)),
              unread: p.unreadIds.has(n.dispatchId) ? Math.max(0, p.unread - 1) : p.unread,
            },
      );
      setNotice(
        result.outcome === "already_read"
          ? `Already read${result.readAt === null ? "" : ` — ${timeLabel(result.readAt)}`}.`
          : "Marked read.",
      );
    } catch (e) {
      setActionError(readStateWriteFailure(e));
    } finally {
      setBusyId(null);
    }
  }

  async function markAll(): Promise<void> {
    setMarkingAll(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await markReadThrough();
      // Re-read rather than derive. The watermark decides read-ness through `isUnread`, which also
      // consults the per-notice rows and fails OPEN on an unparseable `queuedAt` — so computing the
      // new partition here would disagree with the server exactly on the notices it is most
      // important not to hide.
      loadPartition();
      setNotice(
        result.clamped
          ? "Marked everything up to the server's clock read — the position sent was in the future and was clamped."
          : "Marked everything read.",
      );
    } catch (e) {
      setActionError(readStateWriteFailure(e));
    } finally {
      setMarkingAll(false);
    }
  }

  const unreadLabel =
    partition === null
      ? null
      : `${partition.unread.toString()}${partition.truncated ? "+" : ""} unread of ${partition.examined.toString()} examined`;

  return (
    <>
      <Topbar
        title="Notifications"
        subtitle="Everything this deployment has delivered to you in the app"
      />
      <div className="px-8 py-6">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <span className="text-sm text-ink-muted">
            {busy && notices.length === 0
              ? "Loading…"
              : `${notices.length.toString()} notice${notices.length === 1 ? "" : "s"}`}
          </span>
          {unreadLabel !== null && <span className="chip">{unreadLabel}</span>}
          <div className="ml-auto flex gap-2">
            {mayMark && (
              <button
                onClick={() => void markAll()}
                disabled={markingAll}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-soft disabled:opacity-60"
              >
                {markingAll ? "Marking…" : "Mark all read"}
              </button>
            )}
            <button
              onClick={() => {
                load();
                loadPartition();
              }}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-soft"
            >
              Refresh
            </button>
          </div>
        </div>

        {notice && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        )}
        {actionError && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {actionError}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Could not load your notifications: {error}
          </div>
        )}

        {/* The degraded arm. The list above renders either way — `listNotifications` needs no
            read-state route — so this says what is missing and names the flag, rather than leaving
            an operator with an inert page or twenty disabled buttons each repeating one sentence. */}
        {readStateFailure !== null && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-semibold">{readStateFailureHeading(readStateFailure)}</span>{" "}
            {readStateFailure.detail} Your notices are listed below and nothing is hidden; what is
            missing is the record that you have seen one, so the sidebar badge falls back to counting
            notices from the last seven days instead of counting unread ones.
          </div>
        )}

        {/* Named as a fact and NOT with a flag to raise. `--read-state-unread-scan` accepts up to
            1000 while the notification store clamps a page to 200, so raising it past 200 changes
            nothing — and a remedy that cannot work is worse than naming none (ADR-0334). */}
        {partition !== null && partition.truncated && (
          <div className="mb-4 rounded-lg border border-line bg-surface-soft px-4 py-3 text-sm text-ink-muted">
            Read state was answered over the newest {partition.examined.toString()} notices, which is
            as far as the server looks for one answer. Older notices are listed with their read state
            marked <span className="font-semibold">Unknown</span> rather than assumed, and the unread
            figure above is a floor. Marking one read still works: that request names the notice
            directly and does not depend on the window.
          </div>
        )}

        {!busy && notices.length === 0 && error === null && (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            Nothing has been delivered to you in the app yet.
          </div>
        )}

        {notices.length > 0 && (
          <div className="card divide-y divide-line">
            {notices.map((n) => {
              const state: NoticeReadState =
                partition === null ? "unexamined" : noticeReadState(n.dispatchId, partition);
              const style = READ_STATE_STYLE[state];
              // `readState` and not a constant: with no partition every row is `unexamined`, and
              // the cause is the deployment's rather than the row's, so the sentence has to name
              // the real one. Refreshing cannot mount a route or grant a role.
              const title = noticeReadStateTitle(state, readState);
              const decision = decisionOf(n);
              const digest = isDigest(n) ? n.digest : null;
              // A digest's rendered body and a decision's review notes are shown in AI Studio, which
              // is the one place in this app that renders server-rendered notice HTML. Linking there
              // beats a second `dangerouslySetInnerHTML` site.
              const detailHref = decision !== null || digest != null ? STUDIO_PATH : null;
              return (
                <div key={n.dispatchId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <span
                    role="img"
                    title={title}
                    aria-label={style.label}
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`}
                  />
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      state === "unread" ? "font-semibold text-ink" : "text-ink-muted"
                    }`}
                  >
                    {summarise(n)}
                  </span>
                  {digest != null && (
                    <span className="chip">{digest.itemCount.toString()} grouped</span>
                  )}
                  {decision !== null && <span className="chip">{decision}</span>}
                  {n.category !== "" && <span className="chip">{titleCase(n.category)}</span>}
                  <span
                    title={`${style.label} · ${n.templateId}`}
                    className="text-xs tabular-nums text-ink-faint"
                  >
                    {timeLabel(decidedAtOf(n))}
                  </span>
                  {detailHref !== null && (
                    <Link
                      href={detailHref}
                      className="text-sm font-medium text-brand-600 hover:text-brand-700"
                    >
                      Open
                    </Link>
                  )}
                  {/* Offered for `unexamined` as well as `unread`: the POST is per dispatch id and
                      independent of the examined window, it is idempotent, and its `already_read`
                      answer is how an unknown row tells you what it actually was. */}
                  {mayMark && state !== "read" && (
                    <button
                      onClick={() => void markOne(n)}
                      disabled={busyId === n.dispatchId}
                      className="rounded-lg bg-brand-50 px-3 py-1 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
                    >
                      {busyId === n.dispatchId ? "…" : "Mark read"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {nextCursor !== null && (
          <div className="mt-4">
            <button onClick={loadMore} disabled={loadingMore} className="btn-ghost">
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}

        <p className="mt-6 text-xs text-ink-faint">
          This list is per recipient: it is what was delivered to you, not every notice in the
          tenant. A credential that names no person resolves to nobody and sees an empty list —
          an api-key spec needs its fourth field for the inbox to have anything in it.
        </p>
      </div>
    </>
  );
}
