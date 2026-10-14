import { describe, expect, it, vi } from "vitest";

import { loadBuiltinPack } from "./manifest-source.js";
import {
  checkMembershipRoles,
  formatMembershipRoleWarnings,
  MEMBERSHIP_ROLE_POSITIONS,
  MEMBERSHIP_ROLE_VERDICT_WARNS,
  MEMBERSHIP_ROLE_VERDICTS,
  type MembershipRoleCheckInput,
  type MembershipRoleDirectory,
  type MembershipRoleVerdict,
} from "./membership-role-fence.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

function grant(over: Partial<MembershipRoleCheckInput> = {}): MembershipRoleCheckInput {
  return { tenantId: TENANT, primaryRole: "erp_admin", secondaryRoles: [], ...over };
}

function directoryOf(...roles: readonly string[]): MembershipRoleDirectory {
  const set = new Set(roles);
  return () => Promise.resolve(set);
}

const UNRESOLVED: MembershipRoleDirectory = () => Promise.resolve(null);

describe("MEMBERSHIP_ROLE_VERDICT_WARNS", () => {
  it("is total over MEMBERSHIP_ROLE_VERDICTS", () => {
    expect(Object.keys(MEMBERSHIP_ROLE_VERDICT_WARNS).sort()).toEqual(
      [...MEMBERSHIP_ROLE_VERDICTS].sort(),
    );
  });

  it("is silent for 'declared' and warns for both others", () => {
    expect(MEMBERSHIP_ROLE_VERDICT_WARNS.declared).toBe(false);
    expect(MEMBERSHIP_ROLE_VERDICT_WARNS.not_declared).toBe(true);
    expect(MEMBERSHIP_ROLE_VERDICT_WARNS.unresolved).toBe(true);
  });

  /**
   * The map and `MembershipRoleWarning.verdict`'s `Exclude<…, "declared">` are two statements of one
   * fact, and nothing in the type system relates them. `warningVerdictOf` excludes `declared` by
   * comparison so a disagreement goes *silent* rather than producing a warning typed as something it
   * is not — which leaves the pairing itself to be asserted, here, as an exact set: a second `false`
   * entry would make the type wider than the map, and a flipped `declared` narrower.
   */
  it("admits exactly one silent verdict, which is the type's excluded member", () => {
    const silent = MEMBERSHIP_ROLE_VERDICTS.filter((v) => !MEMBERSHIP_ROLE_VERDICT_WARNS[v]);
    expect(silent).toEqual(["declared"]);
  });

  it("names both positions and no third", () => {
    expect(MEMBERSHIP_ROLE_POSITIONS).toEqual(["primary", "secondary"]);
  });
});

describe("checkMembershipRoles — the declared case", () => {
  it("warns about nothing when the primary role is declared", async () => {
    const ws = await checkMembershipRoles(grant(), directoryOf("erp_admin", "erp_viewer"));
    expect(ws).toEqual([]);
  });

  it("warns about nothing when every secondary role is declared too", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "erp_admin", secondaryRoles: ["erp_viewer", "ap_clerk"] }),
      directoryOf("erp_admin", "erp_viewer", "ap_clerk"),
    );
    expect(ws).toEqual([]);
  });
});

describe("checkMembershipRoles — an undeclared primary role", () => {
  it("warns with the sorted declared list in declaredRoles", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "platform_admin" }),
      directoryOf("erp_viewer", "ap_clerk", "erp_admin"),
    );
    expect(ws).toHaveLength(1);
    expect(ws[0]?.position).toBe("primary");
    expect(ws[0]?.role).toBe("platform_admin");
    expect(ws[0]?.verdict).toBe("not_declared");
    expect(ws[0]?.declaredRoles).toEqual(["ap_clerk", "erp_admin", "erp_viewer"]);
  });

  it("names the consequence and offers the declared names as the remedy", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "platform_admin" }),
      directoryOf("erp_admin"),
    );
    expect(ws[0]?.detail).toContain("authorizes nothing");
    expect(ws[0]?.detail).toContain("erp_admin");
  });

  /**
   * The measured case this module exists for, read off the real pack rather than a fixture: a
   * `platform_admin` grant in an `erp-core` tenant. Verified independently against `rbacCheck` —
   * 0 of 255 (entity, operation) pairs and 0 of 51 entities allowed, where `erp_admin` reaches
   * 250 and 50 — so the warning below is reporting a total authorization denial.
   */
  it("warns for platform_admin against erp-core's fifteen declared roles", async () => {
    const core = await loadBuiltinPack("erp-core");
    const declared = new Set(Object.keys(core.roles ?? {}));
    expect(declared.size).toBe(15);
    expect(declared.has("platform_admin")).toBe(false);
    expect(declared.has("erp_admin")).toBe(true);

    const ws = await checkMembershipRoles(grant({ primaryRole: "platform_admin" }), () =>
      Promise.resolve(declared),
    );
    expect(ws).toHaveLength(1);
    expect(ws[0]?.verdict).toBe("not_declared");
    expect(ws[0]?.declaredRoles).toHaveLength(15);

    const control = await checkMembershipRoles(grant({ primaryRole: "erp_admin" }), () =>
      Promise.resolve(declared),
    );
    expect(control).toEqual([]);
  });

  it("summarises rather than listing every name past the limit", async () => {
    const many = Array.from({ length: 15 }, (_, i) => `role_${String(i).padStart(2, "0")}`);
    const ws = await checkMembershipRoles(grant({ primaryRole: "ghost" }), directoryOf(...many));
    expect(ws[0]?.detail).toContain("(+7 more)");
    // The exact list stays on the warning even when the sentence truncates.
    expect(ws[0]?.declaredRoles).toHaveLength(15);
  });
});

