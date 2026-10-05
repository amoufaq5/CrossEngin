import { setPlatformWriteSql, type PgConnection } from "@crossengin/kernel-pg";
import {
  DEFINITION_STATUSES,
  WorkflowDefinitionSchema,
  canTransitionDefinition,
  type DefinitionStatus,
  type WorkflowDefinition,
} from "@crossengin/workflow-engine";
import {
  MUTABLE_DEFINITION_STATUSES,
  definitionContentSha256,
  planDefinitionPublication,
  type DefinitionPublicationDecision,
  type DefinitionPublicationRefusal,
  type StoredDefinitionSummary,
} from "./definition-authoring.js";
import type { WorkflowDefinitionIdResolver } from "./id-mapping.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "workflow_definitions";

/** Mirrors `feature-flags-pg`'s helpers rather than importing them: this package has no edge to it. */
export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

/**
 * The elevation a platform-wide definition write needs.
 *
 * `app.platform_config_write` rather than a grant of its own, because a published workflow
 * definition is configuration in the same sense a feature flag is: it decides what the deployment
 * *does*, and a forged platform-wide one gives every tenant without its own a state machine the
 * platform did not author. The elevation reaches `INSERT` and `UPDATE` but never `DELETE` — the
 * contract retires a definition through `DEFINITION_TRANSITIONS`, not by removing the row.
 */
export const SET_PLATFORM_CONFIG_WRITE_SQL = setPlatformWriteSql("config");

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

