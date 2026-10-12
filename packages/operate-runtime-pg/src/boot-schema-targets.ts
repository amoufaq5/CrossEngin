import type { Manifest } from "@crossengin/kernel/manifest";
import type { OnDelete } from "@crossengin/types/meta-schema";

import {
  columnPlansForManifest,
  joinTablePlansForManifest,
  relationDeleteIndex,
  type EntityTablePlan,
} from "./column-plan.js";

/** One table the boot manifest's column store created, as the shared-table erasure wants it. */
export interface BootSchemaTarget {
  readonly schema: string;
  readonly table: string;
}

/**
 * The order to empty the boot manifest's column tables in, and what the order could not promise.
 *
 * The two travel together deliberately. A caller handed only the list would have to guess whether
 * it is runnable, and the one thing it must not do is run a list that cannot be: the erasure's
 * first refused `DELETE` aborts the pipeline's transaction, which ADR-0321's runner records as
 * `aborted` and leaves `in_progress` for a human.
 */
export interface BootSchemaErasurePlan {
  /** Every table the store's DDL creates for this manifest, in the order to empty them. */
  readonly targets: readonly BootSchemaTarget[];
  /**
   * Every entity no order could reach because of *delete-blocking* references — empty for every
   * manifest an order exists for, which is all seven shipped packs. Non-empty means no per-table
   * order can run and the erasure must refuse rather than try: `targets` is still total (so a
   * report can name every table) and the order among these members has no property at all.
   *
   * **A superset of the cycle, not the cycle**, and the name is about the consequence rather than
   * the topology: a table that merely sits *behind* a `restrict` cycle is blocked by it and is
   * named here too. That is the fail-closed direction and the right one for a refusal — a message
   * naming only the cycle's members would leave an operator who fixed them meeting the same
   * refusal — but it is why nothing here or downstream says these entities "reference each other".
   */
  readonly blockingCycle: readonly string[];
  /**
   * The `"<entity>.<field>"` references whose ordering this plan had to give up to break a cycle,
   * and what each one costs. Empty for an acyclic reference graph.
   *
   * Only a `cascade` entry here is a *figure* problem: those child rows are destroyed by the
   * parent's statement, so the child's own `DELETE` reports fewer than it removed and the row count
   * the Article 17 proof commits to undercounts. A `set_null` entry destroys nothing early and
   * moves no figure, which is why those are given up first.
   *
   * It **over-reports** in two ways, both conservative. Every same-weight reference inside a stuck
   * component is listed, not only the one whose removal broke the cycle, because which single edge
   * did it is an artefact of the scan order and not a fact about the manifest — and the direction
   * that matters is that a `cascade` undercount is never *missed*. And it is populated even when
   * `blockingCycle` is non-empty, describing an order that will never run, which is why a reader
   * answers the cycle first (`boot-erasure-report.ts` does) rather than reporting a figure cost for
   * a deletion that was refused.
   */
  readonly relaxed: readonly RelaxedReference[];
}

/** One reference the deletion order stopped honouring, with the policy that made it droppable. */
export interface RelaxedReference {
  readonly reference: string;
  readonly target: string;
  readonly onDelete: Exclude<OnDelete, "restrict">;
}

/**
 * The schema `ColumnMappedEntityStore` writes to when a deployment names none.
 *
 * **Exported, because a second spelling of this default is the defect this module exists to close.**
 * `column-store.ts` spells it inline at both of its own call sites and exported no constant, and the
 * cost of that is exact: a different default here would aim the erasure at a schema the store never
 * wrote to, find nothing there, and report an honest zero — so the proof would attest
 * `nothing_to_erase` over rows still on disk. `apps/operate-server` had a third copy. One name now,
 * and the two readers that need it read it rather than restating it.
 */
export const COLUMN_STORE_DEFAULT_SCHEMA = "public";

