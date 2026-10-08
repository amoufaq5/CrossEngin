import { PLATFORM_WRITE_GRANTS, type PgConnection, type PgQueryResult } from "@crossengin/kernel-pg";
import { dataKeyWrapAad, wrapDataKey } from "@crossengin/crypto";

import { TENANT_CONTEXT_GUC } from "./tenant-context.js";

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

/** One statement a fake recorded, and whether it ran inside a transaction. */
export interface CapturedStatement {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
  /** False for a statement issued outside `transaction`, which is the defect ADR-0335 found twice. */
  readonly inTx: boolean;
}

export interface FakeDataKeysOptions {
  /**
   * Run as the table's owner: RLS is not applied at all, so the statement's own predicate is the
   * only thing left. Both arms exist because this class of defect is invisible from either vantage
   * alone — a non-owner's unscoped statement is refused by the policy whether the store carries a
   * predicate or not.
   */
  readonly owner?: boolean;
  readonly seedRows?: readonly Record<string, unknown>[];
  /**
   * Answers a statement this fake does not model, consulted **before** every rule below, with
   * `null` falling through to them.
   *
   * It exists for the rekey, which runs a key rotation's catalog reads, row counts, `UPDATE`s and
   * confirm passes against the *entity* schema in the same transaction as the key row's own
   * statements. Those are not `meta.tenant_data_keys` statements and must not be judged by its
   * tripwires: a catalog query carries no `tenant_id` predicate and would be refused for it, which
   * would be the fake asserting a rule about a table the statement does not touch.
   */
  readonly answer?: (sql: string, params: readonly unknown[]) => PgQueryResult | null;
}

export interface FakeDataKeysPg {
  readonly conn: PgConnection;
  readonly captured: readonly CapturedStatement[];
  readonly rows: Record<string, unknown>[];
}

/** Thrown where Postgres raises `new row violates row-level security policy`. */
class FakeDataKeyRlsViolation extends Error {
  constructor(detail: string) {
    super(
      `new row violates row-level security policy for table "tenant_data_keys": ${detail}`,
    );
    this.name = "FakeDataKeyRlsViolation";
  }
}

/**
 * In-memory `meta.tenant_data_keys` with RLS-like scoping, modelled on `fakeCryptoKeysPg` above.
 *
 * Two tripwires carry the weight, and both are the point of having a fake at all rather than a
 * recorder: a **write** with no `tenant_id` — the bound column on an INSERT, the predicate on a
 * DELETE — throws, because as the owner such a statement reaches whichever scope's row it finds;
 * and a non-owner write whose tenant is not the session's scope raises, because this table's
 * isolation policy is its only arm and therefore the only thing carrying a `WITH CHECK`.
 *
 * It diverges from `fakeCryptoKeysPg` in one place: a **read** with no `tenant_id` predicate throws
 * here too. That fake exempts reads on purpose, because `classifyScopedWriteRefusal`'s diagnosing
 * re-read is deliberately unscoped and asks whether the row sits in another scope. This store has
 * no such re-read, so there is nothing to exempt and the stricter rule costs nothing.
 *
 * It lives here rather than in one test file because the rekey exercises the same table through a
 * second module, and two copies of a fake are two things to keep in agreement — which is the shape
 * of defect this repo keeps finding in lists nobody compares.
 */
