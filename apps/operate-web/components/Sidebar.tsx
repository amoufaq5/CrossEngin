"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { FINANCE_ROLES } from "@/lib/aging";
import { useInbox } from "@/lib/inbox";
import {
  fetchUnreadCount,
  listNotifications,
  recentNoticeCount,
  reportUnreadBadgeCount,
  useUnreadBadgeCount,
} from "@/lib/notifications";
import { accessibleEntities, entityByName, featureEnabled, groupByModule, roleLabel, useSchema } from "@/lib/schema";

/**
 * The Platform group's links, declared rather than written out three times.
 *
 * The active state used to be *"on /platform and not on /platform/reviews"*, which is a maintained
 * list of siblings written as an exclusion — so the moment a third page landed under `/platform`,
 * "Tenants" lit up for it and nothing said so. `activePlatformHref` resolves by **longest matching
 * prefix** over this array instead, which makes a fourth entry one line and cannot be forgotten.
 */
const PLATFORM_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/platform", label: "Tenants" },
  { href: "/platform/users", label: "Users" },
  { href: "/platform/reviews", label: "Design Reviews" },
];

/** The longest declared prefix the path is under, or null when it is under none. */
function activePlatformHref(pathname: string): string | null {
  let best: string | null = null;
  for (const { href } of PLATFORM_LINKS) {
    if (pathname === href || pathname.startsWith(`${href}/`)) {
      if (best === null || href.length > best.length) best = href;
    }
  }
  return best;
}

