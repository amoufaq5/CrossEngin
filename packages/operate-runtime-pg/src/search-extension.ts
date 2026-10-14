import type { PgConnection } from "@crossengin/kernel-pg";

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
 */

/** What provisioning answered, so a boot line can say it rather than a request discovering it. */
export const SEARCH_EXTENSION_OUTCOMES = ["present", "created", "refused"] as const;
export type SearchExtensionOutcome = (typeof SEARCH_EXTENSION_OUTCOMES)[number];

export interface SearchExtensionResult {
  readonly outcome: SearchExtensionOutcome;
  /** The driver's own message on `refused`, and null otherwise. */
  readonly detail: string | null;
}

/**
 * Whether `?q=` and `[contains]` can be served at all.
 *
 * A total map rather than `outcome !== "refused"`, so a fourth outcome has to say which side of the
 * one question that matters it falls on.
 */
export const SEARCH_EXTENSION_SERVES: Readonly<Record<SearchExtensionOutcome, boolean>> =
  Object.freeze({ present: true, created: true, refused: false });

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
export async function ensureSearchExtension(conn: PgConnection): Promise<SearchExtensionResult> {
  try {
    const probe = await conn.query<{ readonly installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS installed",
    );
    // Asked rather than inferred from the CREATE's own result, which answers the same for an
    // extension it installed and one it found (ADR-0330's rule). The distinction is worth one query
    // because it is what tells an operator whether their own init SQL is doing its job.
    if (probe.rows[0]?.installed === true) return { outcome: "present", detail: null };
    await conn.query("CREATE EXTENSION IF NOT EXISTS unaccent;");
    return { outcome: "created", detail: null };
  } catch (err) {
    return { outcome: "refused", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The boot sentence, said in all three cases.
 *
 * `present` and `created` are stated rather than left silent for the reason every survey in this
 * binary is: "we checked and search works" cannot be inferred from the absence of a line, and this
 * is a capability whose failure mode was an empty dropdown that looks like empty data.
 */
export function searchExtensionLine(result: SearchExtensionResult): string {
  switch (result.outcome) {
    case "present":
      return "[search] unaccent: present — ?q= and [contains] are serveable";
    case "created":
      return "[search] unaccent: created — ?q= and [contains] are serveable";
    case "refused":
      return (
        "[search] unaccent: REFUSED — ?q= and every [contains] filter will answer 500, and a" +
        " reference picker's typeahead will show an EMPTY dropdown rather than an error, which" +
        " reads as no matching records. Install it as a superuser once:" +
        ` CREATE EXTENSION IF NOT EXISTS unaccent;  (${result.detail ?? "no detail"})`
      );
  }
}
