import { describe, expect, it } from "vitest";
import {
  RECORD_STORAGE_MODELS,
  TombstoneRecordStorageDeclarationSchema,
  type RecordStorageModel,
} from "@crossengin/tenant-lifecycle";

import {
  bootErasureCoverageIsSuspect,
  formatBootErasureCoverage,
  recordStorageDeclarationFor,
  type BootErasureCoverageInput,
} from "./boot-erasure-report.js";

/** Every store the serving binary accepts, so a fourth one fails here as well as at the map. */
const STORES: readonly BootErasureCoverageInput["store"][] = ["memory", "pg", "pg-columns"];

/** Deliberately not `public` or `meta`, so a line that hardcoded either is caught. */
const SCHEMA = "clinic";

/**
 * The store and figure fields default; the two plan fields do not.
 *
 * Required at every call site deliberately. A coverage input that can be built without saying
 * whether an order exists is the shape of defect this increment closes, and a helper defaulting
 * both to the empty answer would make every test below assert the acyclic case while reading as
 * though it had considered the other one.
 */
type CoverageParts = Partial<Pick<BootErasureCoverageInput, "store" | "schema" | "targetCount">> &
  Pick<BootErasureCoverageInput, "blockingCycle" | "relaxedCascades">;

/** An order exists and nothing was given up to find one — the answer for all seven shipped packs. */
const ORDERED: Pick<BootErasureCoverageInput, "blockingCycle" | "relaxedCascades"> = {
  blockingCycle: [],
  relaxedCascades: [],
};

function input(parts: CoverageParts): BootErasureCoverageInput {
  return { store: "pg-columns", schema: SCHEMA, targetCount: 54, ...parts };
}

/** A cycle of `ON DELETE RESTRICT` references, which no sequence of per-table deletes empties. */
const CYCLE: readonly string[] = ["Invoice", "Payment"];

