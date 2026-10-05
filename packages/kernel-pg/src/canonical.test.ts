import { describe, expect, it } from "vitest";
import { META_TABLES, type TableDefinition } from "@crossengin/kernel/bootstrap";

import {
  APPLIER_OWNED_TABLES,
  COMMAND_TO_POLCMD,
  DEFAULT_ON_DELETE,
  DEFAULT_ON_UPDATE,
  DEFAULT_POLICY_COMMAND,
  DEFAULT_POLICY_PERMISSIVE,
  DEFAULT_POLICY_ROLES,
  PG_NAME_MAX_LENGTH,
  PG_TYPE_ALIASES,
  POLCMD_TO_COMMAND,
  canonicalPgDefault,
  canonicalPgType,
  canonicalPolicyCommand,
  canonicalPolicyRoles,
  declaredCheckConstraints,
  declaredConstraintOnDelete,
  declaredConstraintOnUpdate,
  declaredConstraintTarget,
  declaredForeignKeyConstraints,
  declaredForeignKeys,
  declaredOnDelete,
  declaredPolicyCommand,
  declaredPolicyPermissive,
  declaredPolicyRoles,
  declaredUniqueConstraints,
  expectedCheckConstraintNames,
  expectedIndexNames,
  makeObjectName,
  policyCommandToPolcmd,
  samePolicyRoles,
} from "./canonical.js";

describe("APPLIER_OWNED_TABLES", () => {
  it("names the applier's own bookkeeping table", () => {
    expect(APPLIER_OWNED_TABLES.has("_meta_migrations")).toBe(true);
  });

  it("does not shadow a catalog table", () => {
    for (const name of APPLIER_OWNED_TABLES) {
      expect(META_TABLES.some((t) => t.name === name)).toBe(false);
    }
  });
});

