import { describe, expect, it } from "vitest";

import { PostgresAccessReviewCampaignStore } from "./campaign-store.js";
import { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import { PostgresAccessReviewItemStore } from "./item-store.js";
import {
  ACCESS_REVIEW_DRIFT_ISSUE_KINDS,
  AccessReviewReplayer,
  verifyCampaignRowShape,
  verifyDecisionRowShape,
  verifyItemRowShape,
} from "./replayer.js";
import { FakeConn, UUIDS, makeCampaign, makeDecision, makeItem } from "./test-fakes.js";

describe("verifyCampaignRowShape", () => {
  it("passes a well-formed campaign", () => {
    expect(verifyCampaignRowShape(makeCampaign())).toHaveLength(0);
  });

  it("flags a counter overflow", () => {
    const forced = { ...makeCampaign(), totalItems: 2, decidedItems: 2, autoRevokedItems: 1 };
    const issues = verifyCampaignRowShape(forced);
    expect(issues.map((i) => i.kind)).toContain("counter_overflow");
  });

  it("flags a cancelled campaign missing a reason", () => {
    const c = makeCampaign({ status: "scheduled" });
    const forced = { ...c, status: "cancelled" as const, cancelledReason: null };
    expect(verifyCampaignRowShape(forced).map((i) => i.kind)).toContain(
      "cancelled_without_reason",
    );
  });

  it("flags a completed campaign with open items", () => {
    const c = makeCampaign();
    const forced = {
      ...c,
      status: "completed" as const,
      completedAt: "2026-02-01T00:00:00.000Z",
      totalItems: 5,
      decidedItems: 1,
    };
    expect(verifyCampaignRowShape(forced).map((i) => i.kind)).toContain(
      "completed_with_open_items",
    );
  });
});

describe("verifyItemRowShape", () => {
  it("passes a well-formed item", () => {
    expect(verifyItemRowShape(makeItem())).toHaveLength(0);
  });

  it("flags a decided item without a decisionId", () => {
    const forced = { ...makeItem(), status: "decided" as const, decisionId: null };
    expect(verifyItemRowShape(forced).map((i) => i.kind)).toContain(
      "decided_without_decision_id",
    );
  });

  it("flags an item whose campaignId disagrees with its campaign", () => {
    const item = makeItem();
    const campaign = makeCampaign({ id: "arc_00000099" });
    expect(verifyItemRowShape(item, campaign).map((i) => i.kind)).toContain(
      "item_campaign_mismatch",
    );
  });
});

describe("verifyDecisionRowShape", () => {
  it("passes a decision consistent with its item", () => {
    expect(verifyDecisionRowShape(makeDecision(), makeItem())).toHaveLength(0);
  });

  it("flags a decision whose itemId disagrees", () => {
    const decision = makeDecision();
    const item = makeItem({ id: "ari_00000099" });
    expect(verifyDecisionRowShape(decision, item).map((i) => i.kind)).toContain(
      "decision_item_mismatch",
    );
  });

  it("flags a decision whose campaignId disagrees with its item's", () => {
    const decision = makeDecision({ campaignId: "arc_00000099" });
    expect(verifyDecisionRowShape(decision, makeItem()).map((i) => i.kind)).toContain(
      "decision_campaign_mismatch",
    );
  });
});

/**
 * The kind that could not fire.
 *
 * The check ANDed in `!canTransitionItem("escalated", "auto_revoked")`, which depends on nothing in
 * the decision and is the constant `false`, so the finding was unreachable in every deployment. The
 * premise it was reaching for is real but is not answerable from a decision alone, because
 * `default_keep` makes a no-response default legitimately a *keep*.
 */
describe("auto_revoke_kind_mismatch is reachable and policy-aware", () => {
  const AUTO_DEFAULT = { reason: "no_response_auto_default" } as const;

  it("is not asked at all without a campaign, rather than answered with a constant", () => {
    const decision = makeDecision({ ...AUTO_DEFAULT, kind: "keep" });
    expect(verifyDecisionRowShape(decision, makeItem()).map((i) => i.kind)).not.toContain(
      "auto_revoke_kind_mismatch",
    );
  });

  it("flags a keep under auto_revoke_on_deadline", () => {
    const decision = makeDecision({ ...AUTO_DEFAULT, kind: "keep" });
    const campaign = makeCampaign({ autoRevokePolicy: "auto_revoke_on_deadline" });
    const issues = verifyDecisionRowShape(decision, makeItem(), campaign);
    expect(issues.map((i) => i.kind)).toContain("auto_revoke_kind_mismatch");
    expect(issues[0]?.detail).toContain("auto_revoke_on_deadline");
    expect(issues[0]?.detail).toContain("'revoke'");
  });

  it("flags a keep under default_revoke", () => {
    const decision = makeDecision({ ...AUTO_DEFAULT, kind: "keep" });
    const campaign = makeCampaign({ autoRevokePolicy: "default_revoke" });
    expect(
      verifyDecisionRowShape(decision, makeItem(), campaign).map((i) => i.kind),
    ).toContain("auto_revoke_kind_mismatch");
  });

  it("accepts a revoke under auto_revoke_on_deadline", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "auto_revoke_on_deadline" });
    const decision = makeDecision({ ...AUTO_DEFAULT, kind: "revoke" });
    expect(verifyDecisionRowShape(decision, makeItem(), campaign)).toHaveLength(0);
  });

  it("accepts a keep under default_keep, which the old rule would have called drift", () => {
    // The reason "no_response_auto_default implies revoke" is false as a standalone rule.
    const campaign = makeCampaign({ autoRevokePolicy: "default_keep" });
    const decision = makeDecision({ ...AUTO_DEFAULT, kind: "keep" });
    expect(verifyDecisionRowShape(decision, makeItem(), campaign)).toHaveLength(0);
  });

  it("flags a revoke under default_keep", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "default_keep" });
    const decision = makeDecision({ ...AUTO_DEFAULT, kind: "revoke" });
    const issues = verifyDecisionRowShape(decision, makeItem(), campaign);
    expect(issues.map((i) => i.kind)).toContain("auto_revoke_kind_mismatch");
    expect(issues[0]?.detail).toContain("'keep'");
  });

  it("asks nothing under escalate_to_manager, where a manager decides either way", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "escalate_to_manager" });
    for (const kind of ["keep", "revoke"] as const) {
      const decision = makeDecision({ ...AUTO_DEFAULT, kind });
      expect(verifyDecisionRowShape(decision, makeItem(), campaign)).toHaveLength(0);
    }
  });

  it("asks nothing of a decision with a different reason", () => {
    const campaign = makeCampaign({ autoRevokePolicy: "auto_revoke_on_deadline" });
    const decision = makeDecision({ reason: "role_appropriate", kind: "keep" });
    expect(verifyDecisionRowShape(decision, makeItem(), campaign)).toHaveLength(0);
  });
});

