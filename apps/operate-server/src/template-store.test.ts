import type { PgConnection } from "@crossengin/kernel-pg";
import { NotificationTemplateSchema, type NotificationTemplate } from "@crossengin/notifications";
import { beforeEach, describe, expect, it } from "vitest";

import {
  PostgresTemplateStore,
  languageOnlyLocale,
  templateFromRow,
  tryTemplateFromRow,
  type TemplateQuery,
} from "./template-store.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";

const TEMPLATE_ID = "billing.invoice_due";
const SUBJECT = "Your invoice is due";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

type Row = Record<string, unknown>;

let rowSeq = 0;

beforeEach(() => {
  rowSeq = 0;
});

function emailContent(): Row {
  return {
    channel: "email",
    subject: SUBJECT,
    htmlBody: "<p>Your invoice is due.</p>",
    plaintextBody: "Your invoice is due.",
  };
}

function templateRow(overrides: Row = {}): Row {
  rowSeq += 1;
  return {
    id: `66666666-6666-4666-8666-${String(rowSeq).padStart(12, "0")}`,
    ntpl_id: `ntpl_billing${String(rowSeq).padStart(4, "0")}`,
    tenant_id: TENANT_A,
    template_id: TEMPLATE_ID,
    version: "1.0.0",
    locale: "en",
    channel: "email",
    category: "transactional",
    status: "approved",
    content: emailContent(),
    variables: [],
    body_size_bytes: 2048,
    created_at: "2026-08-01T09:00:00.000Z",
    created_by: USER_A,
    approved_at: "2026-08-01T10:00:00.000Z",
    approved_by: USER_B,
    deprecated_at: null,
    superseded_by_template_id: null,
    ...overrides,
  };
}

function templateOf(overrides: Partial<NotificationTemplate> = {}): NotificationTemplate {
  return {
    id: "ntpl_billing0001",
    tenantId: TENANT_A,
    templateId: TEMPLATE_ID,
    version: "1.0.0",
    locale: "en",
    channel: "email",
    category: "transactional",
    status: "approved",
    content: {
      channel: "email",
      subject: SUBJECT,
      htmlBody: "<p>Your invoice is due.</p>",
      plaintextBody: "Your invoice is due.",
    },
    variables: [{ name: "invoiceNumber", type: "string", required: true, redactInLogs: false }],
    bodySizeBytes: 2048,
    createdAt: "2026-08-01T09:00:00.000Z",
    createdBy: USER_A,
    approvedAt: "2026-08-01T10:00:00.000Z",
    approvedBy: USER_B,
    deprecatedAt: null,
    supersededByTemplateId: null,
    ...overrides,
  };
}

function queryOf(overrides: Partial<TemplateQuery> = {}): TemplateQuery {
  return { templateId: TEMPLATE_ID, locale: "en", channel: "email", ...overrides };
}

/** The tenant-context `SELECT set_config(...)` also starts with SELECT. */
function isSelect(captured: Captured): boolean {
  return captured.sql.startsWith("SELECT ") && !captured.sql.includes("set_config");
}

function versionKey(value: unknown): readonly number[] {
  return String(value)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}

