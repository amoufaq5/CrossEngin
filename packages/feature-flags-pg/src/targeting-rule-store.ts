import {
  requireIsoInstant,
  scopeFilterWithPlatform,
  type PgConnection,
} from "@crossengin/kernel-pg";
import {
  TargetingRuleSchema,
  type FlagDefinition,
  type TargetingRule,
} from "@crossengin/feature-flags";

import { PostgresFeatureFlagStore } from "./flag-store.js";
import {
  SET_PLATFORM_CONFIG_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  assertTenantId,
} from "./kill-switch-store.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "feature_flag_targeting_rules";

/**
 * The columns of `meta.feature_flag_targeting_rules` in the order `targetingRuleRowValues` supplies
 * them. Every statement derives its column list and its placeholders from this one array, and
 * nothing restates them — which is the rule ADR-0332 had to install here after
 * `FEATURE_FLAG_COLUMN_NAMES` said `default_value` for a column the catalog had renamed to
 * `default_value_json`, so the flag store could not round-trip a single flag against any real
 * database while every offline test passed.
 *
 * The list is a literal rather than a runtime read of `META_TABLES` on purpose: it is compared to
 * the catalog **mechanically and in both directions** by
 * `packages/testing/src/strategy/pg-column-coverage.ts`, which reads this array and every statement
 * in the workspace as *text* and asserts that each column named exists and that each
 * `notNull`-with-no-default column is named by every `INSERT`. Importing `@crossengin/kernel` here
 * to derive it would buy nothing that check does not already give and would make the answer depend
 * on whether someone ran `pnpm -r build`.
 *
 * `id` is absent on purpose: it is the surrogate key with a `uuid_generate_v7()` default, and
 * `rule_id` is the contract's own `ftr_…` id — the one a flag's `targetingRuleIds` names.
 */
export const TARGETING_RULE_COLUMN_NAMES: readonly string[] = Object.freeze([
  "rule_id",
  "tenant_id",
  // TEXT holding the contract's `ff_…` id, not the surrogate UUID the catalog declared. The column
  // was `UUID NOT NULL REFERENCES meta.feature_flags(id)` and `TargetingRule.flagId` is
  // `^ff_[a-z0-9]{8,32}$`, so the *only* value this store can supply raised `invalid input syntax
  // for type uuid: "ff_checkout1"` — the third instance in this table family of ADR-0289's
  // `declared_by` defect, after `meta.feature_flag_kill_switches.flag_id` and
  // `meta.incidents.declared_by`. Measured live before the catalog patch; see the module note below.
  "flag_id",
  "priority",
  "label",
  "condition",
  "served_variant_key",
  "served_value_json",
  "is_exclusion",
  "description",
  "created_at",
  "created_by",
]);

/**
 * `condition` alone. The two served-value columns are deliberately TEXT: `servedValueJson` is text
 * the contract has already validated as parseable JSON, and storing it as JSONB would hand back
 * Postgres's re-serialisation rather than the text that was validated — key order resorted, `1e3`
 * returned as `1000`. `condition` is genuinely structural (a discriminated union the catalog holds
 * as JSONB and an operator queries by `kind`), and it is re-parsed through the contract on the way
 * out, so a re-serialisation cannot change what it means.
 */
export const TARGETING_RULE_JSONB_COLUMNS: ReadonlySet<string> = new Set(["condition"]);

export const TARGETING_RULE_COLUMNS = TARGETING_RULE_COLUMN_NAMES.join(", ");

