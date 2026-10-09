/**
 * The `rekey` maintenance subcommand's own module: the shape of its options, the one question it
 * asks the database that `crypto-pg` cannot, and the two reports an operator reads.
 *
 * ## What this surface is for
 *
 * ADR-0347 shipped the per-tenant envelope and said in its own open ends that for an **existing**
 * deployment it bought the mechanism and not the horizon: every tenant already holding ciphertext
 * was given a data key *seeded* from ADR-0338's derived one, and a seeded key stays recomputable
 * from `COLUMN_ENCRYPTION_SECRET`, so destroying its row destroys nothing. `rekeyTenant` is what
 * moves such a tenant to a random key. This module is the operator's whole view of it.
 *
 * ## Why the wording is the deliverable here and not decoration
 *
 * The act is irreversible-adjacent in both directions. It rewrites every encrypted row this tenant
 * holds inside one transaction — so a failure costs nothing — and then it **destroys** the previous
 * generation, which is the whole product and is not undoable. And its most dangerous consequence
 * outlives the transaction entirely: a serving process still holding the previous key in
 * `buildEnvelopeKeySource`'s cache goes on *writing* under it. So three sentences carry weight that
 * no amount of correct SQL can carry for them, and each has its own function below:
 *
 * - an **empty plan** must make the wrong `--data-schema` the obvious hypothesis, because one
 *   `--schema` flag drives two stores with two different defaults (`meta` for the wrapped key,
 *   `public` for the ciphertext) and a wrong data schema is indistinguishable from a tenant that
 *   genuinely holds nothing;
 * - the **result** must state the horizon the rekey bought in words, and those words are read off
 *   `data-key-envelope.ts`'s own map rather than written again here — ADR-0347 exists partly to
 *   correct the overclaim that destruction makes PHI "unrecoverable including from backups", and a
 *   second spelling of the corrected claim is a second thing to get wrong;
 * - the **stale key window** must name the hazard *and* the remedy, because the hazard is the one
 *   this increment creates and a TTL bounds it rather than closing it.
 *
 * Nothing either formatter returns carries a key, a wrapped key, a ciphertext or a row's contents.
 * That holds by construction rather than by filtering: `TenantRekeySurvey.current` deliberately
 * omits the dek, and everything else printed here is a catalog name, a count or one of this
 * module's own sentences.
 *
 * The CLI parse (`parseRekeyArgs`, `rekeyHelpText`) and the runner (`runRekey`) live in `cli.ts` and
 * `node.ts`, following `replay.ts`: the pure module holds the vocabulary and the rendering, and the
 * argv and the connection stay with the two files that own them.
 */

import type { KeyRotationPlan, PgConnection } from "@crossengin/kernel-pg";
import type { DataKeyProvenance, TenantRekeyResult, TenantRekeySurvey } from "@crossengin/crypto-pg";
import {
  TenantLifecycleStateSchema,
  blocksWrites,
  type TenantLifecycleState,
} from "@crossengin/tenant-lifecycle";

import {
  COLUMN_KEY_MODE_FLAG,
  COLUMN_KEY_TTL_FLAG,
  formatShreddability,
  shreddabilityOf,
} from "./data-key-envelope.js";

/** Options for the `rekey` maintenance subcommand. Parsed in `cli.ts`; shaped here. */
export interface RekeyOptions {
  readonly tenantId: string;
  /**
   * The same tenant id, typed a second time.
   *
   * `--tenant-erasure-routes`' `confirmTenantId` rule: the destructive half of this operation is a
   * `DELETE` of the only copy of a key, so it must not be one mistyped path segment — or here, one
   * shell-history arrow key — away.
   */
  readonly confirmTenantId: string;
  /** Survey only: print the plan and the row counts, write nothing. */
  readonly plan: boolean;
  /** Meta schema holding `tenant_data_keys` (default `meta`). */
  readonly schema: string | null;
  /** Schema holding the encrypted entity tables (default `public`). */
  readonly dataSchema: string | null;
  /** Proceed although the tenant's status still permits writes. */
  readonly allowLiveRekey: boolean;
  /**
   * The serving fleet's `--column-key-ttl-ms`, or `null` when the operator did not say.
   *
   * This process does not run the gateway, so it cannot read that value — and the stale-key window
   * is the one figure here whose understatement is dangerous, because an operator who believes the
   * window has lapsed resumes writes while a replica still holds the previous key. Absent, the line
   * prints the default and says it is a default and unread.
   */
  readonly columnKeyTtlMs: number | null;
  readonly format: "human" | "json";
  readonly help: boolean;
}

