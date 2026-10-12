import { scopeFilter, type PgConnection } from "@crossengin/kernel-pg";
import {
  CONTENT_CATEGORIES,
  NOTIFICATION_CHANNELS,
  PreferenceMatrixEntrySchema,
  UserPreferenceMatrixSchema,
  isCategorySuppressible,
  isPreferenceOptedIn,
  requiresExplicitOptIn,
  type ContentCategory,
  type NotificationChannel,
  type PreferenceMatrixEntry,
  type UserPreferenceMatrix,
} from "@crossengin/notifications";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

/**
 * The writer `meta.notification_preferences` never had.
 *
 * ADR-0334's census classified this table `unwritten_table`, and it is the sharpest member of that
 * class after `meta.access_review_evidence`: `apps/operate-server/src/recipient-resolver.ts` READS
 * it on every drained dispatch (`preferencesFor`) to build each recipient's `UserPreferenceMatrix`,
 * and nothing has ever written a row — so every user's preferences have been the built-in defaults
 * for ever, and a tenant turning a category off has nowhere for that to land. The whole of the
 * notification stack's consent vocabulary — the five categories, the six channels, ADR-0302's
 * consent-vs-deliverability split, `computeDispatchEligibility`'s `not_opted_in` branch — was
 * unreachable by construction, because `isPreferenceOptedIn` can only answer from an entry and
 * nothing could make one.
 *
 * **Unlike the read-state tables of ADR-0330, this one has NOT drifted.** Verified against a live
 * applied catalog: nine columns, the three CHECKs enumerate exactly `CONTENT_CATEGORIES`,
 * `NOTIFICATION_CHANNELS` and the contract's five sources, and `updated_at` is `TIMESTAMPTZ`.
 * `assertCatalogAgreement` pins that agreement in both directions rather than leaving it as a
 * statement in a comment, because a table with a writer drifts the moment somebody edits one side.
 *
 * ## Why the conflict clause is neither `DO NOTHING` nor a bare `DO UPDATE`
 *
 * A read state is first-write-wins (`DO NOTHING`) and a watermark is monotonic (`GREATEST`). A
 * preference is **a current value**, so neither fits — and a bare last-writer-wins
 * `DO UPDATE` loses the race in exactly the direction that matters. Two tabs load the preferences
 * page; the person turns marketing email off in one; the other submits its stale form. Last-writer-
 * wins restores `opted_in = true` and the mail resumes. ADR-0330 used `GREATEST` against this for a
 * watermark; `updated_at` cannot play that part here, because it is minted by the server on the way
 * in, so the *stale* write carries the *newer* timestamp.
 *
 * So the premise is re-asserted inside the `UPDATE` predicate — ADR-0321's "the row is the lock" —
 * and the premise is **the value the caller believes it is replacing**. It is stronger than a
 * revision token for the reason ADR-0331 gave: a caller cannot defeat it by reusing what it read,
 * because reusing a stale value is precisely what makes the predicate fail.
 *
 * And the precondition is **required in one direction only**, which is the decision rather than an
 * omission:
 *
 *  - An **opt-out** needs none. It is monotonic in the safe direction: landing it over a stale read
 *    still ends in "do not send", which is what the person asked for, and landing it twice is one
 *    fact. A refusal here would be a consent withdrawal the platform declined to record.
 *  - An **opt-in** requires one. It is the direction that *widens* delivery, and ADR-0302's rule is
 *    that a safety record must never widen on an inference — a write with no precondition is an
 *    inference about what the stored value was. `expect: "absent"` is how a first-ever opt-in says
 *    it believes there is no row; a row that turns out to exist is a conflict, not an overwrite.
 *
 * ## Scope
 *
 * `tenant_id` is `NOT NULL` here, so this table has no platform scope at all and the strict
 * `scopeFilter` is the only correct spelling — `scopeFilterWithPlatform` would be asking for rows
 * that cannot exist. It rides **beside** RLS rather than instead of it, because a table's owner
 * bypasses its policies and connecting as the owner is an ordinary deployment (ADR-0331, ADR-0333).
 * Without it, `matrixFor` as the owner would hand one tenant's opt-out to another tenant's drain.
 */

export interface PreferenceStoreOptions {
  readonly schema?: string;
}

/** What the caller believes the stored row currently says. `absent` means "no row at all". */
export const PREFERENCE_EXPECTATIONS = ["absent", "opted_in", "opted_out"] as const;
export type PreferenceExpectation = (typeof PREFERENCE_EXPECTATIONS)[number];

