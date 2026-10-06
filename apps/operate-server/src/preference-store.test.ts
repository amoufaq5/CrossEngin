import { META_TABLES } from "@crossengin/kernel/bootstrap";
import type { PgConnection } from "@crossengin/kernel-pg";
import { CONTENT_CATEGORIES, NOTIFICATION_CHANNELS } from "@crossengin/notifications";
import { describe, expect, it } from "vitest";

import {
  PREFERENCE_EXPECTATIONS,
  PREFERENCE_SOURCES,
  PREFERENCE_WRITE_OUTCOMES,
  PostgresNotificationPreferenceStore,
  PreferenceRowUnreadableError,
  assertCatalogAgreement,
  defaultOptedIn,
  expectationPredicate,
  resolveOptedIn,
} from "./preference-store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";
const ACTOR = "00000000-0000-4000-8000-0000000000cc";
const AT = "2026-09-01T12:00:00.000Z";
const SUBJECT = { tenantId: TENANT, userId: USER };

type Row = Record<string, unknown>;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface Fake {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  readonly tenantContext: () => string | null;
  readonly sql: () => string;
  readonly writes: () => readonly Captured[];
}

const WRITE_RE = /^\s*(WITH|INSERT|UPDATE|DELETE)\b/i;

/**
 * Records every statement and answers whatever the test hands it — and **throws on a write with no
 * `tenant_id` predicate**.
 *
 * ADR-0334's finding about the fakes in this repo is the reason for that tripwire: `crypto-pg`'s
 * fake applied the RLS predicate to writes and so hid every owner-bypass defect by construction,
 * and `feature-flags-pg`'s and `dr-runtime-pg`'s modelled `tenant_id` not at all. A fake that
 * answers a statement it could not really serve is a test asserting the wrong thing, and the thing
 * this store would most plausibly lose in a refactor is the scope predicate that stops a write
 * reaching another tenant's row as the table's owner.
 */
function fakeDb(responses: readonly Row[][]): Fake {
  const captured: Captured[] = [];
  let tenant: string | null = null;
  let next = 0;

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p });
    if (sql.includes("set_config")) {
      tenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (WRITE_RE.test(sql) && !/tenant_id\s*=\s*\$/.test(sql)) {
      throw new Error(`write with no tenant_id predicate: ${sql}`);
    }
    const rows = responses[next] ?? [];
    next += 1;
    return { rows: [...rows], rowCount: rows.length };
  };

  const conn = {
    query: run,
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
      fn(conn as unknown as PgConnection),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<undefined> => undefined,
  };

  return {
    conn: conn as unknown as PgConnection,
    captured,
    tenantContext: () => tenant,
    sql: () => captured.map((c) => c.sql).join("\n---\n"),
    writes: () => captured.filter((c) => WRITE_RE.test(c.sql)),
  };
}

function prefRow(over: Partial<Row> = {}): Row {
  return {
    tenant_id: TENANT,
    user_id: USER,
    category: "marketing",
    channel: "email",
    opted_in: false,
    source: "user_set",
    updated_at: new Date(AT),
    updated_by: ACTOR,
    written: true,
    existed: false,
    prior_opted_in: null,
    ...over,
  };
}

const OPT_OUT = {
  category: "marketing",
  channel: "email",
  optedIn: false,
  source: "user_set",
  at: AT,
  updatedBy: ACTOR,
} as const;

describe("preference-store — constants", () => {
  it("names the four write outcomes", () => {
    expect(PREFERENCE_WRITE_OUTCOMES).toEqual(["inserted", "updated", "reaffirmed", "conflict"]);
  });

  it("names the three expectations", () => {
    expect(PREFERENCE_EXPECTATIONS).toEqual(["absent", "opted_in", "opted_out"]);
  });

  it("restates exactly the catalog's five sources", () => {
    expect([...PREFERENCE_SOURCES]).toEqual([
      "default_policy",
      "user_set",
      "admin_set",
      "regulatory_requirement",
      "import",
    ]);
  });

  it("refuses a schema identifier that is not an identifier", () => {
    const db = fakeDb([]);
    expect(() => new PostgresNotificationPreferenceStore(db.conn, { schema: "a-b" })).toThrow(
      /invalid schema identifier/,
    );
  });
});

