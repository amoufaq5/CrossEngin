import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import { PostgresAccessReviewItemStore } from "./item-store.js";
import { rowToDecision, rowToReviewItem } from "./records.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-0000000000a1";
const REVIEWER = "00000000-0000-4000-8000-0000000000c1";

interface Captured {
  conn: PgConnection;
  calls: { sql: string; params: readonly unknown[] }[];
  rows: Record<string, unknown>[];
}

/** A fake connection whose `transaction` runs the fn against a recording tx. */
function capture(rows: Record<string, unknown>[] = []): Captured {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const cap: Captured = { calls, rows, conn: undefined as unknown as PgConnection };
  const query = (async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return { rows: sql.includes("set_config") ? [] : cap.rows, rowCount: cap.rows.length };
  }) as PgConnection["query"];
  const tx: PgConnection = {
    query,
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  cap.conn = {
    query: vi.fn() as PgConnection["query"],
    transaction: (async (fn: (t: PgConnection) => Promise<unknown>) => fn(tx)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return cap;
}

function itemRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: "ari_aaaa0001",
    campaign_business_id: "arc_camp0001",
    tenant_id: TENANT,
    principal_id: PRINCIPAL,
    principal_type: "user",
    principal_label: "alice",
    grant_kind: "permission",
    grant_id: "p1",
    grant_label: "products.read",
    grant_attributes: {},
    granted_at: new Date("2026-01-01T00:00:00.000Z"),
    granted_by: null,
    last_used_at: new Date("2026-06-01T00:00:00.000Z"),
    risk_level: "low",
    status: "in_review",
    current_reviewer_user_id: REVIEWER,
    current_reviewer_kind: "human_user",
    reviewer_assigned_at: new Date("2026-06-14T00:00:00.000Z"),
    reminder_count: 2,
    last_reminder_at: new Date("2026-06-15T00:00:00.000Z"),
    escalation_level: 1,
    created_at: new Date("2026-06-13T00:00:00.000Z"),
    opened_for_review_at: new Date("2026-06-14T00:00:00.000Z"),
    decided_at: null,
    decision_id: null,
    auto_revoked_at: null,
    auto_revoke_reason: null,
    due_at: new Date("2026-07-01T00:00:00.000Z"),
    notes: null,
    ...over,
  };
}

function decisionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_id: "ard_dddd0001",
    item_business_id: "ari_aaaa0001",
    campaign_business_id: "arc_camp0001",
    tenant_id: TENANT,
    decided_by_user_id: REVIEWER,
    decided_at: new Date("2026-06-15T00:00:00.000Z"),
    kind: "keep",
    reason: "role_appropriate",
    comment: null,
    time_bound_extend_until: null,
    modified_grant_attributes: null,
    attestation_kind: "click_through_acknowledgement",
    attestation_signature_sha256: null,
    attestation_signing_key_fingerprint: null,
    co_attesting_user_id: null,
    co_attested_at: null,
    ip_address: "203.0.113.1",
    user_agent: "test-agent",
    supersedes_decision_id: null,
    related_exception_id: null,
    applied_at: null,
    application_failed_at: null,
    application_failure_reason: null,
    ...over,
  };
}

describe("row mappers", () => {
  it("reconstructs an item, collapsing the flattened reviewer columns", () => {
    const it_ = rowToReviewItem(itemRow());
    expect(it_).toMatchObject({ id: "ari_aaaa0001", campaignId: "arc_camp0001", status: "in_review" });
    expect(it_.currentReviewer).toMatchObject({ reviewerUserId: REVIEWER, reminderCount: 2, escalationLevel: 1 });
    expect(it_.grantedBy).toBeNull();
  });

  it("reads back a null reviewer when the reviewer columns are null", () => {
    const it_ = rowToReviewItem(itemRow({ status: "pending", current_reviewer_user_id: null, current_reviewer_kind: null, reviewer_assigned_at: null, opened_for_review_at: null, reminder_count: 0, last_reminder_at: null, escalation_level: 0 }));
    expect(it_.currentReviewer).toBeNull();
  });

  it("reconstructs a decision, deriving attestedAt/attestedByUserId from the decision", () => {
    const d = rowToDecision(decisionRow());
    expect(d).toMatchObject({ id: "ard_dddd0001", itemId: "ari_aaaa0001", campaignId: "arc_camp0001", kind: "keep" });
    expect(d.attestation.attestedByUserId).toBe(REVIEWER);
    expect(d.attestation.attestedAt).toBe("2026-06-15T00:00:00.000Z");
  });
});

describe("PostgresAccessReviewItemStore", () => {
  it("record upserts on item_id, resolving the campaign UUID by subquery", async () => {
    const cap = capture();
    await new PostgresAccessReviewItemStore(cap.conn).record(rowToReviewItem(itemRow()));
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO meta.access_review_items"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("ON CONFLICT (item_id) DO UPDATE");
    expect(insert!.sql).toContain("SELECT id FROM meta.access_review_campaigns WHERE campaign_id = $2");
    expect(cap.calls[0]!.sql).toContain("set_config");
  });

  it("get joins the campaign back / returns null", async () => {
    expect(await new PostgresAccessReviewItemStore(capture().conn).get(TENANT, "ari_aaaa0001")).toBeNull();
    const hit = await new PostgresAccessReviewItemStore(capture([itemRow()]).conn).get(TENANT, "ari_aaaa0001");
    expect(hit?.id).toBe("ari_aaaa0001");
  });

  it("listForCampaign filters on the campaign business id", async () => {
    const cap = capture([itemRow()]);
    const rows = await new PostgresAccessReviewItemStore(cap.conn).listForCampaign(TENANT, "arc_camp0001");
    expect(rows).toHaveLength(1);
    expect(cap.calls.some((c) => c.sql.includes("WHERE c.campaign_id = $1"))).toBe(true);
  });

  it("rejects an invalid schema name + a malformed tenant id", async () => {
    expect(() => new PostgresAccessReviewItemStore(capture().conn, { schema: "x; drop" })).toThrow(/invalid schema/);
    await expect(new PostgresAccessReviewItemStore(capture().conn).get("not-a-uuid", "ari_aaaa0001")).rejects.toThrow(/invalid tenant/);
  });
});

describe("PostgresAccessReviewDecisionStore", () => {
  it("record upserts on decision_id, resolving item + campaign UUIDs by subquery", async () => {
    const cap = capture();
    await new PostgresAccessReviewDecisionStore(cap.conn).record(rowToDecision(decisionRow()));
    const insert = cap.calls.find((c) => c.sql.includes("INSERT INTO meta.access_review_decisions"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("ON CONFLICT (decision_id) DO UPDATE");
    expect(insert!.sql).toContain("SELECT id FROM meta.access_review_items WHERE item_id = $2");
    expect(insert!.sql).toContain("SELECT id FROM meta.access_review_campaigns WHERE campaign_id = $3");
  });

  it("get / listForItem reconstruct through the join", async () => {
    expect(await new PostgresAccessReviewDecisionStore(capture().conn).get(TENANT, "ard_dddd0001")).toBeNull();
    const list = await new PostgresAccessReviewDecisionStore(capture([decisionRow()]).conn).listForItem(TENANT, "ari_aaaa0001");
    expect(list[0]?.id).toBe("ard_dddd0001");
  });
});
