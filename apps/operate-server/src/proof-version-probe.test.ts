import type { PgConnection } from "@crossengin/kernel-pg";
import { TOMBSTONE_PROOF_VERSIONS } from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  PROOF_VERSION_CHECK_STATES,
  formatProofVersionCheck,
  probeProofVersionCheck,
  proofVersionCheckBlocksDeletion,
  proofVersionCheckRemedy,
  type ProofVersionCheckState,
} from "./proof-version-probe.js";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeOptions {
  /** `undefined` leaves the column present with no CHECK; a string is the deparsed definition. */
  readonly definition?: string | null;
  readonly columnExists?: boolean;
  /** No row at all — the table itself is not there. */
  readonly noRows?: boolean;
  readonly throws?: unknown;
}

/**
 * Answers the one statement the probe issues, and **throws on anything else**.
 *
 * ADR-0350's rule about fakes, applied to a one-statement module: an empty `{rows: []}` fallback
 * would be the `absent` answer, so a statement whose shape later changed would make every assertion
 * about what the probe *found* pass vacuously while reporting that the catalog had not been applied.
 */
function fakeDb(opts: FakeOptions = {}): { conn: PgConnection; captured: Captured[] } {
  const captured: Captured[] = [];
  const run = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    captured.push({ sql, params: params ?? [] });
    if (!sql.includes("pg_get_constraintdef")) {
      throw new Error(`fake asked a statement it cannot serve: ${sql}`);
    }
    if (opts.throws !== undefined) throw opts.throws;
    if (opts.noRows === true) return { rows: [], rowCount: 0 };
    return {
      rows: [
        {
          definition: opts.definition ?? null,
          column_exists: opts.columnExists ?? true,
        },
      ],
      rowCount: 1,
    };
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
  return { conn, captured };
}

/**
 * Postgres's own rendering of the catalog's `IN (…)` over the versions named — **asked of Postgres
 * rather than guessed**, which is how this file found the probe's shape test too narrow.
 *
 * Both forms were read off `pg_get_constraintdef` on PG 16.13 for the identical
 * `CHECK (proof_version IN ('v1', …))`, differing only in the column's declared type. The catalog
 * declares TEXT, so `text` is what a correctly-applied database holds; `varchar` is what a drifted
 * column renders, and it is the one whose extra paren the first version of `ANY_ARRAY_SHAPE`
 * rejected. Writing the varchar spelling by mistake is what surfaced that.
 */
function deparsed(versions: readonly string[], as: "text" | "varchar" = "text"): string {
  if (as === "varchar") {
    const items = versions.map((v) => `'${v}'::character varying`).join(", ");
    return `CHECK (((proof_version)::text = ANY ((ARRAY[${items}])::text[])))`;
  }
  const items = versions.map((v) => `'${v}'::text`).join(", ");
  return `CHECK ((proof_version = ANY (ARRAY[${items}])))`;
}

describe("PROOF_VERSION_CHECK_STATES", () => {
  it("names the five states, refusal first among the non-trivial ones", () => {
    expect(PROOF_VERSION_CHECK_STATES).toEqual([
      "admits",
      "refuses",
      "unconstrained",
      "absent",
      "unreadable",
    ]);
  });

  it("has more than one version to compare, so the refusal fixtures are not vacuous", () => {
    // Every `refuses` case below is built by omitting the last member. With one version declared
    // there would be nothing to omit and the whole refusal half of this file would assert nothing.
    expect(TOMBSTONE_PROOF_VERSIONS.length).toBeGreaterThan(1);
  });
});