describe("canonicalPgType", () => {
  it("rewrites TIMESTAMPTZ the way format_type prints it", () => {
    // 425 columns in the catalog declare TIMESTAMPTZ; comparing the raw spellings reported every
    // one of them as drifted.
    expect(canonicalPgType("TIMESTAMPTZ")).toBe("timestamp with time zone");
  });

  it("is already canonical for the printed form, so it is idempotent", () => {
    expect(canonicalPgType("timestamp with time zone")).toBe("timestamp with time zone");
    expect(canonicalPgType(canonicalPgType("TIMESTAMPTZ"))).toBe("timestamp with time zone");
  });

  it("expands CHAR and VARCHAR", () => {
    expect(canonicalPgType("CHAR(64)")).toBe("character(64)");
    expect(canonicalPgType("VARCHAR(20)")).toBe("character varying(20)");
  });

  it("strips whitespace inside a precision list", () => {
    expect(canonicalPgType("NUMERIC(12, 6)")).toBe("numeric(12,6)");
    expect(canonicalPgType("numeric(12,6)")).toBe("numeric(12,6)");
  });

  it("maps the integer and float aliases", () => {
    expect(canonicalPgType("INT")).toBe("integer");
    expect(canonicalPgType("INT4")).toBe("integer");
    expect(canonicalPgType("INT8")).toBe("bigint");
    expect(canonicalPgType("INT2")).toBe("smallint");
    expect(canonicalPgType("FLOAT8")).toBe("double precision");
    expect(canonicalPgType("BOOL")).toBe("boolean");
    expect(canonicalPgType("DECIMAL(4,2)")).toBe("numeric(4,2)");
  });

  it("keeps an array suffix and canonicalizes the element type", () => {
    expect(canonicalPgType("TEXT[]")).toBe("text[]");
    expect(canonicalPgType("TIMESTAMPTZ[]")).toBe("timestamp with time zone[]");
    expect(canonicalPgType("TEXT [ ]")).toBe("text[]");
    expect(canonicalPgType("TEXT[][]")).toBe("text[][]");
  });

  it("puts a time precision inside the name, where Postgres puts it", () => {
    expect(canonicalPgType("TIMESTAMPTZ(3)")).toBe("timestamp(3) with time zone");
    expect(canonicalPgType("TIMETZ(0)")).toBe("time(0) with time zone");
  });

  it("distinguishes the two timestamp flavours", () => {
    expect(canonicalPgType("TIMESTAMP")).toBe("timestamp without time zone");
    expect(canonicalPgType("TIMESTAMPTZ")).not.toBe(canonicalPgType("TIMESTAMP"));
  });

  it("leaves a type it has no alias for alone but lowercases it", () => {
    expect(canonicalPgType("JSONB")).toBe("jsonb");
    expect(canonicalPgType("UUID")).toBe("uuid");
    expect(canonicalPgType("TEXT")).toBe("text");
  });

  it("handles an empty string", () => {
    expect(canonicalPgType("")).toBe("");
  });

  it("never maps two distinct declared types onto one canonical form", () => {
    const seen = new Map<string, string>();
    for (const [alias, target] of Object.entries(PG_TYPE_ALIASES)) {
      const prior = seen.get(target);
      // Several aliases legitimately share a target (int/int4 -> integer); what must not happen is
      // an alias mapping onto a *different* alias's declared name.
      if (prior !== undefined) expect(PG_TYPE_ALIASES[prior]).toBe(target);
      seen.set(target, alias);
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe("canonicalPgDefault", () => {
  it("is null for an absent default", () => {
    expect(canonicalPgDefault(null)).toBeNull();
    expect(canonicalPgDefault(undefined)).toBeNull();
    expect(canonicalPgDefault("   ")).toBeNull();
  });

  it("equates a string literal with the cast Postgres adds to it", () => {
    expect(canonicalPgDefault("'active'")).toBe(canonicalPgDefault("'active'::text"));
  });

  it("strips a cast carrying a precision or an array suffix", () => {
    expect(canonicalPgDefault("'{}'::jsonb")).toBe("'{}'");
    expect(canonicalPgDefault("'x'::character varying(20)")).toBe("'x'");
    expect(canonicalPgDefault("'{}'::text[]")).toBe("'{}'");
  });

  it("unwraps the parentheses Postgres adds around a re-rendered default", () => {
    expect(canonicalPgDefault("('{}'::jsonb)")).toBe("'{}'");
  });

  it("leaves a function call alone", () => {
    expect(canonicalPgDefault("uuid_generate_v7()")).toBe("uuid_generate_v7()");
    expect(canonicalPgDefault("now()")).toBe("now()");
  });

  it("does not strip a cast that sits inside a call", () => {
    expect(canonicalPgDefault("nextval('s'::regclass)")).toBe("nextval('s'::regclass)");
  });

  it("normalizes case and whitespace", () => {
    expect(canonicalPgDefault("  NOW()  ")).toBe("now()");
    expect(canonicalPgDefault("FALSE")).toBe("false");
  });

  it("agrees on the literal defaults the catalog actually uses", () => {
    for (const declared of ["'active'", "'eu'", "'small'", "'simple'", "false", "0", "'[]'::jsonb"]) {
      const live = declared.includes("::") ? declared : `${declared}::text`;
      expect(canonicalPgDefault(declared)).toBe(canonicalPgDefault(live));
    }
  });
});

const TABLE: TableDefinition = {
  schema: "meta",
  name: "widgets",
  columns: [
    { name: "id", type: "UUID", notNull: true },
    { name: "code", type: "TEXT", notNull: true, unique: { constraintName: "widgets_code_key" } },
    { name: "label", type: "TEXT" },
  ],
  primaryKey: ["id"],
  uniqueConstraints: [{ name: "widgets_label_code_key", columns: ["label", "code"] }],
  indexes: [{ name: "idx_widgets_label", columns: ["label"] }],
};

describe("expectedIndexNames", () => {
  it("separates plain indexes from constraint-backed ones", () => {
    const expected = expectedIndexNames(TABLE);
    expect([...expected.indexes]).toEqual(["idx_widgets_label"]);
    expect([...expected.constraints].sort()).toEqual([
      "widgets_code_key",
      "widgets_label_code_key",
    ]);
  });

  it("derives the Postgres name for an unnamed column UNIQUE", () => {
    const expected = expectedIndexNames({
      ...TABLE,
      uniqueConstraints: undefined,
      columns: [{ name: "slug", type: "TEXT", unique: true }],
    });
    expect([...expected.constraints]).toEqual(["widgets_slug_key"]);
  });

  it("is empty for a table declaring neither", () => {
    const expected = expectedIndexNames({
      schema: "meta",
      name: "bare",
      columns: [{ name: "id", type: "UUID" }],
    });
    expect(expected.indexes.size).toBe(0);
    expect(expected.constraints.size).toBe(0);
  });

  it("accounts for every constraint-backed index in the real catalog", () => {
    // The gap this closes: 117 live indexes were reported as removed because they are created by a
    // UNIQUE constraint and so never appear in `table.indexes`.
    let constraintBacked = 0;
    for (const table of META_TABLES) {
      const expected = expectedIndexNames(table);
      constraintBacked += expected.constraints.size;
      for (const idx of table.indexes ?? []) {
        expect(expected.indexes.has(idx.name)).toBe(true);
      }
    }
    expect(constraintBacked).toBeGreaterThan(100);
  });
});

describe("declaredOnDelete", () => {
  it("is RESTRICT when the reference omits it, because that is what the emitter writes", () => {
    expect(declaredOnDelete({ schema: "meta", table: "users", column: "id" })).toBe("RESTRICT");
    expect(DEFAULT_ON_DELETE).toBe("RESTRICT");
  });

  it("is whatever the reference declares", () => {
    expect(
      declaredOnDelete({ schema: "meta", table: "tenants", column: "id", onDelete: "CASCADE" }),
    ).toBe("CASCADE");
    expect(
      declaredOnDelete({ schema: "meta", table: "tenants", column: "id", onDelete: "SET NULL" }),
    ).toBe("SET NULL");
  });
});

describe("declaredForeignKeys", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "children",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      {
        name: "tenant_id",
        type: "UUID",
        references: { schema: "meta", table: "tenants", column: "id", onDelete: "CASCADE" },
      },
      { name: "owner_id", type: "UUID", references: { table: "users", column: "id" } },
      { name: "label", type: "TEXT" },
    ],
  };

  it("finds one per column carrying a reference", () => {
    const fks = declaredForeignKeys(table);
    expect(fks.map((f) => f.column)).toEqual(["tenant_id", "owner_id"]);
  });

  it("predicts the name Postgres gives an inline reference", () => {
    expect(declaredForeignKeys(table)[0]?.expectedConstraintName).toBe("children_tenant_id_fkey");
  });

  it("resolves an unqualified target to the table's own schema", () => {
    // An unqualified REFERENCES resolves through the search path, which for the meta-schema is
    // the schema the table lives in.
    expect(declaredForeignKeys(table)[1]?.targetSchema).toBe("meta");
  });

  it("carries the effective onDelete for each", () => {
    const fks = declaredForeignKeys(table);
    expect(fks[0]?.onDelete).toBe("CASCADE");
    expect(fks[1]?.onDelete).toBe("RESTRICT");
  });

  it("is empty for a table with no references", () => {
    expect(declaredForeignKeys({ ...table, columns: [{ name: "id", type: "UUID" }] })).toEqual([]);
  });

  it("finds every reference in the real catalog and names them uniquely per table", () => {
    let total = 0;
    for (const t of META_TABLES) {
      const fks = declaredForeignKeys(t);
      total += fks.length;
      expect(new Set(fks.map((f) => f.expectedConstraintName)).size).toBe(fks.length);
    }
    expect(total).toBeGreaterThan(100);
  });
});

describe("policy command canonicalization", () => {
  it("maps every polcmd character to its command", () => {
    expect(canonicalPolicyCommand("*")).toBe("ALL");
    expect(canonicalPolicyCommand("r")).toBe("SELECT");
    expect(canonicalPolicyCommand("a")).toBe("INSERT");
    expect(canonicalPolicyCommand("w")).toBe("UPDATE");
    expect(canonicalPolicyCommand("d")).toBe("DELETE");
  });

  it("maps every command back to its polcmd character", () => {
    expect(policyCommandToPolcmd("ALL")).toBe("*");
    expect(policyCommandToPolcmd("SELECT")).toBe("r");
    expect(policyCommandToPolcmd("INSERT")).toBe("a");
    expect(policyCommandToPolcmd("UPDATE")).toBe("w");
    expect(policyCommandToPolcmd("DELETE")).toBe("d");
  });

  it("round-trips both ways for every command", () => {
    for (const [char, command] of Object.entries(POLCMD_TO_COMMAND)) {
      expect(policyCommandToPolcmd(command)).toBe(char);
      expect(canonicalPolicyCommand(policyCommandToPolcmd(command))).toBe(command);
    }
    expect(Object.keys(POLCMD_TO_COMMAND)).toHaveLength(5);
    expect(Object.keys(COMMAND_TO_POLCMD)).toHaveLength(5);
  });

  it("tolerates the padding a char column can carry", () => {
    expect(canonicalPolicyCommand(" r ")).toBe("SELECT");
  });

  it("returns null for a character it does not know, rather than guessing ALL", () => {
    // A future Postgres command must not make every policy using it read as drifted back to ALL.
    expect(canonicalPolicyCommand("m")).toBeNull();
    expect(canonicalPolicyCommand("")).toBeNull();
  });

  it("treats an omitted command as ALL, which is what CREATE POLICY does", () => {
    expect(DEFAULT_POLICY_COMMAND).toBe("ALL");
    expect(declaredPolicyCommand({ name: "p", using: "true" })).toBe("ALL");
    expect(declaredPolicyCommand({ name: "p", using: "true", command: "ALL" })).toBe("ALL");
    expect(declaredPolicyCommand({ name: "p", using: "true", command: "DELETE" })).toBe("DELETE");
  });
});

describe("policy role canonicalization", () => {
  it("treats an omitted role list as PUBLIC, which is what CREATE POLICY does", () => {
    expect([...DEFAULT_POLICY_ROLES]).toEqual(["PUBLIC"]);
    expect([...declaredPolicyRoles({ name: "p", using: "true" })]).toEqual(["PUBLIC"]);
  });

  it("treats an empty role list as absent, not as a grant to nobody", () => {
    expect([...declaredPolicyRoles({ name: "p", using: "true", roles: [] })]).toEqual(["PUBLIC"]);
  });

  it("matches an explicitly declared PUBLIC against the default", () => {
    expect(
      samePolicyRoles(declaredPolicyRoles({ name: "p", using: "true", roles: ["PUBLIC"] }), [
        "PUBLIC",
      ]),
    ).toBe(true);
    expect(
      samePolicyRoles(declaredPolicyRoles({ name: "p", using: "true", roles: ["public"] }), [
        "PUBLIC",
      ]),
    ).toBe(true);
  });

  it("sorts, because polroles comes back in oid order and not declaration order", () => {
    expect([...canonicalPolicyRoles(["b", "a", "c"])]).toEqual(["a", "b", "c"]);
    expect(samePolicyRoles(["app_writer", "app_reader"], ["app_reader", "app_writer"])).toBe(true);
  });

  it("leaves a role name's case alone, since Postgres stores a quoted identifier as written", () => {
    expect([...canonicalPolicyRoles(["App_Reader"])]).toEqual(["App_Reader"]);
    expect(samePolicyRoles(["App_Reader"], ["app_reader"])).toBe(false);
  });

  it("sees a narrowed and a widened grant as different", () => {
    expect(samePolicyRoles(["PUBLIC"], ["app_reader"])).toBe(false);
    expect(samePolicyRoles(["app_reader"], ["app_reader", "app_writer"])).toBe(false);
  });

  it("does not mutate the list it was given", () => {
    const roles = ["b", "a"];
    canonicalPolicyRoles(roles);
    expect(roles).toEqual(["b", "a"]);
  });

  /**
   * A policy is scoped to one command **iff its name says so**.
   *
   * This was a hand-maintained list of eight until ADR-0332's 29-table split made it seventy-eight,
   * at which point it became exactly the shape ADR-0288 is the standing lesson about: a fact with
   * two copies, where a policy missing from one copy is invisible. The rule cannot go stale, and it
   * asserts something the list did not — that the catalog's naming convention and its scoping are
   * two statements of the same fact, so a policy *named* `_platform_read` cannot quietly be
   * `ALL`-scope (which is the defect the split exists to close, since on an `ALL` policy the
   * `USING` expression also serves as the `WITH CHECK`).
   *
   * `_platform_audit_read` / `_platform_audit_write` are ADR-0313's and ADR-0331's spelling on
   * `meta.audit_log`, matched by the optional `audit_` group rather than renamed, because the names
   * are what deployments already hold.
   */
  const NARROWED_NAME = /_platform_(audit_)?(read|write|update)$/;

  it("scopes a policy to one command iff its name says so, and never narrows `roles`", () => {
    let narrowed = 0;
    for (const t of META_TABLES) {
      for (const policy of t.rls?.policies ?? []) {
        // No policy anywhere narrows `roles`: a role list is resolved against `pg_authid`, and a
        // catalog naming a role a deployment has not created would read as undetermined.
        expect([...declaredPolicyRoles(policy)]).toEqual(["PUBLIC"]);
        if (NARROWED_NAME.test(policy.name)) {
          narrowed += 1;
          expect([policy.name, declaredPolicyCommand(policy)]).not.toEqual([policy.name, "ALL"]);
          continue;
        }
        expect([policy.name, declaredPolicyCommand(policy)]).toEqual([policy.name, "ALL"]);
      }
    }
    // So the rule cannot pass vacuously on a catalog where nothing is narrowed: 8 from ADR-0313 and
    // ADR-0331, plus 71 from the 29-table split (29 reads, 29 inserts, 13 updates), plus 2 for
    // `meta.audit_integrity_verdicts` — the last member of that class, whose single `ALL` policy
    // ORed in the cross-tenant *read* grant and so let an elevated reader forge, flip or delete a
    // verdict at any scope. Append-only, so a read arm and an `INSERT` arm and no `UPDATE`.
    //
    // The 13th `UPDATE` arm is `dr_drill_executions`, which ADR-0332 classified append-only by
    // reading its INSERT-only store rather than its contract — the one place that increment applied
    // its own shape axis the way it said it had not. A drill result is an amendment to an existing
    // record, so the arm is required for the store to be able to complete one.
    expect(narrowed).toBe(81);
  });
});

describe("makeObjectName", () => {
  it("joins the parts with underscores when everything fits", () => {
    expect(makeObjectName("widgets", "status", "check")).toBe("widgets_status_check");
    expect(makeObjectName("widgets", null, "check")).toBe("widgets_check");
  });

  it("leaves the label intact and shortens the longer name, not the whole string", () => {
    // The real catalog case: naive truncation at 63 characters drops `_check` altogether, which would
    // report a correct constraint as undeclared.
    expect(
      makeObjectName("access_review_templates", "default_remediation_days_from_completion", "check"),
    ).toBe("access_review_templates_default_remediation_days_from_com_check");
    expect(
      makeObjectName("access_review_decisions", "attestation_signing_key_fingerprint", "check"),
    ).toBe("access_review_decisions_attestation_signing_key_fingerpri_check");
  });

  it("never exceeds the identifier limit", () => {
    const long = "x".repeat(80);
    expect(makeObjectName(long, long, "check").length).toBe(PG_NAME_MAX_LENGTH);
    expect(makeObjectName(long, null, "fkey").length).toBe(PG_NAME_MAX_LENGTH);
    expect(PG_NAME_MAX_LENGTH).toBe(63);
  });

  it("shortens whichever name is longer, one character at a time", () => {
    const out = makeObjectName("a".repeat(10), "b".repeat(60), "check");
    expect(out.startsWith("aaaaaaaaaa_")).toBe(true);
    expect(out.endsWith("_check")).toBe(true);
    expect(out.length).toBe(PG_NAME_MAX_LENGTH);
  });

  it("agrees with every name the existing index and foreign-key guesses already use", () => {
    // `expectedIndexNames` and `declaredForeignKeys` build `<table>_<column>_key` and `_fkey` by
    // concatenation. That happens to be right for the whole catalog today; this says so, so a longer
    // table or column name later fails here rather than reading as drift.
    for (const t of META_TABLES) {
      for (const col of t.columns) {
        if (col.unique === true) {
          expect(`${t.name}_${col.name}_key`).toBe(makeObjectName(t.name, col.name, "key"));
        }
        if (col.references !== undefined) {
          expect(`${t.name}_${col.name}_fkey`).toBe(makeObjectName(t.name, col.name, "fkey"));
        }
      }
    }
  });
});

describe("expectedCheckConstraintNames", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "comms",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      { name: "status", type: "TEXT", notNull: true, check: "status IN ('a','b')" },
      { name: "label", type: "TEXT" },
    ],
  };

  it("is empty for a table with no checks at all", () => {
    expect([...expectedCheckConstraintNames({ ...table, columns: [table.columns[0]!] })]).toEqual([]);
  });

  it("derives the name Postgres gives a single-column check", () => {
    expect(expectedCheckConstraintNames(table).has("comms_status_check")).toBe(true);
  });

  it("also expects the unqualified name, because a cross-column check gets that one", () => {
    // Which name Postgres picks depends on how many columns the *expression* references, and knowing
    // that means parsing it. `tenant_credits.remaining_cents` in the real catalog declares
    // `remaining_cents <= amount_cents` on a column and so carries `tenant_credits_check`.
    expect(expectedCheckConstraintNames(table).has("comms_check")).toBe(true);
  });

  it("includes a declared table-level check under the name it declares", () => {
    const withTableCheck: TableDefinition = {
      ...table,
      constraints: [
        { kind: "check", name: "comms_window_check", expression: "a <= b" },
        { kind: "unique", name: "comms_pair_key", columns: ["id", "label"] },
      ],
    };
    const names = expectedCheckConstraintNames(withTableCheck);
    expect(names.has("comms_window_check")).toBe(true);
    // A unique constraint is not a CHECK and is accounted for through its backing index instead.
    expect(names.has("comms_pair_key")).toBe(false);
  });

  it("accounts for every check name in the real catalog within the identifier limit", () => {
    // The acceptance test for "a correct schema reports no drift": each generated name has to be one
    // Postgres could actually have stored, which means 63 characters or fewer.
    let checked = 0;
    for (const t of META_TABLES) {
      for (const name of expectedCheckConstraintNames(t)) {
        expect(name.length).toBeLessThanOrEqual(PG_NAME_MAX_LENGTH);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(700);
  });

  it("expects the unqualified name for every catalog table that has any column check", () => {
    for (const t of META_TABLES) {
      if (!t.columns.some((c) => c.check !== undefined)) continue;
      expect(expectedCheckConstraintNames(t).has(makeObjectName(t.name, null, "check"))).toBe(true);
    }
  });
});

describe("table constraints — splitters and defaults", () => {
  const table: TableDefinition = {
    schema: "meta",
    name: "comms",
    columns: [
      { name: "id", type: "UUID", notNull: true },
      { name: "tenant_id", type: "UUID", notNull: true },
    ],
    uniqueConstraints: [{ name: "comms_legacy_key", columns: ["id"] }],
    constraints: [
      { kind: "check", name: "comms_window_check", expression: "a <= b" },
      {
        kind: "foreign_key",
        name: "comms_incident_fkey",
        columns: ["tenant_id", "id"],
        references: { table: "incidents", columns: ["tenant_id", "id"] },
      },
      { kind: "unique", name: "comms_pair_key", columns: ["tenant_id", "id"] },
    ],
  };

  it("splits the union by kind", () => {
    expect(declaredCheckConstraints(table).map((c) => c.name)).toEqual(["comms_window_check"]);
    expect(declaredForeignKeyConstraints(table).map((c) => c.name)).toEqual([
      "comms_incident_fkey",
    ]);
  });

  it("returns nothing for a table declaring none", () => {
    const bare: TableDefinition = { schema: "meta", name: "x", columns: [] };
    expect(declaredCheckConstraints(bare)).toEqual([]);
    expect(declaredForeignKeyConstraints(bare)).toEqual([]);
    expect(declaredUniqueConstraints(bare)).toEqual([]);
  });

  it("merges both spellings of a unique constraint", () => {
    expect(declaredUniqueConstraints(table).map((c) => c.name)).toEqual([
      "comms_legacy_key",
      "comms_pair_key",
    ]);
  });

  it("expects a kind:unique constraint's index, so it is never reported as missing twice", () => {
    const expected = expectedIndexNames(table);
    expect(expected.constraints.has("comms_pair_key")).toBe(true);
    expect(expected.constraints.has("comms_legacy_key")).toBe(true);
    expect(expected.indexes.has("comms_pair_key")).toBe(false);
  });

  it("reads an omitted ON DELETE as RESTRICT and an omitted ON UPDATE as NO ACTION", () => {
    const fk = declaredForeignKeyConstraints(table)[0]!;
    expect(declaredConstraintOnDelete(fk)).toBe("RESTRICT");
    expect(declaredConstraintOnUpdate(fk)).toBe("NO ACTION");
    expect(DEFAULT_ON_DELETE).toBe("RESTRICT");
    expect(DEFAULT_ON_UPDATE).toBe("NO ACTION");
  });

  it("reads a declared action as itself", () => {
    expect(
      declaredConstraintOnDelete({
        kind: "foreign_key",
        name: "f",
        columns: ["a"],
        references: { table: "t", columns: ["id"] },
        onDelete: "CASCADE",
      }),
    ).toBe("CASCADE");
    expect(
      declaredConstraintOnUpdate({
        kind: "foreign_key",
        name: "f",
        columns: ["a"],
        references: { table: "t", columns: ["id"] },
        onUpdate: "SET NULL",
      }),
    ).toBe("SET NULL");
  });

  it("resolves an unqualified target through the table's own schema", () => {
    expect(declaredConstraintTarget(table, declaredForeignKeyConstraints(table)[0]!)).toBe(
      "meta.incidents",
    );
  });

  it("keeps an explicit target schema", () => {
    expect(
      declaredConstraintTarget(table, {
        kind: "foreign_key",
        name: "f",
        columns: ["a"],
        references: { schema: "other", table: "t", columns: ["id"] },
      }),
    ).toBe("other.t");
  });
});

describe("declaredPolicyPermissive", () => {
  it("reads an omitted field as permissive, which is the CREATE POLICY default", () => {
    expect(declaredPolicyPermissive({ name: "p", using: "true" })).toBe(true);
    expect(DEFAULT_POLICY_PERMISSIVE).toBe(true);
  });

  it("reads a declared value as itself", () => {
    expect(declaredPolicyPermissive({ name: "p", using: "true", permissive: true })).toBe(true);
    expect(declaredPolicyPermissive({ name: "p", using: "true", permissive: false })).toBe(false);
  });

  it("leaves every policy in the real catalog permissive", () => {
    for (const t of META_TABLES) {
      for (const policy of t.rls?.policies ?? []) {
        expect(declaredPolicyPermissive(policy)).toBe(true);
      }
    }
  });
});
