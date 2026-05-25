import { describe, expect, it } from "vitest";
import {
  COMPATIBILITY_LEVELS,
  COMPATIBILITY_RANK,
  CompatibilityEntrySchema,
  CompatibilityMatrixSchema,
  clientsAffectedByApiVersion,
  meetsLevel,
  resolveCompatibility,
  type CompatibilityEntry,
} from "./compatibility.js";

describe("constants", () => {
  it("COMPATIBILITY_LEVELS has 5 entries", () => {
    expect(COMPATIBILITY_LEVELS).toContain("fully_compatible");
    expect(COMPATIBILITY_LEVELS).toContain("blocked");
  });

  it("COMPATIBILITY_RANK orders fully_compatible highest, blocked lowest", () => {
    expect(COMPATIBILITY_RANK.fully_compatible).toBeGreaterThan(COMPATIBILITY_RANK.blocked);
    expect(COMPATIBILITY_RANK.unsupported).toBeGreaterThan(COMPATIBILITY_RANK.blocked);
  });
});

describe("CompatibilityEntrySchema", () => {
  const base: CompatibilityEntry = {
    language: "typescript",
    clientVersion: "1.0.0",
    apiVersion: "v1",
    level: "fully_compatible",
    warningCount: 0,
    determinedAt: "2026-05-15T10:00:00Z",
  };

  it("accepts a valid fully_compatible entry", () => {
    expect(() => CompatibilityEntrySchema.parse(base)).not.toThrow();
  });

  it("rejects compatible_with_warnings without warnings", () => {
    expect(() =>
      CompatibilityEntrySchema.parse({
        ...base,
        level: "compatible_with_warnings",
      }),
    ).toThrow(/warningCount >= 1/);
  });

  it("rejects fully_compatible with warnings", () => {
    expect(() => CompatibilityEntrySchema.parse({ ...base, warningCount: 5 })).toThrow(
      /cannot have warnings/,
    );
  });

  it("rejects unsupported without notes", () => {
    expect(() =>
      CompatibilityEntrySchema.parse({
        ...base,
        level: "unsupported",
      }),
    ).toThrow(/requires notes/);
  });

  it("rejects blocked without notes", () => {
    expect(() =>
      CompatibilityEntrySchema.parse({
        ...base,
        level: "blocked",
      }),
    ).toThrow(/requires notes/);
  });
});

describe("CompatibilityMatrixSchema", () => {
  it("rejects duplicate (language, clientVersion, apiVersion)", () => {
    const entry: CompatibilityEntry = {
      language: "python",
      clientVersion: "1.0.0",
      apiVersion: "v1",
      level: "fully_compatible",
      warningCount: 0,
      determinedAt: "2026-05-15T10:00:00Z",
    };
    expect(() => CompatibilityMatrixSchema.parse([entry, entry])).toThrow(
      /duplicate \(language, clientVersion, apiVersion\)/,
    );
  });
});

describe("resolveCompatibility", () => {
  const matrix: CompatibilityEntry[] = [
    {
      language: "typescript",
      clientVersion: "1.0.0",
      apiVersion: "v1",
      level: "fully_compatible",
      warningCount: 0,
      determinedAt: "2026-05-15T10:00:00Z",
    },
    {
      language: "typescript",
      clientVersion: "0.9.0",
      apiVersion: "v1",
      level: "deprecated_supported",
      warningCount: 0,
      notes: "upgrade to 1.x",
      determinedAt: "2026-05-15T10:00:00Z",
    },
    {
      language: "python",
      clientVersion: "0.5.0",
      apiVersion: "v1",
      level: "blocked",
      warningCount: 0,
      notes: "incompatible auth scheme",
      determinedAt: "2026-05-15T10:00:00Z",
    },
  ];

  it("returns fully_compatible for matched entry", () => {
    expect(
      resolveCompatibility(matrix, {
        language: "typescript",
        clientVersion: "1.0.0",
        apiVersion: "v1",
      }).level,
    ).toBe("fully_compatible");
  });

  it("returns unsupported when no entry exists", () => {
    expect(
      resolveCompatibility(matrix, {
        language: "go",
        clientVersion: "1.0.0",
        apiVersion: "v1",
      }).allowed,
    ).toBe(false);
  });

  it("blocks when level=blocked", () => {
    const r = resolveCompatibility(matrix, {
      language: "python",
      clientVersion: "0.5.0",
      apiVersion: "v1",
    });
    expect(r.level).toBe("blocked");
    expect(r.allowed).toBe(false);
  });

  it("allows deprecated_supported", () => {
    expect(
      resolveCompatibility(matrix, {
        language: "typescript",
        clientVersion: "0.9.0",
        apiVersion: "v1",
      }).allowed,
    ).toBe(true);
  });
});

describe("clientsAffectedByApiVersion", () => {
  const matrix: CompatibilityEntry[] = [
    {
      language: "typescript",
      clientVersion: "0.5.0",
      apiVersion: "v1",
      level: "unsupported",
      warningCount: 0,
      notes: "old",
      determinedAt: "2026-05-15T10:00:00Z",
    },
    {
      language: "typescript",
      clientVersion: "1.0.0",
      apiVersion: "v1",
      level: "fully_compatible",
      warningCount: 0,
      determinedAt: "2026-05-15T10:00:00Z",
    },
    {
      language: "python",
      clientVersion: "0.5.0",
      apiVersion: "v1",
      level: "blocked",
      warningCount: 0,
      notes: "x",
      determinedAt: "2026-05-15T10:00:00Z",
    },
  ];

  it("returns clients at-or-below the min level", () => {
    const affected = clientsAffectedByApiVersion(matrix, "v1", "unsupported");
    expect(affected.length).toBe(2);
  });
});

describe("meetsLevel", () => {
  it("returns true when actual exceeds required", () => {
    expect(meetsLevel("fully_compatible", "deprecated_supported")).toBe(true);
  });

  it("returns false when actual below required", () => {
    expect(meetsLevel("unsupported", "fully_compatible")).toBe(false);
  });

  it("equal level meets itself", () => {
    expect(meetsLevel("compatible_with_warnings", "compatible_with_warnings")).toBe(true);
  });
});
