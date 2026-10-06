import { describe, expect, it } from "vitest";
import {
  INCIDENT_STATUSES,
  IncidentRecordSchema,
  SEVERITIES,
  requiresPostmortem,
  type IncidentStatus,
  type Severity,
} from "@crossengin/incident-response";
import { cancelIfUntriaged } from "@crossengin/incident-response-runtime";

import { T0, declaredIncident } from "./test-fakes.js";

/**
 * What a store in this package is a prerequisite *of*, asserted from the contracts rather than
 * remembered in prose.
 *
 * `PostgresPostmortemStore` and `PostgresCustomerCommsStore` and `PostgresRunbookExecutionStore`
 * are constructed nowhere outside their own tests, and the decision to leave them that way rests
 * on two couplings that are easy to lose. Both are properties of `@crossengin/incident-response`,
 * so an increment that adds an incident-close route and no postmortem writer — or that reads
 * `human_owned` as a state a deployment can reach — fails here, naming the reason, instead of
 * failing at the first sev1 a human tries to close.
 */

const AFTER = "2026-09-30T12:00:00.000Z";

/** A `closed` record for one severity, with every timestamp and field that status demands. */
function closedIncident(severity: Severity, postmortemId: string | null) {
  return {
    ...declaredIncident({}, severity),
    status: "closed" satisfies IncidentStatus,
    ackedAt: AFTER,
    mitigatedAt: AFTER,
    resolvedAt: AFTER,
    closedAt: AFTER,
    rootCause: "a bounded buffer was not bounded",
    // sev1 and sev2 additionally refuse any status past `declared` without this.
    publiclyVisible: true,
    postmortemId,
  };
}

describe("closing an incident is gated on a Postmortem record", () => {
  const needsOne = SEVERITIES.filter((s) => requiresPostmortem(s));
  const needsNone = SEVERITIES.filter((s) => !requiresPostmortem(s));

  it("has severities on both sides of the rule, so neither case below is vacuous", () => {
    expect(needsOne.length).toBeGreaterThan(0);
    expect(needsNone.length).toBeGreaterThan(0);
  });

  it.each(needsOne)("%s cannot reach closed with no postmortemId", (severity) => {
    const parsed = IncidentRecordSchema.safeParse(closedIncident(severity, null));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes("postmortemId"))).toBe(true);
    }
  });

  it.each(needsOne)("%s closes once a postmortem id is attached", (severity) => {
    expect(IncidentRecordSchema.safeParse(closedIncident(severity, "PM-2026-0001")).success).toBe(
      true,
    );
  });

  it.each(needsNone)("%s closes with no postmortem at all", (severity) => {
    expect(IncidentRecordSchema.safeParse(closedIncident(severity, null)).success).toBe(true);
  });

  it("covers the grades the escalators declare at", () => {
    // The deletion-evidence and integrity escalators page at sev1; a stalled tombstone sweep at
    // sev2 (ADR-0324, ADR-0330). Both are on the postmortem-required side, so every incident this
    // deployment can declare is one that cannot be closed until `PostgresPostmortemStore` has a
    // caller.
    expect(requiresPostmortem("sev1")).toBe(true);
    expect(requiresPostmortem("sev2")).toBe(true);
  });
});

describe("cancelIfUntriaged is the only automatic exit", () => {
  it("acts on `declared` and no other status", () => {
    const acted = INCIDENT_STATUSES.filter((status) => {
      const record = IncidentRecordSchema.parse({
        ...declaredIncident(),
        status: "declared",
      });
      // Only `declared` is attempted as itself; every other status is asked of the same record
      // with its status swapped, which is what the guard reads.
      const probe = { ...record, status };
      return cancelIfUntriaged(probe, { at: AFTER, actorUserId: "operate-server", reason: "r" }) !== null;
    });
    expect(acted).toEqual(["declared"]);
  });

  it("means `human_owned` requires a human transition, which no route in this repo performs", () => {
    // `PostgresIncidentDeclarer.closeOut` answers `human_owned` exactly when `cancelIfUntriaged`
    // declines, i.e. when the status has moved past `declared`. Advancing to `triaged` requires the
    // on-call roles assigned, and `operate-server` mounts no route that assigns one — so the
    // `human_owned` arm of `closeOutClosesAlert`, which deliberately leaves a page up for a person
    // (ADR-0326), is unreachable in every deployment today. Asserted as the premise rather than the
    // conclusion: if a triage route lands, this is the line that should change with it.
    const declared = declaredIncident();
    expect(declared.status).toBe("declared");
    expect(declared.roleAssignments).toEqual([]);
    expect(cancelIfUntriaged(declared, { at: T0, actorUserId: "x", reason: "r" })).not.toBeNull();
  });
});