describe("preference-store — the fake's own tripwire is not vacuous", () => {
  // A tripwire that never fires is indistinguishable from no tripwire, which is the whole of
  // ADR-0334's finding about the fakes in this repo. So it is asked about a statement that should
  // trip it, and about one that should not.
  it("throws on a write with no tenant_id predicate", async () => {
    const db = fakeDb([[]]);
    await expect(
      db.conn.query("UPDATE meta.notification_preferences SET opted_in = true WHERE user_id = $1", [
        USER,
      ]),
    ).rejects.toThrow(/no tenant_id predicate/);
  });

  it("admits a write that carries one", async () => {
    const db = fakeDb([[]]);
    await expect(
      db.conn.query("DELETE FROM meta.notification_preferences WHERE tenant_id = $1", [TENANT]),
    ).resolves.toBeDefined();
  });

  it("leaves reads alone, because a diagnosing re-read is deliberately unscoped", async () => {
    const db = fakeDb([[]]);
    await expect(
      db.conn.query("SELECT 1 FROM meta.notification_preferences WHERE user_id = $1", [USER]),
    ).resolves.toBeDefined();
  });
});

describe("preference-store — the catalog has not drifted", () => {
  const table = META_TABLES.find(
    (t) => t.schema === "meta" && t.name === "notification_preferences",
  );

  it("is in META_TABLES", () => {
    expect(table).toBeDefined();
  });

  it("agrees with the contract in both directions", () => {
    expect(() => assertCatalogAgreement(table!)).not.toThrow();
  });

  it("carries a NOT NULL user_id, which is what makes meta.users load-bearing here", () => {
    const column = table!.columns.find((c) => c.name === "user_id");
    expect(column?.notNull).toBe(true);
    expect(column?.references?.table).toBe("users");
  });

  it("leaves updated_by nullable, so a write with no human behind it is storable", () => {
    const column = table!.columns.find((c) => c.name === "updated_by");
    expect(column?.notNull).not.toBe(true);
  });

  it("keeps tenant_id NOT NULL, which is why the strict scopeFilter is the only right spelling", () => {
    expect(table!.columns.find((c) => c.name === "tenant_id")?.notNull).toBe(true);
  });

  it("catches a CHECK that drops a value the contract still has", () => {
    expect(() =>
      assertCatalogAgreement({
        columns: [
          ...table!.columns.filter((c) => c.name !== "category"),
          { name: "category", notNull: true, check: "category IN ('transactional')" },
        ],
      }),
    ).toThrow(/category CHECK does not permit/);
  });

  it("catches a CHECK that permits a value the contract does not — the other direction", () => {
    expect(() =>
      assertCatalogAgreement({
        columns: [
          ...table!.columns.filter((c) => c.name !== "channel"),
          {
            name: "channel",
            notNull: true,
            check: `channel IN (${[...NOTIFICATION_CHANNELS, "telepathy"].map((c) => `'${c}'`).join(", ")})`,
          },
        ],
      }),
    ).toThrow(/permits telepathy/);
  });

  it("catches a column that stopped being NOT NULL", () => {
    expect(() =>
      assertCatalogAgreement({
        columns: table!.columns.map((c) => (c.name === "opted_in" ? { ...c, notNull: false } : c)),
      }),
    ).toThrow(/opted_in must be NOT NULL/);
  });

  it("catches a column that went missing", () => {
    expect(() =>
      assertCatalogAgreement({ columns: table!.columns.filter((c) => c.name !== "source") }),
    ).toThrow(/has no source column/);
  });
});

describe("preference-store — expectationPredicate", () => {
  it("renders 'any' as true rather than omitting the clause", () => {
    expect(expectationPredicate("any", "t")).toBe("true");
  });

  it("renders 'absent' as false, which is DO NOTHING spelled as a predicate", () => {
    expect(expectationPredicate("absent", "t")).toBe("false");
  });

  it("re-asserts the stored value for opted_in", () => {
    expect(expectationPredicate("opted_in", "t")).toBe("t.opted_in = true");
  });

  it("re-asserts the stored value for opted_out", () => {
    expect(expectationPredicate("opted_out", "t")).toBe("t.opted_in = false");
  });
});

