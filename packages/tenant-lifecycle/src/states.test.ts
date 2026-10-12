import { describe, expect, it } from "vitest";
import {
  RESTORABLE_STATES,
  READ_ONLY_STATES,
  TENANT_LIFECYCLE_STATES,
  TENANT_LIFECYCLE_TRANSITIONS,
  TERMINAL_STATES,
  blocksReads,
  blocksWrites,
  canTransitionLifecycle,
  isReadOnly,
  isRestorable,
  isTerminal,
} from "./states.js";

describe("constants", () => {
  it("TENANT_LIFECYCLE_STATES has 5 entries — what a tenant row can hold", () => {
    expect(TENANT_LIFECYCLE_STATES).toHaveLength(5);
    expect(TENANT_LIFECYCLE_STATES).toContain("pending_deletion");
    expect(TENANT_LIFECYCLE_STATES).toContain("deleted");
  });

  it("drops the two billing facts that were duplicated onto the tenant", () => {
    // `past_due` is a *subscription* status with its own transition map in @crossengin/billing, and
    // `trial` is a plan tier — neither was storable in `meta.tenants.status` and neither is a fact
    // about the tenant. Pinned so they cannot drift back in: a tenant in arrears is `active`.
    expect(TENANT_LIFECYCLE_STATES).not.toContain("past_due");
    expect(TENANT_LIFECYCLE_STATES).not.toContain("trial");
  });

  it("is exactly what the catalog's CHECK permits", () => {
    // The two vocabularies this reconciles: `meta.tenants.status` is CHECK-constrained and the
    // console transitions it, so a state this enum holds and the column refuses is a state no
    // tenant can be in. Spelled here rather than imported, because importing @crossengin/kernel
    // would invert the dependency — the kernel's own test asserts the other direction.
    expect([...TENANT_LIFECYCLE_STATES].sort()).toEqual(
      ["active", "archived", "deleted", "pending_deletion", "suspended"],
    );
  });

  it("READ_ONLY_STATES = suspended, archived, pending_deletion", () => {
    expect(READ_ONLY_STATES.has("suspended")).toBe(true);
    expect(READ_ONLY_STATES.has("archived")).toBe(true);
    expect(READ_ONLY_STATES.has("pending_deletion")).toBe(true);
    expect(READ_ONLY_STATES.has("active")).toBe(false);
  });

  it("TERMINAL_STATES = deleted only", () => {
    expect(TERMINAL_STATES.has("deleted")).toBe(true);
    expect(TERMINAL_STATES.size).toBe(1);
  });

  it("RESTORABLE_STATES = suspended, archived, pending_deletion", () => {
    expect(RESTORABLE_STATES.has("suspended")).toBe(true);
    expect(RESTORABLE_STATES.has("pending_deletion")).toBe(true);
    expect(RESTORABLE_STATES.has("deleted")).toBe(false);
  });
});

describe("canTransitionLifecycle", () => {
  it("deleted is reachable only from pending_deletion", () => {
    // Which is what makes the read-only window before an erasure a state rather than a convention:
    // the Article 17 flow cannot take a serving tenant straight to `deleted`.
    for (const from of TENANT_LIFECYCLE_STATES) {
      expect([from, canTransitionLifecycle(from, "deleted")]).toEqual([
        from,
        from === "pending_deletion",
      ]);
    }
  });

  it("active -> suspended", () => {
    expect(canTransitionLifecycle("active", "suspended")).toBe(true);
  });

  it("suspended -> active (restore)", () => {
    expect(canTransitionLifecycle("suspended", "active")).toBe(true);
  });

  it("pending_deletion -> archived (cancel deletion)", () => {
    expect(canTransitionLifecycle("pending_deletion", "archived")).toBe(true);
  });

  it("pending_deletion -> active, because a verified request can still be rejected", () => {
    // `DELETION_REQUEST_TRANSITIONS` permits `verified -> rejected`, so the tenant a verification
    // put here can be let go again, and it must come all the way back rather than stopping at
    // `archived` — a rejected request must not cost the tenant their write access.
    expect(canTransitionLifecycle("pending_deletion", "active")).toBe(true);
    expect(RESTORABLE_STATES.has("pending_deletion")).toBe(true);
  });

  it("pending_deletion -> deleted", () => {
    expect(canTransitionLifecycle("pending_deletion", "deleted")).toBe(true);
  });

  it("deleted is terminal (no outgoing transitions)", () => {
    expect(canTransitionLifecycle("deleted", "active")).toBe(false);
    expect(TENANT_LIFECYCLE_TRANSITIONS.deleted).toEqual([]);
  });

  it("active -> deleted is not direct (must go through pending_deletion)", () => {
    expect(canTransitionLifecycle("active", "deleted")).toBe(false);
  });
});

describe("helpers", () => {
  it("isReadOnly true for suspended/archived/pending_deletion", () => {
    expect(isReadOnly("suspended")).toBe(true);
    expect(isReadOnly("archived")).toBe(true);
    expect(isReadOnly("pending_deletion")).toBe(true);
    expect(isReadOnly("active")).toBe(false);
  });

  it("isTerminal true for deleted only", () => {
    expect(isTerminal("deleted")).toBe(true);
    expect(isTerminal("archived")).toBe(false);
  });

  it("isRestorable true for read-only states", () => {
    expect(isRestorable("suspended")).toBe(true);
    expect(isRestorable("pending_deletion")).toBe(true);
    expect(isRestorable("deleted")).toBe(false);
  });

  it("blocksWrites for read-only and terminal", () => {
    expect(blocksWrites("suspended")).toBe(true);
    expect(blocksWrites("deleted")).toBe(true);
    expect(blocksWrites("active")).toBe(false);
  });

  it("blocksReads only for deleted", () => {
    expect(blocksReads("deleted")).toBe(true);
    expect(blocksReads("suspended")).toBe(false);
    expect(blocksReads("archived")).toBe(false);
  });
});
