import { describe, expect, it } from "vitest";
import { usageRecordFrom } from "@crossengin/billing-runtime";

import { PostgresUsageRecordStore } from "./usage-store.js";
import {
  UsageStripeSync,
  staticSubscriptionItemResolver,
  type UsageReporter,
  type UsageReportInput,
} from "./stripe-sync.js";
import { fakePg } from "./test-fakes.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SUB = "22222222-2222-2222-2222-222222222222";
const period = { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" };

function record(id: string, meter: "ai_call" | "integration_call" = "ai_call") {
  return usageRecordFrom({
    tenantId: TENANT,
    subscriptionId: SUB,
    meter,
    quantity: 200.4,
    source: "ai_provider_calls",
    period,
    id,
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
}

class RecordingReporter implements UsageReporter {
  readonly calls: UsageReportInput[] = [];
  private seq = 0;
  async createUsageRecord(input: UsageReportInput): Promise<{ id: string }> {
    this.calls.push(input);
    this.seq += 1;
    return { id: `mbur_${this.seq.toString()}` };
  }
}

describe("staticSubscriptionItemResolver", () => {
  it("keys by subscription + meter", () => {
    const resolve = staticSubscriptionItemResolver({ [`${SUB}|ai_call`]: "si_ai" });
    expect(resolve(record("33333333-3333-3333-3333-333333333333"))).toBe("si_ai");
    expect(resolve(record("44444444-4444-4444-4444-444444444444", "integration_call"))).toBeNull();
  });
});

describe("PostgresUsageRecordStore.listUnsynced / markSynced", () => {
  it("lists un-synced records within the RLS context", async () => {
    const row = { record: JSON.stringify(record("33333333-3333-3333-3333-333333333333")) };
    const { conn, calls } = fakePg([[row]]);
    const out = await new PostgresUsageRecordStore(conn).listUnsynced(TENANT);
    expect(out).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes("set_config"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("synced_to_stripe_at IS NULL"))).toBe(true);
  });

  it("marks a record synced by id, guarded on still-unsynced", async () => {
    const { conn, calls } = fakePg();
    await new PostgresUsageRecordStore(conn).markSynced(TENANT, "33333333-3333-3333-3333-333333333333", "mbur_1", "2026-07-02T00:00:00.000Z");
    const update = calls.find((c) => c.sql.includes("UPDATE"))!;
    expect(update.sql).toContain("SET synced_to_stripe_at = $2");
    expect(update.sql).toContain("WHERE id = $1 AND synced_to_stripe_at IS NULL");
    expect(update.params).toEqual(["33333333-3333-3333-3333-333333333333", "2026-07-02T00:00:00.000Z", "mbur_1"]);
  });
});

describe("UsageStripeSync", () => {
  it("reports un-synced records to Stripe and marks them synced", async () => {
    const rows = [
      { record: JSON.stringify(record("33333333-3333-3333-3333-333333333333")) },
    ];
    const { conn, calls } = fakePg([rows]);
    const reporter = new RecordingReporter();
    const sync = new UsageStripeSync({
      store: new PostgresUsageRecordStore(conn),
      reporter,
      resolver: staticSubscriptionItemResolver({ [`${SUB}|ai_call`]: "si_ai" }),
      now: () => new Date("2026-07-02T00:00:00.000Z"),
    });
    const result = await sync.syncTenant(TENANT);
    expect(result).toEqual({ synced: 1, skipped: 0 });
    // Reported with rounded quantity, the period-end timestamp, and the record's idempotency key.
    expect(reporter.calls[0]?.subscriptionItemId).toBe("si_ai");
    expect(reporter.calls[0]?.quantity).toBe(200); // 200.4 rounded
    expect(reporter.calls[0]?.idempotencyKey).toBeDefined();
    expect(calls.some((c) => c.sql.includes("UPDATE") && c.sql.includes("synced_to_stripe_at"))).toBe(true);
  });

  it("skips records with no subscription-item mapping without reporting", async () => {
    const rows = [
      { record: JSON.stringify(record("33333333-3333-3333-3333-333333333333", "integration_call")) },
    ];
    const { conn } = fakePg([rows]);
    const reporter = new RecordingReporter();
    const sync = new UsageStripeSync({
      store: new PostgresUsageRecordStore(conn),
      reporter,
      resolver: staticSubscriptionItemResolver({ [`${SUB}|ai_call`]: "si_ai" }),
    });
    const result = await sync.syncTenant(TENANT);
    expect(result).toEqual({ synced: 0, skipped: 1 });
    expect(reporter.calls).toHaveLength(0);
  });
});