/** `$1, $6::jsonb, …` positionally matching `TARGETING_RULE_COLUMN_NAMES`. */
export function targetingRulePlaceholders(): string {
  return TARGETING_RULE_COLUMN_NAMES.map(
    (col, i) => `$${i + 1}${TARGETING_RULE_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
  ).join(", ");
}

/** The number of bound parameters an INSERT carries — one per column. */
export const TARGETING_RULE_PARAM_COUNT = TARGETING_RULE_COLUMN_NAMES.length;

/**
 * A flag may not list more rules than one read can return, and the ceiling is enforced by
 * **asking for one more than it** rather than by trusting a `LIMIT`.
 *
 * `FlagDefinition.targetingRuleIds` declares no maximum, so a flag can name any number of rules. A
 * bare `LIMIT` on the read would then silently truncate the set — and a truncated rule set is
 * exactly the fail-open this module exists to prevent, because the rule that fell off the end may
 * be the exclusion. Fetching `MAX + 1` turns "the set is too large to evaluate" into a refusal
 * naming the flag instead of a quietly shorter answer.
 */
export const MAX_TARGETING_RULES_PER_FLAG = 1000;

/** The row values for a `TargetingRule`, positionally matching `TARGETING_RULE_COLUMNS`. */
export function targetingRuleRowValues(record: TargetingRule): readonly unknown[] {
  const valid = TargetingRuleSchema.parse(record);
  return [
    valid.id,
    valid.tenantId,
    valid.flagId,
    valid.priority,
    valid.label,
    JSON.stringify(valid.condition),
    valid.servedVariantKey,
    valid.servedValueJson,
    valid.isExclusion,
    valid.description ?? null,
    valid.createdAt,
    valid.createdBy,
  ];
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * `description` round-trips through a nullable column and the schema distinguishes absent from null
 * for it (`.optional()`, not `.nullable()`), so a NULL must come back as an omitted key —
 * `rowToKillSwitch`'s `impactScopeNotes` problem in a second table.
 */
function maybe(key: string, value: string | null): Record<string, string> {
  return value === null ? {} : { [key]: value };
}

/**
 * Rebuilds the `TargetingRule` from a row, and **re-validates it** on the way out (ADR-0289).
 *
 * The row *is* the record, so the contract's cross-field rules are the only thing standing between
 * a hand-edited row and a rule the gateway will serve traffic by. Two of them cannot be a CHECK
 * constraint at all: that `condition` is one of ten discriminated shapes with its own per-kind
 * fields — a CHECK cannot reach inside JSONB without `jsonb_typeof` gymnastics per kind, and the
 * `percentage_bucket` arm's `minBucketInclusive < maxBucketExclusive` would need two of them — and
 * that exactly one of `servedVariantKey`/`servedValueJson` is set, which *is* expressible and is
 * not declared. So a row that satisfies every live constraint and still cannot be evaluated fails
 * loudly here rather than being served.
 *
 * `created_at` comes back from node-postgres as a `Date`, never as text (ADR-0331), so it goes
 * through `requireIsoInstant` — a raw `String(date)` would yield `Mon Oct 05 2026 …`, which
 * `z.string().datetime({offset: true})` refuses.
 */
export function rowToTargetingRule(row: Record<string, unknown>): TargetingRule {
  return TargetingRuleSchema.parse({
    id: asString(row["rule_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    flagId: asString(row["flag_id"]),
    priority: Number(row["priority"]),
    label: asString(row["label"]),
    condition: asJson(row["condition"]),
    servedVariantKey: asNullableString(row["served_variant_key"]),
    servedValueJson: asNullableString(row["served_value_json"]),
    isExclusion: row["is_exclusion"] === true,
    ...maybe("description", asNullableString(row["description"])),
    createdAt: requireIsoInstant(row["created_at"], "created_at"),
    createdBy: asString(row["created_by"]),
  });
}

/* ------------------------------------------------------- the dangling id rule */

/**
 * The three ways a flag and its stored rules can disagree, which is the question this increment
 * exists to answer: **once rules can exist, what does a flag naming a missing one mean?**
 *
 * Until now `PostgresFeatureFlagStore` round-tripped `targeting_rule_ids` as a JSONB list of `ftr_…`
 * strings and nothing wrote the rows they name, so *every* stored flag was in the first state below
 * and no code could tell. The answer is not symmetric across the three, and the asymmetry is the
 * decision:
 *
 * - **`rule_missing`** and **`rule_wrong_flag`** are refusals. The flag's `targetingRuleIds` is the
 *   authoritative list, so a named rule that is absent, or present but belonging to another flag, is
 *   a rule the flag *declares* and the evaluation would not apply. Evaluating anyway is a **fail-open
 *   on a feature gate**: `isExclusion` rules are the ones that keep a cohort *out* of a feature, so
 *   the missing rule is precisely the one whose absence hands the feature to the tenants it was
 *   written to withhold it from. And it is undetectable after the fact — `fallthrough_to_default` is
 *   the same recorded reason whether a rule did not match or was never consulted. `rule_wrong_flag`
 *   is the worse of the two, because applying it serves *another flag's* targeting.
 *
 * - **`rule_unreferenced`** is a finding and not a refusal, for the same reason the first two are
 *   refusals: the list decides. A row naming this flag that the list does not name is, by the list's
 *   own authority, not part of this flag's targeting — so the correct behaviour is to not evaluate
 *   it. It is still reported, because it is either a half-finished write (a rule inserted and the
 *   flag's list not yet updated) or a stale leftover, and in the exclusion case it is a safety record
 *   somebody intended that is not being applied. Refusing instead would take the flag off the air
 *   for the duration of any non-transactional write, which is an outage on the request path in
 *   exchange for an inference — ADR-0322's split between evidence and absence, on a third surface.
 *
 * The finding is carried in **the data and not in a log line**: `TargetingRuleSet.unreferenced` is a
 * required field, so a caller holding a resolved set holds the finding too and cannot not have it.
 */
export const TARGETING_RULE_SET_DEFECTS = [
  /** The flag's list names an id no row carries, in this session's scope. */
  "rule_missing",
  /** The flag's list names an id whose row belongs to a different flag. */
  "rule_wrong_flag",
  /** A stored rule names this flag and the flag's list does not name it. */
  "rule_unreferenced",
] as const;
export type TargetingRuleSetDefect = (typeof TARGETING_RULE_SET_DEFECTS)[number];

/** The defects that make a flag unevaluable, as opposed to merely inconsistent. */
export const BLOCKING_TARGETING_RULE_SET_DEFECTS: ReadonlySet<TargetingRuleSetDefect> = new Set([
  "rule_missing",
  "rule_wrong_flag",
]);

export interface TargetingRuleSetFinding {
  readonly defect: TargetingRuleSetDefect;
  readonly ruleId: string;
  /** The flag the stored row names, where one was found and it is not the flag asked about. */
  readonly storedFlagId: string | null;
}

/** Everything the two reads found, with nothing refused — the survey an operator asks for. */
export interface TargetingRuleSetSurvey {
  readonly flagId: string;
  /** The declared rules that resolved, in evaluation order. */
  readonly rules: readonly TargetingRule[];
  readonly findings: readonly TargetingRuleSetFinding[];
}

/**
 * A flag's targeting, complete and in evaluation order, **plus the rules that exist and are not
 * part of it**. `unreferenced` is required rather than optional so the finding travels with the set.
 */
export interface TargetingRuleSet {
  readonly flagId: string;
  readonly rules: readonly TargetingRule[];
  readonly unreferenced: readonly TargetingRuleSetFinding[];
}

export interface FlagWithTargeting {
  readonly flag: FlagDefinition;
  readonly targeting: TargetingRuleSet;
}

export class TargetingRulesUnresolvedError extends Error {
  constructor(
    readonly flagId: string,
    readonly scopeTenantId: string | null,
    readonly findings: readonly TargetingRuleSetFinding[],
  ) {
    super(
      `feature flag '${flagId}' cannot be evaluated: ` +
        findings
          .map((f) =>
            f.defect === "rule_wrong_flag"
              ? `${f.ruleId} belongs to flag ${String(f.storedFlagId)}`
              : `${f.ruleId} (${f.defect})`,
          )
          .join(", "),
    );
    this.name = "TargetingRulesUnresolvedError";
  }
}

export class TargetingRuleSetTooLargeError extends Error {
  constructor(
    readonly flagId: string,
    readonly ceiling: number,
  ) {
    super(
      `feature flag '${flagId}' has more than ${String(ceiling)} targeting rules — ` +
        "a truncated rule set would silently drop whichever rule fell off the end, " +
        "including an exclusion",
    );
    this.name = "TargetingRuleSetTooLargeError";
  }
}

export interface PostgresTargetingRuleStoreOptions {
  readonly schema?: string;
}

/**
 * Persists `TargetingRule` records in `meta.feature_flag_targeting_rules` — the writer that table
 * never had, and the reason a flag read back from the database could not be evaluated against its
 * own targeting at all.
 *
 * ## The store is insert-only, and that is the catalog's shape rather than a simplification
 *
 * The table carries three policies — `ALL` isolation, a `SELECT` platform read, an `INSERT` platform
 * write — and **no platform `UPDATE` arm**, which is ADR-0332's *append-only* shape: a platform-scope
 * rule is immutable-by-RLS once written. A store that offered an upsert would therefore work for a
 * tenant (whose rows the `ALL` isolation policy does reach) and raise "new row violates row-level
 * security policy" for the platform — the asymmetry
 * `packages/testing/src/strategy/pg-column-coverage.ts` flags as `platform_update_arm_missing`. So
 * the store does only what *both* scopes permit, and a retarget is a new `ftr_…` rule plus a rewrite
 * of the flag's `targeting_rule_ids` — which lands in `meta.feature_flags`, the table that *does*
 * have an `UPDATE` arm and already carries the `updated_at` guard. **The list is mutable and the
 * rules are not**, which also means every rule version an auditor might want is still there.
 *
 * There is consequently **no `ON CONFLICT` clause**, and that is the deliberate part. `DO NOTHING`
 * on a reused `rule_id` would report success for an insert of *different* content under an id
 * already taken — ADR-0333's defect, where a `DO NOTHING` on an upsert path stored a failover's plan
 * and silently dropped its completion. A `DO UPDATE` is the same defect inverted and is refused by
 * the policy above anyway, and a *refused* `DO UPDATE` returns `INSERT 0 0`, byte-identical to
 * `DO NOTHING`. With no clause at all the database raises `23505` naming
 * `feature_flag_targeting_rules_rule_id_key`, which is the truthful answer and the only one a caller
 * can act on. A test pins the absence so nobody "completes" it later.
 *
 * ## Scope: inclusive on the read, strict on the write
 *
 * A **read** takes `scopeFilterWithPlatform`. A platform-wide flag is *meant* to be evaluated by
 * every tenant's gateway — `meta.feature_flags`' own catalog comment says so and this package's
 * flag and kill-switch reads already take the inclusive arm — and a platform-wide flag's rules are
 * the same fact: narrowing them would leave a tenant evaluating `gateway.strict_jwt_aud` against an
 * empty rule set, i.e. serving its default to everyone. Verified live in both directions as a
 * non-owner role.
 *
 * A **write** carries no scope *predicate* at all, and that is not an omission — it is what
 * insert-only buys. `scopeFilter`'s strict form exists because a scoped `UPDATE`/`DELETE` matching
 * `tenant_id IS NULL` is a route from a tenant's session into the platform's row; an `INSERT` has no
 * `WHERE` to route through. What stands in its place is the supplied `tenant_id` column plus the
 * policy's own `WITH CHECK`: a tenant-scope insert is admitted by the `ALL` isolation policy only
 * when `tenant_id` equals the session's context, and a platform-scope insert only by the `INSERT`
 * arm, which demands `tenant_id IS NULL` **and** `app.platform_config_write`. The `scopedWrite` arms
 * are mutually exclusive by construction — a tenant context, or the config-write elevation, never
 * both — so no single transaction has a `WITH CHECK` satisfiable by rows of two scopes, which is the
 * shape ADR-0332's policy split exists to take apart. Verified live as a non-owner in both
 * directions, including the forgery: a tenant session inserting `tenant_id = NULL` is refused, and
 * so is a tenant session inserting another tenant's id.
 *
 * ## The scope predicate is beside RLS, not instead of it
 *
 * A table's owner bypasses its policies and connecting as the owner is an ordinary deployment
 * (ADR-0331, ADR-0333), so every read here carries its own `tenant_id` predicate as well. Without
 * one, `rulesFor(flagId, null)` would answer a platform lookup with whichever scope's rules the plan
 * happened to reach — and for this table that is not a longer list but a **different served value**,
 * since `chooseTargetingRule` stops at the first match.
 *
 * Measured as the owner against the same rows, store read beside the same read with the predicate
 * removed:
 *
 * ```
 *   platform   scoped=[]                  no-predicate=["ftr_acmerule/<acme>"]
 *   globex     scoped=[]                  no-predicate=["ftr_acmerule/<acme>"]
 *   acme       scoped=["ftr_acmerule/…"]  no-predicate=["ftr_acmerule/…"]
 * ```
 *
 * The middle line is the damage: `ftr_acmerule` is an **exclusion** rule of Acme's, so without the
 * predicate Globex was excluded from a flag by a rule Acme wrote — one tenant's targeting deciding
 * another tenant's served value. As a non-owner all three rows read `[]`, `[]`, `["ftr_acmerule/…"]`
 * in both columns; with the predicate the owner agrees with the non-owner in every scope.
 */
export class PostgresTargetingRuleStore {
  private readonly schema: string;
  private readonly placeholders: string;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresTargetingRuleStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
    this.placeholders = targetingRulePlaceholders();
  }

  /**
   * Appends one rule.
   *
   * A rule naming a flag that does not exist is refused by the foreign key rather than by a lookup
   * here, which is `meta.notification_read_states.dispatch_id`'s reasoning: translating the `ff_…`
   * id to a surrogate in the store would put a join in front of every write and turn a missing flag
   * into a lookup miss instead of a constraint violation.
   */
  async insert(rule: TargetingRule): Promise<void> {
    const values = targetingRuleRowValues(rule);
    await this.scopedWrite(rule.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${this.schema}.${TABLE} (${TARGETING_RULE_COLUMNS})
         VALUES (${this.placeholders})`,
        values,
      ),
    );
  }

  async load(
    ruleId: string,
    tenantId: string | null = null,
  ): Promise<TargetingRule | null> {
    const scope = scopeFilterWithPlatform(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${TARGETING_RULE_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE rule_id = $1 AND ${scope.sql}`,
        [ruleId, ...scope.params],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToTargetingRule(row);
    });
  }

  /**
   * Every stored rule naming a flag, **in evaluation order**.
   *
   * `ORDER BY priority, rule_id` and not `ORDER BY priority` alone: `priority` carries no uniqueness,
   * and `chooseTargetingRule` stops at the first match, so a tie decided by the query plan decides
   * the served value. `rule_id` is the one column with a table-wide unique constraint, so it is what
   * makes the order total. `idx_feature_flag_targeting_rules_flag_priority` is `(flag_id, priority)`,
   * so the leading sort is served by the index and the tiebreak is a sort within each equal-priority
   * run.
   *
   * **What the disjunction costs, measured** on 60k rules over 2,000 flags (the realistic shape — a
   * flag holds a handful of rules): the statement plans as a **BitmapOr** over
   * `idx_feature_flag_targeting_rules_flag_priority` and
   * `feature_flag_targeting_rules_rule_id_key`, then a top-N sort — 0.274 ms for a 15-rule flag.
   * `flag_id` alone, which cannot answer the two declared-id directions, gets an Incremental Sort
   * over the index with `Presorted Key: priority` at 0.047 ms. So the single round trip costs the
   * presorted path and keeps the index; both are sub-millisecond at any rule count a flag has. The
   * one shape that degrades to a sequential scan is a single flag holding the whole table (30k rules
   * on one flag: 11.4 ms), which no deployment has.
   */
  async rulesFor(
    flagId: string,
    tenantId: string | null = null,
    limit = MAX_TARGETING_RULES_PER_FLAG,
  ): Promise<readonly TargetingRule[]> {
    return this.read(flagId, [], tenantId, limit);
  }

  /**
   * The flag's declared rules and every disagreement between the flag and the rows, with nothing
   * refused.
   *
   * **One query answers all three questions**, which is why the predicate is a disjunction:
   * `flag_id = $1` finds the rows that name the flag (the `rule_unreferenced` direction) and
   * `rule_id = ANY($2)` finds the rows the flag names (the `rule_missing` and `rule_wrong_flag`
   * directions). An empty declared list is harmless — `= ANY('{}')` is false — so the disjunction
   * degrades to the first arm rather than to a scan.
   */
  async surveyFor(
    flag: FlagDefinition,
    tenantId: string | null = null,
  ): Promise<TargetingRuleSetSurvey> {
    const declared = flag.targetingRuleIds;
    const stored = await this.read(flag.id, declared, tenantId, MAX_TARGETING_RULES_PER_FLAG);
    const byId = new Map(stored.map((r) => [r.id, r]));
    const findings: TargetingRuleSetFinding[] = [];
    const rules: TargetingRule[] = [];
    for (const id of declared) {
      const row = byId.get(id);
      if (row === undefined) {
        findings.push({ defect: "rule_missing", ruleId: id, storedFlagId: null });
        continue;
      }
      if (row.flagId !== flag.id) {
        findings.push({
          defect: "rule_wrong_flag",
          ruleId: id,
          storedFlagId: row.flagId,
        });
        continue;
      }
      rules.push(row);
    }
    const declaredIds = new Set(declared);
    for (const row of stored) {
      if (row.flagId !== flag.id || declaredIds.has(row.id)) continue;
      findings.push({ defect: "rule_unreferenced", ruleId: row.id, storedFlagId: row.flagId });
    }
    // The resolved rules are re-sorted rather than trusted in arrival order: `declared` is the
    // flag's JSONB array and its order is the author's, not the evaluator's. The database already
    // returned the rows in `priority, rule_id` order and this restores that after the walk above
    // reordered them into the declared list's order.
    return {
      flagId: flag.id,
      rules: [...rules].sort((a, b) =>
        a.priority !== b.priority ? a.priority - b.priority : a.id < b.id ? -1 : 1,
      ),
      findings,
    };
  }

  /**
   * The flag's targeting, or a refusal naming what is wrong with it.
   *
   * Refuses `rule_missing` and `rule_wrong_flag`, carries `rule_unreferenced` through in the set —
   * see `TARGETING_RULE_SET_DEFECTS` for why the three are not treated alike.
   */
  async loadFor(
    flag: FlagDefinition,
    tenantId: string | null = null,
  ): Promise<TargetingRuleSet> {
    const survey = await this.surveyFor(flag, tenantId);
    const blocking = survey.findings.filter((f) =>
      BLOCKING_TARGETING_RULE_SET_DEFECTS.has(f.defect),
    );
    if (blocking.length > 0) {
      throw new TargetingRulesUnresolvedError(flag.id, tenantId, blocking);
    }
    return {
      flagId: flag.id,
      rules: survey.rules,
      unreferenced: survey.findings,
    };
  }

  private async read(
    flagId: string,
    declared: readonly string[],
    tenantId: string | null,
    limit: number,
  ): Promise<readonly TargetingRule[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const scope = scopeFilterWithPlatform(tenantId, 3);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${TARGETING_RULE_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE (flag_id = $1 OR rule_id = ANY($2::text[])) AND ${scope.sql}
         ORDER BY priority, rule_id
         LIMIT $${String(3 + scope.params.length)}`,
        [flagId, [...declared], ...scope.params, limit + 1],
      );
      if (result.rows.length > limit) throw new TargetingRuleSetTooLargeError(flagId, limit);
      return result.rows.map((row) => rowToTargetingRule(row));
    });
  }

  /** A read's scope: a tenant context, or nothing — `PostgresKillSwitchStore.scoped`'s reasoning. */
  private scoped<T>(
    tenantId: string | null,
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    return this.conn.transaction(async (tx) => {
      if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx);
    });
  }

  /** A write's scope: a tenant context, or the platform config-write elevation, never both. */
  private scopedWrite<T>(
    tenantId: string | null,
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    return this.conn.transaction(async (tx) => {
      if (tenantId === null) await tx.query(SET_PLATFORM_CONFIG_WRITE_SQL);
      else await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx);
    });
  }
}