/** Element-wise numeric compare, mirroring `string_to_array(version, '.')::int[]`. */
function compareVersionDesc(a: unknown, b: unknown): number {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const d = (right[i] ?? 0) - (left[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return new Date(String(value)).getTime();
}

interface FakeDb {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  readonly templates: Row[];
}

/**
 * A scripted fake PgConnection modelling `meta.notification_templates` under its
 * tenant-or-platform RLS policy: a row is visible when its `tenant_id` matches
 * the transaction's `app.current_tenant_id` OR is NULL, so an operator's
 * platform-wide row is legitimately readable by every tenant. It enforces the
 * table's UNIQUE `(tenant_id, template_id, channel, locale, version)` so
 * `ON CONFLICT … DO UPDATE` really does update in place, and it evaluates the
 * resolution ORDER BY — tenant row before platform row, then highest semver
 * compared component-wise — rather than letting the store sort in TypeScript.
 */
function fakeTemplateDb(): FakeDb {
  const captured: Captured[] = [];
  const templates: Row[] = [];
  let insertSeq = 0;
  let currentTenant: string | null = null;

  const project = (sql: string, row: Row): Row => {
    const columns = sql
      .slice("SELECT ".length, sql.indexOf(" FROM "))
      .split(",")
      .map((c) => c.trim());
    const projected: Row = {};
    for (const column of columns) projected[column] = row[column];
    return projected;
  };

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
    inTx: boolean,
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p, inTx });

    if (sql.includes("set_config")) {
      currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }

    const tenantId = String(p[0]);
    const rlsVisible = (r: Row): boolean =>
      r["tenant_id"] == null || r["tenant_id"] === currentTenant;

    if (sql.startsWith("INSERT INTO")) {
      if (p[0] !== currentTenant) return { rows: [], rowCount: 0 };
      const existing = templates.find(
        (r) =>
          r["tenant_id"] === p[0] &&
          r["template_id"] === p[2] &&
          r["channel"] === p[5] &&
          r["locale"] === p[4] &&
          r["version"] === p[3],
      );
      if (existing !== undefined) {
        if (!sql.includes("ON CONFLICT ON CONSTRAINT")) {
          throw new Error("duplicate key value violates unique constraint");
        }
        existing["category"] = p[6];
        existing["status"] = p[7];
        existing["content"] = p[8];
        existing["variables"] = p[9];
        existing["body_size_bytes"] = p[10];
        existing["approved_at"] = p[13];
        existing["approved_by"] = p[14];
        existing["deprecated_at"] = p[15];
        existing["superseded_by_template_id"] = p[16];
        return { rows: [], rowCount: 1 };
      }
      insertSeq += 1;
      templates.push({
        id: `66666666-6666-4666-8666-${String(900 + insertSeq).padStart(12, "0")}`,
        tenant_id: p[0],
        ntpl_id: p[1],
        template_id: p[2],
        version: p[3],
        locale: p[4],
        channel: p[5],
        category: p[6],
        status: p[7],
        content: p[8],
        variables: p[9],
        body_size_bytes: p[10],
        created_at: p[11],
        created_by: p[12],
        approved_at: p[13],
        approved_by: p[14],
        deprecated_at: p[15],
        superseded_by_template_id: p[16],
      });
      return { rows: [], rowCount: 1 };
    }

    if (isSelect({ sql, params: p, inTx }) && sql.includes("AND template_id = $2")) {
      const matched = templates
        .filter((r) => rlsVisible(r))
        .filter((r) => r["tenant_id"] === tenantId || r["tenant_id"] == null)
        .filter(
          (r) =>
            r["template_id"] === p[1] &&
            r["locale"] === p[2] &&
            r["channel"] === p[3] &&
            r["status"] === "approved",
        )
        .sort((a, b) => {
          const aPlatform = a["tenant_id"] == null ? 1 : 0;
          const bPlatform = b["tenant_id"] == null ? 1 : 0;
          if (aPlatform !== bPlatform) return aPlatform - bPlatform;
          return compareVersionDesc(a["version"], b["version"]);
        })
        .slice(0, 1)
        .map((r) => project(sql, r));
      return { rows: matched, rowCount: matched.length };
    }

    if (isSelect({ sql, params: p, inTx }) && sql.includes("WHERE tenant_id = $1")) {
      const limit = Number(p[1]);
      const rows = templates
        .filter((r) => rlsVisible(r) && r["tenant_id"] === tenantId)
        .sort((a, b) => {
          const d = toMillis(b["created_at"]) - toMillis(a["created_at"]);
          if (d !== 0) return d;
          return String(b["ntpl_id"]).localeCompare(String(a["ntpl_id"]));
        })
        .slice(0, limit)
        .map((r) => project(sql, r));
      return { rows, rowCount: rows.length };
    }

    return { rows: [], rowCount: 0 };
  };

  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) =>
      run(sql, params, true)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) =>
      run(sql, params, false)) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
      try {
        return await fn(tx);
      } finally {
        currentTenant = null;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
      fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, captured, templates };
}

