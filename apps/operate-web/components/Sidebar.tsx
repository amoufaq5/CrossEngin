"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import { FINANCE_ROLES } from "@/lib/aging";
import { useInbox } from "@/lib/inbox";
import { accessibleEntities, entityByName, featureEnabled, groupByModule, roleLabel, useSchema } from "@/lib/schema";

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
  // No viewer (dev) → show; otherwise gate on holding a finance role.
  const showReports = viewerRoleList === undefined || viewerRoleList.some((r) => FINANCE_ROLES.includes(r));
  const hasWht = entityByName(schema, "WhtCertificate") !== undefined;
  const inboxEnabled = featureEnabled(schema, "approvals_inbox", true);
  const { items: inboxItems } = useInbox(inboxEnabled ? schema : null);
  const inboxCount = inboxItems.length;

  return (
    <aside className="sticky top-14 flex h-[calc(100vh-3.5rem)] w-64 shrink-0 flex-col border-r border-line bg-white/60 backdrop-blur">
      {primaryRole ? (
        <div className="px-5 pt-4 pb-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Signed in as</div>
          <div className="text-sm font-bold text-ink" title="Your role">
            {roleLabel(schema, primaryRole)}
          </div>
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
        </div>

        <div className="mt-5 border-t border-line pt-3">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Platform</div>
          <Link
            href="/platform"
            className={`block rounded-lg px-3 py-1.5 text-sm transition ${
              pathname === "/platform" || pathname.startsWith("/platform/")
                ? "border-l-2 border-brand bg-brand-50 font-semibold text-brand-700"
                : "text-ink-muted hover:bg-surface-soft hover:text-ink"
            }`}
          >
            Tenants
          </Link>
        </div>
      </nav>
    </aside>
  );
}
