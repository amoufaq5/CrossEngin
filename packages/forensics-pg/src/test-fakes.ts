import { assertBindArity } from "@crossengin/testing";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

const CHECKPOINTS = "forensic_chain_checkpoints";
const ENTRIES = "forensic_chain_entries";

function paramIndex(sql: string, re: RegExp): number | null {
  const m = re.exec(sql);
  return m === null ? Number.NaN : Number(m[1]) - 1;
}

/**
 * The ascending keyset `scanCheckpoints` pages with, matched **specifically** rather than merely
 * truly: that statement also contains `sequence_number >= $1` and `sequence_number = $1`, which the
 * generic read branch's own regexes would read as a lower bound and an equality and so narrow the
 * page to the one sequence the cursor sits at. ADR-0363's lesson — a fake that answers the wrong
 * query's rows is a test asserting the wrong thing — so this arm is checked first and the capture
 * groups are the cursor's two parameter positions, which is what it needs anyway.
 */
const SCAN_KEYSET_RE =
  /sequence_number > \$(\d+)::bigint\s+OR \(sequence_number = \$\d+::bigint AND id (>=?) \$(\d+)::uuid\)/;

/**
 * What `uuid_generate_v7()` gives the `id` column, modelled only in the one property the scan's
 * cursor depends on: monotonic in insertion order, so the lexicographic comparison this fake makes
 * agrees with the byte comparison Postgres makes on a `uuid`.
 */
