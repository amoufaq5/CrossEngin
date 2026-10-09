import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import {
  COLUMN_STORE_DEFAULT_SCHEMA,
  bootSchemaErasurePlan,
  bootSchemaErasureTargets,
} from "./boot-schema-targets.js";
import { emitManifestSchemaDdl } from "./entity-ddl.js";
import { columnPlansForManifest, joinTablePlansForManifest } from "./column-plan.js";

const ACCOUNT: Entity = { name: "Account", fields: [{ name: "name", type: { kind: "text" } }] };
const ORDER: Entity = {
  name: "Order",
  fields: [{ name: "account", type: { kind: "reference", target: "Account" } }],
};
const LINE: Entity = {
  name: "OrderLine",
  fields: [
    { name: "qty", type: { kind: "integer" } },
    { name: "order", type: { kind: "reference", target: "Order" } },
  ],
};

function manifestOf(parts: {
  entities?: readonly Entity[];
  relations?: readonly unknown[];
  traits?: readonly unknown[];
}): Manifest {
  return parts as unknown as Manifest;
}

const CHAIN = manifestOf({ entities: [LINE, ORDER, ACCOUNT] });

/**
 * The shape all seven shipped packs are in: `Employee.department_id -> Department` is declared
 * `onDelete: "set_null"`, so it completes the *reference* cycle `Employee -> Department -> Employee`
 * while constraining no deletion.
 *
 * Measured on PostgreSQL 16.13 against the emitted DDL: emptying `employee` first is refused —
 * `update or delete on table "employee" violates foreign key constraint "fk_department_manager_id"
 * on table "department"` — while `expense`, `department`, `employee` commits.
 */
const CYCLIC = manifestOf({
  entities: [
    { name: "Expense", fields: [{ name: "employee_id", type: { kind: "reference", target: "Employee" } }] },
    { name: "Department", fields: [{ name: "manager_id", type: { kind: "reference", target: "Employee" } }] },
    { name: "Employee", fields: [{ name: "department_id", type: { kind: "reference", target: "Department" } }] },
  ],
  relations: [
    { kind: "many_to_one", from: "Employee", field: "department_id", to: "Department", onDelete: "set_null" },
  ],
});

/** Table names, in plan order. */
function tablesOf(manifest: Manifest, opts?: { readonly schema?: string }): readonly string[] {
  return bootSchemaErasurePlan(manifest, opts).targets.map((t) => t.table);
}

/** The `CREATE TABLE` order the store's own emitter produces, read back off its SQL. */
function createdTables(manifest: Manifest): readonly string[] {
  const plans = columnPlansForManifest(manifest, { schema: "public" });
  return emitManifestSchemaDdl(plans)
    .map((s) => /^CREATE TABLE IF NOT EXISTS "public"\."([a-z_]+)"/.exec(s)?.[1])
    .filter((t): t is string => t !== undefined);
}

describe("bootSchemaErasurePlan — the order over the blocking graph", () => {
  it("empties a child before the parent it references", () => {
    // The composite FKs between entity tables are ON DELETE RESTRICT by default, so deleting
    // Account's rows while an Order still references one is refused by the database.
    const tables = tablesOf(CHAIN);
    expect(tables.indexOf("order_line")).toBeLessThan(tables.indexOf("order"));
    expect(tables.indexOf("order")).toBeLessThan(tables.indexOf("account"));
  });

  it("is the reverse of the create order for an acyclic RESTRICT chain, and only there", () => {
    // The two coincide exactly here and nowhere else: `topologicalEntityOrder` orders the
    // *reference* graph, so its reverse is a deletion order only while every reference also blocks
    // a delete and the graph is acyclic. The cyclic case below asserts the divergence.
    // Read back off the emitted DDL rather than recomputed, so this fails if the emitter ever stops
    // using `topologicalEntityOrder`.
    const created = createdTables(CHAIN);
    expect(created).toHaveLength(3);
    expect(tablesOf(CHAIN)).toEqual([...created].reverse());
  });

  it("names every entity table exactly once", () => {
    expect([...tablesOf(CHAIN)].sort()).toEqual(["account", "order", "order_line"]);
  });

  it("promises nothing it could not keep for an acyclic RESTRICT chain", () => {
    const plan = bootSchemaErasurePlan(CHAIN);
    expect(plan.blockingCycle).toEqual([]);
    expect(plan.relaxed).toEqual([]);
  });

  it("yields an identical plan for the same manifest twice", () => {
    // The erasure's figures go into a signed proof, so two runs must not name the tables in two
    // orders and report two row counts for one deletion.
    expect(bootSchemaErasurePlan(CHAIN)).toEqual(bootSchemaErasurePlan(CHAIN));
    expect(bootSchemaErasurePlan(CYCLIC)).toEqual(bootSchemaErasurePlan(CYCLIC));
  });

  it("orders on a reference contributed by a trait, not just the entity's own fields", () => {
    const manifest = manifestOf({
      traits: [
        { name: "owned", fields: [{ name: "author", type: { kind: "reference", target: "Author" } }] },
      ],
      entities: [
        { name: "Doc", traits: ["owned"], fields: [{ name: "title", type: { kind: "text" } }] },
        { name: "Author", fields: [{ name: "name", type: { kind: "text" } }] },
      ],
    });
    const tables = tablesOf(manifest);
    expect(tables.indexOf("doc")).toBeLessThan(tables.indexOf("author"));
  });
});

