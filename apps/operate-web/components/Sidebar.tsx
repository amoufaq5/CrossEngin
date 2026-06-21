"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import { useInbox } from "@/lib/inbox";
import { accessibleEntities, groupByModule, roleLabel, useSchema } from "@/lib/schema";

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
  const { items: inboxItems } = useInbox(schema);
  const inboxCount = inboxItems.length;

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-line bg-white">
      <div className="flex h-16 items-center gap-2 px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-black text-white">
          CE
        </span>
        <div className="leading-tight">
          <div className="text-sm font-bold text-ink">CrossEngin</div>
          {primaryRole ? (
            <div className="text-[11px] font-medium text-brand-600" title="Your role">
              {roleLabel(schema, primaryRole)}
            </div>
          ) : (
            <div className="text-[11px] font-medium uppercase tracking-wider text-brand-600">Operate</div>
          )}
        </div>
      </div>

      <div className="px-3 pb-2">
        <Link
          href="/"
          className={`mb-1 block rounded-lg px-3 py-2 text-sm font-medium transition ${
            pathname === "/" ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:bg-surface-soft hover:text-ink"
          }`}
        >
          Dashboard
        </Link>
        <Link
          href="/inbox"
          className={`mb-2 flex items-center rounded-lg px-3 py-2 text-sm font-medium transition ${
            pathname === "/inbox" ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:bg-surface-soft hover:text-ink"
          }`}
        >
          My Inbox
          {inboxCount > 0 && (
            <span className="ml-auto rounded-full bg-brand px-2 py-0.5 text-[11px] font-bold text-white">
              {inboxCount}
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
                          ? "bg-brand-50 font-semibold text-brand-700"
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

        <div className="mt-5 border-t border-line pt-3">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Administration</div>
          <Link
            href="/admin/settings"
            className={`block rounded-lg px-3 py-1.5 text-sm transition ${
              pathname === "/admin/settings"
                ? "bg-brand-50 font-semibold text-brand-700"
                : "text-ink-muted hover:bg-surface-soft hover:text-ink"
            }`}
          >
            Settings
          </Link>
        </div>
      </nav>
    </aside>
  );
}
