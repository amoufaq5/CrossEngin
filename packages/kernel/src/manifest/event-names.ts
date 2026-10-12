import type { Manifest } from "./types.js";

/** A dotted event-name segment: lowercased, non-alphanumerics → `_`, leading digit prefixed. */
export function eventNameSegment(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(s) ? s : `x_${s}`;
}

/**
 * The verb an entity write of each operation is named by. Keyed on the three operations that have a
 * fixed verb and deliberately **not** on the write path's full operation union: a `transition` is
 * named by its lifecycle target state, which is a manifest value and not a constant, so a map
 * covering it would have to invent an entry it must never be asked for.
 */
export const ENTITY_EVENT_VERBS: Readonly<Record<"create" | "update" | "delete", string>> =
  Object.freeze({ create: "created", update: "updated", delete: "deleted" });

export interface EntityEventNameInput {
  /** Raw namespace prefix (`Retail Ops` → `retail_ops.salesorder.placed`), segmented here. */
  readonly prefix?: string;
  /** Raw entity name, segmented here. */
  readonly entity: string;
  /**
   * Already a segment, and passing one already segmented is the contract rather than a saving:
   * `eventNameSegment` is idempotent on every output it produces **except** `x_` — the answer for
   * text with no alphanumerics at all, whose trailing `_` a second pass strips to `x` — so a
   * function that re-segmented defensively would rename that one verb. The two sources differ in
   * kind as well: an `ENTITY_EVENT_VERBS` value is a segment by construction, while a transition
   * target is arbitrary manifest text its caller has passed through `eventNameSegment`.
   */
  readonly verb: string;
}

/**
 * The one spelling of an entity event's dotted name — `<prefix?>.<entity>.<verb>`. An empty
 * segment is dropped rather than joined, so a caller holding an empty verb yields
 * `<prefix?>.<entity>` instead of a name with a dangling dot.
 */
export function entityEventName(input: EntityEventNameInput): string {
  const prefix = input.prefix !== undefined ? eventNameSegment(input.prefix) : undefined;
  return [prefix, eventNameSegment(input.entity), input.verb]
    .filter((p) => p !== undefined && p.length > 0)
    .join(".");
}

export interface ProducibleEntityEventNamesOptions {
  readonly eventPrefix?: string;
}

/**
 * Every event name a deployment serving this manifest can emit from an entity write: three per
 * entity (one per `ENTITY_EVENT_VERBS` value) plus one per declared lifecycle **transition
 * target**.
 *
 * Transition *targets* and never `workflow.states`, which is the whole content of this function. A
 * transition event's verb is its target state, so a state nothing transitions *to* can never appear
 * in a name — an initial state is reached by a create, which emits `created`. Measured on resolved
 * `erp-core`: 95 distinct `(entity, state)` names against 77 distinct `(entity, target)` ones, so
 * reading the states answers 248 where 230 are producible. Over-reporting is the permissive
 * direction for every consumer of this answer, which is why the states are the mistake worth naming.
 */
export function producibleEntityEventNames(
  manifest: Manifest,
  options?: ProducibleEntityEventNamesOptions,
): ReadonlySet<string> {
  const prefix = options?.eventPrefix;
  const names = new Set<string>();
  for (const entity of manifest.entities ?? []) {
    for (const verb of Object.values(ENTITY_EVENT_VERBS)) {
      names.add(entityEventName({ prefix, entity: entity.name, verb }));
    }
  }
  for (const workflow of Object.values(manifest.workflows ?? {})) {
    if (workflow.kind !== "entityLifecycle") continue;
    for (const transition of workflow.transitions) {
      names.add(
        entityEventName({ prefix, entity: workflow.entity, verb: eventNameSegment(transition.to) }),
      );
    }
  }
  return names;
}
