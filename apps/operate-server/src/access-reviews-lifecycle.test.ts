import { describe, expect, it } from "vitest";
import type {
  AccessReviewCampaign,
  AccessReviewDecision,
  AccessReviewItem,
} from "@crossengin/access-reviews";
import type { PersistentAccessReviewRuntime } from "@crossengin/access-reviews-runtime-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

import {
  buildAccessReviewsLifecycle,
  parseAccessReviewsConfig,
} from "./access-reviews-lifecycle.js";

const baseCampaign: AccessReviewCampaign = {
  id: "arc_q22026adm",
  tenantId: "11111111-1111-1111-1111-111111111111",
  label: "Q2 2026 Admin Access Review",
  description: "Quarterly review of all admin role grants",
  frequency: "quarterly",
  framework: "soc2_type2",
  status: "scheduled",
  scope: { kind: "all_users_with_role", roleSlug: "admin", includeInherited: true },
  reviewerAssignment: {
    policy: "principal_manager",
    fallbackReviewerUserId: "22222222-2222-2222-2222-222222222222",
    reviewerPoolUserIds: [],
    specificReviewerUserId: null,
    roleBasedReviewerRoleSlug: null,
    escalationChainUserIds: [],
    escalationTimeoutHours: 72,
  },
  autoRevokePolicy: "auto_revoke_on_deadline",
  relatedIncidentId: null,
  scheduledStartAt: "2026-04-01T00:00:00.000Z",
  deadlineAt: "2026-04-30T23:59:59.000Z",
  gracePeriodHours: 24,
  remediationDeadlineAt: "2026-05-15T00:00:00.000Z",
  createdAt: "2026-03-15T10:00:00.000Z",
  createdBy: "55555555-5555-5555-5555-555555555555",
  startedAt: null,
  completedAt: null,
  archivedAt: null,
  cancelledAt: null,
  cancelledReason: null,
  templateId: null,
  totalItems: 50,
  decidedItems: 0,
  autoRevokedItems: 0,
  exceptionItems: 0,
};

const SYSTEM_ACTOR = "99999999-9999-9999-9999-999999999999";
const NOW = new Date("2026-04-15T00:00:00.000Z");
const dummyConn = null as unknown as PgConnection;

interface StubCalls {
  started: string[];
  generatedFor: string[];
  listedFor: string[];
  revocationsFor: string[];
  closedFor: string[];
  ensuredFor: string[];
}

const noCalls = (): StubCalls => ({
  started: [],
  generatedFor: [],
  listedFor: [],
  revocationsFor: [],
  closedFor: [],
  ensuredFor: [],
});

function stubRuntime(
  calls: StubCalls,
  opts: {
    getByCampaignId?: AccessReviewCampaign | null;
    generated?: readonly AccessReviewItem[];
    listItems?: readonly AccessReviewItem[];
    decisions?: readonly AccessReviewDecision[];
    /** Whether the stub's items count as settled, i.e. whether the close is allowed to fire. */
    completable?: boolean;
    closed?: { campaign: AccessReviewCampaign; evidence: { id: string } | null };
    ensured?: { outcome: "sealed" | "already_sealed"; evidence: { id: string } };
  } = {},
): PersistentAccessReviewRuntime {
  const stub = {
    campaignStore: {
      getByCampaignId: async () => opts.getByCampaignId ?? null,
    },
    itemStore: {
      listByCampaign: async (_tenant: string, campaignId: string) => {
        calls.listedFor.push(campaignId);
        return opts.listItems ?? [];
      },
    },
    startCampaign: async (campaign: AccessReviewCampaign) => {
      calls.started.push(campaign.id);
      return { ...campaign, status: "in_progress" as const };
    },
    generateItems: async (campaign: AccessReviewCampaign) => {
      calls.generatedFor.push(campaign.id);
      return opts.generated ?? [];
    },
    planAutoRevocations: async (
      _items: readonly AccessReviewItem[],
      campaign: AccessReviewCampaign,
    ) => {
      calls.revocationsFor.push(campaign.id);
      return opts.decisions ?? [];
    },
    runtime: {
      isCampaignCompletable: () => opts.completable ?? false,
    },
    closeCampaign: async (input: { campaign: AccessReviewCampaign }) => {
      calls.closedFor.push(input.campaign.id);
      return (
        opts.closed ?? {
          campaign: { ...input.campaign, status: "completed" as const },
          evidence: { id: "arv_sealed0001" },
        }
      );
    },
    ensureSealedEvidenceForCampaign: async (input: { campaign: AccessReviewCampaign }) => {
      calls.ensuredFor.push(input.campaign.id);
      return opts.ensured ?? { outcome: "already_sealed", evidence: { id: "arv_sealed0001" } };
    },
  };
  return stub as unknown as PersistentAccessReviewRuntime;
}