export function Sidebar() {
  const pathname = usePathname();
  const { schema } = useSchema();
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const all = accessibleEntities(schema);
    const needle = q.trim().toLowerCase();
    const filtered =
      needle === ""
        ? all
        : all.filter((e) => e.label.toLowerCase().includes(needle) || e.module.toLowerCase().includes(needle));
    return groupByModule(filtered);
  }, [schema, q]);

  const searching = q.trim() !== "";
  const primaryRole = schema?.viewer?.primaryRole;
  const viewerRoleList = schema?.viewer?.roles;
  // Gate on holding a finance role, and an *unresolved* viewer is not a pass. The old
  // `viewerRoleList === undefined ||` arm was labelled "no viewer (dev) → show", but
  // `roles === undefined` is exactly the unauthenticated state — so the one browser holding no
  // session at all was the one shown the finance navigation. Absent roles hide.
  const showReports = viewerRoleList !== undefined && viewerRoleList.some((r) => FINANCE_ROLES.includes(r));
  const hasWht = entityByName(schema, "WhtCertificate") !== undefined;
  const inboxEnabled = featureEnabled(schema, "approvals_inbox", true);
  const { items: inboxItems } = useInbox(inboxEnabled ? schema : null);
  const inboxCount = inboxItems.length;

  // The badge asks "how many notices have you not seen", and the server can answer it: per-user read
  // state (rows + a watermark) scoped to the calling credential. The recency approximation stays as
  // the fallback and is not dead code — a deployment that has not mounted the read-state routes
  // answers 404, and a nav badge must degrade rather than disappear.
  //
  // What moved is WHICH LINK it hangs off, and that was the defect rather than either figure. It
  // used to sit on "AI Studio" → /setup, which renders review decisions and digests; the server's
  // figure counts every unread in-app notice, a strict superset. Measured live on three delivered
  // notices (a review decision, a digest with no rendered copy, an `invoice.overdue`): the badge
  // read **3** and /setup rendered **1**, with no surface anywhere for the other two. The fallback
  // concealed it, because `recentDecisionCount` skipped exactly the notices /setup does not render,
  // so it also read 1 — the approximate badge equalled the items behind the link and the accurate
  // one did not.
  //
  // Now it points at /notifications, which lists every in_app notice and can clear them, so the
  // badge's subject IS the page's subject on both paths. The fallback counts every recent notice for
  // the same reason — a floor over the right subject, where the old narrow count would read zero for
  // a tenant whose only notices are not decisions.
  //
  // The figure is READ from a module-level store and not held here, because this component does not
  // remount: `AppChrome` renders it in the root layout, so the effect below runs once per document
  // load and a count in component state could only ever go up within a session. Marking everything
  // read left the page showing 0 beside a badge still showing the old number — the badge disagreeing
  // with the page it points at. `/notifications` publishes the server's figure whenever it has one,
  // so there is one number rather than two. See `useUnreadBadgeCount`.
  const publishedUnread = useUnreadBadgeCount();
  const unreadCount = publishedUnread ?? 0;

  useEffect(() => {
    let alive = true;
    fetchUnreadCount("in_app")
      .then((count) => alive && reportUnreadBadgeCount(count.unread))
      .catch(() =>
        listNotifications({ channel: "in_app", limit: 50 })
          .then((page) => alive && reportUnreadBadgeCount(recentNoticeCount(page.data)))
          // A failed fetch renders no badge — never an error in the nav.
          .catch(() => alive && reportUnreadBadgeCount(0)),
      );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <aside className="sticky top-14 flex h-[calc(100vh-3.5rem)] w-64 shrink-0 flex-col border-r border-line bg-white/60 backdrop-blur">
      {primaryRole ? (
        <div className="px-5 pt-4 pb-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Signed in as</div>
          {/* The role and not the person, because `UiViewer` carries no name or email — see /account. */}
          <Link
            href="/account"
            className={`block text-sm font-bold transition ${
              pathname === "/account" ? "text-brand-700" : "text-ink hover:text-brand-700"
            }`}
            title="Your account"
          >
            {roleLabel(schema, primaryRole)}
          </Link>
        </div>
      ) : (
        <div className="px-5 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Navigation
        </div>
      )}

      <div className="px-3 pt-2 pb-2">
        <Link
          href="/"
          className={`mb-1 block rounded-lg px-3 py-2 text-sm font-semibold transition ${
            pathname === "/" ? "border-l-2 border-brand bg-brand-50 text-brand-700" : "text-ink-muted hover:bg-surface-soft hover:text-ink"
          }`}
        >
          Dashboard
        </Link>
        {inboxEnabled && (
          <Link
            href="/inbox"
            className={`mb-2 flex items-center rounded-lg px-3 py-2 text-sm font-medium transition ${
              pathname === "/inbox" ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700" : "text-ink-muted hover:bg-surface-soft hover:text-ink"
            }`}
          >
            My Inbox
            {inboxCount > 0 && (
              <span className="ml-auto rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-white">
                {inboxCount}
              </span>
            )}
          </Link>
        )}
        {/* Not behind `inboxEnabled`: that flag gates the APPROVALS inbox, which is entity records
            awaiting a workflow transition — a different subject that shares no code and no table
            with the notification stack. Gating this on it would hide a person's notices because a
            tenant turned off approvals. */}
        <Link
          href="/notifications"
          className={`mb-2 flex items-center rounded-lg px-3 py-2 text-sm font-medium transition ${
            pathname === "/notifications"
              ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
              : "text-ink-muted hover:bg-surface-soft hover:text-ink"
          }`}
        >
          Notifications
          {unreadCount > 0 && (
            <span className="ml-auto rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold text-white">
              {unreadCount}
            </span>
          )}
        </Link>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="w-full rounded-lg border border-line px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-6">
        {groups.map((group) => {
          const open = searching || collapsed[group.module] !== true;
          return (
            <div key={group.module} className="mt-3">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [group.module]: !(c[group.module] !== true) }))}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint hover:text-ink-muted"
              >
                <span className={`transition ${open ? "rotate-90" : ""}`}>›</span>
                <span>{group.module}</span>
                <span className="ml-auto text-ink-faint/70">{group.entities.length}</span>
              </button>
              {open &&
                group.entities.map((e) => {
                  const href = `/e/${e.slug}`;
                  const active = pathname === href || pathname.startsWith(`${href}/`);
                  return (
                    <Link
                      key={e.slug}
                      href={href}
                      className={`block rounded-lg px-3 py-1.5 text-sm transition ${
                        active
                          ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
                          : "text-ink-muted hover:bg-surface-soft hover:text-ink"
                      }`}
                    >
                      {e.label}
                    </Link>
                  );
                })}
            </div>
          );
        })}

        {showReports && (
          <div className="mt-5 border-t border-line pt-3">
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Reports</div>
            <Link
              href="/reports/aging"
              className={`block rounded-lg px-3 py-1.5 text-sm transition ${
                pathname === "/reports/aging"
                  ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
                  : "text-ink-muted hover:bg-surface-soft hover:text-ink"
              }`}
            >
              Aging
            </Link>
            <Link
              href="/reports/period-close"
              className={`block rounded-lg px-3 py-1.5 text-sm transition ${
                pathname === "/reports/period-close"
                  ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
                  : "text-ink-muted hover:bg-surface-soft hover:text-ink"
              }`}
            >
              Period Close
            </Link>
            {hasWht && (
              <Link
                href="/reports/wht"
                className={`block rounded-lg px-3 py-1.5 text-sm transition ${
                  pathname === "/reports/wht"
                    ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
                    : "text-ink-muted hover:bg-surface-soft hover:text-ink"
                }`}
              >
                Withholding Tax
              </Link>
            )}
          </div>
        )}

        <div className="mt-5 border-t border-line pt-3">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Administration</div>
          <Link
            href="/admin/settings"
            className={`block rounded-lg px-3 py-1.5 text-sm transition ${
              pathname === "/admin/settings"
                ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
                : "text-ink-muted hover:bg-surface-soft hover:text-ink"
            }`}
          >
            Settings
          </Link>
          <Link
            href="/admin/billing"
            className={`block rounded-lg px-3 py-1.5 text-sm transition ${
              pathname === "/admin/billing"
                ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
                : "text-ink-muted hover:bg-surface-soft hover:text-ink"
            }`}
          >
            Billing
          </Link>
          {/* No badge here any more. /setup renders review decisions and digests — its own
              content — and a count of every unread in-app notice was never a count of those. */}
          <Link
            href="/setup"
            className={`block rounded-lg px-3 py-1.5 text-sm transition ${
              pathname === "/setup"
                ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
                : "text-ink-muted hover:bg-surface-soft hover:text-ink"
            }`}
          >
            AI Studio
          </Link>
        </div>

        <div className="mt-5 border-t border-line pt-3">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Platform</div>
          {PLATFORM_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`block rounded-lg px-3 py-1.5 text-sm transition ${
                activePlatformHref(pathname) === link.href
                  ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
                  : "text-ink-muted hover:bg-surface-soft hover:text-ink"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>
      </nav>
    </aside>
  );
}
