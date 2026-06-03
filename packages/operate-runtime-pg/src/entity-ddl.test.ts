import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { columnPlanForEntity } from "./column-plan.js";
import { emitEntityTableDdl } from "./entity-ddl.js";

const WIDGET: Entity = {
  name: "Widget",
  fields: [
    { name: "sku", type: { kind: "text" }, required: true },
    { name: "price", type: { kind: "decimal", precision: 12, scale: 2 } },
    { name: "ssn", type: { kind: "text" }, classification: "phi" },
    { name: "cost", type: { kind: "decimal", precision: 12, scale: 2 }, classification: "commercial_sensitive" },
  ],
};

describe("emitEntityTableDdl", () => {
  const sql = emitEntityTableDdl(columnPlanForEntity(WIDGET, { schema: "tenant_app" })).join("\n");

  it("creates the table idempotently with system + typed domain columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "tenant_app"."widget"');
    expect(sql).toContain('"tenant_id" UUID NOT NULL');
    expect(sql).toContain('"id" TEXT NOT NULL');
    expect(sql).toContain('"sku" TEXT NOT NULL');
    expect(sql).toContain('"price" NUMERIC(12, 2)');
    expect(sql).toContain('PRIMARY KEY ("tenant_id", "id")');
  });

  it("stores an encrypt-at-rest (phi) column as BYTEA, not its plaintext type", () => {
    expect(sql).toContain('"ssn" BYTEA');
    expect(sql).not.toContain('"ssn" TEXT');
  });

  it("enables RLS with an idempotent tenant-isolation policy", () => {
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain('DROP POLICY IF EXISTS "widget_tenant_isolation"');
    expect(sql).toContain("current_setting('app.current_tenant_id', true)::UUID");
  });

  it("creates a tenant index idempotently", () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_widget_tenant"');
  });

  it("writes classification comments (with encrypt=at_rest for phi)", () => {
    expect(sql).toContain(`COMMENT ON COLUMN "tenant_app"."widget"."ssn" IS 'crossengin.data_class=phi; crossengin.encrypt=at_rest'`);
    expect(sql).toContain(`COMMENT ON COLUMN "tenant_app"."widget"."cost" IS 'crossengin.data_class=commercial_sensitive'`);
  });

  it("does not comment unclassified columns", () => {
    expect(sql).not.toContain(`"sku" IS 'crossengin`);
  });
});
