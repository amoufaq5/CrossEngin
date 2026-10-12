import {
  classifyScopedWriteRefusal,
  scopeFilter,
  type PgConnection,
  type ScopedWriteRefusal,
} from "@crossengin/kernel-pg";
import {
  FLAG_STATUSES,
  FlagDefinitionSchema,
  canTransitionFlag,
  type FlagDefinition,
  type FlagStatus,
} from "@crossengin/feature-flags";

import {
  SET_PLATFORM_CONFIG_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  assertTenantId,
  scopeFilterWithPlatform,
} from "./kill-switch-store.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "feature_flags";

/** The four environments a flag may be declared in, read off the contract rather than retyped. */
export type FlagEnvironment = FlagDefinition["environments"][number];

/**
 * The columns of `meta.feature_flags` in the order `flagRowValues` supplies them. Every statement
 * derives its column list, its placeholders and its UPDATE assignments from this one array, so a
 * column added in the middle cannot leave an INSERT and an UPDATE disagreeing about which `$n`
 * means what.
 *
 * `id` is absent on purpose: it is the surrogate key with a `uuid_generate_v7()` default, and
 * `flag_id` is the contract's own `ff_…` id — the one a caller holds and an UPDATE matches on.
 *
 * **This list is why the table was reconciled rather than deleted.** ADR-0296 found four tables
 * unable to store the records their contracts produce; `meta.feature_flags` was the worst instance,
 * because it predated `FlagDefinition` entirely. Of the eleven columns it declared, six mapped
 * (`key`, `description`, `environments`, `created_at`, `updated_at`, `archived_at`), one held the
 * contract's text as JSONB (`default_value_json`), two had no contract counterpart at all (`enabled`,
 * `rules`) and **eighteen contract fields had no column** — `tenantId`, `status`, `label`,
 * `riskLevel` and `ownerUserId` among them, every one required. No store limited to that shape
 * could round-trip a single flag, because the re-parse below would reject what came back.
 *
 * `enabled` and `rules` are deliberately *not* named here: both carry a default, so an INSERT that
 * omits them succeeds, and leaving a dead column declared beats a drop reconciliation would refuse
 * (ADR-0291).
 */
export const FEATURE_FLAG_COLUMN_NAMES: readonly string[] = Object.freeze([
  "flag_id",
  "tenant_id",
  "key",
  "kind",
  "label",
  "description",
  "status",
  // `default_value_json`, matching the contract's `defaultValueJson` and its sibling
  // `killed_value_json`. It really was the asymmetric `default_value` for one increment, because the
  // reconciler then had no concept of a rename; ADR-0308's `renamedFrom` closed that and the catalog
  // was renamed with it — and **this list was not**, so every statement here named a column no
  // applied database has had since. Measured as a non-owner role against a live cluster: every
  // insert, update and read raised `column "default_value" of relation "feature_flags" does not
  // exist`, so this store could not round-trip a single flag. The catalog is the source of truth and
  // the only reader of this list is the SQL, so the list is what moves.
  "default_value_json",
  "killed_value_json",
  "variants",
  "environments",
  "risk_level",
  "owner_user_id",
  "owner_team",
  "tags",
  "related_deployment_id",
  "related_incident_id",
  "targeting_rule_ids",
  "requires_four_eyes_to_toggle",
  "requires_incident_to_kill",
  "expires_at",
  "created_at",
  "created_by",
  "updated_at",
  "archived_at",
  "archived_by",
  "archived_reason",
]);

/**
 * The JSONB columns, named rather than numbered, so their `::jsonb` casts follow the array.
 *
 * The two value columns are absent: `defaultValueJson` and `killedValueJson` are TEXT the contract
 * has already validated as parseable JSON, and storing them as JSONB would hand back Postgres's
 * re-serialisation rather than the text that was validated — key order resorted, `1e3` returned as
 * `1000`. `meta.feature_flag_kill_switches.overridden_value_json` is TEXT for the same reason.
 */
export const FEATURE_FLAG_JSONB_COLUMNS: ReadonlySet<string> = new Set([
  "variants",
  "environments",
  "tags",
  "targeting_rule_ids",
]);

export const FEATURE_FLAG_COLUMNS = FEATURE_FLAG_COLUMN_NAMES.join(", ");

