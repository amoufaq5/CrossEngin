/**
 * Pure link-integrity planner. Given an *already-fetched* set of association
 * links plus the sets of ids known to still exist on each side, it partitions
 * the links into those to keep and those that dangle (one endpoint gone). It
 * neither reads nor writes the database — fetching the links, resolving the
 * existing-id sets, and executing any pruning are all caller concerns; this
 * module only decides.
 */

export interface LinkPair {
  readonly leftId: string;
  readonly rightId: string;
}

export interface LinkPruneInput {
  readonly links: ReadonlyArray<LinkPair>;
  readonly existingLeftIds: ReadonlySet<string>;
  readonly existingRightIds: ReadonlySet<string>;
}

export interface LinkPrunePlan {
  readonly keep: ReadonlyArray<LinkPair>;
  readonly drop: ReadonlyArray<LinkPair>;
}

/**
 * Partitions `links` into `keep` / `drop`. A link dangles (is dropped) when its
 * `leftId` is absent from `existingLeftIds` or its `rightId` is absent from
 * `existingRightIds`; otherwise it is kept. Input order is preserved in both
 * arrays.
 */
export function planLinkPrune(input: LinkPruneInput): LinkPrunePlan {
  const keep: LinkPair[] = [];
  const drop: LinkPair[] = [];
  for (const link of input.links) {
    const dangling = !input.existingLeftIds.has(link.leftId) || !input.existingRightIds.has(link.rightId);
    (dangling ? drop : keep).push(link);
  }
  return { keep, drop };
}

/** Convenience: the number of dangling links `planLinkPrune` would drop. */
export function danglingLinkCount(input: LinkPruneInput): number {
  return planLinkPrune(input).drop.length;
}