describe("probeProofVersionCheck", () => {
  it("admits a CHECK naming every version this binary emits", async () => {
    const { conn } = fakeDb({ definition: deparsed([...TOMBSTONE_PROOF_VERSIONS]) });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("admits");
    expect(probe.missing).toEqual([]);
    expect(probe.definition).toContain("= ANY");
  });

  it("refuses a CHECK missing the newest version, and names exactly what is missing", async () => {
    const last = TOMBSTONE_PROOF_VERSIONS[TOMBSTONE_PROOF_VERSIONS.length - 1];
    const older = TOMBSTONE_PROOF_VERSIONS.slice(0, -1);
    const { conn } = fakeDb({ definition: deparsed([...older]) });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("refuses");
    expect(probe.missing).toEqual([last]);
    // The detail is what an operator reads before they understand the failure, so it carries the
    // SQLSTATE *and* where in the pipeline it lands — the part that makes it urgent.
    expect(probe.detail).toContain("23514");
    expect(probe.detail).toContain("after the tenant's data has been deleted");
    expect(probe.detail).toContain("in_progress");
  });

  it("names every missing version, not just the first", async () => {
    const { conn } = fakeDb({ definition: deparsed(["v1"]) });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("refuses");
    expect(probe.missing).toEqual(TOMBSTONE_PROOF_VERSIONS.filter((v) => v !== "v1"));
  });

  it("reads both spellings Postgres produces for one IN check", async () => {
    // The catalog declares TEXT and that is the spelling every applied database holds; a column
    // drifted to VARCHAR renders an extra paren and a `::text[]` cast. Since an unreadable shape
    // *mounts*, a spelling this probe could read and did not would leave the 23514 in place behind
    // a warning — which is what the first version of the shape test did.
    for (const as of ["text", "varchar"] as const) {
      const full = fakeDb({ definition: deparsed([...TOMBSTONE_PROOF_VERSIONS], as) });
      expect((await probeProofVersionCheck(full.conn, "meta")).state).toBe("admits");
      const partial = fakeDb({ definition: deparsed(["v1"], as) });
      expect((await probeProofVersionCheck(partial.conn, "meta")).state).toBe("refuses");
    }
  });

  it("asks for a quoted literal, so a version appearing bare in the expression is not a member", async () => {
    // The guard that keeps an identifier from being read as a list member. A column or function
    // named after a version would otherwise make the probe report `admits` for a CHECK that does
    // not name it — the fail-open direction.
    const { conn } = fakeDb({
      definition: `CHECK ((proof_version = ANY (ARRAY['v1'::text])) AND (v4_migrated IS NOT NULL))`,
    });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("refuses");
    expect(probe.missing).toContain("v4");
  });

  it("reports unconstrained when the column is there and carries no CHECK", async () => {
    const { conn } = fakeDb({ definition: null });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("unconstrained");
    expect(probe.missing).toEqual([]);
    expect(probe.definition).toBeNull();
    expect(probe.detail).toContain("drifted");
  });

  it("treats an empty definition as unconstrained rather than as an unreadable one", async () => {
    const { conn } = fakeDb({ definition: "" });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("unconstrained");
  });

  it("reports absent when the table yields no row", async () => {
    const { conn } = fakeDb({ noRows: true });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("absent");
    expect(probe.detail).toContain("migration applier");
  });

  it("reports absent when the relation is there and the column is not", async () => {
    const { conn } = fakeDb({ columnExists: false });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("absent");
  });

  it("reports unreadable when the catalog read throws, carrying the message", async () => {
    const { conn } = fakeDb({ throws: new Error("connection refused") });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("unreadable");
    expect(probe.detail).toContain("connection refused");
    expect(probe.detail).toContain("unknown");
  });

  it("reports unreadable for a thrown non-Error too", async () => {
    const { conn } = fakeDb({ throws: "boom" });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("unreadable");
    expect(probe.detail).toContain("boom");
  });

  it("reports unreadable — never refuses — for a CHECK in a shape it does not read", async () => {
    // The distinction the module exists to keep: "this expression is not one I can read" and "this
    // expression rejects v4" are different facts, and only the second has an ALTER as its remedy.
    // Reporting the first as the second would print a remedy for a constraint nobody can predict.
    const { conn } = fakeDb({ definition: "CHECK ((length((proof_version)::text) = 2))" });
    const probe = await probeProofVersionCheck(conn, "meta");
    expect(probe.state).toBe("unreadable");
    expect(probe.missing).toEqual([]);
    expect(probe.definition).toBe("CHECK ((length((proof_version)::text) = 2))");
    expect(probe.detail).toContain("only the first has");
  });

  it("binds the schema, the column and the table rather than interpolating them", async () => {
    const { conn, captured } = fakeDb({ definition: deparsed([...TOMBSTONE_PROOF_VERSIONS]) });
    await probeProofVersionCheck(conn, "meta");
    expect(captured).toHaveLength(1);
    const only = captured[0];
    expect(only?.params).toEqual(["meta", "proof_version", "tenant_tombstones"]);
    expect(only?.sql).not.toContain("tenant_tombstones");
  });

  it("restricts the join to a CHECK over exactly that one column", async () => {
    // Without `conkey = ARRAY[attnum]` the probe would read the four-eyes CHECK, or any other
    // table-level one, and answer about a constraint that has nothing to do with the version.
    const { conn, captured } = fakeDb({ definition: deparsed([...TOMBSTONE_PROOF_VERSIONS]) });
    await probeProofVersionCheck(conn, "meta");
    expect(captured[0]?.sql).toContain("con.conkey = ARRAY[att.attnum]");
    expect(captured[0]?.sql).toContain("con.contype = 'c'");
  });

  it("refuses a schema identifier it cannot bind, before opening a statement", async () => {
    const { conn, captured } = fakeDb();
    await expect(probeProofVersionCheck(conn, "me ta")).rejects.toThrow(/invalid schema/);
    await expect(probeProofVersionCheck(conn, 'meta"; DROP TABLE x --')).rejects.toThrow(
      /invalid schema/,
    );
    // The schema is the one part of the statement that *is* interpolated into no SQL — it is bound
    // as `$1` — but it also names what the probe reports on, so a garbled one must not read as
    // `absent`, which is a mountable state.
    expect(captured).toEqual([]);
  });
});

