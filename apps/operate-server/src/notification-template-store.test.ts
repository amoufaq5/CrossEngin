import type { PgConnection } from "@crossengin/kernel-pg";
import type { NotificationTemplate, TemplateStatus } from "@crossengin/notifications";
import { assertBindArity, bindArityMismatch } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import {
  PostgresNotificationTemplateStore,
  decodeTemplateCursor,
  encodeTemplateCursor,
} from "./notification-template-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const APPROVER = "00000000-0000-4000-8000-0000000000a2";

const SET_TENANT_SQL = "set_config('app.current_tenant_id'";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function templateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ntpl_id: "ntpl_aaaaaaaa",
    tenant_id: TENANT_A,
    template_id: "invoice.issued",
    version: "1.0.0",
    locale: "en-US",
    channel: "email",
    category: "transactional",
    status: "draft",
    content: {
      channel: "email",
      subject: "Invoice {{number}}",
      htmlBody: "<p>Invoice {{number}}</p>",
      plaintextBody: "Invoice {{number}}",
    },
    variables: [{ name: "number", type: "string" }],
    body_size_bytes: 64,
    created_at: new Date("2026-09-01T00:00:00.000Z"),
    created_by: AUTHOR,
    approved_at: null,
    approved_by: null,
    deprecated_at: null,
    superseded_by_template_id: null,
    ...overrides,
  };
}

function templateFor(overrides: Partial<NotificationTemplate> = {}): NotificationTemplate {
  return {
    id: "ntpl_aaaaaaaa",
    tenantId: TENANT_A,
    templateId: "invoice.issued",
    version: "1.0.0",
    locale: "en-US",
    channel: "email",
    category: "transactional",
    status: "draft",
    content: {
      channel: "email",
      subject: "Invoice {{number}}",
      htmlBody: "<p>Invoice {{number}}</p>",
      plaintextBody: "Invoice {{number}}",
    },
    variables: [{ name: "number", type: "string", required: true, redactInLogs: false }],
    bodySizeBytes: 64,
    createdAt: "2026-09-01T00:00:00.000Z",
    createdBy: AUTHOR,
    approvedAt: null,
    approvedBy: null,
    deprecatedAt: null,
    supersededByTemplateId: null,
    ...overrides,
  };
}

interface FakeDb {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  /** The tenant each closed transaction was carrying, so RLS confinement is visible. */
  readonly tenants: (string | null)[];
  readonly rows: Map<string, Record<string, unknown>>;
  seed(overrides?: Record<string, unknown>): Record<string, unknown>;
}

/**
 * A scripted fake over `meta.notification_templates` under its RLS policy: a row is visible when it
 * belongs to the transaction's `app.current_tenant_id` or has no tenant at all. Only the statements
 * this store issues are modelled; anything else returns nothing, so an unexpected statement shows up
 * as a failing assertion rather than as a passing test.
 */
