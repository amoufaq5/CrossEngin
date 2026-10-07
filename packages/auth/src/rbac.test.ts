import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import type { AbacEvaluationInput, AbacEvaluator } from "./abac.js";
import { rbacCheck } from "./rbac.js";
import type { AbacOutcome, PermissionMap, Principal, RoleDefinition } from "./types.js";

const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([
  ["staff", { name: "staff" }],
  ["pharmacist", { name: "pharmacist", inherits: ["staff"] }],
  ["manager", { name: "manager", inherits: ["pharmacist"] }],
]);

function principal(role: string): Principal {
  return {
    kind: "user",
    tenantId: "t" as TenantId,
    userId: "u" as UserId,
    primaryRole: role,
    secondaryRoles: [],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
  };
}

const PERMS: PermissionMap = {
  prescription: {
    read: { roles: ["pharmacist", "manager"] },
    create: { roles: ["pharmacist"] },
    update: { roles: ["pharmacist"], abac: "data.access.allow_update" },
    delete: { roles: [] },
    transitions: {
      verify: { roles: ["pharmacist"], abac: "data.access.signature_required_and_valid" },
      cancel: { roles: ["pharmacist", "manager"] },
    },
  },
};

describe("rbacCheck — entity-level operations", () => {
  it("allows pharmacist to read", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "read",
    });
    expect(r.allowed).toBe(true);
  });

  it("allows manager to read via inheritance", () => {
    const r = rbacCheck({
      principal: principal("manager"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "read",
    });
    expect(r.allowed).toBe(true);
  });

  it("denies staff (no inherited grant)", () => {
    const r = rbacCheck({
      principal: principal("staff"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "read",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/effective roles do not grant/);
  });

  it("denies delete when the grant list is empty", () => {
    const r = rbacCheck({
      principal: principal("manager"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "delete",
    });
    expect(r.allowed).toBe(false);
  });

  it("denies an abac-qualified grant when no evaluator can discharge it", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
    });
    // The role check passes; the obligation does not. Granting here was the defect: an obligation
    // handed back to a caller that never read it granted unconditionally.
    expect(r.allowed).toBe(false);
    expect(r.abac).toEqual({
      policyKey: "data.access.allow_update",
      outcome: "undischargeable",
    });
  });

  it("allows an abac-qualified grant when the evaluator answers satisfied", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: () => "satisfied",
    });
    expect(r.allowed).toBe(true);
    expect(r.abac).toEqual({ policyKey: "data.access.allow_update", outcome: "satisfied" });
  });

  it("does not set abac when the grant carries no policy key", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "create",
    });
    expect(r.allowed).toBe(true);
    // `undefined` rather than a `satisfied` discharge: no obligation existed, so none was evaluated.
    expect(r.abac).toBeUndefined();
  });

  it("denies an operation that's not declared on the entity", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "list",
    });
    expect(r.allowed).toBe(false);
  });

  it("denies operation on an entity not in the permission map", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "unknown",
      operation: "read",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no permissions declared/);
  });
});

describe("rbacCheck — transitions", () => {
  it("allows pharmacist to verify once the abac obligation is satisfied", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "verify" },
      abacEvaluator: () => "satisfied",
    });
    expect(r.allowed).toBe(true);
    expect(r.abac).toEqual({
      policyKey: "data.access.signature_required_and_valid",
      outcome: "satisfied",
    });
  });

  it("denies the same transition with no evaluator, so a signature check is not assumed", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "verify" },
    });
    expect(r.allowed).toBe(false);
    expect(r.abac?.outcome).toBe("undischargeable");
  });

  it("allows manager to cancel via inheritance", () => {
    const r = rbacCheck({
      principal: principal("manager"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "cancel" },
    });
    expect(r.allowed).toBe(true);
  });

  it("denies an undeclared transition", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "nonexistent" },
    });
    expect(r.allowed).toBe(false);
  });

  it("denies a transition for a role not in the grant", () => {
    const r = rbacCheck({
      principal: principal("staff"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "verify" },
    });
    expect(r.allowed).toBe(false);
  });
});

