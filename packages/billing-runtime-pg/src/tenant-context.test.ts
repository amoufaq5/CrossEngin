import { describe, expect, it } from "vitest";

import { withTenantContext } from "./tenant-context.js";
import { fakePg } from "./test-fakes.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

describe("withTenantContext", () => {
  it("binds set_config for the tenant inside a transaction", async () => {
    const { conn, calls } = fakePg();
    const out = await withTenantContext(conn, TENANT, async () => "ok");
    expect(out).toBe("ok");
    expect(calls[0]?.sql).toContain("set_config('app.current_tenant_id', $1, true)");
    expect(calls[0]?.params[0]).toBe(TENANT);
  });

  it("rejects a malformed tenant id before any SQL", async () => {
    const { conn, calls } = fakePg();
    await expect(withTenantContext(conn, "nope; DROP", async () => "x")).rejects.toThrow(/invalid tenantId/);
    expect(calls).toHaveLength(0);
  });
});
