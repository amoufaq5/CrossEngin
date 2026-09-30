import {
  IncidentRecordSchema,
  canTransitionIncident,
  type IncidentRecord,
  type IncidentStatus,
  type TimelineEntry,
} from "@crossengin/incident-response";

export class IllegalIncidentTransitionError extends Error {
  constructor(
    readonly from: IncidentStatus,
    readonly to: IncidentStatus,
  ) {
    super(`illegal incident transition '${from}' -> '${to}'`);
    this.name = "IllegalIncidentTransitionError";
  }
}

export class IncidentTransitionBlockedError extends Error {
  constructor(
    readonly from: IncidentStatus,
    readonly to: IncidentStatus,
    readonly blockers: readonly string[],
  ) {
    super(
      `incident transition '${from}' -> '${to}' is blocked: ${blockers.join("; ")}`,
    );
    this.name = "IncidentTransitionBlockedError";
  }
}

export interface TransitionIncidentInput {
  readonly to: IncidentStatus;
  readonly at: string;
  readonly actorUserId: string;
  readonly message?: string;
  readonly rootCause?: string;
  readonly cancelledReason?: string;
  readonly customerImpactSummary?: string;
  /** Flipped on the way out of `declared` for severities that require a status page. */
  readonly publiclyVisible?: boolean;
  readonly postmortemId?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Builds the record a transition would produce, without judging it.
 *
 * Kept separate from `transitionIncident` so `incidentTransitionBlockers` can ask the *schema*
 * whether the result is acceptable instead of re-listing the schema's own rules. There is one
 * answer to "may this incident move to that status?" and it is `IncidentRecordSchema`; a second
 * copy of the role/status-page/root-cause requirements here would drift from it.
 */
export function draftTransition(
  record: IncidentRecord,
  input: TransitionIncidentInput,
): unknown {
  const stamps = stampsFor(record, input.to, input.at);
  const entry: TimelineEntry = {
    occurredAt: input.at,
    actorUserId: input.actorUserId,
    kind: input.to === "resolved" ? "resolved" : "status_changed",
    message: input.message ?? `status ${record.status} -> ${input.to}`,
    metadata: input.metadata ?? {},
  };
  return {
    ...record,
    ...stamps,
    status: input.to,
    publiclyVisible: input.publiclyVisible ?? record.publiclyVisible,
    rootCause: input.rootCause ?? record.rootCause,
    cancelledReason: input.cancelledReason ?? record.cancelledReason,
    customerImpactSummary: input.customerImpactSummary ?? record.customerImpactSummary,
    postmortemId: input.postmortemId ?? record.postmortemId,
    timeline: [...record.timeline, entry],
  };
}

interface Stamps {
  readonly ackedAt?: string | null;
  readonly mitigatedAt?: string | null;
  readonly resolvedAt?: string | null;
  readonly closedAt?: string | null;
  readonly cancelledAt?: string | null;
}

/**
 * The timestamps a target status implies, including the ones it implies *transitively*.
 *
 * The schema requires `mitigatedAt` before `resolvedAt` and `ackedAt` before `mitigatedAt`, but
 * `INCIDENT_TRANSITIONS` permits `mitigating -> resolved`, which skips the `mitigated` state
 * where `mitigatedAt` would normally be stamped. So a resolve has to back-fill every earlier
 * stamp it does not already have, or it produces a record the schema rejects for a reason that
 * has nothing to do with the caller's intent.
 */
function stampsFor(record: IncidentRecord, to: IncidentStatus, at: string): Stamps {
  switch (to) {
    case "triaged":
      return { ackedAt: record.ackedAt ?? at };
    case "mitigating":
      // Re-entering mitigation means the incident is demonstrably not mitigated any more, so the
      // stamp is cleared — otherwise `metMitigateSla` reports a target met for an incident still
      // being worked. Left alone once resolved, where clearing it would break the schema's
      // resolvedAt-implies-mitigatedAt ordering.
      return {
        ackedAt: record.ackedAt ?? at,
        ...(record.status === "mitigated" && record.resolvedAt === null
          ? { mitigatedAt: null }
          : {}),
      };
    case "mitigated":
      return { ackedAt: record.ackedAt ?? at, mitigatedAt: record.mitigatedAt ?? at };
    case "resolved":
      return {
        ackedAt: record.ackedAt ?? at,
        mitigatedAt: record.mitigatedAt ?? at,
        resolvedAt: record.resolvedAt ?? at,
      };
    case "postmortem_pending":
      return {};
    case "closed":
      return { closedAt: record.closedAt ?? at };
    case "cancelled":
      return { cancelledAt: record.cancelledAt ?? at };
    default:
      return {};
  }
}

/**
 * Why this transition would be refused, or an empty list if it would be accepted. The answers
 * come from `IncidentRecordSchema` itself, so a caller can see what is missing (unassigned
 * roles, an un-flipped status page, an absent root cause) before attempting the move.
 */
export function incidentTransitionBlockers(
  record: IncidentRecord,
  input: TransitionIncidentInput,
): readonly string[] {
  if (!canTransitionIncident(record.status, input.to)) {
    return [`illegal transition '${record.status}' -> '${input.to}'`];
  }
  const parsed = IncidentRecordSchema.safeParse(draftTransition(record, input));
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  });
}

export function transitionIncident(
  record: IncidentRecord,
  input: TransitionIncidentInput,
): IncidentRecord {
  if (!canTransitionIncident(record.status, input.to)) {
    throw new IllegalIncidentTransitionError(record.status, input.to);
  }
  const draft = draftTransition(record, input);
  const parsed = IncidentRecordSchema.safeParse(draft);
  if (!parsed.success) {
    throw new IncidentTransitionBlockedError(
      record.status,
      input.to,
      incidentTransitionBlockers(record, input),
    );
  }
  return parsed.data;
}

const OPEN_STATUSES: ReadonlyArray<IncidentStatus> = Object.freeze([
  "declared",
  "triaged",
  "mitigating",
  "mitigated",
  "resolved",
  "postmortem_pending",
]);

export function isIncidentOpen(record: IncidentRecord): boolean {
  return OPEN_STATUSES.includes(record.status);
}

export interface AutoCancelInput {
  readonly at: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly message?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Closes out an auto-declared incident whose triggering signal recovered before anyone picked
 * it up, and returns `null` when it must be left alone.
 *
 * `cancelled` is the only status reachable from `declared` without a human: advancing to
 * `triaged` requires the on-call roles to be assigned (five of them at sev1), which no automated
 * declarer can do. That is not a limitation to route around — an incident nobody has taken is
 * not an incident that was mitigated, and recording it as resolved would claim a response that
 * never happened. Once the status has moved past `declared` a human owns the record, so an
 * automatic recovery must not touch it.
 */
export function cancelIfUntriaged(
  record: IncidentRecord,
  input: AutoCancelInput,
): IncidentRecord | null {
  if (record.status !== "declared") return null;
  return transitionIncident(record, {
    to: "cancelled",
    at: input.at,
    actorUserId: input.actorUserId,
    cancelledReason: input.reason,
    message: input.message ?? input.reason,
    metadata: { ...(input.metadata ?? {}), autoCancelled: true },
  });
}