describe("formatBootErasureCoverage", () => {
  it("leads every store with one greppable label", () => {
    for (const store of STORES) {
      expect(formatBootErasureCoverage(input({ ...ORDERED, store }))).toMatch(
        /^tenant record erasure: /,
      );
    }
  });

  it("says something for every store, including when the figure is zero", () => {
    // The defect this module closes is a fact that was never said. A line present only when there
    // is something to erase prints nothing on exactly the deployment that is wrong.
    for (const store of STORES) {
      for (const targetCount of [0, 54]) {
        const line = formatBootErasureCoverage(input({ ...ORDERED, store, targetCount }));
        expect(line.length).toBeGreaterThan(80);
      }
    }
  });

  it("is one line per store, so the absence of this fact shows in a diff of two boots", () => {
    for (const store of STORES) {
      for (const targetCount of [0, 1, 54]) {
        for (const blockingCycle of [[], CYCLE]) {
          for (const relaxedCascades of [[], ["Expense.employee_id -> Employee"]]) {
            const line = formatBootErasureCoverage(
              input({ store, targetCount, blockingCycle, relaxedCascades }),
            );
            expect(line).not.toContain("\n");
          }
        }
      }
    }
  });

  describe("--store memory", () => {
    const line = formatBootErasureCoverage(input({ ...ORDERED, store: "memory", targetCount: 0 }));

    it("reports no_database", () => {
      expect(line).toContain("no_database");
    });

    it("names no schema, rather than printing a default for a deployment with no database", () => {
      expect(line).not.toContain(SCHEMA);
      expect(line).not.toContain("public");
      expect(line).toContain("no schema to erase it from");
    });

    it("says the deletion routes cannot mount, so the zero is not an empty scope", () => {
      expect(line).toContain("refuse to mount");
      expect(line).toContain("not an empty scope");
    });
  });

  describe("--store pg", () => {
    const line = formatBootErasureCoverage(input({ ...ORDERED, store: "pg", targetCount: 0 }));

    it("reports catalogued", () => {
      expect(line).toContain("catalogued");
    });

    it("names the schema, because the records' location is what the figure does not say", () => {
      expect(line).toContain(`${SCHEMA}.operate_entity_records`);
    });

    it("names the links table too, since a tenant's links are records", () => {
      expect(line).toContain(`${SCHEMA}.operate_entity_links`);
    });

    it("says the zero is a fact rather than a finding", () => {
      expect(line).toContain("not a finding");
    });
  });

  describe("--store pg-columns with targets", () => {
    const line = formatBootErasureCoverage(input({ ...ORDERED, targetCount: 54 }));

    it("reports column_tables", () => {
      expect(line).toContain("column_tables");
    });

    it("names the figure", () => {
      expect(line).toContain("54 typed table(s)");
    });

    it("names the schema, which is the one thing a wrong --schema makes wrong", () => {
      expect(line).toContain(`in schema ${SCHEMA}`);
    });

    it("names the count(*) rule the proof's figure depends on", () => {
      expect(line).toContain("count(*)");
    });

    it("bounds the claim to the boot manifest, not to a per-tenant one in t_<hex>", () => {
      expect(line).toContain("t_<hex>");
    });

    it("carries a single-table figure verbatim rather than pluralising", () => {
      expect(formatBootErasureCoverage(input({ ...ORDERED, targetCount: 1 }))).toContain(
        "1 typed table(s)",
      );
    });

    it("says none of these tables is retainable, and why", () => {
      // A stated gap rather than an omission: both retention sets are constants over META_TABLES,
      // so a statutory obligation over a tenant's own records has nowhere to be declared.
      expect(line).toContain("None of them is retainable");
      expect(line).toContain("both retention sets are constants over META_TABLES");
    });

    it("appends no cascade clause when the order gave nothing up", () => {
      expect(line).not.toContain("parent-first");
      expect(line).not.toContain("understates");
    });
  });

  describe("--store pg-columns with a relaxed cascade", () => {
    const FIRST = "OrderLine.order_id -> SalesOrder";
    const SECOND = "Shipment.order_id -> SalesOrder";
    const line = formatBootErasureCoverage(
      input({ targetCount: 54, blockingCycle: [], relaxedCascades: [FIRST, SECOND] }),
    );

    it("keeps the column_tables verdict, because the claim still stands", () => {
      expect(line).toContain("column_tables");
    });

    it("names every reference the order gave up", () => {
      expect(line).toContain(`(${FIRST}, ${SECOND})`);
    });

    it("counts them and says which way the proof's figure is wrong", () => {
      expect(line).toContain("2 reference(s) are emptied parent-first");
      expect(line).toContain("understates those children");
    });

    it("is not suspect, so the level stays meaningful on the two conditions that are findings", () => {
      expect(
        bootErasureCoverageIsSuspect(
          input({ targetCount: 54, blockingCycle: [], relaxedCascades: [FIRST] }),
        ),
      ).toBe(false);
    });
  });

  describe("--store pg-columns with a blocking cycle", () => {
    const line = formatBootErasureCoverage(
      input({ targetCount: 54, blockingCycle: CYCLE, relaxedCascades: [] }),
    );

    it("reports order_unrunnable", () => {
      expect(line).toContain("order_unrunnable");
    });

    it("answers the cycle before the count, with a large figure in hand", () => {
      // `column_tables: 54 table(s)` beside a deletion that will refuse its first statement is
      // exactly the reassuring line this module exists to prevent.
      expect(line).not.toContain("column_tables");
    });

    it("decides on the cycle alone, whatever the figure", () => {
      // No count makes an unrunnable order runnable, so the figure cannot reach either other arm.
      for (const targetCount of [0, 1, 54]) {
        expect(
          formatBootErasureCoverage(input({ targetCount, blockingCycle: CYCLE, relaxedCascades: [] })),
        ).toContain("order_unrunnable");
      }
    });

    it("names the entities in the cycle", () => {
      expect(line).toContain("Invoice, Payment");
    });

    it("counts the cycle's members rather than the targets", () => {
      expect(line).toContain("2 of this manifest's entities");
    });

    it("says why no order exists, so the figure beside it cannot be read as coverage", () => {
      expect(line).toContain("cannot be emptied in any order");
      // "blocked by", not "reference each other": `blockingCycle` names every entity the cycle
      // blocks, the ones behind it included, so the shorter claim would be false of some names.
      expect(line).toContain("a cycle of ON DELETE RESTRICT references blocks them");
    });

    it("names the refusal the deletion will answer with, before anything is destroyed", () => {
      expect(line).toContain("boot_schema_order_unrunnable");
      expect(line).toContain("before anything is destroyed");
    });

    it("says serving is unaffected, which is why this is reported here and refused there", () => {
      expect(line).toContain("Serving is unaffected");
    });

    it("names the remedy as a declaration on one relation in the cycle", () => {
      expect(line).toContain("onDelete cascade or set_null on one relation");
    });

    it("still carries the figure and the schema", () => {
      expect(line).toContain("54 typed table(s)");
      expect(line).toContain(`in schema ${SCHEMA}`);
    });

    it("carries no cascade caveat, which would read as a deletion that is going to run", () => {
      const relaxed = formatBootErasureCoverage(
        input({
          targetCount: 54,
          blockingCycle: CYCLE,
          relaxedCascades: ["OrderLine.order_id -> SalesOrder"],
        }),
      );
      expect(relaxed).not.toContain("parent-first");
    });
  });

  describe("--store pg-columns with no targets", () => {
    const line = formatBootErasureCoverage(input({ ...ORDERED, targetCount: 0 }));

    it("reports no_targets", () => {
      expect(line).toContain("no_targets");
    });

    it("still names the schema", () => {
      expect(line).toContain(SCHEMA);
    });

    it("sends the operator to the manifest, because a wrong schema cannot produce this", () => {
      // `bootSchemaErasurePlan` counts from the manifest, so the count is schema-independent;
      // naming a schema as the remedy here would send an operator after the wrong thing.
      expect(line).toContain("the manifest this server loaded is the one intended");
    });

    it("says the scope will name no table of the tenant's own", () => {
      expect(line).toContain("no table of the tenant's own");
    });
  });

  it("uses the caller's schema verbatim on both database stores", () => {
    for (const store of ["pg", "pg-columns"] as const) {
      expect(
        formatBootErasureCoverage(input({ ...ORDERED, store, schema: "t_deadbeef" })),
      ).toContain("t_deadbeef");
    }
  });
});