describe("proofVersionCheckBlocksDeletion", () => {
  it("blocks on refuses and on nothing else", () => {
    const blocking = PROOF_VERSION_CHECK_STATES.filter((s) => proofVersionCheckBlocksDeletion(s));
    expect(blocking).toEqual(["refuses"]);
  });

  it("mounts on absent and unreadable, which is the asymmetry", () => {
    // ADR-0334's `missing`-versus-`unreachable`: an observed omission has one ALTER as its remedy,
    // while at boot the database may simply not be up, and refusing on an unestablished fact would
    // refuse a deployment that works.
    const unestablished: ProofVersionCheckState[] = ["absent", "unreadable"];
    for (const state of unestablished) {
      expect(proofVersionCheckBlocksDeletion(state)).toBe(false);
    }
  });
});

describe("proofVersionCheckRemedy", () => {
  it("names every declared version, so it cannot fall behind the enum", () => {
    const remedy = proofVersionCheckRemedy("meta");
    for (const version of TOMBSTONE_PROOF_VERSIONS) {
      expect(remedy).toContain(`'${version}'`);
    }
  });

  it("drops the old constraint and adds the new one under the same name", () => {
    const remedy = proofVersionCheckRemedy("meta");
    expect(remedy).toContain('DROP CONSTRAINT "tenant_tombstones_proof_version_check"');
    expect(remedy).toContain('ADD CONSTRAINT "tenant_tombstones_proof_version_check"');
    expect(remedy).toContain('"meta"."tenant_tombstones"');
  });

  it("leads with the query for rows that would refuse it", () => {
    // An operator should be able to see what the widening would reject before running it, which is
    // what `constraint_needs_validation` hands over and the reason a plan may not assume it.
    const first = proofVersionCheckRemedy("meta").split("\n")[0];
    expect(first).toContain("rows that would refuse it");
  });

  it("quotes the schema it was given", () => {
    expect(proofVersionCheckRemedy("other_meta")).toContain('"other_meta"."tenant_tombstones"');
  });
});

describe("formatProofVersionCheck", () => {
  it("leads with the state, because that is what an operator greps for", async () => {
    const { conn } = fakeDb({ definition: deparsed([...TOMBSTONE_PROOF_VERSIONS]) });
    const line = formatProofVersionCheck(await probeProofVersionCheck(conn, "meta"), "meta");
    expect(line.startsWith("tombstone proof version: admits")).toBe(true);
    expect(line).not.toContain("ALTER TABLE");
  });

  it("appends the remedy only when the state blocks the deletion surfaces", async () => {
    const { conn } = fakeDb({ definition: deparsed(["v1"]) });
    const line = formatProofVersionCheck(await probeProofVersionCheck(conn, "meta"), "meta");
    expect(line).toContain("tombstone proof version: refuses");
    expect(line).toContain("ALTER TABLE");
  });

  it("says nothing about a remedy for a state it could not establish", async () => {
    for (const opts of [{ noRows: true }, { throws: new Error("down") }]) {
      const { conn } = fakeDb(opts);
      const line = formatProofVersionCheck(await probeProofVersionCheck(conn, "meta"), "meta");
      expect(line).not.toContain("ALTER TABLE");
    }
  });
});
