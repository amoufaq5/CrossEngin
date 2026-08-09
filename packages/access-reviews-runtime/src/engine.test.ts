import { describe, expect, it, vi } from "vitest";
import type {
  AccessReviewCampaign,
  AccessReviewItem,
} from "@crossengin/access-reviews";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import { generateItems } from "./item-generation.js";
import {
  AccessReviewRuntime,
  CampaignScheduler,
  type AccessReviewSource,
  type IntervalHandle,
  type IntervalScheduler,
} from "./engine.js";
import { UUID, makeCampaign, makeGrant, makePrincipal } from "./fixtures.js";

const BEFORE_DEADLINE = new Date("2026-01-10T00:00:00.000Z");
const AFTER_DEADLINE = new Date("2026-01-16T00:00:00.000Z");

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class ManualScheduler implements IntervalScheduler {
  handlers: (() => void)[] = [];
  cleared = 0;
  lastMs: number | null = null;
  setInterval(handler: () => void, ms: number): IntervalHandle {
    this.handlers.push(handler);
    this.lastMs = ms;
    return this.handlers.length - 1;
  }
  clearInterval(): void {
    this.cleared += 1;
  }
  fire(): void {
    for (const h of this.handlers) h();
  }
}

class MemorySource implements AccessReviewSource {
  constructor(
    private readonly campaignsList: readonly AccessReviewCampaign[],
    private readonly itemsByCampaign: Map<string, readonly AccessReviewItem[]> = new Map(),
  ) {}
  activeCampaigns(): readonly AccessReviewCampaign[] {
    return this.campaignsList;
  }
  itemsForCampaign(campaign: AccessReviewCampaign): readonly AccessReviewItem[] {
    return this.itemsByCampaign.get(campaign.id) ?? [];
  }
}

const runtimeAt = (now: Date, start = 0): AccessReviewRuntime =>
  new AccessReviewRuntime({
    systemActorUserId: UUID.system,
    clock: new FixedClock(now),
    ids: new CountingIdGenerator(start),
  });

describe("AccessReviewRuntime", () => {
  it("uses its own clock as the default now", () => {
    const rt = runtimeAt(AFTER_DEADLINE);
    expect(rt.dueCampaigns([makeCampaign()])).toHaveLength(1);
    expect(rt.dueCampaigns([makeCampaign()], BEFORE_DEADLINE)).toHaveLength(1);
    expect(rt.dueCampaigns([makeCampaign({ status: "draft" })])).toHaveLength(0);
  });

  it("starts a due campaign", () => {
    const started = runtimeAt(AFTER_DEADLINE).startCampaign(makeCampaign());
    expect(started.status).toBe("in_progress");
  });

  it("plans the next occurrence with a fresh id from its generator", () => {
    const rt = runtimeAt(AFTER_DEADLINE, 900);
    const completed = makeCampaign({
      status: "completed",
      completedAt: "2026-01-14T00:00:00.000Z",
    });
    const next = rt.planNextOccurrence(completed);
    expect(next?.id).toBe("arc_00000901");
    expect(next?.status).toBe("scheduled");
  });

  it("generates items and detects overdue ones", () => {
    const rt = runtimeAt(AFTER_DEADLINE);
    const items = rt.generateItems(makeCampaign(), [makeGrant()], [makePrincipal()], {
      assignReviewers: false,
    });
    expect(items).toHaveLength(1);
    expect(rt.overdueItems(items)).toHaveLength(1);
    expect(rt.overdueItems(items, BEFORE_DEADLINE)).toHaveLength(0);
  });

  it("plans auto-revocations with the runtime's system actor", () => {
    const rt = runtimeAt(AFTER_DEADLINE);
    const items = generateItems(
      makeCampaign(),
      [makeGrant()],
      [makePrincipal()],
      { ids: new CountingIdGenerator(), now: BEFORE_DEADLINE, assignReviewers: false },
    );
    const decisions = rt.planAutoRevocations(items, makeCampaign());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decidedByUserId).toBe(UUID.system);
  });

  it("reports overdue campaigns", () => {
    const rt = runtimeAt(AFTER_DEADLINE);
    const c = makeCampaign({ status: "in_progress" });
    expect(rt.overdueCampaigns([c])).toHaveLength(1);
    expect(rt.pastGraceCampaigns([c])).toHaveLength(0);
    expect(rt.pastGraceCampaigns([c], new Date("2026-01-17T00:00:00.000Z"))).toHaveLength(1);
  });
});