/**
 * How much a reference's `ON DELETE` policy constrains the order its tables are emptied in.
 *
 * A **total map** over `OnDelete`, so a fourth member is a compile error here rather than
 * inheriting whichever answer an `if` chain happened to end on — `onDeleteClause` is the other
 * total switch over this enum and the two must not disagree about a new one.
 */
const DELETE_ORDER_WEIGHT: Readonly<Record<OnDelete, 0 | 1 | 2>> = {
  // Not negotiable. Postgres refuses the parent's `DELETE` while any child row references it, so an
  // order that violates one of these cannot run at all — it is not a worse order, it is no order.
  restrict: 2,
  // The parent's `DELETE` succeeds and takes the child rows with it, so this edge is satisfiable in
  // either direction — but only one of the two counts honestly. A cascaded child row is destroyed
  // by the *parent's* statement, so the child's own `DELETE` reports fewer rows than it removed and
  // the figure the tombstone commits to undercounts: ADR-0317's class of defect (a proof that is
  // wrong about what it destroyed), not a cosmetic one. Honoured wherever the graph admits it.
  cascade: 1,
  // The parent's `DELETE` succeeds and nulls the reference column, leaving the child row for its own
  // statement to delete and count. Nothing is destroyed early and no figure moves, so this is the
  // first thing to give up when a cycle has to be broken.
  set_null: 0,
};

/** One child→parent reference, carrying how hard it constrains the deletion order. */
interface DeleteEdge {
  readonly child: string;
  readonly parent: string;
  readonly field: string;
  readonly onDelete: OnDelete;
  readonly weight: 0 | 1 | 2;
}

/**
 * Every delete-constraining reference between two *distinct* entities of this plan set, strongest
 * policy winning where one entity references another twice.
 *
 * A **self**-reference is excluded, and that is measured rather than assumed: on PostgreSQL 16.13,
 * with the erasure's own single-statement shape, a self-referencing `ON DELETE RESTRICT` foreign key
 * does not refuse the bulk delete — both rows go and the constraint is not triggered — because the
 * referencing rows are being removed by the same statement. There is no order to choose within one
 * table anyway, so including it could only manufacture a cycle of one.
 *
 * A reference whose target is not in the plan set is excluded for the emitter's reason:
 * `emitForeignKeyDdl` skips a target not in `knownEntities`, so no constraint exists to refuse.
 */
function deleteEdges(
  plans: ReadonlyMap<string, EntityTablePlan>,
  deletePolicies: ReadonlyMap<string, OnDelete>,
): readonly DeleteEdge[] {
  const byPair = new Map<string, DeleteEdge>();
  for (const plan of plans.values()) {
    for (const col of plan.columns) {
      const parent = col.referenceTarget;
      if (parent === null || parent === plan.entity || !plans.has(parent)) continue;
      // The same lookup `emitManifestSchemaDdl` performs, spelled the same way, so the order cannot
      // be computed against a policy the emitted constraint does not carry.
      const onDelete = deletePolicies.get(`${plan.entity}.${col.field}`) ?? "restrict";
      const edge: DeleteEdge = {
        child: plan.entity,
        parent,
        field: col.field,
        onDelete,
        weight: DELETE_ORDER_WEIGHT[onDelete],
      };
      const key = `${plan.entity}\u0000${parent}`;
      const existing = byPair.get(key);
      // Two columns onto one parent are two separate constraints, and the strictest one decides:
      // a `set_null` beside a `restrict` still leaves the parent's delete refused.
      if (existing === undefined || edge.weight > existing.weight) byPair.set(key, edge);
    }
  }
  return [...byPair.values()];
}

/**
 * Kahn's algorithm in the *deletion* direction over one weight tier: a table may be emptied once no
 * remaining table references it.
 *
 * Returns what it could emit and what it could not. `stuck` is the remaining nodes, which is a
 * superset of the cycle — every node still blocked, whether it is in the cycle or merely behind it.
 */