export const PREFERENCE_WRITE_OUTCOMES = [
  "inserted",
  "updated",
  /**
   * A row existed and already said this. The decision did not move; its provenance (`source`,
   * `updated_by`, `updated_at`) was refreshed. Named for what is true rather than `unchanged`,
   * which would claim the row is byte-identical when `source` may have gone from `user_set` to
   * `admin_set` — a difference an access review cares about.
   */
  "reaffirmed",
  /**
   * The stored row did not match the caller's expectation — another writer got there first. The
   * stored row is returned so the caller can show what it actually says.
   */
  "conflict",
] as const;
export type PreferenceWriteOutcome = (typeof PREFERENCE_WRITE_OUTCOMES)[number];

export interface PreferenceWriteResult {
  readonly outcome: PreferenceWriteOutcome;
  /** The row that now holds this (tenant, user, category, channel) — stored, never echoed input. */
  readonly entry: PreferenceMatrixEntry | null;
}

/** The sources a preference row may carry; the contract's enum, restated as the store's input type. */
export const PREFERENCE_SOURCES = [
  "default_policy",
  "user_set",
  "admin_set",
  "regulatory_requirement",
  "import",
] as const;
export type PreferenceSource = (typeof PREFERENCE_SOURCES)[number];

export interface PreferenceSubject {
  readonly tenantId: string;
  readonly userId: string;
}

export interface PreferenceWrite {
  readonly category: ContentCategory;
  readonly channel: NotificationChannel;
  readonly optedIn: boolean;
  readonly source: PreferenceSource;
  readonly at: string;
  /** `meta.users.id` of whoever changed it, or null for a write with no human behind it. */
  readonly updatedBy: string | null;
  /**
   * Required for an opt-in, optional for an opt-out — see the class comment. Absent on an opt-in is
   * a programming error here and a 400 at the route, not a write.
   */
  readonly expect?: PreferenceExpectation;
}

/**
 * Why a row the store read could not be served.
 *
 * `category_unreadable` is its own kind because it is the one defect that cannot be attributed to
 * either side of the fail-open/fail-closed split: without a category there is no way to know whether
 * the row was protecting a suppressible one.
 */
export const PREFERENCE_ROW_DEFECTS = [
  "category_unreadable",
  "entry_unparseable",
  "user_unreadable",
] as const;
export type PreferenceRowDefect = (typeof PREFERENCE_ROW_DEFECTS)[number];

export class PreferenceRowUnreadableError extends Error {
  readonly defect: PreferenceRowDefect;
  readonly category: ContentCategory | null;

  constructor(defect: PreferenceRowDefect, category: ContentCategory | null, detail: string) {
    super(`notification preference row is unreadable (${defect}): ${detail}`);
    this.name = "PreferenceRowUnreadableError";
    this.defect = defect;
    this.category = category;
  }
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The columns the store reads. `id` is never read — the natural key is the four-column unique. */
const PREFERENCE_COLUMNS =
  "tenant_id, user_id, category, channel, opted_in, source, updated_at, updated_by";

export class PostgresNotificationPreferenceStore {
  private readonly preferences: string;
  /** The bare table name, which is how `ON CONFLICT … DO UPDATE` addresses its target. */
  private readonly table = "notification_preferences";

  constructor(
    private readonly conn: PgConnection,
    options: PreferenceStoreOptions = {},
  ) {
    const schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.preferences = `"${schema}"."notification_preferences"`;
  }

