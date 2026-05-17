import { z } from "zod";

export const TENANT_LIFECYCLE_STATES = [
  "trial",
  "active",
  "past_due",
  "suspended",
  "archived",
  "pending_deletion",
  "deleted",
] as const;
export type TenantLifecycleState = (typeof TENANT_LIFECYCLE_STATES)[number];
export const TenantLifecycleStateSchema = z.enum(TENANT_LIFECYCLE_STATES);

export const TENANT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<TenantLifecycleState, readonly TenantLifecycleState[]>
> = Object.freeze({
  trial: ["active", "suspended", "archived", "pending_deletion"],
  active: ["past_due", "suspended", "archived", "pending_deletion"],
  past_due: ["active", "suspended", "archived"],
  suspended: ["active", "archived", "pending_deletion"],
  archived: ["active", "pending_deletion"],
  pending_deletion: ["archived", "deleted"],
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