describe("parseAccessReviewsConfig", () => {
  it("applies interval + assignReviewers defaults and empty grants/principals", () => {
    const config = parseAccessReviewsConfig({
      systemActorUserId: SYSTEM_ACTOR,
      campaigns: [baseCampaign],
    });
    expect(config.intervalMs).toBe(3_600_000);
    expect(config.assignReviewers).toBe(true);
    expect(config.grants).toEqual([]);
    expect(config.principals).toEqual([]);
  });

  it("rejects an empty campaigns array", () => {
    expect(() =>
      parseAccessReviewsConfig({ systemActorUserId: SYSTEM_ACTOR, campaigns: [] }),
    ).toThrow();
  });

  it("rejects a non-uuid systemActorUserId", () => {
    expect(() =>
      parseAccessReviewsConfig({ systemActorUserId: "nope", campaigns: [baseCampaign] }),
    ).toThrow();
  });
});

describe("AccessReviewCampaignScheduler tick", () => {
  const config = parseAccessReviewsConfig({
    systemActorUserId: SYSTEM_ACTOR,
    campaigns: [baseCampaign],
  });

  it("starts a due campaign and generates its items", async () => {
    const calls: StubCalls = noCalls();
    const fakeItem = {} as AccessReviewItem;
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: stubRuntime(calls, { generated: [fakeItem, fakeItem] }),
      clock: () => NOW,
    });
    const report = await lifecycle.scheduler.tickOnce();
    expect(report?.startedCampaigns).toEqual(["arc_q22026adm"]);
    expect(report?.generatedItems).toBe(2);
    expect(calls.started).toEqual(["arc_q22026adm"]);
    expect(calls.generatedFor).toEqual(["arc_q22026adm"]);
    expect(calls.revocationsFor).toEqual([]);
  });

  it("plans auto-revocations for an already-in-progress campaign", async () => {
    const calls: StubCalls = noCalls();
    const decision = { id: "ard_revoke01" } as AccessReviewDecision;
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: stubRuntime(calls, {
        getByCampaignId: { ...baseCampaign, status: "in_progress" },
        listItems: [{} as AccessReviewItem],
        decisions: [decision],
      }),
      clock: () => NOW,
    });
    const report = await lifecycle.scheduler.tickOnce();
    expect(report?.startedCampaigns).toEqual([]);
    expect(report?.autoRevocations).toEqual(["ard_revoke01"]);
    expect(calls.started).toEqual([]);
    // Twice: the second read is after the auto-revocations, which resolve items the first list is
    // stale about, and the close may only fire when nothing is outstanding.
    expect(calls.listedFor).toEqual(["arc_q22026adm", "arc_q22026adm"]);
    expect(calls.revocationsFor).toEqual(["arc_q22026adm"]);
  });

  it("does nothing for a not-yet-due scheduled campaign", async () => {
    const calls: StubCalls = noCalls();
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: stubRuntime(calls),
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const report = await lifecycle.scheduler.tickOnce();
    expect(report?.startedCampaigns).toEqual([]);
    expect(report?.autoRevocations).toEqual([]);
    expect(calls.started).toEqual([]);
    expect(calls.listedFor).toEqual([]);
  });

  it("sources grants from an injected grantSource instead of the config", async () => {
    const calls: StubCalls = noCalls();
    let grantsSeen = -1;
    const runtime = {
      campaignStore: { getByCampaignId: async () => null },
      startCampaign: async (c: AccessReviewCampaign) => {
        calls.started.push(c.id);
        return { ...c, status: "in_progress" as const };
      },
      generateItems: async (
        _c: AccessReviewCampaign,
        grants: readonly unknown[],
      ) => {
        grantsSeen = grants.length;
        return [] as readonly AccessReviewItem[];
      },
    } as unknown as import("@crossengin/access-reviews-runtime-pg").PersistentAccessReviewRuntime;
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime,
      clock: () => NOW,
      grantSource: {
        grantsForCampaign: async () => ({
          grants: [{} as never, {} as never, {} as never],
          principals: [],
        }),
      },
    });
    await lifecycle.scheduler.tickOnce();
    // Config declares zero grants; the source supplied three.
    expect(grantsSeen).toBe(3);
  });

  it("routes a tick error to onError instead of throwing", async () => {
    let captured: unknown = null;
    const throwingRuntime = {
      campaignStore: {
        getByCampaignId: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as PersistentAccessReviewRuntime;
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: throwingRuntime,
      clock: () => NOW,
      onError: (err) => {
        captured = err;
      },
    });
    const report = await lifecycle.scheduler.tickOnce();
    expect(report).toBeNull();
    expect((captured as Error).message).toBe("boom");
  });
});

