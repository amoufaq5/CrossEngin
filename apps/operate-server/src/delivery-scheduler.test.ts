import type { DeliveryAttempt, NotificationDispatch } from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import type { DeliveryDrainOptions, DeliveryStoreLike, RecipientResolverLike } from "./delivery-drain.js";
import { DeliveryScheduler } from "./delivery-scheduler.js";
import { InAppSender, SenderRegistry } from "./delivery-senders.js";
import type { ClaimedDispatch, DispatchAdvanceUpdate, DueRetry } from "./delivery-store.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import { StaticTenantSource } from "./scheduler.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-23T12:00:00.000Z");

function dispatch(): NotificationDispatch {
  return {
    id: `disp_${"a".repeat(32)}`,
    tenantId: TENANT,
    templateId: "design_review.approved",
    templateVersion: "1.0.0",
    locale: "en",
    channel: "in_app",
    category: "transactional",
    priority: "high",
    audienceJson: { kind: "tenant_admins", tenantId: TENANT },
    variablesSha256: "b".repeat(64),
    correlationId: null,
    idempotencyKey: "k",
    status: "queued",
    queuedAt: NOW.toISOString(),
    startedAt: null,
    completedAt: null,
    recipientCount: 1,
    deliveredCount: 0,
    failedCount: 0,
    suppressedCount: 0,
    cancelledReason: null,
    requestedBy: null,
    requestingSystem: "operate-server.design-review",
  };
}

class FakeStore implements DeliveryStoreLike {
  claims: ClaimedDispatch[] = [];
  claimCalls = 0;
  readonly advances: DispatchAdvanceUpdate[] = [];
  async claimQueued(): Promise<readonly ClaimedDispatch[]> {
    this.claimCalls += 1;
    return this.claims;
  }
  async recordAttempt(_t: string, _r: string, _a: DeliveryAttempt): Promise<boolean> {
    return true;
  }
  async advance(_t: string, _r: string, update: DispatchAdvanceUpdate): Promise<boolean> {
    this.advances.push(update);
    return true;
  }
  async dueRetries(): Promise<readonly DueRetry[]> {
    return [];
  }
}

const resolver: RecipientResolverLike = {
  async resolveAudience() {
    return [
      { userId: USER, email: "a@x.test", displayName: null, primaryRole: "erp_admin", secondaryRoles: [] },
    ];
  },
  async preferencesFor() {
    return new Map();
  },
  async activeSuppressions() {
    return [];
  },
};

class FakeIntervalScheduler implements IntervalScheduler {
  handler: (() => void) | null = null;
  ms: number | null = null;
  cleared = 0;
  setInterval(handler: () => void, ms: number): IntervalHandle {
    this.handler = handler;
    this.ms = ms;
    return { id: 1 } as unknown as IntervalHandle;
  }
  clearInterval(): void {
    this.cleared += 1;
  }
  tick(): void {
    this.handler?.();
  }
}

function drainOptions(store: DeliveryStoreLike): DeliveryDrainOptions {
  return { store, resolver, senders: new SenderRegistry([new InAppSender()]), clock: () => NOW };
}

