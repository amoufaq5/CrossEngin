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

function writer(
  result: TenantRecord | null,
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
    const store = writer(record("pending_deletion"));
    await buildTenantStateMover(store).markPendingDeletion(TENANT);
    expect(store.calls).toEqual([
      { id: TENANT, to: "pending_deletion", from: ["active", "suspended", "archived"] },
    ]);
  });

  it("restores to active only from pending_deletion", async () => {
    const store = writer(record("active"));
    await buildTenantStateMover(store).restore(TENANT);
    expect(store.calls).toEqual([
      { id: TENANT, to: "active", from: ["pending_deletion"] },
    ]);
  });

  it("does not throw when nothing matched — the premise was wrong, not broken", async () => {
    const store = writer(null);
    await expect(buildTenantStateMover(store).restore(TENANT)).resolves.toBeUndefined();
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
    await buildTenantStateMover(writer(record("active")), { onNoMatch }).restore(TENANT);
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