export const TENANT_WRITE_STATUSES = ["blocks_writes", "permits_writes", "no_tenant_row"] as const;
export type TenantWriteStatus = (typeof TENANT_WRITE_STATUSES)[number];

/** The app's schema-identifier shape, the same pattern ten other `meta.*` readers here validate. */
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

function quoteIdent(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

/**
 * Whether this tenant can still be written to while the rekey runs.
 *
 * Read from `meta.tenants.status` through `@crossengin/tenant-lifecycle`'s `blocksWrites` —
 * **called, never restated**, which is ADR-0334's rule for this exact column: the gate it added
 * reads the same predicate rather than listing the states a second time, and a second list is what
 * let `tenant-lifecycle` declare seven states while the deployment could store four.
 *
 * `no_tenant_row` is a third value and is deliberately **not** folded into `permits_writes`. An
 * `--api-key 'key:role:tenant'` principal names an arbitrary UUID with no `meta.tenants` row in any
 * dev deployment — ADR-0334's own boot survey exists because it found exactly that — so treating an
 * absence as "permits writes" would make the caller supply `--allow-live-rekey` precisely where the
 * flag's warning is least meaningful, and an operator who learns to pass it there passes it
 * everywhere.
 *
 * Two things this read does **not** do, both unlike every other statement in this increment:
 * it sets no tenant context and carries no scope predicate beyond the id. `meta.tenants` has no
 * `tenant_id` column and no RLS block at all — the row *is* the tenant — so there is nothing for a
 * context to confine and no owner-bypass asymmetry to close. Saying so here is worth a line,
 * because the neighbouring reads all need both arms and an absent one usually means somebody forgot.
 */
export async function probeTenantWriteStatus(
  conn: PgConnection,
  schema: string,
  tenantId: string,
): Promise<TenantWriteStatus> {
  // Refused before the round trip, and then quoted anyway. Two defences for one argv-sourced
  // identifier going into SQL text: the regex is what refuses, and the quoting is what keeps the
  // statement correct for a schema that merely happens to collide with a keyword.
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  const result = await conn.query<{ readonly status: unknown }>(
    `SELECT status FROM ${quoteIdent(schema)}.${quoteIdent("tenants")} WHERE id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) return "no_tenant_row";
  // Parsed through the contract's own enum and **not** defaulted. A status the contract forbids and
  // the column CHECK permits raises here rather than resolving to one of the three answers, which
  // is `tenantStatusDirectoryFromStore`'s choice for the same column and ADR-0289's rule: a row
  // edited into an impossible state is a finding, and the one thing it must not do is decide
  // whether this rekey needs an operator's override.
  const state: TenantLifecycleState = TenantLifecycleStateSchema.parse(row.status);
  return blocksWrites(state) ? "blocks_writes" : "permits_writes";
}

/**
 * One line per status, as a **total map** so a fourth answer is a compile error rather than one
 * inheriting whichever branch a chain ended on.
 *
 * Each says what the status means **for the rekey**, which is not the same as what it means for the
 * request path: `blocks_writes` is the *good* answer here, and a line that merely reported the state
 * would leave an operator to work that inversion out for themselves.
 */
export const TENANT_WRITE_STATUS_DETAIL: Readonly<Record<TenantWriteStatus, string>> =
  Object.freeze({
    blocks_writes:
      "this tenant's lifecycle state refuses writes — but only on a process running " +
      "--tenant-status-gate, which is OPT-IN and off by default, so on a deployment without it " +
      "this status is advisory and the fleet goes on accepting writes. With the gate, this is the " +
      "state to rekey in; without it, the unconditional remedy is to stop or roll the serving " +
      "processes for the rekey and the stale-key window after it",
    permits_writes:
      "this tenant can still be written to, so a serving process holding the previous key in its " +
      "cache may write a column under it after the rekey commits, splitting this tenant's data " +
      "across two keys — suspend the tenant for the duration, or accept the window with " +
      "--allow-live-rekey",
    no_tenant_row:
      "no row in meta.tenants names this tenant, so its lifecycle state cannot be read and no " +
      "claim is made in either direction; an api-key principal naming a UUID that was never " +
      "provisioned reads this way, and so does a tenant id that is simply wrong",
  });

/**
 * The provenance a rekey always writes.
 *
 * `rekeyWithin` takes no provenance parameter and writes `random` unconditionally — seeding exists
 * only to keep *existing* ciphertext readable, and the rekey has just rewritten that ciphertext, so
 * there is no such thing as a seeded rekey. `TenantRekeyResult` therefore carries no `toProvenance`
 * field, and this is where the result line's claim about the new row comes from.
 */
const PROVENANCE_AFTER_REKEY: DataKeyProvenance = "random";

/** `30000` reads as `30s`; a value that is not whole seconds keeps its unit rather than rounding. */
function renderMs(ms: number): string {
  return ms % 1000 === 0 ? `${(ms / 1000).toString()}s` : `${ms.toString()}ms`;
}

/** `schema.table.column (class)`, the only identifiers either report prints. */
function columnLabel(plan: KeyRotationPlan): string {
  return `${plan.table}.${plan.column} (${plan.dataClass ?? "?"})`;
}

/**
 * What destroying this tenant's key row is worth **today**.
 *
 * With a row, read straight off `data-key-envelope.ts`'s map, and passing `"envelope"` is not an
 * assumption about the deployment's `--column-key-mode`: the row's own existence is the evidence,
 * since `derived` mode writes none.
 *
 * With **no** row the shared sentence is not reused, and that is the one place this module spells a
 * line the envelope module otherwise owns. `SHREDDABILITY_DETAIL.not_applicable` reads "no data key
 * row exists for this tenant: the column key is derived from `COLUMN_ENCRYPTION_SECRET` … and
 * stored nowhere", which is sound at its only other call site — the boot line, where the mode is in
 * hand — and is a claim about the deployment's configuration that *this* surface cannot make. An
 * operator running a rekey has supplied the secret and is almost certainly in `envelope` mode, where
 * a missing row means this tenant has never written an encrypted column (or the tenant id is
 * wrong), so the shared clause would be confidently false in the likeliest case. The verdict word is
 * the shared one; only the reason is local.
 */
function shreddabilityLine(provenance: DataKeyProvenance | null): string {
  if (provenance !== null) return formatShreddability(shreddabilityOf("envelope", provenance));
  return (
    "data key shreddability: not_applicable — no data key row exists for this tenant, so there is " +
    "nothing to destroy and no deletion horizon. Which of the two reasons it is — this deployment " +
    `runs ${COLUMN_KEY_MODE_FLAG} derived, or this tenant has never written an encrypted column — ` +
    "is not decidable from here, and the refusal above carries both"
  );
}

/**
 * What this rekey would do, and every reason it will not.
 *
 * Leads with the verdict on the header line and then the refusals, following `formatChainVerification`
 * and `formatReplayReport`: the first thing read has to be whether anything is going to happen.
 *
 * Deliberately **not** the plans' SQL. `formatKeyRotationPlan` renders it and prints for nobody —
 * its only caller is `formatKeyRotationSurvey`, itself callerless — so this is a choice rather than
 * a contrast with a sibling surface; an earlier version of this comment justified it against
 * `crossengin-pg encrypt --plan`, which prints the encrypt-on-write migration from a different
 * planner and never a key rotation. The reason stands on its own: a rekey's operator is approving a
 * **row count and a lock window** for a transaction this binary runs itself, so printing the
 * UPDATEs would bury the counts under statements nobody is meant to execute.
 */
export function formatRekeySurvey(survey: TenantRekeySurvey, status: TenantWriteStatus): string {
  const lines: string[] = [];
  const refused = survey.refusals.length > 0;
  // `rowsToRewrite` is summed from per-plan counts that `surveyTenant` fills only when nothing
  // refuses, so the aggregate collapses `KeyRotationPlan.rowsToRewrite`'s null-is-not-0 distinction.
  // Asked of the plans rather than of `refusals`, so the qualifier tracks the thing it is about.
  const uncounted = survey.plans.some((p) => p.rowsToRewrite === null);
  const verdict = refused
    ? `REFUSED (${survey.refusals.length.toString()})`
    : `would rewrite ${survey.rowsToRewrite.toString()} row(s) across ` +
      `${survey.plans.length.toString()} column(s)`;
  lines.push(`rekey survey: tenant ${survey.tenantId} in schema ${survey.dataSchema} — ${verdict}`);

  if (refused) {
    for (const refusal of survey.refusals) {
      lines.push(`  REFUSED ${refusal.reason}: ${refusal.detail}`);
    }
    lines.push(
      "  nothing has been written, and nothing will be until every refusal above is cleared",
    );
  }

  if (survey.current === null) {
    lines.push("  current data key: none — no row in the data key table for this tenant");
  } else {
    lines.push(
      `  current data key: generation ${survey.current.generation.toString()}, ` +
        `kek generation ${survey.current.kekGeneration.toString()}, ` +
        `provenance ${survey.current.provenance}`,
    );
  }
  lines.push(`  ${shreddabilityLine(survey.current?.provenance ?? null)}`);

  if (survey.plans.length === 0) {
    // The wrong `--data-schema` first, because an empty plan is the only way that error shows up
    // and its output is byte-identical to a tenant that genuinely holds no ciphertext — where the
    // right action is to do nothing at all.
    lines.push(
      `  no ciphertext (bytea) column hinted crossengin.encrypt=at_rest in schema ` +
        `${survey.dataSchema} — check --data-schema before concluding this tenant holds none: ` +
        `the key row lives in the meta schema and the ciphertext in the data schema, and a tenant ` +
        `serving its own activated manifest holds its encrypted tables in its own schema`,
    );
    if (survey.alternativesWithCiphertext.length > 0) {
      lines.push(
        `  these schemas DO hold one: ${survey.alternativesWithCiphertext.join(", ")} — ` +
          `pass --data-schema with one of them`,
      );
    }
  } else {
    for (const plan of survey.plans) {
      // "not counted" and never 0: a confined session also reports 0, and the rekey's very next act
      // is to destroy the generation those uncounted rows are under.
      const rows =
        plan.rowsToRewrite === null
          ? "not counted"
          : `${plan.rowsToRewrite.toString()} row(s) to rewrite`;
      lines.push(`  ${columnLabel(plan)} — ${rows}`);
    }
    // The total and the schema on one line, unconditionally rather than only on the header's clean
    // path: this is the figure an operator is approving as a lock window, and it must not be a
    // sentence that disappears exactly when something refused.
    const total =
      `  ${survey.rowsToRewrite.toString()} row(s) to rewrite in total across ` +
      `${survey.plans.length.toString()} column(s) in schema ${survey.dataSchema}`;
    lines.push(
      uncounted
        ? `${total} — excluding every column above whose rows were not counted, so it is a lower ` +
          `bound and not a measurement`
        : total,
    );
  }

  // Reported, not filtered. A column hinted `encrypt=at_rest` but still stored as text is plaintext
  // at rest: a rekey cannot re-encrypt what was never encrypted, and dropping it silently is how
  // `formatKeyRotationPlan([])` came to claim an absence it had not checked.
  for (const col of survey.plaintextAtRest) {
    lines.push(
      `  SKIPPED ${col.table}.${col.column}: hinted encrypt=at_rest but stored as ` +
        `${col.dataType}, so it is plaintext at rest and no key protects it`,
    );
  }

  lines.push(`  write status: ${status} — ${TENANT_WRITE_STATUS_DETAIL[status]}`);
  return lines.join("\n");
}

/**
 * What the rekey did, what it bought, and the window it leaves behind.
 *
 * A returned `TenantRekeyResult` means the transaction committed, so every line here is a statement
 * about work that has happened — which is why the horizon claim belongs on this report and not on
 * the survey's, where it would describe a horizon nothing had bounded yet.
 */
export function formatRekeyResult(
  result: TenantRekeyResult,
  staleKeyWindowMs: number,
  stated: boolean,
): string {
  const lines: string[] = [
    `rekeyed tenant ${result.tenantId}: generation ${result.fromGeneration.toString()} → ` +
      `${result.toGeneration.toString()}, provenance ${result.fromProvenance} → ` +
      `${PROVENANCE_AFTER_REKEY}`,
  ];
  for (const column of result.columns) {
    lines.push(`  ${columnLabel(column)} — ${column.rowsReencrypted.toString()} row(s) re-encrypted`);
  }
  // Both totals, because their agreement is what licensed the commit: every rewritten row was
  // decrypted again under the new key before the transaction ended, and a disagreement would have
  // rolled the whole thing back rather than reported a difference here.
  lines.push(
    `  ${result.rowsReencrypted.toString()} row(s) re-encrypted, ` +
      `${result.rowsConfirmed.toString()} confirmed readable under the new key; ` +
      `${result.priorGenerationsDestroyed.toString()} earlier generation(s) destroyed`,
  );
  // The corrected claim, read off the one map that holds it rather than written a second time here.
  // ADR-0347 exists partly to retire "unrecoverable including from backups" — the wrapped key and
  // the ciphertext share one database, so one backup holds both — and a parallel sentence in this
  // file would be a second place for that overclaim to come back.
  lines.push(`  ${formatShreddability(shreddabilityOf("envelope", PROVENANCE_AFTER_REKEY))}`);
  lines.push(formatStaleKeyWindow(staleKeyWindowMs, stated));
  return lines.join("\n");
}


/**
 * The sentence an operator has to read, because the hazard outlives the transaction.
 *
 * The rekey commits out of process. A serving process holds the previous key in
 * `buildEnvelopeKeySource`'s cache, so until that entry expires its **reads** raise
 * `Wrong key or corrupt data` — loud, and never a wrong answer — while its **writes** encrypt new
 * values under the old key and split this tenant's data across two keys with nothing on any row
 * recording which. That is the unrecoverable direction, and a TTL bounds it rather than closing it.
 *
 * So the line names the remedy and not only the risk, in the order an operator can act on: a
 * restart drops an in-process cache at once, and holding the tenant in a write-blocking state for
 * the window removes the hazard instead of waiting it out. Closing the window properly would need
 * the serving process to be *told* a rekey happened, which is a different increment.
 */
export function formatStaleKeyWindow(staleKeyWindowMs: number, stated: boolean): string {
  // `stated` is the whole honesty of this line. This process does not run the gateway and cannot
  // read its `--column-key-ttl-ms`, so printing the default as though it were a measurement
  // understates the hazard by up to 10x for a fleet on the 300000ms ceiling — in the direction
  // where an operator resumes writes while a replica still holds the previous key. So an unstated
  // figure is labelled as the default and as unread, and `--column-key-ttl-ms` on this subcommand
  // is how an operator supplies the fleet's real value.
  const window = stated
    ? `${renderMs(staleKeyWindowMs)} (${COLUMN_KEY_TTL_FLAG}, as you stated it)`
    : `${renderMs(staleKeyWindowMs)} — the DEFAULT, not a reading: this process does not run the ` +
      `gateway and cannot see its ${COLUMN_KEY_TTL_FLAG}; pass it here to have this line reflect ` +
      `your fleet`;
  return (
    `  stale key window: ${window}. ` +
    `A serving process caches the previous key for up to that long, and this rekey committed out ` +
    `of process. Its READS raise "Wrong key or corrupt data" until the entry expires, which is ` +
    `loud and never a wrong answer; its WRITES encrypt new values under the previous key and ` +
    `split this tenant's columns across two keys with nothing on any row recording which — and ` +
    `that is not recoverable. Remedy, in order: restart or roll the serving processes, which drops the ` +
    `cache at once; or keep the tenant in a state that refuses writes until the window lapses. ` +
    `Lowering ${COLUMN_KEY_TTL_FLAG} shortens the window and does not close it — only a process ` +
    `that is told of the rekey could, and ${COLUMN_KEY_MODE_FLAG} derived has no window because ` +
    `it has no cached row.`
  );
}
