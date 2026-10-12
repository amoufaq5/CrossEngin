import { z } from "zod";
import { SeveritySchema, profileFor } from "./severities.js";
import {
  RoleAssignmentSetSchema,
  REQUIRED_ROLES,
  SEV1_REQUIRED_ROLES,
  rolesMissingRequired,
} from "./roles.js";

const Iso8601 = z.string().datetime({ offset: true });

/**
 * Incident ids are `INC-YYYY-NNNN`. The pattern, the formatter and the parser live together
 * here because a store that persists `year` and `sequence_number` as real columns must derive
 * them from the id by exactly the rule that produced it — two spellings of this would let a
 * row's columns disagree with its own id.
 */
export const INCIDENT_ID_REGEX = /^INC-\d{4}-\d{4,8}$/;

export function formatIncidentId(year: number, seq: number): string {
  if (!Number.isInteger(year) || year < 1970) throw new Error("invalid year");
  if (!Number.isInteger(seq) || seq < 0) throw new Error("invalid sequence");
  return `INC-${year}-${String(seq).padStart(4, "0")}`;
}

export interface ParsedIncidentId {
  readonly year: number;
  readonly sequence: number;
}

/**
 * Composes an `autoDeclaredFor` key.
 *
 * Namespaced by signal, because two signals can watch one subject: an availability SLO and a
 * latency SLO on the same surface are different breaches and must be able to be open at once. An
 * unnamespaced key would let one adopt the other's incident.
 */
export function autoDeclaredForKey(signal: string, subject: string): string {
  if (signal.length === 0 || subject.length === 0) {
    throw new Error("autoDeclaredForKey needs a non-empty signal and subject");
  }
  if (signal.includes(":")) {
    throw new Error(`autoDeclaredFor signal must not contain ':': ${signal}`);
  }
  return `${signal}:${subject}`;
}

export function parseIncidentId(id: string): ParsedIncidentId {
  if (!INCIDENT_ID_REGEX.test(id)) {
    throw new Error(`invalid incident id '${id}' (expected 'INC-YYYY-NNNN')`);
  }
  const parts = id.split("-");
  return {
    year: Number.parseInt(parts[1] as string, 10),
    sequence: Number.parseInt(parts[2] as string, 10),
  };
}