function syntheticRowId(n: number): string {
  const hex = n.toString(16).padStart(32, "0");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * Refuses an `INSERT` binding more parameters than this fake's row model reads, which is the one
 * thing `assertBindArity` structurally cannot see: that fence compares the statement's `$n` set
 * against the supplied array, so a column added to both agrees on arity and is then **dropped on the
 * floor here** (ADR-0371). That is ADR-0333's `fakeCertificationPg` hazard — a fake that silently
 * ignores a column is worse than no fake, because a round-trip test is answered from this side
 * table and passes while the real database stores nothing. Per branch, because the two statements
 * bind different counts, and a bare total would pass whichever branch happened to match.
 */
function assertModelsEveryParam(
  params: readonly unknown[],
  modelled: number,
  table: string,
): void {
  if (params.length !== modelled) {
    throw new Error(
      `fakeChainPg models ${modelled.toString()} columns of ${table} and the statement bound ` +
        `${params.length.toString()}: model the new column here, or this fake drops it silently`,
    );
  }
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
  let nextCheckpointRowId = 1;

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
      assertBindArity(sql, p);
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
          assertModelsEveryParam(p, 8, CHECKPOINTS);
          const tenant = (p[0] as string | null) ?? null;
          const seq = Number(p[1]);
          // `ON CONFLICT (tenant_id, sequence_number) DO NOTHING` **never fires for a platform
          // row**: `tenant_id` is nullable, NULL means platform, and SQL treats NULLs as distinct,
          // so `(NULL, 3)` twice is two legal rows (ADR-0371). Verified live on PG 16.13 — the same
          // pair of statements leaves 2 rows at one platform sequence and 1 at one tenant sequence.
          // Deduplicating both scopes made this fake **stricter than the real database**, which is
          // the hazard its own header describes for reads: an isolation the code never asked for
          // cannot catch a missing one, and here it meant no round trip through this fake could
          // hold the two rows the `id` tiebreaker and the scan's keyset exist for.
          const exists =
            tenant !== null &&
            checkpointRows.some(
              (r) => (r["tenant_id"] ?? null) === tenant && Number(r["sequence_number"]) === seq,
            );
          if (!exists) {
            checkpointRows.push({
              // Defaulted by the table (`uuid_generate_v7()`) rather than bound, so it is minted
              // here — and `assertModelsEveryParam` still counts the 8 the statement binds.
              id: syntheticRowId(nextCheckpointRowId),
              tenant_id: p[0] ?? null,
              sequence_number: p[1],
              root_hash: p[2],
              checkpointed_at: p[3],
              checkpointed_by: p[4],
              external_anchor_reference: p[5] ?? null,
              algorithm: p[6],
              provenance: p[7] ?? null,
            });
            nextCheckpointRowId += 1;
          }
          return { rows: [], rowCount: exists ? 0 : 1 };
        }
        assertModelsEveryParam(p, 11, ENTRIES);
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

        const keyset = SCAN_KEYSET_RE.exec(sql);
        if (keyset !== null) {
          const seqPos = Number(keyset[1]);
          const idPos = Number(keyset[3]);
          // The `id` arm's operator is read off the statement rather than assumed, which is what
          // makes this fake able to *show* the consequence of weakening it instead of refusing the
          // statement: with `>=` the cursor's own row is re-admitted, so a boundary inside a run of
          // one sequence re-reads it and a sequence holding a full page never advances at all.
          const idStrict = keyset[2] === ">";
          if (!Number.isInteger(seqPos) || !Number.isInteger(idPos)) {
            throw new Error("fakeChainPg: a keyset scan must bind both halves of its cursor");
          }
          // The order is asked for rather than supplied: this arm sorts by the pair, so a statement
          // ordering by anything else would be answered in an order it did not request and a test
          // over the rows could not tell the two apart (ADR-0363's rule — a fake must not answer a
          // statement it could not really serve).
          if (!sql.includes("ORDER BY sequence_number ASC, id ASC")) {
            throw new Error(
              "fakeChainPg: a keyset scan must order by the pair its cursor is made of",
            );
          }
          const afterSeq = Number(p[seqPos - 1]);
          const afterId = String(p[idPos - 1]);
          // The predicate as written, which is what makes this fake able to answer the question the
          // scan is about: after `(sequence, id)`, so two rows at one sequence are two distinct
          // positions rather than one.
          visible = visible.filter((r) => {
            const seq = Number(r["sequence_number"]);
            if (seq > afterSeq) return true;
            if (seq !== afterSeq) return false;
            const id = String(r["id"]);
            return idStrict ? id > afterId : id >= afterId;
          });
          visible = [...visible].sort(
            (a, b) =>
              Number(a["sequence_number"]) - Number(b["sequence_number"]) ||
              String(a["id"]).localeCompare(String(b["id"])),
          );
          const scanLimitIdx = paramIndex(sql, /LIMIT \$(\d+)/);
          if (scanLimitIdx === null || Number.isNaN(scanLimitIdx)) {
            // Not an answer this fake could really serve: without a bound limit the loop that reads
            // it cannot page, so returning the whole scope would make a paging test pass vacuously.
            throw new Error("fakeChainPg: a keyset scan must bind its LIMIT");
          }
          visible = visible.slice(0, Number(p[scanLimitIdx]));
          return { rows: visible, rowCount: visible.length };
        }

        // A read that compares `id` is a keyset the arm above did not recognise, and the generic
        // branch below would answer it with the *wrong* rows rather than badly: its
        // `sequence_number = $n` regex matches the disjunction's equality arm and narrows the page
        // to the one sequence the cursor sits at. So it is refused by name — the mutation that first
        // showed this answered an empty page and read as a behavioural failure.
        if (/\bid\s*>=?\s*\$\d+/.test(sql)) {
          throw new Error(
            `fakeChainPg: unrecognised keyset predicate — ${sql.replace(/\s+/g, " ").trim()}`,
          );
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
        // `NEWEST_AT_ONE_SEQUENCE`, modelled rather than assumed away. It mattered only once the
        // platform scope could hold two rows at one sequence (see the `ON CONFLICT` note above):
        // a stable sort on the sequence alone returns them in insertion order, i.e. the **older**
        // first — which is exactly the fail-open order ADR-0371 added that tiebreaker to fix, so an
        // unmodelled sort here would let a test assert the defect and pass.
        const newestFirst = sql.includes("checkpointed_at DESC, id DESC");
        visible = [...visible].sort((a, b) => {
          const bySequence =
            (Number(a["sequence_number"]) - Number(b["sequence_number"])) * (desc ? -1 : 1);
          if (bySequence !== 0 || !newestFirst) return bySequence;
          return (
            String(b["checkpointed_at"]).localeCompare(String(a["checkpointed_at"])) ||
            String(b["id"]).localeCompare(String(a["id"]))
          );
        });

        const limitIdx = paramIndex(sql, /LIMIT \$(\d+)/);
        if (limitIdx !== null && !Number.isNaN(limitIdx)) {
          visible = visible.slice(0, Number(p[limitIdx]));
        } else if (/LIMIT 1\b/.test(sql)) {
          visible = visible.slice(0, 1);
        }
        return { rows: visible, rowCount: visible.length };
      }
      // A statement this fake could not really serve raises rather than answering an empty result
      // (ADR-0350): `{rows: []}` here is a well-formed answer to a question nobody asked, so an
      // assertion about what a read *found* would pass vacuously the moment its shape changed.
      throw new Error(`fakeChainPg cannot serve this statement: ${sql.replace(/\s+/g, " ").trim()}`);
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