export function fakeDataKeysPg(options: FakeDataKeysOptions = {}): FakeDataKeysPg {
  const owner = options.owner === true;
  const rows: Record<string, unknown>[] = [...(options.seedRows ?? [])];
  const captured: CapturedStatement[] = [];

  function makeClient(inTx: boolean): PgConnection {
    let currentTenant: string | null = null;

    function statementScope(sql: string, p: readonly unknown[], kind: string): string {
      const strict = sql.match(/tenant_id\s*=\s*\$(\d+)/);
      if (strict !== null) return String(p[Number(strict[1]) - 1]);
      throw new Error(
        `this fake refuses a ${kind} that carries no tenant_id predicate: as the table's owner ` +
          "it reaches whichever scope's row it finds",
      );
    }

    const query = async (
      sql: string,
      params?: readonly unknown[],
    ): Promise<PgQueryResult> => {
      const p = params ?? [];
      captured.push({ sql, params, inTx });

      const supplied = options.answer?.(sql, p) ?? null;
      if (supplied !== null) return supplied;

      if (sql.includes("set_config")) {
        // Only `app.current_tenant_id` rescopes the session. A rekey sets two key GUCs through
        // `set_config($1, $2, true)`, where the *name* is a bound parameter — so a fake reading
        // `p[0]` as a tenant id would rescope the session to the string
        // "app.column_encryption_key_old" and then refuse the rekey's own INSERT for naming a
        // tenant that is not the session's. Both spellings are read, and neither is assumed.
        if (sql.includes(TENANT_CONTEXT_GUC)) {
          currentTenant = (p[0] as string | null) ?? null;
        } else if (p[0] === TENANT_CONTEXT_GUC) {
          currentTenant = (p[1] as string | null) ?? null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("INSERT INTO")) {
        const columns = sql.match(/\(([^)]*)\)\s*VALUES/);
        if (columns === null || !/\btenant_id\b/.test(columns[1] ?? "")) {
          throw new Error(
            "this fake refuses an INSERT that does not name tenant_id: the column is NOT NULL and " +
              "is the row's whole scope",
          );
        }
        const names = (columns[1] ?? "").split(",").map((c) => c.trim());
        const row: Record<string, unknown> = {};
        names.forEach((name, i) => {
          row[name] = p[i];
        });
        const tenantId = String(row["tenant_id"]);
        if (!owner && tenantId !== currentTenant) {
          throw new FakeDataKeyRlsViolation(
            `tenant ${tenantId} is not the session's scope (${String(currentTenant)})`,
          );
        }
        const duplicate = rows.some(
          (r) =>
            r["tenant_id"] === row["tenant_id"] && r["generation"] === row["generation"],
        );
        if (duplicate) {
          const err = new Error(
            'duplicate key value violates unique constraint "tenant_data_keys_tenant_generation_key"',
          );
          (err as Error & { code?: string }).code = "23505";
          throw err;
        }
        rows.push(row);
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("DELETE FROM")) {
        const scope = statementScope(sql, p, "DELETE");
        // `generation <= $n` is applied rather than ignored, which is not a nicety: the rekey's
        // DELETE retires the generations it rotated *from* and must not reach the one it has just
        // written. A fake that dropped the conjunct would show every rekey destroying its own new
        // key row and still reporting success.
        const bound = sql.match(/generation\s*<=\s*\$(\d+)/);
        const ceiling = bound === null ? null : Number(p[Number(bound[1]) - 1]);
        const doomed = rows.filter(
          (r) =>
            r["tenant_id"] === scope &&
            (owner || r["tenant_id"] === currentTenant) &&
            (ceiling === null || Number(r["generation"]) <= ceiling),
        );
        for (const r of doomed) rows.splice(rows.indexOf(r), 1);
        return { rows: [], rowCount: doomed.length };
      }

      if (sql.includes("SELECT")) {
        const scope = statementScope(sql, p, "SELECT");
        let visible = rows.filter((r) => owner || r["tenant_id"] === currentTenant);
        visible = visible.filter((r) => r["tenant_id"] === scope);
        const generation = sql.match(/generation\s*=\s*\$(\d+)/);
        if (generation !== null) {
          const want = p[Number(generation[1]) - 1];
          visible = visible.filter((r) => r["generation"] === want);
        }
        if (sql.includes("ORDER BY generation DESC")) {
          visible = [...visible].sort(
            (a, b) => Number(b["generation"]) - Number(a["generation"]),
          );
        }
        if (/LIMIT 1/.test(sql)) visible = visible.slice(0, 1);
        return { rows: visible, rowCount: visible.length };
      }

      return { rows: [], rowCount: 0 };
    };

    return {
      query: query as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
        // This fake rolls back where `fakeCryptoKeysPg` does not, because the property the rekey
        // exists to have is that the ciphertext and the key row land together or not at all — and a
        // fake that kept a half-written row would show a *failed* rekey as having written one, which
        // is the exact outcome the design refuses. Statements stay in `captured` either way: what
        // was attempted is as interesting as what survived.
        const snapshot = rows.map((r) => ({ ...r }));
        try {
          return await fn(makeClient(true));
        } catch (error) {
          rows.splice(0, rows.length, ...snapshot);
          throw error;
        }
      }) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
  }

  return { conn: makeClient(false), captured, rows };
}

export interface StoredDataKeyRowOptions {
  readonly generation?: number;
  readonly kekGeneration?: number;
  readonly provenance?: string;
  /** Wrap against a different tenant's AAD, which is what a row copied between tenants looks like. */
  readonly aadTenantId?: string;
}

/** A `meta.tenant_data_keys` row as node-postgres would hand it back. */
export function storedDataKeyRow(
  kek: Uint8Array,
  tenantId: string,
  dek: Uint8Array,
  options: StoredDataKeyRowOptions = {},
): Record<string, unknown> {
  const generation = options.generation ?? 1;
  return {
    tenant_id: tenantId,
    generation,
    wrapped_key: Buffer.from(
      wrapDataKey(kek, dek, dataKeyWrapAad(options.aadTenantId ?? tenantId, generation)),
    ),
    kek_generation: options.kekGeneration ?? 1,
    provenance: options.provenance ?? "random",
  };
}
