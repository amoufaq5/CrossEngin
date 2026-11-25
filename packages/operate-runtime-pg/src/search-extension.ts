import type { PgConnection } from "@crossengin/kernel-pg";

import {
  ensureSearchFunction,
  probeSearchIndexReach,
  searchFunctionLine,
  type SearchFunctionProbe,
  type SearchIndexReachProbe,
  type SearchStoreKind,
} from "./search-function.js";
import {
  auditSupersededTrigramIndexes,
  supersededTrigramLine,
  type SupersededTrigramAudit,
} from "./trigram-index-audit.js";

/**
 * Provisions `unaccent`, which the search predicate calls and only one of the two stores installed.
 *
 * `list-sql.ts` is shared by **both** Postgres stores -- it is where `?q=` and `[contains]` become
 * SQL -- and it emits `unaccent(<expr>::text) ILIKE …` unconditionally. The extension behind that
 * call was created in exactly one place, `ensureColumnStoreExtensions`, whose only caller is the
 * per-tenant **column-store** applier. So on `--store pg`, which is the shipped compose default,
 * nothing ever created it and every search was
 *
 *     ERROR:  function unaccent(text) does not exist
 *
 * surfacing as a **500**, not as a slow query. The register had this recorded as an indexing
 * problem ("every list search is an unindexed table scan"), which is true of the column store and
 * understates the document store by a category: a scan returns the right rows late, and this
 * returns none at all.
 *
 * The sharpest symptom is not the 500. The reference picker's typeahead issues
 * `?<field>[contains]=<needle>` and renders an **empty dropdown** on failure rather than an error,
 * so on `erp-core` the 53 of 78 reference fields whose picker searches server-side looked like
 * *there is nothing to choose* -- a wrong answer, which this repo ranks below a refusal, in the one
 * control a user needs to create a record that points at another.
 *
 * Why a function of its own rather than a line added to `ensureColumnStoreExtensions`: that function
 * provisions what the column store's **DDL** depends on (pgcrypto for ciphertext columns, `pg_trgm`
 * for the per-column trigram indexes it emits), and `unaccent` is not in that category. It is what
 * the **query builder** depends on, and the query builder serves both stores -- so attaching it to
 * one store's DDL is how it came to be missing from the other. It is deliberately `unaccent` alone:
 * `pg_trgm` accelerates indexes only the column store emits, and creating it for the document store
 * would install an extension nothing there can use.
 *
 * ## That argument is true of `unaccent` and **does not extend to `ce_unaccent`**
 *
 * It was written for the extension and then carried, unexamined, to the IMMUTABLE wrapper beside it,
 * and the wrapper is in **both** categories: `list-sql.ts` names it (the query builder's dependency,
 * and since `entity-ops.ts` declared its own fold, only for the column store) *and* `entity-ddl.ts`
 * names it inside the index expression it emits (the column store's **DDL** dependency, which did
 * not exist before ADR-0383). So the clause above stops applying the moment the index expression
 * starts naming the function -- an argument that expired in the same increment that created the
 * thing it was being applied to, which is ADR-0364's class.
 *
 * The consequence is not cosmetic and is why this is written down rather than quietly amended.
 * `ensureSearchFunction` reaches the **boot** path only: `node.ts` calls `ensureSearchExtension`
 * before `store.ensureSchema()`, and `applyTenantManifestSchema` calls `ensureColumnStoreExtensions`
 * and never this. So a per-tenant activation provisions `pg_trgm` and not the function its own index
 * statements name, and the first `CREATE INDEX` aborts the applier's transaction. The wrapper
 * therefore belongs in **both** places -- here, for the query builder, and in
 * `ensureColumnStoreExtensions`, for the DDL -- out of one definition in `search-function.ts`, so
 * the two cannot drift. That second half is the ADR-0383 open question, because
 * `ensureColumnStoreExtensions` is outside this increment's file ownership.
 */

/**
 * What provisioning answered, so a boot line can say it rather than a request discovering it.
 *
 * `refused` and `unreachable` are separate members because their remedies are opposite (ADR-0472).
 * `refused` is Postgres answering the `CREATE EXTENSION` with an error of its own — a privilege, an
 * unavailable extension, a missing control file — and the remedy is to install it as a superuser.
 * `unreachable` is a statement that never got an answer from a database at all: the connection was
 * refused, reset, timed out, or its TLS handshake failed. Printing *"install it as a superuser"* to
 * an operator whose `PGHOST` points nowhere is a remedy that cannot work (ADR-0334) — it sends them
 * to a privilege problem that does not exist while the real one is the address. `unreadable` is the
 * third answer: the database answered the probe of `pg_extension` with an error, so nothing about
 * the extension was established and no `CREATE` was attempted.
 */
