import { describe, expect, it } from "vitest";

import {
  assertTenantId,
  scopeFilter,
  SET_PLATFORM_AUDIT_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
} from "./tenant-context.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

describe("scopeFilter", () => {
  it("binds a tenant as an equality parameter", () => {
    expect(scopeFilter(TENANT_A)).toEqual({ sql: "tenant_id = $1", params: [TENANT_A] });
  });

  it("places its parameter where the caller asks", () => {
    expect(scopeFilter(TENANT_A, 3)).toEqual({ sql: "tenant_id = $3", params: [TENANT_A] });
  });

  it("asks for the platform scope as IS NULL and binds nothing", () => {
    // `tenant_id = NULL` is never true, so the platform scope cannot ride along as a parameter —
    // and `IS NOT DISTINCT FROM`, which could, is not an indexable operator.
    expect(scopeFilter(null)).toEqual({ sql: "tenant_id IS NULL", params: [] });
    expect(scopeFilter(null, 4)).toEqual({ sql: "tenant_id IS NULL", params: [] });
  });

  it("never uses IS NOT DISTINCT FROM, which would cost the index", () => {
    expect(scopeFilter(TENANT_A).sql).not.toContain("DISTINCT");
    expect(scopeFilter(null).sql).not.toContain("DISTINCT");
  });

  it("refuses a tenant id that could not be an identifier before interpolating anything", () => {
    expect(() => scopeFilter("'; DROP TABLE meta.forensic_chain_entries; --")).toThrow(/tenantId/);
  });
});

describe("the context statements", () => {
  it("are transaction-local, so no pooled connection carries an elevation out", () => {
    expect(SET_TENANT_CONTEXT_SQL).toContain(", true)");
    expect(SET_PLATFORM_AUDIT_WRITE_SQL).toContain(", true)");
  });

  it("keep the platform write grant separate from ADR-0313's read grant", () => {
    expect(SET_PLATFORM_AUDIT_WRITE_SQL).toContain("app.platform_audit_write");
    // A read grant that also authorised a write would let a reader of the trail forge the chain.
    expect(SET_PLATFORM_AUDIT_WRITE_SQL).not.toContain("'app.platform_audit'");
  });
});

describe("assertTenantId", () => {
  it("accepts a uuid and rejects anything that is not one shape", () => {
    expect(() => assertTenantId(TENANT_A)).not.toThrow();
    expect(() => assertTenantId("not a uuid")).toThrow(/tenantId/);
  });
});
