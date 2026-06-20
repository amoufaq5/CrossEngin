import type { PgConnection } from "@crossengin/kernel-pg";
import type { SequenceAllocator, SequenceAllocationInput } from "@crossengin/operate-runtime";

import { withTenantContext } from "./tenant-context.js";

const SEQUENCE_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/;
const PERIOD_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Durable, gap-free-per-allocation document-number allocator over
 * `meta.operate_sequences`. The counter is bumped with a single atomic
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so concurrent callers never
 * receive the same value. The row is keyed by `(tenant_id, sequence_name,
 * period_key)` and confined to the caller's tenant by RLS (the tenant id is
 * bound, never interpolated).
 */
export class PostgresSequenceAllocator implements SequenceAllocator {
  constructor(
    private readonly conn: PgConnection,
    private readonly schema = "meta",
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
  }

  async allocate(input: SequenceAllocationInput): Promise<number> {
    if (!SEQUENCE_NAME_RE.test(input.sequenceName)) {
      throw new Error(`invalid sequence name: ${JSON.stringify(input.sequenceName)}`);
    }
    if (!PERIOD_KEY_RE.test(input.periodKey)) {
      throw new Error(`invalid period key: ${JSON.stringify(input.periodKey)}`);
    }
    const start = input.start ?? 1;
    return withTenantContext(this.conn, input.tenantId, async (tx) => {
      const res = await tx.query<{ current_value: string }>(
        `INSERT INTO ${this.schema}.operate_sequences
           (tenant_id, sequence_name, period_key, current_value, updated_at)
         VALUES ($1::uuid, $2, $3, $4, now())
         ON CONFLICT (tenant_id, sequence_name, period_key)
         DO UPDATE SET current_value = ${this.schema}.operate_sequences.current_value + 1,
                       updated_at = now()
         RETURNING current_value`,
        [input.tenantId, input.sequenceName, input.periodKey, start],
      );
      const value = res.rows[0]?.current_value;
      if (value === undefined) {
        throw new Error("sequence allocation returned no row");
      }
      return Number(value);
    });
  }
}
