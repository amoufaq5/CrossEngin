import {
  gCounterMerge,
  lwwMapMerge,
  lwwRegisterMerge,
  mvRegisterMerge,
  orSetMerge,
  pnCounterMerge,
  CrdtSchema,
  VectorClockSchema,
  compareVectorClocks,
  mergeVectorClocks,
  type CausalRelation,
  type Crdt,
  type GCounter,
  type LwwMap,
  type LwwRegister,
  type MvRegister,
  type OrSet,
  type PNCounter,
} from "@crossengin/active-active";
import { RegionSchema } from "@crossengin/residency";
import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });

/**
 * A replicated record value: a CRDT payload (the conflict-free state) carried with
 * the vector clock that stamps its causal history, plus the region that last wrote
 * it. The CRDT guarantees the *value* converges; the clock lets the runtime classify
 * whether a remote update is causally newer, older, or concurrent.
 */
export const ReplicatedValueSchema = z.object({
  key: z.string().min(1),
  crdt: CrdtSchema,
  clock: VectorClockSchema,
  lastWriter: RegionSchema,
  updatedAt: Iso8601,
});
export type ReplicatedValue = z.infer<typeof ReplicatedValueSchema>;

/** Thrown when two CRDTs for the same key disagree on kind — a key can't change CRDT type. */
export class CrdtKindMismatchError extends Error {
  constructor(
    readonly expected: Crdt["kind"],
    readonly received: Crdt["kind"],
  ) {
    super(`CRDT kind mismatch: expected ${expected}, received ${received}`);
    this.name = "CrdtKindMismatchError";
  }
}

/**
 * Merges two same-kind CRDTs by dispatching to the contract's per-kind merge (each
 * is commutative, associative, and idempotent, so merge order never matters).
 * Throws `CrdtKindMismatchError` if the kinds differ.
 */
export function mergeCrdt(a: Crdt, b: Crdt): Crdt {
  if (a.kind !== b.kind) throw new CrdtKindMismatchError(a.kind, b.kind);
  switch (a.kind) {
    case "g_counter":
      return gCounterMerge(a, b as GCounter);
    case "pn_counter":
      return pnCounterMerge(a, b as PNCounter);
    case "or_set":
      return orSetMerge(a, b as OrSet);
    case "lww_register":
      return lwwRegisterMerge(a, b as LwwRegister);
    case "lww_map":
      return lwwMapMerge(a, b as LwwMap);
    case "mv_register":
      return mvRegisterMerge(a, b as MvRegister);
  }
}

/** The outcome of merging an incoming replicated value into an existing one. */
export interface ReplicatedMerge {
  readonly value: ReplicatedValue;
  /** The incoming clock's relation to the existing clock (before merge). */
  readonly relation: CausalRelation;
}

/**
 * Merges an `incoming` replicated value into the `existing` one for the same key:
 * the CRDT payloads merge conflict-free, the vector clocks merge to their
 * least-upper-bound, and the `relation` reports whether the incoming write was
 * causally `after` / `before` / `equal` to, or `concurrent` with, the existing one.
 * `lastWriter` / `updatedAt` follow the wall-clock-newer side (a tiebreak only — the
 * CRDT value is independent of it).
 */
export function mergeReplicatedValues(existing: ReplicatedValue, incoming: ReplicatedValue): ReplicatedMerge {
  const relation = compareVectorClocks(incoming.clock, existing.clock);
  const crdt = mergeCrdt(existing.crdt, incoming.crdt);
  const clock = mergeVectorClocks(existing.clock, incoming.clock);
  const incomingNewer = incoming.updatedAt >= existing.updatedAt;
  return {
    relation,
    value: {
      key: existing.key,
      crdt,
      clock,
      lastWriter: incomingNewer ? incoming.lastWriter : existing.lastWriter,
      updatedAt: incomingNewer ? incoming.updatedAt : existing.updatedAt,
    },
  };
}