describe("preference-store — put", () => {
  it("binds the tenant context and carries an explicit tenant_id predicate beside it", async () => {
    const db = fakeDb([[prefRow()]]);
    await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, OPT_OUT);
    expect(db.tenantContext()).toBe(TENANT);
    expect(db.writes()[0]?.sql).toMatch(/tenant_id = \$1/);
  });

  it("performs the conflict rule in SQL, not in process", async () => {
    const db = fakeDb([[prefRow()]]);
    await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, OPT_OUT);
    const sql = db.writes()[0]?.sql ?? "";
    expect(sql).toContain("ON CONFLICT (tenant_id, user_id, category, channel) DO UPDATE");
    expect(sql).toMatch(/WHERE true/);
  });

  it("reads the prior row in the same statement, so inserted and updated are answerable", async () => {
    const db = fakeDb([[prefRow()]]);
    await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, OPT_OUT);
    const sql = db.writes()[0]?.sql ?? "";
    expect(sql).toContain("WITH prior AS");
    expect(sql).toContain("EXISTS (SELECT 1 FROM prior) AS existed");
    expect(sql).not.toContain("xmax");
  });

  it("binds every value as a parameter, in order", async () => {
    const db = fakeDb([[prefRow()]]);
    await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, OPT_OUT);
    expect(db.writes()[0]?.params).toEqual([
      TENANT,
      USER,
      "marketing",
      "email",
      false,
      "user_set",
      AT,
      ACTOR,
    ]);
  });

  it("reports inserted when nothing was there before", async () => {
    const db = fakeDb([[prefRow({ existed: false })]]);
    const result = await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, {
      ...OPT_OUT,
      expect: "absent",
    });
    expect(result.outcome).toBe("inserted");
    expect(result.entry?.optedIn).toBe(false);
  });

  it("reports updated when the stored decision moved", async () => {
    const db = fakeDb([[prefRow({ existed: true, prior_opted_in: true })]]);
    const result = await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, OPT_OUT);
    expect(result.outcome).toBe("updated");
  });

  it("reports reaffirmed when the stored decision already said this", async () => {
    const db = fakeDb([[prefRow({ existed: true, prior_opted_in: false })]]);
    const result = await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, OPT_OUT);
    expect(result.outcome).toBe("reaffirmed");
  });

  it("reports conflict and returns the STORED row when the premise no longer held", async () => {
    const db = fakeDb([
      [prefRow({ written: false, existed: true, prior_opted_in: true, opted_in: true, source: "admin_set" })],
    ]);
    const result = await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, {
      ...OPT_OUT,
      optedIn: true,
      expect: "opted_out",
    });
    expect(result.outcome).toBe("conflict");
    // The caller aimed at a row saying opted_out; what is there says opted_in. Returning the stored
    // row rather than the input is the whole point — a UI re-renders from it.
    expect(result.entry?.optedIn).toBe(true);
    expect(result.entry?.source).toBe("admin_set");
  });

  it("refuses an opt-in with no expectation, in the store and not only at the route", async () => {
    const db = fakeDb([[prefRow()]]);
    await expect(
      new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, {
        ...OPT_OUT,
        optedIn: true,
      }),
    ).rejects.toThrow(/must name the value it expects to replace/);
    expect(db.writes()).toHaveLength(0);
  });

  it("accepts an opt-out with no expectation, because it is monotonic in the safe direction", async () => {
    const db = fakeDb([[prefRow({ existed: true, prior_opted_in: true })]]);
    const result = await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, OPT_OUT);
    expect(result.outcome).toBe("updated");
  });

  it("renders 'absent' into the predicate so an existing row is never overwritten", async () => {
    const db = fakeDb([[prefRow({ written: false, existed: true, prior_opted_in: true })]]);
    const store = new PostgresNotificationPreferenceStore(db.conn);
    const result = await store.put(SUBJECT, { ...OPT_OUT, optedIn: true, expect: "absent" });
    expect(db.writes()[0]?.sql).toMatch(/DO UPDATE[\s\S]*WHERE false/);
    expect(result.outcome).toBe("conflict");
  });

  it("throws rather than inventing a receipt when nothing comes back at all", async () => {
    const db = fakeDb([[]]);
    await expect(
      new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, OPT_OUT),
    ).rejects.toThrow(/produced no row/);
  });

  it("refuses a tenantId that is not a uuid, naming the field", async () => {
    const db = fakeDb([[prefRow()]]);
    await expect(
      new PostgresNotificationPreferenceStore(db.conn).put(
        { tenantId: "nope", userId: USER },
        OPT_OUT,
      ),
    ).rejects.toThrow(/tenantId must be a uuid/);
  });

  it("refuses a userId that is not a uuid, naming the field", async () => {
    const db = fakeDb([[prefRow()]]);
    await expect(
      new PostgresNotificationPreferenceStore(db.conn).put(
        { tenantId: TENANT, userId: "nope" },
        OPT_OUT,
      ),
    ).rejects.toThrow(/userId must be a uuid/);
  });

  it("writes a null updated_by rather than fabricating an actor", async () => {
    const db = fakeDb([[prefRow({ updated_by: null })]]);
    await new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, {
      ...OPT_OUT,
      updatedBy: null,
    });
    expect(db.writes()[0]?.params[7]).toBeNull();
  });

  it("honours a non-default schema in the statement", async () => {
    const db = fakeDb([[prefRow()]]);
    await new PostgresNotificationPreferenceStore(db.conn, { schema: "ops" }).put(SUBJECT, OPT_OUT);
    expect(db.writes()[0]?.sql).toContain('"ops"."notification_preferences"');
  });
});

