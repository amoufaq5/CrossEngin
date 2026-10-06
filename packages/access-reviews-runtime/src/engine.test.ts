import { describe, expect, it } from "vitest";
import { CountingIdGenerator, FixedClock } from "./clock.js";
import { generateItems } from "./item-generation.js";
import { AccessReviewRuntime } from "./engine.js";
import { UUID, makeCampaign, makeGrant, makePrincipal } from "./fixtures.js";

const BEFORE_DEADLINE = new Date("2026-01-10T00:00:00.000Z");
const AFTER_DEADLINE = new Date("2026-01-16T00:00:00.000Z");

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

describe("AccessReviewRuntime: closing a campaign and sealing its pack", () => {
  const AT = new Date("2026-03-31T00:00:00.000Z");
  const runtime = () =>
    new AccessReviewRuntime({
      systemActorUserId: UUID.system,
      clock: new FixedClock(AT),
      ids: new CountingIdGenerator(),
    });
  const running = () =>
    makeCampaign({ status: "in_progress", startedAt: "2026-01-01T00:00:00.000Z" });

  it("completes a campaign through the engine's own clock", () => {
    const done = runtime().completeCampaign(running(), []);
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBe(AT.toISOString());
  });

  it("answers isCampaignCompletable in both directions", () => {
    const r = runtime();
    expect(r.isCampaignCompletable(running(), [])).toBe(true);
    expect(r.isCampaignCompletable(makeCampaign({ status: "draft" }), [])).toBe(false);
  });

  it("compiles and seals in one call, which is the only valid order", () => {
    const r = runtime();
    const done = r.completeCampaign(running(), []);
    const { evidence } = r.compileAndSealEvidence({
      tenantId: done.tenantId,
      framework: done.framework,
      periodStartAt: done.startedAt ?? done.scheduledStartAt,
      periodEndAt: done.completedAt ?? AT.toISOString(),
      campaigns: [done],
      items: [],
      decisions: [],
      createdBy: UUID.creator,
    });
    expect(evidence.status).toBe("sealed");
    expect(evidence.sealedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.sealedAt).toBe(AT.toISOString());
  });

  it("refuses to seal a pack over a campaign that is still running", () => {
    const r = runtime();
    expect(() =>
      r.compileAndSealEvidence({
        tenantId: UUID.tenant,
        framework: "soc2_type2",
        periodStartAt: "2026-01-01T00:00:00.000Z",
        periodEndAt: "2026-03-31T00:00:00.000Z",
        campaigns: [running()],
        items: [],
        decisions: [],
        createdBy: UUID.creator,
      }),
    ).toThrow(/campaign_unfinished/);
  });
});
