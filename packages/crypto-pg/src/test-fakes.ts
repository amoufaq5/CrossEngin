import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

/**
 * In-memory fake of `meta.crypto_keys` with RLS-like scoping. Rows are keyed by `key_id`. Each
 * transaction starts with a null (platform) tenant context; a `set_config('app.current_tenant_id', …)`
 * scopes subsequent statements. RLS visibility models the table's platform-or-tenant policy:
 * `tenant_id IS NULL OR tenant_id = <context>`. Enough to exercise upsert, keyed/filtered reads,
 * and status updates offline.
 */
export function fakeCryptoKeysPg(): PgConnection {
  const rows = new Map<string, Record<string, unknown>>();

  function paramIndex(sql: string, expr: string): number | null {
    const m = sql.match(new RegExp(`${expr}\\s*=\\s*\\$(\\d+)`));
    return m ? Number(m[1]) - 1 : null;
  }

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

      if (sql.includes("INSERT INTO")) {
        const keyId = p[0] as string;
        const incoming: Record<string, unknown> = {
          key_id: keyId,
          tenant_id: p[1] ?? null,
          algorithm: p[2],
          purpose: p[3],
          public_key_base64: p[4] ?? null,
          fingerprint_sha256: p[5] ?? null,
          key_version: p[6],
          status: p[7],
          created_at: p[8],
        };
        const existing = rows.get(keyId);
        if (existing === undefined) {
          rows.set(keyId, incoming);
        } else {
          rows.set(keyId, {
            ...existing,
            public_key_base64: incoming.public_key_base64,
            fingerprint_sha256: incoming.fingerprint_sha256,
            key_version: incoming.key_version,
            status: incoming.status,
          });
        }
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("UPDATE")) {
        const statusIdx = paramIndex(sql, "status");
        const keyIdIdx = paramIndex(sql, "key_id");
        if (statusIdx === null || keyIdIdx === null) return { rows: [], rowCount: 0 };
        const keyId = p[keyIdIdx] as string;
        const row = rows.get(keyId);
        if (row === undefined || !visible(row, currentTenant)) {
          return { rows: [], rowCount: 0 };
        }
        row.status = p[statusIdx];
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("SELECT")) {
        let visibleRows = [...rows.values()].filter((r) => visible(r, currentTenant));

        const keyIdIdx = paramIndex(sql, "key_id");
        if (keyIdIdx !== null) {
          visibleRows = visibleRows.filter((r) => r["key_id"] === p[keyIdIdx]);
        }
        const fpIdx = paramIndex(sql, "fingerprint_sha256");
        if (fpIdx !== null) {
          visibleRows = visibleRows.filter((r) => r["fingerprint_sha256"] === p[fpIdx]);
        }
        const tenantIdx = paramIndex(sql, "tenant_id");
        if (tenantIdx !== null) {
          visibleRows = visibleRows.filter((r) => (r["tenant_id"] ?? null) === p[tenantIdx]);
        }
        const algoIdx = paramIndex(sql, "algorithm");
        if (algoIdx !== null) {
          visibleRows = visibleRows.filter((r) => r["algorithm"] === p[algoIdx]);
        }
        const purposeIdx = paramIndex(sql, "purpose");
        if (purposeIdx !== null) {
          visibleRows = visibleRows.filter((r) => r["purpose"] === p[purposeIdx]);
        }
        const statusIdx = paramIndex(sql, "status");
        if (statusIdx !== null) {
          visibleRows = visibleRows.filter((r) => r["status"] === p[statusIdx]);
        }

        if (sql.includes("ORDER BY created_at DESC")) {
          visibleRows = [...visibleRows].sort((a, b) => {
            const byDate = String(b["created_at"]).localeCompare(String(a["created_at"]));
            if (byDate !== 0) return byDate;
            return String(a["key_id"]).localeCompare(String(b["key_id"]));
          });
        }
        return { rows: visibleRows, rowCount: visibleRows.length };
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

function visible(row: Record<string, unknown>, currentTenant: string | null): boolean {
  const tenantId = (row["tenant_id"] ?? null) as string | null;
  return tenantId === null || tenantId === currentTenant;
}