describe("rbacCheck — abac obligations", () => {
  function spyEvaluator(outcome: AbacOutcome): {
    readonly fn: AbacEvaluator;
    readonly calls: AbacEvaluationInput[];
  } {
    const calls: AbacEvaluationInput[] = [];
    return {
      fn: (input) => {
        calls.push(input);
        return outcome;
      },
      calls,
    };
  }

  it("does not consult the evaluator when the role check already failed", () => {
    const spy = spyEvaluator("satisfied");
    const r = rbacCheck({
      principal: principal("staff"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: spy.fn,
    });
    expect(r.allowed).toBe(false);
    // There is nothing to learn from an evaluation that a 403 was already owed, and asking would
    // hand the deployment's policy layer a principal it has no business seeing.
    expect(spy.calls).toEqual([]);
  });

  it("does not consult the evaluator for an entity with no permissions declared", () => {
    const spy = spyEvaluator("satisfied");
    rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "unknown",
      operation: "update",
      abacEvaluator: spy.fn,
    });
    expect(spy.calls).toEqual([]);
  });

  it("does not consult the evaluator for a grant carrying no policy key", () => {
    const spy = spyEvaluator("satisfied");
    rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "create",
      abacEvaluator: spy.fn,
    });
    expect(spy.calls).toEqual([]);
  });

  it("passes the policy key, principal, entity and operation to the evaluator", () => {
    const spy = spyEvaluator("satisfied");
    const p = principal("pharmacist");
    rbacCheck({
      principal: p,
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: spy.fn,
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toEqual({
      policyKey: "data.access.allow_update",
      principal: p,
      entity: "prescription",
      operation: "update",
    });
  });

  it("names the transition in the evaluation input", () => {
    const spy = spyEvaluator("satisfied");
    rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "verify" },
      abacEvaluator: spy.fn,
    });
    expect(spy.calls[0]?.operation).toEqual({ kind: "transition", name: "verify" });
  });

  it("denies on 'denied' and attaches the discharge", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: () => "denied",
    });
    expect(r.allowed).toBe(false);
    expect(r.abac).toEqual({ policyKey: "data.access.allow_update", outcome: "denied" });
  });

  it("gives 'denied' and 'undischargeable' different reason text", () => {
    const denied = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: () => "denied",
    });
    const undischargeable = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
    });
    // A refusal about this principal's attributes and a refusal because nothing could answer have
    // different remedies, so they must not read alike.
    expect(denied.reason).toMatch(/denied\)$/);
    expect(undischargeable.reason).toMatch(/undischargeable\)$/);
    expect(denied.reason).not.toBe(undischargeable.reason);
    expect(denied.reason).toContain("data.access.allow_update");
  });

  it("denies when the evaluator throws", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: () => {
        throw new Error("policy service unreachable");
      },
    });
    expect(r.allowed).toBe(false);
    expect(r.abac?.outcome).toBe("undischargeable");
  });

  it("leaves an unqualified grant untouched when an evaluator is supplied", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "read",
      abacEvaluator: () => "denied",
    });
    // No obligation on the grant, so the evaluator has no say: a deployment wiring an evaluator
    // must not start refusing grants nobody qualified.
    expect(r.allowed).toBe(true);
    expect(r.abac).toBeUndefined();
  });
});