function fakeTemplateDb(): FakeDb {
  const captured: Captured[] = [];
  const tenants: (string | null)[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let currentTenant: string | null = null;

  const visible = (): Record<string, unknown>[] =>
    [...rows.values()].filter(
      (r) => r["tenant_id"] === null || r["tenant_id"] === currentTenant,
    );

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p });
    // Postgres refuses in the bind step, before the planner, so no amount of SQL interpretation
    // below reaches it — and all five status transitions were refused there while every test here
    // passed (ADR-0370). Raise where the server would, not after modelling the row.
    assertBindArity(sql, p);
    if (sql.includes("set_config")) {
      currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO")) {
      const key = [p[0], p[2], p[5], p[4], p[3]].join("|");
      for (const existing of rows.values()) {
        const existingKey = [
          existing["tenant_id"],
          existing["template_id"],
          existing["channel"],
          existing["locale"],
          existing["version"],
        ].join("|");
        if (existingKey === key) return { rows: [], rowCount: 0 };
      }
      const row = templateRow({
        tenant_id: p[0],
        ntpl_id: p[1],
        template_id: p[2],
        version: p[3],
        locale: p[4],
        channel: p[5],
        category: p[6],
        status: p[7],
        content: JSON.parse(String(p[8])),
        variables: JSON.parse(String(p[9])),
        body_size_bytes: p[10],
        created_at: new Date(String(p[11])),
        created_by: p[12],
      });
      rows.set(String(p[1]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE")) {
      const row = visible().find(
        (r) => r["tenant_id"] === p[0] && r["ntpl_id"] === p[1] && r["status"] === p[3],
      );
      if (row === undefined) return { rows: [], rowCount: 0 };
      // Resolve each placeholder rather than naming a position, which is the SELECT branch's own
      // idiom and what this branch lacked: it matched the literals `$5` and `$6`, so it modelled
      // one particular numbering of the assignments and silently stopped modelling anything when
      // that numbering changed. A fake that reads positions the way Postgres does cannot drift
      // with the statement it is handed.
      const at = (column: string): number | null => {
        const m = new RegExp(`\\b${column} = \\$(\\d+)`).exec(sql);
        return m === null ? null : Number(m[1]) - 1;
      };
      const fourEyes = /created_by <> \$(\d+)/.exec(sql);
      if (fourEyes !== null && row["created_by"] === p[Number(fourEyes[1]) - 1]) {
        return { rows: [], rowCount: 0 };
      }
      const next: Record<string, unknown> = { ...row, status: p[2] };
      const approvedAt = at("approved_at");
      const approvedBy = at("approved_by");
      if (approvedAt !== null) next["approved_at"] = new Date(String(p[approvedAt]));
      if (approvedBy !== null) next["approved_by"] = p[approvedBy];
      if (sql.includes("approved_at = NULL")) {
        next["approved_at"] = null;
        next["approved_by"] = null;
      }
      const deprecatedAt = at("deprecated_at");
      if (deprecatedAt !== null) next["deprecated_at"] = new Date(String(p[deprecatedAt]));
      rows.set(String(p[1]), next);
      return { rows: [next], rowCount: 1 };
    }
    if (sql.startsWith("SELECT")) {
      let list = visible();
      if (sql.includes("ntpl_id = $2")) list = list.filter((r) => r["ntpl_id"] === p[1]);
      const statusMatch = /\bstatus = \$(\d+)/.exec(sql);
      if (statusMatch !== null) {
        list = list.filter((r) => r["status"] === p[Number(statusMatch[1]) - 1]);
      }
      const templateMatch = /template_id = \$(\d+)/.exec(sql);
      if (templateMatch !== null) {
        list = list.filter((r) => r["template_id"] === p[Number(templateMatch[1]) - 1]);
      }
      const channelMatch = /channel = \$(\d+)/.exec(sql);
      if (channelMatch !== null) {
        list = list.filter((r) => r["channel"] === p[Number(channelMatch[1]) - 1]);
      }
      const seek = /created_at < \$(\d+)::timestamptz OR/.exec(sql);
      if (seek !== null) {
        const atIdx = Number(seek[1]) - 1;
        const cursorAt = Date.parse(String(p[atIdx]));
        const cursorId = String(p[atIdx + 1]);
        list = list.filter((r) => {
          const at = (r["created_at"] as Date).getTime();
          return at < cursorAt || (at === cursorAt && String(r["ntpl_id"]) < cursorId);
        });
      }
      list.sort((a, b) => {
        const av = (a["created_at"] as Date).getTime();
        const bv = (b["created_at"] as Date).getTime();
        if (av !== bv) return bv - av;
        return String(b["ntpl_id"]).localeCompare(String(a["ntpl_id"]));
      });
      const limitMatch = /LIMIT \$(\d+)/.exec(sql);
      const limit = limitMatch === null ? list.length : Number(p[Number(limitMatch[1]) - 1]);
      const page = list.slice(0, limit);
      return { rows: page, rowCount: page.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params)) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
      try {
        return await fn(tx);
      } finally {
        tenants.push(currentTenant);
        currentTenant = null;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };

  const seed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const row = templateRow(overrides);
    rows.set(String(row["ntpl_id"]), row);
    return row;
  };

  return { conn, captured, tenants, rows, seed };
}

/** The first real statement of its kind, skipping the `SELECT set_config(...)` tenant binding. */
function dataStatement(db: FakeDb, prefix: string): Captured | undefined {
  return db.captured.find((c) => c.sql.startsWith(prefix) && !c.sql.includes("set_config"));
}

