import { manifestAssociationRoutes } from "@crossengin/operate-runtime";
import type { Manifest } from "@crossengin/kernel/manifest";

/**
 * The structural capability the sweep needs: prune one relation's dangling
 * association links. `PostgresEntityStore.pruneDanglingLinks` satisfies it; the
 * column store doesn't (its join-table FKs cascade, so it never dangles).
 *
 * **The read order and the writer premise it needs** (ADR-0481; ADR-0407's survey found this
 * comparison right and its reason written nowhere). The implementation reads the links first and
 * the two record-id sets second, in one READ COMMITTED transaction — so one transaction and not one
 * snapshot — and deletes every link whose endpoints the *later* read did not find. That is the safe
 * order, the containing side read second: a record created in the window is in the set it is
 * compared against, and a link created in the window is not in the set being pruned. Reversed, the
 * sweep would delete links whose records were created between the two reads.
 *
 * What the order cannot supply is the premise it rests on: that a link is written only for records
 * that already exist. **No writer establishes that.** `PostgresEntityStore.link` is a bare `INSERT`
 * and the association route calls it without reading either record, so a client that links a
 * record id and then creates the record leaves a link that is "dangling" for exactly that interval,
 * and a sweep landing inside it deletes a link the client meant. Bounded by the sweep's cadence and
 * by clients writing in that order; stated here rather than fixed, because the fix is on the write
 * side (`association.ts` and the store), not in this sweep.
 */
export interface DanglingLinkPruner {
  pruneDanglingLinks(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    opts?: { readonly dryRun?: boolean },
  ): Promise<{ readonly pruned: number; readonly kept: number }>;
}

/**
 * Structural guard for `DanglingLinkPruner`. The JSONB `PostgresEntityStore`
 * satisfies it (it owns the `operate_entity_links` table); the column store does
 * not (its join-table FKs cascade, so there's nothing to prune).
 */
export function isDanglingLinkPruner(store: unknown): store is DanglingLinkPruner {
  return typeof (store as { pruneDanglingLinks?: unknown } | null)?.pruneDanglingLinks === "function";
}

/** Options common to the single- and multi-tenant sweeps. */
export interface SweepOptions {
  /** Report what would be pruned without deleting anything. */
  readonly dryRun?: boolean;
}

/** A `many_to_many` relation as (left, right) entities in canonical order. */
export interface RelationPair {
  readonly left: string;
  readonly right: string;
}

export interface SweepRelationResult extends RelationPair {
  readonly pruned: number;
  readonly kept: number;
}

export interface SweepReport {
  readonly relations: readonly SweepRelationResult[];
  readonly totalPruned: number;
  readonly totalKept: number;
}

export interface TenantSweepReport {
  readonly tenantId: string;
  readonly report: SweepReport;
}

export interface MultiTenantSweepReport {
  readonly tenants: readonly TenantSweepReport[];
  readonly totalPruned: number;
  readonly totalKept: number;
  readonly dryRun: boolean;
}

/**
 * The distinct `many_to_many` relation pairs to sweep, derived from the
 * manifest. `manifestAssociationRoutes` yields two specs per relation (one per
 * direction) carrying the same canonical `(left, right)`; this de-dupes them to
 * one pair per relation (a self-relation is already a single spec).
 */
export function relationPairsFromManifest(manifest: Manifest): readonly RelationPair[] {
  const seen = new Set<string>();
  const pairs: RelationPair[] = [];
  for (const spec of manifestAssociationRoutes(manifest)) {
    const key = `${spec.left}\u0000${spec.right}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ left: spec.left, right: spec.right });
  }
  return pairs;
}

/**
 * Prunes every relation's dangling links for one tenant, aggregating the
 * per-relation `{pruned, kept}` counts. Pure orchestration over the structural
 * pruner, so it's driven identically by the CLI runner and by tests.
 */
export async function sweepDanglingLinks(
  pruner: DanglingLinkPruner,
  pairs: readonly RelationPair[],
  tenantId: string,
  opts: SweepOptions = {},
): Promise<SweepReport> {
  const relations: SweepRelationResult[] = [];
  let totalPruned = 0;
  let totalKept = 0;
  for (const pair of pairs) {
    const { pruned, kept } = await pruner.pruneDanglingLinks(tenantId, pair.left, pair.right, {
      dryRun: opts.dryRun === true,
    });
    relations.push({ left: pair.left, right: pair.right, pruned, kept });
    totalPruned += pruned;
    totalKept += kept;
  }
  return { relations, totalPruned, totalKept };
}

/**
 * Sweeps every tenant in `tenantIds`, one after another, aggregating a grand
 * total. Each tenant's sweep is independently RLS-confined by the pruner.
 */
export async function sweepDanglingLinksForTenants(
  pruner: DanglingLinkPruner,
  pairs: readonly RelationPair[],
  tenantIds: readonly string[],
  opts: SweepOptions = {},
): Promise<MultiTenantSweepReport> {
  const tenants: TenantSweepReport[] = [];
  let totalPruned = 0;
  let totalKept = 0;
  for (const tenantId of tenantIds) {
    const report = await sweepDanglingLinks(pruner, pairs, tenantId, opts);
    tenants.push({ tenantId, report });
    totalPruned += report.totalPruned;
    totalKept += report.totalKept;
  }
  return { tenants, totalPruned, totalKept, dryRun: opts.dryRun === true };
}

/** Human-readable one-line-per-relation summary of a single tenant's sweep, plus a total. */
export function formatSweepReport(report: SweepReport): string {
  if (report.relations.length === 0) {
    return "no many_to_many relations to sweep\n";
  }
  const lines = report.relations.map(
    (r) => `  ${r.left} ↔ ${r.right}: pruned ${r.pruned.toString()}, kept ${r.kept.toString()}`,
  );
  lines.push(`total: pruned ${report.totalPruned.toString()}, kept ${report.totalKept.toString()}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Renders a multi-tenant sweep: a header per tenant, its per-relation lines, and
 * a grand total. A dry run is marked so the operator knows nothing was deleted.
 */
export function formatMultiTenantReport(multi: MultiTenantSweepReport): string {
  const banner = multi.dryRun ? "dry-run — nothing deleted\n\n" : "";
  if (multi.tenants.length === 0) {
    return `${banner}no tenants to sweep\n`;
  }
  const sections = multi.tenants.map((t) => `tenant ${t.tenantId}\n${formatSweepReport(t.report)}`);
  const grand = `grand total: pruned ${multi.totalPruned.toString()}, kept ${multi.totalKept.toString()}\n`;
  return `${banner}${sections.join("\n")}\n${grand}`;
}
