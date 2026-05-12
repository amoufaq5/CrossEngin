import { describe, expect, it } from "vitest";
import { ManifestSchema } from "./types.js";

const validMeta = { name: "Test", slug: "test/example", version: "1.0.0" } as const;

describe("ManifestSchema — minimum manifest", () => {
  it("parses a manifest with only meta", () => {
    const m = { manifestVersion: "1.0" as const, meta: validMeta };
    expect(ManifestSchema.parse(m)).toEqual(m);
  });

  it("requires manifestVersion", () => {
    expect(() => ManifestSchema.parse({ meta: validMeta })).toThrow();
  });

  it("requires meta", () => {
    expect(() => ManifestSchema.parse({ manifestVersion: "1.0" })).toThrow();
  });

  it("rejects a future manifestVersion", () => {
    expect(() =>
      ManifestSchema.parse({ manifestVersion: "2.0", meta: validMeta }),
    ).toThrow();
  });
});

describe("ManifestSchema — meta", () => {
  it("accepts a simple slug", () => {
    expect(
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "simple", version: "1.0.0" },
      }).meta.slug,
    ).toBe("simple");
  });

  it("accepts a multi-segment slug", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: { name: "X", slug: "operate-pharma/community-pharmacy", version: "1.0.0" },
    };
    expect(ManifestSchema.parse(m).meta.slug).toBe("operate-pharma/community-pharmacy");
  });

  it("rejects slug with uppercase letters", () => {
    expect(() =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "Simple", version: "1.0.0" },
      }),
    ).toThrow();
  });

  it("rejects slug with leading slash", () => {
    expect(() =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "/leading", version: "1.0.0" },
      }),
    ).toThrow();
  });

  it("rejects slug with underscores", () => {
    expect(() =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "with_underscore", version: "1.0.0" },
      }),
    ).toThrow();
  });

  it("rejects non-semver version", () => {
    expect(() =>
      ManifestSchema.parse({
        manifestVersion: "1.0",
        meta: { name: "X", slug: "x", version: "1.0" },
      }),
    ).toThrow();
  });
});

describe("ManifestSchema — entities / traits / relations", () => {
  it("parses entities array", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: validMeta,
      entities: [
        { name: "Patient", fields: [{ name: "first_name", type: { kind: "text" as const } }] },
      ],
    };
    const parsed = ManifestSchema.parse(m);
    expect(parsed.entities).toHaveLength(1);
  });

  it("parses traits and relations alongside entities", () => {
    const m = {
      manifestVersion: "1.0" as const,
      meta: validMeta,
      entities: [
        { name: "Patient", fields: [{ name: "first_name", type: { kind: "text" as const } }] },
        { name: "Prescriber", fields: [{ name: "license", type: { kind: "text" as const } }] },
      ],
      traits: [
        {
          name: "geocoded",
          fields: [
            { name: "lat", type: { kind: "decimal" as const, precision: 10, scale: 6 } },
          ],
        },
      ],
      relations: [
        {
          kind: "many_to_one" as const,
          from: "Prescription",
          field: "patient",
          to: "Patient",
        },
      ],
    };
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });
});
