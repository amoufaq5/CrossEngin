import {
  AccessReviewDecisionSchema,
  AccessReviewItemSchema,
  assignReviewer,
  type AccessReviewDecision,
  type AccessReviewItem,
} from "@crossengin/access-reviews";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import { PostgresAccessReviewItemStore } from "./item-store.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, skipped offline) for the
 * access-review persistence stores: seed a tenant + user + campaign, persist an in-review
 * item (the campaign UUID resolved by subquery + the flattened reviewer columns), read it
 * back RLS-scoped, then persist + read back a keep decision (item + campaign UUID FKs
 * resolved + reconstructed as business ids).
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

suite("access-review persistence (real Postgres)", () => {
  let conn: PgConnection;
  let itemStore: PostgresAccessReviewItemStore;
  let decisionStore: PostgresAccessReviewDecisionStore;
  let tenant: string;
  let user: string;
  let campaignBusinessId: string;
  let itemId: string;

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    const suffix = Math.random().toString(36).slice(2, 10);
    const t = await conn.query<{ id: string }>(
      `INSERT INTO meta.tenants (slug, name, schema_name) VALUES ($1,$1,$2) RETURNING id`,
      [`ar-${suffix}`, `tenant_ar_${suffix}`],
    );
    tenant = t.rows[0]!.id;
    user = randomUUID();
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [user, `ar-${suffix}@crossengin.test`]);
    campaignBusinessId = `arc_${suffix}`;
    itemId = `ari_${suffix}`;
    await conn.query(
      `INSERT INTO meta.access_review_campaigns (
         campaign_id, tenant_id, label, description, frequency, framework, status,
         scope, reviewer_assignment, auto_revoke_policy, scheduled_start_at, deadline_at, created_by
       ) VALUES ($1,$2,'Q3 review','quarterly access review','quarterly','soc2_type2','in_progress',
         '{}'::jsonb,'{}'::jsonb,'escalate_to_manager',$3,$4,$5)`,
      [campaignBusinessId, tenant, "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", user],
    );
    itemStore = new PostgresAccessReviewItemStore(conn);
    decisionStore = new PostgresAccessReviewDecisionStore(conn);
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  function buildItem(): AccessReviewItem {
    const pending = AccessReviewItemSchema.parse({
      id: itemId,
      campaignId: campaignBusinessId,
      tenantId: tenant,
      principalId: randomUUID(),
      principalType: "user",
      principalLabel: "alice",
      grantKind: "permission",
      grantId: "p1",
      grantLabel: "products.read",
      grantAttributes: {},
      grantedAt: "2026-01-01T00:00:00.000Z",
      grantedBy: null,
      lastUsedAt: "2026-06-01T00:00:00.000Z",
      riskLevel: "low",
      status: "pending",
      currentReviewer: null,
      createdAt: "2026-06-13T00:00:00.000Z",
      openedForReviewAt: null,
      decidedAt: null,
      decisionId: null,
      autoRevokedAt: null,
      autoRevokeReason: null,
      dueAt: "2026-07-01T00:00:00.000Z",
    });
    return assignReviewer(pending, user, "human_user", new Date("2026-06-14T00:00:00.000Z"));
  }

  it("persists an in-review item + reads it back", async () => {
    const item = buildItem();
    await itemStore.record(item);
    const back = await itemStore.get(tenant, itemId);
    expect(back).toMatchObject({ id: itemId, campaignId: campaignBusinessId, status: "in_review" });
    expect(back?.currentReviewer).toMatchObject({ reviewerUserId: user, reviewerKind: "human_user" });
    expect((await itemStore.listForCampaign(tenant, campaignBusinessId)).some((i) => i.id === itemId)).toBe(true);
  });

  it("persists a keep decision + reads it back through the FK joins", async () => {
    const decisionId = `ard_${Math.random().toString(36).slice(2, 10)}`;
    const decision: AccessReviewDecision = AccessReviewDecisionSchema.parse({
      id: decisionId,
      itemId,
      campaignId: campaignBusinessId,
      tenantId: tenant,
      decidedByUserId: user,
      decidedAt: "2026-06-15T00:00:00.000Z",
      kind: "keep",
      reason: "role_appropriate",
      timeBoundExtendUntil: null,
      modifiedGrantAttributes: null,
      attestation: {
        kind: "click_through_acknowledgement",
        attestedAt: "2026-06-15T00:00:00.000Z",
        attestedByUserId: user,
        signatureSha256: null,
        signingKeyFingerprint: null,
        coAttestingUserId: null,
        coAttestedAt: null,
        ipAddress: "203.0.113.1",
        userAgent: "test-agent",
      },
      supersedesDecisionId: null,
      relatedExceptionId: null,
      appliedAt: null,
      applicationFailedAt: null,
      applicationFailureReason: null,
    });
    await decisionStore.record(decision);
    const back = await decisionStore.get(tenant, decisionId);
    expect(back).toMatchObject({ id: decisionId, itemId, campaignId: campaignBusinessId, kind: "keep" });
    expect(back?.attestation.attestedByUserId).toBe(user);
    expect((await decisionStore.listForItem(tenant, itemId)).some((d) => d.id === decisionId)).toBe(true);
  });
});
