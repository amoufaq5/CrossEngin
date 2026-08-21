import { randomUUID } from "node:crypto";

import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  CreateManifestProposalInputSchema,
  MANIFEST_PROPOSAL_STATUSES,
  PostgresTenantManifestStore,
  TenantManifestRecordSchema,
  canTransitionManifest,
  manifestSummary,
  type CreateManifestProposalInput,
} from "./tenant-manifests.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly inTx: boolean;
}

/**
 * A scripted fake PgConnection modelling `meta.operate_tenant_manifests` under
 * RLS: rows are only visible after the transaction's `set_config` call has
 * established `app.current_tenant_id`, mirroring the real policy.
 */
function fakeManifestDb(): { conn: PgConnection; captured: Captured[] } {
  const captured: Captured[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  let currentTenant: string | null = null;

  const visible = (): Record<string, unknown>[] =>
    [...rows.values()].filter((r) => r["tenant_id"] === currentTenant);

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
    inTx: boolean,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p, inTx });
    if (sql.includes("set_config")) {
      currentTenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO")) {
      seq += 1;
      const at = new Date(Date.UTC(2026, 5, 1) + seq * 1000);
      const row: Record<string, unknown> = {
        id: randomUUID(),
        tenant_id: p[0],
        name: p[1],
        description: p[2],
        manifest: JSON.parse(String(p[3])) as Record<string, unknown>,
        manifest_hash: p[4],
        status: "draft",
        source: p[5],
        provider_label: p[6] ?? null,
        created_at: at,
        updated_at: at,
        activated_at: null,
      };
      rows.set(String(row["id"]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE") && sql.includes("SET status = 'archived'")) {
      let n = 0;
      for (const r of visible()) {
        if (r["tenant_id"] === p[0] && r["status"] === "active" && r["id"] !== p[1]) {
          r["status"] = "archived";
          r["updated_at"] = new Date();
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }
    if (sql.startsWith("UPDATE") && sql.includes("SET status = 'active'")) {
      const row = visible().find((r) => r["tenant_id"] === p[0] && r["id"] === p[1]);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row["status"] = "active";
      row["updated_at"] = new Date();
      row["activated_at"] = new Date();
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE") && sql.includes("SET status = $3")) {
      const row = visible().find((r) => r["tenant_id"] === p[0] && r["id"] === p[1]);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row["status"] = p[2];
      row["updated_at"] = new Date();
      if (sql.includes("activated_at = now()")) row["activated_at"] = new Date();
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT manifest FROM")) {
      const actives = visible()
        .filter((r) => r["tenant_id"] === p[0] && r["status"] === "active")
        .sort((a, b) => {
          const av = a["activated_at"] instanceof Date ? a["activated_at"].getTime() : 0;
          const bv = b["activated_at"] instanceof Date ? b["activated_at"].getTime() : 0;
          return bv - av;
        });
      const row = actives[0];
      return {
        rows: row === undefined ? [] : [{ manifest: row["manifest"] }],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    if (sql.includes("WHERE tenant_id = $1 AND id = $2")) {
      const row = visible().find((r) => r["tenant_id"] === p[0] && r["id"] === p[1]);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.includes("ORDER BY created_at DESC")) {
      let list = visible().filter((r) => r["tenant_id"] === p[0]);
      let idx = 1;
      if (sql.includes("AND status = $2")) {
        list = list.filter((r) => r["status"] === p[1]);
        idx = 2;
      }
      list.sort((a, b) => {
        const av = (a["created_at"] as Date).getTime();
        const bv = (b["created_at"] as Date).getTime();
        return av !== bv ? bv - av : String(a["id"]).localeCompare(String(b["id"]));
      });
      const limit = Number(p[idx]);
      const offset = Number(p[idx + 1]);
      const page = list.slice(offset, offset + limit);
      return { rows: page, rowCount: page.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const tx: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params, true)) as PgConnection["query"],
    transaction: (async () => {
      throw new Error("nested transaction not supported by fake");
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  const conn: PgConnection = {
    query: ((sql: string, params?: readonly unknown[]) => run(sql, params, false)) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => {
      try {
        return await fn(tx);
      } finally {
        currentTenant = null;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, captured };
}

/** A one-shot conn whose only data row carries `manifest` exactly as given (string or object). */
function scriptedManifestConn(manifestValue: unknown): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string) => {
      if (sql.includes("set_config")) return { rows: [], rowCount: 0 };
      return { rows: [{ manifest: manifestValue }], rowCount: 1 };
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (t: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

function proposalInput(overrides: Record<string, unknown> = {}): CreateManifestProposalInput {
  return CreateManifestProposalInputSchema.parse({
    name: "Retail v1",
    description: "First cut",
    manifest: { entities: { Product: { label: "Product", fields: { sku: {}, price: {} } } } },
    manifestHash: "a".repeat(16),
    source: "ai",
    providerLabel: "anthropic/claude-sonnet-4-6",
    ...overrides,
  });
}

function validRecord(): Record<string, unknown> {
  return {
    id: randomUUID(),
    tenantId: TENANT_A,
    name: "Retail v1",
    description: "",
    manifest: { entities: {} },
    manifestHash: "a".repeat(16),
    status: "draft",
    source: "manual",
    providerLabel: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    activatedAt: null,
  };
}

describe("tenant-manifests — schemas", () => {
  it("accepts a full valid record", () => {
    const parsed = TenantManifestRecordSchema.parse(validRecord());
    expect(parsed.status).toBe("draft");
    expect(parsed.activatedAt).toBeNull();
  });

  it("rejects an unknown status", () => {
    expect(TenantManifestRecordSchema.safeParse({ ...validRecord(), status: "pending" }).success).toBe(false);
  });

  it("rejects a non-uuid tenantId", () => {
    expect(TenantManifestRecordSchema.safeParse({ ...validRecord(), tenantId: "not-a-uuid" }).success).toBe(false);
  });

  it("defaults description to empty and accepts omitted providerLabel", () => {
    const parsed = CreateManifestProposalInputSchema.parse({
      name: "n",
      manifest: {},
      manifestHash: "h",
      source: "manual",
    });
    expect(parsed.description).toBe("");
    expect(parsed.providerLabel).toBeUndefined();
  });

  it("rejects empty name, oversize name, oversize description, and unknown source", () => {
    expect(CreateManifestProposalInputSchema.safeParse({ name: "", manifest: {}, manifestHash: "h", source: "ai" }).success).toBe(false);
    expect(
      CreateManifestProposalInputSchema.safeParse({ name: "x".repeat(201), manifest: {}, manifestHash: "h", source: "ai" }).success,
    ).toBe(false);
    expect(
      CreateManifestProposalInputSchema.safeParse({
        name: "n",
        description: "d".repeat(8001),
        manifest: {},
        manifestHash: "h",
        source: "ai",
      }).success,
    ).toBe(false);
    expect(
      CreateManifestProposalInputSchema.safeParse({ name: "n", manifest: {}, manifestHash: "h", source: "robot" }).success,
    ).toBe(false);
  });
});

describe("tenant-manifests — canTransitionManifest", () => {
  it("allows exactly draft→active, draft→archived, active→archived, archived→active", () => {
    const legal = new Set(["draft>active", "draft>archived", "active>archived", "archived>active"]);
    for (const from of MANIFEST_PROPOSAL_STATUSES) {
      for (const to of MANIFEST_PROPOSAL_STATUSES) {
        expect(canTransitionManifest(from, to)).toBe(legal.has(`${from}>${to}`));
      }
    }
  });
});

describe("tenant-manifests — manifestSummary", () => {
  it("summarizes a realistic manifest with label fallback", () => {
    const summary = manifestSummary({
      entities: {
        Product: { label: "Product", fields: { sku: {}, price: {}, unit_cost: {} } },
        Store: { fields: { city: {} } },
      },
      roles: { admin: {}, cashier: {} },
      relations: { r1: {}, r2: {}, r3: {} },
      workflows: { order: {} },
    });
    expect(summary.entityCount).toBe(2);
    expect(summary.roleCount).toBe(2);
    expect(summary.relationCount).toBe(3);
    expect(summary.workflowCount).toBe(1);
    expect(summary.entities).toEqual([
      { name: "Product", label: "Product", fieldCount: 3 },
      { name: "Store", label: "Store", fieldCount: 1 },
    ]);
  });

  it("summarizes a kernel-shaped manifest (array entities, array fields, i18n labels)", () => {
    const summary = manifestSummary({
      entities: [
        { name: "Customer", label: { en: "Customers" }, fields: [{ name: "email" }, { name: "phone" }], traits: ["auditable"] },
        { name: "WorkOrder", fields: [{ name: "status" }] },
      ],
      roles: { app_admin: {}, app_user: {} },
      relations: [{ name: "customer_orders" }],
      workflows: [{ name: "order_lifecycle" }],
    });
    expect(summary.entityCount).toBe(2);
    expect(summary.roleCount).toBe(2);
    expect(summary.relationCount).toBe(1);
    expect(summary.workflowCount).toBe(1);
    expect(summary.entities).toEqual([
      { name: "Customer", label: "Customers", fieldCount: 2 },
      { name: "WorkOrder", label: "WorkOrder", fieldCount: 1 },
    ]);
  });

  it("names an array entity without a name defensively", () => {
    const summary = manifestSummary({ entities: [{ fields: [] }, 42] });
    expect(summary.entities).toEqual([
      { name: "entity_0", label: "entity_0", fieldCount: 0 },
      { name: "entity_1", label: "entity_1", fieldCount: 0 },
    ]);
  });

  it("returns zeros for an empty manifest", () => {
    expect(manifestSummary({})).toEqual({
      entityCount: 0,
      roleCount: 0,
      relationCount: 0,
      workflowCount: 0,
      entities: [],
    });
  });

  it("is defensive over malformed shapes", () => {
    const summary = manifestSummary({
      entities: { Broken: 42, NoFields: { label: "" }, BadFields: { fields: "nope" } },
      roles: ["admin", "cashier"],
      relations: null,
      workflows: "many",
    });
    expect(summary.entityCount).toBe(3);
    expect(summary.entities).toEqual([
      { name: "Broken", label: "Broken", fieldCount: 0 },
      { name: "NoFields", label: "NoFields", fieldCount: 0 },
      { name: "BadFields", label: "BadFields", fieldCount: 0 },
    ]);
    expect(summary.roleCount).toBe(2);
    expect(summary.relationCount).toBe(0);
    expect(summary.workflowCount).toBe(0);
  });
});

describe("tenant-manifests — store create", () => {
  it("creates a draft record with the manifest round-tripped", async () => {
    const { conn } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    const record = await store.create(TENANT_A, proposalInput());
    expect(record.status).toBe("draft");
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.source).toBe("ai");
    expect(record.providerLabel).toBe("anthropic/claude-sonnet-4-6");
    expect(record.activatedAt).toBeNull();
    expect(manifestSummary(record.manifest).entityCount).toBe(1);
  });

  it("runs inside withTenantContext with tenant_id bound in both set_config and the INSERT", async () => {
    const { conn, captured } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    await store.create(TENANT_A, proposalInput());
    const setConfig = captured.find((c) => c.sql.includes("set_config"));
    expect(setConfig?.params).toEqual([TENANT_A]);
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.inTx).toBe(true);
    expect(insert?.sql).toContain("INSERT INTO meta.operate_tenant_manifests");
    expect(insert?.sql).toContain("'draft'");
    expect(insert?.sql).toContain("$4::jsonb");
    expect(insert?.params[0]).toBe(TENANT_A);
    expect(typeof insert?.params[3]).toBe("string");
  });

  it("binds provider_label as null when omitted", async () => {
    const { conn, captured } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    const record = await store.create(TENANT_A, proposalInput({ providerLabel: undefined }));
    expect(record.providerLabel).toBeNull();
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.params[6]).toBeNull();
  });
});

describe("tenant-manifests — store getById", () => {
  it("returns an existing record and null for a missing id", async () => {
    const { conn, captured } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    const created = await store.create(TENANT_A, proposalInput());
    const found = await store.getById(TENANT_A, created.id);
    expect(found?.id).toBe(created.id);
    expect(await store.getById(TENANT_A, randomUUID())).toBeNull();
    const select = captured.find((c) => c.sql.startsWith("SELECT") && c.sql.includes("AND id = $2"));
    expect(select?.sql).toContain("WHERE tenant_id = $1 AND id = $2");
    expect(select?.inTx).toBe(true);
  });

  it("does not leak a record across tenants", async () => {
    const { conn } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    const created = await store.create(TENANT_A, proposalInput());
    expect(await store.getById(TENANT_B, created.id)).toBeNull();
  });
});

describe("tenant-manifests — store list", () => {
  it("lists newest-first with the default limit bound as limit+1", async () => {
    const { conn, captured } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    await store.create(TENANT_A, proposalInput({ name: "one" }));
    await store.create(TENANT_A, proposalInput({ name: "two" }));
    const page = await store.list(TENANT_A);
    expect(page.data.map((r) => r.name)).toEqual(["two", "one"]);
    expect(page.nextCursor).toBeNull();
    const select = captured.find((c) => c.sql.includes("ORDER BY created_at DESC"));
    expect(select?.params).toEqual([TENANT_A, 51, 0]);
    expect(select?.inTx).toBe(true);
  });

  it("clamps limits to [1, 200]", async () => {
    const { conn, captured } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    await store.list(TENANT_A, { limit: 999 });
    await store.list(TENANT_A, { limit: 0 });
    const lists = captured.filter((c) => c.sql.includes("ORDER BY created_at DESC"));
    expect(lists[0]?.params).toEqual([TENANT_A, 201, 0]);
    expect(lists[1]?.params).toEqual([TENANT_A, 2, 0]);
  });

  it("paginates with an opaque cursor and treats garbage cursors as offset 0", async () => {
    const { conn } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    for (const name of ["aa", "bb", "cc"]) await store.create(TENANT_A, proposalInput({ name }));
    const first = await store.list(TENANT_A, { limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.list(TENANT_A, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const garbage = await store.list(TENANT_A, { limit: 2, cursor: "!!not-a-cursor!!" });
    expect(garbage.data).toHaveLength(2);
  });

  it("filters by status", async () => {
    const { conn } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    const a = await store.create(TENANT_A, proposalInput({ name: "keep-draft" }));
    const b = await store.create(TENANT_A, proposalInput({ name: "goes-active" }));
    await store.activate(TENANT_A, b.id);
    const drafts = await store.list(TENANT_A, { status: "draft" });
    expect(drafts.data.map((r) => r.id)).toEqual([a.id]);
    const actives = await store.list(TENANT_A, { status: "active" });
    expect(actives.data.map((r) => r.id)).toEqual([b.id]);
  });
});

describe("tenant-manifests — store setStatus", () => {
  it("archives without touching activated_at", async () => {
    const { conn, captured } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    const created = await store.create(TENANT_A, proposalInput());
    const archived = await store.setStatus(TENANT_A, created.id, "archived");
    expect(archived?.status).toBe("archived");
    expect(archived?.activatedAt).toBeNull();
    const update = captured.find((c) => c.sql.includes("SET status = $3"));
    expect(update?.sql).toContain("updated_at = now()");
    expect(update?.sql).not.toContain("activated_at = now()");
    expect(update?.sql).toContain("WHERE tenant_id = $1 AND id = $2");
    expect(update?.inTx).toBe(true);
  });

  it("stamps activated_at when the target status is active", async () => {
    const { conn, captured } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    const created = await store.create(TENANT_A, proposalInput());
    const activated = await store.setStatus(TENANT_A, created.id, "active");
    expect(activated?.status).toBe("active");
    expect(activated?.activatedAt).not.toBeNull();
    const update = captured.find((c) => c.sql.includes("SET status = $3"));
    expect(update?.sql).toContain("activated_at = now()");
  });

  it("returns null for a missing id", async () => {
    const { conn } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    expect(await store.setStatus(TENANT_A, randomUUID(), "archived")).toBeNull();
  });
});

describe("tenant-manifests — store activate", () => {
  it("demotes the prior active row and promotes the target in one transaction", async () => {
    const { conn, captured } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    const first = await store.create(TENANT_A, proposalInput({ name: "first" }));
    const second = await store.create(TENANT_A, proposalInput({ name: "second" }));
    await store.activate(TENANT_A, first.id);
    captured.length = 0;
    const promoted = await store.activate(TENANT_A, second.id);
    const activateCalls = captured.slice();
    expect(promoted?.status).toBe("active");
    expect(promoted?.activatedAt).not.toBeNull();
    expect(activateCalls).toHaveLength(4);
    expect(activateCalls.map((c) => c.inTx)).toEqual([true, true, true, true]);
    expect(activateCalls.filter((c) => c.sql.includes("set_config"))).toHaveLength(1);
    expect(activateCalls[0]?.sql).toContain("set_config");
    expect(activateCalls[0]?.params).toEqual([TENANT_A]);
    expect(activateCalls[1]?.sql).toContain("pg_advisory_xact_lock");
    expect(activateCalls[1]?.params).toEqual([TENANT_A]);
    expect(activateCalls[2]?.sql).toContain("SET status = 'archived'");
    expect(activateCalls[2]?.sql).toContain("AND id <> $2");
    expect(activateCalls[3]?.sql).toContain("SET status = 'active'");
    expect(activateCalls[3]?.sql).toContain("activated_at = now()");
    expect((await store.getById(TENANT_A, first.id))?.status).toBe("archived");
  });

  it("returns null for a missing target", async () => {
    const { conn } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    expect(await store.activate(TENANT_A, randomUUID())).toBeNull();
  });

  it("keeps the target active when re-activated (demote skips the target itself)", async () => {
    const { conn } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    const only = await store.create(TENANT_A, proposalInput());
    await store.activate(TENANT_A, only.id);
    const again = await store.activate(TENANT_A, only.id);
    expect(again?.status).toBe("active");
  });
});

describe("tenant-manifests — activeManifestFor", () => {
  it("returns the newest active manifest and null when none is active", async () => {
    const { conn } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    expect(await store.activeManifestFor(TENANT_A)).toBeNull();
    const first = await store.create(TENANT_A, proposalInput({ manifest: { entities: { A: {} } } }));
    const second = await store.create(TENANT_A, proposalInput({ manifest: { entities: { B: {} } } }));
    await store.activate(TENANT_A, first.id);
    await store.activate(TENANT_A, second.id);
    const active = await store.activeManifestFor(TENANT_A);
    expect(Object.keys((active?.["entities"] as Record<string, unknown>) ?? {})).toEqual(["B"]);
  });

  it("parses a JSONB payload arriving as a string", async () => {
    const store = new PostgresTenantManifestStore(scriptedManifestConn('{"entities":{"Product":{}}}'));
    const active = await store.activeManifestFor(TENANT_A);
    expect(active).toEqual({ entities: { Product: {} } });
  });

  it("degrades an unparseable JSONB string to an empty manifest", async () => {
    const store = new PostgresTenantManifestStore(scriptedManifestConn("{not json"));
    expect(await store.activeManifestFor(TENANT_A)).toEqual({});
  });
});

describe("tenant-manifests — store construction", () => {
  it("rejects an invalid schema identifier and interpolates a valid custom one", async () => {
    const { conn, captured } = fakeManifestDb();
    expect(() => new PostgresTenantManifestStore(conn, { schema: "Bad-Schema" })).toThrow(/invalid schema/);
    const store = new PostgresTenantManifestStore(conn, { schema: "ops" });
    await store.create(TENANT_A, proposalInput());
    const insert = captured.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert?.sql).toContain("INSERT INTO ops.operate_tenant_manifests");
  });

  it("rejects a malformed tenant id before any SQL is issued", async () => {
    const { conn, captured } = fakeManifestDb();
    const store = new PostgresTenantManifestStore(conn);
    await expect(store.list("robert'); DROP TABLE tenants;--")).rejects.toThrow(/invalid tenantId/);
    expect(captured).toHaveLength(0);
  });
});