describe("bootErasureCoverageIsSuspect", () => {
  it("flags pg-columns with no targets", () => {
    expect(bootErasureCoverageIsSuspect(input({ ...ORDERED, targetCount: 0 }))).toBe(true);
  });

  it("flags pg-columns with a blocking cycle, whatever the figure", () => {
    for (const targetCount of [0, 1, 54]) {
      expect(
        bootErasureCoverageIsSuspect(
          input({ targetCount, blockingCycle: CYCLE, relaxedCascades: [] }),
        ),
      ).toBe(true);
    }
  });

  it("does not flag pg-columns with targets and a runnable order", () => {
    expect(bootErasureCoverageIsSuspect(input({ ...ORDERED, targetCount: 1 }))).toBe(false);
    expect(bootErasureCoverageIsSuspect(input({ ...ORDERED, targetCount: 54 }))).toBe(false);
  });

  it("does not flag pg with no targets, where zero is the correct answer", () => {
    expect(bootErasureCoverageIsSuspect(input({ ...ORDERED, store: "pg", targetCount: 0 }))).toBe(
      false,
    );
  });

  it("does not flag memory with no targets", () => {
    expect(
      bootErasureCoverageIsSuspect(input({ ...ORDERED, store: "memory", targetCount: 0 })),
    ).toBe(false);
  });

  it("does not become a second place deciding what a store's target list should be", () => {
    // A non-zero count, or a cycle, on a store that creates no typed tables is the caller's
    // business. This function reports a condition; inventing a verdict for that pair would make
    // two modules disagree about one deployment.
    for (const store of ["pg", "memory"] as const) {
      for (const targetCount of [0, 54]) {
        for (const blockingCycle of [[], CYCLE]) {
          expect(
            bootErasureCoverageIsSuspect(
              input({ store, targetCount, blockingCycle, relaxedCascades: [] }),
            ),
          ).toBe(false);
        }
      }
    }
  });

  it("flags a count that is not a positive number of tables", () => {
    // `hasTargets` is `> 0` rather than `<= 0` precisely for `NaN`: a caller that could not compute
    // a count must land on the branch that reports a finding, never on the one claiming coverage.
    expect(bootErasureCoverageIsSuspect(input({ ...ORDERED, targetCount: Number.NaN }))).toBe(true);
    expect(bootErasureCoverageIsSuspect(input({ ...ORDERED, targetCount: -1 }))).toBe(true);
  });

  it("leaves a non-positive count unflagged on the stores where zero is correct", () => {
    expect(
      bootErasureCoverageIsSuspect(input({ ...ORDERED, store: "pg", targetCount: Number.NaN })),
    ).toBe(false);
  });

  it("does not flag a relaxed cascade on its own", () => {
    // The caveat rides inside a line that already carries the figure it qualifies, and warning on
    // it would train an operator to ignore the level on the two conditions that are findings.
    expect(
      bootErasureCoverageIsSuspect(
        input({
          targetCount: 54,
          blockingCycle: [],
          relaxedCascades: ["OrderLine.order_id -> SalesOrder"],
        }),
      ),
    ).toBe(false);
  });

  it("agrees with the line for every store, figure and cycle", () => {
    // The level a caller logs at and the verdict an operator reads come from one comparison, so
    // they cannot disagree about a deployment. The suspect verdicts are asserted as a set, because
    // a third condition reaching one of the two functions and not the other is the divergence this
    // guards against.
    const SUSPECT_VERDICTS: readonly string[] = ["no_targets", "order_unrunnable"];
    for (const store of STORES) {
      for (const targetCount of [0, 1, 54, -1, Number.NaN]) {
        for (const blockingCycle of [[], CYCLE]) {
          const candidate = input({ store, targetCount, blockingCycle, relaxedCascades: [] });
          const line = formatBootErasureCoverage(candidate);
          const reads = SUSPECT_VERDICTS.some((verdict) => line.includes(verdict));
          expect(reads).toBe(bootErasureCoverageIsSuspect(candidate));
        }
      }
    }
  });
});