describe("delivery-scheduler", () => {
  it("drains immediately on start", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "r1", dispatch: dispatch() }];
    const timer = new FakeIntervalScheduler();
    const s = new DeliveryScheduler({
      drain: drainOptions(store),
      tenantSource: new StaticTenantSource([TENANT]),
      intervalMs: 5000,
      scheduler: timer,
    });

    s.start();
    await new Promise((r) => setImmediate(r));

    expect(store.claimCalls).toBe(1);
  });

  it("registers the interval with the configured period", () => {
    const timer = new FakeIntervalScheduler();
    new DeliveryScheduler({
      drain: drainOptions(new FakeStore()),
      tenantSource: new StaticTenantSource([TENANT]),
      intervalMs: 7500,
      scheduler: timer,
    }).start();

    expect(timer.ms).toBe(7500);
  });

  it("drains again on each tick", async () => {
    const store = new FakeStore();
    const timer = new FakeIntervalScheduler();
    const s = new DeliveryScheduler({
      drain: drainOptions(store),
      tenantSource: new StaticTenantSource([TENANT]),
      intervalMs: 1000,
      scheduler: timer,
    });

    s.start();
    await new Promise((r) => setImmediate(r));
    timer.tick();
    await new Promise((r) => setImmediate(r));

    expect(store.claimCalls).toBe(2);
  });

  it("is idempotent on repeated start", () => {
    const timer = new FakeIntervalScheduler();
    const s = new DeliveryScheduler({
      drain: drainOptions(new FakeStore()),
      tenantSource: new StaticTenantSource([TENANT]),
      intervalMs: 1000,
      scheduler: timer,
    });
    s.start();
    const first = timer.ms;
    s.start();
    expect(timer.ms).toBe(first);
  });

  it("clears the interval on stop and tolerates a second stop", () => {
    const timer = new FakeIntervalScheduler();
    const s = new DeliveryScheduler({
      drain: drainOptions(new FakeStore()),
      tenantSource: new StaticTenantSource([TENANT]),
      intervalMs: 1000,
      scheduler: timer,
    });
    s.start();
    s.stop();
    s.stop();
    expect(timer.cleared).toBe(1);
  });

  it("reports what it drained via onDrained", async () => {
    const store = new FakeStore();
    store.claims = [{ rowId: "r1", dispatch: dispatch() }];
    const seen: number[] = [];
    const s = new DeliveryScheduler({
      drain: drainOptions(store),
      tenantSource: new StaticTenantSource([TENANT]),
      intervalMs: 1000,
      scheduler: new FakeIntervalScheduler(),
      onDrained: (report) => seen.push(report.delivered),
    });

    await s.drainOnce();

    expect(seen).toEqual([1]);
  });

  it("routes a tenant-source failure to onError instead of throwing", async () => {
    const errors: unknown[] = [];
    const s = new DeliveryScheduler({
      drain: drainOptions(new FakeStore()),
      tenantSource: {
        activeTenantIds(): Promise<readonly string[]> {
          return Promise.reject(new Error("registry down"));
        },
      },
      intervalMs: 1000,
      scheduler: new FakeIntervalScheduler(),
      onError: (err) => errors.push(err),
    });

    const report = await s.drainOnce();

    expect(report).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("never overlaps two sweeps", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = new FakeStore();
    const slow: DeliveryStoreLike = {
      ...store,
      claimQueued: async (): Promise<readonly ClaimedDispatch[]> => {
        store.claimCalls += 1;
        await gate;
        return [];
      },
      recordAttempt: (t, r, a) => store.recordAttempt(t, r, a),
      advance: (t, r, u) => store.advance(t, r, u),
      dueRetries: () => store.dueRetries(),
    };
    const s = new DeliveryScheduler({
      drain: drainOptions(slow),
      tenantSource: new StaticTenantSource([TENANT]),
      intervalMs: 1000,
      scheduler: new FakeIntervalScheduler(),
    });

    const first = s.drainOnce();
    const second = await s.drainOnce();
    expect(second).toBeNull();
    expect(store.claimCalls).toBe(1);

    release?.();
    await first;

    // The lock releases, so a later sweep runs normally.
    await s.drainOnce();
    expect(store.claimCalls).toBe(2);
  });

  it("sweeps every tenant the source reports", async () => {
    const store = new FakeStore();
    const s = new DeliveryScheduler({
      drain: drainOptions(store),
      tenantSource: new StaticTenantSource([TENANT, TENANT, TENANT]),
      intervalMs: 1000,
      scheduler: new FakeIntervalScheduler(),
    });

    const report = await s.drainOnce();

    expect(report?.tenants).toBe(3);
    expect(store.claimCalls).toBe(3);
  });

  it("returns an empty report when no tenants are active", async () => {
    const s = new DeliveryScheduler({
      drain: drainOptions(new FakeStore()),
      tenantSource: new StaticTenantSource([]),
      intervalMs: 1000,
      scheduler: new FakeIntervalScheduler(),
    });

    const report = await s.drainOnce();

    expect(report?.tenants).toBe(0);
  });
});
