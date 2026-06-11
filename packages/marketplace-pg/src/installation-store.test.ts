import type { PgConnection } from "@crossengin/kernel-pg";
import type { PackInstallation } from "@crossengin/marketplace";
import { describe, expect, it, vi } from "vitest";

import { PostgresPackInstallationStore, rowToInstallation } from "./installation-store.js";

interface Captured {
  conn: PgConnection;
  calls: { sql: string; params: readonly unknown[] }[];
  rows: Record<string, unknown>[];
}

/** A fake connection whose `transaction` runs the fn against a recording tx. */
function capture(): Captured {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const cap: Captured = { calls, rows: [], conn: undefined as unknown as PgConnection };
  const query = (async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    // the set_config call returns nothing; data queries return the staged rows
    return { rows: sql.includes("set_config") ? [] : cap.rows, rowCount: cap.rows.length };
  }) as PgConnection["query"];
  const tx: PgConnection = {
    query,
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  cap.conn = {
    query: vi.fn() as PgConnection["query"],
    transaction: (async (fn: (t: PgConnection) => Promise<unknown>) => fn(tx)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return cap;
}

const TENANT = "00000000-0000-4000-8000-000000000001";

const INSTALL: PackInstallation = {
  id: "inst-1",
  tenantId: TENANT,
  packId: "acme.crm.sales",
  installedVersion: "1.2.0",
  pinnedVersion: null,
  status: "installed",
  updatePolicy: "manual",
  config: { region: "us" },
  permissionGrants: [],
  requestedAt: "2026-06-11T00:00:00.000Z",
  requestedBy: "00000000-0000-4000-8000-0000000000aa",
  installedAt: "2026-06-11T00:05:00.000Z",
  installedBy: "00000000-0000-4000-8000-0000000000bb",
  lastUpdatedAt: "2026-06-11T00:05:00.000Z",
  uninstalledAt: null,
  uninstalledBy: null,
} as unknown as PackInstallation;

function row(): Record<string, unknown> {
  return {
    id: "inst-1",
    tenant_id: TENANT,
    pack_id: "acme.crm.sales",
    installed_version: "1.2.0",
    pinned_version: null,
    status: "installed",
    update_policy: "manual",
    config: { region: "us" },
    permission_grants: [],
    requested_at: "2026-06-11T00:00:00.000Z",
    requested_by: "00000000-0000-4000-8000-0000000000aa",
    installed_at: new Date("2026-06-11T00:05:00.000Z"),
    installed_by: "00000000-0000-4000-8000-0000000000bb",
    last_updated_at: new Date("2026-06-11T00:05:00.000Z"),
    uninstalled_at: null,
    uninstalled_by: null,
    failure_reason: null,
    isolation_sandbox: null,
  };
}

describe("PostgresPackInstallationStore.record", () => {
  it("upserts inside a tenant-context transaction (set_config first)", async () => {
    const cap = capture();
    await new PostgresPackInstallationStore(cap.conn).record(INSTALL);
    expect(cap.calls[0]!.sql).toContain("set_config('app.current_tenant_id'");
    expect(cap.calls[0]!.params[0]).toBe(TENANT);
    const insert = cap.calls[1]!;
    expect(insert.sql).toContain("INSERT INTO meta.pack_installations");
    expect(insert.sql).toContain("ON CONFLICT (id) DO UPDATE SET");
    expect(insert.sql).toContain("$8::jsonb"); // config
    expect(insert.params.slice(0, 3)).toEqual(["inst-1", TENANT, "acme.crm.sales"]);
    expect(JSON.parse(insert.params[7] as string)).toEqual({ region: "us" }); // config
  });

  it("rejects an invalid schema name + a malformed tenant id", () => {
    const cap = capture();
    expect(() => new PostgresPackInstallationStore(cap.conn, { schema: "bad; DROP" })).toThrow(/invalid schema/);
    return expect(new PostgresPackInstallationStore(cap.conn).get("not-a-uuid", "x")).rejects.toThrow(/invalid tenant id/);
  });
});

describe("PostgresPackInstallationStore reads", () => {
  it("get returns null when absent, a parsed installation when present", async () => {
    const cap = capture();
    const store = new PostgresPackInstallationStore(cap.conn);
    expect(await store.get(TENANT, "missing")).toBeNull();
    cap.rows = [row()];
    const inst = await store.get(TENANT, "inst-1");
    expect(inst?.id).toBe("inst-1");
    expect(inst?.installedVersion).toBe("1.2.0");
    expect(inst?.installedAt).toBe("2026-06-11T00:05:00.000Z"); // Date → ISO
  });

  it("listForTenant filters by status + clamps the limit", async () => {
    const cap = capture();
    cap.rows = [row()];
    await new PostgresPackInstallationStore(cap.conn).listForTenant(TENANT, { status: "installed", limit: 99999 });
    const select = cap.calls[1]!;
    expect(select.sql).toContain("WHERE status = $1");
    expect(select.sql).toContain("ORDER BY requested_at DESC");
    expect(select.params).toEqual(["installed", 1000]); // clamped
  });

  it("activeForPack queries the non-terminal status set", async () => {
    const cap = capture();
    cap.rows = [row()];
    const inst = await new PostgresPackInstallationStore(cap.conn).activeForPack(TENANT, "acme.crm.sales");
    const select = cap.calls[1]!;
    expect(select.sql).toContain("status = ANY($2::text[])");
    expect((select.params[1] as string[])).toContain("installed");
    expect((select.params[1] as string[])).not.toContain("uninstalled");
    expect(inst?.packId).toBe("acme.crm.sales");
  });
});

describe("rowToInstallation", () => {
  it("coerces Date timestamps + JSONB and omits absent optionals", () => {
    const inst = rowToInstallation({ ...row(), failure_reason: null, isolation_sandbox: null });
    expect("failureReason" in inst).toBe(false);
    expect("isolationSandbox" in inst).toBe(false);
    expect(inst.config).toEqual({ region: "us" });
  });
});
