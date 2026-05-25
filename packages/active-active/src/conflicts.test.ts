import { describe, expect, it } from "vitest";
import {
  CONFLICT_KINDS,
  CONFLICT_STATUSES,
  ConflictRecordSchema,
  RESOLUTION_STRATEGIES,
  canTransitionConflict,
  detectConflictKind,
  isAutoResolvable,
  preferredStrategyFor,
  type ConflictRecord,
  type ConflictingWrite,
} from "./conflicts.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("CONFLICT_KINDS has 6 entries", () => {
    expect(CONFLICT_KINDS).toContain("concurrent_write");
    expect(CONFLICT_KINDS).toContain("tenant_residency_violation");
  });

  it("RESOLUTION_STRATEGIES has 7 entries", () => {
    expect(RESOLUTION_STRATEGIES).toContain("last_writer_wins");
    expect(RESOLUTION_STRATEGIES).toContain("crdt_merge");
    expect(RESOLUTION_STRATEGIES).toContain("manual_review");
  });

  it("CONFLICT_STATUSES has 5 entries", () => {
    expect(CONFLICT_STATUSES).toContain("auto_resolving");
    expect(CONFLICT_STATUSES).toContain("escalated");
  });
});

describe("canTransitionConflict", () => {
  it("detected -> auto_resolving", () => {
    expect(canTransitionConflict("detected", "auto_resolving")).toBe(true);
  });

  it("auto_resolving -> resolved", () => {
    expect(canTransitionConflict("auto_resolving", "resolved")).toBe(true);
  });

  it("resolved is terminal", () => {
    expect(canTransitionConflict("resolved", "detected")).toBe(false);
  });

  it("escalated -> awaiting_review", () => {
    expect(canTransitionConflict("escalated", "awaiting_review")).toBe(true);
  });
});

