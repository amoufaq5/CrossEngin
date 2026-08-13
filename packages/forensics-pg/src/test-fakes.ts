import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

/**
 * In-memory fake of `meta.forensic_chain_entries` with RLS-like scoping: each transaction starts with a
 * null (platform) tenant context; a `set_config('app.current_tenant_id', …)` call scopes subsequent
 * SELECTs to that tenant's rows, modelling the table's platform-or-tenant policy. Enough to exercise the
 * store's tail → build → insert append path and the ordered reads offline.
 */
export function fakeChainPg(): PgConnection {
  const rows: Record<string, unknown>[] = [];

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
        rows.push({
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
        let visible = rows.filter((r) => (r["tenant_id"] ?? null) === currentTenant);
        visible = [...visible].sort(
          (a, b) => Number(a["sequence_number"]) - Number(b["sequence_number"]),
        );
        if (sql.includes("ORDER BY sequence_number DESC")) {
          visible = visible.slice(-1);
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