describe("bootSchemaErasurePlan — a cycle the weakest edge breaks", () => {
  it("orders the shipped packs' reference cycle the way the database accepts", () => {
    expect(tablesOf(CYCLIC)).toEqual(["expense", "department", "employee"]);
  });

  it("names the reference it gave up, and that it cost no figure", () => {
    const plan = bootSchemaErasurePlan(CYCLIC);
    expect(plan.blockingCycle).toEqual([]);
    expect(plan.relaxed).toEqual([
      { reference: "Employee.department_id", target: "Department", onDelete: "set_null" },
    ]);
  });

  it("is not the reverse of the create order, which is what the database refused", () => {
    // The reverse puts `employee` first, which is the refused statement quoted above. This
    // assertion is the whole difference between ordering the reference graph and ordering the
    // blocking one — and the length check keeps it from passing because the DDL stopped parsing.
    const created = createdTables(CYCLIC);
    expect(created).toHaveLength(3);
    expect(tablesOf(CYCLIC)).not.toEqual([...created].reverse());
  });

  it("gives up a cascade edge when that is the weakest in the cycle, and says so", () => {
    // `A.b -> B` cascades, `B.a -> A` restricts, so the only breakable edge is the cascade one: B
    // is emptied first and its statement destroys A's referencing rows. A's own DELETE then reports
    // fewer rows than it removed, so the figure the tombstone commits to undercounts — nothing else
    // in the pipeline reports that, which is why `relaxed` carries the policy and not just the name.
    const cascading = manifestOf({
      entities: [
        { name: "A", fields: [{ name: "b", type: { kind: "reference", target: "B" } }] },
        { name: "B", fields: [{ name: "a", type: { kind: "reference", target: "A" } }] },
      ],
      relations: [{ kind: "many_to_one", from: "A", field: "b", to: "B", onDelete: "cascade" }],
    });
    const plan = bootSchemaErasurePlan(cascading);
    expect(plan.blockingCycle).toEqual([]);
    expect(plan.targets.map((t) => t.table)).toEqual(["b", "a"]);
    expect(plan.relaxed).toEqual([{ reference: "A.b", target: "B", onDelete: "cascade" }]);
  });

  it("gives up set_null before cascade when a cycle contains both", () => {
    // `A.b -> B` cascades, `B.c -> C` restricts, `C.a -> A` nulls. Dropping the set_null edge alone
    // frees the cycle, so the cascade edge is still honoured — which is the point: only a relaxed
    // cascade moves a row count, so it is the dearer of the two to give up.
    const mixed = manifestOf({
      entities: [
        { name: "A", fields: [{ name: "b", type: { kind: "reference", target: "B" } }] },
        { name: "B", fields: [{ name: "c", type: { kind: "reference", target: "C" } }] },
        { name: "C", fields: [{ name: "a", type: { kind: "reference", target: "A" } }] },
      ],
      relations: [
        { kind: "many_to_one", from: "A", field: "b", to: "B", onDelete: "cascade" },
        { kind: "many_to_one", from: "C", field: "a", to: "A", onDelete: "set_null" },
      ],
    });
    const plan = bootSchemaErasurePlan(mixed);
    expect(plan.blockingCycle).toEqual([]);
    expect(plan.relaxed).toEqual([{ reference: "C.a", target: "A", onDelete: "set_null" }]);
    // A before B is the cascade edge kept, B before C the restrict edge that was never negotiable.
    expect(plan.targets.map((t) => t.table)).toEqual(["a", "b", "c"]);
  });
});

