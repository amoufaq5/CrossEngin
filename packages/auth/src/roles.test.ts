import { describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@crossengin/types";
import { RoleInheritanceCycleError, UnknownRoleError } from "./errors.js";
import { resolveEffectiveRoles, validateRoleGraph } from "./roles.js";
import type { Principal, RoleDefinition } from "./types.js";

function principal(primary: string, secondary: string[] = []): Principal {
  return {
    kind: "user",
    tenantId: "t" as TenantId,
    userId: "u" as UserId,
    primaryRole: primary,
    secondaryRoles: secondary,
    abacAttributes: {},
    mfaProofAgeSeconds: null,
  };
}

const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([
  ["staff", { name: "staff" }],
  ["pharmacist", { name: "pharmacist", inherits: ["staff"] }],
  ["technician", { name: "technician", inherits: ["staff"] }],
  ["manager", { name: "manager", inherits: ["pharmacist"] }],
  ["a", { name: "a", inherits: ["b"] }],
  ["b", { name: "b", inherits: ["a"] }],
]);

describe("resolveEffectiveRoles", () => {
  it("returns the primary role for a role without inheritance", () => {
    expect(resolveEffectiveRoles(principal("staff"), ROLES)).toEqual(new Set(["staff"]));
  });

  it("includes parent role via inheritance", () => {
    expect(resolveEffectiveRoles(principal("pharmacist"), ROLES)).toEqual(
      new Set(["pharmacist", "staff"]),
    );
  });

  it("resolves transitive inheritance (manager -> pharmacist -> staff)", () => {
    expect(resolveEffectiveRoles(principal("manager"), ROLES)).toEqual(
      new Set(["manager", "pharmacist", "staff"]),
    );
  });

  it("merges secondary roles + their parents into the effective set", () => {
    expect(resolveEffectiveRoles(principal("staff", ["technician"]), ROLES)).toEqual(
      new Set(["staff", "technician"]),
    );
  });

  it("SKIPS an unknown primary role rather than throwing, so the decision is a denial", () => {
    // These two tests asserted `toThrow(UnknownRoleError)` and that was the defect, pinned. All
    // seven request-path callers resolve roles *before* deciding anything, so the throw reached the
    // handler and became a 500 on every entity route for any session whose role the served manifest
    // does not declare — live on the shipped deployment, where `--platform-admin-role
    // platform_admin` is a platform role by design and `erp-core` declares fifteen of which it is
    // not one. The answer owed is 403: an undeclared role holds no grants. A 500 is not a stricter
    // 403, it is the different claim that the server failed.
    //
    // `node.ts` has said so since ADR-0339 — "throws `UnknownRoleError` for an undeclared name, and
    // answers false — fail-closed" — which is two incompatible halves in one sentence, because a
    // function that throws answers nothing. The code now does what that comment described.
    expect(resolveEffectiveRoles(principal("nonexistent"), ROLES)).toEqual(new Set());
  });

  it("skips an unknown secondary role and keeps the declared ones", () => {
    // Narrowing and not widening: the unknown name contributes nothing while `staff` still resolves
    // with its parents, so a session with one good role and one typo is authorised on the good one
    // alone. That is the direction that cannot grant anything it should not.
    expect(resolveEffectiveRoles(principal("staff", ["unknown"]), ROLES)).toEqual(
      new Set(["staff"]),
    );
  });

  it("skips an unknown INHERITED parent, narrowing rather than raising", () => {
    // The same rule one level in. A declared role whose `inherits` names something absent is an
    // authoring error `validateRoleGraph` refuses — but if one reaches a live request, dropping the
    // parent narrows the effective set, where throwing 500s a request that should have been decided.
    const withMissingParent = new Map(ROLES);
    withMissingParent.set("orphan" as never, { name: "orphan", inherits: ["ghost"] } as never);
    expect(resolveEffectiveRoles(principal("orphan"), withMissingParent)).toEqual(
      new Set(["orphan"]),
    );
  });

  it("still throws UnknownRoleError from validateRoleGraph, which is the authoring question", () => {
    // The split is by question and not by name: `refuse` is "is this role graph coherent", asked of
    // a manifest a reviewer is about to approve, and `skip` is "what may this session do". Only the
    // second has an undeclared name as an ordinary input.
    // A standalone map and not `new Map(ROLES)`: that fixture carries the cycle used two tests
    // above, and `validateRoleGraph` walks every key, so it would raise
    // `RoleInheritanceCycleError` first and this assertion would pass on the wrong error.
    const broken = new Map([
      ["dangling", { name: "dangling", inherits: ["nope"] }],
    ] as never) as never;
    expect(() => validateRoleGraph(broken)).toThrow(UnknownRoleError);
  });

  it("throws RoleInheritanceCycleError on a cycle", () => {
    expect(() => resolveEffectiveRoles(principal("a"), ROLES)).toThrow(
      RoleInheritanceCycleError,
    );
  });
});

describe("validateRoleGraph", () => {
  it("accepts a flat role graph (no inheritance)", () => {
    const r = new Map<string, RoleDefinition>([
      ["staff", { name: "staff" }],
      ["pharmacist", { name: "pharmacist" }],
    ]);
    expect(() => validateRoleGraph(r)).not.toThrow();
  });

  it("accepts a hierarchical role graph", () => {
    const r = new Map<string, RoleDefinition>([
      ["staff", { name: "staff" }],
      ["pharmacist", { name: "pharmacist", inherits: ["staff"] }],
      ["manager", { name: "manager", inherits: ["pharmacist"] }],
    ]);
    expect(() => validateRoleGraph(r)).not.toThrow();
  });

  it("throws on a 2-node cycle", () => {
    const r = new Map<string, RoleDefinition>([
      ["a", { name: "a", inherits: ["b"] }],
      ["b", { name: "b", inherits: ["a"] }],
    ]);
    expect(() => validateRoleGraph(r)).toThrow(RoleInheritanceCycleError);
  });

  it("throws on an unknown inherits reference", () => {
    const r = new Map<string, RoleDefinition>([
      ["pharmacist", { name: "pharmacist", inherits: ["mystery"] }],
    ]);
    expect(() => validateRoleGraph(r)).toThrow(UnknownRoleError);
  });
});