/** Stands in for a write the RLS WITH CHECK refused: the statement affects no row. */
function swallowInsert(conn: PgConnection): PgConnection {
  const wrap = (t: PgConnection): PgConnection => ({
    query: (async (sql: string, params?: readonly unknown[]) => {
      if (sql.startsWith("INSERT INTO")) return { rows: [], rowCount: 0 };
      return t.query(sql, params);
    }) as PgConnection["query"],
    transaction: ((fn: (tx: PgConnection) => Promise<unknown>) =>
      t.transaction(fn)) as PgConnection["transaction"],
    withAdvisoryLock: ((k: bigint, fn: () => Promise<unknown>) =>
      t.withAdvisoryLock(k, fn)) as PgConnection["withAdvisoryLock"],
    close: (() => t.close()) as PgConnection["close"],
  });
  return {
    ...wrap(conn),
    transaction: ((fn: (tx: PgConnection) => Promise<unknown>) =>
      conn.transaction((tx) => fn(wrap(tx)))) as PgConnection["transaction"],
  };
}

describe("template-store — find precedence", () => {
  it("prefers the tenant's own override over the platform default", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(
      templateRow({ tenant_id: null, ntpl_id: "ntpl_platform001", version: "3.0.0" }),
      templateRow({ ntpl_id: "ntpl_tenantown01", version: "1.0.0" }),
    );
    const store = new PostgresTemplateStore(conn);
    const found = await store.find(TENANT_A, queryOf());
    expect(found?.id).toBe("ntpl_tenantown01");
    expect(found?.tenantId).toBe(TENANT_A);
  });

  it("falls back to the platform default when the tenant has authored nothing", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(templateRow({ tenant_id: null, ntpl_id: "ntpl_platform001" }));
    const store = new PostgresTemplateStore(conn);
    const found = await store.find(TENANT_A, queryOf());
    expect(found?.id).toBe("ntpl_platform001");
    expect(found?.tenantId).toBeNull();
  });

  // A plain text sort silently gets both of these backwards: '10' < '9' as text.
  it("picks the highest version numerically — 10.0.0 beats 9.0.0, 1.10.0 beats 1.9.0", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(
      templateRow({ ntpl_id: "ntpl_version009", version: "9.0.0" }),
      templateRow({ ntpl_id: "ntpl_version010", version: "10.0.0" }),
    );
    const store = new PostgresTemplateStore(conn);
    expect((await store.find(TENANT_A, queryOf()))?.version).toBe("10.0.0");

    const minor = fakeTemplateDb();
    minor.templates.push(
      templateRow({ ntpl_id: "ntpl_version001", version: "1.9.0" }),
      templateRow({ ntpl_id: "ntpl_version002", version: "1.10.0" }),
    );
    const minorStore = new PostgresTemplateStore(minor.conn);
    expect((await minorStore.find(TENANT_A, queryOf()))?.version).toBe("1.10.0");
  });
});

describe("template-store — find query shape", () => {
  it("matches tenant-or-platform rows and binds every value", async () => {
    const { conn, captured } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    await store.find(TENANT_A, queryOf({ locale: "fr", channel: "sms" }));
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("WHERE (tenant_id = $1 OR tenant_id IS NULL)");
    expect(select?.sql).toContain("AND template_id = $2 AND locale = $3 AND channel = $4");
    expect(select?.sql).toContain("AND status = 'approved'");
    expect(select?.sql).toContain(
      "ORDER BY (tenant_id IS NULL) ASC, string_to_array(version, '.')::int[] DESC LIMIT 1",
    );
    expect(select?.params).toEqual([TENANT_A, TEMPLATE_ID, "fr", "sms"]);
    expect(select?.inTx).toBe(true);
  });

  it("ignores draft, in_review and deprecated rows", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(
      templateRow({ ntpl_id: "ntpl_draft00001", version: "9.0.0", status: "draft" }),
      templateRow({ ntpl_id: "ntpl_review00001", version: "8.0.0", status: "in_review" }),
      templateRow({
        ntpl_id: "ntpl_deprecated1",
        version: "7.0.0",
        status: "deprecated",
        deprecated_at: "2026-08-02T09:00:00.000Z",
      }),
      templateRow({ ntpl_id: "ntpl_approved01", version: "1.0.0" }),
    );
    const store = new PostgresTemplateStore(conn);
    expect((await store.find(TENANT_A, queryOf()))?.id).toBe("ntpl_approved01");
  });

  it("returns null when no template matches", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(templateRow({ template_id: "billing.invoice_paid" }));
    const store = new PostgresTemplateStore(conn);
    expect(await store.find(TENANT_A, queryOf())).toBeNull();
    expect(await store.find(TENANT_A, queryOf({ channel: "sms" }))).toBeNull();
  });

  it("never resolves another tenant's override", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(templateRow({ tenant_id: TENANT_B, ntpl_id: "ntpl_othertenant" }));
    const store = new PostgresTemplateStore(conn);
    expect(await store.find(TENANT_A, queryOf())).toBeNull();
    expect((await store.find(TENANT_B, queryOf()))?.id).toBe("ntpl_othertenant");
  });

  it("returns null rather than throwing when the stored row fails the schema", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(templateRow({ content: { channel: "sms", body: "mismatched channel" } }));
    const store = new PostgresTemplateStore(conn);
    expect(await store.find(TENANT_A, queryOf())).toBeNull();
  });
});