describe("preference-store — clear", () => {
  it("deletes under the tenant context with an explicit scope predicate", async () => {
    const db = fakeDb([[]]);
    await new PostgresNotificationPreferenceStore(db.conn).clear(SUBJECT, {
      category: "marketing",
      channel: "email",
    });
    const write = db.writes()[0];
    expect(write?.sql).toMatch(/^DELETE FROM/);
    expect(write?.sql).toMatch(/tenant_id = \$1/);
    expect(write?.params).toEqual([TENANT, USER, "marketing", "email"]);
  });

  it("reports whether a row was actually removed", async () => {
    const present = fakeDb([[prefRow()]]);
    await expect(
      new PostgresNotificationPreferenceStore(present.conn).clear(SUBJECT, {
        category: "marketing",
        channel: "email",
      }),
    ).resolves.toBe(true);
    const absent = fakeDb([[]]);
    await expect(
      new PostgresNotificationPreferenceStore(absent.conn).clear(SUBJECT, {
        category: "marketing",
        channel: "email",
      }),
    ).resolves.toBe(false);
  });
});

describe("preference-store — matrixFor", () => {
  it("reads with a scope predicate and a stable order", async () => {
    const db = fakeDb([[prefRow()]]);
    await new PostgresNotificationPreferenceStore(db.conn).matrixFor(SUBJECT);
    const read = db.captured[db.captured.length - 1];
    expect(read?.sql).toMatch(/tenant_id = \$1/);
    expect(read?.sql).toContain("ORDER BY category, channel");
  });

  it("builds the matrix through the contract's own schema", async () => {
    const db = fakeDb([[prefRow(), prefRow({ category: "operational_digest", opted_in: true })]]);
    const matrix = await new PostgresNotificationPreferenceStore(db.conn).matrixFor(SUBJECT);
    expect(matrix.entries).toHaveLength(2);
    expect(matrix.userId).toBe(USER);
    expect(matrix.updatedAt).toBe(AT);
  });

  it("returns an empty matrix for a subject with no rows, not an error", async () => {
    const db = fakeDb([[]]);
    const matrix = await new PostgresNotificationPreferenceStore(db.conn).matrixFor(SUBJECT);
    expect(matrix.entries).toEqual([]);
  });

  it("normalises a Date from timestamptz into an offset ISO string", async () => {
    const db = fakeDb([[prefRow({ updated_at: new Date("2026-03-04T05:06:07.008Z") })]]);
    const matrix = await new PostgresNotificationPreferenceStore(db.conn).matrixFor(SUBJECT);
    expect(matrix.entries[0]?.updatedAt).toBe("2026-03-04T05:06:07.008Z");
  });
});