describe("ConflictRecordSchema", () => {
  const baseWrite: ConflictingWrite = {
    region: "eu-central",
    vectorClock: [{ region: "eu-central", counter: 5 }],
    payloadSha256: SHA,
    occurredAt: "2026-05-15T10:00:00Z",
    actorReference: "u-1",
  };

  const base: ConflictRecord = {
    id: "CFL-2026-0001",
    tenantId: "t-1",
    entityClass: "tenants",
    entityId: "t-id-1",
    kind: "concurrent_write",
    status: "resolved",
    detectedAt: "2026-05-15T10:01:00Z",
    conflictingWrites: [
      baseWrite,
      {
        region: "us-east",
        vectorClock: [{ region: "us-east", counter: 3 }],
        payloadSha256: SHA,
        occurredAt: "2026-05-15T10:00:00Z",
        actorReference: "u-2",
      },
    ],
    chosenStrategy: "vector_clock_merge",
    chosenStrategyAt: "2026-05-15T10:01:30Z",
    chosenStrategyBy: "u-resolver",
    resolvedAt: "2026-05-15T10:02:00Z",
    resolvedBy: "u-resolver",
    resolutionPayloadSha256: SHA,
    requiresAudit: false,
    auditRecordedAt: null,
  };

  it("accepts a valid resolved conflict", () => {
    expect(() => ConflictRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate region in conflicting writes", () => {
    expect(() =>
      ConflictRecordSchema.parse({
        ...base,
        conflictingWrites: [baseWrite, baseWrite],
      }),
    ).toThrow(/duplicate conflicting write/);
  });

  it("rejects concurrent_write kind with non-concurrent clocks", () => {
    expect(() =>
      ConflictRecordSchema.parse({
        ...base,
        conflictingWrites: [
          {
            ...baseWrite,
            vectorClock: [{ region: "eu-central", counter: 3 }],
          },
          {
            ...baseWrite,
            region: "us-east",
            vectorClock: [{ region: "eu-central", counter: 5 }],
          },
        ],
      }),
    ).toThrow(/causally concurrent/);
  });

  it("rejects resolved without resolutionPayloadSha256", () => {
    expect(() => ConflictRecordSchema.parse({ ...base, resolutionPayloadSha256: null })).toThrow(
      /resolutionPayloadSha256/,
    );
  });

  it("rejects manual_review resolved without notes", () => {
    expect(() =>
      ConflictRecordSchema.parse({
        ...base,
        chosenStrategy: "manual_review",
      }),
    ).toThrow(/resolutionNotes/);
  });

  it("rejects tenant_residency_violation without requiresAudit=true", () => {
    expect(() =>
      ConflictRecordSchema.parse({
        ...base,
        kind: "tenant_residency_violation",
        chosenStrategy: "manual_review",
        resolutionNotes: "x",
      }),
    ).toThrow(/requiresAudit/);
  });

  it("rejects tenant_residency_violation auto_resolving", () => {
    expect(() =>
      ConflictRecordSchema.parse({
        ...base,
        kind: "tenant_residency_violation",
        status: "auto_resolving",
        chosenStrategy: null,
        chosenStrategyAt: null,
        chosenStrategyBy: null,
        resolvedAt: null,
        resolvedBy: null,
        resolutionPayloadSha256: null,
        requiresAudit: true,
      }),
    ).toThrow(/cannot be auto_resolving/);
  });

  it("rejects requiresAudit + resolved without auditRecordedAt", () => {
    expect(() =>
      ConflictRecordSchema.parse({
        ...base,
        requiresAudit: true,
      }),
    ).toThrow(/auditRecordedAt/);
  });

  it("rejects escalated without escalatedTo + reason", () => {
    expect(() =>
      ConflictRecordSchema.parse({
        ...base,
        status: "escalated",
        chosenStrategy: null,
        chosenStrategyAt: null,
        chosenStrategyBy: null,
        resolvedAt: null,
        resolvedBy: null,
        resolutionPayloadSha256: null,
      }),
    ).toThrow();
  });

  it("rejects malformed conflict id", () => {
    expect(() => ConflictRecordSchema.parse({ ...base, id: "CFL-1" })).toThrow();
  });
});

describe("detectConflictKind", () => {
  it("returns null for single write", () => {
    expect(
      detectConflictKind([
        {
          region: "eu-central",
          vectorClock: [{ region: "eu-central", counter: 1 }],
          payloadSha256: SHA,
          occurredAt: "2026-05-15T10:00:00Z",
          actorReference: "u-1",
        },
      ]),
    ).toBeNull();
  });

  it("returns concurrent_write for concurrent clocks", () => {
    expect(
      detectConflictKind([
        {
          region: "eu-central",
          vectorClock: [{ region: "eu-central", counter: 5 }],
          payloadSha256: SHA,
          occurredAt: "2026-05-15T10:00:00Z",
          actorReference: "u-1",
        },
        {
          region: "us-east",
          vectorClock: [{ region: "us-east", counter: 3 }],
          payloadSha256: SHA,
          occurredAt: "2026-05-15T10:00:00Z",
          actorReference: "u-2",
        },
      ]),
    ).toBe("concurrent_write");
  });

  it("returns null when clocks are causally ordered", () => {
    expect(
      detectConflictKind([
        {
          region: "eu-central",
          vectorClock: [{ region: "eu-central", counter: 3 }],
          payloadSha256: SHA,
          occurredAt: "2026-05-15T10:00:00Z",
          actorReference: "u-1",
        },
        {
          region: "us-east",
          vectorClock: [{ region: "eu-central", counter: 5 }],
          payloadSha256: SHA,
          occurredAt: "2026-05-15T10:00:00Z",
          actorReference: "u-2",
        },
      ]),
    ).toBeNull();
  });
});

describe("preferredStrategyFor", () => {
  it("concurrent_write -> vector_clock_merge", () => {
    expect(preferredStrategyFor("concurrent_write")).toBe("vector_clock_merge");
  });

  it("schema_drift -> manual_review", () => {
    expect(preferredStrategyFor("schema_drift")).toBe("manual_review");
  });

  it("ordering_ambiguity -> last_writer_wins", () => {
    expect(preferredStrategyFor("ordering_ambiguity")).toBe("last_writer_wins");
  });
});

describe("isAutoResolvable", () => {
  it("auto-resolvable for lww/fww/vector-clock/crdt", () => {
    expect(isAutoResolvable("last_writer_wins")).toBe(true);
    expect(isAutoResolvable("first_writer_wins")).toBe(true);
    expect(isAutoResolvable("vector_clock_merge")).toBe(true);
    expect(isAutoResolvable("crdt_merge")).toBe(true);
  });

  it("not auto-resolvable for manual/application/rollback", () => {
    expect(isAutoResolvable("manual_review")).toBe(false);
    expect(isAutoResolvable("application_merge")).toBe(false);
    expect(isAutoResolvable("rollback")).toBe(false);
  });
});