describe("template-store — locale fallback", () => {
  it("falls back from en-GB to a stored en row", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(templateRow({ locale: "en", ntpl_id: "ntpl_language01" }));
    const store = new PostgresTemplateStore(conn);
    const found = await store.find(TENANT_A, queryOf({ locale: "en-GB" }));
    expect(found?.id).toBe("ntpl_language01");
    expect(found?.locale).toBe("en");
  });

  it("issues the fallback as a second query rebinding only the locale", async () => {
    const { conn, captured, templates } = fakeTemplateDb();
    templates.push(templateRow({ locale: "en" }));
    const store = new PostgresTemplateStore(conn);
    await store.find(TENANT_A, queryOf({ locale: "en-GB" }));
    const selects = captured.filter((c) => isSelect(c));
    expect(selects).toHaveLength(2);
    expect(selects[0]?.params).toEqual([TENANT_A, TEMPLATE_ID, "en-GB", "email"]);
    expect(selects[1]?.params).toEqual([TENANT_A, TEMPLATE_ID, "en", "email"]);
    expect(selects[0]?.sql).toBe(selects[1]?.sql);
  });

  it("prefers an exact regional row and never issues the fallback", async () => {
    const { conn, captured, templates } = fakeTemplateDb();
    templates.push(
      templateRow({ locale: "en", ntpl_id: "ntpl_language01", version: "9.0.0" }),
      templateRow({ locale: "en-GB", ntpl_id: "ntpl_regional001", version: "1.0.0" }),
    );
    const store = new PostgresTemplateStore(conn);
    const found = await store.find(TENANT_A, queryOf({ locale: "en-GB" }));
    expect(found?.id).toBe("ntpl_regional001");
    expect(captured.filter((c) => isSelect(c))).toHaveLength(1);
  });

  it("issues just one query for a language-only locale that misses", async () => {
    const { conn, captured } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    expect(await store.find(TENANT_A, queryOf({ locale: "en" }))).toBeNull();
    expect(captured.filter((c) => isSelect(c))).toHaveLength(1);
  });

  it("returns null when neither the exact locale nor its language matches", async () => {
    const { conn, captured, templates } = fakeTemplateDb();
    templates.push(templateRow({ locale: "fr" }));
    const store = new PostgresTemplateStore(conn);
    expect(await store.find(TENANT_A, queryOf({ locale: "en-GB" }))).toBeNull();
    expect(captured.filter((c) => isSelect(c))).toHaveLength(2);
  });

  it("derives the language-only locale only from a regioned one", () => {
    expect(languageOnlyLocale("en-GB")).toBe("en");
    expect(languageOnlyLocale("pt-BR")).toBe("pt");
    expect(languageOnlyLocale("en")).toBeNull();
    expect(languageOnlyLocale("en-gb")).toBeNull();
    expect(languageOnlyLocale("")).toBeNull();
  });
});

