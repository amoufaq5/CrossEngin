import {
  formatAbacObligation,
  ABAC_DENIAL_EFFECT,
  ABAC_GRANT_POSITIONS,
  ABAC_RECORD_AVAILABILITY,
  type AbacGrantPosition,
  type AbacObligation,
} from "@crossengin/auth";
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
import {
  ALLOW_CURSOR_DISCLOSURE_FLAG,
  CURSOR_ENCRYPTION_SECRET_VAR,
  CURSOR_SEALING_MODES,
  type CursorSealingMode,
} from "./cursor-encryption.js";
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

/**
 * A synthetic result. `cursorSealing` defaults to `"sealed"` throughout this file, and every
 * `checkAbacObligations` input below says so explicitly for the same reason: a fixture about
 * something else must not trip the cursor refusal, which fires only when rows are withheld and
 * nothing seals the cursor. The cursor refusal's own describe block passes each mode on purpose.
 */
function check(parts: Partial<AbacObligationCheck> = {}): AbacObligationCheck {
  return {
    obligations: [],
    evaluatorDeclared: false,
    unanswerable: [],
    recordUnavailable: [],
    createBlocked: [],
    rowFiltered: [],
    listSortConflicts: [],
    cursorDisclosing: [],
    cursorSealing: "sealed",
    refusal: null,
    ...parts,
  };
}

