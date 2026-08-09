import type { AccessReviewCampaign } from "@crossengin/access-reviews";
import type { PgConnection } from "@crossengin/kernel-pg";

import { CampaignUuidResolver } from "./id-mapping.js";
import { rowToCampaign, type CampaignRow } from "./records.js";
import { withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "access_review_campaigns";

const SELECT_COLUMNS = `
  campaign_id, tenant_id, label, description, frequency, framework, status,
  scope, reviewer_assignment, auto_revoke_policy, related_incident_id,
  scheduled_start_at, deadline_at, grace_period_hours, remediation_deadline_at,
  created_at, created_by, started_at, completed_at, archived_at, cancelled_at,
  cancelled_reason, template_id, total_items, decided_items, auto_revoked_items,
  exception_items`;

export class PostgresAccessReviewCampaignStore {
  constructor(
    private readonly conn: PgConnection,
    private readonly resolver: CampaignUuidResolver = new CampaignUuidResolver(),
  ) {}

  async upsert(campaign: AccessReviewCampaign): Promise<string> {
    return withTenantContext(this.conn, campaign.tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO ${SCHEMA}.${TABLE} (
           campaign_id, tenant_id, label, description, frequency, framework, status,
           scope, reviewer_assignment, auto_revoke_policy, related_incident_id,
           scheduled_start_at, deadline_at, grace_period_hours, remediation_deadline_at,
           created_at, created_by, started_at, completed_at, archived_at, cancelled_at,
           cancelled_reason, template_id, total_items, decided_items, auto_revoked_items,
           exception_items
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9::jsonb, $10, $11,
           $12, $13, $14, $15,
           $16, $17, $18, $19, $20, $21,
           $22, $23, $24, $25, $26,
           $27
         )
         ON CONFLICT (campaign_id) DO UPDATE SET
           label = EXCLUDED.label,
           description = EXCLUDED.description,
           frequency = EXCLUDED.frequency,
           framework = EXCLUDED.framework,
           status = EXCLUDED.status,
           scope = EXCLUDED.scope,
           reviewer_assignment = EXCLUDED.reviewer_assignment,
           auto_revoke_policy = EXCLUDED.auto_revoke_policy,
           related_incident_id = EXCLUDED.related_incident_id,
           scheduled_start_at = EXCLUDED.scheduled_start_at,
           deadline_at = EXCLUDED.deadline_at,
           grace_period_hours = EXCLUDED.grace_period_hours,
           remediation_deadline_at = EXCLUDED.remediation_deadline_at,
           started_at = EXCLUDED.started_at,
           completed_at = EXCLUDED.completed_at,
           archived_at = EXCLUDED.archived_at,
           cancelled_at = EXCLUDED.cancelled_at,
           cancelled_reason = EXCLUDED.cancelled_reason,
           template_id = EXCLUDED.template_id,
           total_items = EXCLUDED.total_items,
           decided_items = EXCLUDED.decided_items,
           auto_revoked_items = EXCLUDED.auto_revoked_items,
           exception_items = EXCLUDED.exception_items
         RETURNING id`,
        [
          campaign.id,
          campaign.tenantId,
          campaign.label,
          campaign.description,
          campaign.frequency,
          campaign.framework,
          campaign.status,
          JSON.stringify(campaign.scope),
          JSON.stringify(campaign.reviewerAssignment),
          campaign.autoRevokePolicy,
          campaign.relatedIncidentId,
          campaign.scheduledStartAt,
          campaign.deadlineAt,
          campaign.gracePeriodHours,
          campaign.remediationDeadlineAt,
          campaign.createdAt,
          campaign.createdBy,
          campaign.startedAt,
          campaign.completedAt,
          campaign.archivedAt,
          campaign.cancelledAt,
          campaign.cancelledReason,
          campaign.templateId,
          campaign.totalItems,
          campaign.decidedItems,
          campaign.autoRevokedItems,
          campaign.exceptionItems,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`failed to upsert campaign ${campaign.id}`);
      }
      this.resolver.register(campaign.id, row.id);
      return row.id;
    });
  }

  async getByCampaignId(
    tenantId: string,
    campaignId: string,
  ): Promise<AccessReviewCampaign | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<CampaignRow>(
        `SELECT ${SELECT_COLUMNS} FROM ${SCHEMA}.${TABLE} WHERE campaign_id = $1 LIMIT 1`,
        [campaignId],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToCampaign(row);
    });
  }

  async listByTenant(tenantId: string): Promise<readonly AccessReviewCampaign[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<CampaignRow>(
        `SELECT ${SELECT_COLUMNS} FROM ${SCHEMA}.${TABLE} ORDER BY created_at ASC, campaign_id ASC`,
      );
      return result.rows.map(rowToCampaign);
    });
  }
}
