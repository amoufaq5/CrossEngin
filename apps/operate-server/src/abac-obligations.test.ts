import { formatAbacObligation, type AbacObligation } from "@crossengin/auth";
import type { Manifest } from "@crossengin/kernel";
import { describe, expect, it } from "vitest";

import {
  ABAC_OBLIGATION_REFUSALS,
  AbacObligationsUnevaluable,
  OBLIGATION_DETAIL_LIMIT,
  checkAbacObligations,
  formatAbacObligationCheck,
  type AbacObligationCheck,
} from "./abac-obligations.js";
import { ABAC_POLICY_FLAG } from "./abac-policy.js";
import { BUILTIN_PACK_NAMES, loadBuiltinPack } from "./manifest-source.js";

function manifest(parts: Partial<Manifest> = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: { name: "Fixture", slug: "fixture/pack", version: "1.0.0" },
    ...parts,
  };
}

/** A resolved manifest declaring exactly one `abac`-qualified grant. */
function withOneObligation(): Manifest {
  return manifest({
    permissions: {
      Patient: { read: { roles: ["clinician"], abac: "same_facility" } },
    },
  });
}

/** Two obligations with distinct keys, so a partial evaluator can cover one and not the other. */
function withTwoObligations(): Manifest {
  return manifest({
    permissions: {
      Patient: { read: { roles: ["clinician"], abac: "same_facility" } },
      Citizen: { update: { roles: ["gov_admin"], abac: "own_jurisdiction" } },
    },
  });
}

/** `n` distinct synthetic obligations, so a truncated render is checkable per member. */
function synthetic(n: number): readonly AbacObligation[] {
  return Array.from({ length: n }, (_, i) => ({
    entity: `E${(i + 1).toString()}`,
    operation: "read" as const,
    field: null,
    policyKey: `p${(i + 1).toString()}`,
  }));
}

function check(parts: Partial<AbacObligationCheck> = {}): AbacObligationCheck {
  return {
    obligations: [],
    evaluatorDeclared: false,
    unanswerable: [],
    recordUnavailable: [],
    createBlocked: [],
    refusal: null,
    ...parts,
  };
}

describe("ABAC_OBLIGATION_REFUSALS", () => {
  it("names all three refusals", () => {
    expect(ABAC_OBLIGATION_REFUSALS).toEqual([
      "obligation_unevaluable",
      "policy_undeclared",
      "record_unavailable",
    ]);
  });

  it("has no escape-hatch member, because serving an unevaluated obligation is not a state to opt into", () => {
    expect(ABAC_OBLIGATION_REFUSALS).toHaveLength(3);
    expect(ABAC_OBLIGATION_REFUSALS.some((r) => /allow|skip|ignore|unchecked/.test(r))).toBe(false);
  });
});

describe("OBLIGATION_DETAIL_LIMIT", () => {
  it("is 8", () => {
    expect(OBLIGATION_DETAIL_LIMIT).toBe(8);
  });
});

