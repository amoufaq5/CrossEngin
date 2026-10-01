import {
  IncidentRecordSchema,
  activeAssignmentFor,
  type IncidentCategory,
  type IncidentRecord,
  type IncidentRole,
  type Severity,
  type TimelineEntry,
} from "@crossengin/incident-response";

import { SystemClock, type Clock } from "./clock.js";
import {
  transitionIncident,
  type TransitionIncidentInput,
} from "./transitions.js";

/** Timeline kinds a caller may append freely; the rest are stamped by the operation itself. */
export const NOTE_KINDS = [
  "observation",
  "action_taken",
  "comms_sent",
  "runbook_invoked",
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export class RoleNotAssignedError extends Error {
  constructor(readonly role: IncidentRole) {
    super(`no active assignment for role '${role}'`);
    this.name = "RoleNotAssignedError";
  }
}

export interface DeclareIncidentInput {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly category: IncidentCategory;
  readonly declaredBy: string;
  readonly detail: string;
  readonly declaredAt?: string;
  readonly affectedTenantIds?: readonly string[];
  readonly affectedRegions?: readonly string[];
  readonly publiclyVisible?: boolean;
  readonly securityIncident?: boolean;
  readonly breachDataClasses?: readonly string[];
  /** The automated signal this declaration is for; null for a human declaration. */
  readonly autoDeclaredFor?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface AssignRoleInput {
  readonly role: IncidentRole;
  readonly userId: string;
  readonly actorUserId: string;
  readonly at?: string;
  readonly message?: string;
}

export interface HandOffRoleInput {
  readonly role: IncidentRole;
  readonly toUserId: string;
  readonly reason: string;
  readonly actorUserId: string;
  readonly at?: string;
  readonly message?: string;
}

export interface ChangeSeverityInput {
  readonly severity: Severity;
  readonly reason: string;
  readonly actorUserId: string;
  readonly at?: string;
  readonly publiclyVisible?: boolean;
}

export interface NoteInput {
  readonly kind: NoteKind;
  readonly message: string;
  readonly actorUserId: string;
  readonly at?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AttachPostmortemInput {
  readonly postmortemId: string;
  readonly actorUserId: string;
  readonly at?: string;
}

export interface IncidentExecutorOptions {
  readonly clock?: Clock;
}

/**
 * Drives one incident's lifecycle as a pure function of its current record.
 *
 * Every operation returns a fresh `IncidentRecord` parsed by the contract schema and appends
 * exactly one timeline entry, so the timeline is a complete account of how the record reached
 * its current shape — which is what lets a persistence layer treat it as an append-only log and
 * re-derive the projection from it.
 */
export class IncidentExecutor {
  private readonly clock: Clock;

  constructor(opts: IncidentExecutorOptions = {}) {
    this.clock = opts.clock ?? new SystemClock();
  }

  declare(input: DeclareIncidentInput): IncidentRecord {
    const at = input.declaredAt ?? this.clock.nowIso();
    return IncidentRecordSchema.parse({
      id: input.id,
      title: input.title,
      severity: input.severity,
      category: input.category,
      status: "declared",
      affectedTenantIds: [...(input.affectedTenantIds ?? [])],
      affectedRegions: [...(input.affectedRegions ?? [])],
      publiclyVisible: input.publiclyVisible ?? false,
      securityIncident: input.securityIncident ?? false,
      breachDataClasses: [...(input.breachDataClasses ?? [])],
      autoDeclaredFor: input.autoDeclaredFor ?? null,
      declaredAt: at,
      declaredBy: input.declaredBy,
      timeline: [
        {
          occurredAt: at,
          actorUserId: input.declaredBy,
          kind: "declared",
          message: input.detail,
          metadata: input.metadata ?? {},
        },
      ],
    });
  }

  assignRole(record: IncidentRecord, input: AssignRoleInput): IncidentRecord {
    const at = input.at ?? this.clock.nowIso();
    return this.withEntry(
      {
        ...record,
        roleAssignments: [
          ...record.roleAssignments,
          {
            role: input.role,
            userId: input.userId,
            assignedAt: at,
            handedOffAt: null,
            handedOffToUserId: null,
          },
        ],
      },
      {
        occurredAt: at,
        actorUserId: input.actorUserId,
        kind: "role_assigned",
        message: input.message ?? `${input.role} assigned to ${input.userId}`,
        metadata: { role: input.role, userId: input.userId },
      },
    );
  }

  /**
   * Closes the active assignment for a role and opens a new one in the same step. Split across
   * two calls it would pass through a state where a required role has no holder, which the schema
   * rejects for a triaged incident — so the handoff is one transition, not two.
   */
  handOffRole(record: IncidentRecord, input: HandOffRoleInput): IncidentRecord {
    const at = input.at ?? this.clock.nowIso();
    const active = activeAssignmentFor(record.roleAssignments, input.role);
    if (active === null) throw new RoleNotAssignedError(input.role);
    const assignments = record.roleAssignments.map((a) =>
      a === active
        ? {
            ...a,
            handedOffAt: at,
            handedOffToUserId: input.toUserId,
            handedOffReason: input.reason,
          }
        : a,
    );
    return this.withEntry(
      {
        ...record,
        roleAssignments: [
          ...assignments,
          {
            role: input.role,
            userId: input.toUserId,
            assignedAt: at,
            handedOffAt: null,
            handedOffToUserId: null,
          },
        ],
      },
      {
        occurredAt: at,
        actorUserId: input.actorUserId,
        kind: "role_handed_off",
        message:
          input.message ??
          `${input.role} handed from ${active.userId} to ${input.toUserId}: ${input.reason}`,
        metadata: { role: input.role, fromUserId: active.userId, toUserId: input.toUserId },
      },
    );
  }

  /**
   * A severity change can make an already-legal record illegal: sev1 demands five active roles
   * and a status page where sev3 demands neither, so an upgrade of a triaged incident is refused
   * until those are in place. That refusal is the point — it is the same rule the transition into
   * `triaged` would have enforced.
   */
  changeSeverity(record: IncidentRecord, input: ChangeSeverityInput): IncidentRecord {
    const at = input.at ?? this.clock.nowIso();
    return this.withEntry(
      {
        ...record,
        severity: input.severity,
        publiclyVisible: input.publiclyVisible ?? record.publiclyVisible,
      },
      {
        occurredAt: at,
        actorUserId: input.actorUserId,
        kind: "severity_changed",
        message: `severity ${record.severity} -> ${input.severity}: ${input.reason}`,
        metadata: { from: record.severity, to: input.severity, reason: input.reason },
      },
    );
  }

  note(record: IncidentRecord, input: NoteInput): IncidentRecord {
    const at = input.at ?? this.clock.nowIso();
    return this.withEntry(record, {
      occurredAt: at,
      actorUserId: input.actorUserId,
      kind: input.kind,
      message: input.message,
      metadata: input.metadata ?? {},
    });
  }

  attachPostmortem(record: IncidentRecord, input: AttachPostmortemInput): IncidentRecord {
    const at = input.at ?? this.clock.nowIso();
    return this.withEntry(
      { ...record, postmortemId: input.postmortemId },
      {
        occurredAt: at,
        actorUserId: input.actorUserId,
        kind: "action_taken",
        message: `postmortem ${input.postmortemId} attached`,
        metadata: { postmortemId: input.postmortemId },
      },
    );
  }

  transition(record: IncidentRecord, input: TransitionIncidentInput): IncidentRecord {
    return transitionIncident(record, input);
  }

  private withEntry(draft: IncidentRecord, entry: TimelineEntry): IncidentRecord {
    return IncidentRecordSchema.parse({
      ...draft,
      timeline: [...draft.timeline, entry],
    });
  }
}