describe("checkMembershipRoles — an undeclared secondary role", () => {
  it("warns with a detail that differs from the primary one", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "erp_admin", secondaryRoles: ["ghost"] }),
      directoryOf("erp_admin"),
    );
    expect(ws).toHaveLength(1);
    expect(ws[0]?.position).toBe("secondary");
    expect(ws[0]?.verdict).toBe("not_declared");
    expect(ws[0]?.detail).toContain("secondary role 'ghost'");
    expect(ws[0]?.detail).not.toContain("authorizes nothing");
  });

  /**
   * The measured fact the detail must carry: a secondary role is stored, read back and echoed, and
   * then reaches no authorization decision for two independent reasons — `mintSessionToken` stamps
   * one `scope` from `primaryRole`, and `principalRoles` returns no `secondaryRoles` key at all. So
   * the warning must not read as *declare it and it will work*, and in particular must not offer
   * the role catalog as a remedy the way the primary warning does.
   */
  it("says the position is unread rather than offering the declared names", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "erp_admin", secondaryRoles: ["ghost"] }),
      directoryOf("erp_admin", "erp_viewer"),
    );
    expect(ws[0]?.detail).toContain("whether declared or not");
    expect(ws[0]?.detail).toContain("principalRoles reads one scope");
    expect(ws[0]?.detail).not.toContain("the roles a session can carry");
    expect(ws[0]?.detail).not.toContain("erp_viewer");
  });

  it("still reports the declared list on the warning for an operator to read", async () => {
    const ws = await checkMembershipRoles(
      grant({ secondaryRoles: ["ghost"] }),
      directoryOf("erp_admin", "ap_clerk"),
    );
    expect(ws[0]?.declaredRoles).toEqual(["ap_clerk", "erp_admin"]);
  });
});

describe("checkMembershipRoles — ordering and duplicates", () => {
  it("reports both positions in input order, primary first", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "ghost_primary", secondaryRoles: ["ghost_b", "ghost_a"] }),
      directoryOf("erp_admin"),
    );
    expect(ws.map((w) => [w.position, w.role])).toEqual([
      ["primary", "ghost_primary"],
      ["secondary", "ghost_b"],
      ["secondary", "ghost_a"],
    ]);
  });

  it("warns once for a role named twice among the secondaries", async () => {
    const ws = await checkMembershipRoles(
      grant({ secondaryRoles: ["ghost", "ghost"] }),
      directoryOf("erp_admin"),
    );
    expect(ws).toHaveLength(1);
    expect(ws[0]?.role).toBe("ghost");
  });

  it("keeps the primary position when a role is named as both", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "ghost", secondaryRoles: ["ghost"] }),
      directoryOf("erp_admin"),
    );
    expect(ws).toHaveLength(1);
    // The consequential position survives: `primary` is the one a session reads.
    expect(ws[0]?.position).toBe("primary");
    expect(ws[0]?.detail).toContain("authorizes nothing");
  });

  it("does not collapse a declared role into a later undeclared one", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "erp_admin", secondaryRoles: ["erp_admin", "ghost"] }),
      directoryOf("erp_admin"),
    );
    expect(ws.map((w) => w.role)).toEqual(["ghost"]);
  });

  it("compares names exactly, so whitespace and case are different roles", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "ERP_ADMIN", secondaryRoles: [" erp_admin"] }),
      directoryOf("erp_admin"),
    );
    expect(ws.map((w) => w.role)).toEqual(["ERP_ADMIN", " erp_admin"]);
  });
});