function emptyableOrder(
  remaining: readonly string[],
  edges: readonly DeleteEdge[],
): { readonly emitted: readonly string[]; readonly stuck: readonly string[] } {
  const present = new Set(remaining);
  const children = new Map<string, Set<string>>();
  for (const name of remaining) children.set(name, new Set());
  for (const edge of edges) {
    if (!present.has(edge.child) || !present.has(edge.parent)) continue;
    children.get(edge.parent)?.add(edge.child);
  }
  const emitted: string[] = [];
  const done = new Set<string>();
  // Scanned in the caller's order rather than from a queue, so the result depends only on the
  // manifest's declaration order: the figures go into a signed proof and two runs must not name the
  // tables in two orders.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const name of remaining) {
      if (done.has(name)) continue;
      const blockers = children.get(name);
      if (blockers !== undefined && blockers.size > 0) continue;
      emitted.push(name);
      done.add(name);
      progressed = true;
      for (const set of children.values()) set.delete(name);
    }
  }
  return { emitted, stuck: remaining.filter((n) => !done.has(n)) };
}

/**
 * Every table `ColumnMappedEntityStore.ensureSchema` creates for this manifest, in the order they
 * must be emptied, plus what that order could not promise.
 *
 * ## The order is over the blocking graph, not the reference graph
 *
 * Join tables first, then entity tables child-before-parent — but child-before-parent over the
 * references that actually *block* a delete, which is not the same graph `CREATE TABLE` ordering
 * needs. `topologicalEntityOrder` orders the reference graph and deliberately tolerates a cycle,
 * appending its members in **insertion order** (ADR-0285, because `ensureSchema` adds foreign keys
 * in a second pass once every table exists). Insertion order has no ordering property at all, so
 * reversing that list is not a deletion order wherever the reference graph cycles — and it cycles
 * in all seven shipped packs, where `Employee.department_id -> Department` is declared
 * `onDelete: "set_null"` and so completes `Employee -> Department -> Employee` while constraining
 * no deletion. Measured on PostgreSQL 16.13 against the emitted DDL: emptying `employee` first is
 * refused with `update or delete on table "employee" violates foreign key constraint
 * "fk_department_manager_id" on table "department"`, while `expense`, `department`, `employee`
 * commits. Ordering on the blocking edges only is what distinguishes the two.
 *
 * So a cycle is broken by giving up the **weakest** edge in it (`set_null` before `cascade`, per
 * `DELETE_ORDER_WEIGHT`) and never a `restrict` one, and `relaxed` says which. A cycle of nothing
 * but `restrict` edges is not an order this function can improve on — those entities' rows cannot
 * be removed by any sequence of per-table statements — so it is named in `blockingCycle` for the
 * erasure to refuse by name before it destroys anything, rather than discovered as a refused
 * `DELETE` halfway through a transaction that has already dropped a tenant's schema.
 *
 * ## Where the targets come from
 *
 * The **manifest**, never introspection. `columnPlansForManifest` and `joinTablePlansForManifest`
 * are what created these tables, so they are what name them. Introspecting "every table in this
 * schema with a `tenant_id` column" would make the erasure's target list whatever happens to be in
 * the shared schema, and there is no table-level marker to narrow it with — the emitter writes
 * classification only as `COMMENT ON COLUMN`.
 *
 * It is the **boot** manifest's tables and only those. A tenant serving its own activated manifest
 * holds its column tables in its own schema, which the `tenant_schema` subsystem drops whole
 * (ADR-0314, ADR-0316), and a tenant whose DDL application was refused is served from the JSONB
 * fallback, whose rows `meta.operate_entity_records` already covers.
 *
 * Pure, and issues no SQL: it names tables. Whether they exist, whether the session can see them and
 * whether they emptied is the erasure's business.
 *
 * It **throws** wherever `columnPlansForManifest` does — today only `UndecidedColumnTypeError` for a
 * `duration` field — and that is the fail-closed answer rather than an oversight: a plan this store
 * refuses to build is a plan whose tables it never created, so returning a short list would hand the
 * erasure a target set that silently omits an entity. A deployment serving such a manifest on
 * `pg-columns` cannot boot at all, so the throw is reachable only from a caller asking about a
 * manifest this store does not serve.
 */
