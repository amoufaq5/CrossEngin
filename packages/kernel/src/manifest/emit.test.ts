import { describe, expect, it } from "vitest";
import type { Entity } from "@crossengin/types/meta-schema";
import { applyManifest, emitManifestCreate, emitManifestDiff } from "./emit.js";
import { computeManifestDiff } from "./diff.js";
import type { Manifest } from "./types.js";

const meta = { name: "T", slug: "t", version: "1.0.0" } as const;
const schema = "t_acme";

function manifest(entities: Entity[]): Manifest {
  return { manifestVersion: "1.0", meta, entities };
}

describe("emitManifestCreate", () => {
  it("emits CREATE TABLE statements", () => {
    const m = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const statements = emitManifestCreate(m, { schema });
    expect(statements[0]).toContain(`CREATE TABLE "t_acme"."patient"`);
  });

  it("orders dependencies before dependents", () => {
    const m = manifest([
      {
        name: "Prescription",
        fields: [{ name: "patient", type: { kind: "reference", target: "Patient" } }],
      },
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const statements = emitManifestCreate(m, { schema });
    const createStatements = statements.filter((s) => s.startsWith("CREATE TABLE"));
    const patientIdx = createStatements.findIndex((s) => s.includes(`."patient" (`));
    const prescriptionIdx = createStatements.findIndex((s) =>
      s.includes(`."prescription" (`),
    );
    expect(patientIdx).toBeLessThan(prescriptionIdx);
  });

  it("handles an empty manifest", () => {
    const m: Manifest = { manifestVersion: "1.0", meta };
    expect(emitManifestCreate(m, { schema })).toEqual([]);
  });

  it("passes custom traits through to entity emission", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta,
      entities: [
        {
          name: "Address",
          fields: [{ name: "line1", type: { kind: "text" } }],
          traits: ["geocoded"],
        },
      ],
      traits: [
        {
          name: "geocoded",
          fields: [
            { name: "latitude", type: { kind: "decimal", precision: 10, scale: 6 } },
          ],
        },
      ],
    };
    const statements = emitManifestCreate(m, { schema });
    expect(statements[0]).toContain(`"latitude" NUMERIC(10, 6)`);
  });
});

describe("emitManifestDiff", () => {
  it("emits DROP TABLE CASCADE for removed entities", () => {
    const m1 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
      { name: "Old", fields: [{ name: "x", type: { kind: "text" } }] },
    ]);
    const m2 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const diff = computeManifestDiff(m1, m2);
    const statements = emitManifestDiff(m2, diff, { schema });
    expect(statements).toContain(`DROP TABLE "t_acme"."old" CASCADE;`);
  });

  it("emits CREATE TABLE for added entities", () => {
    const m1 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const m2 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
      { name: "Address", fields: [{ name: "line1", type: { kind: "text" } }] },
    ]);
    const diff = computeManifestDiff(m1, m2);
    const statements = emitManifestDiff(m2, diff, { schema });
    expect(statements.some((s) => s.startsWith(`CREATE TABLE "t_acme"."address"`))).toBe(true);
  });

  it("emits ALTER statements for modified entities", () => {
    const m1 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const m2 = manifest([
      {
        name: "Patient",
        fields: [
          { name: "name", type: { kind: "text" } },
          { name: "email", type: { kind: "email" } },
        ],
      },
    ]);
    const diff = computeManifestDiff(m1, m2);
    const statements = emitManifestDiff(m2, diff, { schema });
    expect(statements).toContain(
      `ALTER TABLE "t_acme"."patient" ADD COLUMN "email" VARCHAR(320);`,
    );
  });

  it("emits drops before modifies before adds", () => {
    const m1 = manifest([
      { name: "Old", fields: [{ name: "x", type: { kind: "text" } }] },
      { name: "Existing", fields: [{ name: "a", type: { kind: "text" } }] },
    ]);
    const m2 = manifest([
      {
        name: "Existing",
        fields: [
          { name: "a", type: { kind: "text" } },
          { name: "b", type: { kind: "integer" } },
        ],
      },
      { name: "Brand_New", fields: [{ name: "x", type: { kind: "text" } }] },
    ]);
    const diff = computeManifestDiff(m1, m2);
    const statements = emitManifestDiff(m2, diff, { schema });

    const dropIdx = statements.findIndex((s) => s.startsWith(`DROP TABLE`));
    const alterIdx = statements.findIndex((s) => s.startsWith(`ALTER TABLE`));
    const createIdx = statements.findIndex((s) => s.startsWith(`CREATE TABLE`));

    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(alterIdx).toBeGreaterThan(dropIdx);
    expect(createIdx).toBeGreaterThan(alterIdx);
  });
});

describe("applyManifest", () => {
  it("with null old, emits the full CREATE pipeline", () => {
    const m = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const statements = applyManifest(null, m, { schema });
    expect(statements[0]).toContain(`CREATE TABLE "t_acme"."patient"`);
  });

  it("with non-null old, emits diff-based pipeline", () => {
    const m1 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const m2 = manifest([
      {
        name: "Patient",
        fields: [
          { name: "name", type: { kind: "text" } },
          { name: "email", type: { kind: "email" } },
        ],
      },
    ]);
    const statements = applyManifest(m1, m2, { schema });
    expect(statements).toEqual([
      `ALTER TABLE "t_acme"."patient" ADD COLUMN "email" VARCHAR(320);`,
    ]);
  });
});