export const SEARCH_EXTENSION_OUTCOMES = ["present", "created", "refused", "unreachable", "unreadable"] as const;
export type SearchExtensionOutcome = (typeof SEARCH_EXTENSION_OUTCOMES)[number];

/**
 * Whether an error is a failure to reach a database rather than a database's answer.
 *
 * Read off the SQLSTATE, because that is the one field that says which side of the wire produced
 * the error: node-postgres sets `code` from the server's `ErrorResponse` and leaves it unset — or
 * sets a Node `errno` string such as `ECONNREFUSED` — for a socket or TLS failure. Class `08`
 * (connection exception) and `57P` (operator intervention: admin shutdown, crash shutdown, cannot
 * connect now) are the server's own words for "this connection is not usable", so they count as
 * unreachable too, and so do class `28` and `3D000`, which are raised only while a session is being
 * established. Every other five-character SQLSTATE is the database answering.
 */
export function isConnectionLevelError(err: unknown): boolean {
  const code = (err as { readonly code?: unknown } | null)?.code;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return true;
  // A Node errno that happens to be five characters — `EPIPE` on a socket the server closed mid-query,
  // `EPERM`, `ENXIO`, `EBUSY` — passes the shape test above, and read as a SQLSTATE it would be the
  // database "answering" and print the superuser remedy. No SQLSTATE class begins with `E` (the
  // classes are 00–58, `F0`, `HV`, `P0` and `XX`), so a leading `E` is always a socket's word.
  if (code.startsWith("E")) return true;
  // Class `28` (a wrong password, an unknown role) and `3D000` (no such database) are SQLSTATEs, but
  // the server raises them only while *establishing* the session: the remedy is the connection
  // settings, and reading them as the database answering a catalog read would print
  // "?q= may answer 500" about a process that never got a session.
  return code.startsWith("08") || code.startsWith("57P") || code.startsWith("28") || code === "3D000";
}

export interface SearchExtensionResult {
  readonly outcome: SearchExtensionOutcome;
  /** The driver's own message on `refused`, `unreachable` or `unreadable`, and null otherwise. */
  readonly detail: string | null;
  /**
   * The IMMUTABLE wrapper the predicate names, provisioned and checked in the same pass.
   *
   * Here rather than in a second boot step because the predicate depends on the dictionary *and*
   * the wrapper, in that order, and splitting them across two call sites is how the extension came
   * to be created by one store's DDL and missing from the other store entirely (ADR-0166). One
   * call, one ordered pass, one boot block.
   */
  readonly searchFunction: SearchFunctionProbe;
  /** Bare-column trigram indexes an earlier manifest left behind, which nothing drops. */
  readonly supersededIndexes: SupersededTrigramAudit;
  /**
   * How far an `ILIKE` predicate can reach a trigram index on this session.
   *
   * Carried on the result rather than resolved inside the renderer, so the boot line is a pure
   * function of what this pass established — and so a caller that wants the fact for a route or a
   * report can read it without issuing the query a second time.
   */
  readonly indexReach: SearchIndexReachProbe;
}

/*
 * `SEARCH_EXTENSION_SERVES` is deleted (ADR-0472). It was a total map from outcome to "can `?q=` be
 * served", and nothing but its own test read it — while the question it answered is not a property
 * of the extension alone: with `unaccent` present in another schema both stores' folds raise, which
 * is why `extensionLine` stopped making the claim. A total map nobody reads is a constant nobody
 * reads (ADR-0344); the exhaustive switch in `extensionLine` is the compile-time fence a new outcome
 * needs, and it says what is true of each.
 */

/**
 * Creates `unaccent` if it is absent, and **reports** rather than throwing when it cannot.
 *
 * Reported and not fatal, on this repo's own split: a deployment with no search still serves every
 * list, every record, every filter and every sort, so refusing the boot would take a working
 * deployment down to close a gap in one surface (ADR-0338's rule read the other way, as ADR-0359
 * read it for the same module). `CREATE EXTENSION` needs privileges the serving role may not hold
 * in a least-privilege deployment, and that operator has made a deliberate choice this must not
 * override.
 *
 * `IF NOT EXISTS` makes the common case a no-op, so this is safe to call on every boot, and the
 * `present`/`created` split is only for the boot line -- both serve.
 */