export const INCIDENT_STATUSES = [
  "declared",
  "triaged",
  "mitigating",
  "mitigated",
  "resolved",
  "postmortem_pending",
  "closed",
  "cancelled",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const IncidentStatusSchema = z.enum(INCIDENT_STATUSES);

export const INCIDENT_TRANSITIONS: Readonly<
  Record<IncidentStatus, readonly IncidentStatus[]>
> = Object.freeze({
  declared: ["triaged", "cancelled"],
  triaged: ["mitigating", "cancelled"],
  mitigating: ["mitigated", "resolved", "cancelled"],
  mitigated: ["resolved", "mitigating"],
  resolved: ["postmortem_pending", "closed"],
  postmortem_pending: ["closed"],
  closed: [],
  cancelled: [],
});

export function canTransitionIncident(
  from: IncidentStatus,
  to: IncidentStatus,
): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export const INCIDENT_CATEGORIES = [
  "availability",
  "performance",
  "data_integrity",
  "security",
  "compliance",
  "billing",
  "dependency_failure",
  "human_error",
  "scheduled_change_impact",
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];
export const IncidentCategorySchema = z.enum(INCIDENT_CATEGORIES);

export const TimelineEntrySchema = z
  .object({
    occurredAt: Iso8601,
    actorUserId: z.string().min(1),
    kind: z.enum([
      "declared",
      "severity_changed",
      "status_changed",
      "role_assigned",
      "role_handed_off",
      "observation",
      "action_taken",
      "comms_sent",
      "runbook_invoked",
      /**
       * Somebody was paged, or a page was closed. Beside `comms_sent` and `runbook_invoked`
       * because it is the same kind of fact: something left the platform. Adding a member only
       * widens what parses, so no stored row becomes unreadable — which matters here because the
       * `-pg` store re-parses every row it reads.
       */
      "paged",
      "resolved",
    ]),
    message: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

/**
 * A channel kind is an identifier — `pagerduty_phone`, `slack`, `sms`. The pattern is the
 * structural reason an address, a phone number, a `#channel` or a routing key cannot reach a
 * stored timeline note: none of them is a lower snake_case identifier.
 */
const CHANNEL_KIND_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_CHANNEL_KIND_LENGTH = 40;
const MAX_PAGE_REFERENCE_LENGTH = 200;

/**
 * What a `paged` timeline entry is allowed to know.
 *
 * Deliberately only channel **kinds**, counts and a provider-issued handle. ADR-0310 and ADR-0325
 * keep tenant data, tombstone ids and defect names out of a page's *content*; the rule here is
 * narrower — a timeline note is stored next to the incident, not shipped to a lock screen — but it
 * is the same rule: the note says who was reached over what, never where they were reached or with
 * which credential. There is no field for an address, a number, a channel name or a key, which is
 * what makes "it must not carry one" true by construction rather than by review.
 */
export interface PagedTimelineFacts {
  /** The channel kinds this page or close was attempted over, in the order the caller fanned out. */
  readonly channels: readonly string[];
  readonly delivered: number;
  readonly attempted: number;
  /** The provider's own handle for the alert — e.g. a PagerDuty dedup key. Never a routing key. */
  readonly reference?: string | null;
  readonly operation?: "trigger" | "resolve";
}

function validatePagedFacts(facts: PagedTimelineFacts): void {
  const { delivered, attempted } = facts;
  if (
    !Number.isInteger(delivered) ||
    !Number.isInteger(attempted) ||
    delivered < 0 ||
    attempted < 0 ||
    delivered > attempted
  ) {
    // A programming error, not user input: the dispatcher counted its own fan-out, so a
    // delivered count above the attempted one means the caller is reporting something else.
    throw new RangeError(
      `paged counts must be non-negative integers with delivered <= attempted ` +
        `(delivered=${String(delivered)}, attempted=${String(attempted)})`,
    );
  }
  facts.channels.forEach((channel, i) => {
    if (
      typeof channel !== "string" ||
      channel.length > MAX_CHANNEL_KIND_LENGTH ||
      !CHANNEL_KIND_PATTERN.test(channel)
    ) {
      // Names the position and not the value: a rejected "channel kind" is exactly the kind of
      // thing that might be an address or a key, and an error message ends up in a log.
      throw new TypeError(`channels[${i}] is not a channel kind`);
    }
  });
  const reference = facts.reference;
  if (reference !== undefined && reference !== null) {
    if (reference.trim().length === 0 || reference.length > MAX_PAGE_REFERENCE_LENGTH) {
      throw new TypeError("page reference must be a non-empty handle under 200 characters");
    }
  }
}

/**
 * The metadata a `paged` entry carries, built once here so the three escalators cannot each
 * invent a shape an incident review then has to learn three times.
 */
export function pagedTimelineMetadata(facts: PagedTimelineFacts): Record<string, unknown> {
  validatePagedFacts(facts);
  const reference = facts.reference;
  return {
    operation: facts.operation ?? "trigger",
    channels: [...facts.channels],
    delivered: facts.delivered,
    attempted: facts.attempted,
    ...(reference === undefined || reference === null ? {} : { reference }),
  };
}

/** The one line an incident review scans for. */
export function pagedTimelineMessage(facts: PagedTimelineFacts): string {
  validatePagedFacts(facts);
  const resolving = (facts.operation ?? "trigger") === "resolve";
  if (facts.channels.length === 0) {
    return resolving
      ? "closed no alert — no page channel was attempted"
      : "PAGED NOBODY — no page channel was attempted";
  }
  const list = facts.channels.join(", ");
  if (resolving) {
    // A close that reached nobody is not an alarm — a Slack message cannot be unposted, so
    // `unsupported` is the expected answer on most channels (ADR-0326).
    return facts.delivered === 0
      ? `closed no alert — 0/${facts.attempted} over ${list}`
      : `resolved the alert on ${list}`;
  }
  // Shouted, because this is the line that says the escalation did not happen. A quiet
  // "paged 0/2" reads like every other entry when a reviewer scans the timeline.
  return facts.delivered === 0
    ? `PAGED NOBODY — 0/${facts.attempted} over ${list}`
    : `paged ${facts.delivered}/${facts.attempted} over ${list}`;
}

export const IncidentRecordSchema = z
  .object({
    id: z.string().regex(INCIDENT_ID_REGEX, {
      message: "incident id must match 'INC-YYYY-NNNN' (e.g. 'INC-2026-0042')",
    }),
    title: z.string().min(1).max(200),
    severity: SeveritySchema,
    category: IncidentCategorySchema,
    status: IncidentStatusSchema,
    affectedTenantIds: z.array(z.string().min(1)).default([]),
    affectedRegions: z.array(z.string().min(1)).default([]),
    publiclyVisible: z.boolean().default(false),
    declaredAt: Iso8601,
    declaredBy: z.string().min(1),
    ackedAt: Iso8601.nullable().default(null),
    mitigatedAt: Iso8601.nullable().default(null),
    resolvedAt: Iso8601.nullable().default(null),
    closedAt: Iso8601.nullable().default(null),
    cancelledAt: Iso8601.nullable().default(null),
    cancelledReason: z.string().min(1).optional(),
    rootCause: z.string().min(1).optional(),
    customerImpactSummary: z.string().min(1).optional(),
    roleAssignments: RoleAssignmentSetSchema.default([]),
    timeline: z.array(TimelineEntrySchema).min(1),
    runbookExecutionIds: z.array(z.string().min(1)).default([]),
    relatedDeploymentIds: z.array(z.string().min(1)).default([]),
    securityIncident: z.boolean().default(false),
    breachDataClasses: z
      .array(z.enum(["pii", "phi", "regulated", "commercial_sensitive"]))
      .default([]),
    postmortemId: z.string().min(1).nullable().default(null),
    /**
     * The automated signal this incident was declared for, and the idempotency key for declaring
     * it. An SLO burn loop or an integrity proof holds its open incidents in memory, so a restart
     * would re-declare a still-present breach under a new id — one episode, two incidents. With
     * this on the record, a declarer can ask the store "which open incident did this signal open?"
     * before declaring a second (ADR-0294).
     *
     * On the record rather than beside it, because the row *is* the record: a column outside the
     * schema would break the property the replayer depends on. Null for anything a human declared.
     */
    autoDeclaredFor: z.string().min(1).max(200).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    const declaredMs = new Date(v.declaredAt).getTime();
    const timeFields: ReadonlyArray<readonly [string, string | null]> = [
      ["ackedAt", v.ackedAt],
      ["mitigatedAt", v.mitigatedAt],
      ["resolvedAt", v.resolvedAt],
      ["closedAt", v.closedAt],
    ];
    for (const [name, value] of timeFields) {
      if (value !== null && new Date(value).getTime() < declaredMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} cannot be before declaredAt`,
        });
      }
    }
    if (v.mitigatedAt !== null && v.ackedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ackedAt"],
        message: "mitigatedAt requires ackedAt to be set first",
      });
    }
    if (v.resolvedAt !== null && v.mitigatedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mitigatedAt"],
        message: "resolvedAt requires mitigatedAt to be set first",
      });
    }
    if (
      (v.status === "resolved" ||
        v.status === "postmortem_pending" ||
        v.status === "closed") &&
      v.resolvedAt === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedAt"],
        message: `status '${v.status}' requires resolvedAt`,
      });
    }
    if (v.status === "closed") {
      if (v.closedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["closedAt"],
          message: "closed status requires closedAt",
        });
      }
      if (v.rootCause === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rootCause"],
          message: "closed incidents must declare rootCause",
        });
      }
    }
    if (v.status === "cancelled") {
      if (v.cancelledAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cancelledAt"],
          message: "cancelled status requires cancelledAt",
        });
      }
      if (v.cancelledReason === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cancelledReason"],
          message: "cancelled status requires cancelledReason",
        });
      }
    }
    const required = v.severity === "sev1" ? SEV1_REQUIRED_ROLES : REQUIRED_ROLES;
    const missing = rolesMissingRequired(v.roleAssignments, required);
    if (
      (v.status === "triaged" ||
        v.status === "mitigating" ||
        v.status === "mitigated") &&
      missing.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roleAssignments"],
        message: `status '${v.status}' requires roles: ${missing.join(", ")}`,
      });
    }
    if (v.securityIncident && v.category !== "security") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["category"],
        message: "securityIncident=true requires category='security'",
      });
    }
    if (v.breachDataClasses.length > 0 && !v.securityIncident) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["securityIncident"],
        message: "breachDataClasses requires securityIncident=true",
      });
    }
    const tenantSet = new Set<string>();
    v.affectedTenantIds.forEach((t, i) => {
      if (tenantSet.has(t)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["affectedTenantIds", i],
          message: `duplicate tenant '${t}'`,
        });
      }
      tenantSet.add(t);
    });
    const profile = profileFor(v.severity);
    if (profile.requiresStatusPage && !v.publiclyVisible && v.status !== "declared" && v.status !== "cancelled") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publiclyVisible"],
        message: `severity '${v.severity}' requires publiclyVisible=true once triaged`,
      });
    }
    if (profile.postmortemRequired && v.status === "closed" && v.postmortemId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postmortemId"],
        message: `severity '${v.severity}' requires a postmortemId before closing`,
      });
    }
  });
export type IncidentRecord = z.infer<typeof IncidentRecordSchema>;

export function timeToAckMinutes(record: IncidentRecord): number | null {
  if (record.ackedAt === null) return null;
  const declared = new Date(record.declaredAt).getTime();
  const acked = new Date(record.ackedAt).getTime();
  return Math.round((acked - declared) / 60_000);
}

export function timeToMitigateMinutes(record: IncidentRecord): number | null {
  if (record.mitigatedAt === null) return null;
  const declared = new Date(record.declaredAt).getTime();
  const mitigated = new Date(record.mitigatedAt).getTime();
  return Math.round((mitigated - declared) / 60_000);
}

export function timeToResolveMinutes(record: IncidentRecord): number | null {
  if (record.resolvedAt === null) return null;
  const declared = new Date(record.declaredAt).getTime();
  const resolved = new Date(record.resolvedAt).getTime();
  return Math.round((resolved - declared) / 60_000);
}

export function metAckSla(record: IncidentRecord): boolean | null {
  const ttm = timeToAckMinutes(record);
  if (ttm === null) return null;
  return ttm <= profileFor(record.severity).ackMinutes;
}

export function metMitigateSla(record: IncidentRecord): boolean | null {
  const ttm = timeToMitigateMinutes(record);
  if (ttm === null) return null;
  return ttm <= profileFor(record.severity).mitigateMinutes;
}

export function impactedTenantCount(record: IncidentRecord): number {
  return record.affectedTenantIds.length;
}