export function bootSchemaErasurePlan(
  manifest: Manifest,
  opts?: { readonly schema?: string },
): BootSchemaErasurePlan {
  const schema = opts?.schema ?? COLUMN_STORE_DEFAULT_SCHEMA;
  // Join plans first, which also validates the schema name before anything else is derived: a
  // manifest with no entities never reaches `columnPlanForEntity`'s check, and a target list is
  // interpolated into `DELETE FROM <schema>.<table>` by the caller.
  const joinPlans = joinTablePlansForManifest(manifest, { schema });
  const plans = columnPlansForManifest(manifest, { schema });

  const edges = deleteEdges(plans, relationDeleteIndex(manifest));
  const names = [...plans.keys()];
  const ordered: string[] = [];
  const relaxed: RelaxedReference[] = [];
  let remaining: readonly string[] = names;
  for (const minWeight of [0, 1, 2] as const) {
    const pass = emptyableOrder(
      remaining,
      edges.filter((e) => e.weight >= minWeight),
    );
    ordered.push(...pass.emitted);
    remaining = pass.stuck;
    if (remaining.length === 0) break;
    // Stuck, so the next tier stops honouring this tier's edges. Record only the ones among the
    // stuck nodes: an edge the order already satisfied is not something it gave up.
    const stillStuck = new Set(remaining);
    for (const edge of edges) {
      if (edge.weight !== minWeight) continue;
      if (!stillStuck.has(edge.child) || !stillStuck.has(edge.parent)) continue;
      if (edge.onDelete === "restrict") continue;
      relaxed.push({
        reference: `${edge.child}.${edge.field}`,
        target: edge.parent,
        onDelete: edge.onDelete,
      });
    }
  }
  // A cycle of `restrict` edges only. The list stays total so a report can name every table, and
  // `blockingCycle` is what says the tail of it is not an order.
  const blockingCycle = remaining;
  ordered.push(...blockingCycle);

  const targets: BootSchemaTarget[] = [];
  // The join tables are targets too. The store creates them (`emitManifestSchemaDdl` emits a
  // `CREATE TABLE` for every join plan, whether or not either side's entity is present) and they
  // carry `tenant_id`. Omitting them would not merely leave link rows behind: both of their foreign
  // keys are `ON DELETE CASCADE`, so the entity deletes would take the link rows away *silently*,
  // and the proof would commit to a `rowCount` and a `tables` list naming neither.
  for (const plan of joinPlans) targets.push({ schema: plan.schema, table: plan.table });
  for (const name of ordered) {
    const plan = plans.get(name);
    if (plan !== undefined) targets.push({ schema: plan.schema, table: plan.table });
  }

  // One physical table named once. Two entities can snake-case to one table name, and an entity can
  // collide with a join table's `<left>_<right>`; the store serves such a manifest as a single
  // merged table, so a doubled target would double-count the `storageBytes` a proof commits to while
  // the second DELETE reported zero. The first occurrence wins, which keeps the child-before-parent
  // ordering above intact.
  const seen = new Set<string>();
  return {
    targets: targets.filter((t) => {
      const key = `${t.schema}.${t.table}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    blockingCycle,
    relaxed,
  };
}

/**
 * The target list alone, for a caller that has already dealt with `blockingCycle`.
 *
 * Deliberately **not** the whole module's entry point: a caller holding only this cannot tell a
 * runnable order from one the database will refuse partway through, and the erasure is exactly that
 * caller. Kept because a boot report and a test want the names without re-deriving the rest.
 */
export function bootSchemaErasureTargets(
  manifest: Manifest,
  opts?: { readonly schema?: string },
): readonly BootSchemaTarget[] {
  return bootSchemaErasurePlan(manifest, opts).targets;
}