export function assertTenantId(tenantId: string): void {
  throwUnless(TENANT_ID_RE.test(tenantId), `invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
}

function throwUnless(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** A `tenant_id` predicate and the parameters it binds, for one scope. */
export interface ScopeFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Builds this transaction's scope predicate at a given placeholder index.
 *
 * A factory rather than a prebuilt `ScopeFilter`, because the index is a property of the *query*,
 * not of the scope: `loadEngineDefinitions` binds the predicate at `$1` and `loadByKeyVersion` at
 * `$3`. Handing every query one filter would make the caller renumber it, which is exactly the kind
 * of restating this sweep is removing.
 */
export type ScopeFactory = (firstParam: number) => ScopeFilter;

/**
 * The `tenant_id` predicate every read here must carry, **beside** RLS rather than instead of it.
 *
 * **A table's owner bypasses its policies** (ADR-0331), and connecting as the owner is an ordinary
 * deployment — so a read that leans on RLS to confine it is right as a non-owner and wrong as the
 * owner, which is the worse of the two because it is the one nobody notices. On this table the
 * consequence was sharp in two directions. `loadByKeyVersion` ordered `tenant_id NULLS LAST` and
 * took the first row: the right tie-break for a *tenant* read, where its own row should beat the
 * platform's, and exactly backwards for a *platform* read, where it ranks a tenant's row first. And
 * `loadEngineDefinitions` carried no predicate at all, so as the owner it loaded every tenant's
 * definitions into one map keyed by `definitionId` — inflating the `definitionCount` that the worker
 * supervisor's `no_definitions` refusal reads, and letting the row limit crowd the platform's
 * definitions out of the map an instance's timer resolves its definition from.
 *
 * The predicate **branches** rather than using `tenant_id IS NOT DISTINCT FROM $1`, the one operator
 * matching NULL to NULL and so the one that would give a single code path. Measured on this table
 * at 45,003 rows, both spellings returning the same 901 platform rows: `IS NOT DISTINCT FROM` with
 * a *bound parameter* — which is how a store issues it — plans a **Seq Scan at 24.7 ms**, against
 * **1.7 ms** for `tenant_id IS NULL` on `idx_workflow_definitions_platform_key_version`. With a
 * *literal* NULL Postgres constant-folds it and the cost vanishes, which is exactly why the penalty
 * is invisible in psql and real in production.
 *
 * Verbatim from `crypto-pg`/`forensics-pg`; one idiom across the sweep, not a third spelling.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  // `tenant_id = NULL` is never true, so the platform scope has to be asked for as `IS NULL`.
  if (tenantId === null) return { sql: "tenant_id IS NULL", params: [] };
  assertTenantId(tenantId);
  return { sql: `tenant_id = $${String(firstParam)}`, params: [tenantId] };
}

/**
 * `scopeFilter` with the platform's rows kept in a tenant's answer — **the form every read in this
 * store wants**, and the one the table's own policy grants.
 *
 * The rule for choosing between the two is Lane E's: **the predicate reproduces what a non-owner
 * would have been shown, no wider and no narrower.** `meta.workflow_definitions` does not carry
 * plain `TENANT_ISOLATION_USING` — it carries the isolation policy plus a platform read arm — so a
 * non-owner tenant session is shown its own rows *and* the platform's. That is not an accident to
 * be tightened away: a deployment-wide definition with no tenant of its own is precisely how a
 * tenant without its own gets a state machine, and the strict arm would have made this store
 * owner-independent by destroying that rather than by reproducing it.
 *
 * For the platform scope the two functions agree on `tenant_id IS NULL`, and that is the arm the
 * defect was in: the platform read was the one answering with a tenant's row.
 *
 * Still indexable, and verified so here rather than assumed: Postgres plans the disjunction as a
 * **BitmapOr** over `idx_workflow_definitions_tenant_key` and the partial
 * `idx_workflow_definitions_platform_key_version (… ) WHERE tenant_id IS NULL`, because each arm is
 * an indexable operator on its own. That partial index is the platform arm written down in the
 * catalog, which is the clearest sign the two-arm reading is the intended one. It is also the
 * property `IS NOT DISTINCT FROM` lacks.
 */
export function scopeFilterWithPlatform(
  tenantId: string | null,
  firstParam = 1,
): ScopeFilter {
  if (tenantId === null) return scopeFilter(null, firstParam);
  assertTenantId(tenantId);
  return {
    sql: `(tenant_id = $${String(firstParam)} OR tenant_id IS NULL)`,
    params: [tenantId],
  };
}

/**
 * The columns of `meta.workflow_definitions` in the order `definitionRowValues` supplies them.
 * Every statement derives its column list, placeholders and UPDATE assignments from this one array,
 * so a column added in the middle cannot leave an INSERT and an UPDATE disagreeing about which
 * `$n` means what.
 *
 * `id` is absent on purpose: it is the surrogate key with a `uuid_generate_v7()` default, while
 * `definition_id` is the contract's own `wfd_…` id — the one a caller holds, an UPDATE matches on,
 * and `WorkflowDefinitionIdResolver` translates.
 *
 * Unlike `meta.feature_flags` (ADR-0300) this table had **not** drifted in column coverage: all 22
 * contract fields have a column and no column is contract-less. What it lacks is constraints, and
 * those are reported with the reconciliation rather than worked around here.
 */
export const WORKFLOW_DEFINITION_COLUMN_NAMES: readonly string[] = Object.freeze([
  "definition_id",
  "tenant_id",
  "definition_key",
  "version",
  "label",
  "description",
  "status",
  "states",
  "transitions",
  "variables",
  "timers",
  "signals",
  "initial_state",
  "compensation_strategy",
  "timeout_seconds",
  "created_at",
  "created_by",
  "published_at",
  "published_by",
  "deprecated_at",
  "superseded_by_definition_id",
  "source_manifest_sha256",
]);

export const WORKFLOW_DEFINITION_JSONB_COLUMNS: ReadonlySet<string> = new Set([
  "states",
  "transitions",
  "variables",
  "timers",
  "signals",
]);

export const WORKFLOW_DEFINITION_COLUMNS = WORKFLOW_DEFINITION_COLUMN_NAMES.join(", ");

/** `$1, $8::jsonb, …` positionally matching `WORKFLOW_DEFINITION_COLUMN_NAMES`. */
export function definitionPlaceholders(): string {
  return WORKFLOW_DEFINITION_COLUMN_NAMES.map(
    (col, i) => `$${i + 1}${WORKFLOW_DEFINITION_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
  ).join(", ");
}

/**
 * `col = $n` for every column except the first, which is the key an UPDATE matches on.
 *
 * `definition_key` and `tenant_id` are assigned like any other column, which looks redundant since
 * the UPDATE matches a `definition_id` that is unique table-wide. It is not: writing them means a
 * row whose key or tenant was edited out from under the contract converges on the next publication
 * instead of being silently preserved.
 */
export function definitionUpdateAssignments(): string {
  return WORKFLOW_DEFINITION_COLUMN_NAMES.slice(1)
    .map(
      (col, i) =>
        `${col} = $${i + 2}${WORKFLOW_DEFINITION_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
    )
    .join(", ");
}

/** The row values for a `WorkflowDefinition`, positionally matching `WORKFLOW_DEFINITION_COLUMNS`. */
export function definitionRowValues(record: WorkflowDefinition): readonly unknown[] {
  const valid = WorkflowDefinitionSchema.parse(record);
  return [
    valid.id,
    valid.tenantId,
    valid.definitionKey,
    valid.version,
    valid.label,
    valid.description,
    valid.status,
    JSON.stringify(valid.states),
    JSON.stringify(valid.transitions),
    JSON.stringify(valid.variables),
    JSON.stringify(valid.timers),
    JSON.stringify(valid.signals),
    valid.initialState,
    valid.compensationStrategy,
    valid.timeoutSeconds,
    valid.createdAt,
    valid.createdBy,
    valid.publishedAt,
    valid.publishedBy,
    valid.deprecatedAt,
    valid.supersededByDefinitionId,
    valid.sourceManifestSha256,
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
  return value === null || value === undefined ? null : asIso(value);
}

function asJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * Rebuilds the `WorkflowDefinition` from a row and **re-validates it** (ADR-0289).
 *
 * The row *is* the definition the engine will execute, and the contract's cross-field invariants
 * are the only thing between a hand-edited row and a state machine the platform drives: that
 * exactly one state is `initial`, that `initialState` names a declared state, that no transition
 * departs a terminal state, that every `signal_received` trigger names a declared signal, and that
 * a `published` definition carries two *different* people. None of those is expressible as a CHECK
 * — they all need `jsonb_array_elements`, which a CHECK admits no more than it admits an aggregate
 * — so this is the one place they hold for a stored row. A row that cannot answer them raises here
 * rather than being served, because a shorter answer would be an engine running a definition the
 * contract forbids.
 */
export function rowToWorkflowDefinition(row: Record<string, unknown>): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    id: asString(row["definition_id"]),
    tenantId: asNullableString(row["tenant_id"]),
    definitionKey: asString(row["definition_key"]),
    version: asString(row["version"]),
    label: asString(row["label"]),
    description: asString(row["description"]),
    status: asString(row["status"]),
    states: asJson(row["states"]),
    transitions: asJson(row["transitions"]),
    variables: asJson(row["variables"]),
    timers: asJson(row["timers"]),
    signals: asJson(row["signals"]),
    initialState: asString(row["initial_state"]),
    compensationStrategy: asString(row["compensation_strategy"]),
    timeoutSeconds: Number(row["timeout_seconds"]),
    createdAt: asIso(row["created_at"]),
    createdBy: asString(row["created_by"]),
    publishedAt: asNullableIso(row["published_at"]),
    publishedBy: asNullableString(row["published_by"]),
    deprecatedAt: asNullableIso(row["deprecated_at"]),
    supersededByDefinitionId: asNullableString(row["superseded_by_definition_id"]),
    sourceManifestSha256: asNullableString(row["source_manifest_sha256"]),
  });
}

/**
 * The summary the planner compares against, computed from the re-parsed row rather than read from a
 * stored digest column.
 *
 * There is no such column, and that is the better arrangement: ADR-0323 found that a digest which
 * does not commit to the thing it describes detects nothing, so recomputing means a row edited
 * after it was published compares *unequal* to the definition that produced it, instead of matching
 * a digest somebody could have edited alongside it.
 */
export function summarizeDefinition(
  definition: WorkflowDefinition,
): StoredDefinitionSummary {
  return {
    id: definition.id,
    tenantId: definition.tenantId,
    definitionKey: definition.definitionKey,
    version: definition.version,
    status: definition.status,
    contentSha256: definitionContentSha256(definition),
  };
}

/**
 * The statuses a definition may be in to legally reach `to`, read off `DEFINITION_TRANSITIONS`.
 * Quoting is safe because the values come from the contract's frozen status tuple, never a caller.
 */
function predecessorsOf(to: DefinitionStatus): readonly DefinitionStatus[] {
  return DEFINITION_STATUSES.filter((from) => canTransitionDefinition(from, to));
}

function quoted(statuses: readonly string[]): string {
  return statuses.map((s) => `'${s}'`).join(", ");
}

const MUTABLE_SQL = quoted([...MUTABLE_DEFINITION_STATUSES]);

export class WorkflowDefinitionConflictError extends Error {
  constructor(
    readonly definitionId: string,
    readonly reason: string,
  ) {
    super(`workflow definition '${definitionId}' could not be written: ${reason}`);
    this.name = "WorkflowDefinitionConflictError";
  }
}

export interface DefinitionWriteResult {
  readonly decision: DefinitionPublicationDecision;
  readonly refusal: DefinitionPublicationRefusal | null;
  readonly detail: string | null;
  readonly contentSha256: string;
  /** The row's surrogate uuid, which is what `meta.workflow_instances.definition_id` references. */
  readonly rowId: string | null;
}

export interface PostgresWorkflowDefinitionStoreOptions {
  readonly schema?: string;
  /**
   * When supplied, every definition this store reads or writes registers its `wfd_…` → row-uuid
   * mapping here, so `PostgresInstanceStore.create` does not re-query for it on the first instance
   * of each definition.
   */
  readonly definitionResolver?: WorkflowDefinitionIdResolver;
}

export interface LoadEngineDefinitionsOptions {
  readonly tenantId?: string | null;
  readonly limit?: number;
}

/**
 * The default ceiling on a loaded definition map. Generous: the catalog is per-deployment, not
 * per-instance, and hitting it raises rather than truncating (see `loadEngineDefinitions`).
 */
export const DEFAULT_DEFINITION_LOAD_LIMIT = 2000;

/**
 * Persists `WorkflowDefinition` records in `meta.workflow_definitions` — the source of definitions
 * that `buildPersistentEngine` has had no way to obtain since it was written (ADR-0330).
 *
 * **Tenant scoping is conditional**, as in `PostgresFeatureFlagStore`, and for the same reason read
 * off the contract: `WorkflowDefinition.tenantId` is `.nullable()`, so a definition is either one
 * tenant's or the platform's, and the table already carries the matching policy — `tenant_id IS
 * NULL OR tenant_id = …` — rather than plain `TENANT_ISOLATION_USING`. Under plain isolation a
 * platform-wide definition would be invisible to every reader including the one that wrote it. An
 * unconditional `withTenantContext` wrapper is wrong for the mirror-image reason: setting a tenant
 * context around a platform-wide write would hide the very row being written. So a write takes its
 * scope from the record's own `tenantId`, and a read takes an optional one defaulting to null,
 * where RLS exposes exactly the platform-wide rows — the fail-closed answer for a caller that has
 * not said whose definitions it wants.
 *
 * **There is no `revision` and no `updated_at` column, so a status change is guarded by the status
 * itself.** The predecessors of the target status go into the `UPDATE` predicate, so the row is the
 * lock (ADR-0321): two publishers racing one `in_review` definition means one `UPDATE` matches and
 * the other matches zero rows and raises. That is a stronger guard than a timestamp token, not a
 * weaker one — it cannot be defeated by a caller reusing the value it read — and it needs no column
 * the table does not have.
 */
export class PostgresWorkflowDefinitionStore {
  private readonly schema: string;
  private readonly resolver: WorkflowDefinitionIdResolver | null;
  private readonly placeholders: string;
  private readonly updateAssignments: string;
  /** The guard binds after every column value, so it is always the next placeholder. */
  private readonly guardParam: number;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresWorkflowDefinitionStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    throwUnless(
      SCHEMA_RE.test(this.schema),
      `invalid schema identifier: ${JSON.stringify(this.schema)}`,
    );
    this.resolver = options.definitionResolver ?? null;
    this.placeholders = definitionPlaceholders();
    this.updateAssignments = definitionUpdateAssignments();
    this.guardParam = WORKFLOW_DEFINITION_COLUMN_NAMES.length + 1;
  }

  /**
   * Plans a publication against what is stored and carries it out, in one transaction.
   *
   * One transaction because the plan is a read followed by a write whose premise is what the read
   * saw; splitting them would let a second publisher land between the two. Each statement then
   * **re-asserts** that premise in its own predicate, so the transaction is the window and the
   * predicate is the lock.
   *
   * The result is a report and not an exception for the planned refusals: "this version is already
   * published with different content" is an answer a caller acts on, while a predicate that matches
   * zero rows after the plan said it would is a broken premise and raises.
   */
  async publish(definition: WorkflowDefinition): Promise<DefinitionWriteResult> {
    const valid = WorkflowDefinitionSchema.parse(definition);
    return this.scopedWrite(valid.tenantId, async (tx, scopeOf) => {
      const stored = await this.gatherForPublication(tx, valid, scopeOf);
      const plan = planDefinitionPublication({ proposed: valid, stored });
      if (plan.decision === "refused" || plan.decision === "unchanged") {
        const rowId =
          plan.decision === "unchanged" ? await this.rowIdOf(tx, valid.id, scopeOf) : null;
        return {
          decision: plan.decision,
          refusal: plan.refusal,
          detail: plan.detail,
          contentSha256: plan.contentSha256,
          rowId,
        };
      }
      const rowId =
        plan.decision === "insert"
          ? await this.insertRow(tx, valid)
          : await this.updateRow(tx, valid, plan.decision);
      if (this.resolver !== null) this.resolver.register(valid.id, rowId);
      return {
        decision: plan.decision,
        refusal: null,
        detail: null,
        contentSha256: plan.contentSha256,
        rowId,
      };
    });
  }

  async loadById(
    definitionId: string,
    tenantId: string | null = null,
  ): Promise<WorkflowDefinition | null> {
    return this.scoped(tenantId, async (tx, scopeOf) => {
      const scope = scopeOf(2);
      const result = await tx.query<Record<string, unknown>>(
        `SELECT id, ${WORKFLOW_DEFINITION_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE definition_id = $1 AND ${scope.sql}`,
        [definitionId, ...scope.params],
      );
      return this.firstDefinition(result.rows);
    });
  }

  async loadByKeyVersion(
    definitionKey: string,
    version: string,
    tenantId: string | null = null,
  ): Promise<WorkflowDefinition | null> {
    return this.scoped(tenantId, async (tx, scopeOf) => {
      const scope = scopeOf(3);
      const result = await tx.query<Record<string, unknown>>(
        `SELECT id, ${WORKFLOW_DEFINITION_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE definition_key = $1 AND version = $2 AND ${scope.sql}
         ORDER BY tenant_id NULLS LAST`,
        [definitionKey, version, ...scope.params],
      );
      return this.firstDefinition(result.rows);
    });
  }

  /**
   * Every stored version of a key, as summaries.
   *
   * `tenant_id NULLS LAST` on the companion lookups is not cosmetic: a tenant-scoped read sees its
   * own rows *and* the platform-wide ones, so a key held by both would otherwise answer whichever
   * Postgres returned first. The tenant's own row wins, which is the only reading under which a
   * tenant's definition means anything — and `planDefinitionPublication` refuses to create that
   * ambiguity in the first place.
   *
   * That tie-break was never the defect, and it is worth being exact about why: it is right for a
   * tenant read and backwards for a platform one, where it ranks a tenant's row *first*. What makes
   * it right in both directions now is the `scopeFilter` beside it — a platform read is
   * `tenant_id IS NULL`, so there are no tenant rows left for the ordering to prefer.
   */
  async listByKey(
    definitionKey: string,
    tenantId: string | null = null,
  ): Promise<readonly StoredDefinitionSummary[]> {
    return this.scoped(tenantId, (tx, scopeOf) =>
      this.summariesForKey(tx, definitionKey, scopeOf),
    );
  }

  /**
   * The map `buildPersistentEngine` and `ProjectingEventLog` take, **keyed by `definition.id`**.
   *
   * That key is not a choice. `startInstance` looks the proposal up by `input.definitionId`, then
   * records `definitionId: definition.id` in the `instance_started` payload; `projectInstance`
   * reads that payload field into `ProjectedInstance.definitionId`, and every later lookup — timer
   * firing, signal delivery, activity execution, compensation, cancellation — is
   * `definitions.get(state.definitionId)`. Keying by `definitionKey` would make `startInstance`
   * succeed and every subsequent lookup miss.
   *
   * **Every status is loaded, not only `published`.** A missing definition does not raise in the
   * engine: it `continue`s past a due timer, declines a signal, reports `executed: false` for a
   * claimed activity and answers `strategy: null` for a compensation. So a map narrowed to
   * `published` would make in-flight instances of a *deprecated* definition go quiet — the silent
   * degradation ADR-0327 refuses — while `startInstance` and `resolveChildDefinition` already
   * refuse a non-published definition by name. The status filter belongs to the engine, which says
   * so; it does not belong to the loader, which cannot.
   *
   * Hitting `limit` **raises**. A truncated map is the same failure as a narrowed one, except
   * nothing would report it.
   */
  async loadEngineDefinitions(
    options: LoadEngineDefinitionsOptions = {},
  ): Promise<ReadonlyMap<string, WorkflowDefinition>> {
    const limit = options.limit ?? DEFAULT_DEFINITION_LOAD_LIMIT;
    throwUnless(limit > 0, "limit must be positive");
    return this.scoped(options.tenantId ?? null, async (tx, scopeOf) => {
      const scope = scopeOf(1);
      const result = await tx.query<Record<string, unknown>>(
        `SELECT id, ${WORKFLOW_DEFINITION_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE ${scope.sql}
         ORDER BY definition_key, version
         LIMIT $${String(scope.params.length + 1)}`,
        [...scope.params, limit + 1],
      );
      if (result.rows.length > limit) {
        throw new Error(
          `workflow definition map hit its ${limit}-row limit; a truncated map silently stops ` +
            "every instance whose definition fell off the end",
        );
      }
      const map = new Map<string, WorkflowDefinition>();
      for (const row of result.rows) {
        const definition = rowToWorkflowDefinition(row);
        const previous = map.get(definition.id);
        if (previous !== undefined) {
          throw new Error(
            `two rows claim workflow definition id ${definition.id} — the engine keys by it`,
          );
        }
        map.set(definition.id, definition);
        if (this.resolver !== null) this.resolver.register(definition.id, asString(row["id"]));
      }
      return map;
    });
  }

  private firstDefinition(
    rows: readonly Record<string, unknown>[],
  ): WorkflowDefinition | null {
    const row = rows[0];
    if (row === undefined) return null;
    const definition = rowToWorkflowDefinition(row);
    if (this.resolver !== null) this.resolver.register(definition.id, asString(row["id"]));
    return definition;
  }

  private async summariesForKey(
    tx: PgConnection,
    definitionKey: string,
    scopeOf: ScopeFactory,
  ): Promise<readonly StoredDefinitionSummary[]> {
    const scope = scopeOf(2);
    const result = await tx.query<Record<string, unknown>>(
      `SELECT id, ${WORKFLOW_DEFINITION_COLUMNS} FROM ${this.schema}.${TABLE}
       WHERE definition_key = $1 AND ${scope.sql}
       ORDER BY tenant_id NULLS LAST, version`,
      [definitionKey, ...scope.params],
    );
    return result.rows.map((row) => summarizeDefinition(rowToWorkflowDefinition(row)));
  }

  /**
   * What the planner needs to see: every row sharing the proposal's key, plus the row (if any)
   * already holding its `wfd_…` id.
   *
   * Two narrow indexed queries rather than loading the table, because `definition_id_reused` is a
   * question about the whole id space and `version_not_monotonic` is a question about one key, and
   * only the second has a useful index. The id lookup is deduplicated against the key list so a row
   * that answers both does not appear twice and read as two conflicting facts.
   */
  private async gatherForPublication(
    tx: PgConnection,
    proposed: WorkflowDefinition,
    scopeOf: ScopeFactory,
  ): Promise<readonly StoredDefinitionSummary[]> {
    const byKey = await this.summariesForKey(tx, proposed.definitionKey, scopeOf);
    if (byKey.some((s) => s.id === proposed.id)) return byKey;
    // Scoped like every other read, and that narrows `definition_id_reused` to the scope doing the
    // publishing. It is the right narrowing: the rule reproduces what a non-owner would see, and a
    // non-owner platform session cannot see a tenant's rows. A cross-scope id collision is still
    // caught, one step later and loudly — `loadEngineDefinitions` raises "two rows claim workflow
    // definition id …", because the map a tenant's engine loads holds both scopes' rows and keys
    // by that id.
    const scope = scopeOf(2);
    const result = await tx.query<Record<string, unknown>>(
      `SELECT id, ${WORKFLOW_DEFINITION_COLUMNS} FROM ${this.schema}.${TABLE}
       WHERE definition_id = $1 AND ${scope.sql}`,
      [proposed.id, ...scope.params],
    );
    const row = result.rows[0];
    if (row === undefined) return byKey;
    return [...byKey, summarizeDefinition(rowToWorkflowDefinition(row))];
  }

  private async rowIdOf(
    tx: PgConnection,
    definitionId: string,
    scopeOf: ScopeFactory,
  ): Promise<string | null> {
    const scope = scopeOf(2);
    const result = await tx.query<{ id: string }>(
      `SELECT id FROM ${this.schema}.${TABLE} WHERE definition_id = $1 AND ${scope.sql}`,
      [definitionId, ...scope.params],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (this.resolver !== null) this.resolver.register(definitionId, row.id);
    return row.id;
  }

  private async insertRow(
    tx: PgConnection,
    definition: WorkflowDefinition,
  ): Promise<string> {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO ${this.schema}.${TABLE} (${WORKFLOW_DEFINITION_COLUMNS})
       VALUES (${this.placeholders})
       RETURNING id`,
      [...definitionRowValues(definition)],
    );
    const row = result.rows[0];
    if (row === undefined) {
      // Only reachable if `definition_id`'s unique constraint fired between the plan and here,
      // which the plan said could not happen — so the premise is broken, not the request.
      throw new WorkflowDefinitionConflictError(
        definition.id,
        "a concurrent publication claimed this definition id",
      );
    }
    return row.id;
  }

  /**
   * The guarded UPDATE for a `replace_draft` or a `transition_status`.
   *
   * The predicate carries three things the plan asserted. The **status set** re-asserts it: the
   * statuses the target may be reached from for a lifecycle move, and the editable set for a draft
   * rewrite. The **four-eyes predicate** `created_by <> $publishedBy` is the third layer on the one
   * rule the contract already enforces in `superRefine` and the table should enforce as a CHECK
   * (ADR-0313's shape) — carried here because the contract's copy holds for a value in memory and
   * this one holds for the row, so a published definition cannot be its own author's doing even if
   * a caller assembled the record by hand.
   */
  private async updateRow(
    tx: PgConnection,
    definition: WorkflowDefinition,
    decision: Extract<DefinitionPublicationDecision, "replace_draft" | "transition_status">,
  ): Promise<string> {
    const statuses =
      decision === "replace_draft" ? MUTABLE_SQL : quoted(predecessorsOf(definition.status));
    throwUnless(
      statuses.length > 0,
      `no status can transition to '${definition.status}' — it is reached by insert, not by update`,
    );
    const values = definitionRowValues(definition);
    const fourEyes =
      definition.status === "published" && definition.publishedBy !== null
        ? ` AND created_by <> $${this.guardParam}`
        : "";
    const params =
      fourEyes === "" ? [...values] : [...values, definition.publishedBy];
    const result = await tx.query<{ id: string }>(
      `UPDATE ${this.schema}.${TABLE} SET ${this.updateAssignments}
       WHERE definition_id = $1 AND status IN (${statuses})${fourEyes}
       RETURNING id`,
      params,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WorkflowDefinitionConflictError(
        definition.id,
        `no row in status ${statuses} with a different creator — another writer moved it first`,
      );
    }
    return row.id;
  }

  /**
   * A **read**'s scope: a tenant context, or nothing at all — the platform read policy is
   * `SELECT`-scoped on `tenant_id IS NULL` and demands no grant, which is what this did before the
   * policy split and what it keeps doing.
   */
  private scoped<T>(
    tenantId: string | null,
    fn: (tx: PgConnection, scopeOf: ScopeFactory) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    // The predicate every query inside gets, handed down rather than recomputed from a field, so a
    // read cannot be issued under one scope and filtered by another.
    const scopeOf: ScopeFactory = (firstParam) => scopeFilterWithPlatform(tenantId, firstParam);
    return this.conn.transaction(async (tx) => {
      if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx, scopeOf);
    });
  }

  /**
   * A **write**'s scope: a tenant context, or the platform config-write elevation, never both.
   *
   * `publish` reads and then writes inside one transaction, so the elevation is claimed for the
   * whole of it. That costs nothing a read could abuse — the read arm of the platform policy needs
   * no grant either way — and it is the only arrangement in which the plan's premise and the
   * statement that re-asserts it are under one scope.
   */
  private scopedWrite<T>(
    tenantId: string | null,
    fn: (tx: PgConnection, scopeOf: ScopeFactory) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    const scopeOf: ScopeFactory = (firstParam) => scopeFilterWithPlatform(tenantId, firstParam);
    return this.conn.transaction(async (tx) => {
      if (tenantId === null) await tx.query(SET_PLATFORM_CONFIG_WRITE_SQL);
      else await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx, scopeOf);
    });
  }
}

/** The number of bound parameters an INSERT carries — one per column. */
export const WORKFLOW_DEFINITION_PARAM_COUNT = WORKFLOW_DEFINITION_COLUMN_NAMES.length;
