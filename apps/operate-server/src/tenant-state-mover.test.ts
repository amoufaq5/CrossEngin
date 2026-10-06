import { describe, expect, it, vi } from "vitest";
import { TENANT_LIFECYCLE_STATES, blocksWrites } from "@crossengin/tenant-lifecycle";

import {
  PENDING_DELETION_SOURCES,
  RESTORE_SOURCES,
  RESTORE_TARGET,
  WRITE_BLOCKED_COMPLEMENT_OF_PENDING_SOURCES,
  buildTenantStateMover,
  type TenantStatusWriter,
} from "./tenant-state-mover.js";
import type { TenantTransition } from "./platform-admin.js";
import type { TenantRecord, TenantStatus } from "./platform-tenants.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

function record(status: TenantStatus): TenantRecord {
  return {
    id: TENANT,
    slug: "acme",
    name: "Acme",
    status,
    tier: "small",
    region: "eu",
    schemaName: "t_acme",
    searchLocale: "english",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * A writer that reports a landed transition out of `previousStatus`, or `null` for a no-match.
 *
 * The previous state is a *parameter* of the fake rather than derived from the record it returns,
 * because that is the asymmetry the real store has: `RETURNING` answers with the row as it now
 * stands, so the state the predicate matched has to be carried separately or it is lost.
 */
function writer(
  result: TenantTransition | null,
): TenantStatusWriter & {
  calls: { id: string; to: TenantStatus; from: readonly TenantStatus[] }[];
} {
  const calls: { id: string; to: TenantStatus; from: readonly TenantStatus[] }[] = [];
  return {
    calls,
    transitionStatus: async (id, to, from) => {
      calls.push({ id, to, from });
      return result;
    },
  };
}

function landed(to: TenantStatus, previousStatus: TenantStatus): TenantTransition {
  return { tenant: record(to), previousStatus };
}

describe("source sets", () => {
  it("derives the pending_deletion sources from the lifecycle map", () => {
    expect(PENDING_DELETION_SOURCES).toEqual(["active", "suspended", "archived"]);
  });

  it("excludes deleted — a deleted tenant is not re-queued", () => {
    expect(PENDING_DELETION_SOURCES).not.toContain("deleted");
    expect(PENDING_DELETION_SOURCES).not.toContain("pending_deletion");
  });

  it("restores only from pending_deletion, and to active", () => {
    expect(RESTORE_SOURCES).toEqual(["pending_deletion"]);
    expect(RESTORE_TARGET).toBe("active");
  });

  it("every state markPendingDeletion will not move already blocks writes", () => {
    // This is what makes `tenantReadOnly: true` honest through a no-match: the states the
    // transition declines to move out of are exactly `{pending_deletion, deleted}`, and both are
    // write-blocked, so a tenant it did not move was already read-only. A sixth state added to
    // `TENANT_LIFECYCLE_STATES` without a path to `pending_deletion` fails here rather than
    // quietly making the route claim something it cannot support.
    expect(WRITE_BLOCKED_COMPLEMENT_OF_PENDING_SOURCES).toEqual(["pending_deletion", "deleted"]);
    for (const s of WRITE_BLOCKED_COMPLEMENT_OF_PENDING_SOURCES) {
      expect(blocksWrites(s)).toBe(true);
    }
  });

  it("no state restore declines is one this flow put the tenant in", () => {
    // `restore`'s complement: `active` has nothing to restore, and the other three are an
    // operator's decision a rejected deletion request has no standing to override.
    const complement = TENANT_LIFECYCLE_STATES.filter((s) => !RESTORE_SOURCES.includes(s));
    expect(complement).toEqual(["active", "suspended", "archived", "deleted"]);
  });
});

describe("buildTenantStateMover", () => {
  it("marks pending_deletion with the derived source set in the predicate", async () => {
    const store = writer(landed("pending_deletion", "active"));
    await buildTenantStateMover(store).markPendingDeletion(TENANT);
    expect(store.calls).toEqual([
      { id: TENANT, to: "pending_deletion", from: ["active", "suspended", "archived"] },
    ]);
  });

  it("restores to active only from pending_deletion", async () => {
    const store = writer(landed("active", "pending_deletion"));
    await buildTenantStateMover(store).restore(TENANT);
    expect(store.calls).toEqual([
      { id: TENANT, to: "active", from: ["pending_deletion"] },
    ]);
  });

  it("does not throw when nothing matched — the premise was wrong, not broken", async () => {
    const store = writer(null);
    await expect(buildTenantStateMover(store).restore(TENANT)).resolves.toEqual({
      moved: false,
      fromState: null,
    });
  });

  it("reports the state it moved the tenant out of, so the trail's fromState is not a guess", async () => {
    // The whole reason `transitionStatus` reports a previous state: `PENDING_DELETION_SOURCES` has
    // three members, so the predicate's candidate list does not say which one matched, and a
    // lifecycle event's `fromState` is a required field of a permanent record.
    const store = writer(landed("pending_deletion", "suspended"));
    await expect(buildTenantStateMover(store).markPendingDeletion(TENANT)).resolves.toEqual({
      moved: true,
      fromState: "suspended",
    });
  });

  it("reports fromState: null on a no-match rather than guessing from the source set", async () => {
    // Even for `restore`, whose source set is a singleton and so would *look* inferable: nothing
    // moved, and a fabricated source state would put a transition in the trail the row never made.
    await expect(buildTenantStateMover(writer(null)).restore(TENANT)).resolves.toEqual({
      moved: false,
      fromState: null,
    });
  });

  it("reports a no-match through onNoMatch with the attempted transition", async () => {
    const onNoMatch = vi.fn();
    const store = writer(null);
    await buildTenantStateMover(store, { onNoMatch }).markPendingDeletion(TENANT);
    expect(onNoMatch).toHaveBeenCalledWith({
      tenantId: TENANT,
      to: "pending_deletion",
      from: ["active", "suspended", "archived"],
    });
  });

  it("does not report a no-match when the row moved", async () => {
    const onNoMatch = vi.fn();
    await buildTenantStateMover(writer(landed("active", "pending_deletion")), { onNoMatch }).restore(TENANT);
    expect(onNoMatch).not.toHaveBeenCalled();
  });

  it("propagates a store failure, so the route can report the open window", async () => {
    const store: TenantStatusWriter = {
      transitionStatus: async () => {
        throw new Error("deadlock detected");
      },
    };
    await expect(buildTenantStateMover(store).markPendingDeletion(TENANT)).rejects.toThrow(
      "deadlock detected",
    );
  });
});
