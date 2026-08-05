import { describe, expect, it } from "vitest";

import { PostgresInstallationStore } from "./installation-store.js";
import { FAKE_TENANT as TENANT, FAKE_USER as USER, fakeInstallation as installation, fakePg } from "./test-fakes.js";

const OTHER = "00000000-0000-4000-8000-000000000002";

describe("PostgresInstallationStore — round-trips", () => {
  it("upsert then get returns the record", async () => {
    const { conn } = fakePg();
    const store = new PostgresInstallationStore(conn);
    await store.upsert(installation());
    const got = await store.get(TENANT, "11111111-1111-4111-8111-111111111111");
    expect(got?.status).toBe("installing");
    expect(got?.packId).toBe("com.crossengin.example");
  });

  it("upsert on the same id updates the mutable status", async () => {
    const { conn } = fakePg();
    const store = new PostgresInstallationStore(conn);
    await store.upsert(installation());
    await store.upsert(installation({ status: "installed", installedVersion: "1.0.0", installedAt: "2026-05-16T12:01:00.000Z", installedBy: USER }));
    const got = await store.get(TENANT, "11111111-1111-4111-8111-111111111111");
    expect(got?.status).toBe("installed");
    expect(got?.installedVersion).toBe("1.0.0");
  });

  it("preserves config + permission_grants JSONB across a round-trip", async () => {
    const { conn } = fakePg();
    const store = new PostgresInstallationStore(conn);
    const grants = [
      { scope: "records:read", status: "granted", grantedAt: "2026-05-16T12:00:00.000Z", grantedBy: USER, deniedAt: null, revokedAt: null, revokedBy: null, optional: false },
    ];
    await store.upsert(installation({ config: { region: "us-east" }, permissionGrants: grants }));
    const got = await store.get(TENANT, "11111111-1111-4111-8111-111111111111");
    expect(got?.config).toEqual({ region: "us-east" });
    expect(got?.permissionGrants).toEqual(grants);
  });

  it("get returns null for a missing id", async () => {
    const { conn } = fakePg();
    const store = new PostgresInstallationStore(conn);
    expect(await store.get(TENANT, "nope")).toBeNull();
  });

  it("listForTenant returns all installs for the tenant", async () => {
    const { conn } = fakePg();
    const store = new PostgresInstallationStore(conn);
    await store.upsert(installation({ id: "11111111-1111-4111-8111-111111111111", packId: "com.crossengin.a" }));
    await store.upsert(installation({ id: "22222222-2222-4222-8222-222222222222", packId: "com.crossengin.b", requestedAt: "2026-05-16T12:05:00.000Z" }));
    const list = await store.listForTenant(TENANT);
    expect(list.map((i) => i.packId)).toEqual(["com.crossengin.a", "com.crossengin.b"]);
  });

  it("activeForPack excludes uninstalled/failed", async () => {
    const { conn } = fakePg();
    const store = new PostgresInstallationStore(conn);
    await store.upsert(installation({ id: "11111111-1111-4111-8111-111111111111", status: "installed", installedVersion: "1.0.0", installedAt: "2026-05-16T12:00:00.000Z", installedBy: USER }));
    await store.upsert(installation({ id: "22222222-2222-4222-8222-222222222222", status: "failed", failureReason: "boom" }));
    const active = await store.activeForPack(TENANT, "com.crossengin.example");
    expect(active).toHaveLength(1);
    expect(active[0]?.status).toBe("installed");
  });
});

describe("PostgresInstallationStore — tenant isolation + config", () => {
  it("a record for one tenant is invisible to another (RLS context)", async () => {
    const { conn } = fakePg();
    const store = new PostgresInstallationStore(conn);
    await store.upsert(installation());
    expect(await store.get(OTHER, "11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(await store.listForTenant(OTHER)).toEqual([]);
  });

  it("targets meta.pack_installations by default and honors a custom schema", async () => {
    const { conn } = fakePg();
    expect(() => new PostgresInstallationStore(conn, { schema: "app_x" })).not.toThrow();
    expect(() => new PostgresInstallationStore(conn, { schema: "meta; DROP" })).toThrow(/invalid schema/);
  });

  it("rejects a malformed tenant id (RLS guard)", async () => {
    const { conn } = fakePg();
    const store = new PostgresInstallationStore(conn);
    await expect(store.get("not-a-uuid!!", "x")).rejects.toThrow(/invalid tenantId/);
  });
});