describe("ACCESS_REVIEW_DRIFT_ISSUE_KINDS", () => {
  it("names every kind, as a value a test can assert against", () => {
    expect([...ACCESS_REVIEW_DRIFT_ISSUE_KINDS]).toEqual([
      "unreadable_campaign_row",
      "unreadable_item_row",
      "unreadable_decision_row",
      "counter_overflow",
      "completed_without_timestamp",
      "completed_with_open_items",
      "cancelled_without_reason",
      "decided_without_decision_id",
      "auto_revoked_without_reason",
      "item_campaign_mismatch",
      "decision_item_mismatch",
      "decision_campaign_mismatch",
      "auto_revoke_kind_mismatch",
    ]);
  });

  it("has no duplicate member", () => {
    expect(new Set(ACCESS_REVIEW_DRIFT_ISSUE_KINDS).size).toBe(
      ACCESS_REVIEW_DRIFT_ISSUE_KINDS.length,
    );
  });
});

function connFor(
  campaignRows: unknown[],
  itemRows: unknown[],
  decisionRows: unknown[],
): FakeConn {
  return new FakeConn((sql, params) => {
    if (sql.includes("FROM meta.access_review_items i")) {
      return { rows: itemRows as Record<string, unknown>[], rowCount: itemRows.length };
    }
    if (sql.includes("FROM meta.access_review_decisions d")) {
      return { rows: decisionRows as Record<string, unknown>[], rowCount: decisionRows.length };
    }
    if (sql.includes("FROM meta.access_review_campaigns")) {
      // `getByCampaignId` is a point lookup and `listByTenant` is a sweep, and this fake used to
      // answer both with every campaign row — so a sweep over two campaigns handed the point lookup
      // the *first* one whatever id it asked for. Harmless while every fixture was well-formed and
      // not once one of them is deliberately unreadable, which is the shape of fake defect this
      // repo keeps finding (`fakeCertificationPg` ignoring `tenant_id` entirely).
      const rows = sql.includes("c.campaign_id = $1")
        ? campaignRows.filter(
            (row) => (row as Record<string, unknown>)["campaign_id"] === params?.[0],
          )
        : campaignRows;
      return { rows: rows as Record<string, unknown>[], rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

function replayerOn(conn: FakeConn): AccessReviewReplayer {
  return new AccessReviewReplayer({
    campaignStore: new PostgresAccessReviewCampaignStore(conn),
    itemStore: new PostgresAccessReviewItemStore(conn),
    decisionStore: new PostgresAccessReviewDecisionStore(conn),
  });
}

function stores(campaignRows: unknown[], itemRows: unknown[], decisionRows: unknown[]): AccessReviewReplayer {
  const conn = new FakeConn((sql) => {
    if (sql.includes("FROM meta.access_review_items i")) {
      return { rows: itemRows as Record<string, unknown>[], rowCount: itemRows.length };
    }
    if (sql.includes("FROM meta.access_review_decisions d")) {
      return { rows: decisionRows as Record<string, unknown>[], rowCount: decisionRows.length };
    }
    if (sql.includes("FROM meta.access_review_campaigns")) {
      return { rows: campaignRows as Record<string, unknown>[], rowCount: campaignRows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return new AccessReviewReplayer({
    campaignStore: new PostgresAccessReviewCampaignStore(conn),
    itemStore: new PostgresAccessReviewItemStore(conn),
    decisionStore: new PostgresAccessReviewDecisionStore(conn),
  });
}

const campaignDbRow = {
  campaign_id: "arc_00000001",
  tenant_id: UUIDS.tenant,
  label: "Q",
  description: "d",
  frequency: "quarterly",
  framework: "soc2_type2",
  status: "in_progress",
  scope: { kind: "all_users_with_role", roleSlug: "member", includeInherited: true },
  reviewer_assignment: {
    policy: "principal_manager",
    fallbackReviewerUserId: UUIDS.reviewer,
    reviewerPoolUserIds: [],
    specificReviewerUserId: null,
    roleBasedReviewerRoleSlug: null,
    escalationChainUserIds: [],
    escalationTimeoutHours: 72,
  },
  auto_revoke_policy: "auto_revoke_on_deadline",
  related_incident_id: null,
  scheduled_start_at: "2026-01-01T00:00:00.000Z",
  deadline_at: "2026-01-15T00:00:00.000Z",
  grace_period_hours: 24,
  remediation_deadline_at: null,
  created_at: "2025-12-01T00:00:00.000Z",
  created_by: UUIDS.creator,
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  archived_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  template_id: null,
  total_items: 1,
  decided_items: 0,
  auto_revoked_items: 0,
  exception_items: 0,
};

const itemDbRow = {
  item_id: "ari_00000001",
  tenant_id: UUIDS.tenant,
  campaign_natural_id: "arc_00000001",
  principal_id: UUIDS.principal,
  principal_type: "user",
  principal_label: "alice",
  grant_kind: "role",
  grant_id: "grant-1",
  grant_label: "admin",
  grant_attributes: {},
  granted_at: "2024-01-01T00:00:00.000Z",
  granted_by: UUIDS.creator,
  last_used_at: null,
  risk_level: "high",
  status: "pending",
  current_reviewer_user_id: null,
  current_reviewer_kind: null,
  reviewer_assigned_at: null,
  reminder_count: 0,
  last_reminder_at: null,
  escalation_level: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  opened_for_review_at: null,
  decided_at: null,
  decision_id: null,
  auto_revoked_at: null,
  auto_revoke_reason: null,
  due_at: "2026-01-10T00:00:00.000Z",
  notes: null,
};

/** One stored decision row, in the spelling `SELECT_JOINED` aliases its columns to. */
const decisionDbRow = {
  decision_id: "ard_00000001",
  item_natural_id: "ari_00000001",
  campaign_natural_id: "arc_00000001",
  tenant_id: UUIDS.tenant,
  decided_by_user_id: UUIDS.system,
  decided_at: "2026-02-01T00:00:00.000Z",
  kind: "revoke",
  reason: "no_response_auto_default",
  comment: null,
  time_bound_extend_until: null,
  modified_grant_attributes: null,
  attestation_kind: "click_through_acknowledgement",
  attestation_phrase: null,
  attestation_signature_sha256: null,
  attestation_signing_key_fingerprint: null,
  co_attesting_user_id: null,
  co_attested_at: null,
  ip_address: "127.0.0.1",
  user_agent: "crossengin-access-reviews-runtime",
  supersedes_decision_id: null,
  related_exception_id: null,
  applied_at: null,
  application_failed_at: null,
  application_failure_reason: null,
};

describe("AccessReviewReplayer", () => {
  it("returns no issues for a clean campaign graph", async () => {
    const replayer = stores([campaignDbRow], [itemDbRow], []);
    const issues = await replayer.verifyCampaign(UUIDS.tenant, "arc_00000001");
    expect(issues).toHaveLength(0);
  });

  it("returns empty when the campaign is absent", async () => {
    const replayer = stores([], [], []);
    expect(await replayer.verifyCampaign(UUIDS.tenant, "arc_00000001")).toHaveLength(0);
  });

  it("summarize counts campaigns, items, decisions", async () => {
    const replayer = stores([campaignDbRow], [itemDbRow], []);
    const summary = await replayer.summarize(UUIDS.tenant, "arc_00000001");
    expect(summary).toEqual({ campaigns: 1, items: 1, decisions: 0, issues: 0 });
  });

  it("replayCampaign carries the scope it was asked for into its own report", async () => {
    const replay = await replayerOn(
      connFor([campaignDbRow], [itemDbRow], []),
    ).replayCampaign(UUIDS.tenant, "arc_00000001");
    expect(replay).toMatchObject({
      tenantId: UUIDS.tenant,
      campaignId: "arc_00000001",
      found: true,
      items: 1,
      decisions: 0,
    });
  });

  it("reports found: false for an absent campaign rather than an empty clean one", async () => {
    // "No such campaign" and "a clean campaign" are different answers and a sweep must not read
    // the first as the second.
    const replay = await replayerOn(connFor([], [], [])).replayCampaign(
      UUIDS.tenant,
      "arc_00000001",
    );
    expect(replay.found).toBe(false);
    expect(replay.issues).toEqual([]);
  });

  it("replayTenant walks every campaign the tenant owns", async () => {
    const second = { ...campaignDbRow, campaign_id: "arc_00000002" };
    const tenantReplay = await replayerOn(
      connFor([campaignDbRow, second], [itemDbRow], []),
    ).replayTenant(UUIDS.tenant);
    expect(tenantReplay.replays).toHaveLength(2);
    expect(tenantReplay.replays.every((r) => r.tenantId === UUIDS.tenant)).toBe(true);
    expect(tenantReplay.unreadableCampaigns).toEqual([]);
  });

  it("replayTenant reports an unreadable campaign and still sweeps the others", async () => {
    // The whole increment, in one assertion. `rowToCampaign` throws on a NULL required timestamp,
    // and that throw used to escape `listByTenant`'s `.map` — so one such row ended the entire
    // tenant's sweep and the pass reported nothing at all, which reads as a clean bill of health.
    const broken = {
      ...campaignDbRow,
      campaign_id: "arc_0000bad1",
      scheduled_start_at: null,
    };
    const tenantReplay = await replayerOn(
      connFor([broken, campaignDbRow], [itemDbRow], []),
    ).replayTenant(UUIDS.tenant);
    expect(tenantReplay.replays.map((r) => r.campaignId)).toEqual(["arc_00000001"]);
    expect(tenantReplay.unreadableCampaigns).toEqual([
      {
        kind: "unreadable_campaign_row",
        id: "arc_0000bad1",
        detail: "row is missing required timestamp: scheduled_start_at",
      },
    ]);
  });

  it("names a refused campaign by its business key and discloses nothing else of it", async () => {
    // `detail` names the column and nothing the row held. Asserted over the rendered finding, so a
    // field added later cannot smuggle a value in: an operator scoping a manual fix by a value that
    // may be the reason the row was refused is the hazard.
    const broken = {
      ...campaignDbRow,
      campaign_id: "arc_0000bad2",
      label: "Payroll admins — Q1 offboarding",
      created_by: UUIDS.creator,
      created_at: null,
    };
    const tenantReplay = await replayerOn(connFor([broken], [], [])).replayTenant(UUIDS.tenant);
    const rendered = JSON.stringify(tenantReplay.unreadableCampaigns);
    expect(rendered).toContain("arc_0000bad2");
    expect(rendered).not.toContain("Payroll admins");
    expect(rendered).not.toContain(UUIDS.creator);
  });

  it("admits it cannot name a campaign whose own id column is what is wrong", async () => {
    const tenantReplay = await replayerOn(
      connFor([{ ...campaignDbRow, campaign_id: null, created_at: null }], [], []),
    ).replayTenant(UUIDS.tenant);
    expect(tenantReplay.unreadableCampaigns[0]?.id).toBe("<unidentified>");
  });

  it("reports an unreadable item and keeps the campaign's other findings", async () => {
    const broken = { ...itemDbRow, item_id: "ari_0000bad1", granted_at: null };
    const flagged = { ...itemDbRow, item_id: "ari_00000002", status: "decided", decision_id: null };
    const replay = await replayerOn(
      connFor([campaignDbRow], [broken, flagged], []),
    ).replayCampaign(UUIDS.tenant, "arc_00000001");
    expect(replay.issues.map((i) => i.kind)).toEqual([
      "unreadable_item_row",
      "decided_without_decision_id",
    ]);
    expect(replay.items).toBe(1);
  });

  it("reports an unreadable decision through the same campaign replay", async () => {
    const broken = { ...decisionDbRow, decision_id: "ard_0000bad1", decided_at: null };
    const replay = await replayerOn(
      connFor([campaignDbRow], [itemDbRow], [broken]),
    ).replayCampaign(UUIDS.tenant, "arc_00000001");
    expect(replay.issues.map((i) => i.kind)).toEqual(["unreadable_decision_row"]);
    expect(replay.issues[0]?.id).toBe("ard_0000bad1");
    expect(replay.decisions).toBe(0);
  });

  it("stops claiming a complete graph once any row is withheld", async () => {
    // `complete: false` is what makes every cross-row finding an inference: a decision whose item
    // was the unreadable row reads as having no item at all, so the question is not asked.
    const clean = await replayerOn(connFor([campaignDbRow], [itemDbRow], [])).replayCampaign(
      UUIDS.tenant,
      "arc_00000001",
    );
    expect(clean.complete).toBe(true);
    const withheld = await replayerOn(
      connFor([campaignDbRow], [{ ...itemDbRow, granted_at: null }], []),
    ).replayCampaign(UUIDS.tenant, "arc_00000001");
    expect(withheld.complete).toBe(false);
  });

  it("an absent campaign is complete, because there was nothing it failed to read", async () => {
    const replay = await replayerOn(connFor([], [], [])).replayCampaign(
      UUIDS.tenant,
      "arc_00000001",
    );
    expect(replay).toMatchObject({ found: false, complete: true });
  });

  it("the plain listByCampaign still refuses, because a scheduler counts from it", async () => {
    // The other of the two legitimate answers. `PersistingAccessReviewRuntime` and
    // `AccessReviewCampaignLifecycle` decide whether a campaign is finished by counting these rows,
    // so a short list under-counts and completes a campaign with an item unaccounted for.
    const conn = connFor([campaignDbRow], [{ ...itemDbRow, granted_at: null }], []);
    const store = new PostgresAccessReviewItemStore(conn);
    await expect(store.listByCampaign(UUIDS.tenant, "arc_00000001")).rejects.toThrow(
      /could not be represented/,
    );
  });

  it("the refusal names every unreadable row, where the mapper's throw named the first", async () => {
    const conn = connFor(
      [campaignDbRow],
      [
        { ...itemDbRow, item_id: "ari_0000bad1", granted_at: null },
        { ...itemDbRow, item_id: "ari_0000bad2", created_at: null },
      ],
      [],
    );
    const store = new PostgresAccessReviewItemStore(conn);
    const err = await store
      .listByCampaign(UUIDS.tenant, "arc_00000001")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("ari_0000bad1");
    expect((err as Error).message).toContain("ari_0000bad2");
  });

  it("summarize reads each table once, not twice", async () => {
    // It used to read all three and then call verifyCampaign, which read all three again — so one
    // reported summary was assembled from two separate reads of a table that can change between.
    const conn = connFor([campaignDbRow], [itemDbRow], []);
    await replayerOn(conn).summarize(UUIDS.tenant, "arc_00000001");
    const reads = conn.calls.filter((c) => c.sql.includes("SELECT"));
    expect(reads.filter((c) => c.sql.includes("FROM meta.access_review_items i"))).toHaveLength(1);
    expect(
      reads.filter((c) => c.sql.includes("FROM meta.access_review_decisions d")),
    ).toHaveLength(1);
  });
});

/**
 * The predicate beside RLS, which these reads had none of.
 *
 * All three tables are `tenant_id NOT NULL` with the isolation policy as their only arm, so as a
 * non-owner they were correct — and as the owner, who bypasses RLS, the `tenantId` argument bought
 * nothing but the GUC. `campaign_id` is table-wide unique, so one tenant's id reached another
 * tenant's whole campaign graph and the replayer reported its drift under the wrong name.
 */
describe("every read names its scope", () => {
  const CAMPAIGN_READ = "FROM meta.access_review_campaigns c";

  it("getByCampaignId pins the campaign's tenant and binds it", async () => {
    const conn = connFor([campaignDbRow], [], []);
    await new PostgresAccessReviewCampaignStore(conn).getByCampaignId(
      UUIDS.tenant,
      "arc_00000001",
    );
    const read = conn.find(CAMPAIGN_READ);
    expect(read?.sql).toContain("c.tenant_id = $2");
    expect(read?.params).toEqual(["arc_00000001", UUIDS.tenant]);
  });

  it("listByTenant has a WHERE clause at all", async () => {
    const conn = connFor([campaignDbRow], [], []);
    await new PostgresAccessReviewCampaignStore(conn).listByTenant(UUIDS.tenant);
    const read = conn.find(CAMPAIGN_READ);
    expect(read?.sql).toContain("c.tenant_id = $1");
    expect(read?.params).toEqual([UUIDS.tenant]);
  });

  it("the item read pins both sides of its join", async () => {
    // RLS applies each table's own policy to each table in a join, so one side is narrower than
    // what a non-owner sees in neither direction and wider in one.
    const conn = connFor([], [itemDbRow], []);
    await new PostgresAccessReviewItemStore(conn).listByCampaign(UUIDS.tenant, "arc_00000001");
    const read = conn.find("FROM meta.access_review_items i");
    expect(read?.sql).toContain("i.tenant_id = $2");
    expect(read?.sql).toContain("c.tenant_id = $2");
    expect(read?.params).toEqual(["arc_00000001", UUIDS.tenant]);
  });

  it("the decision read pins all three of its joined tables", async () => {
    const conn = connFor([], [], []);
    await new PostgresAccessReviewDecisionStore(conn).listByCampaign(
      UUIDS.tenant,
      "arc_00000001",
    );
    const read = conn.find("FROM meta.access_review_decisions d");
    expect(read?.sql).toContain("d.tenant_id = $2");
    expect(read?.sql).toContain("i.tenant_id = $2");
    expect(read?.sql).toContain("c.tenant_id = $2");
    expect(read?.params).toEqual(["arc_00000001", UUIDS.tenant]);
  });

  it("still sets the tenant context, because the predicate is beside RLS and not instead of it", async () => {
    const conn = connFor([campaignDbRow], [], []);
    await new PostgresAccessReviewCampaignStore(conn).listByTenant(UUIDS.tenant);
    expect(conn.find("set_config('app.current_tenant_id'")?.params).toEqual([UUIDS.tenant]);
  });

  it("refuses a tenant id that is not shaped like one before it reaches SQL", async () => {
    const conn = connFor([], [], []);
    await expect(
      new PostgresAccessReviewCampaignStore(conn).listByTenant("'; DROP TABLE meta.incidents; --"),
    ).rejects.toThrow(/invalid tenantId/);
    expect(conn.calls).toHaveLength(0);
  });
});
