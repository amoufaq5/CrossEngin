import { describe, expect, it } from "vitest";
import {
  INCIDENT_STATUSES,
  IncidentRecordSchema,
  SEV1_REQUIRED_ROLES,
  SEVERITIES,
  profileFor,
  requiresPostmortem,
  type IncidentRecord,
  type IncidentStatus,
  type Severity,
} from "@crossengin/incident-response";
import {
  FixedClock,
  IncidentExecutor,
  IncidentTransitionBlockedError,
  cancelIfUntriaged,
} from "@crossengin/incident-response-runtime";

import { T0, declaredIncident } from "./test-fakes.js";

/**
 * What a store in this package is a prerequisite *of*, asserted from the contracts rather than
 * remembered in prose.
 *
 * `PostgresPostmortemStore` and `PostgresCustomerCommsStore` and `PostgresRunbookExecutionStore`
 * are constructed nowhere outside their own tests, and the decision to leave them that way rests
 * on couplings that are easy to lose. They are properties of `@crossengin/incident-response` and
 * its executor, so they are asserted by **driving the real executor** rather than by asserting the
 * shape of a fixture this file wrote.
 *
 * Which grades the deployed escalators actually declare at is not answerable here: the escalator
 * schemas live in `apps/operate-server`, which this package cannot import without inverting the
 * dependency edge. That assertion lives in `incident-lifecycle-survey.test.ts`, beside the boot line
 * that reports it.
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
});

/**
 * Every grade closes through the pure executor — the bar to closing an incident in a deployment is
 * that nothing **calls** `transition`, not that the contract refuses it. What follows is exactly the
 * set of inputs the executor needs, so an increment that mounts a lifecycle route knows what its
 * request body must carry, and an increment that relaxes a refinement knows it was not a blocker.
 *
 * Two of those inputs are **claims the caller types in**: `publiclyVisible` asserts a status page
 * nothing in this repository serves, and `postmortemId` is free text naming no stored postmortem
 * (`meta.incidents.postmortem_id` is unconstrained TEXT). So "the executor accepts it" is not "a
 * route may accept it": ADR-0336 declared these stores rather than wiring a route that would record
 * those two claims and report success.
 */
