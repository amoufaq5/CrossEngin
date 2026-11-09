import type { AccessReviewDecision } from "@crossengin/access-reviews";
import {
  readRowsWithUnreadable,
  type PgConnection,
} from "@crossengin/kernel-pg";

import { CampaignUuidResolver, ItemUuidResolver } from "./id-mapping.js";
import {
  recordsOrRefuse,
  rowKey,
  rowToDecision,
  type DecisionRow,
  type TypedRowRead,
} from "./records.js";
import { tenantScopePredicate, withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "access_review_decisions";

const SELECT_JOINED = `
  SELECT
    d.decision_id, i.item_id AS item_natural_id, c.campaign_id AS campaign_natural_id,
    d.tenant_id, d.decided_by_user_id, d.decided_at, d.kind, d.reason, d.comment,
    d.time_bound_extend_until, d.modified_grant_attributes, d.attestation_kind,
    d.attestation_phrase, d.attestation_signature_sha256,
    d.attestation_signing_key_fingerprint,
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
           attestation_kind, attestation_phrase, attestation_signature_sha256,
           attestation_signing_key_fingerprint,
           co_attesting_user_id, co_attested_at, ip_address, user_agent,
           supersedes_decision_id, related_exception_id, applied_at, application_failed_at,
           application_failure_reason
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11::jsonb,
           $12, $13, $14, $15,
           $16, $17, $18::inet, $19,
           $20, $21, $22, $23,
           $24
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
          // Bound because it duplicates no other column, and because the signed bytes commit to it
          // independently: `canonicalAttestationBytes` hashes `attestationPhrase`, and
          // `canonicalStringify` skips `undefined`, so losing it removes the **key** from the
          // payload rather than nulling it. So a signed attestation that carried a phrase could
          // never have its `signatureSha256` recomputed from the stored row — and for
          // `typed_attestation_phrase`, which requires no signature at all, the phrase *is* the
          // whole evidence, which is why the contract now refuses one without it.
          att.attestationPhrase ?? null,
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
    const read = await withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<DecisionRow>(
        `${SELECT_JOINED} WHERE i.item_id = $1 ORDER BY d.decided_at ASC, d.decision_id ASC`,
        [itemId],
      );
      return readRowsWithUnreadable(result.rows, rowToDecision, (row) => rowKey(row.decision_id));
    });
    return recordsOrRefuse(`decisions of item ${itemId}`, read);
  }

  /**
   * All three joined tables carry the predicate — the decision, its item and their campaign — which
   * is what a non-owner is shown, since RLS applies each table's own isolation policy to each table
   * in the join. Without it this read was global as the owner: `campaign_id` is table-wide unique,
   * so `listByCampaign(tenantA, …)` returned tenant B's decisions and the replayer reported them
   * under tenant A.
   */
  async listByCampaign(
    tenantId: string,
    campaignId: string,
  ): Promise<readonly AccessReviewDecision[]> {
    return recordsOrRefuse(
      `decisions of campaign ${campaignId}`,
      await this.listByCampaignWithUnreadable(tenantId, campaignId),
    );
  }

  /**
   * The same read, with the rows the contract refused beside the ones it accepted.
   *
   * This is the read ADR-0362 made throwable: it gave `rowToDecision` a `parse` where it had
   * returned a bare literal *typed as* the contract, and measured that 9 of the schema's 13 clauses
   * became reachable from a stored row. So the hardening one increment ago is what put the other
   * campaign's decisions at risk here — which is the argument for the two landing together rather
   * than against the parse.
   */
  async listByCampaignWithUnreadable(
    tenantId: string,
    campaignId: string,
  ): Promise<TypedRowRead<AccessReviewDecision>> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<DecisionRow>(
        `${SELECT_JOINED}
          WHERE c.campaign_id = $1
            AND ${tenantScopePredicate("d", 2)}
            AND ${tenantScopePredicate("i", 2)}
            AND ${tenantScopePredicate("c", 2)}
          ORDER BY d.decided_at ASC, d.decision_id ASC`,
        [campaignId, tenantId],
      );
      return readRowsWithUnreadable(result.rows, rowToDecision, (row) => rowKey(row.decision_id));
    });
  }

  /**
   * Decisions of this campaign whose **item** belongs to a different one.
   *
   * One statement over both tables, which is the whole reason it exists: the replayer used to ask
   * this by comparing two reads — `itemsById.get(decision.itemId)` against a per-campaign item
   * set — and that comparison **could never answer it**. Both reads filter on
   * `c.campaign_id = $1`, so the decisions read returns a mismatched decision iff its *own*
   * campaign is the asked-for one, while the items read returns its item iff the *item's* campaign
   * is — and a mismatch means exactly one of those holds. So the item was permanently absent from
   * the map, `verifyDecisionRowShape`'s `if (item !== undefined)` guard skipped, and the finding
   * was unreachable from either campaign. Measured live on PG 16 as the non-owner `serving` role:
   * a decision in campaign A naming an item in campaign B reported `issues=[-]` for **both**
   * campaigns while this query answers `1` for A and `0` for B.
   *
   * It is **not** a read-order fix. Reordering the two reads cannot help, because the absence is
   * produced by the two WHERE clauses rather than by an interleaving — and asking it in one
   * statement is strictly better than ordering two, since a predicate evaluated in a single
   * snapshot has no order to get wrong (ADR-0407's rule read forward). A decision committed after
   * this read is simply not covered yet, which is the conservative direction.
   *
   * No mapper and so no refusal axis: every column it reads is a business key compared to another
   * business key, so there is no row it can fail to represent and the finding is **conclusive**
   * where the old one was inferential (ADR-0322's axis). All four joined relations carry the
   * tenant predicate, for `listByCampaign`'s reason — `campaign_id` is table-wide unique, so
   * without it this read is global as the owner.
   */
  async campaignMismatches(
    tenantId: string,
    campaignId: string,
  ): Promise<readonly DecisionCampaignMismatch[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<{ decision_id: string; item_campaign_id: string }>(
        `SELECT d.decision_id, ic.campaign_id AS item_campaign_id
           FROM ${SCHEMA}.${TABLE} d
           JOIN ${SCHEMA}.access_review_items i ON i.id = d.item_id
           JOIN ${SCHEMA}.access_review_campaigns dc ON dc.id = d.campaign_id
           JOIN ${SCHEMA}.access_review_campaigns ic ON ic.id = i.campaign_id
          WHERE dc.campaign_id = $1
            AND d.campaign_id <> i.campaign_id
            AND ${tenantScopePredicate("d", 2)}
            AND ${tenantScopePredicate("i", 2)}
            AND ${tenantScopePredicate("dc", 2)}
            AND ${tenantScopePredicate("ic", 2)}
          ORDER BY d.decision_id ASC`,
        [campaignId, tenantId],
      );
      return result.rows.map((row) => ({
        decisionId: row.decision_id,
        itemCampaignId: row.item_campaign_id,
      }));
    });
  }
}

/**
 * A decision whose campaign disagrees with its item's, as `campaignMismatches` answers it.
 *
 * Both fields are business keys read straight off a column: the decision's own id, and the campaign
 * the item really belongs to. The decision's *claimed* campaign is the one the caller asked about,
 * so it is not repeated here — a finding must not invite a reader to act on a value that came back
 * from the row rather than from the question.
 */
export interface DecisionCampaignMismatch {
  readonly decisionId: string;
  readonly itemCampaignId: string;
}