  /**
   * Records one preference, refusing a write whose premise no longer holds.
   *
   * One statement rather than a select-then-write: the predicate inside `DO UPDATE` is the whole
   * concurrency rule, and moving it into process would reintroduce the two-tab race it exists to
   * close. `RETURNING` on both paths plus the CTE's fallback mean the row that comes back is the row
   * that now holds this key, whichever of insert / update / refusal happened.
   */
  async put(subject: PreferenceSubject, write: PreferenceWrite): Promise<PreferenceWriteResult> {
    this.assertSubject(subject);
    if (write.optedIn && write.expect === undefined) {
      // Not a refusal the route should ever reach — `decideExpectation` turns this into a 400 — but
      // the store states the rule too, because the rule is what keeps consent from widening on an
      // inference and a second caller must not be able to skip it by calling the store directly.
      throw new Error("an opt-in must name the value it expects to replace (expect)");
    }
    const expect = write.expect ?? "any";
    const scope = scopeFilter(subject.tenantId, 1);

    const key = `${scope.sql} AND user_id = $2::uuid AND category = $3 AND channel = $4`;

    return withTenantContext(this.conn, subject.tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        // `prior` is read in the statement's own snapshot, which is taken before the INSERT runs, so
        // it reports the row as it was. That is what makes `inserted` / `updated` / `reaffirmed`
        // answerable without `xmax`, whose zero-ness is an implementation detail of the heap and not
        // something a store should read. It is also the only way to be honest: the caller's
        // expectation says what it *believed*, and reporting from that would call an insert an
        // update whenever the belief was wrong.
        `WITH prior AS (
           SELECT opted_in FROM ${this.preferences} WHERE ${key}
         ),
         upserted AS (
           INSERT INTO ${this.preferences}
             (tenant_id, user_id, category, channel, opted_in, source, updated_at, updated_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::boolean, $6, $7::timestamptz, $8::uuid)
           ON CONFLICT (tenant_id, user_id, category, channel) DO UPDATE
             SET opted_in = EXCLUDED.opted_in,
                 source = EXCLUDED.source,
                 updated_at = EXCLUDED.updated_at,
                 updated_by = EXCLUDED.updated_by
             WHERE ${expectationPredicate(expect, this.table)}
           RETURNING ${PREFERENCE_COLUMNS}, true AS written
         )
         SELECT ${PREFERENCE_COLUMNS}, written,
                (SELECT opted_in FROM prior) AS prior_opted_in,
                EXISTS (SELECT 1 FROM prior) AS existed
           FROM upserted
         UNION ALL
         SELECT ${PREFERENCE_COLUMNS}, false AS written,
                (SELECT opted_in FROM prior) AS prior_opted_in,
                EXISTS (SELECT 1 FROM prior) AS existed
           FROM ${this.preferences}
          WHERE ${key} AND NOT EXISTS (SELECT 1 FROM upserted)`,
        [
          ...scope.params,
          subject.userId,
          write.category,
          write.channel,
          write.optedIn,
          write.source,
          write.at,
          write.updatedBy,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        // Nothing was written and nothing could be read back. Under RLS as a non-owner that is a
        // confined statement — the insert matched no policy and the select cannot see what it would
        // have written. Throwing beats returning a receipt for a row that does not exist: a caller
        // told its preference was saved would stop asking. ADR-0330's rule for `markRead`.
        throw new Error(
          "notification preference write produced no row; check the tenant context and RLS",
        );
      }
      const entry = this.rowToEntry(row);
      if (row["written"] !== true) return { outcome: "conflict", entry };
      if (row["existed"] !== true) return { outcome: "inserted", entry };
      return {
        outcome: row["prior_opted_in"] === write.optedIn ? "reaffirmed" : "updated",
        entry,
      };
    });
  }

