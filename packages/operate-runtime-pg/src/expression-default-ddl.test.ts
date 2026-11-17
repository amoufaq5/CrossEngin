import type { PgConnection } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { UnadmittedDefaultError, columnPlanForEntity, columnPlansForManifest } from "./column-plan.js";
import { ColumnMappedEntityStore } from "./column-store.js";
import { emitManifestSchemaDdl } from "./entity-ddl.js";
import { applyTenantManifestSchema } from "./tenant-schema-apply.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

/** The audit's L31 payload: a text field whose expression default closes the DEFAULT clause. */
const L31 = "'a'); CREATE TABLE public.pwned(x int); --";

const PAYLOADS: readonly string[] = [
  L31,
  "'a'); CREATE TABLE public.pwned(x int); CREATE TEMP TABLE z (tenant_id uuid, id text, q text DEFAULT 'a'",
  "now(); DROP TABLE meta.tenants",
  "now() /* x */",
  "(now())",
  "$t$; DROP TABLE x; $t$",
  "pg_sleep(10)",
  "NOW()",
];

/**
 * Not a fake that answers: every method throws, so a refusal that is decided from the manifest
 * alone is proven to touch nothing, and one that reached the database would fail loudly here.
 */
const untouchable: PgConnection = {
  query: () => {
    throw new Error("the refusal must be decided before any statement");
  },
  transaction: () => {
    throw new Error("the refusal must be decided before any transaction");
  },
} as unknown as PgConnection;

/**
 * Built with a cast because the manifest is the *stored* shape the rule exists for: one written
 * before `validateManifest` refused it, which `ManifestSchema` itself still admits.
 */
function storedManifest(expression: string, kind: "text" | "datetime" = "text"): Manifest {
  return {
    manifestVersion: "1.0",
    meta: { name: "T", slug: "t", version: "1.0.0" },
    entities: [
      {
        name: "Note",
        fields: [{ name: "label", type: { kind }, default: { kind: "expression", expression } }],
      },
    ],
  } as unknown as Manifest;
}

describe("expression defaults reaching entity DDL", () => {
  it("renders an admitted default unchanged, so no existing table's DDL moves", () => {
    const entity: Entity = {
      name: "Note",
      traits: ["auditable"],
      fields: [{ name: "at", type: { kind: "datetime" }, default: { kind: "expression", expression: "now()" } }],
    };
    const plan = columnPlanForEntity(entity, { schema: "app" });
    const ddl = emitManifestSchemaDdl(new Map([["Note", plan]])).join("\n");
    expect(ddl).toContain('"at" TIMESTAMPTZ DEFAULT now()');
    expect(ddl).toContain('"created_at" TIMESTAMPTZ NOT NULL DEFAULT now()');
  });

  it.each(PAYLOADS)("refuses %j at the plan, so no DDL is ever emitted for it", (expression) => {
    expect(() => columnPlansForManifest(storedManifest(expression), { schema: "app" })).toThrow(
      UnadmittedDefaultError,
    );
  });

  it("names the entity and the field and never the payload", () => {
    let caught: unknown = null;
    try {
      columnPlansForManifest(storedManifest(L31), { schema: "app" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnadmittedDefaultError);
    const err = caught as UnadmittedDefaultError;
    expect(err.entity).toBe("Note");
    expect(err.field).toBe("label");
    expect(err.message).toContain("Note.label");
    expect(err.message).not.toContain("pwned");
    expect(err.message).not.toContain("CREATE TABLE");
  });

  it("refuses a payload a custom trait carries, which the plan resolves", () => {
    const entity: Entity = { name: "Note", traits: ["stamped"], fields: [{ name: "t", type: { kind: "text" } }] };
    const traits = [
      { name: "stamped", fields: [{ name: "label", type: { kind: "text" }, default: { kind: "expression", expression: L31 } }] },
    ];
    expect(() => columnPlanForEntity(entity, { schema: "app", traits: traits as never })).toThrow(
      /Note\.label/,
    );
  });

  it("refuses the boot store at construction, before any statement", () => {
    expect(() => new ColumnMappedEntityStore(untouchable, storedManifest(L31))).toThrow(
      UnadmittedDefaultError,
    );
  });

  it("refuses a tenant's stored manifest as a blocking change rather than an exception", async () => {
    // A tenant's manifest arrives through `TenantColumnStoreRegistry`, which degrades a refused
    // application to the JSONB store and cannot degrade a throw; that store never evaluates an
    // expression default, so the degradation carries nothing of the payload either.
    const application = await applyTenantManifestSchema(untouchable, TENANT, storedManifest(L31));
    expect(application.applied).toBe(false);
    expect(application.statements).toEqual([]);
    expect(application.changes).toHaveLength(1);
    const change = application.changes[0]!;
    expect(change).toMatchObject({
      kind: "unadmitted_expression_default",
      table: "Note",
      column: "label",
      blocking: true,
      sql: null,
    });
    expect(change.detail).not.toContain("pwned");
  });

  it("does not refuse the type mismatch here, which validation owns", () => {
    // `now()` on a text column is refused by `validateManifest`; the emitter's re-check is the
    // grammar alone, because a mismatched admitted constant injects nothing. Postgres does *not*
    // refuse this one (text takes an assignment cast from timestamptz), which is why validation
    // must — see `EXPRESSION_DEFAULTS`.
    expect(() =>
      columnPlansForManifest(storedManifest("now()", "text"), { schema: "app" }),
    ).not.toThrow();
  });
});
