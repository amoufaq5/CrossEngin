import type { AccessReviewItem } from "@crossengin/access-reviews";
import type { PgConnection } from "@crossengin/kernel-pg";

import { CampaignUuidResolver, ItemUuidResolver } from "./id-mapping.js";
import { rowToItem, type ItemRow } from "./records.js";
import { withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "access_review_items";

const SELECT_JOINED = `
  SELECT
    i.item_id, i.tenant_id, c.campaign_id AS campaign_natural_id,
    i.principal_id, i.principal_type, i.principal_label,
    i.grant_kind, i.grant_id, i.grant_label, i.grant_attributes,
    i.granted_at, i.granted_by, i.last_used_at, i.risk_level, i.status,
    i.current_reviewer_user_id, i.current_reviewer_kind, i.reviewer_assigned_at,
    i.reminder_count, i.last_reminder_at, i.escalation_level, i.created_at,
    i.opened_for_review_at, i.decided_at, i.decision_id, i.auto_revoked_at,
    i.auto_revoke_reason, i.due_at, i.notes
  FROM ${SCHEMA}.${TABLE} i
  JOIN ${SCHEMA}.access_review_campaigns c ON c.id = i.campaign_id`;

export class PostgresAccessReviewItemStore {
  constructor(
    private readonly conn: PgConnection,
    private readonly campaignResolver: CampaignUuidResolver = new CampaignUuidResolver(),
    private readonly itemResolver: ItemUuidResolver = new ItemUuidResolver(),
  ) {}

  async upsert(item: AccessReviewItem): Promise<string> {
    return withTenantContext(this.conn, item.tenantId, async (tx) => {
      const campaignUuid = await this.campaignResolver.requireResolve(tx, item.campaignId);
      const reviewer = item.currentReviewer;
      const result = await tx.query<{ id: string }>(
        `INSERT INTO ${SCHEMA}.${TABLE} (
           item_id, campaign_id, tenant_id, principal_id, principal_type, principal_label,
           grant_kind, grant_id, grant_label, grant_attributes, granted_at, granted_by,
           last_used_at, risk_level, status, current_reviewer_user_id, current_reviewer_kind,
           reviewer_assigned_at, reminder_count, last_reminder_at, escalation_level,
           created_at, opened_for_review_at, decided_at, decision_id, auto_revoked_at,
           auto_revoke_reason, due_at, notes
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10::jsonb, $11, $12,
           $13, $14, $15, $16, $17,
           $18, $19, $20, $21,
           $22, $23, $24, $25, $26,
           $27, $28, $29
         )
         ON CONFLICT (item_id) DO UPDATE SET
           status = EXCLUDED.status,
           grant_attributes = EXCLUDED.grant_attributes,
           last_used_at = EXCLUDED.last_used_at,
           risk_level = EXCLUDED.risk_level,
           current_reviewer_user_id = EXCLUDED.current_reviewer_user_id,
           current_reviewer_kind = EXCLUDED.current_reviewer_kind,
           reviewer_assigned_at = EXCLUDED.reviewer_assigned_at,
           reminder_count = EXCLUDED.reminder_count,
           last_reminder_at = EXCLUDED.last_reminder_at,
           escalation_level = EXCLUDED.escalation_level,
           opened_for_review_at = EXCLUDED.opened_for_review_at,
           decided_at = EXCLUDED.decided_at,
           decision_id = EXCLUDED.decision_id,
           auto_revoked_at = EXCLUDED.auto_revoked_at,
           auto_revoke_reason = EXCLUDED.auto_revoke_reason,
           due_at = EXCLUDED.due_at,
           notes = EXCLUDED.notes
         RETURNING id`,
        [
          item.id,
          campaignUuid,
          item.tenantId,
          item.principalId,
          item.principalType,
          item.principalLabel,
          item.grantKind,
          item.grantId,
          item.grantLabel,
          JSON.stringify(item.grantAttributes),
          item.grantedAt,
          item.grantedBy,
          item.lastUsedAt,
          item.riskLevel,
          item.status,
          reviewer?.reviewerUserId ?? null,
          reviewer?.reviewerKind ?? null,
          reviewer?.assignedAt ?? null,
          reviewer?.reminderCount ?? 0,
          reviewer?.lastReminderAt ?? null,
          reviewer?.escalationLevel ?? 0,
          item.createdAt,
          item.openedForReviewAt,
          item.decidedAt,
          item.decisionId,
          item.autoRevokedAt,
          item.autoRevokeReason,
          item.dueAt,
          item.notes ?? null,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`failed to upsert item ${item.id}`);
      }
      this.itemResolver.register(item.id, row.id);
      return row.id;
    });
  }

  async listByCampaign(
    tenantId: string,
    campaignId: string,
  ): Promise<readonly AccessReviewItem[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<ItemRow>(
        `${SELECT_JOINED} WHERE c.campaign_id = $1 ORDER BY i.created_at ASC, i.item_id ASC`,
        [campaignId],
      );
      return result.rows.map(rowToItem);
    });
  }
}