describe("rbacCheck — unresolved abac attributes", () => {
  function unresolved(role: string): Principal {
    return { ...principal(role), abacAttributes: null };
  }

  function spy(outcome: AbacOutcome): {
    readonly fn: AbacEvaluator;
    readonly calls: AbacEvaluationInput[];
  } {
    const calls: AbacEvaluationInput[] = [];
    return {
      fn: (input) => {
        calls.push(input);
        return outcome;
      },
      calls,
    };
  }

  it("denies an obligated grant even when an evaluator is supplied", () => {
    const s = spy("satisfied");
    const r = rbacCheck({
      principal: unresolved("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: s.fn,
    });
    expect(r.allowed).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it("names undischargeable in the reason and on the discharge", () => {
    const r = rbacCheck({
      principal: unresolved("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: () => "satisfied",
    });
    expect(r.abac).toEqual({
      policyKey: "data.access.allow_update",
      outcome: "undischargeable",
    });
    expect(r.reason).toContain("undischargeable");
    expect(r.reason).toContain("data.access.allow_update");
  });

  it("denies an obligated transition too", () => {
    const r = rbacCheck({
      principal: unresolved("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "verify" },
      abacEvaluator: () => "satisfied",
    });
    expect(r.allowed).toBe(false);
    expect(r.abac?.outcome).toBe("undischargeable");
  });

  it("leaves an unobligated grant exactly as it was", () => {
    // The regression that matters most: the new rule is about obligations, so a grant that carries
    // none must not start refusing because a directory happens not to be wired.
    const r = rbacCheck({
      principal: unresolved("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "read",
      abacEvaluator: () => "satisfied",
    });
    expect(r).toEqual({ allowed: true });
  });

  it("leaves an unobligated grant as it was with no evaluator either", () => {
    const r = rbacCheck({
      principal: unresolved("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "create",
    });
    expect(r).toEqual({ allowed: true });
  });

  it("still refuses on roles first, so the reason is the role failure and not the attributes", () => {
    const r = rbacCheck({
      principal: unresolved("staff"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: () => "satisfied",
    });
    expect(r.allowed).toBe(false);
    expect(r.abac).toBeUndefined();
    expect(r.reason).toContain("effective roles");
  });
});

describe("rbacCheck — the record a policy needs", () => {
  const RECORD: Readonly<Record<string, unknown>> = { id: "rx-1", department: "oncology" };

  function spy(outcome: AbacOutcome): {
    readonly fn: AbacEvaluator;
    readonly calls: AbacEvaluationInput[];
  } {
    const calls: AbacEvaluationInput[] = [];
    return {
      fn: (input) => {
        calls.push(input);
        return outcome;
      },
      calls,
    };
  }

  /** An evaluator whose policy is about the row: deferred without one, satisfied with it. */
  const recordBearing: AbacEvaluator = (input) =>
    input.record === undefined ? "deferred" : "satisfied";

  it("refuses when the policy needs a record and the caller supplied none", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: recordBearing,
    });
    // `deferred` is a refusal, not a skip: a caller that reads it as "nothing to check" would grant
    // an obligation nothing evaluated.
    expect(r.allowed).toBe(false);
    expect(r.abac).toEqual({ policyKey: "data.access.allow_update", outcome: "deferred" });
  });

  it("names the policy key and the deferred outcome in the reason", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: recordBearing,
    });
    expect(r.reason).toContain("data.access.allow_update");
    expect(r.reason).toMatch(/deferred\)$/);
  });

  it("gives deferred a different reason from denied and from undischargeable", () => {
    const base = {
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update" as const,
    };
    const deferred = rbacCheck({ ...base, abacEvaluator: () => "deferred" });
    const denied = rbacCheck({ ...base, abacEvaluator: () => "denied" });
    const undischargeable = rbacCheck({ ...base });
    // Three refusals, three remedies — load the record, change the principal's attributes, wire a
    // policy layer — so they must not read alike.
    expect(new Set([deferred.reason, denied.reason, undischargeable.reason]).size).toBe(3);
  });

  it("allows the same grant once the record is supplied", () => {
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: recordBearing,
      record: RECORD,
    });
    expect(r.allowed).toBe(true);
    expect(r.abac).toEqual({ policyKey: "data.access.allow_update", outcome: "satisfied" });
  });

  it("passes the record through to the evaluator verbatim", () => {
    const s = spy("satisfied");
    rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: s.fn,
      record: RECORD,
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.record).toBe(RECORD);
  });

  it("omits the record key entirely when none was supplied", () => {
    // Absent, not `undefined`: an evaluator telling "no record supplied" from "a record of nothing"
    // reads the key's presence.
    const s = spy("satisfied");
    rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: s.fn,
    });
    const input = s.calls[0] as AbacEvaluationInput;
    expect("record" in input).toBe(false);
  });

  it("passes the record on a transition too", () => {
    const s = spy("satisfied");
    rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: { kind: "transition", name: "verify" },
      abacEvaluator: s.fn,
      record: RECORD,
    });
    expect(s.calls[0]?.record).toBe(RECORD);
    expect(s.calls[0]?.operation).toEqual({ kind: "transition", name: "verify" });
  });

  it("does not consult the evaluator when the role check failed, record or not", () => {
    const s = spy("satisfied");
    const r = rbacCheck({
      principal: principal("staff"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: s.fn,
      record: RECORD,
    });
    expect(r.allowed).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it("leaves an unobligated grant untouched when a record is supplied", () => {
    // A record is an input to a policy, never a trigger for one: a grant carrying no `abac` must
    // behave identically whether or not the caller happened to have loaded the row.
    const r = rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "read",
      abacEvaluator: () => "deferred",
      record: RECORD,
    });
    expect(r).toEqual({ allowed: true });
  });

  it("refuses an unresolved-attribute principal before the record can matter", () => {
    const s = spy("satisfied");
    const r = rbacCheck({
      principal: { ...principal("pharmacist"), abacAttributes: null },
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: s.fn,
      record: RECORD,
    });
    expect(r.abac?.outcome).toBe("undischargeable");
    expect(s.calls).toEqual([]);
  });

  it("carries an empty record through as a record", () => {
    const s = spy("satisfied");
    rbacCheck({
      principal: principal("pharmacist"),
      permissions: PERMS,
      roles: ROLES,
      entity: "prescription",
      operation: "update",
      abacEvaluator: s.fn,
      record: {},
    });
    const input = s.calls[0] as AbacEvaluationInput;
    expect("record" in input).toBe(true);
    expect(input.record).toEqual({});
  });
});
