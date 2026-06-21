"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/Badge";
import { Topbar } from "@/components/Topbar";
import { runTransition } from "@/lib/api";
import { useInbox, type InboxItem } from "@/lib/inbox";
import { roleLabel, useSchema } from "@/lib/schema";

export default function InboxPage() {
  const { schema } = useSchema();
  const { items, loading, error, refresh } = useInbox(schema);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const viewer = schema?.viewer ?? null;

  // Group by department for the cross-department view.
  const byModule = new Map<string, InboxItem[]>();
  for (const item of items) {
    const list = byModule.get(item.entity.module) ?? [];
    list.push(item);
    byModule.set(item.entity.module, list);
  }
  const groups = [...byModule.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  async function fire(item: InboxItem, transition: string) {
    const key = `${item.entity.slug}/${item.id}`;
    setBusyId(key);
    setActionError(null);
    setNotice(null);
    try {
      await runTransition(item.entity.slug, item.id, transition);
      setNotice(`${item.entity.singular} "${item.label}" — ${transition} applied.`);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Topbar
        title="My Inbox"
        subtitle={
          viewer
            ? `Items awaiting ${roleLabel(schema, viewer.primaryRole)} action across all departments`
            : "Items awaiting your action across all departments"
        }
      />
      <div className="px-8 py-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="text-sm text-ink-muted">
            {loading ? "Loading…" : `${items.length} item${items.length === 1 ? "" : "s"} pending`}
          </span>
          <button
            onClick={refresh}
            className="ml-auto rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-soft"
          >
            Refresh
          </button>
        </div>

        {notice && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</div>
        )}
        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">{error}</div>
        )}
        {actionError && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">{actionError}</div>
        )}

        {!loading && items.length === 0 && (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            🎉 You&apos;re all caught up — nothing is waiting on you right now.
          </div>
        )}

        <div className="space-y-7">
          {groups.map(([module, list]) => (
            <section key={module}>
              <div className="mb-3 flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-brand" />
                <h2 className="text-sm font-bold uppercase tracking-wide text-ink">{module}</h2>
                <span className="text-xs text-ink-faint">{list.length}</span>
              </div>
              <div className="overflow-hidden rounded-xl border border-line bg-white">
                {list.map((item, i) => {
                  const key = `${item.entity.slug}/${item.id}`;
                  return (
                    <div
                      key={key}
                      className={`flex flex-wrap items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-line" : ""}`}
                    >
                      <Link
                        href={`/e/${item.entity.slug}/${encodeURIComponent(item.id)}`}
                        className="min-w-0 flex-1"
                      >
                        <div className="truncate text-sm font-medium text-ink hover:text-brand-700">{item.label}</div>
                        <div className="text-xs text-ink-faint">{item.entity.singular}</div>
                      </Link>
                      <Badge value={item.state} />
                      <div className="flex flex-wrap gap-1.5">
                        {item.actions.map((a) => (
                          <button
                            key={a.name}
                            onClick={() => void fire(item, a.name)}
                            disabled={busyId === key}
                            className="rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