describe("checkMembershipRoles — an empty set is a claim, null is not", () => {
  it("reads an empty set as not_declared with an empty declared list", async () => {
    const ws = await checkMembershipRoles(grant({ primaryRole: "erp_admin" }), directoryOf());
    expect(ws).toHaveLength(1);
    expect(ws[0]?.verdict).toBe("not_declared");
    expect(ws[0]?.declaredRoles).toEqual([]);
    expect(ws[0]?.detail).toContain("declares no role at all");
  });

  it("reads null as unresolved with no declared list", async () => {
    const ws = await checkMembershipRoles(grant({ primaryRole: "erp_admin" }), UNRESOLVED);
    expect(ws).toHaveLength(1);
    expect(ws[0]?.verdict).toBe("unresolved");
    expect(ws[0]?.declaredRoles).toBeNull();
  });

  /**
   * ADR-0331's distinction, asserted as a *difference* rather than per field: `new Set()` claims
   * this manifest declares no role, and `null` says nobody looked. Collapsing them would report a
   * directory that could not answer as a manifest that declares nothing — a confident wrong
   * statement where there is no statement to make.
   */
  it("answers the two differently in every respect", async () => {
    const [empty] = await checkMembershipRoles(grant(), directoryOf());
    const [unknown] = await checkMembershipRoles(grant(), UNRESOLVED);
    expect(empty).toBeDefined();
    expect(unknown).toBeDefined();
    expect(empty).not.toEqual(unknown);
    expect(empty?.verdict).not.toBe(unknown?.verdict);
    expect(empty?.detail).not.toBe(unknown?.detail);
    // Asserted as the discriminating shapes rather than `not.toBe`, which two distinct empty
    // arrays would also satisfy — the hazard being a test that names the distinction and then
    // compares two references that can never be equal.
    expect(Array.isArray(empty?.declaredRoles)).toBe(true);
    expect(unknown?.declaredRoles).toBeNull();
  });
});

describe("checkMembershipRoles — a directory that cannot answer", () => {
  it("yields unresolved for a throwing directory rather than rejecting", async () => {
    const ws = await checkMembershipRoles(grant(), () => {
      throw new Error("relation \"meta.manifests\" does not exist");
    });
    expect(ws).toHaveLength(1);
    expect(ws[0]?.verdict).toBe("unresolved");
  });

  it("yields unresolved for a rejecting directory rather than rejecting", async () => {
    const ws = await checkMembershipRoles(grant(), () =>
      Promise.reject(new Error("42501: permission denied")),
    );
    expect(ws[0]?.verdict).toBe("unresolved");
  });

  it("does not leak the directory's failure into the detail", async () => {
    const ws = await checkMembershipRoles(grant(), () => {
      throw new Error("connect ECONNREFUSED 10.0.0.4:5432");
    });
    expect(ws[0]?.detail).not.toContain("ECONNREFUSED");
    expect(ws[0]?.detail).not.toContain("10.0.0.4");
  });

  /**
   * An unresolved verdict knows nothing about this grant, so there is no action to recommend —
   * naming the role catalog would name a catalog the call could not read, and telling an operator
   * to re-grant would be advice drawn from an absence (ADR-0334).
   */
  it("names no remedy for an unresolved verdict, in either position", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "ghost_primary", secondaryRoles: ["ghost_secondary"] }),
      UNRESOLVED,
    );
    expect(ws).toHaveLength(2);
    for (const w of ws) {
      expect(w.verdict).toBe("unresolved");
      expect(w.detail).not.toContain("remedy");
      expect(w.detail).not.toContain("the roles a session can carry");
      expect(w.detail).not.toContain("re-grant");
      expect(w.detail).not.toMatch(/\buse\b/);
    }
  });
});

describe("checkMembershipRoles — the directory is consulted once", () => {
  it("calls it exactly once for a grant naming four roles", async () => {
    const spy = vi.fn(() => Promise.resolve(new Set(["erp_admin"])));
    await checkMembershipRoles(
      grant({ primaryRole: "ghost_a", secondaryRoles: ["ghost_b", "ghost_c", "ghost_d"] }),
      spy,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(TENANT);
  });

  it("calls it once even when every role is declared and nothing is reported", async () => {
    const spy = vi.fn(() => Promise.resolve(new Set(["a", "b", "c"])));
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "a", secondaryRoles: ["b", "c"] }),
      spy,
    );
    expect(ws).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("asks about the grant's tenant and not the roles", async () => {
    const other = "22222222-2222-2222-2222-222222222222";
    const spy = vi.fn(() => Promise.resolve(null));
    await checkMembershipRoles(grant({ tenantId: other }), spy);
    expect(spy.mock.calls).toEqual([[other]]);
  });
});

