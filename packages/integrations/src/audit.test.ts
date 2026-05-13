import { describe, expect, it } from "vitest";
import { DataClassSchema, IntegrationCallRecordSchema } from "./audit.js";

describe("DataClassSchema", () => {
  it.each(["public", "internal", "commercial_sensitive", "pii", "phi", "regulated"])(
    "accepts %s",
    (c) => {
      expect(DataClassSchema.parse(c)).toBe(c);
    },
  );

  it("rejects unknown data class", () => {
    expect(() => DataClassSchema.parse("top-secret")).toThrow();
  });
});

describe("IntegrationCallRecordSchema", () => {
  it("parses a complete record", () => {
    expect(() =>
      IntegrationCallRecordSchema.parse({
        id: "ic_01H...",
        tenantId: "t_acme",
        integrationId: "stripeBilling",
        operation: "createInvoice",
        direction: "outbound",
        idempotencyKey: "inv_2026_05_12_001",
        request: {
          headers: { "Content-Type": "application/json" },
          body: { customer: "cus_xyz", amount: 5000 },
        },
        response: {
          status: 200,
          headers: { "stripe-version": "2024-04-10" },
          body: { id: "in_xyz", status: "open" },
        },
        latencyMs: 432,
        retries: 0,
        ok: true,
        dataClass: "commercial_sensitive",
        occurredAt: "2026-05-12T14:33:18.221Z",
      }),
    ).not.toThrow();
  });

  it("parses a failure record (no response status)", () => {
    expect(() =>
      IntegrationCallRecordSchema.parse({
        id: "ic_01H...",
        tenantId: "t_acme",
        integrationId: "stripeBilling",
        operation: "createInvoice",
        direction: "outbound",
        request: { body: {} },
        response: {},
        latencyMs: 5000,
        ok: false,
        errorMessage: "timeout after 5s",
        occurredAt: "2026-05-12T14:33:18.221Z",
      }),
    ).not.toThrow();
  });

  it("parses an inbound record without idempotency key", () => {
    expect(() =>
      IntegrationCallRecordSchema.parse({
        id: "ic_01H...",
        tenantId: "t_acme",
        integrationId: "labResultsHl7",
        operation: "deliver",
        direction: "inbound",
        request: {},
        response: { status: 200 },
        latencyMs: 12,
        ok: true,
        dataClass: "phi",
        occurredAt: "2026-05-12T14:33:18.221Z",
      }),
    ).not.toThrow();
  });

  it("rejects negative latency", () => {
    expect(() =>
      IntegrationCallRecordSchema.parse({
        id: "x",
        tenantId: "t",
        integrationId: "x",
        operation: "x",
        direction: "outbound",
        request: {},
        response: {},
        latencyMs: -1,
        ok: true,
        occurredAt: "x",
      }),
    ).toThrow();
  });

  it("rejects an unknown direction", () => {
    expect(() =>
      IntegrationCallRecordSchema.parse({
        id: "x",
        tenantId: "t",
        integrationId: "x",
        operation: "x",
        direction: "sideways",
        request: {},
        response: {},
        latencyMs: 1,
        ok: true,
        occurredAt: "x",
      }),
    ).toThrow();
  });
});