export async function ensureSearchExtension(
  conn: PgConnection,
  /**
   * The table the reach is asked of — `searchReachTable` — or null to claim nothing about it.
   * Required, so a caller cannot inherit an ownership guess: the default this replaced inferred the
   * reach from the role alone and printed a reach the shipped role does not have.
   */
  reachTable: string | null,
): Promise<SearchExtensionResult> {
  const extension = await ensureUnaccentExtension(conn);
  // A database this pass cannot reach answers nothing else either, and every probe below would only
  // repeat the same connection error as three more lines with three more remedies.
  if (extension.outcome === "unreachable") {
    return {
      ...extension,
      searchFunction: { state: "unreadable", detail: extension.detail },
      supersededIndexes: { indexes: null, detail: extension.detail },
      indexReach: { reach: "unknown", table: reachTable, detail: "the database could not be reached" },
    };
  }
  // After the extension, never before: the wrapper's body pins `public.unaccent`, so a function
  // created ahead of its dictionary reports a state that is true of the text and false of every
  // call. `ensureSearchFunction` re-probes for exactly that reason, so this ordering is belt and
  // braces rather than the only fence -- but it is what makes the common path report `created`
  // instead of `dictionary_absent`.
  const searchFunction = await ensureSearchFunction(conn);
  const supersededIndexes = await auditSupersededTrigramIndexes(conn);
  const indexReach = await probeSearchIndexReach(conn, reachTable);
  return { ...extension, searchFunction, supersededIndexes, indexReach };
}

async function ensureUnaccentExtension(
  conn: PgConnection,
): Promise<{ readonly outcome: SearchExtensionOutcome; readonly detail: string | null }> {
  let installed: boolean;
  try {
    const probe = await conn.query<{ readonly installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS installed",
    );
    // Asked rather than inferred from the CREATE's own result, which answers the same for an
    // extension it installed and one it found (ADR-0330's rule). The distinction is worth one query
    // because it is what tells an operator whether their own init SQL is doing its job.
    installed = probe.rows[0]?.installed === true;
  } catch (err) {
    // The probe never reached a CREATE, so this is never `refused`: either nothing answered, or the
    // database answered a catalog read with an error and nothing was established either way.
    return {
      outcome: isConnectionLevelError(err) ? "unreachable" : "unreadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (installed) return { outcome: "present", detail: null };
  try {
    await conn.query("CREATE EXTENSION IF NOT EXISTS unaccent;");
    return { outcome: "created", detail: null };
  } catch (err) {
    return {
      outcome: isConnectionLevelError(err) ? "unreachable" : "refused",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The boot sentence, said in every outcome.
 *
 * `present` and `created` are stated rather than left silent for the reason every survey in this
 * binary is: "we checked and search works" cannot be inferred from the absence of a line, and this
 * is a capability whose failure mode was an empty dropdown that looks like empty data.
 */
export function searchExtensionLine(result: SearchExtensionResult, store: SearchStoreKind): string {
  // One joined block rather than three call sites, so a `console.info` in the binary need not know
  // how many facts this pass established — which is what kept the wrapper and the superseded-index
  // audit out of `apps/operate-server/src/node.ts` entirely. The superseded line is absent on a
  // converged deployment, so the normal boot is two lines.
  // An unreachable database is one line, and it names no remedy but the address: the function
  // probe and the superseded-index audit were never asked, so printing their `unreadable` arms would
  // be three sentences about one connection error.
  if (result.outcome === "unreachable") return extensionLine(result);
  const lines = [
    extensionLine(result),
    searchFunctionLine(result.searchFunction, store, result.indexReach),
  ];
  const superseded = supersededTrigramLine(result.supersededIndexes);
  if (superseded !== null) lines.push(superseded);
  return lines.join("\n");
}

function extensionLine(result: SearchExtensionResult): string {
  switch (result.outcome) {
    // No serveability claim on these two arms, which there used to be ("?q= and [contains] are
    // serveable"): with unaccent installed in some other schema this line read `present` while
    // both stores' folds raised for want of `public.unaccent` (measured, the `dictionary_absent`
    // state), and on --store pg-columns it read `present` while the next line said ABSENT. Whether
    // search is served is a fact about the dictionary, the wrapper and the store together, and the
    // next line is the one that holds all three.
    case "present":
      return "[search] unaccent: present";
    case "created":
      return "[search] unaccent: created";
    case "refused":
      return (
        "[search] unaccent: REFUSED — ?q= and every [contains] filter will answer 500, and a" +
        " reference picker's typeahead will show an EMPTY dropdown rather than an error, which" +
        " reads as no matching records. Install it as a superuser once:" +
        ` CREATE EXTENSION IF NOT EXISTS unaccent;  (${result.detail ?? "no detail"})`
      );
    case "unreachable":
      // No remedy beyond the connection itself, deliberately: nothing about the extension, the
      // dictionary or any privilege was established, and a `CREATE EXTENSION` printed here is the
      // remedy-that-cannot-work this member exists to stop printing (ADR-0334).
      return (
        "[search] the database could not be reached, so nothing about unaccent, the search function" +
        ` or substring search was established — check the connection settings (${result.detail ?? "no detail"})`
      );
    case "unreadable":
      return (
        "[search] unaccent: the database answered the probe of pg_extension with an error, so nothing" +
        ` was established and no CREATE was attempted — ?q= may answer 500. (${result.detail ?? "no detail"})`
      );
  }
}