describe("template cursors", () => {
  it("round-trips", () => {
    const cursor = { createdAt: "2026-09-01T00:00:00.000Z", ntplId: "ntpl_aaaaaaaa" };
    expect(decodeTemplateCursor(encodeTemplateCursor(cursor))).toEqual(cursor);
  });

  it("refuses a cursor it did not issue rather than rewinding to the first page", () => {
    expect(decodeTemplateCursor("not-base64url!!")).toBeNull();
    expect(decodeTemplateCursor(Buffer.from("v1:nope:ntpl_aaaaaaaa").toString("base64url"))).toBeNull();
    expect(decodeTemplateCursor(Buffer.from("v2:2026-09-01T00:00:00.000Z:ntpl_aaaaaaaa").toString("base64url"))).toBeNull();
    expect(decodeTemplateCursor(undefined)).toBeNull();
    expect(decodeTemplateCursor("")).toBeNull();
  });
});

describe("PostgresNotificationTemplateStore.createDraft", () => {
  it("inserts a draft inside the caller's tenant context and binds every value", async () => {
    const db = fakeTemplateDb();
    const store = new PostgresNotificationTemplateStore(db.conn);
    const created = await store.createDraft(TENANT_A, templateFor());
    expect(created?.status).toBe("draft");
    expect(db.captured[0]?.sql).toContain(SET_TENANT_SQL);
    const insert = dataStatement(db, "INSERT INTO");
    expect(insert?.sql).toContain("meta.notification_templates");
    expect(insert?.sql).toContain("ON CONFLICT ON CONSTRAINT notification_templates_tenant_template_locale_version_key DO NOTHING");
    expect(insert?.params[0]).toBe(TENANT_A);
    expect(insert?.params[7]).toBe("draft");
    expect(db.tenants).toEqual([TENANT_A]);
  });

  it("returns null when the tenant already has that version, rather than overwriting it", async () => {
    const db = fakeTemplateDb();
    db.seed();
    const store = new PostgresNotificationTemplateStore(db.conn);
    expect(await store.createDraft(TENANT_A, templateFor({ id: "ntpl_bbbbbbbb" }))).toBeNull();
  });

  it("refuses to author a platform-wide template", async () => {
    const db = fakeTemplateDb();
    const store = new PostgresNotificationTemplateStore(db.conn);
    await expect(store.createDraft(TENANT_A, templateFor({ tenantId: null }))).rejects.toThrow(
      /platform-wide/,
    );
    expect(db.captured).toEqual([]);
  });

  it("refuses another tenant's template before any SQL is issued", async () => {
    const db = fakeTemplateDb();
    const store = new PostgresNotificationTemplateStore(db.conn);
    await expect(store.createDraft(TENANT_A, templateFor({ tenantId: TENANT_B }))).rejects.toThrow(
      /does not match caller tenant/,
    );
    expect(db.captured).toEqual([]);
  });

  it("refuses to insert anything but a draft, so an approval cannot be written directly", async () => {
    const db = fakeTemplateDb();
    const store = new PostgresNotificationTemplateStore(db.conn);
    await expect(
      store.createDraft(
        TENANT_A,
        templateFor({ status: "approved", approvedAt: "2026-09-02T00:00:00.000Z", approvedBy: APPROVER }),
      ),
    ).rejects.toThrow(/must be a draft/);
    expect(db.captured).toEqual([]);
  });
});

describe("PostgresNotificationTemplateStore.get", () => {
  it("reads the tenant's own template", async () => {
    const db = fakeTemplateDb();
    db.seed();
    const store = new PostgresNotificationTemplateStore(db.conn);
    const found = await store.get(TENANT_A, "ntpl_aaaaaaaa");
    expect(found?.templateId).toBe("invoice.issued");
    expect(dataStatement(db, "SELECT")?.sql).toContain("WHERE tenant_id = $1 AND ntpl_id = $2");
  });

  it("does not see another tenant's template", async () => {
    const db = fakeTemplateDb();
    db.seed();
    const store = new PostgresNotificationTemplateStore(db.conn);
    expect(await store.get(TENANT_B, "ntpl_aaaaaaaa")).toBeNull();
  });

  it("issues no query for an id that cannot be one", async () => {
    const db = fakeTemplateDb();
    const store = new PostgresNotificationTemplateStore(db.conn);
    expect(await store.get(TENANT_A, "' OR 1=1 --")).toBeNull();
    expect(db.captured).toEqual([]);
  });

  it("refuses a row the contract forbids — an approval by its own author", async () => {
    const db = fakeTemplateDb();
    db.seed({ status: "approved", approved_at: new Date("2026-09-02T00:00:00.000Z"), approved_by: AUTHOR });
    const store = new PostgresNotificationTemplateStore(db.conn);
    await expect(store.get(TENANT_A, "ntpl_aaaaaaaa")).rejects.toThrow();
  });
});