describe("checkAbacObligations", () => {
  it("refuses when obligations are declared and no evaluator is", () => {
    const result = checkAbacObligations({
      manifest: withOneObligation(),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toHaveLength(1);
    expect(result.evaluatorDeclared).toBe(false);
    expect(result.refusal).toBe("obligation_unevaluable");
  });

  it("does not refuse when obligations are declared and an evaluator is", () => {
    const result = checkAbacObligations({
      manifest: withOneObligation(),
      answerableKeys: new Set(["same_facility"]),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toHaveLength(1);
    expect(result.evaluatorDeclared).toBe(true);
    expect(result.refusal).toBeNull();
  });

  it("does not refuse when no obligation is declared and no evaluator is", () => {
    const result = checkAbacObligations({
      manifest: manifest({ permissions: { Patient: { read: { roles: ["clinician"] } } } }),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toEqual([]);
    expect(result.refusal).toBeNull();
  });

  it("does not refuse when no obligation is declared and an evaluator is", () => {
    const result = checkAbacObligations({
      manifest: manifest({ permissions: {} }),
      answerableKeys: new Set(["same_facility"]),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toEqual([]);
    expect(result.refusal).toBeNull();
  });

  it("treats an absent `permissions` key as no obligations rather than throwing", () => {
    const m = manifest();
    expect(m.permissions).toBeUndefined();
    const result = checkAbacObligations({
      manifest: m,
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toEqual([]);
    expect(result.refusal).toBeNull();
  });

  it("finds an obligation on a plain operation grant", () => {
    const result = checkAbacObligations({
      manifest: manifest({
        permissions: { Invoice: { update: { roles: ["ap_clerk"], abac: "own_entity" } } },
      }),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toEqual([
      { entity: "Invoice", operation: "update", field: null, policyKey: "own_entity" },
    ]);
  });

  it("finds an obligation on a transition grant", () => {
    const result = checkAbacObligations({
      manifest: manifest({
        permissions: {
          SalesOrder: { transitions: { fulfil: { roles: ["picker"], abac: "same_store" } } },
        },
      }),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toHaveLength(1);
    const [only] = result.obligations;
    expect(only?.entity).toBe("SalesOrder");
    expect(only?.operation).toEqual({ kind: "transition", name: "fulfil" });
    expect(only?.field).toBeNull();
    expect(only?.policyKey).toBe("same_store");
  });

  it("finds an obligation on a field read grant", () => {
    const result = checkAbacObligations({
      manifest: manifest({
        permissions: {
          Patient: { fields: { mrn: { read: { roles: ["clinician"], abac: "treating" } } } },
        },
      }),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toEqual([
      { entity: "Patient", operation: "read", field: "mrn", policyKey: "treating" },
    ]);
  });

  it("finds an obligation on a field update grant", () => {
    const result = checkAbacObligations({
      manifest: manifest({
        permissions: {
          Citizen: {
            fields: { national_id: { update: { roles: ["gov_admin"], abac: "own_jurisdiction" } } },
          },
        },
      }),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toEqual([
      {
        entity: "Citizen",
        operation: "update",
        field: "national_id",
        policyKey: "own_jurisdiction",
      },
    ]);
  });

  it("ignores a grant carrying roles and no `abac` key", () => {
    const result = checkAbacObligations({
      manifest: manifest({
        permissions: {
          Patient: {
            read: { roles: ["clinician"] },
            transitions: { close: { roles: ["clinician"] } },
            fields: { mrn: { read: { roles: ["clinician"] }, update: { roles: ["clinician"] } } },
          },
        },
      }),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toEqual([]);
  });

  it("finds every obligation when one entity qualifies several grants", () => {
    const result = checkAbacObligations({
      manifest: manifest({
        permissions: {
          Patient: {
            read: { roles: ["clinician"], abac: "a" },
            update: { roles: ["clinician"], abac: "b" },
            transitions: { close: { roles: ["clinician"], abac: "c" } },
            fields: {
              mrn: {
                read: { roles: ["clinician"], abac: "d" },
                update: { roles: ["clinician"], abac: "e" },
              },
            },
          },
        },
      }),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations.map((o) => o.policyKey).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("checkAbacObligations against an incomplete evaluator", () => {
  it("refuses `policy_undeclared` and names only the obligation whose key is missing", () => {
    const result = checkAbacObligations({
      manifest: withTwoObligations(),
      answerableKeys: new Set(["same_facility"]),
      recordBearingKeys: new Set(),
    });
    expect(result.evaluatorDeclared).toBe(true);
    expect(result.refusal).toBe("policy_undeclared");
    expect(result.obligations).toHaveLength(2);
    expect(result.unanswerable.map((o) => o.policyKey)).toEqual(["own_jurisdiction"]);
  });

  it("does not refuse when every declared key is covered", () => {
    const result = checkAbacObligations({
      manifest: withTwoObligations(),
      answerableKeys: new Set(["same_facility", "own_jurisdiction"]),
      recordBearingKeys: new Set(),
    });
    expect(result.refusal).toBeNull();
    expect(result.unanswerable).toEqual([]);
  });

  it("ignores a declared key no obligation names, because a policy may precede its grant", () => {
    const result = checkAbacObligations({
      manifest: withOneObligation(),
      answerableKeys: new Set(["same_facility", "unused"]),
      recordBearingKeys: new Set(),
    });
    expect(result.refusal).toBeNull();
    expect(result.unanswerable).toEqual([]);
  });

  /**
   * The precedence. An empty set is the no-evaluator case, which `obligation_unevaluable` states
   * once with the remedy that supersedes every per-key one — so it must not be reported as a
   * per-key gap, and `unanswerable` must stay empty rather than naming all of them beside it.
   */
  it("reports `obligation_unevaluable` rather than `policy_undeclared` on an empty set", () => {
    const result = checkAbacObligations({
      manifest: withTwoObligations(),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.evaluatorDeclared).toBe(false);
    expect(result.refusal).toBe("obligation_unevaluable");
    expect(result.unanswerable).toEqual([]);
  });

  it("matches a policy key exactly, so a near-miss is unanswerable rather than covered", () => {
    const result = checkAbacObligations({
      manifest: withOneObligation(),
      answerableKeys: new Set(["Same_Facility"]),
      recordBearingKeys: new Set(),
    });
    expect(result.refusal).toBe("policy_undeclared");
    expect(result.unanswerable).toHaveLength(1);
  });

  it("neither refuses nor reports an unanswerable key when no obligation is declared", () => {
    const result = checkAbacObligations({
      manifest: manifest({ permissions: { Patient: { read: { roles: ["clinician"] } } } }),
      answerableKeys: new Set(["same_facility"]),
      recordBearingKeys: new Set(),
    });
    expect(result.refusal).toBeNull();
    expect(result.unanswerable).toEqual([]);
  });
});

describe("the policy_undeclared refusal text", () => {
  function undeclared(): AbacObligationCheck {
    return checkAbacObligations({
      manifest: withTwoObligations(),
      answerableKeys: new Set(["same_facility"]),
      recordBearingKeys: new Set(),
    });
  }

  it("names the unanswerable key and the grant carrying it, and not the covered one", () => {
    const err = new AbacObligationsUnevaluable(undeclared());
    expect(err.refusal).toBe("policy_undeclared");
    expect(err.message).toContain("'own_jurisdiction'");
    expect(err.message).toContain(
      formatAbacObligation(undeclared().unanswerable[0] as AbacObligation),
    );
    expect(err.message).not.toContain("same_facility");
  });

  it("counts the unanswerable grants, not every declared obligation", () => {
    const err = new AbacObligationsUnevaluable(undeclared());
    expect(err.message).toContain("1 abac-qualified grant(s)");
  });

  it("names both remedies, and the flag for the one a flag can do", () => {
    const err = new AbacObligationsUnevaluable(undeclared());
    expect(err.message).toContain(ABAC_POLICY_FLAG);
    expect(err.message).toContain("remove the `abac` key");
    expect(err.message).toContain("the role grant beside it is enforced");
  });

  it("carries the unanswerable subset structurally, so a boot catch need not parse the message", () => {
    const c = undeclared();
    const err = new AbacObligationsUnevaluable(c);
    expect(err.unanswerable).toEqual(c.unanswerable);
    expect(err.obligations).toEqual(c.obligations);
  });

  it("is the same text the boot line carries, so the two cannot disagree", () => {
    const c = undeclared();
    expect(formatAbacObligationCheck(c)).toContain(new AbacObligationsUnevaluable(c).message);
  });

  it("is a different text from the no-evaluator refusal", () => {
    const none = checkAbacObligations({
      manifest: withTwoObligations(),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(new AbacObligationsUnevaluable(none).message).not.toBe(
      new AbacObligationsUnevaluable(undeclared()).message,
    );
  });
});

describe("formatAbacObligationCheck", () => {
  it("says none were declared affirmatively, so a clean survey is not inferred from silence", () => {
    expect(formatAbacObligationCheck(check())).toBe(
      "abac obligations: none declared, so no grant depends on an ABAC evaluator",
    );
  });

  it("says the same affirmative line whether or not an evaluator is declared", () => {
    expect(formatAbacObligationCheck(check({ evaluatorDeclared: true }))).toBe(
      formatAbacObligationCheck(check({ evaluatorDeclared: false })),
    );
  });

  it("names the count, the evaluator and the obligations when they are evaluable", () => {
    const obligations = synthetic(2);
    const line = formatAbacObligationCheck(
      check({ obligations, evaluatorDeclared: true, refusal: null }),
    );
    expect(line).toContain("2 declared");
    expect(line).toContain("an evaluator is declared");
    expect(line).toContain(formatAbacObligation(obligations[0] as AbacObligation));
    expect(line).toContain(formatAbacObligation(obligations[1] as AbacObligation));
  });

  it("carries the refusal's own message, so the boot line and the thrown error cannot disagree", () => {
    const c = check({
      obligations: synthetic(3),
      refusal: "obligation_unevaluable",
    });
    expect(formatAbacObligationCheck(c)).toContain(new AbacObligationsUnevaluable(c).message);
  });

  it("does not truncate at exactly OBLIGATION_DETAIL_LIMIT", () => {
    const obligations = synthetic(OBLIGATION_DETAIL_LIMIT);
    const line = formatAbacObligationCheck(check({ obligations, evaluatorDeclared: true }));
    expect(line).not.toContain("more)");
    for (const o of obligations) {
      expect(line).toContain(formatAbacObligation(o));
    }
  });

  it("truncates one past the limit and names how many it withheld", () => {
    const obligations = synthetic(OBLIGATION_DETAIL_LIMIT + 1);
    const line = formatAbacObligationCheck(check({ obligations, evaluatorDeclared: true }));
    expect(line).toContain("(+1 more)");
    expect(line).toContain(`${(OBLIGATION_DETAIL_LIMIT + 1).toString()} declared`);
    expect(line).not.toContain(
      formatAbacObligation(obligations[OBLIGATION_DETAIL_LIMIT] as AbacObligation),
    );
  });

  it("reports the full count even when the list is cut", () => {
    const line = formatAbacObligationCheck(
      check({ obligations: synthetic(30), evaluatorDeclared: true }),
    );
    expect(line).toContain("30 declared");
    expect(line).toContain(`(+${(30 - OBLIGATION_DETAIL_LIMIT).toString()} more)`);
  });
});

describe("AbacObligationsUnevaluable", () => {
  it("names the count", () => {
    const err = new AbacObligationsUnevaluable(
      check({ obligations: synthetic(4), refusal: "obligation_unevaluable" }),
    );
    expect(err.message).toContain("4 abac-qualified grant(s)");
  });

  it("names the first OBLIGATION_DETAIL_LIMIT obligations and withholds the rest", () => {
    const obligations = synthetic(OBLIGATION_DETAIL_LIMIT + 2);
    const err = new AbacObligationsUnevaluable(
      check({ obligations, refusal: "obligation_unevaluable" }),
    );
    for (const o of obligations.slice(0, OBLIGATION_DETAIL_LIMIT)) {
      expect(err.message).toContain(formatAbacObligation(o));
    }
    expect(err.message).toContain("(+2 more)");
  });

  it("names both remedies and invents no flag for the second", () => {
    const err = new AbacObligationsUnevaluable(
      check({ obligations: synthetic(1), refusal: "obligation_unevaluable" }),
    );
    expect(err.message).toContain("Remove the `abac` key");
    expect(err.message).toContain("the role grant beside it is enforced");
    expect(err.message).toContain("ABAC evaluator");
    expect(err.message).not.toMatch(/--[a-z]/);
  });

  it("carries the obligations array and the refusal", () => {
    const obligations = synthetic(2);
    const err = new AbacObligationsUnevaluable(
      check({ obligations, refusal: "obligation_unevaluable" }),
    );
    expect(err.obligations).toEqual(obligations);
    expect(err.refusal).toBe("obligation_unevaluable");
  });

  it("is an Error with its own name, so a boot catch can report it structurally", () => {
    const err = new AbacObligationsUnevaluable(check({ obligations: synthetic(1) }));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AbacObligationsUnevaluable");
    expect(err.refusal).toBe("obligation_unevaluable");
  });
});

describe("the builtin pack census", () => {
  /**
   * The point of this lane. A non-zero count is **not automatically a bug**: it means the
   * deployment now needs an ABAC evaluator, and this test is the forcing function for that
   * conversation — whoever adds the grant meets the refusal here, with its reason, instead of
   * a silent total denial in production.
   *
   * Zero today is also what makes the boot refusal vacuous, so this change breaks no
   * deployment that worked.
   */
  it("declares zero abac obligations across all seven resolved builtin packs today", async () => {
    const counts: Record<string, number> = {};
    for (const name of BUILTIN_PACK_NAMES) {
      const resolved = await loadBuiltinPack(name);
      counts[name] = checkAbacObligations({
        manifest: resolved,
        answerableKeys: new Set(),
        recordBearingKeys: new Set(),
      }).obligations.length;
    }
    expect(Object.keys(counts)).toHaveLength(7);
    expect(counts).toEqual({
      "erp-core": 0,
      "erp-retail": 0,
      "erp-healthcare": 0,
      "erp-grocery": 0,
      "erp-government": 0,
      "erp-education": 0,
      "erp-construction": 0,
    });
  });

  it("surveys a non-empty permission map on every pack, so the zero is a measurement and not an empty walk", async () => {
    for (const name of BUILTIN_PACK_NAMES) {
      const resolved = await loadBuiltinPack(name);
      expect(Object.keys(resolved.permissions ?? {}).length).toBeGreaterThan(0);
    }
  });

  /**
   * The vacuity control, the way `packages/testing/src/strategy/*` rules carry one: the
   * census above would read zero just as happily if the survey were walking nothing. This
   * puts an `abac` grant through the same function and demands it comes back.
   */
  it("finds an abac grant through the same code path, so a zero census cannot be a wrong path", () => {
    const result = checkAbacObligations({
      manifest: withOneObligation(),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toEqual([
      { entity: "Patient", operation: "read", field: null, policyKey: "same_facility" },
    ]);
    expect(result.refusal).toBe("obligation_unevaluable");
  });

  it("refuses a resolved pack the moment one abac grant is added to it", async () => {
    const core = await loadBuiltinPack("erp-core");
    const entity = Object.keys(core.permissions ?? {})[0];
    expect(entity).toBeDefined();
    const qualified: Manifest = {
      ...core,
      permissions: {
        ...(core.permissions ?? {}),
        [entity as string]: {
          ...(core.permissions ?? {})[entity as string],
          read: { roles: ["platform-admin"], abac: "same_region" },
        },
      },
    };
    const result = checkAbacObligations({
      manifest: qualified,
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.obligations).toHaveLength(1);
    expect(result.refusal).toBe("obligation_unevaluable");
  });
});

describe("checkAbacObligations against a record-bearing policy", () => {
  /** One obligation at `position`, keyed `rec` so a caller can declare it record-bearing. */
  function at(position: "create" | "list" | "read" | "update" | "delete"): Manifest {
    return manifest({
      permissions: { Chart: { [position]: { roles: ["clinician"], abac: "rec" } } },
    });
  }

  function fieldAt(op: "read" | "update"): Manifest {
    return manifest({
      permissions: {
        Chart: { fields: { note: { [op]: { roles: ["clinician"], abac: "rec" } } } },
      },
    });
  }

  const declared = (m: Manifest): AbacObligationCheck =>
    checkAbacObligations({
      manifest: m,
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(["rec"]),
    });

  it("refuses at entity create, list and field read, where no call site can ever supply a record", () => {
    for (const m of [at("create"), at("list"), fieldAt("read")]) {
      const result = declared(m);
      expect(result.refusal).toBe("record_unavailable");
      expect(result.recordUnavailable).toHaveLength(1);
      expect(result.createBlocked).toEqual([]);
    }
  });

  it("admits at entity read, update, delete and a transition, where the handler loads the record", () => {
    const transition = manifest({
      permissions: {
        Chart: { transitions: { admit: { roles: ["clinician"], abac: "rec" } } },
      },
    });
    for (const m of [at("read"), at("update"), at("delete"), transition]) {
      const result = declared(m);
      expect(result.refusal).toBeNull();
      expect(result.recordUnavailable).toEqual([]);
      expect(result.createBlocked).toEqual([]);
    }
  });

  it("reports a field update obligation without refusing, because a create genuinely has no record", () => {
    // The one `sometimes` position. Refusing would reject a coherent declaration — "you may only
    // set this field on a record that is yours" — for the one path that cannot satisfy it.
    const result = declared(fieldAt("update"));
    expect(result.refusal).toBeNull();
    expect(result.createBlocked).toEqual([
      { entity: "Chart", operation: "update", field: "note", policyKey: "rec" },
    ]);
    expect(result.recordUnavailable).toEqual([]);
  });

  it("says so on the boot line, naming the field and why it cannot be set at create", () => {
    const line = formatAbacObligationCheck(declared(fieldAt("update")));
    expect(line).toContain("not settable at create");
    expect(line).toContain("Chart.update -> note");
    expect(line).toContain("the create path cannot");
  });

  it("classifies nothing as record-bearing when the key is not declared as one", () => {
    // The same manifest that refuses above is served when the policy compares against the
    // principal's own attributes: the position is only wrong for a policy that needs a record.
    const result = checkAbacObligations({
      manifest: at("create"),
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(),
    });
    expect(result.refusal).toBeNull();
    expect(result.recordUnavailable).toEqual([]);
  });

  it("reports the undeclared-key refusal first, because its remedy is the true one", () => {
    // A key no evaluator answers is reported as that, even at a position a record could never
    // reach: telling an operator to move an obligation whose policy does not exist would send
    // them to fix the second problem first.
    const result = checkAbacObligations({
      manifest: at("create"),
      answerableKeys: new Set(["other"]),
      recordBearingKeys: new Set(["rec"]),
    });
    expect(result.refusal).toBe("policy_undeclared");
  });

  it("cannot classify anything record-bearing with no evaluator, so the no-evaluator refusal stands", () => {
    const result = checkAbacObligations({
      manifest: at("create"),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
    });
    expect(result.refusal).toBe("obligation_unevaluable");
  });

  it("names the position's reason and all three remedies in the refusal", () => {
    const result = declared(at("create"));
    const message = formatAbacObligationCheck(result);
    expect(message).toContain("Chart.create requires abac policy 'rec'");
    expect(message).toContain("does not exist until the write commits");
    expect(message).toContain(ABAC_POLICY_FLAG);
    expect(message).toContain("the role grant beside it is enforced and stays");
  });

  it("carries the subset on the thrown error, so a caller need not re-derive it", () => {
    const result = declared(at("list"));
    const error = new AbacObligationsUnevaluable(result);
    expect(error.refusal).toBe("record_unavailable");
    expect(error.recordUnavailable).toHaveLength(1);
    expect(error.message).toContain("a filter and not an authorization decision");
  });

  it("truncates the reasoned render at the detail limit", () => {
    const perms: Record<string, { create: { roles: string[]; abac: string } }> = {};
    for (let i = 0; i < OBLIGATION_DETAIL_LIMIT + 3; i += 1) {
      perms[`E${i.toString()}`] = { create: { roles: ["r"], abac: "rec" } };
    }
    const result = declared(manifest({ permissions: perms }));
    expect(result.recordUnavailable).toHaveLength(OBLIGATION_DETAIL_LIMIT + 3);
    expect(formatAbacObligationCheck(result)).toContain("(+3 more)");
  });

  it("declares none of the seven builtin packs record-bearing, because none declares an obligation", async () => {
    // The measurement that makes this refusal vacuous today and a forcing function later.
    for (const name of BUILTIN_PACK_NAMES) {
      const pack = await loadBuiltinPack(name);
      const result = checkAbacObligations({
        manifest: pack,
        answerableKeys: new Set(["rec"]),
        recordBearingKeys: new Set(["rec"]),
      });
      expect(result.recordUnavailable, name).toEqual([]);
      expect(result.createBlocked, name).toEqual([]);
    }
  });
});