describe("recordStorageDeclarationFor", () => {
  /**
   * The model each store declares, as a `Record` over the store union rather than a list — so a
   * fourth store is a compile error here as well as at the map this mirrors, and the mapping is what
   * is asserted rather than three calls agreeing with whatever they returned.
   */
  const EXPECTED_MODEL: Readonly<Record<BootErasureCoverageInput["store"], RecordStorageModel>> = {
    memory: "no_durable_store",
    pg: "document_rows",
    "pg-columns": "typed_tables",
  };

  it("is total over the stores the serving binary accepts, and names no others", () => {
    // Both directions, because the loops below run over `STORES`: a store in the union and missing
    // from that list would be untested while reading as covered.
    expect(Object.keys(EXPECTED_MODEL).sort()).toEqual([...STORES].sort());
  });

  it("answers the model for every store", () => {
    for (const store of STORES) {
      expect(recordStorageDeclarationFor({ store, schema: SCHEMA }).model).toBe(
        EXPECTED_MODEL[store],
      );
    }
  });

  it("names the schema for typed_tables and null for the models that have no typed relations", () => {
    for (const store of STORES) {
      const declared = recordStorageDeclarationFor({ store, schema: SCHEMA });
      expect(declared.schema).toBe(EXPECTED_MODEL[store] === "typed_tables" ? SCHEMA : null);
    }
  });

  it("carries the caller's schema verbatim rather than a default of its own", () => {
    expect(recordStorageDeclarationFor({ store: "pg-columns", schema: "t_deadbeef" }).schema).toBe(
      "t_deadbeef",
    );
  });

  it("withholds the schema from the other two models even when a real one is passed", () => {
    // The schema is the half an operator cross-checks against the store's own default, so naming one
    // for a model with no typed relations would be a claim about relations that do not exist — and
    // it is the caller, not this function, that holds a schema for both database stores.
    for (const store of ["pg", "memory"] as const) {
      expect(recordStorageDeclarationFor({ store, schema: "public" }).schema).toBeNull();
    }
  });

  it("produces a declaration the contract parses once the count is added", () => {
    // The cross-check a test of the map alone cannot make: this producer and the schema's own
    // refinement have to agree about which (model, schema) pairs are legal, and the refinement
    // refuses `typed_tables` with a null schema and a non-typed model carrying one.
    for (const store of STORES) {
      const declared = recordStorageDeclarationFor({ store, schema: SCHEMA });
      expect(
        TombstoneRecordStorageDeclarationSchema.safeParse({ ...declared, relationCount: 0 }).success,
        store,
      ).toBe(true);
    }
    // Zero is the count every model may carry, so the loop above exercises only the arm that admits
    // all three. A positive count is legal for the one model that has relations to count.
    expect(
      TombstoneRecordStorageDeclarationSchema.safeParse({
        ...recordStorageDeclarationFor({ store: "pg-columns", schema: SCHEMA }),
        relationCount: 54,
      }).success,
    ).toBe(true);
  });

  it("reaches every model the contract declares", () => {
    // A model no store produces is a vocabulary member no deployment can claim, which is the shape
    // of gap ADR-0350's missing declaration was. A fifth model needs a store answering it, or a
    // stated reason it is unreachable.
    const reached = STORES.map((store) => recordStorageDeclarationFor({ store, schema: SCHEMA }).model);
    expect([...new Set(reached)].sort()).toEqual([...RECORD_STORAGE_MODELS].sort());
  });
});
