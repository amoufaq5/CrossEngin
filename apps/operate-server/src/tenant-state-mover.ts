import {
  TENANT_LIFECYCLE_STATES,
  TENANT_LIFECYCLE_TRANSITIONS,
  type TenantLifecycleState,
} from "@crossengin/tenant-lifecycle";

import type { TenantMoveOutcome, TenantStateMover } from "./deletion-request-routes.js";
import type { TenantTransition } from "./platform-admin.js";
import type { TenantStatus } from "./platform-tenants.js";

/** The subset of `PostgresTenantStore` the mover writes through. */
export interface TenantStatusWriter {
  transitionStatus(
    id: string,
    to: TenantStatus,
    from: readonly TenantStatus[],
  ): Promise<TenantTransition | null>;
}

/**
 * The states a verification may move a tenant *out of* — derived from the lifecycle map rather than
 * listed, so a sixth state that can reach `pending_deletion` is covered without an edit here.
 *
 * `deleted` is excluded because the map excludes it, which is the answer we want: a request verified
 * against an already-deleted tenant is not something to quietly re-queue.
 */
export const PENDING_DELETION_SOURCES: readonly TenantLifecycleState[] =
  TENANT_LIFECYCLE_STATES.filter((s) => TENANT_LIFECYCLE_TRANSITIONS[s].includes("pending_deletion"));

/**
 * Where a rejected request restores a tenant to, and the only state it restores *from*.
 *
 * `pending_deletion` alone: a tenant a console suspension moved elsewhere while the request was
 * pending must stay where the operator put it, and `transitionStatus`' predicate is what enforces
 * that rather than a read-then-write. `active` is the destination because a rejected request must
 * not cost the tenant their write access — see `TENANT_LIFECYCLE_TRANSITIONS`.
 */
export const RESTORE_SOURCES: readonly TenantLifecycleState[] = ["pending_deletion"];
export const RESTORE_TARGET: TenantLifecycleState = "active";

/**
 * Every state `markPendingDeletion` will *not* move a tenant out of. The claim a test pins: all of
 * them already block writes, so a no-match leaves `tenantReadOnly: true` true.
 */
export const WRITE_BLOCKED_COMPLEMENT_OF_PENDING_SOURCES: readonly TenantLifecycleState[] =
  TENANT_LIFECYCLE_STATES.filter((s) => !PENDING_DELETION_SOURCES.includes(s));

/**
 * Why a no-match is reported rather than surfaced as a failed move, and why the route's
 * `tenantReadOnly` / `tenantRestored` stay `true` through one.
 *
 * The source sets are chosen so that **a no-match still leaves the claim true**, and that is a
 * property of the sets rather than a convenience:
 *
 * - `markPendingDeletion`'s complement is `{pending_deletion, deleted}`, and **both block writes**
 *   (`blocksWrites` is true for every state but `active`). So a tenant this transition did not move
 *   was already read-only, and `tenantReadOnly: true` is not a guess.
 * - `restore`'s complement is `{active, suspended, archived, deleted}`, none of which this flow put
 *   the tenant in. `active` has nothing to restore; the other three are an operator's decision that
 *   a rejected deletion request has no standing to override. Either way the request is no longer
 *   holding the tenant, which is what `tenantRestored` claims.
 *
 * `WRITE_BLOCKED_COMPLEMENT_OF_PENDING_SOURCES` below is that property asserted, so the day somebody
 * adds a sixth state the arithmetic is re-checked instead of assumed.
 */
export interface TenantStateMoverOptions {
  /**
   * Called when a guarded transition matched no row. Not an error: the premise was wrong, which for
   * `restore` is the ordinary case of a tenant that was never moved (a request rejected while still
   * `submitted`), and for `markPendingDeletion` means somebody else moved the tenant first.
   */
  readonly onNoMatch?: (input: {
    readonly tenantId: string;
    readonly to: TenantLifecycleState;
    readonly from: readonly TenantLifecycleState[];
  }) => void;
}

/**
 * The `TenantStateMover` the deletion-request routes take, over the one store that owns
 * `meta.tenants`.
 *
 * Neither method throws on a no-match, and that asymmetry with the route's own error reporting is
 * deliberate: a no-match is a *decision* ("the tenant is not where this transition starts"), while a
 * thrown error is a failure the route reports as `tenantReadOnly: false`. Collapsing the two would
 * make a rejection of a never-verified request look like a broken restore on every call.
 */
export function buildTenantStateMover(
  store: TenantStatusWriter,
  opts: TenantStateMoverOptions = {},
): TenantStateMover {
  const move = async (
    tenantId: string,
    to: TenantLifecycleState,
    from: readonly TenantLifecycleState[],
  ): Promise<TenantMoveOutcome> => {
    const moved = await store.transitionStatus(tenantId, to, from);
    if (moved === null) {
      opts.onNoMatch?.({ tenantId, to, from });
      // `fromState: null` and not a guess from `from`: the lifecycle trail records a transition that
      // happened, and on a no-match none did. A fabricated source state would put a transition in
      // the permanent record that the row never made.
      return { moved: false, fromState: null };
    }
    return { moved: true, fromState: moved.previousStatus };
  };
  return {
    markPendingDeletion: (tenantId) => move(tenantId, "pending_deletion", PENDING_DELETION_SOURCES),
    restore: (tenantId) => move(tenantId, RESTORE_TARGET, RESTORE_SOURCES),
  };
}
