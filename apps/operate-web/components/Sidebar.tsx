"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { hrefFor, navGroups } from "@/lib/nav";

export function Sidebar() {
  const pathname = usePathname();
  const groups = navGroups();

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

      <nav className="flex-1 overflow-y-auto px-3 pb-6">
        <Link
          href="/"
          className={`mb-1 block rounded-lg px-3 py-2 text-sm font-medium transition ${
            pathname === "/" ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:bg-surface-soft hover:text-ink"
          }`}
        >
          Dashboard
        </Link>

        {groups.map((group) => (
          <div key={group.key} className="mt-5">
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              {group.label}
            </div>
            {group.resources.map((res) => {
              const href = hrefFor(res);
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`block rounded-lg px-3 py-1.5 text-sm transition ${
                    active
                      ? "bg-brand-50 font-semibold text-brand-700"
                      : "text-ink-muted hover:bg-surface-soft hover:text-ink"
                  }`}
                >
                  {res.title}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
