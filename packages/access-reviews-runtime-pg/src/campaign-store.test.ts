import { describe, expect, it } from "vitest";

import { PostgresAccessReviewCampaignStore } from "./campaign-store.js";
import { CampaignUuidResolver } from "./id-mapping.js";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";
import { FakeConn, UUIDS, makeCampaign } from "./test-fakes.js";
import type { CampaignRow as RecordCampaignRow } from "./records.js";

describe("PostgresAccessReviewCampaignStore.upsert", () => {
  it("runs inside tenant context, then INSERT ... ON CONFLICT (campaign_id)", async () => {
    const conn = new FakeConn();
    const store = new PostgresAccessReviewCampaignStore(conn);
    await store.upsert(makeCampaign({ status: "in_progress", startedAt: "2026-01-01T00:00:00.000Z" }));

    expect(conn.calls[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(conn.calls[0]?.params).toEqual([UUIDS.tenant]);
    const insert = conn.calls[1];
    expect(insert?.sql).toContain("INSERT INTO meta.access_review_campaigns");
    expect(insert?.sql).toContain("ON CONFLICT (campaign_id) DO UPDATE");
  });

  it("binds every column value as a parameter in order", async () => {
    const conn = new FakeConn();
    const store = new PostgresAccessReviewCampaignStore(conn);
    const campaign = makeCampaign({ status: "in_progress", startedAt: "2026-01-05T00:00:00.000Z" });
    await store.upsert(campaign);
    const params = conn.find("INSERT INTO meta.access_review_campaigns")?.params ?? [];
    expect(params[0]).toBe(campaign.id);
    expect(params[1]).toBe(campaign.tenantId);
    expect(params[6]).toBe("in_progress");
    expect(params[7]).toBe(JSON.stringify(campaign.scope));
    expect(params[8]).toBe(JSON.stringify(campaign.reviewerAssignment));
    expect(params[9]).toBe("auto_revoke_on_deadline");
    expect(params[17]).toBe("2026-01-05T00:00:00.000Z");
    expect(params[23]).toBe(0);
  });

  it("does not interpolate the campaign id into the SQL text", async () => {
    const conn = new FakeConn();
    const store = new PostgresAccessReviewCampaignStore(conn);
    await store.upsert(makeCampaign());
    const insert = conn.find("INSERT INTO meta.access_review_campaigns");
    expect(insert?.sql).not.toContain("arc_00000001");
  });

  it("registers the DB-assigned uuid in the shared resolver", async () => {
    const conn = new FakeConn();
    const resolver = new CampaignUuidResolver();
    const store = new PostgresAccessReviewCampaignStore(conn, resolver);
    const uuid = await store.upsert(makeCampaign());
    expect(uuid).toBe(UUIDS.campaignRow);
    expect(resolver.peek("arc_00000001")).toBe(UUIDS.campaignRow);
  });

  it("throws when the upsert returns no row", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresAccessReviewCampaignStore(conn);
    await expect(store.upsert(makeCampaign())).rejects.toThrow(/failed to upsert campaign/);
  });
});

const dbRow: RecordCampaignRow = {
  campaign_id: "arc_00000001",
  tenant_id: UUIDS.tenant,
  label: "Q",
  description: "d",
  frequency: "quarterly",
  framework: "soc2_type2",
  status: "scheduled",
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
  started_at: null,
  completed_at: null,
  archived_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  template_id: null,
  total_items: 0,
  decided_items: 0,
  auto_revoked_items: 0,
  exception_items: 0,
};

describe("PostgresAccessReviewCampaignStore reads", () => {
  it("getByCampaignId returns the mapped record", async () => {
    const conn = new FakeConn((sql) =>
      sql.includes("SELECT") ? { rows: [dbRow], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
    const store = new PostgresAccessReviewCampaignStore(conn);
    const c = await store.getByCampaignId(UUIDS.tenant, "arc_00000001");
    expect(c?.id).toBe("arc_00000001");
    expect(conn.find("WHERE campaign_id = $1")?.params).toEqual(["arc_00000001"]);
  });

  it("getByCampaignId returns null when absent", async () => {
    const conn = new FakeConn(() => ({ rows: [], rowCount: 0 }));
    const store = new PostgresAccessReviewCampaignStore(conn);
    expect(await store.getByCampaignId(UUIDS.tenant, "arc_00000009")).toBeNull();
  });

  it("listByTenant maps rows and orders by created_at", async () => {
    const conn = new FakeConn((sql) =>
      sql.includes("SELECT") ? { rows: [dbRow], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
    const store = new PostgresAccessReviewCampaignStore(conn);
    const list = await store.listByTenant(UUIDS.tenant);
    expect(list).toHaveLength(1);
    expect(conn.find("ORDER BY created_at")).toBeDefined();
  });
});
