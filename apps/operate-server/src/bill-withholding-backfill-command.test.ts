import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { CliUsageError, parseBillWithholdingBackfillArgs } from "./cli.js";
import { billWithholdingBackfillCommand } from "./bill-withholding-backfill-command.js";
import type { BillWithholdingBackfillReport } from "./bill-withholding-backfill.js";
import { loadBuiltinPack } from "./manifest-source.js";
import { backfillColumnStore, runBillWithholdingBackfill } from "./node.js";

const TENANT = "00000000-0000-4000-8000-00000000000a";

describe("parseBillWithholdingBackfillArgs", () => {
  it("parses the full flag set", () => {
    expect(
      parseBillWithholdingBackfillArgs([
        "--pack",
        "erp-core",
        "--store=pg-columns",
        "--schema",
        "erp",
        "--tenant",
        TENANT,
        "--plan",
        "--audit-chain-config",
        "chain.json",
        "--format",
        "json",
      ]),
    ).toEqual({
      pack: "erp-core",
      manifestPath: null,
      store: "pg-columns",
      schema: "erp",
      tenantId: TENANT,
      allTenants: false,
      plan: true,
      auditChainConfig: "chain.json",
      format: "json",
      help: false,
    });
  });

  it("accepts --all-tenants with a manifest file", () => {
    expect(
      parseBillWithholdingBackfillArgs(["--manifest", "m.json", "--store", "pg", "--all-tenants"]),
    ).toMatchObject({ manifestPath: "m.json", allTenants: true, tenantId: null, plan: false, format: "human" });
  });

  it("answers help without any required flag", () => {
    expect(parseBillWithholdingBackfillArgs(["-h"]).help).toBe(true);
  });

  const refused: readonly (readonly [string, readonly string[]])[] = [
    ["no pack or manifest", ["--store", "pg", "--all-tenants"]],
    ["both pack and manifest", ["--pack", "erp-core", "--manifest", "m.json", "--store", "pg", "--all-tenants"]],
    ["no store", ["--pack", "erp-core", "--all-tenants"]],
    ["the in-memory store", ["--pack", "erp-core", "--store", "memory", "--all-tenants"]],
    ["no scope", ["--pack", "erp-core", "--store", "pg"]],
    ["both scopes", ["--pack", "erp-core", "--store", "pg", "--tenant", TENANT, "--all-tenants"]],
    ["a malformed tenant", ["--pack", "erp-core", "--store", "pg", "--tenant", "x;drop"]],
    ["a bad format", ["--pack", "erp-core", "--store", "pg", "--all-tenants", "--format", "yaml"]],
    ["an unknown flag", ["--pack", "erp-core", "--store", "pg", "--all-tenants", "--confirm"]],
    ["a flag missing its value", ["--pack", "erp-core", "--store", "pg", "--all-tenants", "--schema"]],
  ];
  for (const [name, argv] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => parseBillWithholdingBackfillArgs(argv)).toThrow(CliUsageError);
    });
  }
});

function report(ok: boolean): BillWithholdingBackfillReport {
  return {
    runId: "run_test",
    plan: false,
    store: "pg",
    anchored: false,
    refusal: ok ? null : { reason: "not_stamped_here", detail: "x" },
    tenants: [],
    ok,
  };
}

async function exitOf(
  argv: readonly string[],
  ok = true,
): Promise<{ code: number; out: string; err: string; ran: boolean }> {
  let out = "";
  let err = "";
  let ran = false;
  const code = await billWithholdingBackfillCommand(argv, {
    run: async () => {
      ran = true;
      return report(ok);
    },
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  });
  return { code, out, err, ran };
}

describe("billWithholdingBackfillCommand exit codes", () => {
  const valid = ["--pack", "erp-core", "--store", "pg", "--all-tenants"];

  it("exits 0 on a clean pass and 1 when anything was refused", async () => {
    expect((await exitOf(valid, true)).code).toBe(0);
    const refused = await exitOf(valid, false);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("REFUSED not_stamped_here");
  });

  it("exits 2 on a usage error and runs nothing", async () => {
    const r = await exitOf(["--pack", "erp-core"]);
    expect(r.code).toBe(2);
    expect(r.ran).toBe(false);
    expect(r.err).toContain("error: backfill-bill-withholding requires --store");
    expect(r.err).toContain("Usage:");
  });

  it("exits 0 for help and runs nothing", async () => {
    const r = await exitOf(["--help"]);
    expect(r.code).toBe(0);
    expect(r.ran).toBe(false);
    expect(r.out).toContain("operate-server backfill-bill-withholding");
  });

  it("prints the report as JSON under --format json", async () => {
    const r = await exitOf([...valid, "--format", "json"]);
    expect(JSON.parse(r.out)).toMatchObject({ runId: "run_test", ok: true });
  });
});

