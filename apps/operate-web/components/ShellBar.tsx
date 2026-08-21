"use client";

import Link from "next/link";

import { roleLabel, useSchema } from "@/lib/schema";

/**
 * SAP-Fiori-style shell bar: a translucent, blurred top bar spanning the whole
 * app, carrying the brand mark, product title, and the viewer/tenant cluster.
 * The side navigation and work area sit below it.
 */
export function ShellBar() {
  const { schema } = useSchema();
  const viewer = schema?.viewer ?? null;
  const roleName = viewer ? roleLabel(schema, viewer.primaryRole) : null;
  const initial = (roleName ?? "A").trim().charAt(0).toUpperCase();

  return (
    <header className="shell-bar">
      <Link href="/" className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-black text-white shadow-tile">
          CE
        </span>
        <span className="hidden text-[15px] font-extrabold tracking-tight text-ink sm:block">
          CrossEngin <span className="font-semibold text-ink-muted">Operate</span>
        </span>
      </Link>

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden items-center gap-1.5 rounded-lg bg-surface-soft/80 px-3 py-1.5 text-xs font-semibold text-ink-muted md:inline-flex">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" />
          Workspace
        </span>
        {roleName ? (
          <span className="hidden text-xs font-medium text-ink-faint lg:inline">{roleName}</span>
        ) : null}
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand-700 ring-1 ring-brand/20"
          title={roleName ?? "Account"}
        >
          {initial}
        </span>
      </div>
    </header>
  );
}