describe("bootSchemaErasurePlan — a cycle no order can break", () => {
  const MUTUAL_RESTRICT = manifestOf({
    entities: [
      { name: "A", fields: [{ name: "b", type: { kind: "reference", target: "B" } }] },
      { name: "B", fields: [{ name: "a", type: { kind: "reference", target: "A" } }] },
    ],
  });

  it("names both entities in blockingCycle when neither reference is droppable", () => {
    // Neither relation is declared, so both FKs are ON DELETE RESTRICT: whichever table goes first,
    // the database refuses it while the other still holds a referencing row. There is no order to
    // choose, which is a different answer from a worse order — so it is said rather than attempted,
    // before the pipeline's transaction has dropped anything.
    const plan = bootSchemaErasurePlan(MUTUAL_RESTRICT);
    expect(plan.blockingCycle).toEqual(["A", "B"]);
    expect(plan.relaxed).toEqual([]);
  });

  it("keeps the target list total, so a report can still name every table", () => {
    // The store created both tables; an erasure that dropped a cyclic entity from the list would
    // sign a proof over its rows. Only the *order* among these members has no property.
    expect([...tablesOf(MUTUAL_RESTRICT)].sort()).toEqual(["a", "b"]);
  });

  it("lets a set_null beside a restrict still block, because the strongest policy wins", () => {
    // Two columns onto one parent are two separate constraints. The nulling one is satisfiable in
    // either direction and the restricting one is not, so the pair is as blocked as if the first
    // were not declared at all.
    const onlyNulling = manifestOf({
      entities: [
        { name: "A", fields: [{ name: "primary_b", type: { kind: "reference", target: "B" } }] },
        { name: "B", fields: [{ name: "a", type: { kind: "reference", target: "A" } }] },
      ],
      relations: [
        { kind: "many_to_one", from: "A", field: "primary_b", to: "B", onDelete: "set_null" },
      ],
    });
    const alsoRestricting = manifestOf({
      entities: [
        {
          name: "A",
          fields: [
            { name: "primary_b", type: { kind: "reference", target: "B" } },
            { name: "secondary_b", type: { kind: "reference", target: "B" } },
          ],
        },
        { name: "B", fields: [{ name: "a", type: { kind: "reference", target: "A" } }] },
      ],
      relations: [
        { kind: "many_to_one", from: "A", field: "primary_b", to: "B", onDelete: "set_null" },
      ],
    });
    expect(bootSchemaErasurePlan(onlyNulling).blockingCycle).toEqual([]);
    expect(bootSchemaErasurePlan(alsoRestricting).blockingCycle).toEqual(["A", "B"]);
  });
});

describe("bootSchemaErasurePlan — which references count", () => {
  const PAIR: readonly Entity[] = [
    { name: "A", fields: [{ name: "b", type: { kind: "reference", target: "B" } }] },
    { name: "B", fields: [{ name: "a", type: { kind: "reference", target: "A" } }] },
  ];
  const BARE = manifestOf({ entities: PAIR });

  it("ignores an onDelete declared on a field that is not a reference column", () => {
    // The lookup is keyed `"<entity>.<field>"` against the planned columns, the same spelling
    // `emitManifestSchemaDdl` uses — so a policy naming a field that carries no FK describes no
    // emitted constraint and must not weaken the order.
    const stray = manifestOf({
      entities: PAIR,
      relations: [{ kind: "many_to_one", from: "A", field: "nope", to: "B", onDelete: "set_null" }],
    });
    expect(bootSchemaErasurePlan(stray)).toEqual(bootSchemaErasurePlan(BARE));
  });

  it("ignores an onDelete declared for an entity the manifest does not have", () => {
    const ghost = manifestOf({
      entities: PAIR,
      relations: [{ kind: "many_to_one", from: "Ghost", field: "b", to: "B", onDelete: "cascade" }],
    });
    expect(bootSchemaErasurePlan(ghost)).toEqual(bootSchemaErasurePlan(BARE));
  });

  it("excludes a self-reference, which cannot be a cycle of one", () => {
    // Measured on PostgreSQL 16.13: with the erasure's single-statement shape a self-referencing
    // ON DELETE RESTRICT does not refuse the bulk delete, because the referencing rows go in the
    // same statement. There is no order to choose inside one table either way.
    const selfRef = manifestOf({
      entities: [
        {
          name: "Node",
          fields: [{ name: "parent", type: { kind: "reference", target: "Node" } }],
        },
      ],
    });
    const plan = bootSchemaErasurePlan(selfRef);
    expect(plan.blockingCycle).toEqual([]);
    expect(plan.targets).toEqual([{ schema: "public", table: "node" }]);
  });
});