describe("formatMembershipRoleWarnings", () => {
  it("renders the empty list as the empty string", () => {
    expect(formatMembershipRoleWarnings([])).toBe("");
  });

  it("renders one line per warning, each naming its verdict", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "ghost_primary", secondaryRoles: ["ghost_secondary"] }),
      directoryOf("erp_admin"),
    );
    const lines = formatMembershipRoleWarnings(ws).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[membership] not_declared:");
    expect(lines[0]).toContain("ghost_primary");
    expect(lines[1]).toContain("ghost_secondary");
  });

  it("carries every warning's detail verbatim", async () => {
    const ws = await checkMembershipRoles(grant({ primaryRole: "ghost" }), directoryOf("a", "b"));
    const out = formatMembershipRoleWarnings(ws);
    for (const w of ws) expect(out).toContain(w.detail);
  });

  it("never offers the declared names for a secondary-only report", async () => {
    const ws = await checkMembershipRoles(
      grant({ secondaryRoles: ["ghost"] }),
      directoryOf("erp_admin", "erp_viewer"),
    );
    const out = formatMembershipRoleWarnings(ws);
    expect(out).not.toContain("the roles a session can carry");
  });
});

describe("the verdict and its declared list travel together", () => {
  /**
   * The pairing the `RoleCatalog` discriminant makes structural, asserted over every directory shape
   * and both positions: a `not_declared` warning always carries the array it was compared against,
   * and an `unresolved` one never carries a list at all. The hazard is a `?? []` default reached
   * when the two are held as separate nullables — it would report *this manifest declares no role*,
   * a claim, wherever the catalog was in fact unread (ADR-0331), and the empty-catalog case is the
   * one where that substitution is invisible because `[]` is also a legitimate answer.
   */
  it("pairs not_declared with an array and unresolved with null, for every directory", async () => {
    const directories: readonly MembershipRoleDirectory[] = [
      directoryOf(),
      directoryOf("erp_admin"),
      UNRESOLVED,
      () => {
        throw new Error("42501: permission denied");
      },
      () => Promise.reject(new Error("ECONNREFUSED")),
    ];
    const pairs = new Set<string>();
    for (const directory of directories) {
      const ws = await checkMembershipRoles(
        grant({ primaryRole: "ghost_primary", secondaryRoles: ["erp_admin", "ghost_secondary"] }),
        directory,
      );
      expect(ws.length).toBeGreaterThan(0);
      for (const w of ws) {
        pairs.add(`${w.verdict}:${w.declaredRoles === null ? "null" : "array"}`);
      }
    }
    expect([...pairs].sort()).toEqual(["not_declared:array", "unresolved:null"]);
  });

  it("gives an empty catalog an empty array and not null, which is the claim", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "ghost", secondaryRoles: ["also_ghost"] }),
      directoryOf(),
    );
    expect(ws).toHaveLength(2);
    for (const w of ws) {
      expect(w.verdict).toBe("not_declared");
      expect(w.declaredRoles).toEqual([]);
    }
  });

  it("offers no role names in either position when the catalog is empty", async () => {
    const ws = await checkMembershipRoles(
      grant({ primaryRole: "ghost", secondaryRoles: ["also_ghost"] }),
      directoryOf(),
    );
    for (const w of ws) expect(w.detail).not.toContain("the roles a session can carry");
  });
});

describe("the verdict vocabulary is closed", () => {
  it("produces no verdict outside MEMBERSHIP_ROLE_VERDICTS", async () => {
    const cases: readonly MembershipRoleDirectory[] = [
      directoryOf(),
      directoryOf("erp_admin"),
      UNRESOLVED,
      () => {
        throw new Error("boom");
      },
    ];
    const seen = new Set<MembershipRoleVerdict>();
    for (const directory of cases) {
      const ws = await checkMembershipRoles(
        grant({ primaryRole: "ghost", secondaryRoles: ["erp_admin"] }),
        directory,
      );
      for (const w of ws) seen.add(w.verdict);
    }
    for (const verdict of seen) expect(MEMBERSHIP_ROLE_VERDICTS).toContain(verdict);
    // Both warning verdicts are genuinely reachable from the four directories above, so the
    // assertion is not vacuous.
    expect([...seen].sort()).toEqual(["not_declared", "unresolved"]);
  });
});
