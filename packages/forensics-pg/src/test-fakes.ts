import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

const CHECKPOINTS = "forensic_chain_checkpoints";

function paramIndex(sql: string, re: RegExp): number | null {
  const m = re.exec(sql);
  return m === null ? Number.NaN : Number(m[1]) - 1;
}

/**
 * In-memory fake of both `meta.forensic_chain_entries` and `meta.forensic_chain_checkpoints`, routed by the
 * table name in the SQL, with RLS-like scoping: each transaction (and the top-level connection) tracks a
 * `set_config('app.current_tenant_id', …)` tenant, scoping SELECTs to that tenant's rows plus the platform
 * (null) default. Enough to exercise the chain append/read path, checkpoint record/read, and
 * checkpoint-anchored suffix verification offline.
 */
export function fakeChainPg(): PgConnection {
  const entryRows: Record<string, unknown>[] = [];
  const checkpointRows: Record<string, unknown>[] = [];

  function makeClient(): PgConnection {
    let currentTenant: string | null = null;

    const query = async (
      sql: string,
      params?: readonly unknown[],
    ): Promise<PgQueryResult> => {
      const p = params ?? [];
      if (sql.includes("set_config")) {
        currentTenant = (p[0] as string | null) ?? null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO")) {
        if (sql.includes(CHECKPOINTS)) {
          const tenant = (p[0] as string | null) ?? null;
          const seq = Number(p[1]);
          const exists = checkpointRows.some(
            (r) => (r["tenant_id"] ?? null) === tenant && Number(r["sequence_number"]) === seq,
          );
          if (!exists) {
            checkpointRows.push({
              tenant_id: p[0] ?? null,
              sequence_number: p[1],
              root_hash: p[2],
              checkpointed_at: p[3],
              checkpointed_by: p[4],
              external_anchor_reference: p[5] ?? null,
              algorithm: p[6],
            });
          }
          return { rows: [], rowCount: exists ? 0 : 1 };
        }
        entryRows.push({
          tenant_id: p[0] ?? null,
          sequence_number: p[1],
          kind: p[2],
          recorded_at: p[3],
          actor_reference: p[4],
          payload_sha256: p[5],
          payload_size_bytes: p[6],
          prior_entry_hash: p[7],
          entry_hash: p[8],
          signing_key_fingerprint: p[9],
          signature: p[10],
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT")) {
        const table = sql.includes(CHECKPOINTS) ? checkpointRows : entryRows;
        let visible = table.filter((r) => (r["tenant_id"] ?? null) === currentTenant);

        const geIdx = paramIndex(sql, /sequence_number >= \$(\d+)/);
        if (geIdx !== null && !Number.isNaN(geIdx)) {
          const min = Number(p[geIdx]);
          visible = visible.filter((r) => Number(r["sequence_number"]) >= min);
        }
        const eqIdx = paramIndex(sql, /sequence_number = \$(\d+)/);
        if (eqIdx !== null && !Number.isNaN(eqIdx)) {
          const val = Number(p[eqIdx]);
          visible = visible.filter((r) => Number(r["sequence_number"]) === val);
        }

        const desc = sql.includes("ORDER BY sequence_number DESC");
        visible = [...visible].sort(
          (a, b) =>
            (Number(a["sequence_number"]) - Number(b["sequence_number"])) * (desc ? -1 : 1),
        );

        const limitIdx = paramIndex(sql, /LIMIT \$(\d+)/);
        if (limitIdx !== null && !Number.isNaN(limitIdx)) {
          visible = visible.slice(0, Number(p[limitIdx]));
        } else if (/LIMIT 1\b/.test(sql)) {
          visible = visible.slice(0, 1);
        }
        return { rows: visible, rowCount: visible.length };
      }
      return { rows: [], rowCount: 0 };
    };

    const client: PgConnection = {
      query: query as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(makeClient())) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    return client;
  }

  return makeClient();
}