describe("bootSchemaErasurePlan — join tables", () => {
  const M2M = manifestOf({
    entities: [
      { name: "Course", fields: [{ name: "code", type: { kind: "text" } }] },
      { name: "Student", fields: [{ name: "name", type: { kind: "text" } }] },
    ],
    relations: [{ kind: "many_to_many", left: "Course", right: "Student" }],
  });

  it("contributes a many_to_many relation's join table", () => {
    expect(tablesOf(M2M)).toContain("course_student");
  });

  it("names the join table before either entity table", () => {
    // Both of the join table's FKs are ON DELETE CASCADE, so leaving it out would not be refused —
    // the entity deletes would take its rows away while the proof named neither the table nor them.
    // Neither entity references the other, so the two have no required order between them and the
    // manifest's declaration order is used for determinism.
    const tables = tablesOf(M2M);
    expect(tables.indexOf("course_student")).toBe(0);
    expect(tables).toEqual(["course_student", "course", "student"]);
  });

  it("names a join table whose sides are absent, because the store still creates it", () => {
    const orphan = manifestOf({ relations: [{ kind: "many_to_many", left: "A", right: "B" }] });
    expect(bootSchemaErasureTargets(orphan)).toEqual([{ schema: "public", table: "a_b" }]);
  });

  it("derives the self-relation's single table, not two", () => {
    const self = manifestOf({
      entities: [{ name: "Person", fields: [{ name: "name", type: { kind: "text" } }] }],
      relations: [{ kind: "many_to_many", left: "Person", right: "Person" }],
    });
    expect(tablesOf(self)).toEqual(["person_person", "person"]);
  });

  it("ignores a relation that is not many_to_many", () => {
    const m2o = manifestOf({
      entities: [ORDER, ACCOUNT],
      relations: [{ kind: "many_to_one", from: "Order", field: "account", to: "Account" }],
    });
    expect(tablesOf(m2o)).toEqual(["order", "account"]);
  });

  it("names every table the store's DDL creates, and nothing else", () => {
    // The rule this module rests on: the function that creates these tables is the only thing
    // entitled to name them. Compared against the emitted DDL as a set, in both directions.
    const plans = columnPlansForManifest(M2M, { schema: "public" });
    const joins = joinTablePlansForManifest(M2M, { schema: "public" });
    const created = emitManifestSchemaDdl(plans, joins)
      .map((s) => /^CREATE TABLE IF NOT EXISTS "public"\."([a-z_]+)"/.exec(s)?.[1])
      .filter((t): t is string => t !== undefined);
    expect([...tablesOf(M2M)].sort()).toEqual([...created].sort());
  });
});

describe("bootSchemaErasurePlan — the schema", () => {
  it("has one exported spelling of the column store's default", () => {
    // A second spelling of this default is the defect the module exists to close: a different one
    // here would aim the erasure at a schema the store never wrote to, find nothing, and report an
    // honest zero the proof would sign as `nothing_to_erase`.
    expect(COLUMN_STORE_DEFAULT_SCHEMA).toBe("public");
  });

  it("defaults to that constant", () => {
    expect(bootSchemaErasureTargets(manifestOf({ entities: [ACCOUNT] }))).toEqual([
      { schema: COLUMN_STORE_DEFAULT_SCHEMA, table: "account" },
    ]);
  });

  it("carries an explicit schema onto every target", () => {
    const targets = bootSchemaErasureTargets(CHAIN, { schema: "tenant_app" });
    expect(targets.every((t) => t.schema === "tenant_app")).toBe(true);
    expect(targets).toHaveLength(3);
  });

  it("defaults when opts is supplied with no schema", () => {
    expect(bootSchemaErasureTargets(manifestOf({ entities: [ACCOUNT] }), {})).toEqual([
      { schema: "public", table: "account" },
    ]);
  });

  it("refuses a schema name that is not an identifier", () => {
    expect(() => bootSchemaErasurePlan(CHAIN, { schema: "bad; DROP" })).toThrow(/invalid schema/);
  });

  it("refuses a bad schema even for a manifest with no entities", () => {
    // The entity path validates per entity, so with none there is nothing to refuse there; the
    // target list is interpolated into `DELETE FROM <schema>.<table>` either way.
    expect(() => bootSchemaErasurePlan(manifestOf({}), { schema: "pg_catalog; --" })).toThrow(
      /invalid schema/,
    );
  });
});

