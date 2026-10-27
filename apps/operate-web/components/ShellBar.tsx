"use client";

import Link from "next/link";
import { useState } from "react";

import { roleLabel, useSchema } from "@/lib/schema";
import { LOGIN_PATH } from "@/lib/session";

/**
 * SAP-Fiori-style shell bar: a translucent, blurred top bar spanning the whole
 * app, carrying the brand mark, product title, and the viewer/tenant cluster.
 * The side navigation and work area sit below it.
 */
export function ShellBar() {
  const { schema } = useSchema();
  const [signingOut, setSigningOut] = useState(false);
  const viewer = schema?.viewer ?? null;
  const roleName = viewer ? roleLabel(schema, viewer.primaryRole) : null;
  const initial = (roleName ?? "A").trim().charAt(0).toUpperCase();

  /**
   * The only caller of `/api/auth/logout`. A full document load afterwards for the same
   * reason the login does one: **no module-level cache in `lib/` has any invalidation**, so a
   * client-side navigation would leave the signed-out principal's entity list and role on
   * screen. Stated as the property and not only as the roster, because the roster grows —
   * today it is the schema, the reference labels, the subscription problem and the unread
   * badge count, and the fourth arrived without this comment being read. The navigation runs
   * whether or not the POST
   * succeeded — a sign-out that reports a failure and leaves the user looking at their data
   * is the worse of the two outcomes, and the cookie is `httpOnly` so this is the only
   * mechanism there is.
   */
  async function signOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { accept: "application/json" } });
    } catch {
      // fall through to the navigation
    }
    window.location.href = LOGIN_PATH;
  }

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
        <button
          onClick={() => void signOut()}
          disabled={signingOut}
          className="text-xs font-semibold text-ink-faint transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          title="Sign out"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </header>
  );
}
