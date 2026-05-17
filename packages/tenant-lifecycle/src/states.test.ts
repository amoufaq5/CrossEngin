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
  it("TENANT_LIFECYCLE_STATES has 7 entries", () => {
    expect(TENANT_LIFECYCLE_STATES).toHaveLength(7);
    expect(TENANT_LIFECYCLE_STATES).toContain("trial");
    expect(TENANT_LIFECYCLE_STATES).toContain("pending_deletion");
    expect(TENANT_LIFECYCLE_STATES).toContain("deleted");
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
  it("trial -> active", () => {
    expect(canTransitionLifecycle("trial", "active")).toBe(true);
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
