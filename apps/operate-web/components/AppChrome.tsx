"use client";

import { usePathname } from "next/navigation";
import type { ReactElement, ReactNode } from "react";

import { ShellBar } from "@/components/ShellBar";
import { Sidebar } from "@/components/Sidebar";
import { SubscriptionBanner } from "@/components/SubscriptionBanner";
import { LOGIN_PATH } from "@/lib/session";

/**
 * The authenticated chrome, and the one decision about when it renders.
 *
 * `/login` gets `children` alone, and that is not cosmetic: `ShellBar` and `Sidebar` each
 * call `useSchema()` independently, so rendering them over the login form would fire
 * `/api/v1/meta/schema` from a browser that by definition holds no session — a guaranteed
 * 401 whose own handler is a redirect to the page the user is already looking at.
 *
 * A client component in the root layout rather than a route group: a route group does not
 * escape the root layout either, so it would be a 15-page move for the same one-line
 * decision, and moving those pages is what would cost them their static prerendering.
 */
export function AppChrome({ children }: { children: ReactNode }): ReactElement {
  const pathname = usePathname();

  if (pathname === LOGIN_PATH) return <>{children}</>;

  return (
    <div className="flex min-h-screen flex-col">
      <ShellBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="h-[calc(100vh-3.5rem)] flex-1 overflow-y-auto">
          <SubscriptionBanner />
          {children}
        </main>
      </div>
    </div>
  );
}
