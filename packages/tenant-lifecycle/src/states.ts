import { z } from "zod";

/**
 * The states a tenant row can actually be in — **five**, not the seven this declared until
 * ADR-0334, and the narrowing is the point rather than a tidy-up.
 *
 * Nothing in the workspace read this enum, this transition map, the three state sets or any of the
 * four predicates below. Meanwhile `apps/operate-server` carried its *own* four-value `TenantStatus`
 * with its own transition map, and that one is what `meta.tenants.status`' CHECK constrains and what
 * the console transitions. So there were two vocabularies for one concept, the unread one was the
 * wider, and three of its members could not be stored at all.
 *
 * Two of those three were **billing facts duplicated onto the tenant**:
 * - `past_due` is a *subscription* status, with its own transition map in `@crossengin/billing`
 *   (`active: ["past_due", "paused", "canceled"]`). A tenant whose subscription is past due is still
 *   an `active` tenant; the arrears belong to the subscription, and modelling them here meant two
 *   records could disagree about one fact.
 * - `trial` is a *plan tier* in billing (`PLAN_TIERS`), not a status at all, and had **no producer
 *   anywhere** — not in `GRACE_FROM_STATE`, not in `actions.ts`. It was a state nothing could reach.
 *
 * The third, `pending_deletion`, is a genuine tenant state and is **kept**, because it is the one
 * the deployment was missing and it is load-bearing: ADR-0321 made the Article 17 erasure
 * asynchronous precisely because a large tenant outlasts an HTTP request, and ADR-0316's ordering
 * retires the tenant row only *after* the erasure commits. So between a deletion request being
 * verified and its erasure running, a tenant sat `active` and kept accepting writes into data that
 * was about to be destroyed. It is also what `deletion_grace` and `appeal_window` name as their
 * `fromState`, and it is already in `READ_ONLY_STATES` — the contract had the answer and nothing
 * could store the question.
 */
export const TENANT_LIFECYCLE_STATES = [
  "active",
  "suspended",
  "archived",
  "pending_deletion",
  "deleted",
] as const;
export type TenantLifecycleState = (typeof TENANT_LIFECYCLE_STATES)[number];
export const TenantLifecycleStateSchema = z.enum(TENANT_LIFECYCLE_STATES);

/**
 * `deleted` is reachable only from `pending_deletion`, which is what makes the read-only window
 * before an erasure a *state* rather than a convention: the Article 17 flow cannot take a serving
 * tenant straight to `deleted` without first putting it somewhere that blocks writes.
 *
 * `pending_deletion` goes back to `active`, and that is not a loosening for convenience —
 * `DELETION_REQUEST_TRANSITIONS` permits `verified -> rejected`, so a request that put a tenant here
 * can be rejected afterwards, and the tenant has to be able to resume service. Routing that through
 * `archived` instead would cost a tenant their write access for a request that was rejected, which
 * is a penalty for somebody else's mistake; `RESTORABLE_STATES` has named `pending_deletion`
 * restorable since Phase 1 and this is the map agreeing with it. The restore is governed by the same
 * grant and four-eyes rule that moved it here, which is where the control belongs.
 */
export const TENANT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<TenantLifecycleState, readonly TenantLifecycleState[]>
> = Object.freeze({
  active: ["suspended", "archived", "pending_deletion"],
  suspended: ["active", "archived", "pending_deletion"],
  archived: ["active", "pending_deletion"],
  pending_deletion: ["active", "archived", "deleted"],
  deleted: [],
});

export function canTransitionLifecycle(
  from: TenantLifecycleState,
  to: TenantLifecycleState,
): boolean {
  return TENANT_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export const READ_ONLY_STATES: ReadonlySet<TenantLifecycleState> = new Set([
  "suspended",
  "archived",
  "pending_deletion",
]);

export const TERMINAL_STATES: ReadonlySet<TenantLifecycleState> = new Set([
  "deleted",
]);

export const RESTORABLE_STATES: ReadonlySet<TenantLifecycleState> = new Set([
  "suspended",
  "archived",
  "pending_deletion",
]);

export function isReadOnly(state: TenantLifecycleState): boolean {
  return READ_ONLY_STATES.has(state);
}

export function isTerminal(state: TenantLifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isRestorable(state: TenantLifecycleState): boolean {
  return RESTORABLE_STATES.has(state);
}

export function blocksWrites(state: TenantLifecycleState): boolean {
  return isReadOnly(state) || isTerminal(state);
}

export function blocksReads(state: TenantLifecycleState): boolean {
  return state === "deleted";
}
