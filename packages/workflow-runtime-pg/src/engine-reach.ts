import type { JobQueueVisibility } from "./job-claim.js";

/**
 * What a mounted workflow engine can be asked to do in this deployment, said at boot.
 *
 * The engine executes instances; nothing in the deployed binary creates one. No route publishes a
 * definition, starts an instance or submits a signal — the two surfaces that mount the engine are
 * the cancellation route and the worker fleet, and both act only on instances that already exist —
 * so on a deployment that has not written instances by another route, the cancellation route answers
 * an unknown instance for every id and the workers find nothing due. That is deliberate rather than
 * an omission (see `WORKFLOW_ENGINE_UNREACHABLE_REASONS`), and an absence that is deliberate still
 * has to be said, or a mounted engine reads as a working one.
 */
export const WORKFLOW_ENGINE_UNREACHABLE_REASONS = [
  // A definition is loaded once at boot into the engine's map, so a definition published over a
  // route would not reach the engine until a restart: the route would report success and change
  // nothing a request can observe.
  "definitions_load_at_boot",
  // The engine's reads — the event log, the projections it re-reads after each append — issue no
  // tenant context, and the five workflow tables carry only a tenant-isolation policy, so as the
  // confined serving role every instance read answers "not found" (register: "Four stores in
  // `workflow-runtime-pg` set no tenant context"). A start route would write the instance and then
  // fail its own read-back.
  "engine_reads_are_unscoped",
] as const;
export type WorkflowEngineUnreachableReason = (typeof WORKFLOW_ENGINE_UNREACHABLE_REASONS)[number];

/** A total map, so a fifth visibility is a compile error here rather than a silent boot line. */
const EVENTS_VISIBILITY_WARNING: Readonly<Record<JobQueueVisibility, string | null>> = {
  visible: null,
  confined_by_rls:
    "row-level security confines this connection on meta.workflow_events and the engine's reads " +
    "set no tenant context, so every instance read answers not found: cancellation reports an " +
    "unknown instance and a worker cannot advance one",
  unguarded: "meta.workflow_events carries no row-level security for this connection",
  absent: "meta.workflow_events does not exist for this connection",
};

export interface WorkflowEngineReachInput {
  readonly cancellationRoute: boolean;
  readonly workers: boolean;
  /** `meta.workflow_events` as this connection sees it; `null` when it was not asked. */
  readonly eventsVisibility: JobQueueVisibility | null;
}

export interface WorkflowEngineReachLine {
  readonly level: "info" | "warn";
  readonly line: string;
}

export function formatWorkflowEngineReach(input: WorkflowEngineReachInput): readonly WorkflowEngineReachLine[] {
  const mountedFor = [
    ...(input.cancellationRoute ? ["the cancellation route"] : []),
    ...(input.workers ? ["the worker fleet"] : []),
  ];
  const lines: WorkflowEngineReachLine[] = [
    {
      level: "info",
      line:
        `[workflow] engine mounted for ${mountedFor.length > 0 ? mountedFor.join(" and ") : "nothing"}; ` +
        "no route publishes a definition, starts an instance or submits a signal, so it acts only on " +
        "instances another process wrote",
    },
  ];
  const warning = input.eventsVisibility === null ? null : EVENTS_VISIBILITY_WARNING[input.eventsVisibility];
  if (warning !== null) lines.push({ level: "warn", line: `[workflow] ${warning}` });
  return lines;
}