describe("preference-store — which rows fail closed and which fail open", () => {
  const suppressible = CONTENT_CATEGORIES.filter(
    (c) => c !== "transactional" && c !== "security_alert",
  );

  for (const category of suppressible) {
    it(`throws on an unreadable ${category} row, because skipping it would send to somebody who opted out`, async () => {
      const db = fakeDb([[prefRow({ category, source: "not_a_source" })]]);
      await expect(
        new PostgresNotificationPreferenceStore(db.conn).matrixFor(SUBJECT),
      ).rejects.toThrow(PreferenceRowUnreadableError);
    });
  }

  for (const category of ["transactional", "security_alert"] as const) {
    it(`drops an unreadable ${category} row, because a preference cannot block it and refusing would withhold it`, async () => {
      const db = fakeDb([[prefRow({ category, source: "not_a_source" })]]);
      const matrix = await new PostgresNotificationPreferenceStore(db.conn).matrixFor(SUBJECT);
      expect(matrix.entries).toEqual([]);
    });
  }

  it("names the defect and the category on the closed side", async () => {
    const db = fakeDb([[prefRow({ category: "marketing", channel: "carrier_pigeon" })]]);
    await expect(
      new PostgresNotificationPreferenceStore(db.conn).matrixFor(SUBJECT),
    ).rejects.toMatchObject({ defect: "entry_unparseable", category: "marketing" });
  });

  it("takes the closed side for an unreadable category, which cannot be attributed to either", async () => {
    const db = fakeDb([[prefRow({ category: "gossip" })]]);
    await expect(
      new PostgresNotificationPreferenceStore(db.conn).matrixFor(SUBJECT),
    ).rejects.toMatchObject({ defect: "category_unreadable", category: null });
  });

  it("does not quote the row's values back in the message for an unreadable category", async () => {
    const db = fakeDb([[prefRow({ category: "gossip" })]]);
    let message = "";
    try {
      await new PostgresNotificationPreferenceStore(db.conn).matrixFor(SUBJECT);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("category_unreadable");
    expect(message).not.toContain(USER);
  });

  it("fails closed on put's read-back too, not only on matrixFor", async () => {
    const db = fakeDb([[prefRow({ category: "marketing", source: "nope" })]]);
    await expect(
      new PostgresNotificationPreferenceStore(db.conn).put(SUBJECT, OPT_OUT),
    ).rejects.toThrow(PreferenceRowUnreadableError);
  });
});

describe("preference-store — the default, and the resolution order", () => {
  it("defaults to delivering everything a category does not require opt-in for", () => {
    expect(defaultOptedIn("transactional")).toBe(true);
    expect(defaultOptedIn("security_alert")).toBe(true);
    expect(defaultOptedIn("system_notice")).toBe(true);
    expect(defaultOptedIn("operational_digest")).toBe(true);
  });

  it("defaults marketing to off, which is the one category that needs asking", () => {
    expect(defaultOptedIn("marketing")).toBe(false);
  });

  it("answers from the stored row when there is one", () => {
    const matrix = {
      userId: USER,
      tenantId: TENANT,
      updatedAt: AT,
      entries: [
        {
          category: "operational_digest" as const,
          channel: "email" as const,
          optedIn: false,
          updatedAt: AT,
          source: "user_set" as const,
        },
      ],
    };
    expect(resolveOptedIn(matrix, "operational_digest", "email")).toEqual({
      optedIn: false,
      from: "stored",
    });
  });

  it("falls to the default for a pair with no stored row, and says so", () => {
    const matrix = { userId: USER, tenantId: TENANT, updatedAt: AT, entries: [] };
    expect(resolveOptedIn(matrix, "operational_digest", "email")).toEqual({
      optedIn: true,
      from: "default",
    });
    expect(resolveOptedIn(matrix, "marketing", "sms")).toEqual({
      optedIn: false,
      from: "default",
    });
  });

  it("does not let a row for one channel answer for another", () => {
    const matrix = {
      userId: USER,
      tenantId: TENANT,
      updatedAt: AT,
      entries: [
        {
          category: "marketing" as const,
          channel: "email" as const,
          optedIn: true,
          updatedAt: AT,
          source: "user_set" as const,
        },
      ],
    };
    expect(resolveOptedIn(matrix, "marketing", "email").optedIn).toBe(true);
    expect(resolveOptedIn(matrix, "marketing", "sms")).toEqual({ optedIn: false, from: "default" });
  });
});