describe("template-store — upsert", () => {
  it("writes the tenant's own row and reports that a row was written", async () => {
    const { conn, templates } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    expect(await store.upsert(TENANT_A, templateOf())).toBe(true);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.["tenant_id"]).toBe(TENANT_A);
    expect(templates[0]?.["ntpl_id"]).toBe("ntpl_billing0001");
  });

  it("inserts ON CONFLICT DO UPDATE over the table's unique constraint", async () => {
    const { conn, captured } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    await store.upsert(TENANT_A, templateOf());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain(
      "INSERT INTO meta.notification_templates (tenant_id, ntpl_id, template_id, version," +
        " locale, channel, category, status, content, variables, body_size_bytes, created_at," +
        " created_by, approved_at, approved_by, deprecated_at, superseded_by_template_id)",
    );
    expect(insert?.sql).toContain(
      "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14," +
        " $15, $16, $17)",
    );
    expect(insert?.sql).toContain(
      "ON CONFLICT ON CONSTRAINT notification_templates_tenant_template_locale_version_key" +
        " DO UPDATE SET",
    );
    for (const column of [
      "content = EXCLUDED.content",
      "variables = EXCLUDED.variables",
      "status = EXCLUDED.status",
      "category = EXCLUDED.category",
      "channel = EXCLUDED.channel",
      "body_size_bytes = EXCLUDED.body_size_bytes",
      "approved_at = EXCLUDED.approved_at",
      "approved_by = EXCLUDED.approved_by",
    ]) {
      expect(insert?.sql).toContain(column);
    }
  });

  it("binds the caller's tenant as $1 and serialises the JSONB columns", async () => {
    const { conn, captured } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    const template = templateOf();
    await store.upsert(TENANT_A, template);
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.params).toEqual([
      TENANT_A,
      "ntpl_billing0001",
      TEMPLATE_ID,
      "1.0.0",
      "en",
      "email",
      "transactional",
      "approved",
      JSON.stringify(template.content),
      JSON.stringify(template.variables),
      2048,
      "2026-08-01T09:00:00.000Z",
      USER_A,
      "2026-08-01T10:00:00.000Z",
      USER_B,
      null,
      null,
    ]);
  });

  it("updates the stored body in place on a repeat write", async () => {
    const { conn, templates } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    await store.upsert(TENANT_A, templateOf());
    const revised = templateOf({
      content: {
        channel: "email",
        subject: "Revised subject",
        htmlBody: "<p>Revised.</p>",
        plaintextBody: "Revised.",
      },
      bodySizeBytes: 4096,
    });
    expect(await store.upsert(TENANT_A, revised)).toBe(true);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.["body_size_bytes"]).toBe(4096);
    expect(String(templates[0]?.["content"])).toContain("Revised subject");
  });

  it("refuses to author a platform-wide template, before any SQL", async () => {
    const { conn, captured } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    await expect(
      store.upsert(TENANT_A, templateOf({ tenantId: null })),
    ).rejects.toThrow(/platform-wide/);
    expect(captured).toHaveLength(0);
  });

  it("refuses to author another tenant's template, before any SQL", async () => {
    const { conn, captured } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    await expect(
      store.upsert(TENANT_A, templateOf({ tenantId: TENANT_B })),
    ).rejects.toThrow(/does not match caller tenant/);
    expect(captured).toHaveLength(0);
  });

  it("reports false when the statement wrote no row", async () => {
    const { conn, templates } = fakeTemplateDb();
    const store = new PostgresTemplateStore(swallowInsert(conn));
    expect(await store.upsert(TENANT_A, templateOf())).toBe(false);
    expect(templates).toHaveLength(0);
  });

  it("keeps each tenant's override separate", async () => {
    const { conn, templates } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    await store.upsert(TENANT_A, templateOf());
    await store.upsert(TENANT_B, templateOf({ tenantId: TENANT_B, id: "ntpl_billing0002" }));
    expect(templates).toHaveLength(2);
    expect((await store.find(TENANT_A, queryOf()))?.id).toBe("ntpl_billing0001");
    expect((await store.find(TENANT_B, queryOf()))?.id).toBe("ntpl_billing0002");
  });
});