/** A connection answering only the statements the run- and tenant-level refusals reach. */
function fakeConn(
  answer: (sql: string, params: readonly unknown[]) => PgQueryResult<Record<string, unknown>>,
): PgConnection & {
  closed: boolean;
} {
  const conn = {
    closed: false,
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult<T>> {
      return answer(sql, params) as unknown as PgQueryResult<T>;
    },
    async transaction<T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> {
      return fn(conn);
    },
    async withAdvisoryLock<T>(_key: bigint, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async close(): Promise<void> {
      conn.closed = true;
    },
  };
  return conn;
}

function rows(r: Record<string, unknown>[]): PgQueryResult<Record<string, unknown>> {
  return { rows: r, rowCount: r.length } as PgQueryResult<Record<string, unknown>>;
}

describe("runBillWithholdingBackfill refusals", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["AUDIT_CHAIN_SIGNING_KEY"];
    delete process.env["AUDIT_CHAIN_SIGNING_KEY"];
  });
  afterEach(() => {
    if (saved !== undefined) process.env["AUDIT_CHAIN_SIGNING_KEY"] = saved;
  });

  const base = {
    pack: "erp-core",
    manifestPath: null,
    store: "pg" as const,
    schema: null,
    tenantId: TENANT,
    allTenants: false,
    plan: true,
    auditChainConfig: null,
    format: "human" as const,
    help: false,
  };

  it("refuses not_stamped_here for a manifest whose Bill declares no withholding_total, before connecting", async () => {
    const core = buildErpCorePack();
    const stripped = {
      ...core,
      entities: (core.entities ?? []).map((e) =>
        e.name === "Bill" ? { ...e, fields: e.fields.filter((f) => f.name !== "withholding_total") } : e,
      ),
    };
    const dir = await mkdtemp(join(tmpdir(), "backfill-"));
    const path = join(dir, "manifest.json");
    await writeFile(path, JSON.stringify(stripped));
    let connected = false;
    const r = await runBillWithholdingBackfill({ ...base, pack: null, manifestPath: path }, () => {
      connected = true;
      return fakeConn(() => rows([]));
    });
    expect(r.refusal?.reason).toBe("not_stamped_here");
    expect(r.ok).toBe(false);
    expect(connected).toBe(false);
  });

  it("refuses schema_not_provisioned on pg-columns when the schema is absent, and closes the connection", async () => {
    const conn = fakeConn((sql) => (sql.includes("pg_namespace") ? rows([{ present: false }]) : rows([])));
    const r = await runBillWithholdingBackfill({ ...base, store: "pg-columns" }, () => conn);
    expect(r.refusal).toMatchObject({ reason: "schema_not_provisioned" });
    expect(r.refusal?.detail).toContain("schema_absent public");
    expect(r.tenants).toEqual([]);
    expect(conn.closed).toBe(true);
  });

  it("refuses a tenant serving its own activated manifest", async () => {
    const conn = fakeConn((sql) =>
      sql.includes("operate_tenant_manifests") ? rows([{ manifest: { meta: { slug: "own" } } }]) : rows([]),
    );
    const r = await runBillWithholdingBackfill(base, () => conn);
    expect(r.refusal).toBeNull();
    expect(r.tenants).toEqual([
      expect.objectContaining({ tenantId: TENANT, refusal: expect.objectContaining({ reason: "tenant_manifest_unsupported" }) }),
    ]);
    expect(r.ok).toBe(false);
  });

  it("refuses a tenant whose own-manifest read fails, naming no driver message", async () => {
    const conn = fakeConn((sql) => {
      if (sql.includes("operate_tenant_manifests")) throw new TypeError("value SECRET leaked");
      return rows([]);
    });
    const r = await runBillWithholdingBackfill(base, () => conn);
    expect(r.tenants[0]?.refusal).toEqual({ reason: "tenant_manifest_unreadable", detail: "TypeError" });
  });

  it("walks only tenants that can still pay a bill under --all-tenants, and reads each one's own manifest", async () => {
    const OTHER = "00000000-0000-4000-8000-00000000000b";
    const statusParams: unknown[] = [];
    const manifestReads: unknown[] = [];
    const conn = fakeConn((sql, params) => {
      if (/FROM \S+\.tenants WHERE status/.test(sql)) {
        statusParams.push(params[0]);
        return rows([{ id: TENANT }, { id: OTHER }]);
      }
      if (sql.includes("operate_tenant_manifests")) {
        manifestReads.push(...params);
        return rows([{ manifest: { meta: { slug: "own" } } }]);
      }
      return rows([]);
    });
    const r = await runBillWithholdingBackfill({ ...base, tenantId: null, allTenants: true }, () => conn);
    expect(statusParams).toEqual([["active", "suspended", "archived"]]);
    expect(manifestReads).toEqual(expect.arrayContaining([TENANT, OTHER]));
    expect(r.tenants.map((t) => t.tenantId)).toEqual([TENANT, OTHER]);
  });
});

describe("backfillColumnStore", () => {
  it("builds a store over an encrypting pack that asks no key and sets none for a Bill read", async () => {
    const manifest = await loadBuiltinPack("erp-healthcare");
    const statements: string[] = [];
    const conn = fakeConn((sql, params) => {
      statements.push(`${sql} ${JSON.stringify(params)}`);
      return rows([]);
    });
    const built = backfillColumnStore(conn, manifest, null);
    expect(built.kind).toBe("store");
    if (built.kind !== "store") return;
    await built.store.listPage(TENANT, "Bill", { sort: [], filters: [], limit: 10, cursor: null });
    expect(statements.some((s) => s.includes("set_config") && s.includes("column_encryption_key"))).toBe(false);
    expect(statements.some((s) => /FROM\s+"?public"?\."?bill"?/i.test(s))).toBe(true);
  });

  it("refuses a pack whose bills carry an at-rest-encrypted column, naming it", async () => {
    const core = await loadBuiltinPack("erp-core");
    const encrypting = {
      ...core,
      entities: (core.entities ?? []).map((e) =>
        e.name === "Bill"
          ? {
              ...e,
              fields: e.fields.map((f) => (f.name === "currency" ? { ...f, classification: "phi" as const } : f)),
            }
          : e,
      ),
    };
    const built = backfillColumnStore(fakeConn(() => rows([])), encrypting, null);
    expect(built).toMatchObject({ kind: "refused" });
    expect(built.kind === "refused" ? built.detail : "").toContain("Bill.currency");
  });
});