/**
 * A flag and its targeting, loaded together — the round trip that makes
 * `chooseTargetingRule(set.rules, context)` answerable from the database.
 *
 * **A free function over two stores rather than a join, or a method on either store**, for three
 * reasons that all point the same way:
 *
 *  - A join would read `meta.feature_flags`' twenty-seven columns once per rule row and re-parse the
 *    whole flag each time; worse, a `SELECT` with a join or an alias is exactly the shape
 *    `pg-column-coverage.ts` **silently skips**, because a bare column name in a join is ambiguous
 *    about which table it belongs to. So a join would move this read out of the one mechanical rule
 *    that checks it against the catalog — which is the rule that caught `default_value`.
 *  - The rule read's predicate is a *disjunction* over two different columns, which an inner join
 *    cannot express and an outer join can only express by duplicating the flag.
 *  - The two tables answer under two different policies and refuse for different reasons. A store
 *    owning both would have to decide which refusal wins; keeping them separate leaves that to the
 *    caller, and leaves each store's scope argument its own.
 */
export async function loadFlagWithTargeting(
  flags: PostgresFeatureFlagStore,
  rules: PostgresTargetingRuleStore,
  flagId: string,
  tenantId: string | null = null,
): Promise<FlagWithTargeting | null> {
  const flag = await flags.load(flagId, tenantId);
  if (flag === null) return null;
  return { flag, targeting: await rules.loadFor(flag, tenantId) };
}
