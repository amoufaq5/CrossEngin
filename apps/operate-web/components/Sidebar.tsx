"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import { useSchema } from "@/lib/schema";

export function Sidebar() {
  const pathname = usePathname();
  const { schema } = useSchema();
  const [q, setQ] = useState("");

  const entities = useMemo(() => {
    const all = schema?.entities ?? [];
    const needle = q.trim().toLowerCase();
    if (needle === "") return all;
    return all.filter((e) => e.label.toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle));
  }, [schema, q]);

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-line bg-white">
      <div className="flex h-16 items-center gap-2 px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-black text-white">
          CE
        </span>
        <div className="leading-tight">
          <div className="text-sm font-bold text-ink">CrossEngin</div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-brand-600">Operate</div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <Link
          href="/"
          className={`mb-2 block rounded-lg px-3 py-2 text-sm font-medium transition ${
            pathname === "/" ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:bg-surface-soft hover:text-ink"
          }`}
        >
          Dashboard
        </Link>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter entities…"
          className="w-full rounded-lg border border-line px-3 py-1.5 text-sm outline-none focus:border-brand"
        />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-6">
        <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Entities <span className="text-ink-faint/70">({entities.length})</span>
        </div>
        {entities.map((e) => {
          const href = `/e/${e.slug}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={e.slug}
              href={href}
              className={`block rounded-lg px-3 py-1.5 text-sm transition ${
                active ? "bg-brand-50 font-semibold text-brand-700" : "text-ink-muted hover:bg-surface-soft hover:text-ink"
              }`}
            >
              {e.label}
            </Link>
          );
        })}

        <div className="mt-5">
          <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Admin</div>
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
