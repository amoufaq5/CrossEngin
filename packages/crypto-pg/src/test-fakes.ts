import { PLATFORM_WRITE_GRANTS, type PgConnection, type PgQueryResult } from "@crossengin/kernel-pg";

/** Thrown where Postgres raises `new row violates row-level security policy`. */
export class FakeRlsViolation extends Error {
  constructor(readonly detail: string) {
    super(`new row violates row-level security policy for table "crypto_keys": ${detail}`);
    this.name = "FakeRlsViolation";
  }
}

/**
 * In-memory fake of `meta.crypto_keys` with RLS-like scoping. Rows are keyed by `key_id`. Each
 * transaction starts with no scope at all; `set_config('app.current_tenant_id', …)` scopes it to a
 * tenant and `set_config('app.platform_key_write', 'on', …)` claims the platform write elevation.
 *
 * **It models the four policies the table carries, not the one it used to.** Reads follow
 * `tenant_id IS NULL OR tenant_id = <context>`, which is unchanged: the platform read arm is
 * `SELECT`-scoped and needs no grant. Writes do not. A platform-scope INSERT or UPDATE raises
 * unless the elevation is held, and a *tenant*-scope write raises unless that tenant's context is
 * set — including when the elevation is. That second rule is what makes the fake worth having:
 * holding the platform grant must buy no access to a tenant's keys, and a fake that let it through
 * would have reported the store correct while the live policy refused it.
 */
export function fakeCryptoKeysPg(): PgConnection {
  const rows = new Map<string, Record<string, unknown>>();

  function paramIndex(sql: string, expr: string): number | null {
    const m = sql.match(new RegExp(`${expr}\\s*=\\s*\\$(\\d+)`));
    return m ? Number(m[1]) - 1 : null;
  }

  function makeClient(): PgConnection {
    let currentTenant: string | null = null;
    let platformWrite = false;

    /** `WITH CHECK` for whichever of the three write policies could match this row. */
    function assertWritable(tenantId: string | null): void {
      if (tenantId === null) {
        if (!platformWrite) {
          throw new FakeRlsViolation(
            `a platform-scope row needs ${PLATFORM_WRITE_GRANTS.key}`,
          );
        }
        return;
      }
      if (tenantId !== currentTenant) {
        throw new FakeRlsViolation(
          `tenant ${tenantId} is not the session's scope (${String(currentTenant)})`,
        );
      }
    }

    const query = async (
      sql: string,
      params?: readonly unknown[],
    ): Promise<PgQueryResult> => {
      const p = params ?? [];

      if (sql.includes(PLATFORM_WRITE_GRANTS.key)) {
        platformWrite = true;
        return { rows: [], rowCount: 0 };
      }
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
        assertWritable((incoming.tenant_id ?? null) as string | null);
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
        // An UPDATE whose row no policy reaches matches zero rows; it does not raise. Only the
        // `WITH CHECK` on the row it would *write* raises, and the statement never changes
        // `tenant_id`, so the two predicates are the same one here.
        if (row === undefined || !writable(row, currentTenant, platformWrite)) {
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
        // The scope predicate the store carries beside RLS, in its two spellings. The inclusive
        // form has to be matched *first*: `(tenant_id = $2 OR tenant_id IS NULL)` contains the
        // strict form as a substring, so reading it as the strict one would drop the platform rows
        // the OR exists to keep — the fake asserting a shape it had misread.
        const inclusive = sql.match(/\(\s*tenant_id\s*=\s*\$(\d+)\s+OR\s+tenant_id IS NULL\s*\)/);
        if (inclusive !== null) {
          const idx = Number(inclusive[1]) - 1;
          visibleRows = visibleRows.filter(
            (r) => (r["tenant_id"] ?? null) === p[idx] || (r["tenant_id"] ?? null) === null,
          );
        } else if (/(^|\s|\()tenant_id IS NULL/.test(sql)) {
          visibleRows = visibleRows.filter((r) => (r["tenant_id"] ?? null) === null);
        } else {
          const tenantIdx = paramIndex(sql, "tenant_id");
          if (tenantIdx !== null) {
            visibleRows = visibleRows.filter((r) => (r["tenant_id"] ?? null) === p[tenantIdx]);
          }
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

/**
 * Which existing rows a write reaches — strictly narrower than `visible`, which is the whole point
 * of the split: a platform row is readable by anyone and writable only under the elevation.
 */
function writable(
  row: Record<string, unknown>,
  currentTenant: string | null,
  platformWrite: boolean,
): boolean {
  const tenantId = (row["tenant_id"] ?? null) as string | null;
  return tenantId === null ? platformWrite : tenantId === currentTenant;
}
