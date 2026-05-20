import type { PgConnection } from "@crossengin/kernel-pg";
import type {
  RouterInstrumentation,
  RouterInstrumentationEvent,
} from "@crossengin/ai-router";

const SCHEMA = "meta";
const TABLE = "llm_call_traces";

export interface PostgresRouterInstrumentationOptions {
  readonly conn: PgConnection;
}

export class PostgresRouterInstrumentation implements RouterInstrumentation {
  private readonly conn: PgConnection;

  constructor(opts: PostgresRouterInstrumentationOptions) {
    this.conn = opts.conn;
  }

  async onEvent(event: RouterInstrumentationEvent): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (
         tenant_id, provider_id, model_id, task, session_id,
         kind, occurred_at, duration_ms, attributes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        event.tenantId,
        event.providerId,
        event.modelId,
        event.task,
        event.sessionId,
        event.kind,
        event.occurredAt,
        event.durationMs,
        JSON.stringify(event.attributes),
      ],
    );
  }
}