describe("template-store — listForTenant", () => {
  it("returns only the tenant's own overrides, never the platform rows", async () => {
    const { conn, captured, templates } = fakeTemplateDb();
    templates.push(
      templateRow({ tenant_id: null, ntpl_id: "ntpl_platform001" }),
      templateRow({ ntpl_id: "ntpl_tenantown01" }),
    );
    const store = new PostgresTemplateStore(conn);
    const listed = await store.listForTenant(TENANT_A);
    expect(listed.map((t) => t.id)).toEqual(["ntpl_tenantown01"]);
    const select = captured.find((c) => isSelect(c));
    expect(select?.sql).toContain("WHERE tenant_id = $1");
    expect(select?.sql).not.toContain("tenant_id IS NULL");
    expect(select?.sql).toContain("ORDER BY created_at DESC, ntpl_id DESC LIMIT $2");
  });

  it("returns the newest authored template first", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(
      templateRow({ ntpl_id: "ntpl_older00001", created_at: "2026-08-01T09:00:00.000Z" }),
      templateRow({ ntpl_id: "ntpl_newer00001", created_at: "2026-08-03T09:00:00.000Z" }),
      templateRow({ ntpl_id: "ntpl_middle0001", created_at: "2026-08-02T09:00:00.000Z" }),
    );
    const store = new PostgresTemplateStore(conn);
    expect((await store.listForTenant(TENANT_A)).map((t) => t.id)).toEqual([
      "ntpl_newer00001",
      "ntpl_middle0001",
      "ntpl_older00001",
    ]);
  });

  it("binds and clamps the limit, defaulting to 50", async () => {
    const { conn, captured, templates } = fakeTemplateDb();
    templates.push(templateRow());
    const store = new PostgresTemplateStore(conn);
    await store.listForTenant(TENANT_A);
    await store.listForTenant(TENANT_A, 5000);
    await store.listForTenant(TENANT_A, 0);
    await store.listForTenant(TENANT_A, 3.9);
    await store.listForTenant(TENANT_A, Number.NaN);
    expect(captured.filter((c) => isSelect(c)).map((s) => s.params[1])).toEqual([
      50, 200, 1, 3, 50,
    ]);
  });

  it("drops a row that fails the schema instead of failing the whole listing", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(
      templateRow({ ntpl_id: "ntpl_broken0001", channel: "sms" }),
      templateRow({ ntpl_id: "ntpl_intact0001" }),
    );
    const store = new PostgresTemplateStore(conn);
    const listed = await store.listForTenant(TENANT_A);
    expect(listed.map((t) => t.id)).toEqual(["ntpl_intact0001"]);
  });

  it("never lists another tenant's overrides", async () => {
    const { conn, templates } = fakeTemplateDb();
    templates.push(templateRow({ tenant_id: TENANT_B }));
    const store = new PostgresTemplateStore(conn);
    expect(await store.listForTenant(TENANT_A)).toEqual([]);
    expect(await store.listForTenant(TENANT_B)).toHaveLength(1);
  });
});

describe("template-store — row mapping", () => {
  it("maps a realistic row, Date and JSON-string columns included, to a valid record", () => {
    const record = templateFromRow(
      templateRow({
        ntpl_id: "ntpl_mapped0001",
        content: JSON.stringify(emailContent()),
        variables: JSON.stringify([
          { name: "invoiceNumber", type: "string", required: true, redactInLogs: false },
        ]),
        created_at: new Date("2026-08-01T09:00:00.000Z"),
        approved_at: new Date("2026-08-01T10:00:00.000Z"),
      }),
    );
    expect(() => NotificationTemplateSchema.parse(record)).not.toThrow();
    expect(record.id).toBe("ntpl_mapped0001");
    expect(record.content.channel).toBe("email");
    expect(record.variables[0]?.name).toBe("invoiceNumber");
    expect(record.createdAt).toBe("2026-08-01T09:00:00.000Z");
    expect(record.approvedAt).toBe("2026-08-01T10:00:00.000Z");
  });

  it("accepts an already-parsed JSONB object and a platform-wide null tenant", () => {
    const record = templateFromRow(templateRow({ tenant_id: null, variables: null }));
    expect(record.tenantId).toBeNull();
    expect(record.variables).toEqual([]);
    expect(record.content.channel).toBe("email");
    expect(record.deprecatedAt).toBeNull();
    expect(record.supersededByTemplateId).toBeNull();
  });

  it("returns null for a row the schema rejects rather than throwing", () => {
    expect(tryTemplateFromRow(templateRow({ version: "not-a-version" }))).toBeNull();
    expect(tryTemplateFromRow(templateRow({ approved_by: USER_A }))).toBeNull();
    expect(tryTemplateFromRow(templateRow())).not.toBeNull();
  });
});