describe("PostgresNotificationTemplateStore.list", () => {
  it("pages by keyset with the filters bound", async () => {
    const db = fakeTemplateDb();
    db.seed();
    db.seed({ ntpl_id: "ntpl_bbbbbbbb", version: "1.0.1", created_at: new Date("2026-09-03T00:00:00.000Z") });
    const store = new PostgresNotificationTemplateStore(db.conn);
    const page = await store.list(TENANT_A, { status: "draft", limit: 1 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.id).toBe("ntpl_bbbbbbbb");
    expect(page.nextCursor).not.toBeNull();
    const select = dataStatement(db, "SELECT");
    expect(select?.sql).toContain("ORDER BY created_at DESC, ntpl_id DESC");
    // limit + 1, so "is there another page" is answered without a second count query.
    expect(select?.params[select.params.length - 1]).toBe(2);
    expect(select?.params).toContain("draft");
  });

  it("walks to the next page from its own cursor", async () => {
    const db = fakeTemplateDb();
    db.seed();
    db.seed({ ntpl_id: "ntpl_bbbbbbbb", version: "1.0.1", created_at: new Date("2026-09-03T00:00:00.000Z") });
    const store = new PostgresNotificationTemplateStore(db.conn);
    const first = await store.list(TENANT_A, { limit: 1 });
    const second = await store.list(TENANT_A, {
      limit: 1,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    });
    expect(second.data[0]?.id).toBe("ntpl_aaaaaaaa");
    expect(second.nextCursor).toBeNull();
  });

  it("throws on a cursor it did not issue", async () => {
    const db = fakeTemplateDb();
    const store = new PostgresNotificationTemplateStore(db.conn);
    await expect(store.list(TENANT_A, { cursor: "nonsense" })).rejects.toThrow(/cursor/);
  });

  it("refuses the whole page when one row no longer parses, rather than shortening it", async () => {
    const db = fakeTemplateDb();
    db.seed();
    db.seed({ ntpl_id: "ntpl_bbbbbbbb", version: "1.0.1", status: "published_everywhere" });
    const store = new PostgresNotificationTemplateStore(db.conn);
    await expect(store.list(TENANT_A, {})).rejects.toThrow();
  });
});

describe("PostgresNotificationTemplateStore.transition", () => {
  it("moves a draft into review", async () => {
    const db = fakeTemplateDb();
    db.seed();
    const store = new PostgresNotificationTemplateStore(db.conn);
    const outcome = await store.transition(TENANT_A, "ntpl_aaaaaaaa", {
      to: "in_review",
      actorId: AUTHOR,
      at: "2026-09-02T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("transitioned");
    const update = dataStatement(db, "UPDATE");
    // The status it must still have is a predicate, so two moves racing cannot both win.
    expect(update?.sql).toContain("status = $4");
    expect(update?.params[3]).toBe("draft");
  });

  it("stamps the approval and carries four-eyes into the UPDATE's own predicate", async () => {
    const db = fakeTemplateDb();
    db.seed({ status: "in_review" });
    const store = new PostgresNotificationTemplateStore(db.conn);
    const outcome = await store.transition(TENANT_A, "ntpl_aaaaaaaa", {
      to: "approved",
      actorId: APPROVER,
      at: "2026-09-02T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("transitioned");
    if (outcome.kind !== "transitioned") return;
    expect(outcome.template.approvedBy).toBe(APPROVER);
    expect(outcome.template.approvedAt).toBe("2026-09-02T00:00:00.000Z");
    const update = dataStatement(db, "UPDATE");
    // This assertion used to read `toContain("approved_by = $5")` beside
    // `toContain("created_by <> $5")` — it did not merely miss the defect, it **required** it.
    // One parameter in both positions is what pinned `$5` to `text` through the predicate and made
    // the assignment raise `42804` against a UUID column, so the only statement this test admitted
    // was the one no server would run. What has to be true is that the actor reaches both
    // positions and that the two are bound *separately*; which numbers they get is the store's
    // business, so the positions are resolved rather than named.
    const posOf = (fragment: string): number => {
      const m = new RegExp(`${fragment} \\$(\\d+)`).exec(update?.sql ?? "");
      expect(m).not.toBeNull();
      return Number(m?.[1] ?? "0") - 1;
    };
    const assigned = posOf("approved_by =");
    const compared = posOf("created_by <>");
    expect(update?.params[assigned]).toBe(APPROVER);
    expect(update?.params[compared]).toBe(APPROVER);
    expect(assigned).not.toBe(compared);
    // And the statement references exactly what it binds, which is the bind step the fake has no
    // model of and the four other transitions failed.
    expect(bindArityMismatch(update?.sql ?? "", update?.params)).toBeNull();
  });

  it("binds exactly the parameters it references, on every one of the five transitions", async () => {
    // The regression this increment exists for: all five were refused in the bind step — three
    // `08P01`, one `42P18`, one `42804` — while every test in this file passed. The arity half is
    // asserted per transition here rather than only inside the fake, so the property is visible as
    // a test with the five targets named and not only as a guard that happens to raise.
    const walks: readonly { readonly from: TemplateStatus; readonly to: TemplateStatus }[] = [
      { from: "draft", to: "in_review" },
      { from: "in_review", to: "approved" },
      { from: "in_review", to: "draft" },
      { from: "approved", to: "deprecated" },
      { from: "approved", to: "retired" },
    ];
    for (const walk of walks) {
      const db = fakeTemplateDb();
      // An `approved` row must already carry its stamp, or `templateFromRow` refuses the RETURNING
      // row on the contract's own status↔field pairing before the arity is ever reached.
      const stamp =
        walk.from === "approved"
          ? { approved_at: new Date("2026-09-01T00:00:00.000Z"), approved_by: APPROVER }
          : {};
      db.seed({ status: walk.from, created_by: AUTHOR, ...stamp });
      const store = new PostgresNotificationTemplateStore(db.conn);
      const outcome = await store.transition(TENANT_A, "ntpl_aaaaaaaa", {
        to: walk.to,
        actorId: APPROVER,
        at: "2026-09-02T00:00:00.000Z",
      });
      expect(outcome.kind, `${walk.from} -> ${walk.to}`).toBe("transitioned");
      const update = dataStatement(db, "UPDATE");
      expect(update, `${walk.from} -> ${walk.to} issued no UPDATE`).not.toBeUndefined();
      expect(
        bindArityMismatch(update?.sql ?? "", update?.params),
        `${walk.from} -> ${walk.to}`,
      ).toBeNull();
    }
  });

  it("refuses the author approving their own template, and issues no UPDATE at all", async () => {
    const db = fakeTemplateDb();
    db.seed({ status: "in_review" });
    const store = new PostgresNotificationTemplateStore(db.conn);
    const outcome = await store.transition(TENANT_A, "ntpl_aaaaaaaa", {
      to: "approved",
      actorId: AUTHOR,
      at: "2026-09-02T00:00:00.000Z",
    });
    expect(outcome).toEqual({ kind: "four_eyes", authorId: AUTHOR });
    expect(dataStatement(db, "UPDATE")).toBeUndefined();
  });

  it("would still refuse it at the UPDATE if the pre-check were bypassed", async () => {
    // The statement the store actually issues, run directly: the `created_by <> $5` predicate
    // matches nothing, so a self-approval that got past the pre-check still writes no row.
    const db = fakeTemplateDb();
    db.seed({ status: "in_review" });
    const result = await db.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
      return tx.query(
        "UPDATE meta.notification_templates SET status = $3, approved_at = $6::timestamptz," +
          " approved_by = $5 WHERE tenant_id = $1 AND ntpl_id = $2 AND status = $4" +
          " AND created_by <> $5 RETURNING ntpl_id",
        [TENANT_A, "ntpl_aaaaaaaa", "approved", "in_review", AUTHOR, "2026-09-02T00:00:00.000Z"],
      );
    });
    expect(result.rowCount).toBe(0);
  });

  it("reports an illegal transition without touching the row", async () => {
    const db = fakeTemplateDb();
    db.seed();
    const store = new PostgresNotificationTemplateStore(db.conn);
    const outcome = await store.transition(TENANT_A, "ntpl_aaaaaaaa", {
      to: "approved",
      actorId: APPROVER,
      at: "2026-09-02T00:00:00.000Z",
    });
    expect(outcome).toEqual({ kind: "illegal_transition", from: "draft", to: "approved" });
    expect(dataStatement(db, "UPDATE")).toBeUndefined();
  });

  it("clears a stale approval on the way back to draft", async () => {
    const db = fakeTemplateDb();
    db.seed({ status: "in_review", approved_at: new Date("2026-09-02T00:00:00.000Z"), approved_by: APPROVER });
    const store = new PostgresNotificationTemplateStore(db.conn);
    const outcome = await store.transition(TENANT_A, "ntpl_aaaaaaaa", {
      to: "draft",
      actorId: APPROVER,
      at: "2026-09-03T00:00:00.000Z",
    });
    expect(outcome.kind).toBe("transitioned");
    if (outcome.kind !== "transitioned") return;
    expect(outcome.template.approvedBy).toBeNull();
    expect(dataStatement(db, "UPDATE")?.sql).toContain("approved_by = NULL");
  });

  it("reports not_found for a missing template and for an impossible id", async () => {
    const db = fakeTemplateDb();
    const store = new PostgresNotificationTemplateStore(db.conn);
    expect(
      await store.transition(TENANT_A, "ntpl_aaaaaaaa", {
        to: "in_review",
        actorId: AUTHOR,
        at: "2026-09-02T00:00:00.000Z",
      }),
    ).toEqual({ kind: "not_found" });
    expect(
      await store.transition(TENANT_A, "drop table", {
        to: "in_review",
        actorId: AUTHOR,
        at: "2026-09-02T00:00:00.000Z",
      }),
    ).toEqual({ kind: "not_found" });
  });

  it("reports a conflict when the row moved under the read", async () => {
    const db = fakeTemplateDb();
    db.seed();
    let moved = false;
    // A writer that slips in between the store's read and its UPDATE: the row leaves `draft`, so
    // the `status = $4` predicate matches nothing.
    const racing: PgConnection = {
      ...db.conn,
      transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) =>
        db.conn.transaction(async (tx) => {
          const wrapped: PgConnection = {
            ...tx,
            query: ((sql: string, params?: readonly unknown[]) => {
              if (!moved && sql.startsWith("UPDATE")) {
                moved = true;
                const row = db.rows.get("ntpl_aaaaaaaa");
                if (row !== undefined) db.rows.set("ntpl_aaaaaaaa", { ...row, status: "retired" });
              }
              return tx.query(sql, params);
            }) as PgConnection["query"],
          };
          return fn(wrapped);
        })) as PgConnection["transaction"],
    };
    const outcome = await new PostgresNotificationTemplateStore(racing).transition(
      TENANT_A,
      "ntpl_aaaaaaaa",
      { to: "in_review", actorId: AUTHOR, at: "2026-09-02T00:00:00.000Z" },
    );
    expect(outcome).toEqual({ kind: "conflict", from: "draft" });
  });

  it("rejects an invalid schema name and an unparseable actor", async () => {
    const db = fakeTemplateDb();
    expect(() => new PostgresNotificationTemplateStore(db.conn, { schema: "me ta" })).toThrow(
      /invalid schema/,
    );
    db.seed();
    const store = new PostgresNotificationTemplateStore(db.conn);
    await expect(
      store.transition(TENANT_A, "ntpl_aaaaaaaa", {
        to: "in_review",
        actorId: "nobody",
        at: "2026-09-02T00:00:00.000Z",
      }),
    ).rejects.toThrow(/actor id/);
  });
});
