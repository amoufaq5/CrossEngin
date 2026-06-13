import type { PgConnection } from "@crossengin/kernel-pg";
import type { AccessReviewDecision } from "@crossengin/access-reviews";

import { rowToDecision } from "./records.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

export interface DecisionStoreOptions {
  readonly schema?: string;
}

/**
 * The persisted access-review decision ledger (Phase 3 P8.5) over the tenant-scoped
 * `meta.access_review_decisions` table — the durable record of the "attest a grant" step
 * the runtime's `recordItemDecision` produces. Every op runs inside a tenant context
 * (`set_config('app.current_tenant_id', …)`) so RLS confines reads + writes to the caller's
 * tenant.
 *
 * The table keys rows on a UUID `id` and stores `item_id` / `campaign_id` as UUID FKs;
 * `record` upserts on the `ard_…` business `decision_id` and resolves the item + campaign
 * UUIDs inline (`(SELECT id FROM …_items WHERE item_id = $N)`), and the read side joins them
 * back so `rowToDecision` reconstructs the `ari_…` / `arc_…` business ids. The flattened
 * attestation columns carry no `attestedAt` / `attestedByUserId` (derived from
 * `decided_at` / `decided_by_user_id`, which the contract pins equal).
 */
export class PostgresAccessReviewDecisionStore {
  private readonly conn: PgConnection;
  private readonly decisions: string;
  private readonly items: string;
  private readonly campaigns: string;
  private readonly select: string;

  constructor(conn: PgConnection, opts: DecisionStoreOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.decisions = `${schema}.access_review_decisions`;
    this.items = `${schema}.access_review_items`;
    this.campaigns = `${schema}.access_review_campaigns`;
    this.select = `SELECT d.*, it.item_id AS item_business_id, c.campaign_id AS campaign_business_id
       FROM ${this.decisions} d
       JOIN ${this.items} it ON it.id = d.item_id
       JOIN ${this.campaigns} c ON c.id = d.campaign_id`;
  }

  private async withTenant<T>(tenantId: string, fn: (tx: PgConnection) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      return fn(tx);
    });
  }

  async record(decision: AccessReviewDecision): Promise<void> {
    const a = decision.attestation;
    await this.withTenant(decision.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${this.decisions} (
           decision_id, item_id, campaign_id, tenant_id, decided_by_user_id, decided_at,
           kind, reason, comment, time_bound_extend_until, modified_grant_attributes,
           attestation_kind, attestation_signature_sha256, attestation_signing_key_fingerprint,
           co_attesting_user_id, co_attested_at, ip_address, user_agent,
           supersedes_decision_id, related_exception_id, applied_at, application_failed_at,
           application_failure_reason
         ) VALUES (
           $1, (SELECT id FROM ${this.items} WHERE item_id = $2),
           (SELECT id FROM ${this.campaigns} WHERE campaign_id = $3), $4, $5, $6,
           $7, $8, $9, $10, $11::jsonb,
           $12, $13, $14,
           $15, $16, $17, $18,
           $19, $20, $21, $22,
           $23
         )
         ON CONFLICT (decision_id) DO UPDATE SET
           applied_at = EXCLUDED.applied_at,
           application_failed_at = EXCLUDED.application_failed_at,
           application_failure_reason = EXCLUDED.application_failure_reason,
           supersedes_decision_id = EXCLUDED.supersedes_decision_id,
           related_exception_id = EXCLUDED.related_exception_id`,
        [
          decision.id,
          decision.itemId,
          decision.campaignId,
          decision.tenantId,
          decision.decidedByUserId,
          decision.decidedAt,
          decision.kind,
          decision.reason,
          decision.comment ?? null,
          decision.timeBoundExtendUntil,
          decision.modifiedGrantAttributes === null ? null : JSON.stringify(decision.modifiedGrantAttributes),
          a.kind,
          a.signatureSha256,
          a.signingKeyFingerprint,
          a.coAttestingUserId,
          a.coAttestedAt,
          a.ipAddress,
          a.userAgent,
          decision.supersedesDecisionId,
          decision.relatedExceptionId,
          decision.appliedAt,
          decision.applicationFailedAt,
          decision.applicationFailureReason,
        ],
      ),
    );
  }

  async get(tenantId: string, decisionId: string): Promise<AccessReviewDecision | null> {
    return this.withTenant(tenantId, async (tx) => {
      const res = await tx.query(`${this.select} WHERE d.decision_id = $1`, [decisionId]);
      const row = res.rows[0];
      return row === undefined ? null : rowToDecision(row as Record<string, unknown>);
    });
  }

  async listForItem(
    tenantId: string,
    itemId: string,
    query: { readonly limit?: number } = {},
  ): Promise<readonly AccessReviewDecision[]> {
    return this.withTenant(tenantId, async (tx) => {
      const limit = query.limit !== undefined && query.limit > 0 ? Math.min(query.limit, 1000) : 200;
      const res = await tx.query(
        `${this.select} WHERE it.item_id = $1 ORDER BY d.decided_at DESC, d.decision_id DESC LIMIT $2`,
        [itemId, limit],
      );
      return res.rows.map((r) => rowToDecision(r as Record<string, unknown>));
    });
  }
}
