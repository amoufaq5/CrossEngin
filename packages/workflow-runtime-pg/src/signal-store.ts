import type { PgConnection } from "@crossengin/kernel-pg";
import type {
  SignalDeliveryGuarantee,
  SignalStatus,
} from "@crossengin/workflow-engine";

import type { WorkflowInstanceIdResolver } from "./id-mapping.js";

const SCHEMA = "meta";
const TABLE = "workflow_signals";

export interface SignalProjection {
  readonly id: string;
  readonly instanceId: string | null;
  readonly tenantId: string;
  readonly signalName: string;
  readonly correlationKey: string;
  /**
   * Not projected from the log — declared by the workflow's `SignalDefinition` and resolved by
   * `projectPersistableSignals`. Required rather than optional because the column is NOT NULL with
   * no default: an optional field can be forgotten with the type still satisfied, which is exactly
   * how every `upsert` came to omit it.
   */
  readonly deliveryGuarantee: SignalDeliveryGuarantee;
  readonly sourceSystem: string;
  readonly sourcePrincipalId: string | null;
  readonly status: SignalStatus;
  readonly receivedAt: string;
  readonly matchedAt: string | null;
  readonly consumedAt: string | null;
}

export class PostgresSignalStore {
  private readonly conn: PgConnection;
  private readonly instanceResolver: WorkflowInstanceIdResolver;

  constructor(opts: {
    readonly conn: PgConnection;
    readonly instanceResolver: WorkflowInstanceIdResolver;
  }) {
    this.conn = opts.conn;
    this.instanceResolver = opts.instanceResolver;
  }

  async upsert(projection: SignalProjection): Promise<void> {
    const instanceUuid =
      projection.instanceId === null
        ? null
        : await this.instanceResolver.requireResolve(projection.instanceId);
    await this.conn.query(
      // The DO UPDATE set is the signal's *progress* and nothing else. Provenance — the guarantee
      // it arrived under, the system that sent it, the principal behind it — is a fact of receipt;
      // a later definition version declaring a different guarantee must not rewrite what the
      // signal was actually accepted under.
      `INSERT INTO ${SCHEMA}.${TABLE} (
         signal_id, instance_id, tenant_id, signal_name, correlation_key,
         delivery_guarantee, source_system, source_principal_id,
         status, received_at, matched_at, consumed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (signal_id) DO UPDATE
         SET status = EXCLUDED.status,
             matched_at = EXCLUDED.matched_at,
             consumed_at = EXCLUDED.consumed_at,
             instance_id = COALESCE(EXCLUDED.instance_id, ${SCHEMA}.${TABLE}.instance_id)`,
      [
        projection.id,
        instanceUuid,
        projection.tenantId,
        projection.signalName,
        projection.correlationKey,
        projection.deliveryGuarantee,
        projection.sourceSystem,
        projection.sourcePrincipalId,
        projection.status,
        projection.receivedAt,
        projection.matchedAt,
        projection.consumedAt,
      ],
    );
  }

  async upsertMany(projections: readonly SignalProjection[]): Promise<void> {
    for (const p of projections) {
      await this.upsert(p);
    }
  }
}