describe("ABAC_OBLIGATION_REFUSALS", () => {
  it("names all five refusals, in the order they are reported", () => {
    expect(ABAC_OBLIGATION_REFUSALS).toEqual([
      "obligation_unevaluable",
      "policy_undeclared",
      "record_unavailable",
      "list_sort_addresses_withheld_field",
      "cursor_discloses_withheld_rows",
    ]);
  });

  it("names every member after the defect and none after a permission to serve it", () => {
    expect(ABAC_OBLIGATION_REFUSALS).toHaveLength(5);
    expect(ABAC_OBLIGATION_REFUSALS.some((r) => /allow|skip|ignore|unchecked/.test(r))).toBe(false);
  });

  /**
   * The escape-hatch line, asserted rather than left to the doc comment. Exactly one refusal
   * names an `--allow*` flag, and it is the one whose state is degraded-but-coherent: the policy
   * is evaluated and the rows are withheld, and only their positions escape. Serving an
   * obligation the deployment cannot evaluate is not such a state, so those four must offer no
   * opt-out at all — which is checkable from the text, since a flag that is not named is a flag
   * an operator cannot reach.
   */
  it("offers an --allow opt-out in exactly one refusal's text, and it is the cursor one", () => {
    const naming = ABAC_OBLIGATION_REFUSALS.filter((refusal) =>
      /--allow/.test(new AbacObligationsUnevaluable(check({ refusal })).message),
    );
    expect(naming).toEqual(["cursor_discloses_withheld_rows"]);
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
    });
    expect(result.obligations).toEqual([]);
    expect(result.refusal).toBeNull();
  });

  it("does not refuse when no obligation is declared and an evaluator is", () => {
    const result = checkAbacObligations({
      manifest: manifest({ permissions: {} }),
      answerableKeys: new Set(["same_facility"]),
      recordBearingKeys: new Set(),
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
    });
    expect(result.refusal).toBeNull();
    expect(result.unanswerable).toEqual([]);
  });

  it("ignores a declared key no obligation names, because a policy may precede its grant", () => {
    const result = checkAbacObligations({
      manifest: withOneObligation(),
      answerableKeys: new Set(["same_facility", "unused"]),
      recordBearingKeys: new Set(),
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
    });
    expect(result.refusal).toBe("policy_undeclared");
    expect(result.unanswerable).toHaveLength(1);
  });

  it("neither refuses nor reports an unanswerable key when no obligation is declared", () => {
    const result = checkAbacObligations({
      manifest: manifest({ permissions: { Patient: { read: { roles: ["clinician"] } } } }),
      answerableKeys: new Set(["same_facility"]),
      recordBearingKeys: new Set(),
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
        cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
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

  const transitionAt = (): Manifest =>
    manifest({
      permissions: {
        Chart: { transitions: { admit: { roles: ["clinician"], abac: "rec" } } },
      },
    });

  /**
   * One fixture per grant position, **total** over `AbacGrantPosition` — so a ninth position is a
   * compile error here rather than a position silently untested by the two maps' pins below.
   *
   * None of these manifests declares an entity or a view, so `listConfigForEntity` sees no list
   * view and the default sort is empty. That is deliberate: it isolates `rowFiltered` from the
   * sort refusal, which gets its own fixtures.
   */
  const POSITION_MANIFEST: Readonly<Record<AbacGrantPosition, Manifest>> = {
    entity_create: at("create"),
    entity_read: at("read"),
    entity_update: at("update"),
    entity_delete: at("delete"),
    entity_list: at("list"),
    entity_transition: transitionAt(),
    field_read: fieldAt("read"),
    field_update: fieldAt("update"),
  };

  const declared = (m: Manifest): AbacObligationCheck =>
    checkAbacObligations({
      manifest: m,
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(["rec"]),
      cursorSealing: "sealed",
    });

  it("refuses at entity create alone, where no call site can ever supply a record", () => {
    // One position, not three, and the set is asserted by walking every position through the real
    // function rather than by naming the one that refuses — so a future flip in either direction
    // fails here with the position named.
    //
    // Field `read` left when ADR-0343 gave response redaction the operation's declared record
    // shape, so it locates the records a response carries and computes the field set per record.
    // Entity `list` left now, and the reason is the mirror of what kept it: the list handler loads
    // the page before it returns, so every row was in hand all along. What separates `list` from
    // `field_read` is not availability but `ABAC_DENIAL_EFFECT` — one withholds columns within a
    // row, the other withholds whole rows — and reading that as an availability difference is what
    // kept both refused for longer than the facts warranted.
    const refusing = ABAC_GRANT_POSITIONS.filter(
      (p) => declared(POSITION_MANIFEST[p]).refusal === "record_unavailable",
    );
    expect(refusing).toEqual(["entity_create"]);
  });

  it("agrees with ABAC_RECORD_AVAILABILITY about which positions can never be asked", () => {
    // The pin on the contract side: the refusal is the map read through `checkAbacObligations`, so
    // the two must name the same single position or one of them is a second copy of the other.
    expect(ABAC_GRANT_POSITIONS.filter((p) => ABAC_RECORD_AVAILABILITY[p] === "never")).toEqual([
      "entity_create",
    ]);
  });

  it("admits at entity read, update, delete, list, a transition and a field read", () => {
    for (const m of [
      at("read"),
      at("update"),
      at("delete"),
      at("list"),
      transitionAt(),
      fieldAt("read"),
    ]) {
      const result = declared(m);
      expect(result.refusal).toBeNull();
      expect(result.recordUnavailable).toEqual([]);
      expect(result.createBlocked).toEqual([]);
    }
  });

  it("reports a record-bearing entity list obligation as rowFiltered without refusing", () => {
    const result = declared(at("list"));
    expect(result.refusal).toBeNull();
    expect(result.recordUnavailable).toEqual([]);
    expect(result.rowFiltered).toEqual([
      { entity: "Chart", operation: "list", field: null, policyKey: "rec" },
    ]);
  });

  it("derives rowFiltered through ABAC_DENIAL_EFFECT, not by naming a position", () => {
    // The assertion the brief asks for: drive the expectation off the map, so the test fails if
    // the map and the filter ever disagree about which grants filter rows. Both directions, and a
    // vacuity guard, because an empty `filters_rows` set would make the loop pass having asked
    // nothing.
    const filtering = ABAC_GRANT_POSITIONS.filter((p) => ABAC_DENIAL_EFFECT[p] === "filters_rows");
    expect(filtering.length).toBeGreaterThan(0);
    for (const position of filtering) {
      expect(declared(POSITION_MANIFEST[position]).rowFiltered, position).toHaveLength(1);
    }
    for (const position of ABAC_GRANT_POSITIONS.filter(
      (p) => ABAC_DENIAL_EFFECT[p] !== "filters_rows",
    )) {
      expect(declared(POSITION_MANIFEST[position]).rowFiltered, position).toEqual([]);
    }
  });

  it("reports nothing as rowFiltered when the key is not record-bearing", () => {
    const result = checkAbacObligations({
      manifest: at("list"),
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(),
      cursorSealing: "sealed",
    });
    expect(result.rowFiltered).toEqual([]);
    expect(result.refusal).toBeNull();
  });

  it("names all three consequences of row filtering on the boot line", () => {
    // None of them is guessable from the declaration, and each is something a client integration
    // gets wrong silently, so each is said rather than implied.
    const line = formatAbacObligationCheck(declared(at("list")));
    expect(line).toContain("filter rows out of the page");
    expect(line).toContain("shorter than `limit`");
    expect(line).toContain("`nextCursor === null`");
    expect(line).toContain("count route");
    expect(line).toContain("`?sort`");
    expect(line).toContain("may not address rows by a field they may not read");
  });

  it("appends the denial effect's own description rather than restating it", () => {
    const line = formatAbacObligationCheck(declared(at("list")));
    expect(line).toContain("Chart.list requires abac policy 'rec'");
    expect(line).toContain("the denied rows are dropped from the page and no refusal is reported");
  });

  it("says both notes when a manifest carries a filtered list and an obligated field update", () => {
    const both = manifest({
      permissions: {
        Chart: {
          list: { roles: ["clinician"], abac: "rec" },
          fields: { note: { update: { roles: ["clinician"], abac: "rec" } } },
        },
      },
    });
    const result = declared(both);
    expect(result.refusal).toBeNull();
    const line = formatAbacObligationCheck(result);
    expect(line).toContain("not settable at create");
    expect(line).toContain("filter rows out of the page");
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
      cursorSealing: "sealed",
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
      cursorSealing: "sealed",
    });
    expect(result.refusal).toBe("policy_undeclared");
  });

  it("cannot classify anything record-bearing with no evaluator, so the no-evaluator refusal stands", () => {
    const result = checkAbacObligations({
      manifest: at("create"),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
      cursorSealing: "sealed",
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
    const result = declared(at("create"));
    const error = new AbacObligationsUnevaluable(result);
    expect(error.refusal).toBe("record_unavailable");
    expect(error.recordUnavailable).toHaveLength(1);
    expect(error.message).toContain("does not exist until the write commits");
  });

  it("names entity list and field read among the positions an obligation can be moved to", () => {
    // The remedy list grew as the refusal shrank. A remedy that omitted the two positions that
    // just became available would send an operator to the three that were always there.
    const message = new AbacObligationsUnevaluable(declared(at("create"))).message;
    expect(message).toContain("`list`");
    expect(message).toContain("per-field `read`");
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
        cursorSealing: "sealed",
      });
      expect(result.recordUnavailable, name).toEqual([]);
      expect(result.createBlocked, name).toEqual([]);
      expect(result.rowFiltered, name).toEqual([]);
      expect(result.listSortConflicts, name).toEqual([]);
    }
  });
});