describe("CampaignScheduler end-to-end (exit criterion)", () => {
  it("identifies a due campaign, and plans auto-revocations for its overdue items", async () => {
    // Items were generated while the campaign was still open (before the deadline).
    const campaign = makeCampaign({ autoRevokePolicy: "auto_revoke_on_deadline" });
    const items = generateItems(
      campaign,
      [makeGrant({ grantId: "g1" }), makeGrant({ grantId: "g2" })],
      [makePrincipal()],
      { ids: new CountingIdGenerator(), now: BEFORE_DEADLINE, assignReviewers: false },
    );
    const source = new MemorySource(
      [campaign],
      new Map([[campaign.id, items]]),
    );
    const runtime = runtimeAt(AFTER_DEADLINE, 700);
    const scheduler = new ManualScheduler();
    const onTick = vi.fn();
    const cs = new CampaignScheduler({
      runtime,
      source,
      intervalMs: 60_000,
      scheduler,
      onTick,
    });

    const report = await cs.tickOnce();
    expect(report).not.toBeNull();
    // (a) due campaign started
    expect(report?.startedCampaigns).toHaveLength(1);
    expect(report?.startedCampaigns[0]?.status).toBe("in_progress");
    // (b) items in scope flagged overdue
    expect(report?.overdueItems).toHaveLength(2);
    // (c) auto-revocations planned for the un-attested items
    expect(report?.autoRevocations).toHaveLength(2);
    expect(report?.autoRevocations.every((d) => d.kind === "revoke")).toBe(true);
  });

  it("revokes for an already in_progress campaign without re-starting it", async () => {
    const campaign = makeCampaign({
      status: "in_progress",
      startedAt: "2026-01-01T00:00:00.000Z",
      autoRevokePolicy: "default_revoke",
    });
    const items = generateItems(
      campaign,
      [makeGrant()],
      [makePrincipal()],
      { ids: new CountingIdGenerator(), now: BEFORE_DEADLINE, assignReviewers: false },
    );
    const source = new MemorySource([campaign], new Map([[campaign.id, items]]));
    const cs = new CampaignScheduler({
      runtime: runtimeAt(AFTER_DEADLINE),
      source,
      intervalMs: 60_000,
      scheduler: new ManualScheduler(),
    });
    const report = await cs.tickOnce();
    expect(report?.startedCampaigns).toHaveLength(0);
    expect(report?.autoRevocations).toHaveLength(1);
  });

  it("produces no revocations under a keep policy", async () => {
    const campaign = makeCampaign({
      status: "in_progress",
      startedAt: "2026-01-01T00:00:00.000Z",
      autoRevokePolicy: "default_keep",
    });
    const items = generateItems(
      campaign,
      [makeGrant()],
      [makePrincipal()],
      { ids: new CountingIdGenerator(), now: BEFORE_DEADLINE, assignReviewers: false },
    );
    const cs = new CampaignScheduler({
      runtime: runtimeAt(AFTER_DEADLINE),
      source: new MemorySource([campaign], new Map([[campaign.id, items]])),
      intervalMs: 60_000,
    });
    const report = await cs.tickOnce();
    expect(report?.autoRevocations).toEqual([]);
    expect(report?.overdueItems).toHaveLength(1);
  });

  it("routes a source failure to onError and returns null", async () => {
    const failing: AccessReviewSource = {
      activeCampaigns() {
        throw new Error("db down");
      },
      itemsForCampaign() {
        return [];
      },
    };
    const onError = vi.fn();
    const onTick = vi.fn();
    const cs = new CampaignScheduler({
      runtime: runtimeAt(AFTER_DEADLINE),
      source: failing,
      intervalMs: 60_000,
      scheduler: new ManualScheduler(),
      onError,
      onTick,
    });
    const report = await cs.tickOnce();
    expect(report).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onTick).not.toHaveBeenCalled();
  });
});

describe("CampaignScheduler start/stop", () => {
  it("registers an unref-safe interval and fires an immediate tick", async () => {
    const scheduler = new ManualScheduler();
    const onTick = vi.fn();
    const cs = new CampaignScheduler({
      runtime: runtimeAt(AFTER_DEADLINE),
      source: new MemorySource([makeCampaign()]),
      intervalMs: 30_000,
      scheduler,
      onTick,
    });
    cs.start();
    await flush();
    expect(scheduler.handlers).toHaveLength(1);
    expect(scheduler.lastMs).toBe(30_000);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on repeated start", () => {
    const scheduler = new ManualScheduler();
    const cs = new CampaignScheduler({
      runtime: runtimeAt(AFTER_DEADLINE),
      source: new MemorySource([]),
      intervalMs: 30_000,
      scheduler,
    });
    cs.start();
    cs.start();
    expect(scheduler.handlers).toHaveLength(1);
  });

  it("clears the interval on stop", () => {
    const scheduler = new ManualScheduler();
    const cs = new CampaignScheduler({
      runtime: runtimeAt(AFTER_DEADLINE),
      source: new MemorySource([]),
      intervalMs: 30_000,
      scheduler,
    });
    cs.start();
    cs.stop();
    cs.stop();
    expect(scheduler.cleared).toBe(1);
  });

  it("fires subsequent ticks through the registered handler", async () => {
    const scheduler = new ManualScheduler();
    const onTick = vi.fn();
    const cs = new CampaignScheduler({
      runtime: runtimeAt(AFTER_DEADLINE),
      source: new MemorySource([makeCampaign({ status: "draft" })]),
      intervalMs: 30_000,
      scheduler,
      onTick,
    });
    cs.start();
    await flush();
    scheduler.fire();
    await flush();
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});
