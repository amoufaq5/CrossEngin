"use client";

import Link from "next/link";

import { useSubscriptionProblem } from "@/lib/subscription";

function defaultDetail(reason: string): string {
  if (reason === "subscription_past_due") {
    return "Your subscription payment is past due. Access is read-only during the grace period — update billing to restore full access.";
  }
  if (reason === "subscription_lapsed") {
    return "Your subscription has lapsed. Update billing to restore access to this workspace.";
  }
  return "This workspace requires an active subscription. Update billing to restore access.";
}

export function SubscriptionBanner() {
  const problem = useSubscriptionProblem();
  if (!problem) return null;

  const isGrace = problem.reason === "subscription_past_due";
  const tone = isGrace ? "text-amber-800 bg-amber-50" : "text-brand-700 bg-brand-50";
  const message = problem.detail ?? defaultDetail(problem.reason);

  return (
    <div className={`flex items-center justify-between gap-4 border-b px-8 py-2 text-sm ${tone}`} role="alert">
      <span>{message}</span>
      <Link href="/admin/settings" className="shrink-0 font-medium underline underline-offset-2">
        Manage billing
      </Link>
    </div>
  );
}