describe("bootSchemaErasurePlan — the empty cases", () => {
  it("yields [] for a manifest with no entities and no relations", () => {
    expect(bootSchemaErasurePlan(manifestOf({}))).toEqual({
      targets: [],
      blockingCycle: [],
      relaxed: [],
    });
  });

  it("yields [] for explicitly empty entities and relations", () => {
    expect(bootSchemaErasureTargets(manifestOf({ entities: [], relations: [] }))).toEqual([]);
  });

  it("yields [] rather than throwing, so an empty list is a sayable answer", () => {
    // `--store pg` and `--store memory` have no column tables at all, and the erasure's required
    // target list treats [] as the signed assertion that there were none.
    expect(bootSchemaErasureTargets(manifestOf({}), { schema: "public" })).toHaveLength(0);
  });
});

describe("bootSchemaErasurePlan — one physical table named once", () => {
  it("names a table once when two entities snake-case onto it", () => {
    // `toTableName` is not injective: the store serves both entities as one merged table, so a
    // doubled target would double-count the storageBytes figure the proof commits to.
    const collide = manifestOf({
      entities: [
        { name: "OrderLine", fields: [{ name: "a", type: { kind: "text" } }] },
        { name: "Order_Line", fields: [{ name: "b", type: { kind: "text" } }] },
      ],
    });
    expect(bootSchemaErasureTargets(collide)).toEqual([{ schema: "public", table: "order_line" }]);
  });

  it("names a table once when an entity collides with a join table", () => {
    const collide = manifestOf({
      entities: [
        { name: "Course", fields: [{ name: "code", type: { kind: "text" } }] },
        { name: "Student", fields: [{ name: "name", type: { kind: "text" } }] },
        { name: "CourseStudent", fields: [{ name: "grade", type: { kind: "text" } }] },
      ],
      relations: [{ kind: "many_to_many", left: "Course", right: "Student" }],
    });
    const tables = tablesOf(collide);
    expect(tables.filter((t) => t === "course_student")).toHaveLength(1);
    // The join position wins, and the three entities constrain each other not at all, so the rest
    // follows the manifest's declaration order.
    expect(tables).toEqual(["course_student", "course", "student"]);
  });

  it("keeps same-named tables in different schemas apart", () => {
    const one = bootSchemaErasureTargets(manifestOf({ entities: [ACCOUNT] }));
    const other = bootSchemaErasureTargets(manifestOf({ entities: [ACCOUNT] }), { schema: "app" });
    expect([...one, ...other]).toEqual([
      { schema: "public", table: "account" },
      { schema: "app", table: "account" },
    ]);
  });
});

describe("bootSchemaErasurePlan — a manifest this store cannot serve", () => {
  it("throws rather than returning a short list", () => {
    // `duration` compiles to INTERVAL, which has no decided wire type, so the store refuses to plan
    // it and never created the table. A target list missing an entity would be worse than a refusal:
    // the proof would be signed over whatever that entity still holds.
    const withDuration = manifestOf({
      entities: [
        ACCOUNT,
        { name: "Session", fields: [{ name: "elapsed", type: { kind: "duration" } }] },
      ],
    });
    expect(() => bootSchemaErasurePlan(withDuration)).toThrow(/duration/);
  });
});

describe("bootSchemaErasureTargets", () => {
  it("is exactly the plan's targets, for a caller that has dealt with the cycle", () => {
    for (const manifest of [CHAIN, CYCLIC, manifestOf({})]) {
      expect(bootSchemaErasureTargets(manifest)).toEqual(bootSchemaErasurePlan(manifest).targets);
    }
  });

  it("passes its schema option through", () => {
    expect(bootSchemaErasureTargets(CHAIN, { schema: "app" })).toEqual(
      bootSchemaErasurePlan(CHAIN, { schema: "app" }).targets,
    );
  });
});
