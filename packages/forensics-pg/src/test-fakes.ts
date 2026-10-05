import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

const CHECKPOINTS = "forensic_chain_checkpoints";

function paramIndex(sql: string, re: RegExp): number | null {
  const m = re.exec(sql);
  return m === null ? Number.NaN : Number(m[1]) - 1;
}

/**
 * In-memory fake of both `meta.forensic_chain_entries` and `meta.forensic_chain_checkpoints`, routed by
 * the table name in the SQL. Enough to exercise the chain append/read path, checkpoint record/read, and
 * checkpoint-anchored suffix verification offline.
 *
 * **Reads are filtered by the SQL's own `tenant_id` predicate, not by the session's context** — that is,
 * the fake behaves like the *table owner*, for whom RLS is bypassed. The earlier fake filtered reads by
 * the tenant the transaction had set, which made it **stricter than the real database** and so hid a live
 * defect: the reader carried no predicate at all, and connected as the owner it returned every scope's
 * entries to every scope. A fake that enforces an isolation the code never asked for cannot catch a
 * missing predicate, and connecting as the owner is an ordinary deployment.
 *
 * **Writes are checked against the policy set instead**, which is where scope is enforced in the real
 * database: a tenant row needs that tenant's context, and a platform row (`tenant_id IS NULL`) needs the
 * `app.platform_audit_write` elevation and nothing else. Both refusals are the RLS error the server
 * raises, so an append that forgot its elevation fails offline too.
 */
export function fakeChainPg(): PgConnection {
  const entryRows: Record<string, unknown>[] = [];
  const checkpointRows: Record<string, unknown>[] = [];

  function makeClient(): PgConnection {
    let currentTenant: string | null = null;
    let platformWrite = false;

    /** What the real policies allow this transaction to insert. */
    const writeRefusal = (rowTenant: string | null): string | null => {
      if (rowTenant === null) {
        return platformWrite
          ? null
          : "new row violates row-level security policy (platform write needs app.platform_audit_write)";
      }
      return rowTenant === currentTenant
        ? null
        : "new row violates row-level security policy (row tenant is not the session's)";
    };

    const query = async (
      sql: string,
      params?: readonly unknown[],
    ): Promise<PgQueryResult> => {
      const p = params ?? [];
      if (sql.includes("app.platform_audit_write")) {
        platformWrite = true;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("set_config")) {
        currentTenant = (p[0] as string | null) ?? null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO")) {
        const refusal = writeRefusal((p[0] as string | null) ?? null);
        if (refusal !== null) throw new Error(refusal);
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
        // The owner's view: every row, narrowed only by what the statement itself asks for. A read
        // with no `tenant_id` predicate therefore sees every scope — which is the defect, visible.
        let visible = table;
        if (/tenant_id IS NULL/.test(sql)) {
          visible = visible.filter((r) => (r["tenant_id"] ?? null) === null);
        }
        const tenantIdx = paramIndex(sql, /tenant_id = \$(\d+)/);
        if (tenantIdx !== null && !Number.isNaN(tenantIdx)) {
          visible = visible.filter((r) => (r["tenant_id"] ?? null) === p[tenantIdx]);
        }

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