  /**
   * Clears one preference, so the built-in default governs again.
   *
   * A delete rather than a row saying `source = 'default_policy'`, because the two are different
   * facts and only one of them is true: "nobody has expressed a preference" is the absence of a row,
   * and writing a row that restates the default would make `isPreferenceOptedIn` answer from a
   * stored value that happens to agree — until the default changes, at which point every user who
   * had ever pressed "reset" would be pinned to the old one.
   */
  async clear(
    subject: PreferenceSubject,
    key: { readonly category: ContentCategory; readonly channel: NotificationChannel },
  ): Promise<boolean> {
    this.assertSubject(subject);
    const scope = scopeFilter(subject.tenantId, 1);
    return withTenantContext(this.conn, subject.tenantId, async (tx) => {
      const result = await tx.query(
        `DELETE FROM ${this.preferences}
          WHERE ${scope.sql} AND user_id = $2::uuid AND category = $3 AND channel = $4`,
        [...scope.params, subject.userId, key.category, key.channel],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * The whole matrix for one subject, re-parsed through the contract on the way out (ADR-0289).
   *
   * This is the same projection `recipient-resolver.preferencesFor` builds, for one user, and it is
   * deliberately built by the contract's own schema rather than assembled here: a second
   * implementation of the duplicate-key and non-suppressible-opt-out rules is how the two come to
   * disagree.
   */
  async matrixFor(subject: PreferenceSubject): Promise<UserPreferenceMatrix> {
    this.assertSubject(subject);
    const scope = scopeFilter(subject.tenantId, 1);
    const rows = await withTenantContext(this.conn, subject.tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${PREFERENCE_COLUMNS} FROM ${this.preferences}
          WHERE ${scope.sql} AND user_id = $2::uuid
          ORDER BY category, channel`,
        [...scope.params, subject.userId],
      );
      return result.rows;
    });
    const entries: PreferenceMatrixEntry[] = [];
    let updatedAt = EPOCH_ISO;
    for (const row of rows) {
      const entry = this.rowToEntry(row);
      if (entry === null) continue;
      entries.push(entry);
      if (Date.parse(entry.updatedAt) > Date.parse(updatedAt)) updatedAt = entry.updatedAt;
    }
    return UserPreferenceMatrixSchema.parse({
      userId: subject.userId,
      tenantId: subject.tenantId,
      entries,
      updatedAt,
    });
  }

  /**
   * Turns a row into an entry, **throwing** on one it cannot read rather than skipping it.
   *
   * This is ADR-0302's finding applied where it arises next. `PostgresRecipientResolver`'s two
   * suppression readers were changed to throw rather than skip, because skipping the one row you
   * cannot read mails exactly the address the row existed to protect. A preference row carrying
   * `opted_in = false` is the same kind of record, and skipping it sends to exactly the person who
   * said stop.
   *
   * The direction is decided **per category**, from `NON_SUPPRESSIBLE_CATEGORIES`, and the two sides
   * are not a matter of taste:
   *
   *  - A **suppressible** category (`system_notice`, `operational_digest`, `marketing`) is a consent
   *    record, and the absence of a row defaults to *delivering* everything but marketing. So a row
   *    that cannot be read fails **closed**: it throws, the drain's per-tenant catch stops that
   *    tenant's sweep and it retries, rather than sending.
   *  - A **non-suppressible** category (`transactional`, `security_alert`) cannot lawfully be turned
   *    off by a preference at all — the contract refuses a `user_set` opt-out and
   *    `computeDispatchEligibility` overrides consent for them — so the row carries no safety
   *    meaning and refusing would withhold a security alert. It fails **open**: the row is dropped
   *    and the default delivers. That is ADR-0309's quiet-hours argument, which fails open precisely
   *    because never-sending is the worse failure.
   *
   * An unreadable **category** takes the closed side for the obvious reason: nothing can prove the
   * row was not protecting a suppressible one.
   */
  private rowToEntry(row: Record<string, unknown>): PreferenceMatrixEntry | null {
    const rawCategory = row["category"];
    const category =
      typeof rawCategory === "string" &&
      (CONTENT_CATEGORIES as readonly string[]).includes(rawCategory)
        ? (rawCategory as ContentCategory)
        : null;
    if (category === null) {
      throw new PreferenceRowUnreadableError(
        "category_unreadable",
        null,
        `category ${JSON.stringify(rawCategory)} is not one of ${CONTENT_CATEGORIES.join(", ")}`,
      );
    }
    const parsed = PreferenceMatrixEntrySchema.safeParse({
      category,
      channel: row["channel"],
      optedIn: row["opted_in"] === true,
      updatedAt: isoOf(row["updated_at"]),
      source: row["source"],
    });
    if (parsed.success) return parsed.data;
    if (isCategorySuppressible(category)) {
      throw new PreferenceRowUnreadableError(
        "entry_unparseable",
        category,
        `${category} is suppressible, so an unreadable row must not be read as consent: ` +
          parsed.error.issues.map((i) => i.message).join("; "),
      );
    }
    return null;
  }

  private assertSubject(subject: PreferenceSubject): void {
    // Both ids reach a `::uuid` cast and an RLS predicate. Refusing here names which one is wrong;
    // letting Postgres refuse surfaces as a 500 with a cast error and no field named.
    if (!UUID_RE.test(subject.tenantId)) {
      throw new Error(`tenantId must be a uuid, got ${JSON.stringify(subject.tenantId)}`);
    }
    if (!UUID_RE.test(subject.userId)) {
      throw new Error(`userId must be a uuid, got ${JSON.stringify(subject.userId)}`);
    }
  }
}

/**
 * The `DO UPDATE … WHERE` arm for one expectation.
 *
 * `any` renders `true` rather than being omitted, so the statement has one shape and a reader does
 * not have to work out whether a missing clause meant "unconditional" or "a bug dropped it".
 *
 * `absent` renders `false`: the caller said it believes there is no row, so a conflict means one
 * exists and must **not** be overwritten. That is `ON CONFLICT DO NOTHING` spelled as a predicate,
 * which keeps the one statement total across all three expectations.
 */
export function expectationPredicate(
  expect: PreferenceExpectation | "any",
  table: string,
): string {
  switch (expect) {
    case "any":
      return "true";
    case "absent":
      return "false";
    case "opted_in":
      return `${table}.opted_in = true`;
    case "opted_out":
      return `${table}.opted_in = false`;
  }
}

/**
 * What a missing row means, stated once and in one place.
 *
 * It is the contract's own `isPreferenceOptedIn` over an empty matrix, called rather than restated,
 * because the whole risk of giving this table a writer is changing what an absence means by
 * accident: before this store existed every user was on the default path, and a second spelling of
 * the default is how the stored and unstored answers come to differ.
 */
export function defaultOptedIn(category: ContentCategory): boolean {
  return !requiresExplicitOptIn(category);
}

/**
 * The resolution order, as a function, so it can be tested rather than described.
 *
 * A stored entry governs; its absence falls to the built-in default. Nothing else participates —
 * suppressions are a separate and later decision in `computeDispatchEligibility`, which is why this
 * answers consent only.
 */
export function resolveOptedIn(
  matrix: UserPreferenceMatrix,
  category: ContentCategory,
  channel: NotificationChannel,
): { readonly optedIn: boolean; readonly from: "stored" | "default" } {
  const stored = matrix.entries.find((e) => e.category === category && e.channel === channel);
  if (stored !== undefined) return { optedIn: stored.optedIn, from: "stored" };
  return { optedIn: isPreferenceOptedIn(matrix, category, channel), from: "default" };
}

export interface CatalogColumnLike {
  readonly name: string;
  readonly notNull?: boolean;
  readonly default?: string;
  readonly check?: string;
}

export interface CatalogTableLike {
  readonly columns: readonly CatalogColumnLike[];
}

/**
 * Asserts the catalog and the contract still agree, in both directions.
 *
 * ADR-0330 found both read-state tables had drifted behind their contracts while nothing wrote
 * them — `dispatch_id` was `UUID` against a `disp_…` contract, so the first `INSERT` would have
 * failed on a schema that read as correct. This table had **not** drifted when its writer was built,
 * and the useful thing to do with that is pin it: a table with a writer drifts the moment somebody
 * edits one side, and ADR-0334's lesson is that a rule with no forcing function is a comment.
 *
 * Both directions, because one is not enough — ADR-0334's `pg-storeless-tables` census makes the
 * same point: a CHECK that enumerates a value the contract has dropped is as wrong as the reverse,
 * and only a two-way comparison sees it. The enum values are read out of the CHECK expression
 * rather than from a second list kept here, for the reason `FEATURE_FLAG_COLUMN_NAMES` had to learn
 * (ADR-0332): a second copy of the names is the thing that drifts.
 */
export function assertCatalogAgreement(table: CatalogTableLike): void {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  for (const required of [
    "tenant_id",
    "user_id",
    "category",
    "channel",
    "opted_in",
    "source",
    "updated_at",
  ]) {
    const column = byName.get(required);
    if (column === undefined) {
      throw new Error(`meta.notification_preferences has no ${required} column`);
    }
    if (column.notNull !== true) {
      throw new Error(`meta.notification_preferences.${required} must be NOT NULL`);
    }
  }
  const expectations: ReadonlyArray<[string, readonly string[]]> = [
    ["category", CONTENT_CATEGORIES],
    ["channel", NOTIFICATION_CHANNELS],
    ["source", PREFERENCE_SOURCES],
  ];
  for (const [column, values] of expectations) {
    const check = byName.get(column)?.check ?? "";
    const quoted = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "");
    const declared = new Set(quoted);
    for (const value of values) {
      if (!declared.has(value)) {
        throw new Error(
          `meta.notification_preferences.${column} CHECK does not permit ${value}, which the contract does`,
        );
      }
    }
    for (const value of declared) {
      if (!(values as readonly string[]).includes(value)) {
        throw new Error(
          `meta.notification_preferences.${column} CHECK permits ${value}, which the contract does not`,
        );
      }
    }
  }
}

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** node-postgres returns a `Date` for `timestamptz`; the contract wants an offset ISO string. */
function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value == null) return EPOCH_ISO;
  return String(value);
}
