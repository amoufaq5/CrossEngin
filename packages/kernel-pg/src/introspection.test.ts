import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { PgConnection, PgQueryResult } from "./connection.js";
import {
  CHECK_CONSTRAINT_QUERY,
  COLUMN_QUERY,
  CONFUPDTYPE_TO_ACTION,
  FOREIGN_KEY_QUERY,
  INDEX_QUERY,
  POLICY_QUERY,
  SESSION_POLICY_VISIBILITY_COLUMNS,
  SESSION_POLICY_VISIBILITY_QUERY,
  TABLE_QUERY,
  introspectSchema,
  parseLiveSchema,
  parseSessionPolicyVisibility,
  probeSessionPolicyVisibility,
  sessionPolicyVisibilityReason,
  SessionPolicyVisibilityUnreadable,
  sessionWouldBeConfined,
  type CheckConstraintRow,
  type ColumnRow,
  type ForeignKeyRow,
  type IndexRow,
  type LiveForeignKey,
  type LivePolicy,
  type PolicyRow,
  type SessionPolicyVisibility,
  type TableRow,
} from "./introspection.js";

/** One-shot connection answering a queued result, for the single-statement probes below. */
function fakeConn(results: readonly { rows: readonly unknown[]; rowCount: number }[]): PgConnection {
  const queue = [...results];
  return {
    query: vi.fn(async <T,>(): Promise<PgQueryResult<T>> => {
      const next = queue.shift();
      if (next === undefined) throw new Error("fake asked for a result it was not given");
      return { rows: next.rows as readonly T[], rowCount: next.rowCount };
    }) as PgConnection["query"],
    transaction: async <T,>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => fn(fakeConn([])),
    withAdvisoryLock: async <T,>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<void> => undefined,
  };
}

describe("query constants", () => {
  it("declare a parameterized schema filter", () => {
    expect(TABLE_QUERY).toContain("nspname = $1");
    expect(COLUMN_QUERY).toContain("nspname = $1");
    expect(INDEX_QUERY).toContain("nspname = $1");
    expect(POLICY_QUERY).toContain("nspname = $1");
  });

  it("use pg_catalog views without database name interpolation", () => {
    for (const q of [TABLE_QUERY, COLUMN_QUERY, INDEX_QUERY, POLICY_QUERY]) {
      expect(q).not.toMatch(/postgres|crossengin|tenant/i);
    }
  });
});

