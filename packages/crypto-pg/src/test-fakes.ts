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
 *
 * **And it models only a non-owner, which is how the write-side defect hid behind it.** A table's
 * owner bypasses its policies, and connecting as the owner is an ordinary deployment — so every
 * rule above is simply absent there, and the store's own predicate is the only thing left. With
 * `owner: true` the policies are not applied and a statement reaches whatever row its own `WHERE`
 * reaches, which is what a correct store must survive. Measured live on a fresh cluster, as the
 * owner, before the predicates existed: a platform-scope `register` **replaced a tenant's public
 * key**, and `revoke(<a tenant's key id>, null)` revoked a tenant's key. Both now refuse, and the
 * owner-mode tests are what keeps that true offline.
 */
export interface FakeCryptoKeysOptions {
  /**
   * Run as the table's owner: RLS is not applied at all. Both arms exist because this class of
   * defect is invisible from either vantage alone — a non-owner's cross-scope write is refused by
   * the policy whether the store carries a predicate or not.
   */
  readonly owner?: boolean;
}

export function fakeCryptoKeysPg(options: FakeCryptoKeysOptions = {}): PgConnection {
  const owner = options.owner === true;
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
      if (owner) return;
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
          return { rows: [], rowCount: 1 };
        }
        // `ON CONFLICT (key_id) DO UPDATE … WHERE crypto_keys.tenant_id IS NOT DISTINCT FROM
        // EXCLUDED.tenant_id`. A `DO UPDATE` whose `WHERE` is false matches no row — `INSERT 0 0`,
        // which is byte-identical to a `DO NOTHING` and is the silence `assertScopedWriteLanded`
        // turns into a named refusal. The guard is *required* to be present: a statement without it
        // is the pre-fix store, and a fake that quietly applied it anyway would be the member of
        // this class that hides the next one.
        if (!/tenant_id IS NOT DISTINCT FROM EXCLUDED\.tenant_id/.test(sql)) {
          throw new Error(
            "this fake refuses an upsert whose DO UPDATE does not pin the scope: without " +
              "`crypto_keys.tenant_id IS NOT DISTINCT FROM EXCLUDED.tenant_id` a platform " +
              "registration replaces whichever scope's row holds that key_id",
          );
        }
        if ((existing["tenant_id"] ?? null) !== ((incoming.tenant_id ?? null) as string | null)) {
          return { rows: [], rowCount: 0 };
        }
        rows.set(keyId, {
          ...existing,
          public_key_base64: incoming.public_key_base64,
          fingerprint_sha256: incoming.fingerprint_sha256,
          key_version: incoming.key_version,
          status: incoming.status,
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("UPDATE")) {
        const statusIdx = paramIndex(sql, "status");
        const keyIdIdx = paramIndex(sql, "key_id");
        if (statusIdx === null || keyIdIdx === null) return { rows: [], rowCount: 0 };
        const keyId = p[keyIdIdx] as string;
        const row = rows.get(keyId);
        if (row === undefined) return { rows: [], rowCount: 0 };
        // An UPDATE whose row no policy reaches matches zero rows; it does not raise. Only the
        // `WITH CHECK` on the row it would *write* raises, and the statement never changes
        // `tenant_id`, so the two predicates are the same one here. For the **owner** there is no
        // policy at all, which is the whole point: what is left is the statement's own predicate.
        if (!owner && !writable(row, currentTenant, platformWrite)) {
          return { rows: [], rowCount: 0 };
        }
        if (!matchesStatementScope(sql, p, row)) return { rows: [], rowCount: 0 };
        row.status = p[statusIdx];
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("SELECT")) {
        // The owner sees every row, which is what makes the diagnosing re-read in
        // `classifyScopedWriteRefusal` able to answer `wrong_scope` at all. A non-owner's same read
        // is confined by the policy and answers `row_absent` — the truth from that vantage, and the
        // reason this class is invisible from either role alone.
        let visibleRows = owner
          ? [...rows.values()]
          : [...rows.values()].filter((r) => visible(r, currentTenant));

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

/**
 * The `tenant_id` predicate a **statement** carries, applied independently of RLS.
 *
 * A write must carry one — `kernel-pg`'s strict `scopeFilter` — and a statement with none reaches
 * every scope's row as the owner, which is the defect. So "no predicate" is an error here rather
 * than a pass: a fake that silently ignored the column is how `fakeCertificationPg` hid this class
 * (CLAUDE.md's own note), and a fake that treats its absence as "match anything" hides it the same
 * way one level down.
 */
function matchesStatementScope(
  sql: string,
  p: readonly unknown[],
  row: Record<string, unknown>,
): boolean {
  const tenantId = (row["tenant_id"] ?? null) as string | null;
  const inclusive = sql.match(/\(\s*tenant_id\s*=\s*\$(\d+)\s+OR\s+tenant_id IS NULL\s*\)/);
  if (inclusive !== null) {
    throw new Error(
      "this fake refuses the inclusive scope arm on a write: `tenant_id = $n OR tenant_id IS NULL` " +
        "is a route from a tenant's session into the platform's row",
    );
  }
  const strict = sql.match(/tenant_id\s*=\s*\$(\d+)/);
  if (strict !== null) return tenantId === p[Number(strict[1]) - 1];
  if (/tenant_id IS NULL/.test(sql)) return tenantId === null;
  throw new Error(
    "this fake refuses a write that carries no tenant_id predicate: as the table's owner it " +
      "reaches whichever scope's row holds that id",
  );
}
