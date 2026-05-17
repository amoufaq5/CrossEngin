import { describe, expect, it } from "vitest";
import {
  SIGNAL_DELIVERY_GUARANTEES,
  SIGNAL_REJECTION_REASONS,
  SIGNAL_STATUSES,
  SIGNAL_TRANSITIONS,
  WorkflowSignalSchema,
  canTransitionSignal,
  findDuplicateSignal,
  isSignalExpired,
  matchSignalToInstance,
  type WorkflowSignal,
} from "./signals.js";

const baseSignal: WorkflowSignal = {
  id: "wfs_extern01",
  tenantId: "11111111-1111-1111-1111-111111111111",
  instanceId: null,
  signalName: "external.approve",
  correlationKey: "PR-2026-001",
  deliveryGuarantee: "at_least_once",
  idempotencyKey: null,
  payloadSha256: "a".repeat(64),
  payloadStorageUri: "s3://signals/2026/05/abc.json",
  payloadSizeBytes: 256,
  sourceSystem: "external-erp",
  sourcePrincipalId: null,
  status: "received",
  receivedAt: "2026-05-16T10:00:00.000Z",
  matchedAt: null,
  consumedAt: null,
  consumedByActivityId: null,
  expiresAt: "2026-05-16T11:00:00.000Z",
  expiredAt: null,
  rejectedAt: null,
  rejectedReason: null,
};

describe("constants", () => {
  it("has 3 delivery guarantees", () => {
    expect(SIGNAL_DELIVERY_GUARANTEES).toHaveLength(3);
  });
  it("has 5 signal statuses", () => {
    expect(SIGNAL_STATUSES).toHaveLength(5);
  });
  it("has 7 rejection reasons", () => {
    expect(SIGNAL_REJECTION_REASONS).toHaveLength(7);
  });
});

describe("canTransitionSignal", () => {
  it("allows received → matched_to_instance", () => {
    expect(canTransitionSignal("received", "matched_to_instance")).toBe(true);
  });
  it("blocks consumed → received (no rewind)", () => {
    expect(canTransitionSignal("consumed", "received")).toBe(false);
  });
  it("rejected is terminal", () => {
    expect(SIGNAL_TRANSITIONS.rejected).toEqual([]);
  });
});

describe("WorkflowSignalSchema", () => {
  it("accepts a received signal", () => {
    expect(() => WorkflowSignalSchema.parse(baseSignal)).not.toThrow();
  });

  it("rejects exactly_once_idempotent without idempotencyKey", () => {
    expect(() =>
      WorkflowSignalSchema.parse({
        ...baseSignal,
        deliveryGuarantee: "exactly_once_idempotent",
      }),
    ).toThrow(/exactly_once_idempotent delivery requires idempotencyKey/);
  });

  it("rejects payloadStorageUri without payloadSha256", () => {
    expect(() =>
      WorkflowSignalSchema.parse({
        ...baseSignal,
        payloadSha256: null,
        payloadStorageUri: "s3://signals/x.json",
        payloadSizeBytes: 0,
      }),
    ).toThrow(/payloadStorageUri set requires payloadSha256/);
  });

  it("rejects matched_to_instance status without instanceId + matchedAt", () => {
    expect(() =>
      WorkflowSignalSchema.parse({
        ...baseSignal,
        status: "matched_to_instance",
      }),
    ).toThrow(/instanceId \+ matchedAt/);
  });

  it("rejects consumed without consumedAt", () => {
    expect(() =>
      WorkflowSignalSchema.parse({
        ...baseSignal,
        status: "consumed",
        instanceId: "wfi_pr00000001",
        matchedAt: "2026-05-16T10:01:00.000Z",
      }),
    ).toThrow(/consumed status requires/);
  });

  it("rejects rejected without rejectedReason", () => {
    expect(() =>
      WorkflowSignalSchema.parse({
        ...baseSignal,
        status: "rejected",
        rejectedAt: "2026-05-16T10:01:00.000Z",
      }),
    ).toThrow(/rejectedReason/);
  });

  it("rejects matchedAt before receivedAt", () => {
    expect(() =>
      WorkflowSignalSchema.parse({
        ...baseSignal,
        status: "matched_to_instance",
        instanceId: "wfi_pr00000001",
        matchedAt: "2026-05-16T09:00:00.000Z",
      }),
    ).toThrow(/cannot precede receivedAt/);
  });
});

describe("isSignalExpired", () => {
  it("returns false before expiresAt for received signal", () => {
    expect(
      isSignalExpired(baseSignal, new Date("2026-05-16T10:30:00Z")),
    ).toBe(false);
  });
  it("returns true past expiresAt for received signal", () => {
    expect(
      isSignalExpired(baseSignal, new Date("2026-05-16T11:30:00Z")),
    ).toBe(true);
  });
  it("returns false for consumed signal even past expiry", () => {
    const consumed: WorkflowSignal = {
      ...baseSignal,
      status: "consumed",
      instanceId: "wfi_pr00000001",
      matchedAt: "2026-05-16T10:01:00.000Z",
      consumedAt: "2026-05-16T10:02:00.000Z",
    };
    expect(isSignalExpired(consumed, new Date("2026-05-16T12:00:00Z"))).toBe(
      false,
    );
  });
});

describe("findDuplicateSignal", () => {
  it("returns matching signal by name + idempotencyKey", () => {
    const signal: WorkflowSignal = {
      ...baseSignal,
      idempotencyKey: "client-key-1",
      deliveryGuarantee: "exactly_once_idempotent",
    };
    const r = findDuplicateSignal([signal], {
      signalName: "external.approve",
      idempotencyKey: "client-key-1",
    });
    expect(r).not.toBeNull();
  });

  it("returns null when idempotencyKey is null", () => {
    expect(
      findDuplicateSignal([baseSignal], {
        signalName: "external.approve",
        idempotencyKey: null,
      }),
    ).toBeNull();
  });
});

describe("matchSignalToInstance", () => {
  it("matches by tenant + correlation + awaiting signal name", () => {
    const r = matchSignalToInstance(baseSignal, [
      {
        id: "wfi_pr00000001",
        correlationKey: "PR-2026-001",
        awaitingSignalNames: ["external.approve"],
        tenantId: baseSignal.tenantId,
      },
    ]);
    expect(r).toBe("wfi_pr00000001");
  });

  it("returns null when no instance is awaiting the signal", () => {
    const r = matchSignalToInstance(baseSignal, [
      {
        id: "wfi_pr00000001",
        correlationKey: "PR-2026-001",
        awaitingSignalNames: ["other.signal"],
        tenantId: baseSignal.tenantId,
      },
    ]);
    expect(r).toBeNull();
  });

  it("returns null on tenant mismatch", () => {
    const r = matchSignalToInstance(baseSignal, [
      {
        id: "wfi_pr00000001",
        correlationKey: "PR-2026-001",
        awaitingSignalNames: ["external.approve"],
        tenantId: "99999999-9999-9999-9999-999999999999",
      },
    ]);
    expect(r).toBeNull();
  });
});