describe("parseLiveSchema", () => {
  it("returns an empty schema when no tables exist", () => {
    const live = parseLiveSchema("meta", [], [], [], []);
    expect(live.schema).toBe("meta");
    expect(live.tables).toEqual([]);
  });

  it("assembles a table with its columns, indexes, and policies", () => {
    const tables: TableRow[] = [
      { schema: "meta", name: "tenants", rls_enabled: true },
    ];
    const columns: ColumnRow[] = [
      {
        table_name: "tenants",
        column_name: "id",
        data_type: "uuid",
        not_null: true,
        default_expr: "uuid_generate_v7()",
        attnum: 1,
      },
      {
        table_name: "tenants",
        column_name: "name",
        data_type: "text",
        not_null: true,
        default_expr: null,
        attnum: 2,
      },
    ];
    const indexes: IndexRow[] = [
      {
        table_name: "tenants",
        index_name: "tenants_pkey",
        is_unique: true,
        is_primary: true,
        constraint_backed: true,
        method: "btree",
        predicate: null,
        columns: ["id"],
      },
    ];
    const policies: PolicyRow[] = [
      {
        table_name: "tenants",
        policy_name: "tenant_isolation",
        using_expr: "id = current_setting('app.current_tenant_id', true)::uuid",
        check_expr: null,
        command: "*",
        roles: ["PUBLIC"],
        role_count: 1,
      },
    ];
    const live = parseLiveSchema("meta", tables, columns, indexes, policies);
    expect(live.tables).toHaveLength(1);
    const table = live.tables[0]!;
    expect(table.name).toBe("tenants");
    expect(table.rlsEnabled).toBe(true);
    expect(table.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(table.columns[0]?.defaultExpr).toBe("uuid_generate_v7()");
    expect(table.columns[1]?.defaultExpr).toBeNull();
    expect(table.indexes[0]?.primary).toBe(true);
    expect(table.policies[0]?.name).toBe("tenant_isolation");
    expect(table.policies[0]?.command).toBe("ALL");
    expect(table.policies[0]?.roles).toEqual(["PUBLIC"]);
  });

  it("distributes columns to their owning tables", () => {
    const tables: TableRow[] = [
      { schema: "meta", name: "a", rls_enabled: false },
      { schema: "meta", name: "b", rls_enabled: false },
    ];
    const columns: ColumnRow[] = [
      { table_name: "a", column_name: "x", data_type: "int", not_null: true, default_expr: null, attnum: 1 },
      { table_name: "b", column_name: "y", data_type: "int", not_null: false, default_expr: null, attnum: 1 },
      { table_name: "a", column_name: "z", data_type: "int", not_null: false, default_expr: null, attnum: 2 },
    ];
    const live = parseLiveSchema("meta", tables, columns, [], []);
    const a = live.tables.find((t) => t.name === "a");
    const b = live.tables.find((t) => t.name === "b");
    expect(a?.columns.map((c) => c.name)).toEqual(["x", "z"]);
    expect(b?.columns.map((c) => c.name)).toEqual(["y"]);
  });

  it("orphans rows whose table is not in the table list", () => {
    const tables: TableRow[] = [];
    const columns: ColumnRow[] = [
      { table_name: "ghost", column_name: "x", data_type: "int", not_null: true, default_expr: null, attnum: 1 },
    ];
    const live = parseLiveSchema("meta", tables, columns, [], []);
    expect(live.tables).toHaveLength(0);
  });

  it("treats not_null = false as isNullable = true", () => {
    const live = parseLiveSchema(
      "meta",
      [{ schema: "meta", name: "t", rls_enabled: false }],
      [
        { table_name: "t", column_name: "x", data_type: "int", not_null: false, default_expr: null, attnum: 1 },
        { table_name: "t", column_name: "y", data_type: "int", not_null: true, default_expr: null, attnum: 2 },
      ],
      [],
      [],
    );
    expect(live.tables[0]?.columns[0]?.isNullable).toBe(true);
    expect(live.tables[0]?.columns[1]?.isNullable).toBe(false);
  });
});

describe("parseLiveSchema — a policy's command and roles", () => {
  function onePolicy(over: Partial<PolicyRow>): LivePolicy {
    const live = parseLiveSchema(
      "meta",
      [{ schema: "meta", name: "t", rls_enabled: true }],
      [],
      [],
      [
        {
          table_name: "t",
          policy_name: "p",
          using_expr: "(true)",
          check_expr: null,
          command: "*",
          roles: ["PUBLIC"],
          role_count: 1,
          permissive: true,
          ...over,
        },
      ],
    );
    return live.tables[0]?.policies[0] as LivePolicy;
  }

  it("reads polpermissive as given", () => {
    expect(onePolicy({ permissive: true }).permissive).toBe(true);
    expect(onePolicy({ permissive: false }).permissive).toBe(false);
  });

  it("reports an absent polpermissive as undetermined rather than as permissive", () => {
    // Reading an absent value as the default is exactly how a restrictive policy came to look
    // permissive and get silently replaced.
    expect(onePolicy({ permissive: undefined }).permissive).toBeNull();
  });

  it("canonicalizes each polcmd character", () => {
    expect(onePolicy({ command: "*" }).command).toBe("ALL");
    expect(onePolicy({ command: "r" }).command).toBe("SELECT");
    expect(onePolicy({ command: "a" }).command).toBe("INSERT");
    expect(onePolicy({ command: "w" }).command).toBe("UPDATE");
    expect(onePolicy({ command: "d" }).command).toBe("DELETE");
  });

  it("reports an unknown polcmd as undetermined rather than as ALL", () => {
    expect(onePolicy({ command: "z" }).command).toBeNull();
  });

  it("reports a resolved role list as given", () => {
    expect(onePolicy({ roles: ["app_reader", "app_writer"], role_count: 2 }).roles).toEqual([
      "app_reader",
      "app_writer",
    ]);
  });

  it("reports roles as undetermined when an oid resolved to nothing", () => {
    // The resolved list is then a strict subset of the real grant, and comparing a subset would
    // report a narrowing nobody declared.
    expect(onePolicy({ roles: ["app_reader"], role_count: 2 }).roles).toBeNull();
  });

  it("reports both as undetermined when the row does not carry them at all", () => {
    const policy = onePolicy({ command: undefined, roles: undefined, role_count: undefined });
    expect(policy.command).toBeNull();
    expect(policy.roles).toBeNull();
  });

  it("accepts a role list without a count, since there is nothing to contradict it", () => {
    expect(onePolicy({ roles: ["app_reader"], role_count: undefined }).roles).toEqual([
      "app_reader",
    ]);
  });
});

describe("POLICY_QUERY", () => {
  it("casts polcmd and rolname to text, because node-postgres parses neither", () => {
    // ADR-0291 broke on exactly this: a `name[]` arrives as the raw literal `{tenant_id}`.
    expect(POLICY_QUERY).toContain("p.polcmd::text");
    expect(POLICY_QUERY).toContain("r.rolname::text");
  });

  it("maps oid 0 to PUBLIC, which has no pg_roles row to join against", () => {
    expect(POLICY_QUERY).toContain("t.rid = 0 THEN 'PUBLIC'");
    expect(POLICY_QUERY).toContain("LEFT JOIN pg_roles");
  });

  it("asks for the unresolved count alongside the resolved list", () => {
    expect(POLICY_QUERY).toContain("cardinality(p.polroles) AS role_count");
  });

  it("orders the role list, so oid order cannot read as a difference", () => {
    expect(POLICY_QUERY).toContain("ORDER BY 1");
  });
});

describe("introspectSchema", () => {
  it("issues the six catalog queries in parallel and feeds them into parseLiveSchema", async () => {
    const observedSqls: string[] = [];
    const conn: PgConnection = {
      query: vi.fn(async <T,>(sql: string): Promise<PgQueryResult<T>> => {
        observedSqls.push(sql);
        if (sql.includes("relkind = 'r'") && sql.includes("relrowsecurity")) {
          return { rows: [{ schema: "meta", name: "x", rls_enabled: false }] as unknown as readonly T[], rowCount: 1 };
        }
        // Matched before the pg_attribute branch: the foreign-key query joins pg_attribute too.
        if (sql.includes("pg_constraint")) {
          return { rows: [] as readonly T[], rowCount: 0 };
        }
        if (sql.includes("pg_attribute")) {
          return { rows: [] as readonly T[], rowCount: 0 };
        }
        if (sql.includes("pg_index")) {
          return { rows: [] as readonly T[], rowCount: 0 };
        }
        if (sql.includes("pg_policy")) {
          return { rows: [] as readonly T[], rowCount: 0 };
        }
        throw new Error("unexpected SQL: " + sql);
      }) as PgConnection["query"],
      transaction: vi.fn() as PgConnection["transaction"],
      withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
      close: vi.fn() as PgConnection["close"],
    };
    const live = await introspectSchema(conn, "meta");
    expect(observedSqls).toHaveLength(6);
    expect(observedSqls.some((s) => s.includes("contype = 'f'"))).toBe(true);
    expect(observedSqls.some((s) => s.includes("contype = 'c'"))).toBe(true);
    expect(live.tables.map((t) => t.name)).toEqual(["x"]);
    expect(live.tables[0]?.foreignKeys).toEqual([]);
    expect(live.tables[0]?.checkConstraints).toEqual([]);
  });
});

describe("POLICY_QUERY — permissiveness", () => {
  it("asks for polpermissive", () => {
    expect(POLICY_QUERY).toContain("p.polpermissive AS permissive");
  });
});

describe("parseLiveSchema — a foreign key's ON UPDATE", () => {
  function oneFk(over: Partial<ForeignKeyRow>): LiveForeignKey {
    const live = parseLiveSchema(
      "meta",
      [{ schema: "meta", name: "t", rls_enabled: false }],
      [],
      [],
      [],
      [
        {
          table_name: "t",
          constraint_name: "t_parent_fkey",
          columns: ["tenant_id", "parent_id"],
          target_schema: "meta",
          target_table: "parents",
          target_columns: ["tenant_id", "id"],
          on_delete: "c",
          on_update: "a",
          ...over,
        },
      ],
    );
    return live.tables[0]?.foreignKeys[0] as LiveForeignKey;
  }

  it("keeps a composite key's columns in key order on both sides", () => {
    const fk = oneFk({});
    expect([...fk.columns]).toEqual(["tenant_id", "parent_id"]);
    expect([...fk.targetColumns]).toEqual(["tenant_id", "id"]);
  });

  it("canonicalizes confupdtype with the same codes as confdeltype", () => {
    expect(oneFk({ on_update: "a" }).onUpdate).toBe("NO ACTION");
    expect(oneFk({ on_update: "r" }).onUpdate).toBe("RESTRICT");
    expect(oneFk({ on_update: "c" }).onUpdate).toBe("CASCADE");
    expect(oneFk({ on_update: "n" }).onUpdate).toBe("SET NULL");
    expect(oneFk({ on_update: "d" }).onUpdate).toBe("SET DEFAULT");
    expect(CONFUPDTYPE_TO_ACTION["c"]).toBe("CASCADE");
  });

  it("reads an absent or unknown code as NO ACTION, which under-reports rather than invents", () => {
    expect(oneFk({ on_update: undefined }).onUpdate).toBe("NO ACTION");
    expect(oneFk({ on_update: "z" }).onUpdate).toBe("NO ACTION");
  });

  it("still reads ON DELETE independently", () => {
    expect(oneFk({ on_delete: "n", on_update: "c" }).onDelete).toBe("SET NULL");
    expect(oneFk({ on_delete: "n", on_update: "c" }).onUpdate).toBe("CASCADE");
  });
});

describe("FOREIGN_KEY_QUERY — ON UPDATE", () => {
  it("asks for confupdtype alongside confdeltype", () => {
    expect(FOREIGN_KEY_QUERY).toContain("con.confdeltype AS on_delete");
    expect(FOREIGN_KEY_QUERY).toContain("con.confupdtype AS on_update");
  });
});

describe("CHECK_CONSTRAINT_QUERY", () => {
  it("selects only CHECK constraints in the requested schema", () => {
    expect(CHECK_CONSTRAINT_QUERY).toContain("con.contype = 'c'");
    expect(CHECK_CONSTRAINT_QUERY).toContain("nspname = $1");
  });

  it("deparses the expression through pg_get_expr, as the index and policy queries do", () => {
    // That rendering is character-identical to what the ADR-0292 probe produces for the declared
    // side, which is the whole reason the comparison can be an exact string match.
    expect(CHECK_CONSTRAINT_QUERY).toContain("pg_get_expr(con.conbin, con.conrelid)");
  });

  it("casts attname to text, because node-postgres has no name[] parser", () => {
    expect(CHECK_CONSTRAINT_QUERY).toContain("a.attname::text");
  });

  it("keeps conkey in order, so a two-column rule reports both columns as declared", () => {
    expect(CHECK_CONSTRAINT_QUERY).toContain("WITH ORDINALITY");
  });

  it("interpolates no database name", () => {
    expect(CHECK_CONSTRAINT_QUERY).not.toMatch(/postgres|crossengin|tenant/i);
  });
});

describe("parseLiveSchema — check constraints", () => {
  const tables: TableRow[] = [
    { schema: "meta", name: "comms", rls_enabled: false },
    { schema: "meta", name: "other", rls_enabled: false },
  ];

  it("attaches each check to its own table", () => {
    const checks: CheckConstraintRow[] = [
      {
        table_name: "comms",
        constraint_name: "comms_bounces_check",
        expression: "(bounces_count <= recipient_count)",
        columns: ["recipient_count", "bounces_count"],
      },
      {
        table_name: "other",
        constraint_name: "other_status_check",
        expression: "(status = ANY (ARRAY['a'::text]))",
        columns: ["status"],
      },
    ];
    const live = parseLiveSchema("meta", tables, [], [], [], [], checks);
    const comms = live.tables.find((t) => t.name === "comms");
    const other = live.tables.find((t) => t.name === "other");
    expect(comms?.checkConstraints.map((c) => c.name)).toEqual(["comms_bounces_check"]);
    expect([...(comms?.checkConstraints[0]?.columns ?? [])]).toEqual([
      "recipient_count",
      "bounces_count",
    ]);
    expect(other?.checkConstraints[0]?.expression).toBe("(status = ANY (ARRAY['a'::text]))");
  });

  it("defaults to an empty list for a table with none", () => {
    const live = parseLiveSchema("meta", tables, [], [], [], [], []);
    expect(live.tables[0]?.checkConstraints).toEqual([]);
  });

  it("carries a null expression through as undetermined rather than as absent", () => {
    const live = parseLiveSchema("meta", tables, [], [], [], [], [
      { table_name: "comms", constraint_name: "c", expression: null, columns: [] },
    ]);
    expect(live.tables[0]?.checkConstraints[0]?.expression).toBeNull();
  });

  it("accepts a check that references no column at all", () => {
    const live = parseLiveSchema("meta", tables, [], [], [], [], [
      { table_name: "comms", constraint_name: "c", expression: "(true)", columns: [] },
    ]);
    expect(live.tables[0]?.checkConstraints[0]?.columns).toEqual([]);
  });

  it("groups several checks on one table in the order they arrive", () => {
    const live = parseLiveSchema("meta", tables, [], [], [], [], [
      { table_name: "comms", constraint_name: "a", expression: "(1)", columns: [] },
      { table_name: "comms", constraint_name: "b", expression: "(2)", columns: [] },
    ]);
    expect(live.tables[0]?.checkConstraints.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("defaults to no checks when the caller does not pass them, so older callers still parse", () => {
    const live = parseLiveSchema("meta", tables, [], [], []);
    expect(live.tables[0]?.checkConstraints).toEqual([]);
  });
});

/**
 * Ground truth, recorded from a live PG 16.13 cluster rather than reasoned about.
 *
 * Two tables (`plainrls` = RLS enabled, `forcedrls` = RLS enabled + FORCE) under the repo's own
 * NULLIF-guarded isolation policy, four roles, no tenant context set. `rowsSeen` is what an actual
 * `SELECT count(*)` returned out of two rows present, so `confined` is an observation and not a
 * prediction. This table exists because the predicate's whole failure mode is that a confined
 * session's `0 rows` is byte-identical to an empty table, so the only trustworthy oracle is a
 * session that really is or is not shown the rows.
 */
const LIVE_CONFINEMENT_MATRIX: readonly {
  readonly role: string;
  readonly table: string;
  readonly rowsSeen: number;
  readonly confined: boolean;
  readonly facts: SessionPolicyVisibility;
}[] = [
  // An ordinary owner is exempt until the table is FORCEd, and then it is not.
  {
    role: "r_owner",
    table: "plainrls",
    rowsSeen: 2,
    confined: false,
    facts: { role: "r_owner", policiesActive: false, rlsEnabled: true, rlsForced: false, isOwner: true, bypassesRls: false },
  },
  {
    role: "r_owner",
    table: "forcedrls",
    rowsSeen: 0,
    confined: true,
    facts: { role: "r_owner", policiesActive: true, rlsEnabled: true, rlsForced: true, isOwner: true, bypassesRls: false },
  },
  { role: "r_bypass", table: "plainrls", rowsSeen: 2, confined: false,
    facts: { role: "r_bypass", policiesActive: false, rlsEnabled: true, rlsForced: false, isOwner: false, bypassesRls: true } },
  { role: "r_bypass", table: "forcedrls", rowsSeen: 2, confined: false,
    facts: { role: "r_bypass", policiesActive: false, rlsEnabled: true, rlsForced: true, isOwner: false, bypassesRls: true } },
  { role: "r_plain", table: "plainrls", rowsSeen: 0, confined: true,
    facts: { role: "r_plain", policiesActive: true, rlsEnabled: true, rlsForced: false, isOwner: false, bypassesRls: false } },
  { role: "r_plain", table: "forcedrls", rowsSeen: 0, confined: true,
    facts: { role: "r_plain", policiesActive: true, rlsEnabled: true, rlsForced: true, isOwner: false, bypassesRls: false } },
  // The two cells no composition over these four facts can get right: `check_enable_rls` exempts a
  // superuser, and `rolsuper` is not among them. A repo-wide grep for `rolsuper` / `usesuper` /
  // `is_superuser` returns zero, so nothing here has ever been able to see it.
  { role: "r_super_nobypass", table: "plainrls", rowsSeen: 2, confined: false,
    facts: { role: "r_super_nobypass", policiesActive: false, rlsEnabled: true, rlsForced: false, isOwner: false, bypassesRls: false } },
  { role: "r_super_nobypass", table: "forcedrls", rowsSeen: 2, confined: false,
    facts: { role: "r_super_nobypass", policiesActive: false, rlsEnabled: true, rlsForced: true, isOwner: false, bypassesRls: false } },
];

describe("sessionWouldBeConfined", () => {
  it("matches live ground truth in every recorded cell", () => {
    // The assertion the previous version of this suite could not make. It pinned an exhaustive
    // truth table over the four catalog facts and compared the rule against an `ownershipOnly`
    // derivation written in the test itself — two spellings of one composition, agreeing — and
    // called the single disagreement a property. Neither side was ever compared with a database.
    for (const cell of LIVE_CONFINEMENT_MATRIX) {
      expect(sessionWouldBeConfined(cell.facts), `${cell.role} on ${cell.table}`).toBe(cell.confined);
      expect(cell.confined, `${cell.role} on ${cell.table}: rowsSeen must agree with confined`).toBe(
        cell.rowsSeen === 0,
      );
    }
  });

  it("scores the retired composition at 6 of 8, both misses on the superuser", () => {
    // Kept, and derived rather than restated, so the reason the verdict moved to Postgres stays in
    // the suite instead of only in an ADR. The misses are in the conservative direction — claiming
    // confined where the session is free — which is why this was a precision gain and not a hole.
    const composed = (v: SessionPolicyVisibility): boolean =>
      v.rlsEnabled && !(v.rlsForced ? v.bypassesRls : v.isOwner || v.bypassesRls);
    const wrong = LIVE_CONFINEMENT_MATRIX.filter((c) => composed(c.facts) !== c.confined);
    expect(wrong.map((c) => `${c.role}/${c.table}`)).toEqual([
      "r_super_nobypass/plainrls",
      "r_super_nobypass/forcedrls",
    ]);
    for (const c of wrong) expect(composed(c.facts), "conservative direction").toBe(true);
  });

  it("scores an ownership-only composition at 5 of 8, and its extra miss is the dangerous one", () => {
    // What `probeJobQueueVisibility` computed until this increment. Its third miss is an owner of a
    // FORCEd table reading *unconfined* — the permissive direction, and the silent zero the whole
    // family exists to catch: live, that owner's `DELETE … WHERE tenant_id IS NOT NULL` removed
    // nothing, the confirm-absence `count(*)` also reported 0 because it reads through the same
    // policy, and a BYPASSRLS role then counted both rows still present.
    const ownershipOnly = (v: SessionPolicyVisibility): boolean =>
      v.rlsEnabled && !(v.isOwner || v.bypassesRls);
    const wrong = LIVE_CONFINEMENT_MATRIX.filter((c) => ownershipOnly(c.facts) !== c.confined);
    expect(wrong.map((c) => `${c.role}/${c.table}`)).toEqual([
      "r_owner/forcedrls",
      "r_super_nobypass/plainrls",
      "r_super_nobypass/forcedrls",
    ]);
    const permissive = wrong.filter((c) => c.confined && !ownershipOnly(c.facts));
    expect(permissive.map((c) => `${c.role}/${c.table}`)).toEqual(["r_owner/forcedrls"]);
  });

  it("is the verdict column and nothing else, over every combination of the four facts", () => {
    // One field read, asserted as such: with the composition retired there is nothing left for a
    // fact to contribute, so a future edit that starts reading `isOwner` again fails here.
    for (const policiesActive of [false, true]) {
      for (const rlsEnabled of [false, true]) {
        for (const rlsForced of [false, true]) {
          for (const isOwner of [false, true]) {
            for (const bypassesRls of [false, true]) {
              expect(
                sessionWouldBeConfined({ role: "r", policiesActive, rlsEnabled, rlsForced, isOwner, bypassesRls }),
                `policiesActive=${policiesActive} rlsEnabled=${rlsEnabled} rlsForced=${rlsForced} isOwner=${isOwner} bypassesRls=${bypassesRls}`,
              ).toBe(policiesActive);
            }
          }
        }
      }
    }
  });
});

describe("sessionPolicyVisibilityReason", () => {
  it("explains every live cell, and never contradicts the verdict", () => {
    const confining = new Set(["policies_apply", "forced_on_owner"]);
    for (const cell of LIVE_CONFINEMENT_MATRIX) {
      const reason = sessionPolicyVisibilityReason(cell.facts);
      expect(confining.has(reason), `${cell.role}/${cell.table} -> ${reason}`).toBe(cell.confined);
    }
  });

  it("names the owner-under-FORCE case separately, because its remedy is different", () => {
    // "You do not own the table" and "you own it and FORCE confines the owner too" send an operator
    // to opposite fixes, which is the whole reason the four facts are still read.
    const owned = LIVE_CONFINEMENT_MATRIX.find((c) => c.role === "r_owner" && c.table === "forcedrls");
    expect(sessionPolicyVisibilityReason(owned!.facts)).toBe("forced_on_owner");
    const plain = LIVE_CONFINEMENT_MATRIX.find((c) => c.role === "r_plain" && c.table === "plainrls");
    expect(sessionPolicyVisibilityReason(plain!.facts)).toBe("policies_apply");
  });

  it("admits it cannot explain the superuser exemption, rather than guessing", () => {
    // `role_is_exempt` is the honest arm: Postgres says this session is free and no fact read here
    // says why. An explanation that claimed `owner_exempt` or `role_bypasses_rls` here would be a
    // sentence an operator could act on and that is false.
    const sup = LIVE_CONFINEMENT_MATRIX.filter((c) => c.role === "r_super_nobypass");
    expect(sup).toHaveLength(2);
    for (const c of sup) expect(sessionPolicyVisibilityReason(c.facts)).toBe("role_is_exempt");
  });

  it("settles on RLS being off before anything else", () => {
    expect(
      sessionPolicyVisibilityReason({
        role: "r", policiesActive: false, rlsEnabled: false, rlsForced: true, isOwner: true, bypassesRls: true,
      }),
    ).toBe("rls_disabled");
  });
});

describe("the confinement verdict has one spelling in the workspace", () => {
  // ADR-0357's shape: a test that reads source as text to pin both the call and the absence of the
  // literal. There were three mechanisms for this one question and the one the repo extracted as
  // canonical was not the most correct of them, so what is worth fencing is not "call the shared
  // function" but "do not compose this answer again".
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

  const sources = (): readonly { readonly path: string; readonly text: string }[] => {
    const out: { path: string; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          out.push({ path: full.slice(ROOT.length), text: readFileSync(full, "utf8") });
        }
      }
    };
    for (const member of ["packages", "apps"]) walk(`${ROOT}${member}`);
    return out;
  };

  it("has no second composition of ownership and bypass into a confinement answer", () => {
    // The literal shapes the retired copies used, in SQL and in TypeScript. Matching text rather
    // than behaviour is the point: a fourth copy would be *correct-looking*, and the only thing
    // that makes it visible is that it spells the composition at all.
    //
    // Comments are deliberately **not** stripped before matching, and that is a decision rather
    // than laziness. It fired once on a doc comment this increment wrote, quoting the expression it
    // had just retired — and a comment spelling the old composition is exactly what misled the four
    // readers this increment found, each of whom described the composed rule accurately and left
    // the next person to re-derive it. So the rule is that the expression appears nowhere, in code
    // or in prose, and the remedy for a comment that needs to discuss it is to describe it in
    // words.
    const SHAPES = [/isOwner\s*\|\|\s*bypassesRls/, /is_owner\s+OR\s+bypasses_rls/i];
    const offenders = sources().filter((s) => SHAPES.some((re) => re.test(s.text)));
    expect(offenders.map((s) => s.path)).toEqual([]);
  });

  it("reads relforcerowsecurity only beside row_security_active", () => {
    // The column is still selected — the explanation needs it — but a module that reads it without
    // asking Postgres for the verdict is composing again, which is the state this increment found.
    const offenders = sources()
      .filter((s) => s.text.includes("relforcerowsecurity") && !s.text.includes("row_security_active"))
      .map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it("finds the file it is asserting about, so the scan cannot pass by reading nothing", () => {
    const all = sources();
    expect(all.length).toBeGreaterThan(700);
    expect(all.some((s) => s.path.endsWith("packages/kernel-pg/src/introspection.ts"))).toBe(true);
    expect(all.filter((s) => s.text.includes("row_security_active")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("parseSessionPolicyVisibility", () => {
  it("throws on an absent or non-boolean verdict rather than defaulting it", () => {
    // This test previously asserted the opposite, and its comment defended the permissive default
    // with a property the code does not have: it claimed "every caller checks `rlsEnabled` first,
    // which no shape error can make true on its own". Measured — only ONE of the three callers
    // does. `check-admission.ts:743-744` and `encryption-writepath.ts:805-806` are both
    // `parseSessionPolicyVisibility` immediately followed by `if (sessionWouldBeConfined(...))`
    // with nothing between, and the second is `KeyRotationMigrator.probeTable`, whose refusal runs
    // immediately before a key generation is destroyed. So the default was a fence that stops
    // refusing on a shape error, defended by a sentence that was false in exactly that direction —
    // this increment's own class, inside this increment's own fix.
    for (const received of [undefined, null, "t", "f", 0, 1, {}]) {
      expect(() =>
        parseSessionPolicyVisibility({
          role: "serving",
          policies_active: received,
          rls_enabled: true,
          rls_forced: true,
          is_owner: true,
          bypasses_rls: false,
        }),
      ).toThrow(SessionPolicyVisibilityUnreadable);
    }
  });

  it("stays permissive about the four explanatory facts, which degrade to a vaguer sentence", () => {
    // The asymmetry is the decision, not an inconsistency: an unreadable explanation costs a
    // sentence and an unreadable verdict costs the refusal. So `rls_forced: "f"` above is read as
    // false and the message is merely less specific, while the verdict is strict.
    const v = parseSessionPolicyVisibility({
      role: 42,
      policies_active: true,
      rls_enabled: "yes",
      rls_forced: "f",
      is_owner: null,
      bypasses_rls: undefined,
    });
    expect(v).toEqual({
      role: "42",
      policiesActive: true,
      rlsEnabled: false,
      rlsForced: false,
      isOwner: false,
      bypassesRls: false,
    });
    // And note what that combination means: Postgres says the policies apply while `rls_enabled`
    // reads false. Incoherent, and it resolves toward the verdict — `rls_disabled` is what the
    // *explanation* says, and every caller that branches reads `sessionWouldBeConfined`.
    expect(sessionWouldBeConfined(v)).toBe(true);
  });

  it("stringifies the role rather than asserting it", () => {
    expect(
      parseSessionPolicyVisibility({
        role: 42,
        policies_active: false,
        rls_enabled: false,
        rls_forced: false,
        is_owner: false,
        bypasses_rls: false,
      }).role,
    ).toBe("42");
  });
});

describe("SESSION_POLICY_VISIBILITY_QUERY", () => {
  it("asks Postgres for the verdict and the catalog for the explanation", () => {
    expect(SESSION_POLICY_VISIBILITY_QUERY).toContain("n.nspname = $1 AND c.relname = $2");
    // The verdict first, because it is the one column a composition cannot replace.
    expect(SESSION_POLICY_VISIBILITY_QUERY).toContain("row_security_active(c.oid)");
    for (const column of ["rolbypassrls", "pg_get_userbyid", "relrowsecurity", "relforcerowsecurity"]) {
      expect(SESSION_POLICY_VISIBILITY_QUERY).toContain(column);
    }
  });

  it("shares its select list, so a caller wanting extras asks in one round trip", () => {
    // `KeyRotationMigrator.commonRefusals` wants `has_scope_column` beside these, and its comment
    // says why one statement matters. The columns are shared; the query is not.
    expect(SESSION_POLICY_VISIBILITY_QUERY).toContain(SESSION_POLICY_VISIBILITY_COLUMNS);
  });

  it("answers null for a relation that is not there", async () => {
    const conn = fakeConn([{ rows: [], rowCount: 0 }]);
    await expect(probeSessionPolicyVisibility(conn, "meta", "nope")).resolves.toBeNull();
  });

  it("parses the row it gets back", async () => {
    const conn = fakeConn([
      {
        rows: [
          {
            role: "serving",
            policies_active: true,
            rls_enabled: true,
            rls_forced: false,
            is_owner: false,
            bypasses_rls: false,
          },
        ],
        rowCount: 1,
      },
    ]);
    const v = await probeSessionPolicyVisibility(conn, "meta", "t");
    expect(v?.role).toBe("serving");
    expect(sessionWouldBeConfined(v as SessionPolicyVisibility)).toBe(true);
  });
});
