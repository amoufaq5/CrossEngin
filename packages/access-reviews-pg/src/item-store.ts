import type { PgConnection } from "@crossengin/kernel-pg";
import type { AccessReviewItem } from "@crossengin/access-reviews";

import { rowToReviewItem } from "./records.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

export interface ItemStoreOptions {
  readonly schema?: string;
}

/**
 * The persisted access-review item ledger (Phase 3 P8.5) over the tenant-scoped
 * `meta.access_review_items` table. Every op runs inside a tenant context
 * (`SELECT set_config('app.current_tenant_id', $1, true)` in a transaction) so the
 * **RLS policy** — not just `WHERE tenant_id` — confines reads + writes to the caller's
 * tenant; the tenant id rides as a bound parameter, never interpolated.
 *
 * The table keys rows on a UUID `id` (FKs point at it) but the contract item is keyed on
 * the `ari_…` business id, and `campaign_id` is a UUID FK while the contract carries the
 * `arc_…` campaign business id. `record` upserts on `item_id` and resolves the campaign
 * UUID inline (`(SELECT id FROM …_campaigns WHERE campaign_id = $N)`); the read side joins
 * the campaign back so `rowToReviewItem` reconstructs the contract object.
 */
export class PostgresAccessReviewItemStore {
  private readonly conn: PgConnection;
  private readonly items: string;
  private readonly campaigns: string;
  private readonly select: string;

  constructor(conn: PgConnection, opts: ItemStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.items = `${schema}.access_review_items`;
    this.campaigns = `${schema}.access_review_campaigns`;
    this.select = `SELECT i.*, c.campaign_id AS campaign_business_id
       FROM ${this.items} i
       JOIN ${this.campaigns} c ON c.id = i.campaign_id`;
  }

  private async withTenant<T>(tenantId: string, fn: (tx: PgConnection) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      return fn(tx);
    });
  }

  async record(item: AccessReviewItem): Promise<void> {
    const reviewer = item.currentReviewer;
    await this.withTenant(item.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${this.items} (
           item_id, campaign_id, tenant_id, principal_id, principal_type, principal_label,
           grant_kind, grant_id, grant_label, grant_attributes, granted_at, granted_by,
           last_used_at, risk_level, status, current_reviewer_user_id, current_reviewer_kind,
           reviewer_assigned_at, reminder_count, last_reminder_at, escalation_level, created_at,
           opened_for_review_at, decided_at, decision_id, auto_revoked_at, auto_revoke_reason,
           due_at, notes
         ) VALUES (
           $1, (SELECT id FROM ${this.campaigns} WHERE campaign_id = $2), $3, $4, $5, $6,
           $7, $8, $9, $10::jsonb, $11, $12,
           $13, $14, $15, $16, $17,
           $18, $19, $20, $21, $22,
           $23, $24, $25, $26, $27,
           $28, $29
         )
         ON CONFLICT (item_id) DO UPDATE SET
           grant_attributes = EXCLUDED.grant_attributes,
           granted_by = EXCLUDED.granted_by,
           last_used_at = EXCLUDED.last_used_at,
           risk_level = EXCLUDED.risk_level,
           status = EXCLUDED.status,
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
           notes = EXCLUDED.notes`,
        [
          item.id,
          item.campaignId,
          item.tenantId,
          item.principalId,
          item.principalType,
          item.principalLabel,
          item.grantKind,
          item.grantId,
          item.grantLabel,
          JSON.stringify(item.grantAttributes ?? {}),
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
      ),
    );
  }

  async get(tenantId: string, itemId: string): Promise<AccessReviewItem | null> {
    return this.withTenant(tenantId, async (tx) => {
      const res = await tx.query(`${this.select} WHERE i.item_id = $1`, [itemId]);
      const row = res.rows[0];
      return row === undefined ? null : rowToReviewItem(row as Record<string, unknown>);
    });
  }

  async listForCampaign(
    tenantId: string,
    campaignId: string,
    query: { readonly limit?: number } = {},
  ): Promise<readonly AccessReviewItem[]> {
    return this.withTenant(tenantId, async (tx) => {
      const limit = query.limit !== undefined && query.limit > 0 ? Math.min(query.limit, 5000) : 1000;
      const res = await tx.query(
        `${this.select} WHERE c.campaign_id = $1 ORDER BY i.created_at ASC, i.item_id ASC LIMIT $2`,
        [campaignId, limit],
      );
      return res.rows.map((r) => rowToReviewItem(r as Record<string, unknown>));
    });
  }
}
