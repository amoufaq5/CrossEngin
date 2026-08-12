import { describe, expect, it } from "vitest";
import type { UsageReporter, UsageReportInput } from "@crossengin/billing-runtime-pg";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import {
  StripeUsageSyncScheduler,
  buildStripeUsageSync,
  parseStripeUsageSyncConfig,
} from "./stripe-usage-sync.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const SUB = "33333333-3333-3333-3333-333333333333";

function record(id: string) {
  return {
    id,
    tenantId: TENANT_A,
    subscriptionId: SUB,
    meter: "ai_call",
    period: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
    quantity: 42,
    source: "ai_provider_calls",
    recordedAt: "2026-07-01T00:00:00.000Z",
    idempotencyKey: "usage_key_1",
    syncedToStripeAt: null,
    stripeUsageRecordId: null,
  };
}

/** A fake conn whose SELECT returns one un-synced record row, capturing UPDATEs. */
function fakePg(rows: Record<string, unknown>[]): { conn: PgConnection; sql: string[] } {
  const sql: string[] = [];
  let served = false;
  const conn: PgConnection = {
    query: (async (q: string) => {
      sql.push(q);
      if (/SELECT record/i.test(q) && !served) {
        served = true;
        return { rows, rowCount: rows.length } as PgQueryResult;
      }
      return { rows: [], rowCount: 0 } as PgQueryResult;
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => {}) as PgConnection["close"],
  };
  return { conn, sql };
}

class RecordingReporter implements UsageReporter {
  readonly calls: UsageReportInput[] = [];
  async createUsageRecord(input: UsageReportInput): Promise<{ id: string }> {
    this.calls.push(input);
    return { id: `mbur_${this.calls.length.toString()}` };
  }
}

const config = parseStripeUsageSyncConfig({
  tenants: [TENANT_A, TENANT_B],
  subscriptionItems: { [`${SUB}|ai_call`]: "si_ai" },
});

describe("parseStripeUsageSyncConfig", () => {
  it("defaults the interval + requires tenants", () => {
    expect(config.intervalMs).toBe(3_600_000);
    expect(() => parseStripeUsageSyncConfig({ subscriptionItems: {} })).toThrow();
    expect(() => parseStripeUsageSyncConfig({ tenants: [], subscriptionItems: {} })).toThrow();
  });

  it("rejects unknown keys + a non-uuid tenant", () => {
    expect(() => parseStripeUsageSyncConfig({ tenants: [TENANT_A], subscriptionItems: {}, bogus: 1 })).toThrow();
    expect(() => parseStripeUsageSyncConfig({ tenants: ["nope"], subscriptionItems: {} })).toThrow();
  });
});

describe("StripeUsageSyncScheduler", () => {
  it("reports each tenant's un-synced usage on a tick", async () => {
    const { conn } = fakePg([{ record: JSON.stringify(record("44444444-4444-4444-4444-444444444444")) }]);
    const reporter = new RecordingReporter();
    const outcomes: string[] = [];
    const { scheduler } = buildStripeUsageSync(conn, reporter, config, {
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      onSync: (o) => outcomes.push(`${o.tenant}:${o.synced.toString()}`),
    });
    const results = await scheduler.syncOnce();
    // Both tenants iterated; TENANT_A's one record reported (the fake serves it once).
    expect(results).toHaveLength(2);
    expect(reporter.calls[0]?.subscriptionItemId).toBe("si_ai");
    expect(outcomes.some((o) => o.startsWith(TENANT_A))).toBe(true);
  });

  it("routes a per-tenant error to onError without aborting the batch", async () => {
    const throwingReporter: UsageReporter = {
      createUsageRecord: async () => {
        throw new Error("stripe down");
      },
    };
    const { conn } = fakePg([{ record: JSON.stringify(record("44444444-4444-4444-4444-444444444444")) }]);
    let captured: unknown = null;
    const { scheduler } = buildStripeUsageSync(conn, throwingReporter, config, {
      onError: (err) => {
        captured = err;
      },
    });
    const results = await scheduler.syncOnce();
    // TENANT_A throws (routed to onError); TENANT_B has no records ⇒ a clean {synced:0}.
    expect((captured as Error).message).toBe("stripe down");
    expect(results.some((r) => r.tenant === TENANT_B)).toBe(true);
  });

  it("start/stop drive an injected interval scheduler", () => {
    const { conn } = fakePg([]);
    let live = false;
    const { scheduler } = buildStripeUsageSync(conn, new RecordingReporter(), config, {
      scheduler: {
        setInterval: () => {
          live = true;
          return 1;
        },
        clearInterval: () => {
          live = false;
        },
      },
    });
    scheduler.start();
    expect(live).toBe(true);
    scheduler.stop();
    expect(live).toBe(false);
  });
});
