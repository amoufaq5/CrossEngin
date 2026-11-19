import type { TenantSchemaApplication } from "@crossengin/operate-runtime-pg";
import { describe, expect, it } from "vitest";

import { formatTenantSchemaRefusal } from "./tenant-schema-refusal-log.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";

const refused: TenantSchemaApplication = {
  tenantId: TENANT,
  schema: "t_3f2a1b4c",
  manifestHash: "b".repeat(64),
  applied: false,
  statements: [],
  changes: [
    { kind: "column_type_change", table: "widget", column: "sku", blocking: true, detail: "text -> integer", sql: null },
    { kind: "not_null_tightening", table: "widget", column: "old", blocking: false, detail: "kept", sql: null },
  ],
  uniqueIndexRefusals: [],
};

describe("formatTenantSchemaRefusal", () => {
  it("names the 503, and never the fallback, for a stranded tenant", () => {
    const line = formatTenantSchemaRefusal(refused, { kind: "stranded", schema: "t_3f2a1b4c" });
    expect(line).toContain("REFUSED");
    expect(line).toContain("503 tenant_schema_stranded");
    expect(line).toContain("t_3f2a1b4c");
    expect(line).not.toContain("JSONB fallback");
    expect(line).toContain("widget.sku: text -> integer");
    expect(line).not.toContain("widget.old");
  });

  it("names the fallback only when the tenant is served from it", () => {
    const line = formatTenantSchemaRefusal(refused, { kind: "fallback" });
    expect(line).toContain("serving from the JSONB fallback");
    expect(line).not.toContain("503");
  });

  it("names the last applied manifest a refused re-activation leaves in service", () => {
    const line = formatTenantSchemaRefusal(refused, {
      kind: "retained",
      retained: { manifestHash: "a".repeat(64), schema: "t_3f2a1b4c" },
    });
    expect(line).toContain(`still serving the last applied manifest ${"a".repeat(12)} from t_3f2a1b4c`);
    expect(line).not.toContain("JSONB fallback");
  });
});