/** `$1, $10::jsonb, …` positionally matching `FEATURE_FLAG_COLUMN_NAMES`. */
export function flagPlaceholders(): string {
  return FEATURE_FLAG_COLUMN_NAMES.map(
    (col, i) => `$${i + 1}${FEATURE_FLAG_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
  ).join(", ");
}

/** `col = $n` for every column except the first, which is the key an UPDATE matches on. */
export function flagUpdateAssignments(): string {
  return FEATURE_FLAG_COLUMN_NAMES.slice(1)
    .map(
      (col, i) =>
        `${col} = $${i + 2}${FEATURE_FLAG_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
    )
    .join(", ");
}

/** The row values for a `FlagDefinition`, positionally matching `FEATURE_FLAG_COLUMNS`. */
export function flagRowValues(record: FlagDefinition): readonly unknown[] {
  const valid = FlagDefinitionSchema.parse(record);
  return [
    valid.id,
    valid.tenantId,
    valid.key,
    valid.kind,
    valid.label,
    valid.description,
    valid.status,
    valid.defaultValueJson,
    valid.killedValueJson,
    JSON.stringify(valid.variants),
    JSON.stringify(valid.environments),
    valid.riskLevel,
    valid.ownerUserId,
    valid.ownerTeam,
    JSON.stringify(valid.tags),
    valid.relatedDeploymentId,
    valid.relatedIncidentId,
    JSON.stringify(valid.targetingRuleIds),
    valid.requiresFourEyesToToggle,
    valid.requiresIncidentToKill,
    valid.expiresAt,
    valid.createdAt,
    valid.createdBy,
    valid.updatedAt,
    valid.archivedAt,
    valid.archivedBy,
    valid.archivedReason,
  ];
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : asString(value);
}

function asNullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value);
}

function asJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * Rebuilds the `FlagDefinition` from a row, and **re-validates it** on the way out.
 *
 * The row *is* the record, so the contract's cross-field invariants are the only thing standing
 * between a hand-edited row and a flag the platform will act on. `TableDefinition.constraints` can
 * now carry a cross-column CHECK, so several of them *could* be declared — that a `kill_switch`
 * flag requires four eyes, that an `archived` row carries all three archival columns, that
 * `expires_at` is after `created_at`. Two cannot be, at all: whether `default_value_json` parses as
 * JSON (no `IS JSON` before Postgres 17), and whether a `multivariate` flag's variant weights sum
 * to 10000 basis points with no duplicate key — that needs `jsonb_array_elements`, and a CHECK
 * admits neither a set-returning function nor an aggregate. So the re-parse is both the only place
 * those two hold and the one place *all* of them hold at once, which is why a row in an impossible
 * state fails loudly here rather than being served.
 */