describe("AccessReviewCampaignScheduler: closing a campaign and sealing its pack", () => {
  const config = parseAccessReviewsConfig({
    systemActorUserId: SYSTEM_ACTOR,
    campaigns: [baseCampaign],
  });

  it("closes an in-progress campaign once nothing is outstanding", async () => {
    const calls = noCalls();
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: stubRuntime(calls, {
        getByCampaignId: { ...baseCampaign, status: "in_progress" },
        completable: true,
      }),
      clock: () => NOW,
    });
    const report = await lifecycle.scheduler.tickOnce();
    expect(calls.closedFor).toEqual(["arc_q22026adm"]);
    expect(report?.closedCampaigns).toEqual(["arc_q22026adm"]);
    expect(report?.sealedEvidence).toEqual(["arv_sealed0001"]);
  });

  it("does not close while an item is unresolved", async () => {
    const calls = noCalls();
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: stubRuntime(calls, {
        getByCampaignId: { ...baseCampaign, status: "in_progress" },
        completable: false,
      }),
      clock: () => NOW,
    });
    const report = await lifecycle.scheduler.tickOnce();
    expect(calls.closedFor).toEqual([]);
    expect(report?.closedCampaigns).toEqual([]);
  });

  it("re-reads the items after planning auto-revocations, which resolve some of them", async () => {
    const calls = noCalls();
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: stubRuntime(calls, {
        getByCampaignId: { ...baseCampaign, status: "in_progress" },
        completable: true,
      }),
      clock: () => NOW,
    });
    await lifecycle.scheduler.tickOnce();
    expect(calls.listedFor).toEqual(["arc_q22026adm", "arc_q22026adm"]);
  });

  it("retries an unsealed pack on a campaign that is already completed", async () => {
    const calls = noCalls();
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: stubRuntime(calls, {
        getByCampaignId: {
          ...baseCampaign,
          status: "completed",
          completedAt: "2026-05-01T00:00:00.000Z",
        },
        ensured: { outcome: "sealed", evidence: { id: "arv_retried0001" } },
      }),
      clock: () => NOW,
    });
    const report = await lifecycle.scheduler.tickOnce();
    expect(calls.ensuredFor).toEqual(["arc_q22026adm"]);
    expect(report?.sealedEvidence).toEqual(["arv_retried0001"]);
  });

  it("reports nothing newly sealed when the pack was already sealed", async () => {
    const calls = noCalls();
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: stubRuntime(calls, {
        getByCampaignId: {
          ...baseCampaign,
          status: "completed",
          completedAt: "2026-05-01T00:00:00.000Z",
        },
      }),
      clock: () => NOW,
    });
    const report = await lifecycle.scheduler.tickOnce();
    expect(calls.ensuredFor).toEqual(["arc_q22026adm"]);
    expect(report?.sealedEvidence).toEqual([]);
  });

  it("closeCompletedCampaigns: false leaves both paths alone", async () => {
    const calls = noCalls();
    const lifecycle = buildAccessReviewsLifecycle(
      dummyConn,
      parseAccessReviewsConfig({
        systemActorUserId: SYSTEM_ACTOR,
        campaigns: [baseCampaign],
        closeCompletedCampaigns: false,
      }),
      {
        runtime: stubRuntime(calls, {
          getByCampaignId: { ...baseCampaign, status: "in_progress" },
          completable: true,
        }),
        clock: () => NOW,
      },
    );
    await lifecycle.scheduler.tickOnce();
    expect(calls.closedFor).toEqual([]);
    expect(calls.ensuredFor).toEqual([]);
  });

  it("defaults closeCompletedCampaigns on, because off is the broken status quo", () => {
    const parsed = parseAccessReviewsConfig({
      systemActorUserId: SYSTEM_ACTOR,
      campaigns: [baseCampaign],
    });
    expect(parsed.closeCompletedCampaigns).toBe(true);
    expect(parsed.evidenceStorageUriPrefix).toBeUndefined();
  });

  it("reports an evidence failure through onEvidenceError rather than failing the tick", async () => {
    const calls = noCalls();
    const errors: unknown[] = [];
    const runtime = stubRuntime(calls, {
      getByCampaignId: {
        ...baseCampaign,
        status: "completed",
        completedAt: "2026-05-01T00:00:00.000Z",
      },
    }) as unknown as {
      ensureSealedEvidenceForCampaign: () => Promise<never>;
    };
    runtime.ensureSealedEvidenceForCampaign = () =>
      Promise.reject(new Error("evidence store unreachable"));
    const lifecycle = buildAccessReviewsLifecycle(dummyConn, config, {
      runtime: runtime as unknown as PersistentAccessReviewRuntime,
      clock: () => NOW,
      onEvidenceError: (e) => errors.push(e),
    });
    const report = await lifecycle.scheduler.tickOnce();
    expect(report).not.toBeNull();
    expect(report?.sealedEvidence).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
