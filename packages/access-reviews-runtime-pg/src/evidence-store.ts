import type {
  AccessReviewEvidence,
  ComplianceFramework,
} from "@crossengin/access-reviews";
import {
  EVIDENCE_RATE_FIELDS,
  unquantizedEvidenceRates,
} from "@crossengin/access-reviews-runtime";
import {
  assertScopedWriteLanded,
  scopeFilter,
  type PgConnection,
} from "@crossengin/kernel-pg";

import { rowToEvidence, type EvidenceRow } from "./records.js";
import { withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "access_review_evidence";

/**
 * Every column the row carries, in catalog order.
 *
 * Asserted against `META_TABLES` by `packages/testing/src/strategy/pg-column-coverage.ts`, which is
 * the only reason this list can be trusted: ADR-0331's signal store omitted two `notNull` columns
 * with no default and ADR-0332's flag store named one the catalog had renamed, and **both passed
 * every offline test** because a fake `PgConnection` answers any statement. The boundary a fake
 * draws is the SQL string; a column that does not exist is on the far side of it.
 */
const ALL_COLUMNS = `
  evidence_id, tenant_id, framework, period_start_at, period_end_at, campaign_ids,
  control_mappings, total_items_across_campaigns, completion_rate, keep_rate, revoke_rate,
  auto_revoke_rate, exception_rate, strong_attestation_rate, overdue_rate, status,
  compiled_at, sealed_at, sealed_sha256, submitted_at, submitted_to_auditor_id,
  accepted_at, rejected_at, rejected_reason, storage_uri, created_by, created_at`;

/**
 * The columns a re-compilation may move, and therefore the columns the seal digest commits to.
 *
 * `evidence_id`, `tenant_id`, `framework` and `created_by` are **absent on purpose**: the first
 * three are the row's identity (the id is derived from them) and the fourth is who compiled it,
 * which a later pass must not rewrite. `created_at` is absent for the same reason.
 *
 * The `DO UPDATE` list in `compile` spells these columns out **literally** rather than being
 * rendered from this array, and the array is what a test asserts the literal against. That is the
 * opposite of the usual preference for one source, and it is deliberate:
 * `packages/testing/src/strategy/pg-column-coverage.ts` reads every store's SQL **as text** and
 * reports an interpolation it cannot evaluate as `unresolved_columns`, so a rendered list would buy
 * tidiness at the price of the one rule that can tell us a column does not exist. CLAUDE.md records
 * twelve such clauses already declared as gaps and hand-verified once; this one does not need to be
 * one.
 */
export const RECOMPILABLE_COLUMNS = [
  "period_start_at",
  "period_end_at",
  "campaign_ids",
  "control_mappings",
  "total_items_across_campaigns",
  "completion_rate",
  "keep_rate",
  "revoke_rate",
  "auto_revoke_rate",
  "exception_rate",
  "strong_attestation_rate",
  "overdue_rate",
  "status",
  "compiled_at",
] as const;

/**
 * The statuses a pack may be re-compiled from.
 *
 * `EVIDENCE_TRANSITIONS` says `draft -> compiled` and `compiled -> sealed`, so these two are exactly
 * the states from which the figures are not yet committed to a digest. Everything from `sealed`
 * onward is refused, which is the whole claim this store makes.
 */
const RECOMPILABLE_STATUSES = ["draft", "compiled"] as const;

export const EVIDENCE_STORE_REFUSALS = [
  /** A rate is not at `NUMERIC(5, 4)`'s scale, so storing it would move it out from under the seal. */
  "rate_not_quantized",
  /** `compile` was handed a record that is already sealed, or `seal` one that is not compiled. */
  "wrong_status_for_operation",
  /** `seal` was handed a record with no digest. */
  "unsealed_record",
] as const;

export type EvidenceStoreRefusal = (typeof EVIDENCE_STORE_REFUSALS)[number];

export class EvidenceStoreRefusedError extends Error {
  constructor(
    readonly refusal: EvidenceStoreRefusal,
    detail: string,
  ) {
    super(`${SCHEMA}.${TABLE}: ${refusal}: ${detail}`);
    this.name = "EvidenceStoreRefusedError";
  }
}

function assertQuantized(evidence: AccessReviewEvidence): void {
  const bad = unquantizedEvidenceRates(evidence);
  if (bad.length === 0) return;
  throw new EvidenceStoreRefusedError(
    "rate_not_quantized",
    `${bad.join(", ")} exceed NUMERIC(5, 4); the seal digest commits to the rate, so writing a ` +
      `rounded value would leave the stored row unverifiable against its own sealedSha256. ` +
      `Quantize in the producer (compileCampaignEvidence does) rather than here.`,
  );
}

/**
 * `meta.access_review_evidence`'s writer, and the first one it has ever had.
 *
 * The table was declared in Phase 1 and read from Phase 3 onward —
 * `apps/operate-server/src/certification.ts` asks it for the latest sealed pack on every
 * certification pass — with nothing writing it, so `access.periodic_review` scored `not_assessed`
 * for ever and no framework could be certifiable in any deployment. ADR-0334's census called this
 * the sharpest member of its class: a live reader over a table with no writer.
 *
 * ## Two statements, because they are two claims
 *
 * `compile` is a **guarded upsert** and `seal` a **guarded update**, and neither is the blanket
 * `ON CONFLICT ... DO UPDATE SET <everything>` the three sibling stores use. A pack's figures are
 * what its `sealedSha256` commits to, so a blanket upsert would let a sealed row's metrics *and* its
 * digest be rewritten together — a self-consistent forgery in the one record an auditor reads. The
 * guard is the contract's own transition map, re-asserted **inside the predicate** rather than read
 * first (ADR-0321's "the row is the lock"), so two schedulers cannot both seal one period.
 *
 * `DO NOTHING` is wrong on both: ADR-0333 found it on `dr-runtime-pg`'s upsert path, where a
 * completed failover was silently dropped and a breaching deployment then scored `ready: true`. And
 * a *refused* `DO UPDATE` returns `INSERT 0 0`, byte-identical to a `DO NOTHING`, so **the refusal
 * throws** — otherwise the fix reproduces the bug it fixes.
 *
 * ## The scope predicate
 *
 * Every statement carries one beside RLS, because **a table's owner bypasses its policies** and
 * connecting as the owner is an ordinary deployment. That was not theoretical here: measured live as
 * the owner before this existed, `PostgresAccessReviewEvidenceReader.latestSealed` answered tenant
 * A's certification with tenant **B's** sealed pack, and A's SOC 2 report then read
 * `access.periodic_review` *satisfied* at 100% completion citing B's digest as its proof.
 *
 * The **strict** spelling (`scopeFilter`, not `scopeFilterWithPlatform`): `tenant_id` is `NOT NULL`
 * with a foreign key to `meta.tenants`, the table has one `ALL`-scope isolation policy and no
 * platform arm, so a scope's rows are a closed set and there is no platform row a tenant is meant to
 * be shown. One deployment's review is never evidence about another's.
 */
export class PostgresAccessReviewEvidenceStore {
  constructor(private readonly conn: PgConnection) {}

  /**
   * Writes a compiled pack, or re-compiles one for a period that is not yet sealed.
   *
   * Idempotent on a retry without an idempotency key, because `evidenceIdFor` derives the id from
   * the period: the second attempt lands on the row the first wrote.
   */
  async compile(evidence: AccessReviewEvidence): Promise<void> {
    assertQuantized(evidence);
    if (!(RECOMPILABLE_STATUSES as readonly string[]).includes(evidence.status)) {
      throw new EvidenceStoreRefusedError(
        "wrong_status_for_operation",
        `compile() takes a ${RECOMPILABLE_STATUSES.join(" or ")} record and was handed ${evidence.status}; ` +
          `use seal() for a sealed one`,
      );
    }
    // The row binds $1..$27; the scope predicate takes $28 and the status allow-list $29.
    //
    // The guard's columns are **qualified with the table name**, which is not decoration: inside
    // `ON CONFLICT … DO UPDATE`'s `WHERE`, a bare `tenant_id` could mean the stored row or
    // `excluded`, and Postgres answers `42702 column reference "tenant_id" is ambiguous` rather
    // than picking one. Found live on the first real run — the offline fake had accepted the
    // unqualified form happily, which is exactly the boundary ADR-0333 drew: a fake answers the
    // SQL *string*, and whether Postgres can even parse it is on the far side.
    const scope = scopeFilter(evidence.tenantId, 28);
    await withTenantContext(this.conn, evidence.tenantId, async (tx) => {
      const result = await tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (${ALL_COLUMNS})
         VALUES (
           $1, $2, $3, $4, $5, $6::jsonb,
           $7::jsonb, $8, $9, $10, $11,
           $12, $13, $14, $15, $16,
           $17, $18, $19, $20, $21,
           $22, $23, $24, $25, $26, $27
         )
         ON CONFLICT (evidence_id) DO UPDATE SET
           period_start_at = EXCLUDED.period_start_at,
           period_end_at = EXCLUDED.period_end_at,
           campaign_ids = EXCLUDED.campaign_ids,
           control_mappings = EXCLUDED.control_mappings,
           total_items_across_campaigns = EXCLUDED.total_items_across_campaigns,
           completion_rate = EXCLUDED.completion_rate,
           keep_rate = EXCLUDED.keep_rate,
           revoke_rate = EXCLUDED.revoke_rate,
           auto_revoke_rate = EXCLUDED.auto_revoke_rate,
           exception_rate = EXCLUDED.exception_rate,
           strong_attestation_rate = EXCLUDED.strong_attestation_rate,
           overdue_rate = EXCLUDED.overdue_rate,
           status = EXCLUDED.status,
           compiled_at = EXCLUDED.compiled_at
         WHERE ${TABLE}.${scope.sql}
           AND ${TABLE}.status = ANY($29::text[])`,
        [
          evidence.id,
          evidence.tenantId,
          evidence.framework,
          evidence.periodStartAt,
          evidence.periodEndAt,
          JSON.stringify(evidence.campaignIds),
          JSON.stringify(evidence.controlMappings),
          evidence.totalItemsAcrossCampaigns,
          ...EVIDENCE_RATE_FIELDS.map((f) => evidence[f]),
          evidence.status,
          evidence.compiledAt,
          evidence.sealedAt,
          evidence.sealedSha256,
          evidence.submittedAt,
          evidence.submittedToAuditorId,
          evidence.acceptedAt,
          evidence.rejectedAt,
          evidence.rejectedReason,
          evidence.storageUri,
          evidence.createdBy,
          evidence.createdAt,
          ...scope.params,
          [...RECOMPILABLE_STATUSES],
        ],
      );
      await assertScopedWriteLanded(tx, result.rowCount, {
        schema: SCHEMA,
        table: TABLE,
        idColumn: "evidence_id",
        idValue: evidence.id,
        tenantId: evidence.tenantId,
        guard:
          `the stored pack for this period is past ${RECOMPILABLE_STATUSES.join("/")} and its ` +
          `figures are what its sealedSha256 commits to`,
      });
    });
  }

  /**
   * Stamps the seal onto a compiled row.
   *
   * `sealedSha256` is written **verbatim** from the record the producer sealed and is never derived
   * here: a digest recomputed from a stored column rather than from the record it was computed over
   * is ADR-0323's defect, and it is what makes `tombstoneMatchesAttestations`-style tampering
   * invisible.
   *
   * The predicate re-asserts `status = 'compiled'` **and every figure the digest commits to**, each
   * cast to the column's own `NUMERIC(5, 4)`, so a seal can only land on a row holding the figures
   * it was computed over. Without that the two could disagree and the stored proof would be a lie
   * about a row that is otherwise intact — the condition no digest can detect, because the digest
   * would verify.
   */
  async seal(evidence: AccessReviewEvidence): Promise<void> {
    assertQuantized(evidence);
    if (evidence.status !== "sealed") {
      throw new EvidenceStoreRefusedError(
        "wrong_status_for_operation",
        `seal() takes a sealed record and was handed ${evidence.status}`,
      );
    }
    if (evidence.sealedSha256 === null || evidence.sealedAt === null) {
      throw new EvidenceStoreRefusedError(
        "unsealed_record",
        `record ${evidence.id} is status sealed with no sealedSha256/sealedAt`,
      );
    }
    const scope = scopeFilter(evidence.tenantId, 5);
    const rateChecks = EVIDENCE_RATE_FIELDS.map(
      (f, i) =>
        `           AND ${rateColumn(f)} = $${String(6 + i)}::numeric(5, 4)`,
    ).join("\n");
    await withTenantContext(this.conn, evidence.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE ${SCHEMA}.${TABLE}
            SET status = 'sealed',
                sealed_at = $1,
                sealed_sha256 = $2,
                storage_uri = $3
          WHERE evidence_id = $4
            AND ${scope.sql}
            AND status = 'compiled'
            AND total_items_across_campaigns = $${String(6 + EVIDENCE_RATE_FIELDS.length)}
${rateChecks}`,
        [
          evidence.sealedAt,
          evidence.sealedSha256,
          evidence.storageUri,
          evidence.id,
          ...scope.params,
          ...EVIDENCE_RATE_FIELDS.map((f) => evidence[f]),
          evidence.totalItemsAcrossCampaigns,
        ],
      );
      await assertScopedWriteLanded(tx, result.rowCount, {
        schema: SCHEMA,
        table: TABLE,
        idColumn: "evidence_id",
        idValue: evidence.id,
        tenantId: evidence.tenantId,
        guard:
          "it is either not `compiled` or holds different figures than the digest was computed " +
          "over, and a seal may only land on the row it commits to",
      });
    });
  }

  /**
   * The latest sealed pack for a framework, which is the question the certification pass asks.
   *
   * Ordered by `period_end_at DESC` with `evidence_id` as the tiebreak, because two packs can share
   * a period end (a `custom` framework pack beside a named one) and an untotal ordering makes the
   * answer depend on physical row order — ADR-0327's `scanAll` rule, applied to a `LIMIT 1`.
   */
  async latestSealedForFramework(
    tenantId: string,
    framework: ComplianceFramework,
  ): Promise<AccessReviewEvidence | null> {
    const scope = scopeFilter(tenantId, 2);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<EvidenceRow>(
        `SELECT ${ALL_COLUMNS}
           FROM ${SCHEMA}.${TABLE}
          WHERE framework = $1
            AND ${scope.sql}
            AND status IN ('sealed', 'submitted_to_auditor', 'accepted_by_auditor')
          ORDER BY period_end_at DESC, evidence_id DESC
          LIMIT 1`,
        [framework, ...scope.params],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToEvidence(row);
    });
  }

  async getByEvidenceId(
    tenantId: string,
    evidenceId: string,
  ): Promise<AccessReviewEvidence | null> {
    const scope = scopeFilter(tenantId, 2);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<EvidenceRow>(
        `SELECT ${ALL_COLUMNS}
           FROM ${SCHEMA}.${TABLE}
          WHERE evidence_id = $1 AND ${scope.sql}
          LIMIT 1`,
        [evidenceId, ...scope.params],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToEvidence(row);
    });
  }

  async listByTenant(
    tenantId: string,
  ): Promise<readonly AccessReviewEvidence[]> {
    const scope = scopeFilter(tenantId, 1);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<EvidenceRow>(
        `SELECT ${ALL_COLUMNS}
           FROM ${SCHEMA}.${TABLE}
          WHERE ${scope.sql}
          ORDER BY period_end_at ASC, evidence_id ASC`,
        [...scope.params],
      );
      return result.rows.map(rowToEvidence);
    });
  }
}

/** `completionRate` -> `completion_rate`, so one list of fields drives both sides. */
function rateColumn(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