describe("the list_sort_addresses_withheld_field refusal", () => {
  /**
   * One entity with a classified field and an unclassified one, so a view can sort by either.
   * `note` is `phi`; `label` carries no classification at all.
   */
  const CHART_ENTITY = {
    name: "Chart",
    fields: [
      { name: "note", type: { kind: "text" as const }, classification: "phi" as const },
      { name: "label", type: { kind: "text" as const } },
    ],
  };

  /**
   * A `list` view over `Chart` sorting by `field`.
   *
   * Cast rather than built through `ListViewSchema`, because `@crossengin/views` is not a
   * dependency of this app. `listConfigForEntity` reads a view structurally — `kind`, `entity`,
   * `sort`, `columns`, `pageSize` — so every field that decides the default sort is present here,
   * and the defaults a parse would fill in are ones neither it nor this test reads.
   */
  function chartListView(field: string): Manifest["views"] {
    return {
      chartList: {
        kind: "list",
        entity: "Chart",
        columns: [{ field }],
        sort: [{ field, direction: "asc" }],
        pageSize: 50,
      },
    } as unknown as Manifest["views"];
  }

  function sortManifest(opts: {
    readonly sortField: "note" | "label";
    readonly obligationOn: "list" | "read" | null;
  }): Manifest {
    const grant = { roles: ["clinician"], abac: "rec" };
    return manifest({
      entities: [CHART_ENTITY],
      views: chartListView(opts.sortField),
      permissions: {
        Chart:
          opts.obligationOn === null
            ? { list: { roles: ["clinician"] } }
            : { [opts.obligationOn]: grant },
      },
    });
  }

  const declared = (m: Manifest): AbacObligationCheck =>
    checkAbacObligations({
      manifest: m,
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(["rec"]),
      cursorSealing: "sealed",
    });

  it("refuses when the default sort names a classified field of a row-filtered entity", () => {
    const result = declared(sortManifest({ sortField: "note", obligationOn: "list" }));
    expect(result.refusal).toBe("list_sort_addresses_withheld_field");
    expect(result.listSortConflicts).toEqual([
      { entity: "Chart", field: "note", classification: "phi", policyKey: "rec" },
    ]);
  });

  it("does not refuse when the default sort names an unclassified field", () => {
    const result = declared(sortManifest({ sortField: "label", obligationOn: "list" }));
    expect(result.refusal).toBeNull();
    expect(result.listSortConflicts).toEqual([]);
    // The obligation is still there and still filters rows — only the cursor is clean.
    expect(result.rowFiltered).toHaveLength(1);
  });

  it("does not refuse when the entity has no list obligation", () => {
    // The question is "which of the entities whose rows are filtered sorts by a classified field",
    // and an entity whose `read` grant is obligated withholds no rows from its page at all.
    const result = declared(sortManifest({ sortField: "note", obligationOn: "read" }));
    expect(result.refusal).toBeNull();
    expect(result.rowFiltered).toEqual([]);
    expect(result.listSortConflicts).toEqual([]);
  });

  it("does not refuse when the list obligation's key is not record-bearing", () => {
    const result = checkAbacObligations({
      manifest: sortManifest({ sortField: "note", obligationOn: "list" }),
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(),
      cursorSealing: "sealed",
    });
    expect(result.refusal).toBeNull();
    expect(result.listSortConflicts).toEqual([]);
  });

  it("does not refuse when no evaluator is declared, because the prior refusal's remedy is the true one", () => {
    const result = checkAbacObligations({
      manifest: sortManifest({ sortField: "note", obligationOn: "list" }),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
      cursorSealing: "sealed",
    });
    expect(result.refusal).toBe("obligation_unevaluable");
    expect(result.listSortConflicts).toEqual([]);
  });

  it("does not refuse when the manifest declares no abac grant at all", () => {
    const result = declared(sortManifest({ sortField: "note", obligationOn: null }));
    expect(result.obligations).toEqual([]);
    expect(result.refusal).toBeNull();
    expect(result.listSortConflicts).toEqual([]);
  });

  it("does not refuse when the entity has no list view, so no default sort exists", () => {
    const noView = manifest({
      entities: [CHART_ENTITY],
      permissions: { Chart: { list: { roles: ["clinician"], abac: "rec" } } },
    });
    const result = declared(noView);
    expect(result.rowFiltered).toHaveLength(1);
    expect(result.listSortConflicts).toEqual([]);
    expect(result.refusal).toBeNull();
  });

  it("reports record_unavailable first when a manifest trips both", () => {
    // Ordering: the sort rule is computed from `rowFiltered`, a subset of the record-bearing set,
    // so it must not pre-empt a refusal whose remedy an operator has to apply first.
    const both = manifest({
      entities: [CHART_ENTITY],
      views: chartListView("note"),
      permissions: {
        Chart: {
          create: { roles: ["clinician"], abac: "rec" },
          list: { roles: ["clinician"], abac: "rec" },
        },
      },
    });
    const result = declared(both);
    expect(result.recordUnavailable).toHaveLength(1);
    expect(result.listSortConflicts).toHaveLength(1);
    expect(result.refusal).toBe("record_unavailable");
  });

  it("names the entity, the field and the classification, and never a value", () => {
    const result = declared(sortManifest({ sortField: "note", obligationOn: "list" }));
    const message = formatAbacObligationCheck(result);
    expect(message).toContain("Chart.note (phi)");
    expect(message).toContain("under abac policy 'rec'");
  });

  it("says why there is no per-request fix, and names every remedy", () => {
    const message = new AbacObligationsUnevaluable(
      declared(sortManifest({ sortField: "note", obligationOn: "list" })),
    ).message;
    expect(message).toContain("base64url(JSON.stringify({k: [...sort values], id}))");
    expect(message).toContain("last row of the store's slice");
    expect(message).toContain("the sort came from the manifest and not from the request");
    expect(message).toContain("Change that view's `sort`");
    expect(message).toContain("drop the classification from the field");
    expect(message).toContain("remove the `abac` key");
    expect(message).toContain("the role grant beside it is enforced and stays");
  });

  it("is the same text the boot line carries, so the two cannot disagree", () => {
    const result = declared(sortManifest({ sortField: "note", obligationOn: "list" }));
    expect(formatAbacObligationCheck(result)).toContain(
      new AbacObligationsUnevaluable(result).message,
    );
  });

  it("carries the conflicts on the thrown error, so a boot catch need not parse the message", () => {
    const result = declared(sortManifest({ sortField: "note", obligationOn: "list" }));
    const error = new AbacObligationsUnevaluable(result);
    expect(error.refusal).toBe("list_sort_addresses_withheld_field");
    expect(error.listSortConflicts).toEqual(result.listSortConflicts);
  });

  it("names one conflict per entity+field however many times the sort repeats it", () => {
    // One manifest edit is one finding: reporting it twice would make an operator look for a
    // second place to change.
    const repeated = manifest({
      entities: [CHART_ENTITY],
      views: {
        chartList: {
          kind: "list",
          entity: "Chart",
          columns: [{ field: "note" }],
          sort: [
            { field: "note", direction: "asc" },
            { field: "note", direction: "desc" },
          ],
          pageSize: 50,
        },
      } as unknown as Manifest["views"],
      permissions: { Chart: { list: { roles: ["clinician"], abac: "rec" } } },
    });
    expect(declared(repeated).listSortConflicts).toHaveLength(1);
  });

  it("names a conflict on each classified field a multi-key sort addresses", () => {
    const twoKeys = manifest({
      entities: [
        {
          ...CHART_ENTITY,
          fields: [
            ...CHART_ENTITY.fields,
            { name: "owner", type: { kind: "text" as const }, classification: "pii" as const },
          ],
        },
      ],
      views: {
        chartList: {
          kind: "list",
          entity: "Chart",
          columns: [{ field: "note" }, { field: "owner" }, { field: "label" }],
          sort: [
            { field: "label", direction: "asc" },
            { field: "note", direction: "asc" },
            { field: "owner", direction: "asc" },
          ],
          pageSize: 50,
        },
      } as unknown as Manifest["views"],
      permissions: { Chart: { list: { roles: ["clinician"], abac: "rec" } } },
    });
    // Every component of the sort key lands in the cursor, so a clean leading component does not
    // excuse a classified trailing one.
    expect(declared(twoKeys).listSortConflicts.map((c) => c.field)).toEqual(["note", "owner"]);
  });

  /**
   * The live member, measured over the real resolved packs rather than asserted from the brief.
   *
   * No pack declares an `abac` grant, so the refusal is vacuous today — which is why the sweep has
   * to *add* a record-bearing `list` obligation to every entity before it can see anything. What it
   * then finds is the one pair the rule would name the moment somebody declares such a policy for
   * real.
   */
  it("names Patient.family_name across the seven resolved builtin packs, and nothing else", async () => {
    const found: string[] = [];
    for (const name of BUILTIN_PACK_NAMES) {
      const pack = await loadBuiltinPack(name);
      const permissions = Object.fromEntries(
        (pack.entities ?? []).map((e) => [
          e.name,
          { ...(pack.permissions?.[e.name] ?? {}), list: { roles: ["r"], abac: "rec" } },
        ]),
      );
      const result = checkAbacObligations({
        manifest: { ...pack, permissions },
        answerableKeys: new Set(["rec"]),
        recordBearingKeys: new Set(["rec"]),
        cursorSealing: "sealed",
      });
      // The vacuity control: the sweep is walking a real permission map, so a zero is a
      // measurement and not an empty loop.
      expect(result.obligations.length, name).toBeGreaterThan(0);
      expect(result.rowFiltered.length, name).toBeGreaterThan(0);
      for (const c of result.listSortConflicts) {
        found.push(`${name} ${c.entity}.${c.field} (${c.classification})`);
      }
    }
    expect(found).toEqual(["erp-healthcare Patient.family_name (pii)"]);
  });

  it("refuses that pack end to end once such a policy is declared on Patient", async () => {
    const pack = await loadBuiltinPack("erp-healthcare");
    const result = checkAbacObligations({
      manifest: {
        ...pack,
        permissions: {
          ...(pack.permissions ?? {}),
          Patient: {
            ...(pack.permissions ?? {})["Patient"],
            list: { roles: ["clinician"], abac: "same_facility" },
          },
        },
      },
      answerableKeys: new Set(["same_facility"]),
      recordBearingKeys: new Set(["same_facility"]),
      cursorSealing: "sealed",
    });
    expect(result.refusal).toBe("list_sort_addresses_withheld_field");
    expect(result.listSortConflicts).toEqual([
      {
        entity: "Patient",
        field: "family_name",
        classification: "pii",
        policyKey: "same_facility",
      },
    ]);
    expect(formatAbacObligationCheck(result)).toContain("Patient.family_name (pii)");
  });
});