export function rowToFeatureFlag(row: Record<string, unknown>): FlagDefinition {
  return FlagDefinitionSchema.parse({
    id: asString(row["flag_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    key: asString(row["key"]),
    kind: asString(row["kind"]),
    label: asString(row["label"]),
    description: asString(row["description"]),
    status: asString(row["status"]),
    defaultValueJson: asString(row["default_value_json"]),
    killedValueJson: asNullableString(row["killed_value_json"]),
    variants: asJson(row["variants"]),
    environments: asJson(row["environments"]),
    riskLevel: asString(row["risk_level"]),
    ownerUserId: asString(row["owner_user_id"]),
    ownerTeam: asString(row["owner_team"]),
    tags: asJson(row["tags"]),
    relatedDeploymentId: asNullableString(row["related_deployment_id"]),
    relatedIncidentId: asNullableString(row["related_incident_id"]),
    targetingRuleIds: asJson(row["targeting_rule_ids"]),
    requiresFourEyesToToggle: row["requires_four_eyes_to_toggle"] === true,
    requiresIncidentToKill: row["requires_incident_to_kill"] === true,
    expiresAt: asNullableIso(row["expires_at"]),
    createdAt: asIso(row["created_at"]),
    createdBy: asString(row["created_by"]),
    updatedAt: asIso(row["updated_at"]),
    archivedAt: asNullableIso(row["archived_at"]),
    archivedBy: asNullableString(row["archived_by"]),
    archivedReason: asNullableString(row["archived_reason"]),
  });
}

/**
 * `isFlagActive` in SQL. The expiry comparison uses the database clock deliberately: a process
 * whose clock has drifted would otherwise serve a lapsed flag as live.
 */
const ACTIVE_PREDICATE =
  "status = 'active' AND (expires_at IS NULL OR expires_at > now())";

/**
 * The statuses a flag may legally be in to reach `to`, read off `FLAG_STATUS_TRANSITIONS` rather
 * than retyped. Quoting is safe because the values come from the contract's frozen status tuple,
 * never from a caller.
 */
function predecessorsOf(to: FlagStatus): readonly FlagStatus[] {
  return FLAG_STATUSES.filter((from) => canTransitionFlag(from, to));
}

/**
 * A guarded write that moved no row, and **which of the three reasons it was**.
 *
 * The class, its name and `expectedUpdatedAt` stay — a caller catching it would be broken by a new
 * unrelated type — and it carries `reason` now. The old message was not merely incomplete, it was
 * **measured wrong**: as a non-owner, where RLS already refused a cross-scope write, it claimed
 * "another writer changed it first" about a row no writer had touched. The scope predicate did not
 * create that ambiguity, it only made it reachable as the owner too; `classifyScopedWriteRefusal`
 * resolves it for both.
 */
export class FeatureFlagConflictError extends Error {
  constructor(
    readonly flagId: string,
    readonly expectedUpdatedAt: string,
    readonly reason: ScopedWriteRefusal,
    readonly scopeTenantId: string | null,
    readonly storedTenantId: string | null,
    detail: string,
  ) {
    super(`feature flag '${flagId}' was not written (${reason}): ${detail}`);
    this.name = "FeatureFlagConflictError";
  }
}

export interface PostgresFeatureFlagStoreOptions {
  readonly schema?: string;
}

/**
 * Persists `FlagDefinition` records in `meta.feature_flags`.
 *
 * **Nothing constructs this store.** It is declared in `subsystem-survey.ts` as
 * `no_consumer_exists`, and the reason is one level up from this file: no component in the workspace
 * evaluates a feature flag, so a persisted flag has no reader. ADR-0300 built the store and never
 * claimed to wire it — read that ADR's Decision rather than a summary of it — but its argument for
 * doing so, "the store is what makes the next drift fail loudly", was later disproved by ADR-0332
 * rather than borne out: `FEATURE_FLAG_COLUMN_NAMES` named `default_value` where the catalog said
 * `default_value_json`, this store could not round-trip a single flag against any real database, and
 * every offline test passed, because a fake connection asserts SQL shape and cannot know a column
 * does not exist. What makes drift fail loudly is the assertion against `META_TABLES`. Everything
 * below is correct and unexercised outside this package's tests; do not read it as in service.
 *
 * **Tenant scoping is conditional**, as in `PostgresKillSwitchStore`, and for the same reason read
 * off the contract: `FlagDefinition.tenantId` is `.nullable()`, so a flag is either one tenant's or
 * the platform's — a `checkout.new_pricing` flag belongs to a tenant, a `gateway.strict_jwt_aud`
 * flag to everyone. The table therefore wants the kill switch's policy, `tenant_id IS NULL OR
 * tenant_id = current_setting('app.current_tenant_id', true)::UUID`, and not the plain
 * `TENANT_ISOLATION_USING` one: under plain isolation a platform-wide flag would be invisible to
 * every reader including the one that wrote it. An unconditional `withTenantContext` wrapper is
 * wrong for the mirror-image reason — setting a tenant context around a platform-wide write would
 * hide the very row being written. So a write takes its scope from the record's own `tenantId`, and
 * a read takes an optional one defaulting to null, where RLS exposes exactly the `tenant_id IS
 * NULL` rows: the fail-closed answer for a caller that has not said whose flag it wants.
 *
 * **There is no `revision` column, so concurrency is guarded on `updated_at` instead.** ADR-0296
 * gave the three incident child tables `revision` + `updated_at` because a postmortem is edited by
 * humans over days; a feature flag is edited the same way — an owner retargets it while a release
 * manager pauses it — so last-writer-wins would silently discard one of them. `updated_at` is
 * already a contract field and already a column, so a write states the timestamp it read and a
 * zero-row update raises `FeatureFlagConflictError`. What that costs against a real counter: two
 * writers whose reads carry the *same* `updated_at` are indistinguishable, so two edits landing
 * inside one millisecond (the contract's ISO precision) can still lose one; and the token is
 * supplied by the writer rather than incremented by the database, so a caller that reuses the
 * timestamp it read defeats the guard entirely — which is why `update` refuses that case outright
 * rather than trusting callers. A `revision INTEGER NOT NULL DEFAULT 1` column would remove both
 * holes, and is reported with the rest of the reconciliation.
 */
export class PostgresFeatureFlagStore {
  private readonly schema: string;
  private readonly placeholders: string;
  private readonly updateAssignments: string;
  /** The guard binds after every column value, so it is always the next placeholder. */
  private readonly guardParam: number;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresFeatureFlagStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
    this.placeholders = flagPlaceholders();
    this.updateAssignments = flagUpdateAssignments();
    this.guardParam = FEATURE_FLAG_COLUMN_NAMES.length + 1;
  }

  async insert(flag: FlagDefinition): Promise<void> {
    const values = flagRowValues(flag);
    await this.scopedWrite(flag.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${this.schema}.${TABLE} (${FEATURE_FLAG_COLUMNS})
         VALUES (${this.placeholders})`,
        values,
      ),
    );
  }

  /**
   * Writes a new version of a flag, but only if the row is still at the `updated_at` the caller
   * read. A zero-row update is a conflict, not a success — the alternative is silently discarding
   * whatever the other writer did.
   */
  async update(flag: FlagDefinition, expectedUpdatedAt: string): Promise<void> {
    this.assertAdvances(flag, expectedUpdatedAt);
    await this.guardedWrite(flag, expectedUpdatedAt, "");
  }

  /**
   * A status change, guarded by the transition map as well as by `updated_at`.
   *
   * The status predicate is what makes an illegal move impossible rather than merely unlikely: the
   * `updated_at` guard catches a stale read, but two callers reading the same active flag and both
   * writing `archived` would both be legal by it. Naming the statuses the target may be reached
   * *from* means the database refuses `paused → draft` and `archived → active` even if a caller
   * assembled the record, so the contract's `FLAG_STATUS_TRANSITIONS` holds for a row and not only
   * for a value in memory.
   */
  async transition(flag: FlagDefinition, expectedUpdatedAt: string): Promise<void> {
    this.assertAdvances(flag, expectedUpdatedAt);
    const from = predecessorsOf(flag.status);
    if (from.length === 0) {
      throw new Error(
        `no status can transition to '${flag.status}' — a flag reaches it by insert, not by update`,
      );
    }
    const statuses = from.map((status) => `'${status}'`).join(", ");
    await this.guardedWrite(flag, expectedUpdatedAt, ` AND status IN (${statuses})`);
  }

  async load(
    flagId: string,
    tenantId: string | null = null,
  ): Promise<FlagDefinition | null> {
    const scope = scopeFilterWithPlatform(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${FEATURE_FLAG_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE flag_id = $1 AND ${scope.sql}`,
        [flagId, ...scope.params],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToFeatureFlag(row);
    });
  }

  /**
   * The flag a `key` names.
   *
   * At most one row can answer because `key` carries a table-wide unique constraint — which is a
   * decision, not an accident: platform-wide and tenant-scoped flags share one key space, so a
   * tenant cannot shadow `gateway.strict_jwt_aud` with its own. A per-tenant key space is *not* the
   * cheap alternative it looks like: a composite unique over `(tenant_id, key)` is declarable now
   * that `TableDefinition.constraints` exists, but `tenant_id` is nullable and Postgres treats
   * NULLs as distinct by default, so it would permit two platform-wide flags on one key — the one
   * collision that matters most. Expressing it properly needs `UNIQUE NULLS NOT DISTINCT`, which
   * the DDL vocabulary has no spelling for.
   *
   * At most one row *in the table* can answer, and the scope predicate is still required: table-wide
   * uniqueness says which row holds a key, never which scope asked. As the owner, `loadByKey(key,
   * null)` answered a platform lookup with a tenant's flag — the uniqueness is exactly what makes
   * that single wrong row look like a correct answer.
   */
  async loadByKey(
    key: string,
    tenantId: string | null = null,
  ): Promise<FlagDefinition | null> {
    const scope = scopeFilterWithPlatform(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${FEATURE_FLAG_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE key = $1 AND ${scope.sql}`,
        [key, ...scope.params],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToFeatureFlag(row);
    });
  }

  /**
   * Every flag declared in an environment, newest first.
   *
   * `environments` is a JSONB array, so membership is `@>` over a one-element array rather than a
   * scan of the elements: containment is the operator a GIN index on the column can serve, and
   * spelling it any other way would leave such an index unusable for the one query it exists for.
   */
  async listForEnvironment(
    environment: FlagEnvironment,
    limit = 100,
    tenantId: string | null = null,
  ): Promise<readonly FlagDefinition[]> {
    return this.listWhere("", environment, limit, tenantId);
  }

  /** The same list narrowed to `isFlagActive`, which is what an evaluator actually serves. */
  async listActiveForEnvironment(
    environment: FlagEnvironment,
    limit = 100,
    tenantId: string | null = null,
  ): Promise<readonly FlagDefinition[]> {
    return this.listWhere(` AND ${ACTIVE_PREDICATE}`, environment, limit, tenantId);
  }

  private async listWhere(
    extra: string,
    environment: FlagEnvironment,
    limit: number,
    tenantId: string | null,
  ): Promise<readonly FlagDefinition[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const scope = scopeFilterWithPlatform(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${FEATURE_FLAG_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE environments @> $1::jsonb AND ${scope.sql}${extra}
         ORDER BY created_at DESC
         LIMIT $${String(2 + scope.params.length)}`,
        [JSON.stringify([environment]), ...scope.params, limit],
      );
      return result.rows.map((row) => rowToFeatureFlag(row));
    });
  }

  /**
   * A write that reuses the timestamp it read leaves the row's guard token unchanged, so the next
   * writer holding the same stale read would still match and overwrite it. Refusing here is the
   * difference between a guard and the appearance of one.
   */
  private assertAdvances(flag: FlagDefinition, expectedUpdatedAt: string): void {
    if (flag.updatedAt === expectedUpdatedAt) {
      throw new Error(
        `updatedAt must advance past ${expectedUpdatedAt}, or the guard it writes is the one it matched`,
      );
    }
  }

  /**
   * The one `UPDATE` both `update` and `transition` go through, **scoped to the record's own
   * tenant**.
   *
   * The scope predicate is the write-side half of ADR-0331's defect, and this is where it bit
   * hardest. `flag_id` is table-wide unique, so a platform-scoped write naming a tenant's flag
   * matched it as the owner — and `updateAssignments` covers **`tenant_id`**, so the statement did
   * not merely edit that row, it rewrote the row's scope. Measured live on a fresh cluster as the
   * owner, before the predicate: `update({...flag, tenantId: null}, …)` on a tenant's
   * `checkout.new_pricing` reported success, moved the row to `tenant_id = NULL` and flipped its
   * default from `false` to `true`. The flag was taken away from the tenant and the call said it
   * worked.
   *
   * **Strict** rather than inclusive, which is the opposite choice from every read in this package
   * and the right one. `tenant_id = $n OR tenant_id IS NULL` is correct for a read because a
   * platform-wide flag is *meant* to be evaluated by every tenant's gateway; on a write it is a
   * route from a tenant's session into the platform's row — a tenant flipping
   * `gateway.strict_jwt_aud`, which is exactly the authentication bypass ADR-0332's `config` grant
   * was separated from `record` to prevent.
   *
   * It goes **after** the guard parameter rather than before it, so `guardParam` and the column
   * placeholders keep the positions `flagUpdateAssignments` derives.
   */
  private async guardedWrite(
    flag: FlagDefinition,
    expectedUpdatedAt: string,
    extra: string,
  ): Promise<void> {
    const values = flagRowValues(flag);
    const scope = scopeFilter(flag.tenantId, this.guardParam + 1);
    await this.scopedWrite(flag.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE ${this.schema}.${TABLE} SET ${this.updateAssignments}
         WHERE flag_id = $1 AND ${scope.sql}
           AND updated_at = $${this.guardParam}${extra}`,
        [...values, expectedUpdatedAt, ...scope.params],
      );
      const refusal = await classifyScopedWriteRefusal(tx, result.rowCount, {
        schema: this.schema,
        table: TABLE,
        idColumn: "flag_id",
        idValue: flag.id,
        tenantId: flag.tenantId,
        guard:
          `it was not last updated at ${expectedUpdatedAt} — another writer changed it first, ` +
          "or it is no longer in a status this write may leave",
      });
      if (refusal !== null) {
        throw new FeatureFlagConflictError(
          flag.id,
          expectedUpdatedAt,
          refusal.reason,
          flag.tenantId,
          refusal.storedTenantId,
          refusal.detail,
        );
      }
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

/** The number of bound parameters an INSERT carries — one per column. */
export const FEATURE_FLAG_PARAM_COUNT = FEATURE_FLAG_COLUMN_NAMES.length;