describe("which grades close through the pure executor, and on what inputs", () => {
  const ACTOR = "u-operator";
  const CLOSED_PATH: readonly IncidentStatus[] = ["triaged", "mitigating", "resolved", "closed"];

  interface CloseInputs {
    readonly rootCause: boolean;
    readonly publiclyVisible: boolean;
    readonly postmortemId: boolean;
  }
  const FULL: CloseInputs = { rootCause: true, publiclyVisible: true, postmortemId: true };

  /**
   * Declares, assigns every role sev1 needs (a superset of every grade's requirement, so no grade
   * fails on roles), then walks `declared -> triaged -> mitigating -> resolved -> closed` supplying
   * only the inputs `supply` turns on. Returns the status reached and, if refused, the blocker text.
   */
  function drive(
    severity: Severity,
    supply: CloseInputs,
  ): { readonly reached: IncidentStatus; readonly blockedBy: string | null } {
    const ex = new IncidentExecutor({ clock: new FixedClock(new Date(T0)) });
    let record: IncidentRecord = ex.declare({
      id: "INC-2026-0042",
      title: "probe",
      severity,
      category: "availability",
      declaredBy: ACTOR,
      detail: "probe",
      declaredAt: T0,
    });
    for (const role of SEV1_REQUIRED_ROLES) {
      record = ex.assignRole(record, { role, userId: `u-${role}`, actorUserId: ACTOR, at: T0 });
    }
    for (const to of CLOSED_PATH) {
      try {
        record = ex.transition(record, {
          to,
          at: AFTER,
          actorUserId: ACTOR,
          ...(supply.publiclyVisible && to === "triaged" ? { publiclyVisible: true } : {}),
          ...(supply.rootCause && to === "closed" ? { rootCause: "a bounded buffer" } : {}),
          ...(supply.postmortemId && to === "closed" ? { postmortemId: "PM-2026-0001" } : {}),
        });
      } catch (err) {
        if (!(err instanceof IncidentTransitionBlockedError)) throw err;
        return { reached: record.status, blockedBy: err.message };
      }
    }
    return { reached: record.status, blockedBy: null };
  }

  it.each(SEVERITIES)("%s reaches closed when every input is supplied", (severity) => {
    expect(drive(severity, FULL)).toEqual({ reached: "closed", blockedBy: null });
  });

  it.each(SEVERITIES)("%s is refused at close without a root cause, whatever its grade", (severity) => {
    const outcome = drive(severity, { ...FULL, rootCause: false });
    expect(outcome.reached).toBe("resolved");
    expect(outcome.blockedBy).toMatch(/rootCause/);
  });

  it.each(SEVERITIES)(
    "%s needs publiclyVisible on the way out of declared exactly when its profile requires a status page",
    (severity) => {
      const outcome = drive(severity, { ...FULL, publiclyVisible: false });
      if (profileFor(severity).requiresStatusPage) {
        expect(outcome.reached).toBe("declared");
        expect(outcome.blockedBy).toMatch(/publiclyVisible/);
      } else {
        expect(outcome).toEqual({ reached: "closed", blockedBy: null });
      }
    },
  );

  it.each(SEVERITIES)(
    "%s needs a postmortem id at close exactly when its profile requires a postmortem",
    (severity) => {
      const outcome = drive(severity, { ...FULL, postmortemId: false });
      if (requiresPostmortem(severity)) {
        expect(outcome.reached).toBe("resolved");
        expect(outcome.blockedBy).toMatch(/postmortemId/);
      } else {
        expect(outcome).toEqual({ reached: "closed", blockedBy: null });
      }
    },
  );

  it("has grades on both sides of both profile-dependent inputs, so neither split is vacuous", () => {
    const needsPage = SEVERITIES.filter((s) => profileFor(s).requiresStatusPage);
    const needsPm = SEVERITIES.filter((s) => requiresPostmortem(s));
    expect(needsPage.length).toBeGreaterThan(0);
    expect(needsPage.length).toBeLessThan(SEVERITIES.length);
    expect(needsPm.length).toBeGreaterThan(0);
    expect(needsPm.length).toBeLessThan(SEVERITIES.length);
  });

  it("refuses a postmortem id outside the postmortem table's own shape, and checks shape not existence", () => {
    // Rewritten, not deleted (ADR-0372): this test pinned `"anything"` as accepted, which was the
    // defect — `IncidentRecordSchema.postmortemId` was `z.string().min(1)` while the postmortem
    // table's id is `^PM-[0-9]{4}-[0-9]{4,8}$`. The contract shares that regex now (ADR-0483).
    const ex = new IncidentExecutor({ clock: new FixedClock(new Date(T0)) });
    expect(() =>
      ex.attachPostmortem(declaredIncident(), { postmortemId: "anything", actorUserId: ACTOR, at: AFTER }),
    ).toThrow();
    // A well-shaped id that names no stored postmortem is still accepted: existence is a store
    // question, so wiring a close route before `PostgresPostmortemStore` has a caller still needs
    // its own check.
    const attached = ex.attachPostmortem(declaredIncident(), {
      postmortemId: "PM-2026-0001",
      actorUserId: ACTOR,
      at: AFTER,
    });
    expect(attached.postmortemId).toBe("PM-2026-0001");
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

  it.each(SEVERITIES)(
    "%s: a declared incident with no roles cannot be triaged, and once triaged a recovery leaves it alone (`human_owned`)",
    (severity) => {
      // `PostgresIncidentDeclarer.closeOut` answers `human_owned` exactly when `cancelIfUntriaged`
      // declines, i.e. once the status has moved past `declared`. Moving past it is `triaged`,
      // which needs the on-call roles — and the declaration input has no field to carry them (the
      // `@ts-expect-error` below), so only a caller of `assignRole` and `transition` can reach
      // `human_owned`. Whether any such caller is mounted is a deployment fact, reported at boot by
      // `incident-lifecycle-survey.ts` from the live route registry rather than asserted here.
      const ex = new IncidentExecutor({ clock: new FixedClock(new Date(T0)) });
      const declared = ex.declare({
        id: "INC-2026-0043",
        title: "probe",
        severity,
        category: "availability",
        declaredBy: "operate-server",
        detail: "probe",
        declaredAt: T0,
        publiclyVisible: true,
      });
      expect(() =>
        ex.transition(declared, { to: "triaged", at: AFTER, actorUserId: "u" }),
      ).toThrow(/roleAssignments|role/);

      let triaged = declared;
      for (const role of SEV1_REQUIRED_ROLES) {
        triaged = ex.assignRole(triaged, { role, userId: `u-${role}`, actorUserId: "u", at: T0 });
      }
      triaged = ex.transition(triaged, { to: "triaged", at: AFTER, actorUserId: "u" });
      expect(cancelIfUntriaged(triaged, { at: AFTER, actorUserId: "x", reason: "r" })).toBeNull();
      expect(cancelIfUntriaged(declared, { at: AFTER, actorUserId: "x", reason: "r" })?.status).toBe(
        "cancelled",
      );
    },
  );

  it("cannot be handed roles at declaration — the declarer's input type has no field for them", () => {
    const ex = new IncidentExecutor({ clock: new FixedClock(new Date(T0)) });
    const declared = ex.declare({
      id: "INC-2026-0044",
      title: "probe",
      severity: "sev3",
      category: "availability",
      declaredBy: "operate-server",
      detail: "probe",
      declaredAt: T0,
      // @ts-expect-error — `DeclareIncidentInput` carries no `roleAssignments`; the day it does, this
      // directive is unused (TS2578) and the `human_owned` premise above needs re-deriving.
      roleAssignments: [{ role: "incident_commander", userId: "u", assignedAt: T0 }],
    });
    expect(declared.roleAssignments).toEqual([]);
  });
});