describe("the cursor_discloses_withheld_rows refusal", () => {
  /**
   * A record-bearing `list` grant and **no view**, so the default sort is empty and the sort
   * refusal cannot pre-empt this one. The entity declares one classified field and one plain
   * field, so the ordering fixture below can add a view sorting on either.
   */
  const CHART_ENTITY = {
    name: "Chart",
    fields: [
      { name: "note", type: { kind: "text" as const }, classification: "phi" as const },
      { name: "label", type: { kind: "text" as const } },
    ],
  };

  function filtered(cursorSealing: CursorSealingMode): AbacObligationCheck {
    return checkAbacObligations({
      manifest: manifest({
        entities: [CHART_ENTITY],
        permissions: { Chart: { list: { roles: ["clinician"], abac: "rec" } } },
      }),
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(["rec"]),
      cursorSealing,
    });
  }

  it("refuses when rows are filtered and nothing seals the cursor", () => {
    const result = filtered("absent");
    expect(result.rowFiltered).toHaveLength(1);
    expect(result.refusal).toBe("cursor_discloses_withheld_rows");
    expect(result.cursorDisclosing).toEqual([
      { entity: "Chart", operation: "list", field: null, policyKey: "rec" },
    ]);
  });

  it("does not refuse when the cursor is sealed", () => {
    const result = filtered("sealed");
    expect(result.rowFiltered).toHaveLength(1);
    expect(result.refusal).toBeNull();
    expect(result.cursorDisclosing).toEqual([]);
  });

  it("does not refuse when the disclosure was accepted knowingly", () => {
    const result = filtered("plaintext_accepted");
    expect(result.rowFiltered).toHaveLength(1);
    expect(result.refusal).toBeNull();
    expect(result.cursorDisclosing).toEqual([]);
  });

  it("refuses on exactly one of the three modes, driven off the enum", () => {
    // Both directions over the real mode list, so a fourth mode is tested here rather than
    // inheriting whichever branch the gate happened to end on.
    const refusing = CURSOR_SEALING_MODES.filter(
      (mode) => filtered(mode).refusal === "cursor_discloses_withheld_rows",
    );
    expect(refusing).toEqual(["absent"]);
  });

  it("does not refuse when no grant filters rows, whatever the mode", () => {
    // A reversible cursor is only a disclosure where something is withheld. Most deployments
    // withhold nothing, and refusing them would be a refusal with no defect behind it.
    for (const cursorSealing of CURSOR_SEALING_MODES) {
      const result = checkAbacObligations({
        manifest: manifest({
          permissions: { Chart: { read: { roles: ["clinician"], abac: "rec" } } },
        }),
        answerableKeys: new Set(["rec"]),
        recordBearingKeys: new Set(["rec"]),
        cursorSealing,
      });
      expect(result.rowFiltered, cursorSealing).toEqual([]);
      expect(result.cursorDisclosing, cursorSealing).toEqual([]);
      expect(result.refusal, cursorSealing).toBeNull();
    }
  });

  it("does not refuse a manifest with no obligation at all, whatever the mode", () => {
    for (const cursorSealing of CURSOR_SEALING_MODES) {
      const result = checkAbacObligations({
        manifest: manifest({ permissions: { Chart: { list: { roles: ["clinician"] } } } }),
        answerableKeys: new Set(["rec"]),
        recordBearingKeys: new Set(["rec"]),
        cursorSealing,
      });
      expect(result.refusal, cursorSealing).toBeNull();
      expect(result.cursorDisclosing, cursorSealing).toEqual([]);
    }
  });

  it("reports the no-evaluator refusal first, because its remedy supersedes sealing a cursor", () => {
    // With no evaluator nothing is classified record-bearing, so `rowFiltered` is empty and this
    // refusal is vacuously silent — which is why it sits after both questions that do not need
    // the declaration.
    const result = checkAbacObligations({
      manifest: manifest({
        entities: [CHART_ENTITY],
        permissions: { Chart: { list: { roles: ["clinician"], abac: "rec" } } },
      }),
      answerableKeys: new Set(),
      recordBearingKeys: new Set(),
      cursorSealing: "absent",
    });
    expect(result.refusal).toBe("obligation_unevaluable");
    expect(result.cursorDisclosing).toEqual([]);
  });

  it("reports the sort refusal first when a manifest trips both, because sealing does not rescue a sort", () => {
    // The list handler's addressing guard refuses every request on that entity before a cursor is
    // minted, so an operator who answered this refusal by setting a secret would find the entity
    // still unservable and the sort remedy still owed.
    const result = checkAbacObligations({
      manifest: manifest({
        entities: [CHART_ENTITY],
        views: {
          chartList: {
            kind: "list",
            entity: "Chart",
            columns: [{ field: "note" }],
            sort: [{ field: "note", direction: "asc" }],
            pageSize: 50,
          },
        } as unknown as Manifest["views"],
        permissions: { Chart: { list: { roles: ["clinician"], abac: "rec" } } },
      }),
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(["rec"]),
      cursorSealing: "absent",
    });
    expect(result.listSortConflicts).toHaveLength(1);
    expect(result.cursorDisclosing).toHaveLength(1);
    expect(result.refusal).toBe("list_sort_addresses_withheld_field");
  });

  it("reports the record-unavailable refusal first when a manifest trips both", () => {
    const result = checkAbacObligations({
      manifest: manifest({
        entities: [CHART_ENTITY],
        permissions: {
          Chart: {
            create: { roles: ["clinician"], abac: "rec" },
            list: { roles: ["clinician"], abac: "rec" },
          },
        },
      }),
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(["rec"]),
      cursorSealing: "absent",
    });
    expect(result.cursorDisclosing).toHaveLength(1);
    expect(result.refusal).toBe("record_unavailable");
  });

  it("names the cursor's construction, the row it comes from and the limit=1 consequence", () => {
    const message = new AbacObligationsUnevaluable(filtered("absent")).message;
    expect(message).toContain("base64url(JSON.stringify({k: [...sort values], id}))");
    expect(message).toContain("last row of the store's slice");
    expect(message).toContain("a row the caller is never shown");
    expect(message).toContain("`limit=1`");
    expect(message).toContain("enumeration of the ids");
  });

  it("names both remedies, the environment variable first and the flag second", () => {
    const message = new AbacObligationsUnevaluable(filtered("absent")).message;
    expect(message).toContain(CURSOR_ENCRYPTION_SECRET_VAR);
    expect(message).toContain(ALLOW_CURSOR_DISCLOSURE_FLAG);
    expect(message.indexOf(CURSOR_ENCRYPTION_SECRET_VAR)).toBeLessThan(
      message.indexOf(ALLOW_CURSOR_DISCLOSURE_FLAG),
    );
  });

  it("names the grant and what a denial there does, rather than only counting", () => {
    const message = new AbacObligationsUnevaluable(filtered("absent")).message;
    expect(message).toContain("1 abac-qualified grant(s)");
    expect(message).toContain("Chart.list requires abac policy 'rec'");
    expect(message).toContain("the denied rows are dropped from the page");
  });

  it("is the same text the boot line carries, so the two cannot disagree", () => {
    const result = filtered("absent");
    expect(formatAbacObligationCheck(result)).toContain(
      new AbacObligationsUnevaluable(result).message,
    );
  });

  it("carries the disclosing obligations on the thrown error, so a boot catch need not re-derive them", () => {
    const result = filtered("absent");
    const error = new AbacObligationsUnevaluable(result);
    expect(error.refusal).toBe("cursor_discloses_withheld_rows");
    expect(error.cursorDisclosing).toEqual(result.cursorDisclosing);
  });

  it("names every disclosing grant up to the detail limit and withholds the rest", () => {
    const perms: Record<string, { list: { roles: string[]; abac: string } }> = {};
    for (let i = 0; i < OBLIGATION_DETAIL_LIMIT + 2; i += 1) {
      perms[`E${i.toString()}`] = { list: { roles: ["r"], abac: "rec" } };
    }
    const result = checkAbacObligations({
      manifest: manifest({ permissions: perms }),
      answerableKeys: new Set(["rec"]),
      recordBearingKeys: new Set(["rec"]),
      cursorSealing: "absent",
    });
    expect(result.cursorDisclosing).toHaveLength(OBLIGATION_DETAIL_LIMIT + 2);
    const message = new AbacObligationsUnevaluable(result).message;
    expect(message).toContain(`${(OBLIGATION_DETAIL_LIMIT + 2).toString()} abac-qualified`);
    expect(message).toContain("(+2 more)");
  });

  /**
   * ADR-0322's rule on the accepted path: a surface that degrades rather than refusing has to say
   * so out loud, on every boot and not only in the shell history of whoever passed the flag.
   */
  it("reports the accepted disclosure on the boot line without setting a refusal", () => {
    const result = filtered("plaintext_accepted");
    expect(result.refusal).toBeNull();
    const line = formatAbacObligationCheck(result);
    expect(line).toContain(ALLOW_CURSOR_DISCLOSURE_FLAG);
    expect(line).toContain("stays reversible base64url JSON");
    expect(line).toContain(CURSOR_ENCRYPTION_SECRET_VAR);
    // Still the healthy line, with the row-filtering note it always carried.
    expect(line).toContain("filter rows out of the page");
  });

  it("says nothing about the cursor on the boot line when it is sealed", () => {
    const line = formatAbacObligationCheck(filtered("sealed"));
    expect(line).toContain("filter rows out of the page");
    expect(line).not.toContain(ALLOW_CURSOR_DISCLOSURE_FLAG);
    expect(line).not.toContain(CURSOR_ENCRYPTION_SECRET_VAR);
  });

  it("says nothing about the cursor when the disclosure was accepted and nothing is withheld", () => {
    // The note is conditioned on `rowFiltered`, not on the flag: a deployment that passed the
    // flag and withholds no rows has accepted nothing, and saying otherwise every boot is the
    // standing warning operators learn to ignore.
    const line = formatAbacObligationCheck(
      checkAbacObligations({
        manifest: manifest({
          permissions: { Chart: { read: { roles: ["clinician"], abac: "rec" } } },
        }),
        answerableKeys: new Set(["rec"]),
        recordBearingKeys: new Set(["rec"]),
        cursorSealing: "plaintext_accepted",
      }),
    );
    expect(line).not.toContain(ALLOW_CURSOR_DISCLOSURE_FLAG);
  });

  it("declares none of the seven builtin packs disclosing, because none declares an obligation", async () => {
    // The measurement that makes this refusal vacuous today and a forcing function later: no pack
    // declares an `abac` grant, so the unsealed cursor every deployment serves discloses nothing.
    for (const name of BUILTIN_PACK_NAMES) {
      const result = checkAbacObligations({
        manifest: await loadBuiltinPack(name),
        answerableKeys: new Set(["rec"]),
        recordBearingKeys: new Set(["rec"]),
        cursorSealing: "absent",
      });
      expect(result.cursorDisclosing, name).toEqual([]);
      expect(result.refusal, name).toBeNull();
    }
  });
});
