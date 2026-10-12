import type { PgConnection } from "@crossengin/kernel-pg";
import { META_TABLES } from "@crossengin/kernel/bootstrap";
import { STORELESS_TABLES } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import {
  LIVE_USER_FK_WRITERS,
  PRINCIPAL_READINESS,
  USER_REGISTRY_STATES,
  formatUserFkReadiness,
  readinessOf,
  surveyUserFkReadiness,
} from "./user-fk-readiness.js";

const NAMED = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";

type Row = Record<string, unknown>;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface FakeOptions {
  readonly exists?: boolean;
  readonly canSelect?: boolean;
  readonly canInsert?: boolean;
  readonly present?: readonly string[];
  readonly references?: readonly Row[];
  /** Which statement kind should throw: the catalog probe, the reference load, or the id read. */
  readonly throwOn?: "catalog" | "references" | "present";
}

/**
 * Answers the three statements the probe issues, by recognising them rather than by position — the
 * probe must stay free to stop issuing one (an absent registry never loads references), and a
 * positional fake would silently hand the next answer to the wrong question.
 */
function fakeDb(opts: FakeOptions = {}): { conn: PgConnection; captured: Captured[] } {
  const captured: Captured[] = [];
  const exists = opts.exists ?? true;
  const run = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    captured.push({ sql, params: params ?? [] });
    if (sql.includes("has_table_privilege")) {
      if (opts.throwOn === "catalog") throw new Error("connection refused");
      return {
        rows: [
          {
            role: "app_user",
            table_exists: exists,
            can_select: exists && (opts.canSelect ?? true),
            can_insert: exists && (opts.canInsert ?? true),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("pg_constraint")) {
      if (opts.throwOn === "references") throw new Error("catalog unavailable");
      const rows = [...(opts.references ?? DEFAULT_REFERENCES)];
      return { rows, rowCount: rows.length };
    }
    if (opts.throwOn === "present") throw new Error("permission denied");
    const rows = (opts.present ?? []).map((id) => ({ id }));
    return { rows, rowCount: rows.length };
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(conn),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
  return { conn, captured };
}

// Three references, two of which have a live writer, so `blocked` is a real filter rather than the
// whole list. `ml_models` is one of the 34 declared writerless: the reference exists and nothing can
// hit it, which is exactly the row that must not be reported as blocking a boot.
const DEFAULT_REFERENCES: readonly Row[] = [
  { tbl: "notification_read_states", col: "user_id", on_delete: "c" },
  { tbl: "user_tenant_membership", col: "user_id", on_delete: "r" },
  { tbl: "ml_models", col: "created_by", on_delete: "r" },
];

describe("the enums", () => {
  it("names four registry states and three per-principal verdicts", () => {
    expect(USER_REGISTRY_STATES).toEqual(["readable", "unreadable", "absent", "unreachable"]);
    expect(PRINCIPAL_READINESS).toEqual(["provisioned", "absent", "unknown"]);
  });

  it("separates 'the row is absent' from 'we could not check'", () => {
    // The whole point of the probe: these must not collapse, because one names work an operator
    // has to do and the other names a thing this process could not see.
    expect(new Set(PRINCIPAL_READINESS).has("absent")).toBe(true);
    expect(new Set(PRINCIPAL_READINESS).has("unknown")).toBe(true);
  });
});

describe("LIVE_USER_FK_WRITERS", () => {
  it("names only tables the catalog declares with a NOT NULL reference into meta.users", () => {
    const notNullFkTables = new Set<string>();
    for (const table of META_TABLES) {
      for (const column of table.columns) {
        const ref = column.references;
        if (ref?.schema === "meta" && ref.table === "users" && column.notNull === true) {
          notNullFkTables.add(table.name);
        }
      }
    }
    // A subset and not an equality: the other tables in that set join this list the moment somebody
    // writes a store for one, and demanding equality would fail on their correct increment. The
    // both-directions census lives in packages/testing/src/strategy/pg-storeless-tables.ts.
    for (const name of LIVE_USER_FK_WRITERS) {
      expect(notNullFkTables, `${name} has no NOT NULL meta.users reference`).toContain(name);
    }
    // And a floor, so a list emptied by a bad edit fails here rather than reporting nothing blocked.
    expect(LIVE_USER_FK_WRITERS.length).toBeGreaterThanOrEqual(5);
    // 39 distinct tables over 42 references (three — forensic_evidence, legal_holds,
    // ediscovery_requests — carry two each), so the floor is a vacuity guard and not the count.
    expect(notNullFkTables.size).toBeGreaterThanOrEqual(35);
  });

  it("holds exactly the live writers the catalog and the storeless census agree on", () => {
    // The equality the test above deliberately avoids, computed rather than restated: a table is on
    // this list iff it declares a NOT NULL `meta.users` reference *and* `STORELESS_TABLES` does not
    // declare it writerless. So somebody writing a store for one of the other 37 does not fail
    // here — their increment deletes that table's declaration, which moves it into this set, and
    // this test then names it. A hand-maintained copy is ADR-0288's `needsAuditEmitter`.
    const storeless = new Set(STORELESS_TABLES.map((d) => d.table.replace(/^meta\./, "")));
    const derived = new Set<string>();
    for (const table of META_TABLES) {
      if (storeless.has(table.name)) continue;
      for (const column of table.columns) {
        const ref = column.references;
        if (ref?.schema === "meta" && ref.table === "users" && column.notNull === true) {
          derived.add(table.name);
        }
      }
    }
    expect([...derived].sort()).toEqual([...LIVE_USER_FK_WRITERS]);
  });

  it("keeps the two kinds the surviving references are, which is why they survived", () => {
    // Three `CASCADE` tables hold a user's own per-viewer state and must go when the user does; two
    // `RESTRICT` ones are *about* the user. The six that became TEXT in this increment were neither:
    // they recorded which principal acted, and ADR-0318/ADR-0321 had already concluded twice that a
    // `RESTRICT` reference for that makes a user undeletable *because* they did something.
    const onDelete = new Map<string, string>();
    for (const table of META_TABLES) {
      for (const column of table.columns) {
        const ref = column.references;
        if (ref?.schema === "meta" && ref.table === "users" && column.notNull === true) {
          // An omitted `ON DELETE` is the RESTRICT the emitter writes — `canonical.ts` folds the two
          // for exactly this reason, so reading them apart here would invent a third answer.
          if (LIVE_USER_FK_WRITERS.includes(table.name)) {
            onDelete.set(table.name, ref.onDelete ?? "RESTRICT");
          }
        }
      }
    }
    expect(onDelete.get("notification_read_states")).toBe("CASCADE");
    expect(onDelete.get("notification_read_watermarks")).toBe("CASCADE");
    expect(onDelete.get("notification_digests")).toBe("CASCADE");
    expect(onDelete.get("notification_preferences")).toBe("RESTRICT");
    expect(onDelete.get("user_tenant_membership")).toBe("RESTRICT");
  });

  it("is sorted and free of duplicates", () => {
    expect([...LIVE_USER_FK_WRITERS].sort()).toEqual([...LIVE_USER_FK_WRITERS]);
    expect(new Set(LIVE_USER_FK_WRITERS).size).toBe(LIVE_USER_FK_WRITERS.length);
  });
});

describe("surveyUserFkReadiness", () => {
  it("refuses an invalid schema identifier", async () => {
    const { conn } = fakeDb();
    await expect(surveyUserFkReadiness(conn, [], { schema: "me ta" })).rejects.toThrow(
      /invalid schema/,
    );
  });

  it("asks the catalog for existence and privilege in one statement with no branch that can raise", async () => {
    const { conn, captured } = fakeDb({ present: [NAMED] });
    await surveyUserFkReadiness(conn, [NAMED]);
    const probe = captured[0];
    expect(probe?.sql).toMatch(/to_regclass\(\$1\) IS NOT NULL AS table_exists/);
    // The oid overload, not the name one: the name form raises on an absent table, which would make
    // 'absent' indistinguishable from 'unreachable'.
    expect(probe?.sql).toMatch(/has_table_privilege\(current_user, to_regclass\(\$1\), 'SELECT'\)/);
    expect(probe?.params).toEqual(["meta.users"]);
  });

  it("reports every named principal as provisioned when each has a row", async () => {
    const { conn } = fakeDb({ present: [NAMED, OTHER] });
    const report = await surveyUserFkReadiness(conn, [NAMED, OTHER]);
    expect(report.registry).toBe("readable");
    expect(report.provisioned).toEqual([NAMED, OTHER]);
    expect(report.absent).toEqual([]);
    expect(report.blocked).toEqual([]);
    expect(formatUserFkReadiness(report)).toBeNull();
  });

  it("names the absent principals and the written columns that will raise 23503", async () => {
    const { conn } = fakeDb({ present: [NAMED] });
    const report = await surveyUserFkReadiness(conn, [NAMED, OTHER]);
    expect(report.absent).toEqual([OTHER]);
    expect(report.provisioned).toEqual([NAMED]);
    expect(report.blocked).toEqual([
      { table: "notification_read_states", column: "user_id" },
      { table: "user_tenant_membership", column: "user_id" },
    ]);
    const line = formatUserFkReadiness(report) ?? "";
    expect(line).toMatch(/unprovisioned principal: /);
    expect(line).toMatch(/will raise 23503: notification_read_states\.user_id/);
  });

  it("excludes a reference whose table has no live writer from `blocked`", async () => {
    const { conn } = fakeDb({ present: [] });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    // `meta.ml_models` carries the same NOT NULL reference and nothing writes it, so naming it
    // would send an operator after a failure that cannot happen.
    expect(report.references.map((r) => r.table)).toContain("ml_models");
    expect(report.blocked.map((b) => b.table)).not.toContain("ml_models");
  });

  it("spells confdeltype out, so a log line says RESTRICT rather than 'r'", async () => {
    const { conn } = fakeDb({ present: [NAMED], references: [{ tbl: "x", col: "y", on_delete: "r" }] });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    expect(report.references[0]?.onDelete).toBe("RESTRICT");
  });

  it("passes an unrecognised confdeltype through rather than inventing a word for it", async () => {
    const { conn } = fakeDb({ present: [NAMED], references: [{ tbl: "x", col: "y", on_delete: "?" }] });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    expect(report.references[0]?.onDelete).toBe("?");
  });

  it("answers `absent` with every principal `unknown` when the table does not exist", async () => {
    const { conn } = fakeDb({ exists: false });
    const report = await surveyUserFkReadiness(conn, [NAMED, OTHER]);
    expect(report.registry).toBe("absent");
    expect(report.unknown).toEqual([NAMED, OTHER]);
    expect(report.absent).toEqual([]);
    expect(report.detail).toMatch(/does not exist/);
  });

  it("does not try to read the ids when the table does not exist", async () => {
    const { conn, captured } = fakeDb({ exists: false });
    await surveyUserFkReadiness(conn, [NAMED]);
    expect(captured.some((c) => c.sql.includes("WHERE id = ANY"))).toBe(false);
  });

  it("answers `unreadable`, not `absent`, when the role cannot SELECT", async () => {
    const { conn } = fakeDb({ canSelect: false });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    expect(report.registry).toBe("unreadable");
    expect(report.unknown).toEqual([NAMED]);
    // The defect this arm exists for: a zero-row answer would otherwise print a list of principals
    // that are perfectly fine.
    expect(report.absent).toEqual([]);
    expect(report.detail).toMatch(/indistinguishable/);
  });

  it("does not read the ids when it may not read them", async () => {
    const { conn, captured } = fakeDb({ canSelect: false });
    await surveyUserFkReadiness(conn, [NAMED]);
    expect(captured.some((c) => c.sql.includes("WHERE id = ANY"))).toBe(false);
  });

  it("answers `unreachable` when the catalog probe itself fails", async () => {
    const { conn } = fakeDb({ throwOn: "catalog" });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    expect(report.registry).toBe("unreachable");
    expect(report.unknown).toEqual([NAMED]);
    expect(report.detail).toMatch(/connection refused/);
  });

  it("answers `unreachable` when the reference load fails", async () => {
    const { conn } = fakeDb({ throwOn: "references" });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    expect(report.registry).toBe("unreachable");
  });

  it("answers `unreachable` when the id read fails after a readable catalog", async () => {
    const { conn } = fakeDb({ throwOn: "present" });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    expect(report.registry).toBe("unreachable");
    expect(report.references.length).toBeGreaterThan(0);
    expect(report.unknown).toEqual([NAMED]);
  });

  it("warns separately when the role can read but not insert", async () => {
    const { conn } = fakeDb({ canInsert: false, present: [] });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    expect(report.canSelect).toBe(true);
    expect(report.canInsert).toBe(false);
    expect(formatUserFkReadiness(report)).toMatch(/no INSERT privilege/);
  });

  it("says nothing about INSERT when there is nothing to fix", async () => {
    const { conn } = fakeDb({ canInsert: false, present: [NAMED] });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    expect(formatUserFkReadiness(report)).toBeNull();
  });

  it("deduplicates and sorts the checked ids and drops non-uuids", async () => {
    const { conn, captured } = fakeDb({ present: [] });
    const report = await surveyUserFkReadiness(conn, [OTHER, NAMED, NAMED, "", "not-a-uuid"]);
    expect(report.checked).toEqual([NAMED, OTHER]);
    const read = captured.find((c) => c.sql.includes("WHERE id = ANY"));
    expect(read?.params).toEqual([[NAMED, OTHER]]);
  });

  it("matches a stored id case-insensitively, since a UUID is not case-sensitive", async () => {
    const { conn } = fakeDb({ present: [NAMED.toUpperCase()] });
    const report = await surveyUserFkReadiness(conn, [NAMED]);
    expect(report.provisioned).toEqual([NAMED]);
  });

  it("reports nothing and is silent with no principals to check", async () => {
    const { conn, captured } = fakeDb();
    const report = await surveyUserFkReadiness(conn, []);
    expect(report.registry).toBe("readable");
    expect(report.checked).toEqual([]);
    expect(formatUserFkReadiness(report)).toBeNull();
    expect(captured.some((c) => c.sql.includes("WHERE id = ANY"))).toBe(false);
  });

  it("filters the reference query to NOT NULL columns and to foreign keys", async () => {
    const { conn, captured } = fakeDb({ present: [NAMED] });
    await surveyUserFkReadiness(conn, [NAMED]);
    const refs = captured.find((c) => c.sql.includes("pg_constraint"));
    expect(refs?.sql).toMatch(/k\.contype = 'f'/);
    expect(refs?.sql).toMatch(/a\.attnotnull/);
    expect(refs?.sql).toMatch(/k\.confrelid = to_regclass\(\$1\)/);
    expect(refs?.params).toEqual(["meta.users", "meta"]);
  });

  it("honours a non-default schema in every statement", async () => {
    const { conn, captured } = fakeDb({ present: [NAMED] });
    await surveyUserFkReadiness(conn, [NAMED], { schema: "shadow" });
    expect(captured[0]?.params).toEqual(["shadow.users"]);
    expect(captured.find((c) => c.sql.includes("WHERE id = ANY"))?.sql).toMatch(/shadow\.users/);
  });
});

describe("readinessOf", () => {
  it("answers per principal from the three lists", async () => {
    const { conn } = fakeDb({ present: [NAMED] });
    const report = await surveyUserFkReadiness(conn, [NAMED, OTHER]);
    expect(readinessOf(report, NAMED)).toBe("provisioned");
    expect(readinessOf(report, OTHER)).toBe("absent");
    // An id nobody asked about is `unknown` rather than `absent`: the probe never looked.
    expect(readinessOf(report, "00000000-0000-4000-8000-00000000000c")).toBe("unknown");
  });
});
