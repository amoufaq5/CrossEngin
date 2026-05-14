import { describe, expect, it } from "vitest";
import {
  advanceWatermark,
  applyLastWriteWins,
  CONFLICT_STRATEGIES,
  ConflictResolutionRecordSchema,
  hasConflict,
  SyncRequestSchema,
  SyncResponseSchema,
} from "./sync.js";

const earlier = "2026-05-13T09:00:00.000Z";
const later = "2026-05-13T10:00:00.000Z";

describe("CONFLICT_STRATEGIES", () => {
  it("includes the three documented strategies", () => {
    expect(CONFLICT_STRATEGIES).toEqual([
      "last_write_wins",
      "manual_merge",
      "server_authoritative",
    ]);
  });
});

describe("SyncRequestSchema", () => {
  it("parses a foreground sync request", () => {
    expect(() =>
      SyncRequestSchema.parse({
        tenantId: "t_1",
        trigger: "foreground",
        entities: ["Prescription"],
        watermarks: [
          {
            tenantId: "t_1",
            entity: "Prescription",
            updatedAtCursor: earlier,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a watermark whose entity is not in the requested scope", () => {
    expect(() =>
      SyncRequestSchema.parse({
        tenantId: "t_1",
        trigger: "manual_refresh",
        entities: ["Prescription"],
        watermarks: [
          {
            tenantId: "t_1",
            entity: "Patient",
            updatedAtCursor: earlier,
          },
        ],
      }),
    ).toThrow(/not in the requested entities scope/);
  });
});

describe("SyncResponseSchema", () => {
  it("parses a response with upsert + delete operations", () => {
    expect(() =>
      SyncResponseSchema.parse({
        tenantId: "t_1",
        receivedAt: later,
        operations: [
          {
            op: "upsert",
            entity: "Prescription",
            id: "rx_1",
            updatedAt: later,
            row: { qty: 3 },
          },
          {
            op: "delete",
            entity: "Prescription",
            id: "rx_old",
            deletedAt: later,
          },
        ],
        newWatermarks: [
          {
            tenantId: "t_1",
            entity: "Prescription",
            updatedAtCursor: later,
          },
        ],
        hasMore: false,
        serverNowMillis: 1_700_000_000_000,
      }),
    ).not.toThrow();
  });
});

describe("hasConflict / applyLastWriteWins", () => {
  it("returns false when there are no unsynced local changes", () => {
    expect(
      hasConflict({
        localUpdatedAt: earlier,
        serverUpdatedAt: later,
        hasUnsyncedLocalChanges: false,
      }),
    ).toBe(false);
  });

  it("returns true when server has a later timestamp than local + local is unsynced", () => {
    expect(
      hasConflict({
        localUpdatedAt: earlier,
        serverUpdatedAt: later,
        hasUnsyncedLocalChanges: true,
      }),
    ).toBe(true);
  });

  it("applyLastWriteWins prefers the newer timestamp", () => {
    expect(
      applyLastWriteWins({
        localUpdatedAt: earlier,
        serverUpdatedAt: later,
        hasUnsyncedLocalChanges: true,
      }),
    ).toBe("server");
  });
});

describe("advanceWatermark", () => {
  it("advances to the latest updatedAt among operations", () => {
    const watermark = advanceWatermark(
      {
        tenantId: "t_1",
        entity: "Prescription",
        updatedAtCursor: earlier,
      },
      [
        {
          op: "upsert",
          entity: "Prescription",
          id: "rx_1",
          updatedAt: later,
          row: {},
        },
      ],
    );
    expect(watermark?.updatedAtCursor).toBe(later);
  });

  it("returns the current watermark unchanged when no operations advance it", () => {
    const current = {
      tenantId: "t_1",
      entity: "Prescription",
      updatedAtCursor: later,
    };
    const result = advanceWatermark(current, []);
    expect(result?.updatedAtCursor).toBe(later);
  });
});

describe("ConflictResolutionRecordSchema", () => {
  it("manual_merge requires resolvedBy + mergedRow when winner='merged'", () => {
    expect(() =>
      ConflictResolutionRecordSchema.parse({
        entity: "Prescription",
        entityId: "rx_1",
        strategy: "manual_merge",
        localUpdatedAt: earlier,
        serverUpdatedAt: later,
        resolvedAt: later,
        winner: "merged",
      }),
    ).toThrow(/manual_merge/);
  });

  it("accepts last_write_wins resolution without resolvedBy", () => {
    expect(() =>
      ConflictResolutionRecordSchema.parse({
        entity: "Prescription",
        entityId: "rx_1",
        strategy: "last_write_wins",
        localUpdatedAt: earlier,
        serverUpdatedAt: later,
        resolvedAt: later,
        winner: "server",
      }),
    ).not.toThrow();
  });
});
