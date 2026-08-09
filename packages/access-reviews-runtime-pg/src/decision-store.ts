import type { AccessReviewDecision } from "@crossengin/access-reviews";
import type { PgConnection } from "@crossengin/kernel-pg";

import { CampaignUuidResolver, ItemUuidResolver } from "./id-mapping.js";
import { rowToDecision, type DecisionRow } from "./records.js";
import { withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "access_review_decisions";

const SELECT_JOINED = `
  SELECT
    d.decision_id, i.item_id AS item_natural_id, c.campaign_id AS campaign_natural_id,
    d.tenant_id, d.decided_by_user_id, d.decided_at, d.kind, d.reason, d.comment,
    d.time_bound_extend_until, d.modified_grant_attributes, d.attestation_kind,
    d.attestation_signature_sha256, d.attestation_signing_key_fingerprint,
    d.co_attesting_user_id, d.co_attested_at, d.ip_address, d.user_agent,
    d.supersedes_decision_id, d.related_exception_id, d.applied_at,
    d.application_failed_at, d.application_failure_reason
  FROM ${SCHEMA}.${TABLE} d
  JOIN ${SCHEMA}.access_review_items i ON i.id = d.item_id
  JOIN ${SCHEMA}.access_review_campaigns c ON c.id = d.campaign_id`;

export class PostgresAccessReviewDecisionStore {
  constructor(
    private readonly conn: PgConnection,
    private readonly campaignResolver: CampaignUuidResolver = new CampaignUuidResolver(),
    private readonly itemResolver: ItemUuidResolver = new ItemUuidResolver(),
  ) {}

  async record(decision: AccessReviewDecision): Promise<void> {
    await withTenantContext(this.conn, decision.tenantId, async (tx) => {
      const itemUuid = await this.itemResolver.requireResolve(tx, decision.itemId);
      const campaignUuid = await this.campaignResolver.requireResolve(tx, decision.campaignId);
      const att = decision.attestation;
      await tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (
           decision_id, item_id, campaign_id, tenant_id, decided_by_user_id, decided_at,
           kind, reason, comment, time_bound_extend_until, modified_grant_attributes,
           attestation_kind, attestation_signature_sha256, attestation_signing_key_fingerprint,
           co_attesting_user_id, co_attested_at, ip_address, user_agent,
           supersedes_decision_id, related_exception_id, applied_at, application_failed_at,
           application_failure_reason
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11::jsonb,
           $12, $13, $14,
           $15, $16, $17::inet, $18,
           $19, $20, $21, $22,
           $23
         )
         ON CONFLICT (decision_id) DO NOTHING`,
        [
          decision.id,
          itemUuid,
          campaignUuid,
          decision.tenantId,
          decision.decidedByUserId,
          decision.decidedAt,
          decision.kind,
          decision.reason,
          decision.comment ?? null,
          decision.timeBoundExtendUntil,
          decision.modifiedGrantAttributes === null
            ? null
            : JSON.stringify(decision.modifiedGrantAttributes),
          att.kind,
          att.signatureSha256,
          att.signingKeyFingerprint,
          att.coAttestingUserId,
          att.coAttestedAt,
          att.ipAddress,
          att.userAgent,
          decision.supersedesDecisionId,
          decision.relatedExceptionId,
          decision.appliedAt,
          decision.applicationFailedAt,
          decision.applicationFailureReason,
        ],
      );
    });
  }

  async listByItem(
    tenantId: string,
    itemId: string,
  ): Promise<readonly AccessReviewDecision[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<DecisionRow>(
        `${SELECT_JOINED} WHERE i.item_id = $1 ORDER BY d.decided_at ASC, d.decision_id ASC`,
        [itemId],
      );
      return result.rows.map(rowToDecision);
    });
  }

  async listByCampaign(
    tenantId: string,
    campaignId: string,
  ): Promise<readonly AccessReviewDecision[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<DecisionRow>(
        `${SELECT_JOINED} WHERE c.campaign_id = $1 ORDER BY d.decided_at ASC, d.decision_id ASC`,
        [campaignId],
      );
      return result.rows.map(rowToDecision);
    });
  }
}
