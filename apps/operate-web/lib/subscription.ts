// Module-level pub/sub for the tenant subscription "payment required" (HTTP 402)
// state. The API layer reports a problem when a 402 arrives and clears it on any
// successful response; the banner subscribes via useSubscriptionProblem().

import { useSyncExternalStore } from "react";

export interface SubscriptionProblem {
  status: string | null;
  reason: string;
  detail?: string;
}

let current: SubscriptionProblem | null = null;
const listeners = new Set<() => void>();

function sameProblem(a: SubscriptionProblem | null, b: SubscriptionProblem | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function reportSubscriptionProblem(p: SubscriptionProblem | null): void {
  if (sameProblem(current, p)) return;
  current = p;
  for (const cb of listeners) cb();
}

export function getSubscriptionProblem(): SubscriptionProblem | null {
  return current;
}

export function subscribeSubscription(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useSubscriptionProblem(): SubscriptionProblem | null {
  return useSyncExternalStore(subscribeSubscription, getSubscriptionProblem, () => null);
}