describe("template-store — identifier + parameter discipline", () => {
  it("rejects a malicious or malformed schema identifier in the constructor", () => {
    const { conn, captured } = fakeTemplateDb();
    expect(() => new PostgresTemplateStore(conn, { schema: "Bad-Schema" })).toThrow(
      /invalid schema/,
    );
    expect(
      () => new PostgresTemplateStore(conn, { schema: "meta; DROP TABLE notification_templates" }),
    ).toThrow(/invalid schema/);
    expect(() => new PostgresTemplateStore(conn, { schema: "" })).toThrow(/invalid schema/);
    expect(captured).toHaveLength(0);
  });

  it("interpolates a valid custom schema as the only templated identifier", async () => {
    const { conn, captured } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn, { schema: "ops" });
    await store.find(TENANT_A, queryOf());
    await store.upsert(TENANT_A, templateOf());
    await store.listForTenant(TENANT_A);
    for (const c of captured.filter((s) => !s.sql.includes("set_config"))) {
      expect(c.sql).toContain("ops.notification_templates");
      expect(c.sql).not.toContain("meta.notification_templates");
    }
  });

  it("rejects a malformed tenant id before any SQL is issued", async () => {
    const { conn, captured } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    const evil = "robert'); DROP TABLE tenants;--";
    await expect(store.find(evil, queryOf())).rejects.toThrow(/invalid tenantId/);
    await expect(
      store.upsert(evil, templateOf({ tenantId: evil })),
    ).rejects.toThrow(/invalid tenantId/);
    await expect(store.listForTenant(evil)).rejects.toThrow(/invalid tenantId/);
    expect(captured).toHaveLength(0);
  });

  it("never embeds a tenant id, template id, locale, body or timestamp in any statement", async () => {
    const { conn, captured } = fakeTemplateDb();
    const store = new PostgresTemplateStore(conn);
    await store.find(TENANT_A, queryOf({ locale: "en-GB" }));
    await store.upsert(TENANT_A, templateOf());
    await store.listForTenant(TENANT_A);
    expect(captured.length).toBeGreaterThan(4);
    for (const c of captured) {
      expect(c.sql).not.toContain(TENANT_A);
      expect(c.sql).not.toContain(USER_A);
      expect(c.sql).not.toContain(USER_B);
      expect(c.sql).not.toContain(TEMPLATE_ID);
      expect(c.sql).not.toContain("ntpl_billing0001");
      expect(c.sql).not.toContain("en-GB");
      expect(c.sql).not.toContain("'email'");
      expect(c.sql).not.toContain(SUBJECT);
      expect(c.sql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  it("wraps every method in withTenantContext and binds the tenant as $1 besides", async () => {
    const { conn, captured, templates } = fakeTemplateDb();
    templates.push(templateRow());
    const store = new PostgresTemplateStore(conn);
    await store.find(TENANT_A, queryOf());
    await store.upsert(TENANT_A, templateOf({ id: "ntpl_billing0009" }));
    await store.listForTenant(TENANT_A);
    const setConfigs = captured.filter((c) => c.sql.includes("set_config"));
    expect(setConfigs).toHaveLength(3);
    for (const c of setConfigs) {
      expect(c.sql).toContain("app.current_tenant_id");
      expect(c.params).toEqual([TENANT_A]);
    }
    expect(captured.every((c) => c.inTx)).toBe(true);
    for (const c of captured) expect(c.params[0]).toBe(TENANT_A);
  });
});
